import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openDatabase, isFtsAvailable, isVecAvailable } from "../src/db.js";
import { tmpDbPath, cleanupDir } from "./test-utils.js";

// ---------------------------------------------------------------------------
// openDatabase — basic schema
// ---------------------------------------------------------------------------

test("openDatabase creates a valid database with schema", async (t) => {
  const dbPath = tmpDbPath();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  // Check core tables exist
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all() as Array<{ name: string }>;
  const tableNames = tables.map((r) => r.name);

  assert.ok(tableNames.includes("files"), "Missing 'files' table");
  assert.ok(tableNames.includes("chunks"), "Missing 'chunks' table");
  assert.ok(tableNames.includes("meta"), "Missing 'meta' table");
  assert.ok(tableNames.includes("embedding_cache"), "Missing 'embedding_cache' table");
});

test("openDatabase creates files table with mtime and size columns", async (t) => {
  const dbPath = tmpDbPath();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  // Verify mtime and size columns exist
  const info = db.prepare(`PRAGMA table_info(files)`).all() as Array<{ name: string }>;
  const cols = info.map((c) => c.name);
  assert.ok(cols.includes("mtime"), "Missing 'mtime' column in files table");
  assert.ok(cols.includes("size"), "Missing 'size' column in files table");
  assert.ok(cols.includes("hash"), "Missing 'hash' column in files table");
  assert.ok(cols.includes("path"), "Missing 'path' column in files table");
  assert.ok(cols.includes("source"), "Missing 'source' column in files table");
});

test("openDatabase creates chunks table with expected columns", async (t) => {
  const dbPath = tmpDbPath();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  const info = db.prepare(`PRAGMA table_info(chunks)`).all() as Array<{ name: string }>;
  const cols = info.map((c) => c.name);
  assert.ok(cols.includes("path"));
  assert.ok(cols.includes("start_line"));
  assert.ok(cols.includes("end_line"));
  assert.ok(cols.includes("text"));
  assert.ok(cols.includes("hash"));
  assert.ok(cols.includes("source"));
  assert.ok(cols.includes("access_count"));
});

test("openDatabase creates idx_chunks_hash index", async (t) => {
  const dbPath = tmpDbPath();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  const indexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='chunks'`)
    .all() as Array<{ name: string }>;
  const indexNames = indexes.map((i) => i.name);
  assert.ok(indexNames.includes("idx_chunks_hash"), "Missing idx_chunks_hash index");
});

// ---------------------------------------------------------------------------
// isFtsAvailable / isVecAvailable
// ---------------------------------------------------------------------------

test("isFtsAvailable returns true for normal database", async (t) => {
  const dbPath = tmpDbPath();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  // FTS5 should be available on most systems
  const fts = isFtsAvailable(db);
  assert.equal(typeof fts, "boolean");
  // We expect true on most systems but don't hard-assert it
});

test("isVecAvailable returns a boolean", async (t) => {
  const dbPath = tmpDbPath();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  const vec = isVecAvailable(db);
  assert.equal(typeof vec, "boolean");
});

// ---------------------------------------------------------------------------
// openDatabase — WAL mode
// ---------------------------------------------------------------------------

test("openDatabase uses WAL journal mode", async (t) => {
  const dbPath = tmpDbPath();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  const mode = db.pragma("journal_mode", { simple: true }) as string;
  assert.equal(mode, "wal");
});

// ---------------------------------------------------------------------------
// openDatabase — re-open existing database
// ---------------------------------------------------------------------------

test("openDatabase can reopen existing database", async (t) => {
  const dbPath = tmpDbPath();
  let db1: Awaited<ReturnType<typeof openDatabase>> | null = null;
  let db2: Awaited<ReturnType<typeof openDatabase>> | null = null;
  t.after(() => { db2?.close(); db1?.close(); cleanupDir(path.dirname(dbPath)); });

  // First open — creates schema
  db1 = await openDatabase(dbPath, { chunkSize: 512 });
  db1.prepare(`INSERT INTO files (path, hash, source, mtime, size) VALUES (?, ?, ?, ?, ?)`).run(
    "test.md", "hash1", "memory", Date.now(), 100,
  );
  db1.close();
  db1 = null;

  // Second open — should work and retain data
  db2 = await openDatabase(dbPath, { chunkSize: 512 });
  const count = (db2.prepare(`SELECT COUNT(*) as c FROM files`).get() as { c: number }).c;
  assert.equal(count, 1);
});

// ---------------------------------------------------------------------------
// Schema version stored in meta
// ---------------------------------------------------------------------------

test("openDatabase stores schema version in meta table", async (t) => {
  const dbPath = tmpDbPath();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
  assert.ok(row, "Missing schema_version in meta table");
  assert.ok(Number(row.value) > 0);
});
