import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const SCHEMA_VERSION = 1;

export function openDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  ensureSchema(db);
  return db;
}

function ensureSchema(db: Database.Database): void {
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
      updated_at INTEGER NOT NULL
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
}

export function isFtsAvailable(db: Database.Database): boolean {
  try {
    db.prepare(`SELECT COUNT(*) FROM chunks_fts`).get();
    return true;
  } catch {
    return false;
  }
}
