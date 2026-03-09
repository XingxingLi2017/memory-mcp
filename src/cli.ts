#!/usr/bin/env node

/**
 * CLI entry point for memory-mcp search.
 * Usage: node cli.js search "query" [--max-results N] [--min-score N]
 * Outputs JSON to stdout for integration with OpenClaw exec.
 */

import path from "node:path";
import { openDatabase } from "./db.js";
import { syncMemoryFiles, syncSessionFiles, syncEmbeddings } from "./sync.js";
import { searchMemory } from "./search.js";
import { loadConfig, resolvedExtraDirs, type MemoryConfigFile } from "./config.js";
import { setModelSpec, preloadModel } from "./embedding.js";

function printUsage(): void {
  console.error(`Usage: memory-mcp-cli <command> [options]

Commands:
  search <query>    Search memory files
    --max-results N   Max results (default: 10)
    --min-score N     Minimum relevance score 0-1 (default: 0.01)
    --token-max N     Max tokens in response (default: from config)

  status            Show index status

Global flags:
  --profile <name>      Use a named profile (default: from config)

  Override config for this run (optional):
    --workspace <path>    --db-path <path>      --chunk-size N
    --session-days N      --session-max N       --model <path>
    --session-dirs <json> --extra-dirs <paths>

Configuration:
  All settings are read from ~/.memory-mcp-workdir/memory-mcp.json.
  Config is managed via the "memory-mcp" command (not memory-mcp-cli):
    memory-mcp config                       Show current settings
    memory-mcp config --profile <n> show    Show profile settings
    memory-mcp config profile list          List all profiles`);
}

function parseArgs(args: string[]): { command: string; query?: string; opts: Record<string, string> } {
  const command = args[0] ?? "";
  const opts: Record<string, string> = {};
  let query: string | undefined;
  let i = 1;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg.startsWith("--") && i + 1 < args.length) {
      opts[arg.slice(2)] = args[i + 1]!;
      i += 2;
    } else if (!query) {
      query = arg;
      i++;
    } else {
      i++;
    }
  }
  return { command, query, opts };
}

function parseNonNegativeInt(val: string | undefined, name: string, min?: number, max?: number): number | undefined {
  if (!val) return undefined;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`--${name} must be a non-negative integer, got "${val}"`);
  }
  if (min !== undefined && max !== undefined) return Math.max(min, Math.min(max, n));
  return n;
}

function parsePositiveFloat(val: string | undefined, name: string, min?: number, max?: number): number | undefined {
  if (!val) return undefined;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative number, got "${val}"`);
  }
  if (min !== undefined && max !== undefined) return Math.max(min, Math.min(max, n));
  return n;
}

/** Global config flags (kebab-case). Extracted before command-specific parsing. */
const GLOBAL_FLAGS = new Set([
  "profile", "workspace", "db-path", "chunk-size", "token-max",
  "session-days", "session-max", "session-dirs", "extra-dirs", "model",
]);

/** Extract global config overrides from opts, returning {overrides, profile, rest}. */
function extractGlobalOverrides(opts: Record<string, string>): {
  overrides: MemoryConfigFile;
  profile?: string;
  rest: Record<string, string>;
} {
  const overrides: MemoryConfigFile = {};
  let profile: string | undefined;
  const rest: Record<string, string> = {};

  for (const [key, value] of Object.entries(opts)) {
    if (key === "config") {
      console.error("[memory-mcp] Warning: --config flag is no longer supported. Use --profile instead.");
      continue;
    }
    if (!GLOBAL_FLAGS.has(key)) {
      rest[key] = value;
      continue;
    }
    switch (key) {
      case "profile": profile = value; break;
      case "workspace": overrides.workspace = path.resolve(value); break;
      case "db-path": overrides.dbPath = path.resolve(value); break;
      case "chunk-size": overrides.chunkSize = Number(value); break;
      case "token-max": overrides.tokenMax = Number(value); break;
      case "session-days": overrides.sessionDays = Number(value); break;
      case "session-max": overrides.sessionMax = Number(value); break;
      case "session-dirs":
        try { overrides.sessionDirs = JSON.parse(value); } catch {
          throw new Error(`--session-dirs must be valid JSON, got "${value}"`);
        }
        break;
      case "extra-dirs":
        overrides.extraDirs = value.split(",").map((d) => d.trim()).filter(Boolean).map((d) => path.resolve(d));
        break;
      case "model": overrides.model = value; break;
    }
  }

  return { overrides, profile, rest };
}

async function main(): Promise<void> {
  const { command, query, opts } = parseArgs(process.argv.slice(2));

  if (!command || command === "help" || command === "--help") {
    printUsage();
    process.exit(0);
  }

  const { overrides, profile, rest } = extractGlobalOverrides(opts);
  const hasOpts = Object.keys(overrides).length > 0 || profile;
  const config = hasOpts
    ? loadConfig({ profile, overrides })
    : loadConfig();
  setModelSpec(config.model);
  const workspaceDir = config.workspace;
  const dbPath = config.dbPath;
  const db = await openDatabase(dbPath, { chunkSize: config.chunkSize });
  let embeddingDone: Promise<void> | undefined;

  try {
    // Preload embedding model in parallel with file sync for search commands.
    // Model load (~2s cached) overlaps with file sync, so search gets hybrid
    // results at near-zero extra cost.
    const modelReady = command === "search"
      ? preloadModel().catch(() => {})
      : undefined;

    // Sync files before search/status
    const extraDirs = resolvedExtraDirs(config);
    await syncMemoryFiles(db, workspaceDir, { chunkSize: config.chunkSize, extraDirs });
    await syncSessionFiles(db, {
      chunkSize: config.chunkSize,
      maxDays: config.sessionDays,
      maxCount: config.sessionMax,
      sessionDirs: config.sessionDirs,
    });

    // Best-effort model preload: if model loads within file sync time + grace
    // period, search gets hybrid results. Otherwise, fall back to FTS-only
    // (no cold-start blocking — matches the PR's latency objective).
    const MODEL_PRELOAD_TIMEOUT_MS = 5000;
    if (modelReady) {
      const timeout = new Promise<void>((r) => setTimeout(r, MODEL_PRELOAD_TIMEOUT_MS).unref());
      await Promise.race([modelReady, timeout]);
    }

    // Embedding sync only for search — status should remain lightweight.
    // Fire-and-forget: search proceeds immediately with existing embeddings.
    embeddingDone = command === "search"
      ? syncEmbeddings(db).then(() => {}).catch(() => {})
      : undefined;

    if (command === "search") {
      if (!query) {
        throw new Error("search requires a query argument");
      }
      const maxResults = parseNonNegativeInt(rest["max-results"], "max-results", 1, 100) ?? config.maxResults;
      const minScore = parsePositiveFloat(rest["min-score"], "min-score", 0, 1) ?? config.minScore;
      const tokenMax = parseNonNegativeInt(rest["token-max"], "token-max") ?? config.tokenMax;
      const results = await searchMemory(db, query, { maxResults, minScore, tokenMax, ftsWeight: config.ftsWeight });
      console.log(JSON.stringify({ results, count: results.length }, null, 2));
    } else if (command === "status") {
      const fileCount = (db.prepare(`SELECT COUNT(*) as c FROM files`).get() as { c: number }).c;
      const memoryFileCount = (db.prepare(`SELECT COUNT(*) as c FROM files WHERE source = 'memory'`).get() as { c: number }).c;
      const sessionFileCount = (db.prepare(`SELECT COUNT(*) as c FROM files WHERE source = 'sessions'`).get() as { c: number }).c;
      const chunkCount = (db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number }).c;
      let vecCount = 0;
      try { vecCount = (db.prepare(`SELECT COUNT(*) as c FROM chunks_vec`).get() as { c: number }).c; } catch {}
      let cacheCount = 0;
      try { cacheCount = (db.prepare(`SELECT COUNT(*) as c FROM embedding_cache`).get() as { c: number }).c; } catch {}
      console.log(JSON.stringify({
        workspaceDir,
        dbPath,
        extraDirs: extraDirs ?? [],
        files: fileCount,
        memoryFiles: memoryFileCount,
        sessionFiles: sessionFileCount,
        chunks: chunkCount,
        embeddedChunks: vecCount,
        embeddingCache: cacheCount,
        config: {
          chunkSize: config.chunkSize,
          tokenMax: config.tokenMax,
          sessionDays: config.sessionDays,
          sessionMax: config.sessionMax,
        },
      }, null, 2));
    } else {
      throw new Error(`Unknown command: ${command}`);
    }

    // Search results are printed above (stdout available immediately).
  } finally {
    // Wait for background embedding to finish before closing DB — even on
    // error paths. This ensures embedding sync completes safely (no mid-write
    // DB close). The process stays alive until done (may take hours).
    if (embeddingDone) await embeddingDone;
    db.close();
  }
}

main().catch((err) => {
  console.error("memory-mcp CLI error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
