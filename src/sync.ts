import type Database from "better-sqlite3";
import {
  hashText,
  listMemoryFiles,
  listSessionFiles,
  buildFileEntry,
  buildSessionEntry,
  chunkFile,
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
  opts?: { force?: boolean; chunkSize?: number },
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

    indexFile(db, entry, ftsOk, "memory", opts?.chunkSize);
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
    // Clean vector entries in batch
    try {
      if (chunkIds.length > 0) {
        const placeholders = chunkIds.map(() => "?").join(",");
        db.prepare(`DELETE FROM chunks_vec WHERE id IN (${placeholders})`).run(...chunkIds.map(c => c.id));
      }
    } catch {
      // sqlite-vec may not support IN — fall back to per-row delete
      try { for (const c of chunkIds) db.prepare(`DELETE FROM chunks_vec WHERE id = ?`).run(c.id); } catch {}
    }
    deleted++;
  }

  return { indexed, skipped, deleted };
}

function indexFile(
  db: Database.Database,
  entry: MemoryFileEntry,
  ftsOk: boolean,
  source: string,
  chunkSize?: number,
): void {
  const content = entry.content;
  // Session content is already extracted text — chunk as markdown
  const chunks = source === "sessions"
    ? chunkMarkdown(content, chunkSize ? { tokens: chunkSize, overlap: Math.floor(chunkSize / 8) } : undefined)
    : chunkFile(content, entry.path, chunkSize);
  const filtered = chunks.filter((c) => c.text.trim().length > 0);
  const now = Date.now();

  // Clear old data for this file (including vectors)
  const oldChunkIds = db
    .prepare(`SELECT id FROM chunks WHERE path = ? AND source = ?`)
    .all(entry.path, source) as Array<{ id: string }>;
  try {
    for (const { id } of oldChunkIds) {
      db.prepare(`DELETE FROM chunks_vec WHERE id = ?`).run(id);
    }
  } catch {}
  db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(entry.path, source);
  if (ftsOk) {
    try {
      db.prepare(`DELETE FROM chunks_fts WHERE path = ? AND source = ?`).run(entry.path, source);
    } catch {}
  }

  // Generate chunk IDs
  const chunkData = filtered.map((chunk) => ({
    ...chunk,
    id: hashText(`${source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}`),
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
      insertChunk.run(chunk.id, entry.path, source, chunk.startLine, chunk.endLine, chunk.hash, chunk.text, now);
      insertFts?.run(segmentText(chunk.text), chunk.id, entry.path, source, chunk.startLine, chunk.endLine);
    }

    // Upsert file record
    db.prepare(
      `INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET source=excluded.source, hash=excluded.hash, mtime=excluded.mtime, size=excluded.size`,
    ).run(entry.path, source, entry.hash, entry.mtimeMs, entry.size);
  });

  transaction();
}

/**
 * Sync session transcript files (events.jsonl) into the database.
 * Extracts user/assistant messages and indexes them as source="sessions".
 */
export async function syncSessionFiles(
  db: Database.Database,
  workspaceDir: string,
  opts?: { force?: boolean; chunkSize?: number; maxDays?: number; maxCount?: number },
): Promise<SyncResult> {
  const files = await listSessionFiles(workspaceDir, {
    maxDays: opts?.maxDays,
    maxCount: opts?.maxCount,
  });
  const ftsOk = isFtsAvailable(db);
  const activePaths = new Set<string>();
  let indexed = 0;
  let skipped = 0;

  for (const absPath of files) {
    const entry = await buildSessionEntry(absPath, workspaceDir);
    if (!entry) continue;

    activePaths.add(entry.path);

    const existing = db
      .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
      .get(entry.path, "sessions") as { hash: string } | undefined;

    if (!opts?.force && existing?.hash === entry.hash) {
      skipped++;
      continue;
    }

    indexFile(db, entry, ftsOk, "sessions", opts?.chunkSize);
    indexed++;
  }

  // Remove stale session entries
  let deleted = 0;
  const staleRows = db
    .prepare(`SELECT path FROM files WHERE source = ?`)
    .all("sessions") as Array<{ path: string }>;

  for (const row of staleRows) {
    if (activePaths.has(row.path)) continue;
    const chunkIds = db
      .prepare(`SELECT id FROM chunks WHERE path = ? AND source = ?`)
      .all(row.path, "sessions") as Array<{ id: string }>;
    db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(row.path, "sessions");
    db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(row.path, "sessions");
    if (ftsOk) {
      try {
        db.prepare(`DELETE FROM chunks_fts WHERE path = ? AND source = ?`).run(row.path, "sessions");
      } catch {}
    }
    try {
      if (chunkIds.length > 0) {
        const placeholders = chunkIds.map(() => "?").join(",");
        db.prepare(`DELETE FROM chunks_vec WHERE id IN (${placeholders})`).run(...chunkIds.map(c => c.id));
      }
    } catch {
      try { for (const c of chunkIds) db.prepare(`DELETE FROM chunks_vec WHERE id = ?`).run(c.id); } catch {}
    }
    deleted++;
  }

  return { indexed, skipped, deleted };
}

/**
 * Compute and store embeddings for chunks that don't have them yet.
 * Runs after the main sync to avoid blocking startup.
 */
export async function syncEmbeddings(db: Database.Database): Promise<number> {
  const vecOk = isVecAvailable(db);
  if (!vecOk) return 0;

  let totalEmbedded = 0;
  const findMissing = db.prepare(
    `SELECT c.id, c.hash, c.text FROM chunks c
     WHERE NOT EXISTS (SELECT 1 FROM chunks_vec v WHERE v.id = c.id)
     LIMIT 100`,
  );
  const findCache = db.prepare(`SELECT embedding FROM embedding_cache WHERE hash = ?`);
  const insertVec = db.prepare(`INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?, ?)`);
  const insertCache = db.prepare(
    `INSERT OR REPLACE INTO embedding_cache (hash, embedding, updated_at) VALUES (?, ?, ?)`,
  );

  while (true) {
    const missing = findMissing.all() as Array<{ id: string; hash: string; text: string }>;
    if (missing.length === 0) break;

    // Check embedding cache for already-computed hashes
    const cached = new Map<string, Buffer>();
    const uncached: Array<{ index: number; id: string; hash: string; text: string }> = [];

    for (let i = 0; i < missing.length; i++) {
      const row = missing[i]!;
      const hit = findCache.get(row.hash) as { embedding: Buffer } | undefined;
      if (hit) {
        cached.set(row.id, hit.embedding);
      } else {
        uncached.push({ index: i, ...row });
      }
    }

    // Embed uncached texts in batch
    let newEmbeddings: number[][] = [];
    let embedFailed = false;
    if (uncached.length > 0) {
      try {
        newEmbeddings = await embedBatch(uncached.map((u) => u.text));
      } catch (err) {
        console.error("[memory-mcp] embedding failed:", err);
        embedFailed = true;
      }
    }

    // Store all embeddings (including cached hits even if embed failed)
    const now = Date.now();
    const tx = db.transaction(() => {
      for (const [id, buf] of cached) {
        insertVec.run(id, buf);
      }
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

    totalEmbedded += cached.size + newEmbeddings.length;

    if (embedFailed) {
      const remaining = (db.prepare(
        `SELECT COUNT(*) as c FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM chunks_vec v WHERE v.id = c.id)`,
      ).get() as { c: number }).c;
      console.error(`[memory-mcp] embedding stopped early; ${remaining} chunk(s) still need embedding`);
      break;
    }
  }

  // Clean stale embedding cache entries
  try {
    db.prepare(`DELETE FROM embedding_cache WHERE NOT EXISTS (SELECT 1 FROM chunks WHERE chunks.hash = embedding_cache.hash)`).run();
  } catch {}

  return totalEmbedded;
}
