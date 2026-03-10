import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openDatabase, isFtsAvailable } from "./db.js";
import { syncMemoryFiles, type SyncResult } from "./sync.js";
import { hashText } from "./internal.js";
import { tmpWorkspace, writeFile, cleanupDir } from "./test-utils.js";

// ---------------------------------------------------------------------------
// syncMemoryFiles — basic indexing
// ---------------------------------------------------------------------------

test("syncMemoryFiles indexes MEMORY.md", async (t) => {
  const { dir, dbPath } = tmpWorkspace();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(dir); });

  writeFile(dir, "MEMORY.md", "# Memory\n\nThis is a test memory file.\n\n## Section 2\n\nMore content here.");

  const result = await syncMemoryFiles(db, dir);
  assert.ok(result.indexed > 0, `Expected indexed > 0, got ${result.indexed}`);

  // Verify file is in DB
  const fileCount = (db.prepare(`SELECT COUNT(*) as c FROM files WHERE source = 'memory'`).get() as { c: number }).c;
  assert.ok(fileCount > 0);

  // Verify chunks were created
  const chunkCount = (db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number }).c;
  assert.ok(chunkCount > 0, "No chunks created");
});

test("syncMemoryFiles indexes memory/ directory", async (t) => {
  const { dir, dbPath } = tmpWorkspace();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(dir); });

  writeFile(dir, "memory/decisions.md", "# Decisions\n\nUse worker threads.");
  writeFile(dir, "memory/preferences.md", "# Preferences\n\nPrefer TypeScript.");

  const result = await syncMemoryFiles(db, dir);
  assert.ok(result.indexed >= 2, `Expected >= 2 indexed, got ${result.indexed}`);

  const fileCount = (db.prepare(`SELECT COUNT(*) as c FROM files WHERE source = 'memory'`).get() as { c: number }).c;
  assert.ok(fileCount >= 2);
});

// ---------------------------------------------------------------------------
// syncMemoryFiles — stat-based fast-path (skip unchanged)
// ---------------------------------------------------------------------------

test("syncMemoryFiles skips unchanged files on second sync", async (t) => {
  const { dir, dbPath } = tmpWorkspace();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(dir); });

  writeFile(dir, "MEMORY.md", "# Memory\n\nContent.");

  // First sync — indexes
  const r1 = await syncMemoryFiles(db, dir);
  assert.ok(r1.indexed > 0);

  // Second sync — should skip (stat unchanged)
  const r2 = await syncMemoryFiles(db, dir);
  assert.equal(r2.indexed, 0, "Expected 0 indexed on second sync (stat unchanged)");
  assert.ok(r2.skipped > 0, "Expected skipped > 0 on second sync");
});

// ---------------------------------------------------------------------------
// syncMemoryFiles — detects content changes
// ---------------------------------------------------------------------------

test("syncMemoryFiles re-indexes when file content changes", async (t) => {
  const { dir, dbPath } = tmpWorkspace();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(dir); });

  writeFile(dir, "MEMORY.md", "# Version 1\n\nOriginal content.");

  const r1 = await syncMemoryFiles(db, dir);
  assert.ok(r1.indexed > 0);

  // Wait a bit to ensure mtime differs
  await new Promise((r) => setTimeout(r, 50));

  writeFile(dir, "MEMORY.md", "# Version 2\n\nUpdated content with new info.");

  const r2 = await syncMemoryFiles(db, dir);
  assert.ok(r2.indexed > 0, "Expected re-index after content change");
});

// ---------------------------------------------------------------------------
// syncMemoryFiles — deleted files cleaned up
// ---------------------------------------------------------------------------

test("syncMemoryFiles removes deleted files from index", async (t) => {
  const { dir, dbPath } = tmpWorkspace();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(dir); });

  writeFile(dir, "MEMORY.md", "# Memory\n\nContent.");
  writeFile(dir, "memory/extra.md", "# Extra\n\nExtra content.");

  // First sync — indexes both
  await syncMemoryFiles(db, dir);
  let fileCount = (db.prepare(`SELECT COUNT(*) as c FROM files WHERE source = 'memory'`).get() as { c: number }).c;
  assert.ok(fileCount >= 2);

  // Delete extra.md
  fs.unlinkSync(path.join(dir, "memory", "extra.md"));

  // Second sync — should delete extra.md from index
  const r2 = await syncMemoryFiles(db, dir);
  assert.ok(r2.deleted > 0, "Expected deleted > 0 after file removal");

  fileCount = (db.prepare(`SELECT COUNT(*) as c FROM files WHERE source = 'memory'`).get() as { c: number }).c;
  assert.equal(fileCount, 1, "Expected 1 file after deletion");
});

// ---------------------------------------------------------------------------
// syncMemoryFiles — multi-format support
// ---------------------------------------------------------------------------

test("syncMemoryFiles indexes .txt, .json, .yaml files", async (t) => {
  const { dir, dbPath } = tmpWorkspace();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(dir); });

  writeFile(dir, "memory/notes.txt", "Some plain text notes.");
  writeFile(dir, "memory/config.json", '{"key": "value"}');
  writeFile(dir, "memory/settings.yaml", "setting: true\nother: false");

  const result = await syncMemoryFiles(db, dir);
  assert.ok(result.indexed >= 3, `Expected >= 3 indexed, got ${result.indexed}`);
});

// ---------------------------------------------------------------------------
// syncMemoryFiles — FTS index populated
// ---------------------------------------------------------------------------

test("syncMemoryFiles populates FTS index", async (t) => {
  const { dir, dbPath } = tmpWorkspace();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(dir); });

  writeFile(dir, "MEMORY.md", "# Test\n\nWorker threads improve performance.");

  await syncMemoryFiles(db, dir);

  if (isFtsAvailable(db)) {
    // FTS search should find the content
    const ftsResults = db
      .prepare(`SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'worker'`)
      .all();
    assert.ok(ftsResults.length > 0, "FTS index not populated");
  }
});

// ---------------------------------------------------------------------------
// syncMemoryFiles — empty workspace
// ---------------------------------------------------------------------------

test("syncMemoryFiles handles empty workspace", async (t) => {
  const { dir, dbPath } = tmpWorkspace();
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  t.after(() => { db.close(); cleanupDir(dir); });

  const result = await syncMemoryFiles(db, dir);
  assert.equal(result.indexed, 0);
  assert.equal(result.deleted, 0);
});
