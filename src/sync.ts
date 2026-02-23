import type Database from "better-sqlite3";
import {
  hashText,
  listMemoryFiles,
  buildFileEntry,
  chunkMarkdown,
  type MemoryFileEntry,
} from "./internal.js";
import { isFtsAvailable, isVecAvailable } from "./db.js";
import { segmentText } from "./segment.js";
import { embedBatch, vectorToBuffer } from "./embedding.js";

export type SyncResult = {
  indexed: number;
  skipped: number;
  deleted: number;
};

/**
 * Sync memory files into the database.
 * Incremental: skips files whose SHA256 hash hasn't changed.
 */
export async function syncMemoryFiles(
  db: Database.Database,
  workspaceDir: string,
  opts?: { force?: boolean },
): Promise<SyncResult> {
  const files = await listMemoryFiles(workspaceDir);
  const entries = await Promise.all(
    files.map((f) => buildFileEntry(f, workspaceDir)),
  );

  const ftsOk = isFtsAvailable(db);
  const activePaths = new Set(entries.map((e) => e.path));
  let indexed = 0;
  let skipped = 0;

  for (const entry of entries) {
    const existing = db
      .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
      .get(entry.path, "memory") as { hash: string } | undefined;

    if (!opts?.force && existing?.hash === entry.hash) {
      skipped++;
      continue;
    }

    indexFile(db, entry, ftsOk);
    indexed++;
  }

  // Remove stale entries
  let deleted = 0;
  const staleRows = db
    .prepare(`SELECT path FROM files WHERE source = ?`)
    .all("memory") as Array<{ path: string }>;

  for (const row of staleRows) {
    if (activePaths.has(row.path)) continue;
    // Get chunk IDs before deleting (needed for vec cleanup)
    const chunkIds = db
      .prepare(`SELECT id FROM chunks WHERE path = ? AND source = ?`)
      .all(row.path, "memory") as Array<{ id: string }>;
    db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(row.path, "memory");
    db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(row.path, "memory");
    if (ftsOk) {
      try {
        db.prepare(`DELETE FROM chunks_fts WHERE path = ? AND source = ?`).run(row.path, "memory");
      } catch {}
    }
    // Clean vector entries
    try {
      for (const c of chunkIds) {
        db.prepare(`DELETE FROM chunks_vec WHERE id = ?`).run(c.id);
      }
    } catch {}
    deleted++;
  }

  return { indexed, skipped, deleted };
}

function indexFile(
  db: Database.Database,
  entry: MemoryFileEntry,
  ftsOk: boolean,
): void {
  const content = entry.content;
  const chunks = chunkMarkdown(content).filter((c) => c.text.trim().length > 0);
  const now = Date.now();

  // Clear old data for this file
  db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(entry.path, "memory");
  if (ftsOk) {
    try {
      db.prepare(`DELETE FROM chunks_fts WHERE path = ? AND source = ?`).run(entry.path, "memory");
    } catch {}
  }

  // Generate chunk IDs first
  const chunkData = chunks.map((chunk) => ({
    ...chunk,
    id: hashText(`memory:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}`),
  }));

  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, text, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertFts = ftsOk
    ? db.prepare(
        `INSERT INTO chunks_fts (text, id, path, source, start_line, end_line)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
    : null;

  const transaction = db.transaction(() => {
    for (const chunk of chunkData) {
      insertChunk.run(chunk.id, entry.path, "memory", chunk.startLine, chunk.endLine, chunk.hash, chunk.text, now);
      insertFts?.run(segmentText(chunk.text), chunk.id, entry.path, "memory", chunk.startLine, chunk.endLine);
    }

    // Upsert file record
    db.prepare(
      `INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET source=excluded.source, hash=excluded.hash, mtime=excluded.mtime, size=excluded.size`,
    ).run(entry.path, "memory", entry.hash, entry.mtimeMs, entry.size);
  });

  transaction();
}

/**
 * Compute and store embeddings for chunks that don't have them yet.
 * Runs after the main sync to avoid blocking startup.
 */
export async function syncEmbeddings(db: Database.Database): Promise<number> {
  const vecOk = isVecAvailable(db);
  if (!vecOk) return 0;

  // Find chunks without embeddings
  const missing = db
    .prepare(
      `SELECT c.id, c.hash, c.text FROM chunks c
       WHERE NOT EXISTS (SELECT 1 FROM chunks_vec v WHERE v.id = c.id)
       LIMIT 100`,
    )
    .all() as Array<{ id: string; hash: string; text: string }>;

  if (missing.length === 0) return 0;

  // Check embedding cache for already-computed hashes
  const cached = new Map<string, Buffer>();
  const uncached: Array<{ index: number; id: string; hash: string; text: string }> = [];

  for (let i = 0; i < missing.length; i++) {
    const row = missing[i]!;
    const hit = db
      .prepare(`SELECT embedding FROM embedding_cache WHERE hash = ?`)
      .get(row.hash) as { embedding: Buffer } | undefined;
    if (hit) {
      cached.set(row.id, hit.embedding);
    } else {
      uncached.push({ index: i, ...row });
    }
  }

  // Embed uncached texts in batch
  let newEmbeddings: number[][] = [];
  if (uncached.length > 0) {
    try {
      newEmbeddings = await embedBatch(uncached.map((u) => u.text));
    } catch (err) {
      console.error("[memory-mcp] embedding failed:", err);
      return cached.size; // Still store cached ones
    }
  }

  // Store all embeddings
  const insertVec = db.prepare(`INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?, ?)`);
  const insertCache = db.prepare(
    `INSERT OR REPLACE INTO embedding_cache (hash, embedding, updated_at) VALUES (?, ?, ?)`,
  );
  const now = Date.now();

  const tx = db.transaction(() => {
    // Store cached embeddings
    for (const [id, buf] of cached) {
      insertVec.run(id, buf);
    }
    // Store new embeddings
    for (let i = 0; i < uncached.length; i++) {
      const item = uncached[i]!;
      const vec = newEmbeddings[i];
      if (!vec || vec.length === 0) continue;
      const buf = vectorToBuffer(vec);
      insertVec.run(item.id, buf);
      insertCache.run(item.hash, buf, now);
    }
  });
  tx();

  return cached.size + newEmbeddings.length;
}
