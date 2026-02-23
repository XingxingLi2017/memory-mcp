#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { openDatabase } from "./db.js";
import { syncMemoryFiles, syncEmbeddings } from "./sync.js";
import { searchMemory } from "./search.js";
import { MEMORY_EXTENSIONS } from "./internal.js";

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

function resolveTokenMax(): number {
  const val = process.env.MEMORY_TOKEN_MAX;
  if (val) {
    const n = Number(val);
    if (n >= 100 && n <= 16384) return n;
  }
  return 4096;
}

const server = new McpServer({
  name: "memory",
  version: "0.1.0",
});

const dbPath = resolveDbPath();
let db: import("better-sqlite3").Database;
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
    await syncMemoryFiles(db, workspaceDir, { chunkSize: resolveChunkSize() });
    lastSyncAt = Date.now();
    // Async embedding sync — don't block on it
    syncEmbeddings(db).catch((err) =>
      console.error("[memory-mcp] embedding sync error:", err),
    );
  } catch (err) {
    console.error("memory sync error:", err);
  }
}

// --- Tools ---

server.tool(
  "memory_search",
  "Semantically search MEMORY.md and memory/*.md files (also .txt, .json, .jsonl, .yaml). " +
    "Use before answering questions about prior work, decisions, preferences, or project context.",
  {
    query: z.string().describe("Search query"),
    maxResults: z.number().optional().describe("Max results to return (default: auto-calculated from token budget)"),
    minScore: z.number().optional().describe("Minimum relevance score 0-1 (default: 0.01)"),
    tokenMax: z.number().optional().describe("Maximum total tokens to return (default: 4096). Controls snippet length and result count."),
    after: z.string().optional().describe("Only include files modified after this ISO 8601 timestamp (filters by file mtime, not individual chunk age)"),
    before: z.string().optional().describe("Only include files modified before this ISO 8601 timestamp (filters by file mtime, not individual chunk age)"),
  },
  async ({ query, maxResults, minScore, tokenMax, after, before }) => {
    await ensureSynced();
    const effectiveTokenMax = tokenMax ?? resolveTokenMax();
    const results = await searchMemory(db, query, { maxResults, minScore, tokenMax: effectiveTokenMax, after, before });
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
  "Read a specific section from a memory file. Use after memory_search to pull only the needed lines and keep context small.",
  {
    path: z.string().describe("Relative path to the memory file (e.g. memory/decisions.md)"),
    from: z.number().optional().describe("Starting line number (1-based)"),
    lines: z.number().optional().describe("Number of lines to read (omit to read entire file)"),
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
      rel === "MEMORY.txt" ||
      rel === "memory.txt" ||
      rel.startsWith("memory/");
    if (!allowed || !MEMORY_EXTENSIONS.has(path.extname(absPath).toLowerCase())) {
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
  "Show the current status of the memory index (file count, chunk count, last sync time). Includes health checks.",
  {},
  async () => {
    await ensureSynced();
    const workspaceDir = resolveWorkspaceDir();
    const fileCount = (db.prepare(`SELECT COUNT(*) as c FROM files`).get() as { c: number }).c;
    const chunkCount = (db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number }).c;
    let vecCount = 0;
    try {
      vecCount = (db.prepare(`SELECT COUNT(*) as c FROM chunks_vec`).get() as { c: number }).c;
    } catch {}
    let cacheCount = 0;
    try {
      cacheCount = (db.prepare(`SELECT COUNT(*) as c FROM embedding_cache`).get() as { c: number }).c;
    } catch {}

    const warnings: string[] = [];

    // Health check: too many files
    if (fileCount > 50) {
      warnings.push(`High file count (${fileCount}). Consider consolidating related memories.`);
    }

    // Health check: duplicate chunk content across files
    const dupes = db
      .prepare(
        `SELECT hash, COUNT(DISTINCT path) as file_count, GROUP_CONCAT(DISTINCT path) as paths
         FROM chunks GROUP BY hash HAVING file_count > 1 LIMIT 5`,
      )
      .all() as Array<{ hash: string; file_count: number; paths: string }>;
    if (dupes.length > 0) {
      const pairs = dupes.map((d) => d.paths).join("; ");
      warnings.push(`Found ${dupes.length} chunk(s) with duplicate content across files: ${pairs}`);
    }

    // Health check: large files (>500 chunks)
    const largeFiles = db
      .prepare(
        `SELECT path, COUNT(*) as cnt FROM chunks GROUP BY path HAVING cnt > 500`,
      )
      .all() as Array<{ path: string; cnt: number }>;
    if (largeFiles.length > 0) {
      const names = largeFiles.map((f) => `${f.path} (${f.cnt} chunks)`).join(", ");
      warnings.push(`Large files: ${names}. Consider splitting.`);
    }

    const status = {
      workspaceDir,
      dbPath,
      files: fileCount,
      chunks: chunkCount,
      embeddedChunks: vecCount,
      embeddingCache: cacheCount,
      config: {
        chunkSize: resolveChunkSize(),
        tokenMax: resolveTokenMax(),
      },
      lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
    };
  },
);

server.tool(
  "memory_write",
  "Save user-specific knowledge to persistent memory. " +
    "Goal: as memories accumulate, the agent understands the user better and needs less prompting. " +
    "Write proactively whenever you learn something about the user, their projects, or their way of working.",
  {
    content: z.string().describe("What to remember — a clear statement about the user, their preferences, projects, decisions, or context (1-3 sentences)"),
    category: z
      .string()
      .optional()
      .describe(
        "Category filename (e.g. 'preferences', 'decisions', 'project', 'people', 'workflow', 'gotchas'). Defaults to 'general'.",
      ),
    source: z
      .string()
      .optional()
      .describe("Origin of this knowledge (e.g. 'user said', 'observed from code', 'corrected by user')"),
  },
  async ({ content, category, source }) => {
    const workspaceDir = resolveWorkspaceDir();
    const memoryDir = path.join(workspaceDir, "memory");

    // Ensure memory directory exists
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    const cat = (category ?? "general").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const filePath = path.join(memoryDir, `${cat}.md`);
    const timestamp = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

    // Deduplicate: check if file already contains similar content
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, "utf-8");
      const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
      const lines = existing.split("\n");
      for (const line of lines) {
        // Extract the text part of each entry (strip "- ", source, timestamp)
        const match = line.match(/^- (.+?)(?:\s+_\(source:.*?\)_)?(?:\s+—\s+\d{4}.*)?$/);
        if (match) {
          const existingNorm = match[1].toLowerCase().replace(/\s+/g, " ").trim();
          if (existingNorm === normalized) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ stored: false, reason: "duplicate", path: `memory/${cat}.md` }),
                },
              ],
            };
          }
        }
      }
    }

    // Build entry
    let entry = `- ${content}`;
    if (source) {
      entry += ` _(source: ${source})_`;
    }
    entry += ` — ${timestamp}`;

    // Append to file (create with header if new)
    if (!fs.existsSync(filePath)) {
      const header = `# ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n\n`;
      fs.writeFileSync(filePath, header + entry + "\n", "utf-8");
    } else {
      fs.appendFileSync(filePath, entry + "\n", "utf-8");
    }

    // Force re-sync so the new memory is immediately searchable
    lastSyncAt = 0;

    const relPath = `memory/${cat}.md`;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ stored: true, path: relPath, content }),
        },
      ],
    };
  },
);

// --- Start ---

async function main() {
  db = await openDatabase(dbPath, { chunkSize: resolveChunkSize() });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Initial sync on startup
  await ensureSynced();
}

main().catch((err) => {
  console.error("memory-mcp fatal:", err);
  process.exit(1);
});
