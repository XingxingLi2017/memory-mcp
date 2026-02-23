import type Database from "better-sqlite3";
import {
  hashText,
  listMemoryFiles,
  buildFileEntry,
  chunkMarkdown,
  type MemoryFileEntry,
} from "./internal.js";
import { isFtsAvailable } from "./db.js";
import { segmentText } from "./segment.js";

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
    db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(row.path, "memory");
    db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(row.path, "memory");
    if (ftsOk) {
      try {
        db.prepare(`DELETE FROM chunks_fts WHERE path = ? AND source = ?`).run(row.path, "memory");
      } catch {}
    }
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
    for (const chunk of chunks) {
      const id = hashText(`memory:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}`);
      insertChunk.run(id, entry.path, "memory", chunk.startLine, chunk.endLine, chunk.hash, chunk.text, now);
      insertFts?.run(segmentText(chunk.text), id, entry.path, "memory", chunk.startLine, chunk.endLine);
    }

    // Upsert file record
    db.prepare(
      `INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET source=excluded.source, hash=excluded.hash, mtime=excluded.mtime, size=excluded.size`,
    ).run(entry.path, "memory", entry.hash, entry.mtimeMs, entry.size);
  });

  transaction();
}
