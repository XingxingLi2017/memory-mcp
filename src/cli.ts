#!/usr/bin/env node

/**
 * CLI entry point for memory-mcp search.
 * Usage: node cli.js search "query" [--max-results N] [--min-score N]
 * Outputs JSON to stdout for integration with OpenClaw exec.
 */

import path from "node:path";
import { openDatabase } from "./db.js";
import { syncMemoryFiles, syncEmbeddings } from "./sync.js";
import { searchMemory } from "./search.js";

const DEFAULT_WORKSPACE = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? "~",
  ".copilot",
);

function resolveWorkspaceDir(): string {
  return process.env.MEMORY_WORKSPACE ?? DEFAULT_WORKSPACE;
}

function resolveDbPath(): string {
  return process.env.MEMORY_DB_PATH ?? path.join(resolveWorkspaceDir(), "memory.db");
}

function resolveChunkSize(): number {
  const val = process.env.MEMORY_CHUNK_SIZE;
  if (val) {
    const n = Number(val);
    if (n >= 64 && n <= 4096) return n;
  }
  return 512;
}

function resolveExtraDirs(): string[] | undefined {
  const val = process.env.MEMORY_EXTRA_DIRS;
  if (!val) return undefined;
  const dirs = val.split(",").map((d) => d.trim()).filter(Boolean).map((d) => path.resolve(d));
  return dirs.length > 0 ? dirs : undefined;
}

function printUsage(): void {
  console.error(`Usage: memory-mcp <command> [options]

Commands:
  search <query>    Search memory files
    --max-results N   Max results (default: 10)
    --min-score N     Minimum relevance score 0-1 (default: 0.01)
    --token-max N     Max tokens in response (default: 4096)

  status            Show index status

Environment:
  MEMORY_WORKSPACE    Root directory (default: ~/.copilot)
  MEMORY_DB_PATH      SQLite database path
  MEMORY_EXTRA_DIRS   Comma-separated extra directories to index
  MEMORY_MCP_MODEL    Embedding model (HF URI or local path)
  MEMORY_CHUNK_SIZE   Chunk size in tokens (default: 512)`);
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
    console.error(`Error: --${name} must be a positive integer, got "${val}"`);
    process.exit(1);
  }
  return n;
}

function parsePositiveFloat(val: string | undefined, name: string): number | undefined {
  if (!val) return undefined;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`Error: --${name} must be a non-negative number, got "${val}"`);
    process.exit(1);
  }
  return n;
}

async function main(): Promise<void> {
  const { command, query, opts } = parseArgs(process.argv.slice(2));

  if (!command || command === "help" || command === "--help") {
    printUsage();
    process.exit(0);
  }

  const workspaceDir = resolveWorkspaceDir();
  const dbPath = resolveDbPath();
  const db = await openDatabase(dbPath, { chunkSize: resolveChunkSize() });

  // Sync before search
  const extraDirs = resolveExtraDirs();
  await syncMemoryFiles(db, workspaceDir, { chunkSize: resolveChunkSize(), extraDirs });
  // Best-effort embedding sync
  try { await syncEmbeddings(db); } catch {}

  if (command === "search") {
    if (!query) {
      console.error("Error: search requires a query argument");
      process.exit(1);
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
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  db.close();
}

main().catch((err) => {
  console.error("memory-mcp CLI error:", err);
  process.exit(1);
});
