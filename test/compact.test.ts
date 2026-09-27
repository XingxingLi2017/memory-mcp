import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  openDatabase,
  isVecAvailable,
  getVecHealth,
  vecHealthStatus,
  compactVectorIndex,
} from "../src/db.js";
import { syncMemoryFiles, syncEmbeddings } from "../src/sync.js";
import { searchMemory, isVecBloated } from "../src/search.js";
import { vectorToBuffer } from "../src/embedding.js";
import {
  tmpWorkspace,
  tmpDbPath,
  writeFile,
  cleanupDir,
  seedDbWithVectors,
  fakeVector,
} from "./test-utils.js";
import type Database from "better-sqlite3";

const CHUNK_SIZE = 64;

function section(n: number): string {
  const words = Array.from({ length: 40 }, (_, i) => `topic${n}word${i}`).join(" ");
  return `## Section ${n}\n\n${words}\n`;
}

/** Give every chunk without a vector a cached embedding, then run syncEmbeddings (no model needed). */
async function embedFromCache(db: Database.Database): Promise<number> {
  const rows = db.prepare(`SELECT DISTINCT hash FROM chunks`).all() as Array<{ hash: string }>;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO embedding_cache (hash, embedding, updated_at) VALUES (?, ?, ?)`,
  );
  rows.forEach((r, i) => insert.run(r.hash, vectorToBuffer(fakeVector(i + 1)), Date.now()));
  return syncEmbeddings(db);
}

function vecRowids(db: Database.Database): Map<string, number> {
  const rows = db.prepare(`SELECT rowid, id FROM chunks_vec_rowids`).all() as Array<{ rowid: number; id: string }>;
  return new Map(rows.map((r) => [r.id, r.rowid]));
}

function chunkIds(db: Database.Database): Set<string> {
  return new Set((db.prepare(`SELECT id FROM chunks`).all() as Array<{ id: string }>).map((r) => r.id));
}

async function openSyncedWorkspace(t: test.TestContext, content: string) {
  const { dir, dbPath } = tmpWorkspace();
  writeFile(dir, "MEMORY.md", content);
  const db = await openDatabase(dbPath, { chunkSize: CHUNK_SIZE });
  t.after(() => { db.close(); cleanupDir(dir); });
  if (!isVecAvailable(db)) return null;
  await syncMemoryFiles(db, dir, { chunkSize: CHUNK_SIZE });
  await embedFromCache(db);
  return { dir, db };
}

test("appending to a file keeps existing vectors and adds slots only for new chunks", async (t) => {
  const initial = [1, 2, 3, 4, 5, 6].map(section).join("\n");
  const ws = await openSyncedWorkspace(t, initial);
  if (!ws) return t.skip("sqlite-vec not available");
  const { dir, db } = ws;

  const idsBefore = chunkIds(db);
  const rowidsBefore = vecRowids(db);
  assert.ok(idsBefore.size >= 3, `expected several chunks, got ${idsBefore.size}`);
  assert.equal(rowidsBefore.size, idsBefore.size);
  const maxRowidBefore = Math.max(...rowidsBefore.values());

  writeFile(dir, "MEMORY.md", initial + "\n" + section(7));
  await syncMemoryFiles(db, dir, { chunkSize: CHUNK_SIZE });

  const idsAfter = chunkIds(db);
  const kept = [...idsBefore].filter((id) => idsAfter.has(id));
  const added = [...idsAfter].filter((id) => !idsBefore.has(id));
  assert.ok(kept.length >= idsBefore.size - 1, "unchanged chunks keep their ids");
  assert.ok(added.length >= 1, "appended content produces new chunks");

  const rowidsMid = vecRowids(db);
  for (const id of kept) {
    assert.equal(rowidsMid.get(id), rowidsBefore.get(id), `vector of kept chunk ${id} was rewritten`);
  }
  for (const id of idsBefore) {
    if (!idsAfter.has(id)) assert.equal(rowidsMid.has(id), false, `vector of removed chunk ${id} was left behind`);
  }

  const ftsIds = (db.prepare(`SELECT id FROM chunks_fts`).all() as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(new Set(ftsIds), idsAfter, "FTS rows match chunks exactly");
  assert.equal(ftsIds.length, idsAfter.size, "no duplicate FTS rows");

  await embedFromCache(db);
  const rowidsAfter = vecRowids(db);
  assert.equal(rowidsAfter.size, idsAfter.size);
  const newSlots = [...rowidsAfter.values()].filter((r) => r > maxRowidBefore).length;
  assert.equal(newSlots, added.length, "only new chunks received vector slots");
});

test("re-syncing an unchanged file never rewrites chunks_vec", async (t) => {
  const ws = await openSyncedWorkspace(t, [1, 2, 3, 4].map(section).join("\n"));
  if (!ws) return t.skip("sqlite-vec not available");
  const { dir, db } = ws;

  const rowidsBefore = vecRowids(db);
  const healthBefore = getVecHealth(db)!;
  for (let i = 0; i < 2; i++) {
    await syncMemoryFiles(db, dir, { chunkSize: CHUNK_SIZE, force: true });
    assert.equal(await syncEmbeddings(db), 0, "nothing left to embed");
  }
  assert.deepEqual(vecRowids(db), rowidsBefore);
  assert.deepEqual(getVecHealth(db), healthBefore);
});

test("vec health reports blocks, slots, live vectors and utilization", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDbWithVectors(dbPath);
  t.after(() => { db?.close(); cleanupDir(path.dirname(dbPath)); });
  if (!db) return t.skip("sqlite-vec not available");

  const status = vecHealthStatus(db);
  assert.equal(status.vecLive, 6);
  assert.equal(status.vecBlocks, 1);
  assert.ok(status.vecSlots >= 6);
  assert.equal(status.vecUtilization, Number((6 / status.vecSlots).toFixed(4)));
});

/** Insert and delete throwaway vectors so vec0 is left with mostly dead slots. */
function churn(db: Database.Database, count: number): void {
  const insert = db.prepare(`INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)`);
  const del = db.prepare(`DELETE FROM chunks_vec WHERE id = ?`);
  const buf = vectorToBuffer(fakeVector(99));
  db.transaction(() => {
    for (let i = 0; i < count; i++) insert.run(`churn-${i}`, buf);
    for (let i = 0; i < count; i++) del.run(`churn-${i}`);
  })();
}

test("compaction rebuilds a sparse vector index and preserves vectors and results", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDbWithVectors(dbPath);
  t.after(() => { db?.close(); cleanupDir(path.dirname(dbPath)); });
  if (!db) return t.skip("sqlite-vec not available");

  const knn = () => db.prepare(
    `SELECT id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = 10 ORDER BY distance`,
  ).all(vectorToBuffer(fakeVector(3)));
  const knnBefore = knn();
  assert.equal(knnBefore.length, 6, "KNN covers every vector");
  const topBefore = (await searchMemory(db, "hybrid search vector", { embedFn: async () => fakeVector(3) }))[0];
  churn(db, 2100);
  const sparse = getVecHealth(db)!;
  assert.ok(sparse.blocks >= 3, `expected dead blocks, got ${sparse.blocks}`);
  assert.equal(sparse.live, 6);

  const skipped = compactVectorIndex(db);
  assert.equal(skipped.compacted, false, "default thresholds need more dead slots");

  const result = compactVectorIndex(db, { minDeadSlots: 1000 });
  assert.equal(result.compacted, true);
  assert.equal(result.after!.live, 6);
  assert.equal(result.after!.blocks, 1);

  assert.deepEqual(knn(), knnBefore, "KNN results unchanged");
  const topAfter = (await searchMemory(db, "hybrid search vector", { embedFn: async () => fakeVector(3) }))[0];
  assert.equal(topAfter?.path, topBefore?.path);
  assert.equal(topAfter?.startLine, topBefore?.startLine);
});

test("compaction drops vectors whose chunk no longer exists", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDbWithVectors(dbPath);
  t.after(() => { db?.close(); cleanupDir(path.dirname(dbPath)); });
  if (!db) return t.skip("sqlite-vec not available");

  db.prepare(`INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)`).run("orphan", vectorToBuffer(fakeVector(7)));
  const result = compactVectorIndex(db, { force: true });
  assert.equal(result.compacted, true);
  assert.equal(result.after!.live, 6);
});

test("search skips vector KNN and returns FTS results when the index is bloated", async (t) => {
  const dbPath = tmpDbPath();
  const db = await seedDbWithVectors(dbPath);
  t.after(() => { db?.close(); cleanupDir(path.dirname(dbPath)); });
  if (!db) return t.skip("sqlite-vec not available");

  let embedCalls = 0;
  const embedFn = async () => { embedCalls++; return fakeVector(3); };

  await searchMemory(db, "TypeScript", { embedFn });
  assert.equal(embedCalls, 1, "healthy index uses vector search");

  // Small vec0 blocks let a short churn produce the dead-block layout of a large index.
  const live = db.prepare(`SELECT id, embedding FROM chunks_vec`).all() as Array<{ id: string; embedding: Buffer }>;
  db.exec(`DROP TABLE chunks_vec`);
  db.exec(
    `CREATE VIRTUAL TABLE chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding float[768] distance_metric=cosine, chunk_size=8)`,
  );
  const insert = db.prepare(`INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)`);
  for (const row of live) insert.run(row.id, row.embedding);
  churn(db, 8 * 70);
  const health = getVecHealth(db)!;
  assert.equal(health.live, 6);
  assert.ok(health.blocks > 64, `expected many dead blocks, got ${health.blocks}`);
  assert.equal(isVecBloated(health), true);

  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  let results;
  try {
    results = await searchMemory(db, "TypeScript", { embedFn });
  } finally {
    console.error = origError;
  }
  assert.equal(embedCalls, 1, "bloated index skips query embedding and KNN");
  assert.ok(results.length > 0, "FTS results still returned");
  assert.ok(results.some((r) => r.snippet.includes("TypeScript")));
  assert.ok(errors.some((e) => e.includes("memory-mcp-cli compact")), "logs a compact hint");
});

test("isVecBloated tolerates small and proportional indexes", () => {
  assert.equal(isVecBloated({ blocks: 64, slots: 64 * 1024, live: 10, utilization: 0 }), false);
  assert.equal(isVecBloated({ blocks: 65, slots: 65 * 1024, live: 10, utilization: 0 }), true);
  assert.equal(isVecBloated({ blocks: 100, slots: 100 * 1024, live: 30 * 1024, utilization: 0.3 }), false);
  assert.equal(isVecBloated({ blocks: 121, slots: 121 * 1024, live: 30 * 1024, utilization: 0.25 }), true);
  assert.equal(isVecBloated({ blocks: 80, slots: 80 * 8, live: 600, utilization: 0.94 }), false, "uses actual block size");
});


test("syncEmbeddings compacts a sparse vector index while holding the embedding lock", async (t) => {
  const ws = await openSyncedWorkspace(t, [1, 2, 3].map(section).join("\n"));
  if (!ws) return t.skip("sqlite-vec not available");
  const { db } = ws;

  const live = getVecHealth(db)!.live;
  churn(db, 2100);
  assert.ok(getVecHealth(db)!.blocks >= 3);

  await syncEmbeddings(db);
  assert.ok(getVecHealth(db)!.blocks >= 3, "default thresholds leave a small index alone");

  assert.equal(await syncEmbeddings(db, { compact: { minDeadSlots: 1000 } }), 0, "nothing to embed");
  const after = getVecHealth(db)!;
  assert.equal(after.blocks, 1);
  assert.equal(after.live, live);
  assert.equal(db.prepare(`SELECT 1 FROM meta WHERE key = 'embedding_lock'`).get(), undefined, "lock released");
});

// ---------------------------------------------------------------------------
// Real CLI and MCP server processes
// ---------------------------------------------------------------------------

const DIST_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Temp HOME with a config pointing at a synced, fully embedded workspace. */
async function prepareHome(t: test.TestContext) {
  const home = tmpWorkspace().dir;
  t.after(() => cleanupDir(home));
  const workspace = path.join(home, "ws");
  const dbPath = path.join(workspace, "memory.db");
  writeFile(workspace, "MEMORY.md", [1, 2].map(section).join("\n"));
  writeFile(home, path.join(".memory-mcp-workdir", "memory-mcp.json"), JSON.stringify({ workspace, dbPath, sessionDirs: [] }));
  // Same chunk size as the default config, so the child processes do not rebuild the index
  const db = await openDatabase(dbPath, { chunkSize: 512 });
  try {
    if (!isVecAvailable(db)) return null;
    await syncMemoryFiles(db, workspace, { chunkSize: 512 });
    await embedFromCache(db);
    const chunks = (db.prepare(`SELECT COUNT(*) AS c FROM chunks`).get() as { c: number }).c;
    return { home, workspace, dbPath, chunks };
  } finally {
    db.close();
  }
}

function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, MEMORY_MCP_NO_WORKER: "1" };
  delete env.MEMORY_MCP_PROFILE;
  return env;
}

function runCli(home: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(DIST_SRC, "cli.js"), ...args], { env: childEnv(home) });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

function assertVecStatus(status: Record<string, unknown>, chunks: number): void {
  assert.equal(status.vecLive, chunks);
  assert.equal(status.vecBlocks, 1);
  assert.equal(typeof status.vecSlots, "number");
  assert.ok((status.vecSlots as number) >= chunks);
  assert.equal(status.vecUtilization, Number((chunks / (status.vecSlots as number)).toFixed(4)));
}

test("CLI status reports vector index health", async (t) => {
  const env = await prepareHome(t);
  if (!env) return t.skip("sqlite-vec not available");
  const { code, stdout } = await runCli(env.home, ["status", "--workspace", env.workspace, "--db-path", env.dbPath]);
  assert.equal(code, 0);
  assertVecStatus(JSON.parse(stdout), env.chunks);
});

test("CLI compact refuses to rebuild while another process holds the embedding lock", async (t) => {
  const env = await prepareHome(t);
  if (!env) return t.skip("sqlite-vec not available");
  const db = await openDatabase(env.dbPath, { chunkSize: 512 });
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_lock', ?)`).run(
    JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
  );
  db.close();

  const blocked = await runCli(env.home, ["compact", "--workspace", env.workspace, "--db-path", env.dbPath]);
  assert.equal(blocked.code, 1);
  const out = JSON.parse(blocked.stdout);
  assert.equal(out.compacted, false);
  assert.match(out.reason, /lock/);

  const db2 = await openDatabase(env.dbPath, { chunkSize: 512 });
  db2.prepare(`DELETE FROM meta WHERE key = 'embedding_lock'`).run();
  db2.close();
  const done = await runCli(env.home, ["compact", "--workspace", env.workspace, "--db-path", env.dbPath]);
  assert.equal(done.code, 0);
  const result = JSON.parse(done.stdout);
  assert.equal(result.compacted, true);
  assert.equal(typeof result.walTruncated, "boolean");
  assert.equal(result.after.vecLive, env.chunks);
});

test("memory_status over MCP stdio reports vector index health", async (t) => {
  const env = await prepareHome(t);
  if (!env) return t.skip("sqlite-vec not available");

  const child = spawn(process.execPath, [path.join(DIST_SRC, "server.js")], { env: childEnv(env.home) });
  const exited = new Promise((r) => child.on("close", r));
  child.stderr.resume();
  try {
    await callMemoryStatus(child, env.chunks);
  } finally {
    // Stop the server before the temp dir cleanup, which cannot unlink an open database
    child.kill();
    await exited;
  }
});

async function callMemoryStatus(child: ReturnType<typeof spawn>, chunks: number): Promise<void> {
  const stdin = child.stdin!;
  const stdout = child.stdout!;
  const send = (msg: object) => stdin.write(JSON.stringify(msg) + "\n");

  const response = await new Promise<{ result: { content: Array<{ text: string }> } }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("memory_status timed out")), 30000);
    let buf = "";
    stdout.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_status", arguments: {} } });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          resolve(msg);
        }
      }
    });
    child.on("error", reject);
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
  });

  assertVecStatus(JSON.parse(response.result.content[0]!.text), chunks);
}
