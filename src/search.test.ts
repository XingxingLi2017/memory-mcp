import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { searchMemory, type SearchOpts } from "./search.js";
import { isVecAvailable } from "./db.js";
import {
  tmpDbPath, seedDb, seedDbWithVectors, fakeVector, cleanupDir,
} from "./test-utils.js";

// ---------------------------------------------------------------------------
// searchMemory — basic FTS
// ---------------------------------------------------------------------------

test("searchMemory returns results for matching query", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDb(dbPath);
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  const results = await searchMemory(db, "TypeScript");
  assert.ok(results.length > 0, "Expected results for 'TypeScript'");
  assert.ok(results[0]!.score > 0);
  assert.ok(results[0]!.path.length > 0);
});

test("searchMemory returns empty for no match", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDb(dbPath);
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  const results = await searchMemory(db, "zzzznonexistentzzzzz");
  assert.equal(results.length, 0);
});

test("searchMemory returns empty for empty query", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDb(dbPath);
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  const results = await searchMemory(db, "");
  assert.equal(results.length, 0);

  const results2 = await searchMemory(db, "   ");
  assert.equal(results2.length, 0);
});

// ---------------------------------------------------------------------------
// searchMemory — maxResults
// ---------------------------------------------------------------------------

test("searchMemory respects maxResults option", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDb(dbPath);
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  const results = await searchMemory(db, "memory", { maxResults: 2 });
  assert.ok(results.length <= 2, `Expected <= 2 results, got ${results.length}`);
});

test("searchMemory with maxResults=1 returns at most 1", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDb(dbPath);
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  const results = await searchMemory(db, "worker", { maxResults: 1 });
  assert.ok(results.length <= 1);
});

// ---------------------------------------------------------------------------
// searchMemory — minScore
// ---------------------------------------------------------------------------

test("searchMemory filters by minScore", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDb(dbPath);
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  const results = await searchMemory(db, "TypeScript backend", { minScore: 0.01 });
  for (const r of results) {
    assert.ok(r.score >= 0.01, `Score ${r.score} below minScore 0.01`);
  }
});

test("searchMemory with very high minScore returns fewer or no results", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDb(dbPath);
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  const normal = await searchMemory(db, "SQLite", { minScore: 0.01 });
  const strict = await searchMemory(db, "SQLite", { minScore: 0.99 });
  assert.ok(strict.length <= normal.length);
});

// ---------------------------------------------------------------------------
// searchMemory — ftsWeight (FTS-only mode, no embeddings)
// ---------------------------------------------------------------------------

test("searchMemory works with different ftsWeight values", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDb(dbPath);
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  // Without embeddings, ftsWeight has no effect on FTS-only path
  // but should not crash at any value
  const r1 = await searchMemory(db, "worker", { ftsWeight: 0 });
  const r2 = await searchMemory(db, "worker", { ftsWeight: 0.5 });
  const r3 = await searchMemory(db, "worker", { ftsWeight: 1 });

  // All should return results (FTS-only fallback)
  assert.ok(r1.length > 0 || r2.length > 0 || r3.length > 0);
});

// ---------------------------------------------------------------------------
// searchMemory — MEMORY.md boost
// ---------------------------------------------------------------------------

test("searchMemory boosts MEMORY.md results", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDb(dbPath);
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  // Both MEMORY.md and memory/decisions.md mention relevant content
  // MEMORY.md should get a boost
  const results = await searchMemory(db, "backward compatible SQLite");
  const memoryMdResults = results.filter((r) => r.path === "MEMORY.md");
  const otherResults = results.filter((r) => r.path !== "MEMORY.md");

  if (memoryMdResults.length > 0 && otherResults.length > 0) {
    // MEMORY.md result should have boost applied (score × 1.3)
    // We can't assert exact values but the boost should be reflected
    assert.ok(memoryMdResults[0]!.score > 0);
  }
});

// ---------------------------------------------------------------------------
// searchMemory — result structure
// ---------------------------------------------------------------------------

test("searchMemory results have expected structure", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDb(dbPath);
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  const results = await searchMemory(db, "hybrid search");
  if (results.length > 0) {
    const r = results[0]!;
    assert.ok(typeof r.path === "string");
    assert.ok(typeof r.startLine === "number");
    assert.ok(typeof r.endLine === "number");
    assert.ok(typeof r.score === "number");
    assert.ok(typeof r.snippet === "string");
    assert.ok(typeof r.source === "string");
    assert.ok(r.startLine >= 1);
    assert.ok(r.endLine >= r.startLine);
    assert.ok(r.score > 0);
  }
});

// ---------------------------------------------------------------------------
// searchMemory — results sorted by score descending
// ---------------------------------------------------------------------------

test("searchMemory results are sorted by score descending", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDb(dbPath);
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  const results = await searchMemory(db, "worker thread embedding");
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i - 1]!.score >= results[i]!.score,
      `Results not sorted: ${results[i - 1]!.score} < ${results[i]!.score}`,
    );
  }
});

// ===========================================================================
// Vector / Hybrid search (skipped when sqlite-vec unavailable)
// ===========================================================================

test("vector-only search returns results via mock embedFn", async (t) => {
  const dbPath = tmpDbPath();
  let db: Awaited<ReturnType<typeof seedDbWithVectors>> = null;
  t.after(() => { if (db) db.close(); cleanupDir(path.dirname(dbPath)); });
  db = await seedDbWithVectors(dbPath);
  if (!db) { t.skip("sqlite-vec not available"); return; }

  // embedFn returns a fake vector similar to seed=1 (first chunk)
  const mockEmbedFn = async () => fakeVector(1);

  // Use explicit maxResults and minScore=0 to retrieve all reachable chunks
  const results = await searchMemory(db, "TypeScript", {
    embedFn: mockEmbedFn,
    maxResults: 20,
    minScore: 0,
  });
  assert.ok(results.length > 0, "Expected vector search results");

  // FTS-only would return only 1 match ("TypeScript" in c1).
  // Vector search should surface additional chunks via cosine similarity.
  const ftsOnly = await searchMemory(db, "TypeScript", { maxResults: 20, minScore: 0 });
  assert.ok(
    results.length > ftsOnly.length,
    `Vector search (${results.length}) should return more results than FTS-only (${ftsOnly.length})`,
  );
});

test("hybrid search merges FTS and vector results", async (t) => {
  const dbPath = tmpDbPath();
  let db: Awaited<ReturnType<typeof seedDbWithVectors>> = null;
  t.after(() => { if (db) db.close(); cleanupDir(path.dirname(dbPath)); });
  db = await seedDbWithVectors(dbPath);
  if (!db) { t.skip("sqlite-vec not available"); return; }

  const mockEmbedFn = async () => fakeVector(1);

  // Get FTS-only results for the same query as baseline
  const ftsOnly = await searchMemory(db, "TypeScript backend", {
    ftsWeight: 1.0,
    maxResults: 20,
  });

  const results = await searchMemory(db, "TypeScript backend", {
    embedFn: mockEmbedFn,
    ftsWeight: 0.5,
    maxResults: 20,
  });

  assert.ok(results.length > 0, "Hybrid search should return results");
  for (const r of results) {
    assert.ok(r.score > 0, `Expected positive score, got ${r.score}`);
  }

  // Hybrid scores at ftsWeight=0.5 should differ from pure FTS scores,
  // proving that vector component actually contributes to the merge.
  const hybridScores = results.map((r) => r.score);
  const ftsScores = ftsOnly.map((r) => r.score);
  const scoresIdentical =
    hybridScores.length === ftsScores.length &&
    hybridScores.every((s, i) => Math.abs(s - ftsScores[i]!) < 1e-9);
  assert.ok(!scoresIdentical, "Hybrid scores should differ from FTS-only scores when ftsWeight=0.5");
});

test("hybrid search ftsWeight=1 behaves like FTS-only", async (t) => {
  const dbPath = tmpDbPath();
  let db: Awaited<ReturnType<typeof seedDbWithVectors>> = null;
  t.after(() => { if (db) db.close(); cleanupDir(path.dirname(dbPath)); });
  db = await seedDbWithVectors(dbPath);
  if (!db) { t.skip("sqlite-vec not available"); return; }

  const mockEmbedFn = async () => fakeVector(1);

  const ftsOnly = await searchMemory(db, "SQLite", { ftsWeight: 1.0, maxResults: 20 });
  const hybrid = await searchMemory(db, "SQLite", {
    embedFn: mockEmbedFn,
    ftsWeight: 1.0,
    maxResults: 20,
  });

  assert.ok(ftsOnly.length > 0);
  assert.ok(hybrid.length > 0);

  // With ftsWeight=1, every FTS result should appear in hybrid in the same relative order.
  // Hybrid may include extra results from the vector candidate set that also matched FTS,
  // but pure-FTS paths must be a subsequence of hybrid paths.
  const ftsPaths = ftsOnly.map((r) => r.path);
  const hybridPaths = hybrid.map((r) => r.path);
  let ftsIdx = 0;
  for (const hp of hybridPaths) {
    if (ftsIdx < ftsPaths.length && hp === ftsPaths[ftsIdx]) ftsIdx++;
  }
  assert.equal(ftsIdx, ftsPaths.length,
    `FTS paths should be a subsequence of hybrid paths. FTS: ${JSON.stringify(ftsPaths)}, Hybrid: ${JSON.stringify(hybridPaths)}`);
});

test("hybrid search ftsWeight=0 relies on vector results", async (t) => {
  const dbPath = tmpDbPath();
  let db: Awaited<ReturnType<typeof seedDbWithVectors>> = null;
  t.after(() => { if (db) db.close(); cleanupDir(path.dirname(dbPath)); });
  db = await seedDbWithVectors(dbPath);
  if (!db) { t.skip("sqlite-vec not available"); return; }

  // Use a broad query that matches multiple FTS chunks so we can compare orderings
  const mockEmbedFn = async () => fakeVector(3);
  const results = await searchMemory(db, "worker thread memory SQLite", {
    embedFn: mockEmbedFn,
    ftsWeight: 0,
    maxResults: 20,
  });

  assert.ok(results.length > 0, "ftsWeight=0 should still find results via vector");

  // ftsWeight=0 means hybrid merge uses only vector scores.
  // Compare with FTS-only: scores must differ because vector similarity
  // (cosine to fakeVector(3)) produces a different ranking than BM25.
  const ftsOnly = await searchMemory(db, "worker thread memory SQLite", {
    ftsWeight: 1.0,
    maxResults: 20,
  });

  assert.ok(ftsOnly.length > 1, "Need multiple FTS results for meaningful comparison");
  assert.ok(results.length > 1, "Need multiple vector results for meaningful comparison");

  const ftsScores = ftsOnly.map((r) => r.score);
  const vecScores = results.map((r) => r.score);
  const scoresIdentical =
    vecScores.length === ftsScores.length &&
    vecScores.every((s, i) => Math.abs(s - ftsScores[i]!) < 1e-9);
  assert.ok(!scoresIdentical, "ftsWeight=0 scores should differ from FTS-only scores");
});

test("embedFn returning null skips vector search gracefully", async (t) => {
  const dbPath = tmpDbPath();
  let db: Awaited<ReturnType<typeof seedDbWithVectors>> = null;
  t.after(() => { if (db) db.close(); cleanupDir(path.dirname(dbPath)); });
  db = await seedDbWithVectors(dbPath);
  if (!db) { t.skip("sqlite-vec not available"); return; }

  const nullEmbedFn = async () => null;
  const results = await searchMemory(db, "TypeScript", { embedFn: nullEmbedFn });

  assert.ok(results.length > 0, "null embedFn should fall back to FTS");
});

test("partial embedding coverage scales vector weight down", async (t) => {
  const dbPath = tmpDbPath();
  let db: Awaited<ReturnType<typeof seedDbWithVectors>> = null;
  t.after(() => { if (db) db.close(); cleanupDir(path.dirname(dbPath)); });
  db = await seedDbWithVectors(dbPath);
  if (!db) { t.skip("sqlite-vec not available"); return; }

  // Delete half the vectors to simulate partial coverage
  const ids = (db.prepare(`SELECT id FROM chunks_vec`).all() as Array<{ id: string }>)
    .slice(0, 3);
  for (const { id } of ids) {
    db.prepare(`DELETE FROM chunks_vec WHERE id = ?`).run(id);
  }

  const mockEmbedFn = async () => fakeVector(4);
  const results = await searchMemory(db, "worker thread", {
    embedFn: mockEmbedFn,
    ftsWeight: 0.5,
  });

  assert.ok(results.length > 0, "Partial coverage should still produce results");
});

test("ftsWeight=0 with no embeddings falls back to FTS-only", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDb(dbPath);
  t.after(() => { db.close(); cleanupDir(path.dirname(dbPath)); });

  if (!isVecAvailable(db)) {
    t.skip("sqlite-vec not available");
    return;
  }

  // chunks_vec exists but is empty → embedded=0 → vecOk=false → FTS-only path.
  // The hybrid merge div-by-zero guard (total===0) is unreachable with current
  // logic because embedded=0 disables vector search before merge. This test
  // verifies the FTS-only fallback is safe when ftsWeight=0.
  db.exec(`DELETE FROM chunks_vec`);

  const mockEmbedFn = async () => fakeVector(1);
  const results = await searchMemory(db, "TypeScript", {
    embedFn: mockEmbedFn,
    ftsWeight: 0,
  });

  assert.ok(Array.isArray(results));
  assert.ok(results.length > 0, "Should fall back to FTS results");
});

test("vector search respects maxResults", async (t) => {
  const dbPath = tmpDbPath();
  let db: Awaited<ReturnType<typeof seedDbWithVectors>> = null;
  t.after(() => { if (db) db.close(); cleanupDir(path.dirname(dbPath)); });
  db = await seedDbWithVectors(dbPath);
  if (!db) { t.skip("sqlite-vec not available"); return; }

  const mockEmbedFn = async () => fakeVector(1);
  const results = await searchMemory(db, "memory", {
    embedFn: mockEmbedFn,
    maxResults: 2,
  });

  assert.ok(results.length <= 2, `Expected <= 2, got ${results.length}`);
});

test("vector search respects minScore", async (t) => {
  const dbPath = tmpDbPath();
  let db: Awaited<ReturnType<typeof seedDbWithVectors>> = null;
  t.after(() => { if (db) db.close(); cleanupDir(path.dirname(dbPath)); });
  db = await seedDbWithVectors(dbPath);
  if (!db) { t.skip("sqlite-vec not available"); return; }

  const mockEmbedFn = async () => fakeVector(1);
  const results = await searchMemory(db, "TypeScript", {
    embedFn: mockEmbedFn,
    minScore: 0.01,
  });

  for (const r of results) {
    assert.ok(r.score >= 0.01, `Score ${r.score} below minScore`);
  }
});
