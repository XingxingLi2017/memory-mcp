import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

let sqliteVec: typeof import("sqlite-vec") | null = null;
let sqliteVecLoaded = false;

async function ensureSqliteVec(): Promise<typeof import("sqlite-vec") | null> {
  if (sqliteVecLoaded) return sqliteVec;
  sqliteVecLoaded = true;
  try {
    sqliteVec = await import("sqlite-vec");
  } catch {
    // sqlite-vec not installed — vector search will be disabled
  }
  return sqliteVec;
}

const SCHEMA_VERSION = 7;
const EMBEDDING_DIMS = 768;

export async function openDatabase(dbPath: string, opts?: { chunkSize?: number }): Promise<Database.Database> {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  // Load sqlite-vec extension (if available)
  const vec = await ensureSqliteVec();
  if (vec) {
    try {
      vec.load(db);
    } catch (err) {
      console.error("[memory-mcp] sqlite-vec load failed:", err);
    }
  }

  // Check for schema version or config mismatch — atomic rebuild if outdated
  const needsRebuild = checkNeedsRebuild(db, opts?.chunkSize);
  if (needsRebuild) {
    console.error("[memory-mcp] Schema or config changed, rebuilding index (memory files are not affected)");
    const rebuilt = await atomicRebuild(dbPath, db, vec, opts?.chunkSize);
    if (rebuilt) return rebuilt;
    // Fallback: in-place rebuild
    db.exec("DROP TABLE IF EXISTS chunks_fts");
    db.exec("DROP TABLE IF EXISTS chunks_vec");
    db.exec("DROP TABLE IF EXISTS embedding_cache");
    db.exec("DROP TABLE IF EXISTS chunks");
    db.exec("DROP TABLE IF EXISTS files");
    db.exec("DROP TABLE IF EXISTS meta");
  }

  ensureSchema(db, vec, opts?.chunkSize);
  return db;
}

/**
 * Atomic rebuild: create temp DB, set up schema, swap via rename.
 * If anything fails, old DB is untouched.
 */
async function atomicRebuild(
  dbPath: string,
  oldDb: Database.Database,
  vec: typeof import("sqlite-vec") | null,
  chunkSize?: number,
): Promise<Database.Database | null> {
  const tempPath = `${dbPath}.tmp-${crypto.randomUUID()}`;
  try {
    const tempDb = new Database(tempPath);
    tempDb.pragma("journal_mode = WAL");
    tempDb.pragma("busy_timeout = 5000");
    if (vec) {
      try { vec.load(tempDb); } catch {}
    }
    ensureSchema(tempDb, vec, chunkSize);

    // Seed embedding cache from old DB
    try {
      const rows = oldDb.prepare(`SELECT hash, embedding, updated_at FROM embedding_cache`).all() as Array<{
        hash: string; embedding: Buffer; updated_at: number;
      }>;
      const insert = tempDb.prepare(
        `INSERT OR IGNORE INTO embedding_cache (hash, embedding, updated_at) VALUES (?, ?, ?)`,
      );
      const tx = tempDb.transaction(() => {
        for (const row of rows) insert.run(row.hash, row.embedding, row.updated_at);
      });
      tx();
    } catch {}

    // Close both DBs for swap
    oldDb.close();
    tempDb.close();

    // Swap: old → .bak, temp → main, delete .bak (safer on Windows)
    const bakPath = `${dbPath}.bak`;
    try { fs.unlinkSync(bakPath); } catch {}
    try { fs.renameSync(dbPath, bakPath); } catch {}
    // Clean WAL/SHM files from old DB
    for (const suffix of ["-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
    fs.renameSync(tempPath, dbPath);
    // Clean backup and temp WAL/SHM
    try { fs.unlinkSync(bakPath); } catch {}
    for (const suffix of ["-wal", "-shm"]) {
      try { fs.unlinkSync(bakPath + suffix); } catch {}
      try { fs.unlinkSync(tempPath + suffix); } catch {}
    }

    // Reopen the swapped DB
    const newDb = new Database(dbPath);
    newDb.pragma("journal_mode = WAL");
    newDb.pragma("busy_timeout = 5000");
    if (vec) {
      try { vec.load(newDb); } catch {}
    }
    return newDb;
  } catch (err) {
    console.error("[memory-mcp] atomic rebuild failed, falling back to in-place rebuild:", err);
    // Clean up temp files
    for (const f of [tempPath, tempPath + "-wal", tempPath + "-shm"]) {
      try { fs.unlinkSync(f); } catch {}
    }
    return null;
  }
}

function checkNeedsRebuild(db: Database.Database, chunkSize?: number): boolean {
  try {
    const row = db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>;
    const meta = Object.fromEntries(row.map((r) => [r.key, r.value]));
    if (Number(meta.schema_version) !== SCHEMA_VERSION) return true;
    if (chunkSize && Number(meta.chunk_size) !== chunkSize) return true;
    return false;
  } catch {
    return false;
  }
}

function ensureSchema(db: Database.Database, vec: typeof import("sqlite-vec") | null, chunkSize?: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      text TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);

  // FTS5 full-text search index
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        id UNINDEXED,
        path UNINDEXED,
        source UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED
      );
    `);
  } catch (err) {
    console.error("FTS5 not available:", err);
  }

  // Store schema version and config
  db.prepare(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`,
  ).run(String(SCHEMA_VERSION));
  if (chunkSize) {
    db.prepare(
      `INSERT OR REPLACE INTO meta (key, value) VALUES ('chunk_size', ?)`,
    ).run(String(chunkSize));
  }

  // Vector search table (sqlite-vec) — only if extension loaded
  if (vec) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[${EMBEDDING_DIMS}] distance_metric=cosine
        );
      `);
    } catch (err) {
      console.error("sqlite-vec table creation failed:", err);
    }
  }

  // Embedding cache (avoid re-embedding unchanged content)
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      hash TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Structured facts with evidence tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      source TEXT,
      evidence_chunk_ids TEXT,
      created_at INTEGER NOT NULL,
      last_verified_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);`);
}

export function isFtsAvailable(db: Database.Database): boolean {
  try {
    db.prepare(`SELECT COUNT(*) FROM chunks_fts`).get();
    return true;
  } catch {
    return false;
  }
}

export function isVecAvailable(db: Database.Database): boolean {
  try {
    db.prepare(`SELECT COUNT(*) FROM chunks_vec`).get();
    return true;
  } catch {
    return false;
  }
}
