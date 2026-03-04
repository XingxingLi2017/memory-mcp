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

function printUsage(): void {
  console.error(`Usage: memory-mcp-cli <command> [options]

Commands:
  search <query>    Search memory files
    --max-results N   Max results (default: 10)
    --min-score N     Minimum relevance score 0-1 (default: 0.01)
    --token-max N     Max tokens in response (default: 4096)

  status            Show index status

Global flags (override config for this run):
  --config <path>       Use a custom config file
  --workspace <path>    Override workspace directory
  --db-path <path>      Override database path
  --chunk-size N        Override chunk size
  --session-days N      Override session days
  --session-max N       Override session max
  --session-dirs <json> Override session dirs (JSON array)
  --extra-dirs <paths>  Override extra dirs (comma-separated)
  --model <path>        Override embedding model

Configuration:
  All settings are read from ~/.memory-mcp-workdir/memory-mcp.json.
  Config is managed via the "memory-mcp" command (not memory-mcp-cli):
    memory-mcp config            Show current settings
    memory-mcp config set <k> <v> Set a value`);
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

function parseNonNegativeInt(val: string | undefined, name: string): number | undefined {
  if (!val) return undefined;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`--${name} must be a positive integer, got "${val}"`);
  }
  return n;
}

function parsePositiveFloat(val: string | undefined, name: string): number | undefined {
  if (!val) return undefined;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative number, got "${val}"`);
  }
  return n;
}

/** Global config flags (kebab-case). Extracted before command-specific parsing. */
const GLOBAL_FLAGS = new Set([
  "config", "workspace", "db-path", "chunk-size", "token-max",
  "session-days", "session-max", "session-dirs", "extra-dirs", "model",
]);

/** Extract global config overrides from opts, returning {overrides, configPath, rest}. */
function extractGlobalOverrides(opts: Record<string, string>): {
  overrides: MemoryConfigFile;
  configPath?: string;
  rest: Record<string, string>;
} {
  const overrides: MemoryConfigFile = {};
  let configPath: string | undefined;
  const rest: Record<string, string> = {};

  for (const [key, value] of Object.entries(opts)) {
    if (!GLOBAL_FLAGS.has(key)) {
      rest[key] = value;
      continue;
    }
    switch (key) {
      case "config": configPath = value; break;
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

  return { overrides, configPath, rest };
}

async function main(): Promise<void> {
  const { command, query, opts } = parseArgs(process.argv.slice(2));

  if (!command || command === "help" || command === "--help") {
    printUsage();
    process.exit(0);
  }

  const { overrides, configPath, rest } = extractGlobalOverrides(opts);
  const hasOverrides = Object.keys(overrides).length > 0 || configPath;
  const config = hasOverrides ? loadConfig(overrides, configPath) : loadConfig();
  const workspaceDir = config.workspace;
  const dbPath = config.dbPath;
  const db = await openDatabase(dbPath, { chunkSize: config.chunkSize });

  try {
    // Sync before search
    const extraDirs = resolvedExtraDirs(config);
    await syncMemoryFiles(db, workspaceDir, { chunkSize: config.chunkSize, extraDirs });
    await syncSessionFiles(db, {
      chunkSize: config.chunkSize,
      maxDays: config.sessionDays,
      maxCount: config.sessionMax,
      sessionDirs: config.sessionDirs,
    });
    // Best-effort embedding sync
    try { await syncEmbeddings(db); } catch {}

    if (command === "search") {
      if (!query) {
        throw new Error("search requires a query argument");
      }
      const maxResults = parseNonNegativeInt(rest["max-results"], "max-results") ?? 10;
      const minScore = parsePositiveFloat(rest["min-score"], "min-score");
      const tokenMax = parseNonNegativeInt(rest["token-max"], "token-max") ?? config.tokenMax;
      const results = await searchMemory(db, query, { maxResults, minScore, tokenMax });
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
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("memory-mcp CLI error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
