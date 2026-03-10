/**
 * Shared test utilities — temp dirs, DB seeding, file helpers.
 * Imported by *.test.ts files. Not a test file itself.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase, isFtsAvailable, isVecAvailable } from "../src/db.js";
import { vectorToBuffer } from "../src/embedding.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory, returns its absolute path. */
export function tmpDir(prefix = "memory-mcp-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create a temp dir and return both dir path and a config file path inside it. */
export function tmpConfigDir(): { dir: string; configPath: string } {
  const dir = tmpDir();
  return { dir, configPath: path.join(dir, "memory-mcp.json") };
}

/** Create a temp workspace with a DB path. */
export function tmpWorkspace(): { dir: string; dbPath: string } {
  const dir = tmpDir("memory-mcp-ws-");
  return { dir, dbPath: path.join(dir, "test.db") };
}

/** Create a temp DB path (dir + test.db). */
export function tmpDbPath(): string {
  const dir = tmpDir("memory-mcp-db-");
  return path.join(dir, "test.db");
}

/** Write a file inside a directory, creating parent dirs as needed. */
export function writeFile(dir: string, relPath: string, content: string): void {
  const absPath = path.join(dir, relPath);
  const parentDir = path.dirname(absPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  fs.writeFileSync(absPath, content);
}

/** Remove a temp directory recursively. */
export function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// DB seeding
// ---------------------------------------------------------------------------

/** Test chunks used by seedDb. */
const TEST_CHUNKS = [
  { path: "MEMORY.md", start: 1, end: 10, text: "Use TypeScript for all backend services. Prefer strict mode.", hash: "c1" },
  { path: "MEMORY.md", start: 11, end: 20, text: "Database migrations must be backward compatible. Use SQLite for local storage.", hash: "c2" },
  { path: "memory/decisions.md", start: 1, end: 15, text: "Architecture decision: worker threads for CPU-intensive embedding computations.", hash: "c3" },
  { path: "memory/decisions.md", start: 16, end: 30, text: "Hybrid search combines BM25 full-text with vector cosine similarity.", hash: "c4" },
  { path: "memory/preferences.md", start: 1, end: 10, text: "User prefers Chinese language responses. Code comments in English.", hash: "c5" },
  { path: "memory/preferences.md", start: 11, end: 20, text: "Git commits must not include co-authored-by trailers from AI.", hash: "c6" },
];

/**
 * Open a temp DB and seed it with test files, chunks, and FTS data.
 * Returns the open Database instance. Caller must close + cleanup.
 */
export async function seedDb(dbPath: string): Promise<Database.Database> {
  const db = await openDatabase(dbPath, { chunkSize: 512 });

  const insertFile = db.prepare(
    `INSERT OR REPLACE INTO files (path, hash, source, mtime, size) VALUES (?, ?, ?, ?, ?)`,
  );
  insertFile.run("MEMORY.md", "hash1", "memory", Date.now(), 100);
  insertFile.run("memory/decisions.md", "hash2", "memory", Date.now(), 200);
  insertFile.run("memory/preferences.md", "hash3", "memory", Date.now(), 150);

  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, path, start_line, end_line, text, hash, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  for (const c of TEST_CHUNKS) {
    const id = `${c.path}:${c.start}-${c.end}`;
    insertChunk.run(id, c.path, c.start, c.end, c.text, c.hash, "memory", now);
  }

  if (isFtsAvailable(db)) {
    const insertFts = db.prepare(
      `INSERT INTO chunks_fts (rowid, text, id, path, source, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const rows = db.prepare(`SELECT rowid, id, path, source, start_line, end_line, text FROM chunks`).all() as Array<{
      rowid: number; id: string; path: string; source: string; start_line: number; end_line: number; text: string;
    }>;
    for (const row of rows) {
      insertFts.run(row.rowid, row.text, row.id, row.path, row.source, row.start_line, row.end_line);
    }
  }

  return db;
}

// ---------------------------------------------------------------------------
// Vector seeding for hybrid search tests
// ---------------------------------------------------------------------------

const EMBEDDING_DIMS = 768;

/** Generate a deterministic fake 768-dim vector from a seed number. */
export function fakeVector(seed: number): number[] {
  const vec = new Array<number>(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    vec[i] = Math.sin(seed * (i + 1) * 0.1);
  }
  // L2-normalize
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return mag > 0 ? vec.map((v) => v / mag) : vec;
}

/**
 * Seed a DB with test data AND vector embeddings for hybrid search tests.
 * Returns null if sqlite-vec is not available (caller should skip test).
 */
export async function seedDbWithVectors(dbPath: string): Promise<Database.Database | null> {
  const db = await seedDb(dbPath);
  if (!isVecAvailable(db)) {
    db.close();
    return null;
  }

  // Insert a fake embedding for each chunk
  const chunks = db.prepare(`SELECT id FROM chunks`).all() as Array<{ id: string }>;
  const insertVec = db.prepare(`INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)`);
  for (let i = 0; i < chunks.length; i++) {
    insertVec.run(chunks[i]!.id, vectorToBuffer(fakeVector(i + 1)));
  }

  return db;
}
