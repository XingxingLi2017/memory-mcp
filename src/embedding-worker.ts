/**
 * Worker thread for embedding operations.
 * Runs model loading and inference off the main thread so the MCP server
 * event loop stays responsive. Communicates via parentPort messages.
 *
 * Query priority: embed_query and sync_embeddings both use the same
 * underlying model context. Since node-llama-cpp serializes getEmbeddingFor
 * internally, queries naturally interleave between individual sync chunk
 * embeddings (~10-50ms each). The message handler does NOT await handleSync,
 * so query messages are always received and dispatched immediately.
 *
 * Message protocol — see embedding-bridge.ts for the main-thread side.
 */

import { parentPort, workerData } from "node:worker_threads";
import { openDatabase } from "./db.js";
import { setModelSpec, embedText } from "./embedding.js";
import { syncEmbeddings } from "./sync.js";

if (!parentPort) {
  throw new Error("embedding-worker must be run as a worker thread");
}

const port = parentPort;

interface InitMsg { type: "init"; dbPath: string; modelSpec: string; chunkSize: number }
interface EmbedQueryMsg { type: "embed_query"; id: number; text: string }
interface SyncMsg { type: "sync_embeddings" }
interface ShutdownMsg { type: "shutdown" }
type IncomingMsg = InitMsg | EmbedQueryMsg | SyncMsg | ShutdownMsg;

let db: ReturnType<typeof import("better-sqlite3")> | null = null;
let modelReady = false;
let syncRunning = false;
let syncPending = false;

let shutdownRequested = false;
let activeSyncPromise: Promise<void> | null = null;

port.on("message", (msg: IncomingMsg) => {
  switch (msg.type) {
    case "init":
      handleInit(msg);
      break;
    case "embed_query":
      if (shutdownRequested) {
        port.postMessage({ type: "query_error", id: (msg as EmbedQueryMsg).id, error: "Worker shutting down" });
        break;
      }
      handleEmbedQuery(msg);
      break;
    case "sync_embeddings":
      if (shutdownRequested) break;
      // Fire-and-forget — sync runs in background, queries interleave naturally
      handleSync();
      break;
    case "shutdown":
      handleShutdown();
      break;
  }
});

async function handleShutdown(): Promise<void> {
  shutdownRequested = true;
  // Wait for any active sync to finish before closing DB
  if (activeSyncPromise) {
    try { await activeSyncPromise; } catch {}
  }
  if (db) try { db.close(); } catch {}
  process.exit(0);
}

async function handleInit(msg: InitMsg): Promise<void> {
  try {
    setModelSpec(msg.modelSpec);
    db = await openDatabase(msg.dbPath, { chunkSize: msg.chunkSize });

    // Warm up the model — this is the slow part (~80s), but it only
    // blocks THIS thread, not the main thread.
    await embedText("warmup");
    modelReady = true;
    port.postMessage({ type: "ready" });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    port.postMessage({ type: "init_error", error });
  }
}

async function handleEmbedQuery(msg: EmbedQueryMsg): Promise<void> {
  if (!modelReady) {
    port.postMessage({ type: "query_error", id: msg.id, error: "Model not ready" });
    return;
  }
  try {
    const vector = await embedText(msg.text);
    port.postMessage({ type: "query_result", id: msg.id, vector });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    port.postMessage({ type: "query_error", id: msg.id, error });
  }
}

function handleSync(): void {
  if (!db) {
    port.postMessage({ type: "sync_complete", count: 0 });
    return;
  }
  if (syncRunning) {
    syncPending = true;
    return;
  }
  syncRunning = true;
  activeSyncPromise = doSync();
}

async function doSync(): Promise<void> {
  try {
    let totalCount = 0;
    do {
      syncPending = false;
      const count = await syncEmbeddings(db!);
      totalCount += count;
    } while (syncPending && !shutdownRequested);
    port.postMessage({ type: "sync_complete", count: totalCount });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    port.postMessage({ type: "sync_error", error });
  } finally {
    syncRunning = false;
    syncPending = false;
    activeSyncPromise = null;
  }
}
