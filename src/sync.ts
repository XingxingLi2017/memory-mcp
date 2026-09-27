import type Database from "better-sqlite3";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { SessionDirConfig } from "./config.js";
import {
  hashText,
  listMemoryFiles,
  listSessionFiles,
  statFileEntry,
  buildFileEntry,
  buildSessionEntry,
  buildExtraDirAliases,
  deriveSessionRelPath,
  chunkFile,
  chunkMarkdown,
  type MemoryFileEntry,
  type FileStatEntry,
} from "./internal.js";
import { compactVectorIndex, isFtsAvailable, isVecAvailable, type CompactOptions } from "./db.js";
import { segmentText } from "./segment.js";
import { embedBatch, vectorToBuffer } from "./embedding.js";

export type SyncResult = {
  indexed: number;
  skipped: number;
  deleted: number;
};

/**
 * Sync memory files into the database.
 * Two-phase: stat-based fast-path skips unchanged files (mtime+size),
 * only reading content for files that actually changed.
 */
export async function syncMemoryFiles(
  db: Database.Database,
  workspaceDir: string,
  opts?: { force?: boolean; chunkSize?: number; extraDirs?: string[] },
): Promise<SyncResult> {
  const files = await listMemoryFiles(workspaceDir, opts?.extraDirs);
  const extraDirAliases = opts?.extraDirs ? buildExtraDirAliases(opts.extraDirs) : undefined;

  // Phase 1: stat-only pass — identify changed files by mtime+size
  const statEntries = await Promise.all(
    files.map((f) => statFileEntry(f, workspaceDir, extraDirAliases)),
  );

  const ftsOk = isFtsAvailable(db);
  const activePaths = new Set<string>();
  let indexed = 0;
  let skipped = 0;

  // Prepare DB lookup for existing file metadata
  const getFileMeta = db.prepare(
    `SELECT hash, mtime, size FROM files WHERE path = ? AND source = ?`,
  );

  for (const stat of statEntries) {
    const existing = getFileMeta.get(stat.path, "memory") as
      | { hash: string; mtime: number; size: number }
      | undefined;

    // Fast path: skip if mtime and size haven't changed (and not forced)
    if (
      !opts?.force &&
      existing &&
      Math.abs(existing.mtime - stat.mtimeMs) < 1 &&
      existing.size === stat.size
    ) {
      activePaths.add(stat.path);
      skipped++;
      continue;
    }

    // Phase 2: read + hash only for changed files
    let entry: MemoryFileEntry;
    try {
      entry = await buildFileEntry(stat.absPath, workspaceDir, extraDirAliases);
    } catch (err) {
      console.error(`[memory-mcp] failed to read ${stat.path}:`, err instanceof Error ? err.message : String(err));
      // Keep existing index data — file exists on disk but is transiently unreadable
      activePaths.add(stat.path);
      skipped++;
      continue;
    }

    // Content hash check: file may have same content despite mtime change (e.g. touch)
    if (!opts?.force && existing?.hash === entry.hash) {
      // Update mtime in DB so next stat check can skip it
      db.prepare(`UPDATE files SET mtime = ?, size = ? WHERE path = ?`).run(
        entry.mtimeMs, entry.size, entry.path,
      );
      activePaths.add(entry.path);
      skipped++;
      continue;
    }

    indexFile(db, entry, ftsOk, "memory", opts?.chunkSize);
    activePaths.add(entry.path);
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
    // If vec deletes still fail here, orphan embeddings remain until the next
    // syncEmbeddings() pass, which runs a global NOT EXISTS sweep. That's
    // acceptable because search joins chunks_vec back to chunks by id, so stale
    // vec rows are ignored until then.
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

  const chunkData = filtered.map((chunk) => ({
    ...chunk,
    id: hashText(`${source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}`),
  }));
  const newIds = new Set(chunkData.map((c) => c.id));

  // Chunk ids encode position and content, so a shared id means an identical
  // chunk: keep its chunk, FTS and vector rows. Rewriting them would leave a
  // dead vec0 slot behind on every edit.
  const oldIds = new Set(
    (db.prepare(`SELECT id FROM chunks WHERE path = ? AND source = ?`).all(entry.path, source) as Array<{ id: string }>)
      .map((r) => r.id),
  );
  const removedIds = [...oldIds].filter((id) => !newIds.has(id));
  const addedChunks = chunkData.filter((c) => !oldIds.has(c.id));

  const vecOk = isVecAvailable(db);
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
  const findCache = db.prepare(`SELECT embedding FROM embedding_cache WHERE hash = ?`);

  const transaction = db.transaction(() => {
    // Salvage vectors of removed chunks by content hash (e.g. a chunk that
    // only moved lines; best effort), then delete the removed rows. Delete
    // errors propagate so the whole re-index rolls back instead of leaving
    // orphan vector or FTS rows.
    const salvaged = new Map<string, Buffer>();
    if (vecOk) {
      const getVec = db.prepare(
        `SELECT c.hash, v.embedding FROM chunks c JOIN chunks_vec v ON v.id = c.id WHERE c.id = ?`,
      );
      const deleteVec = db.prepare(`DELETE FROM chunks_vec WHERE id = ?`);
      for (const id of removedIds) {
        try {
          const row = getVec.get(id) as { hash: string; embedding: Buffer } | undefined;
          if (row) salvaged.set(row.hash, row.embedding);
        } catch {}
        deleteVec.run(id);
      }
    }
    for (let i = 0; i < removedIds.length; i += DELETE_BATCH) {
      const batch = removedIds.slice(i, i + DELETE_BATCH);
      const placeholders = batch.map(() => "?").join(",");
      db.prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`).run(...batch);
      if (ftsOk) {
        db.prepare(
          `DELETE FROM chunks_fts WHERE path = ? AND source = ? AND id IN (${placeholders})`,
        ).run(entry.path, source, ...batch);
      }
    }

    for (const chunk of addedChunks) {
      insertChunk.run(chunk.id, entry.path, source, chunk.startLine, chunk.endLine, chunk.hash, chunk.text, now);
      insertFts?.run(segmentText(chunk.text), chunk.id, entry.path, source, chunk.startLine, chunk.endLine);
      if (!vecOk) continue;
      // Prefer a salvaged vector, then embedding_cache; otherwise syncEmbeddings fills it later
      const vec = salvaged.get(chunk.hash)
        ?? (findCache.get(chunk.hash) as { embedding: Buffer } | undefined)?.embedding;
      if (vec) {
        try { insertVecIfMissing(db, chunk.id, vec); } catch {}
      }
    }

    // Upsert file record
    db.prepare(
      `INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET source=excluded.source, hash=excluded.hash, mtime=excluded.mtime, size=excluded.size`,
    ).run(entry.path, source, entry.hash, entry.mtimeMs, entry.size);
  });

  transaction();
}

const DELETE_BATCH = 500;

/**
 * Insert a vector only when the id has none. vec0 never frees a replaced
 * slot outside its newest block, so chunks_vec is never written with
 * INSERT OR REPLACE. An existing vector for the same id already matches,
 * because chunk ids include the content hash.
 */
function insertVecIfMissing(db: Database.Database, id: string, embedding: Buffer): boolean {
  if (db.prepare(`SELECT 1 FROM chunks_vec_rowids WHERE id = ?`).get(id)) return false;
  db.prepare(`INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)`).run(id, embedding);
  return true;
}

/**
 * Sync session transcript files (events.jsonl) into the database.
 * Uses stat-based fast-path to skip unchanged files.
 */
export async function syncSessionFiles(
  db: Database.Database,
  opts?: { force?: boolean; chunkSize?: number; maxDays?: number; maxCount?: number; sessionDirs?: SessionDirConfig[] },
): Promise<SyncResult> {
  const files = await listSessionFiles({
    maxDays: opts?.maxDays,
    maxCount: opts?.maxCount,
    sessionDirs: opts?.sessionDirs,
  });
  const ftsOk = isFtsAvailable(db);
  const activePaths = new Set<string>();
  let indexed = 0;
  let skipped = 0;

  const getFileMeta = db.prepare(
    `SELECT hash, mtime, size FROM files WHERE path = ? AND source = ?`,
  );

  for (const absPath of files) {
    const sessionRelPath = deriveSessionRelPath(absPath);

    // Stat-based fast-path: skip if mtime+size unchanged
    let stat: import("fs").Stats;
    try { stat = await fsPromises.stat(absPath); } catch { continue; }

    const existing = getFileMeta.get(sessionRelPath, "sessions") as
      | { hash: string; mtime: number; size: number }
      | undefined;

    if (
      !opts?.force &&
      existing &&
      Math.abs(existing.mtime - stat.mtimeMs) < 1 &&
      existing.size === stat.size
    ) {
      activePaths.add(sessionRelPath); // Unchanged and previously indexed — still active
      skipped++;
      continue;
    }

    const entry = await buildSessionEntry(absPath);
    // Parse failure → skip without marking active, allowing stale cleanup on next pass.
    // This differs from memory files (which preserve stale index on read error) because
    // session files are append-only logs — a parse failure indicates corruption, not a
    // transient lock, so removing stale data is the safer choice.
    if (!entry) continue;

    activePaths.add(sessionRelPath); // Successfully built — mark as active

    if (!opts?.force && existing?.hash === entry.hash) {
      db.prepare(`UPDATE files SET mtime = ?, size = ? WHERE path = ?`).run(
        entry.mtimeMs, entry.size, entry.path,
      );
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
    // If vec deletes still fail here, orphan embeddings remain until the next
    // syncEmbeddings() pass, which runs a global NOT EXISTS sweep. That's
    // acceptable because search joins chunks_vec back to chunks by id, so stale
    // vec rows are ignored until then.
    deleted++;
  }

  return { indexed, skipped, deleted };
}

/**
 * Cross-process embedding lock using the meta table.
 * Uses BEGIN IMMEDIATE for atomic acquisition and PID liveness check.
 * Steals lock from dead processes or alive-but-stuck processes (>2h).
 */
const MAX_LOCK_AGE_MS = 1 * 60 * 60 * 1000; // 1 hour — generous for weak machines

export function tryAcquireEmbeddingLock(db: Database.Database): boolean {
  try {
    // BEGIN IMMEDIATE acquires a write lock immediately, preventing races
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare(`SELECT value FROM meta WHERE key = 'embedding_lock'`).get() as
        | { value: string }
        | undefined;
      if (row) {
        const lock = JSON.parse(row.value) as { pid: number; startedAt: number };
        if (isPidAlive(lock.pid) && Date.now() - lock.startedAt < MAX_LOCK_AGE_MS) {
          db.exec("ROLLBACK");
          return false;
        }
        // Lock holder is dead or stuck too long — steal it
      }
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_lock', ?)`).run(
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      );
      db.exec("COMMIT");
      return true;
    } catch {
      db.exec("ROLLBACK");
      return false;
    }
  } catch {
    return false;
  }
}

/** Check if a PID is alive. Distinguishes ESRCH (dead) from EPERM (alive). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM = process exists but we lack permission → alive
    if (err && typeof err === "object" && "code" in err && err.code === "EPERM") return true;
    return false; // ESRCH = no such process → dead
  }
}

export function releaseEmbeddingLock(db: Database.Database): void {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'embedding_lock'`).get() as
      | { value: string }
      | undefined;
    if (row) {
      const lock = JSON.parse(row.value) as { pid: number };
      if (lock.pid === process.pid) {
        db.prepare(`DELETE FROM meta WHERE key = 'embedding_lock'`).run();
      }
    }
  } catch {}
}

/**
 * Compute and store embeddings for chunks that don't have them yet.
 * Uses a cross-process PID lock so only one process embeds at a time.
 */
export async function syncEmbeddings(
  db: Database.Database,
  opts?: { compact?: CompactOptions },
): Promise<number> {
  const vecOk = isVecAvailable(db);
  if (!vecOk) return 0;

  if (!tryAcquireEmbeddingLock(db)) return 0;

  try {
    const orphanCount = db.prepare(
      `DELETE FROM chunks_vec
       WHERE NOT EXISTS (SELECT 1 FROM chunks WHERE chunks.id = chunks_vec.id)`,
    ).run();
    if (orphanCount.changes > 0) {
      console.error(`[memory-mcp] cleaned up ${orphanCount.changes} orphan embedding(s)`);
    }

    const totalChunks = (db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number }).c;
    let totalEmbedded = 0;
    let batchCount = 0;
    const findMissing = db.prepare(
      `SELECT c.id, c.hash, c.text FROM chunks c
       WHERE NOT EXISTS (SELECT 1 FROM chunks_vec v WHERE v.id = c.id)
       LIMIT 100`,
    );
    const findCache = db.prepare(`SELECT embedding FROM embedding_cache WHERE hash = ?`);
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
          insertVecIfMissing(db, id, buf);
        }
        for (let i = 0; i < uncached.length; i++) {
          const item = uncached[i]!;
          const vec = newEmbeddings[i];
          if (!vec || vec.length === 0) continue;
          const buf = vectorToBuffer(vec);
          insertVecIfMissing(db, item.id, buf);
          insertCache.run(item.hash, buf, now);
        }
      });
      tx();

      totalEmbedded += cached.size + newEmbeddings.length;
      batchCount++;

      // Progress logging — throttle to every 5th batch to reduce COUNT(*) overhead
      if (totalChunks > 0 && batchCount % 5 === 0) {
        const done = (db.prepare(`SELECT COUNT(*) as c FROM chunks_vec`).get() as { c: number }).c;
        const pct = ((done / totalChunks) * 100).toFixed(1);
        console.error(`[memory-mcp] embedding progress: ${done}/${totalChunks} (${pct}%)`);
      }

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

    // Still inside the embedding lock, so only one process rebuilds chunks_vec
    try {
      compactVectorIndex(db, opts?.compact);
    } catch (err) {
      console.error("[memory-mcp] vector index compaction failed:", err instanceof Error ? err.message : String(err));
    }

    return totalEmbedded;
  } finally {
    releaseEmbeddingLock(db);
  }
}
