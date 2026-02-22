#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { openDatabase } from "./db.js";
import { syncMemoryFiles } from "./sync.js";
import { searchMemory } from "./search.js";

const DEFAULT_DB_PATH = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? "~",
  ".copilot",
  "memory.db",
);

const DEFAULT_WORKSPACE = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? "~",
  ".copilot",
);

function resolveWorkspaceDir(): string {
  return process.env.MEMORY_WORKSPACE ?? DEFAULT_WORKSPACE;
}

function resolveDbPath(): string {
  return process.env.MEMORY_DB_PATH ?? DEFAULT_DB_PATH;
}

const server = new McpServer({
  name: "memory",
  version: "0.1.0",
});

const dbPath = resolveDbPath();
const db = openDatabase(dbPath);
let lastSyncAt = 0;
const SYNC_COOLDOWN_MS = 5_000;

/**
 * Auto-sync if enough time has passed since last sync.
 */
async function ensureSynced(): Promise<void> {
  const now = Date.now();
  if (now - lastSyncAt < SYNC_COOLDOWN_MS) return;
  const workspaceDir = resolveWorkspaceDir();
  try {
    await syncMemoryFiles(db, workspaceDir);
    lastSyncAt = Date.now();
  } catch (err) {
    console.error("memory sync error:", err);
  }
}

// --- Tools ---

server.tool(
  "memory_search",
  "Semantically search MEMORY.md and memory/*.md files. Use before answering questions about prior work, decisions, preferences, or project context.",
  {
    query: z.string().describe("Search query"),
    maxResults: z.number().optional().describe("Max results to return (default: 6)"),
    minScore: z.number().optional().describe("Minimum relevance score 0-1 (default: 0.01)"),
  },
  async ({ query, maxResults, minScore }) => {
    await ensureSynced();
    const results = searchMemory(db, query, { maxResults, minScore });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ results, count: results.length }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "memory_get",
  "Read a specific section from a memory file. Use after memory_search to pull the exact lines you need.",
  {
    path: z.string().describe("Relative path to the memory file (e.g. memory/decisions.md)"),
    from: z.number().optional().describe("Starting line number (1-based)"),
    lines: z.number().optional().describe("Number of lines to read"),
  },
  async ({ path: relPath, from, lines }) => {
    const workspaceDir = resolveWorkspaceDir();
    const absPath = path.isAbsolute(relPath)
      ? path.resolve(relPath)
      : path.resolve(workspaceDir, relPath);

    // Security: only allow memory paths
    const rel = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
    const allowed =
      rel === "MEMORY.md" ||
      rel === "memory.md" ||
      rel.startsWith("memory/");
    if (!allowed || !absPath.endsWith(".md")) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "path not allowed" }) }],
        isError: true,
      };
    }

    try {
      const content = fs.readFileSync(absPath, "utf-8");
      if (!from && !lines) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ path: rel, text: content }) }],
        };
      }
      const allLines = content.split("\n");
      const start = Math.max(1, from ?? 1);
      const count = Math.max(1, lines ?? allLines.length);
      const slice = allLines.slice(start - 1, start - 1 + count);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ path: rel, text: slice.join("\n") }) },
        ],
      };
    } catch {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "file not found" }) }],
        isError: true,
      };
    }
  },
);

server.tool(
  "memory_status",
  "Show the current status of the memory index (file count, chunk count, last sync time).",
  {},
  async () => {
    await ensureSynced();
    const workspaceDir = resolveWorkspaceDir();
    const files = (db.prepare(`SELECT COUNT(*) as c FROM files`).get() as { c: number }).c;
    const chunks = (db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number }).c;
    const status = {
      workspaceDir,
      dbPath,
      files,
      chunks,
      lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
    };
  },
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Initial sync on startup
  await ensureSynced();
}

main().catch((err) => {
  console.error("memory-mcp fatal:", err);
  process.exit(1);
});
