/**
 * Main-thread bridge to the embedding worker.
 * Spawns a worker_threads Worker and provides async APIs for:
 * - Query embedding (for search)
 * - Background embedding sync
 * - Readiness check
 */

import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve worker script path relative to this file's compiled location (dist/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, "embedding-worker.js");

let worker: Worker | null = null;
let workerReady = false;
let workerFailed = false;
let queryIdCounter = 0;

// Pending embed_query promises keyed by request ID
const pendingQueries = new Map<number, {
  resolve: (vec: number[]) => void;
  reject: (err: Error) => void;
}>();

// Callbacks for sync completion
type SyncCallback = (count: number) => void;
let syncCallback: SyncCallback | null = null;

interface ReadyMsg { type: "ready" }
interface InitErrorMsg { type: "init_error"; error: string }
interface QueryResultMsg { type: "query_result"; id: number; vector: number[] }
interface QueryErrorMsg { type: "query_error"; id: number; error: string }
interface SyncCompleteMsg { type: "sync_complete"; count: number }
interface SyncErrorMsg { type: "sync_error"; error: string }
type WorkerMsg = ReadyMsg | InitErrorMsg | QueryResultMsg | QueryErrorMsg | SyncCompleteMsg | SyncErrorMsg;

/**
 * Initialize and spawn the embedding worker thread.
 * Call once at server startup. Non-blocking — model loads in background.
 */
export function initEmbeddingWorker(dbPath: string, modelSpec: string, chunkSize: number): void {
  if (worker) return;

  worker = new Worker(WORKER_PATH);

  worker.on("message", (msg: WorkerMsg) => {
    switch (msg.type) {
      case "ready":
        workerReady = true;
        console.error("[memory-mcp] embedding worker ready");
        // Cold-start catch-up: initial file sync likely finished before worker
        // was ready, so triggerWorkerSync() was a no-op. Now that the model is
        // loaded, immediately kick off the first embedding pass.
        worker!.postMessage({ type: "sync_embeddings" });
        break;
      case "init_error":
        workerFailed = true;
        console.error("[memory-mcp] embedding worker init failed:", msg.error);
        break;
      case "query_result": {
        const q = pendingQueries.get(msg.id);
        if (q) { pendingQueries.delete(msg.id); q.resolve(msg.vector); }
        break;
      }
      case "query_error": {
        const q = pendingQueries.get(msg.id);
        if (q) { pendingQueries.delete(msg.id); q.reject(new Error(msg.error)); }
        break;
      }
      case "sync_complete":
        if (syncCallback) { const cb = syncCallback; syncCallback = null; cb(msg.count); }
        break;
      case "sync_error":
        console.error("[memory-mcp] embedding sync error:", msg.error);
        if (syncCallback) { syncCallback = null; }
        break;
    }
  });

  worker.on("error", (err) => {
    console.error("[memory-mcp] embedding worker error:", err.message);
    workerFailed = true;
    // Reject all pending queries
    for (const [id, q] of pendingQueries) {
      q.reject(new Error("Worker crashed"));
      pendingQueries.delete(id);
    }
  });

  worker.on("exit", (code) => {
    if (code !== 0) console.error("[memory-mcp] embedding worker exited with code", code);
    worker = null;
    workerReady = false;
  });

  // Send init message — worker will load model and post "ready" when done
  worker.postMessage({ type: "init", dbPath, modelSpec, chunkSize });
}

/**
 * Check if the worker has loaded the model and is ready for queries.
 */
export function isWorkerReady(): boolean {
  return workerReady && !workerFailed;
}

/**
 * Embed a single text via the worker thread.
 * Returns the normalized embedding vector.
 * Rejects if worker not ready or embed fails.
 */
export function embedTextViaWorker(text: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    if (!worker || !workerReady) {
      reject(new Error("Embedding worker not ready"));
      return;
    }
    const id = ++queryIdCounter;
    pendingQueries.set(id, { resolve, reject });
    worker.postMessage({ type: "embed_query", id, text });
  });
}

/**
 * Trigger a background embedding sync cycle in the worker.
 * Fire-and-forget — does not block. Optional callback on completion.
 */
export function triggerWorkerSync(onComplete?: SyncCallback): void {
  if (!worker || !workerReady) return;
  if (onComplete) syncCallback = onComplete;
  worker.postMessage({ type: "sync_embeddings" });
}

/**
 * Gracefully shut down the worker thread.
 * Returns a promise that resolves when the worker exits.
 * Rejects any in-flight query promises.
 */
export function shutdownWorker(): Promise<void> {
  if (!worker) return Promise.resolve();
  const w = worker;
  worker = null;
  workerReady = false;

  // Reject any in-flight queries
  for (const [id, pending] of pendingQueries) {
    pending.reject(new Error("Worker shutting down"));
  }
  pendingQueries.clear();

  return new Promise<void>((resolve) => {
    w.once("exit", () => resolve());
    w.postMessage({ type: "shutdown" });
    // Safety: force-terminate if worker doesn't exit within 5s
    setTimeout(() => {
      try { w.terminate(); } catch {}
      resolve();
    }, 5000).unref();
  });
}
