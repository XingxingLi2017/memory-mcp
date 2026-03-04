#!/usr/bin/env node

/**
 * CLI entry point for memory-mcp search.
 * Usage: node cli.js search "query" [--max-results N] [--min-score N]
 * Outputs JSON to stdout for integration with OpenClaw exec.
 */

import { openDatabase } from "./db.js";
import { syncMemoryFiles, syncEmbeddings } from "./sync.js";
import { searchMemory } from "./search.js";
import { loadConfig, resolvedExtraDirs } from "./config.js";

function printUsage(): void {
  console.error(`Usage: memory-mcp-cli <command> [options]

Commands:
  search <query>    Search memory files
    --max-results N   Max results (default: 10)
    --min-score N     Minimum relevance score 0-1 (default: 0.01)
    --token-max N     Max tokens in response (default: 4096)

  status            Show index status

Configuration:
  All settings are read from ~/memory-mcp.json (editable via "memory-mcp config set").
  Run "memory-mcp config" to view current settings.`);
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

function parsePositiveInt(val: string | undefined, name: string): number | undefined {
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

async function main(): Promise<void> {
  const { command, query, opts } = parseArgs(process.argv.slice(2));

  if (!command || command === "help" || command === "--help") {
    printUsage();
    process.exit(0);
  }

  const config = loadConfig();
  const workspaceDir = config.workspace;
  const dbPath = config.dbPath;
  const db = await openDatabase(dbPath, { chunkSize: config.chunkSize });

  try {
    // Sync before search
    const extraDirs = resolvedExtraDirs(config);
    await syncMemoryFiles(db, workspaceDir, { chunkSize: config.chunkSize, extraDirs });
    // Best-effort embedding sync
    try { await syncEmbeddings(db); } catch {}

    if (command === "search") {
      if (!query) {
        throw new Error("search requires a query argument");
      }
      const maxResults = parsePositiveInt(opts["max-results"], "max-results") ?? 10;
      const minScore = parsePositiveFloat(opts["min-score"], "min-score");
      const tokenMax = parsePositiveInt(opts["token-max"], "token-max");
      const results = await searchMemory(db, query, { maxResults, minScore, tokenMax });
      console.log(JSON.stringify({ results, count: results.length }, null, 2));
    } else if (command === "status") {
      const fileCount = (db.prepare(`SELECT COUNT(*) as c FROM files`).get() as { c: number }).c;
      const chunkCount = (db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number }).c;
      let vecCount = 0;
      try { vecCount = (db.prepare(`SELECT COUNT(*) as c FROM chunks_vec`).get() as { c: number }).c; } catch {}
      console.log(JSON.stringify({
        workspaceDir,
        dbPath,
        extraDirs: extraDirs ?? [],
        files: fileCount,
        chunks: chunkCount,
        embeddedChunks: vecCount,
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
