import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

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

const SCHEMA_VERSION = 6;
const EMBEDDING_DIMS = 768;

export async function openDatabase(dbPath: string): Promise<Database.Database> {
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

  // Check for schema version mismatch — rebuild if outdated
  const needsRebuild = checkSchemaVersion(db);
  if (needsRebuild) {
    console.error("[memory-mcp] Schema version changed, rebuilding index (memory files are not affected)");
    db.exec("DROP TABLE IF EXISTS chunks_fts");
    db.exec("DROP TABLE IF EXISTS chunks_vec");
    db.exec("DROP TABLE IF EXISTS embedding_cache");
    db.exec("DROP TABLE IF EXISTS chunks");
    db.exec("DROP TABLE IF EXISTS files");
    db.exec("DROP TABLE IF EXISTS meta");
  }

  ensureSchema(db, vec);
  return db;
}

function checkSchemaVersion(db: Database.Database): boolean {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (!row) return false;
    return Number(row.value) !== SCHEMA_VERSION;
  } catch {
    return false;
  }
}

function ensureSchema(db: Database.Database, vec: typeof import("sqlite-vec") | null): void {
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

  // Store schema version
  db.prepare(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`,
  ).run(String(SCHEMA_VERSION));

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
