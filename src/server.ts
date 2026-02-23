#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { openDatabase } from "./db.js";
import { syncMemoryFiles, syncSessionFiles, syncEmbeddings } from "./sync.js";
import { searchMemory } from "./search.js";
import { MEMORY_EXTENSIONS, hashText } from "./internal.js";

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

function resolveSessionDays(): number {
  const val = process.env.MEMORY_SESSION_DAYS;
  if (val) {
    const n = Number(val);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 30;
}

function resolveSessionMax(): number {
  const val = process.env.MEMORY_SESSION_MAX;
  if (val) {
    const n = Number(val);
    if (Number.isFinite(n) && n >= -1) return n;
  }
  return -1; // no count limit
}

const server = new McpServer({
  name: "memory",
  version: "0.1.0",
});

const dbPath = resolveDbPath();
let db: import("better-sqlite3").Database;
let lastSyncAt = 0;
let lastSessionSyncAt = 0;
const SYNC_COOLDOWN_MS = 5_000;
const SESSION_SYNC_COOLDOWN_MS = 60_000;

/**
 * Auto-sync if enough time has passed since last sync.
 */
async function ensureSynced(): Promise<void> {
  const now = Date.now();
  const memoryDue = now - lastSyncAt >= SYNC_COOLDOWN_MS;
  const sessionDue = now - lastSessionSyncAt >= SESSION_SYNC_COOLDOWN_MS;
  if (!memoryDue && !sessionDue) return;
  const workspaceDir = resolveWorkspaceDir();
  try {
    if (memoryDue) {
      await syncMemoryFiles(db, workspaceDir, { chunkSize: resolveChunkSize() });
      lastSyncAt = Date.now();
    }
    if (sessionDue) {
      await syncSessionFiles(db, workspaceDir, {
        chunkSize: resolveChunkSize(),
        maxDays: resolveSessionDays(),
        maxCount: resolveSessionMax(),
      });
      lastSessionSyncAt = Date.now();
    }
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
    const memoryFileCount = (db.prepare(`SELECT COUNT(*) as c FROM files WHERE source = 'memory'`).get() as { c: number }).c;
    const sessionFileCount = (db.prepare(`SELECT COUNT(*) as c FROM files WHERE source = 'sessions'`).get() as { c: number }).c;
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
      memoryFiles: memoryFileCount,
      sessionFiles: sessionFileCount,
      chunks: chunkCount,
      embeddedChunks: vecCount,
      embeddingCache: cacheCount,
      config: {
        chunkSize: resolveChunkSize(),
        tokenMax: resolveTokenMax(),
        sessionDays: resolveSessionDays(),
        sessionMax: resolveSessionMax(),
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
    evidence: z
      .string()
      .optional()
      .describe("The raw context supporting this fact — conversation excerpt, code snippet, or observation. Auto-chunked and linked for traceability."),
  },
  async ({ content, category, source, evidence }) => {
    const workspaceDir = resolveWorkspaceDir();
    const memoryDir = path.join(workspaceDir, "memory");

    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    const cat = (category ?? "general").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const filePath = path.join(memoryDir, `${cat}.md`);
    const timestamp = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

    // Deduplicate: exact string match
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, "utf-8");
      const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
      const lines = existing.split("\n");
      for (const line of lines) {
        const match = line.match(ENTRY_RE);
        if (match) {
          const existingNorm = normalizeForMatch(match[1]!);
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

    // Semantic dedup: best-effort check (respects cooldown)
    await ensureSynced();
    const similar = await searchMemory(db, content, { maxResults: 3, minScore: 0.3 });
    const memHits = similar.filter((r) => r.source === "memory");
    if (memHits.length > 0) {
      const queryWords = contentWords(content);
      for (const hit of memHits) {
        const snippetLines = hit.snippet.split("\n").filter((l) => l.trim().length > 0);
        for (const sLine of snippetLines) {
          const lineWords = contentWords(sLine);
          if (lineWords.size < 2) continue;
          const intersection = [...queryWords].filter((w) => lineWords.has(w)).length;
          const smaller = Math.min(queryWords.size, lineWords.size);
          const overlapRatio = smaller > 0 ? intersection / smaller : 0;
          if (hit.score > 0.6 && overlapRatio > 0.5) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    stored: false,
                    reason: "semantic_duplicate",
                    similarEntry: sLine.trim(),
                    path: hit.path,
                  }),
                },
              ],
            };
          }
        }
      }
    }

    // Write evidence file if provided, get ref tag
    let evidencePath: string | undefined;
    let refTag = "";
    if (evidence && evidence.trim()) {
      const evidenceDir = path.join(memoryDir, "evidence");
      if (!fs.existsSync(evidenceDir)) {
        fs.mkdirSync(evidenceDir, { recursive: true });
      }
      const factId = hashText(content).slice(0, 12);
      const evidenceFile = path.join(evidenceDir, `${factId}.md`);
      const evidenceContent = `# Evidence for: ${content}\n\n${evidence}\n`;
      fs.writeFileSync(evidenceFile, evidenceContent, "utf-8");
      evidencePath = `memory/evidence/${factId}.md`;
      refTag = ` [ref:${evidencePath}]`;
    }

    // Write fact to .md file
    let entry = `- ${content}${refTag}`;
    if (source) {
      entry += ` _(source: ${source})_`;
    }
    entry += ` — ${timestamp}`;

    if (!fs.existsSync(filePath)) {
      const header = `# ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n\n`;
      fs.writeFileSync(filePath, header + entry + "\n", "utf-8");
    } else {
      fs.appendFileSync(filePath, entry + "\n", "utf-8");
    }

    // Reset cooldown so the next tool call triggers re-sync
    lastSyncAt = 0;

    const relPath = `memory/${cat}.md`;
    const result: Record<string, unknown> = { stored: true, path: relPath, fact: content };
    if (evidencePath) result.evidencePath = evidencePath;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Shared helper: find a memory entry by string match then semantic search
// ---------------------------------------------------------------------------

const ENTRY_RE = /^- (.+?)(?:\s+\[ref:.*?\])?(?:\s+_\(source:.*?\)_)?(?:\s+—\s+\d{4}.*)?$/;

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Collect all memory file paths (for string-match scan). */
function listMemoryTargets(workspaceDir: string, category?: string): string[] {
  const memoryDir = path.join(workspaceDir, "memory");
  if (category) {
    const cat = category.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const fp = path.join(memoryDir, `${cat}.md`);
    return fs.existsSync(fp) ? [fp] : [];
  }
  const targets: string[] = [];
  for (const name of ["MEMORY.md", "memory.md", "MEMORY.txt", "memory.txt"]) {
    const p = path.join(workspaceDir, name);
    if (fs.existsSync(p)) targets.push(p);
  }
  if (fs.existsSync(memoryDir)) {
    for (const f of fs.readdirSync(memoryDir)) {
      if (MEMORY_EXTENSIONS.has(path.extname(f).toLowerCase())) {
        targets.push(path.join(memoryDir, f));
      }
    }
  }
  return targets;
}

/** Try to find a `- ` entry line by exact/substring string match. */
function stringMatchEntry(
  targets: string[],
  normalized: string,
): { filePath: string; lineIndex: number; line: string } | null {
  for (const fp of targets) {
    const content = fs.readFileSync(fp, "utf-8");
    const lines = content.split("\n");
    const idx = lines.findIndex((line) => {
      const m = line.match(ENTRY_RE);
      if (!m) return false;
      const lineNorm = normalizeForMatch(m[1]!);
      return lineNorm === normalized || lineNorm.includes(normalized) || normalized.includes(lineNorm);
    });
    if (idx !== -1) return { filePath: fp, lineIndex: idx, line: lines[idx]! };
  }
  return null;
}

/** Pick the best `- ` entry within a line range by word overlap with the query. */
function pickBestEntry(
  allLines: string[],
  startLine: number,
  endLine: number,
  queryNorm: string,
): { idx: number; text: string } | null {
  const entries: Array<{ idx: number; text: string; norm: string }> = [];
  const s = Math.max(0, startLine - 1);
  const e = Math.min(allLines.length, endLine);
  for (let i = s; i < e; i++) {
    const m = allLines[i]!.match(ENTRY_RE);
    if (m) entries.push({ idx: i, text: allLines[i]!, norm: normalizeForMatch(m[1]!) });
  }
  if (entries.length === 0) return null;
  if (entries.length === 1) return { idx: entries[0]!.idx, text: entries[0]!.text };

  // Multiple entries: pick best by word overlap
  const queryWords = new Set(queryNorm.split(" "));
  let best = entries[0]!;
  let bestScore = 0;
  for (const entry of entries) {
    const words = entry.norm.split(" ");
    const overlap = words.filter((w) => queryWords.has(w)).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = entry;
    }
  }
  return { idx: best.idx, text: best.text };
}

/**
 * Find a memory entry: string match first (fast), then semantic search fallback.
 * Returns the file path, line index, and full line text of the best match.
 */
async function findMemoryEntry(
  query: string,
  category?: string,
): Promise<{ filePath: string; lineIndex: number; line: string } | null> {
  const workspaceDir = resolveWorkspaceDir();
  const normalized = normalizeForMatch(query);
  if (!normalized) return null;

  const targets = listMemoryTargets(workspaceDir, category);

  // Phase 1: fast string match
  const strMatch = stringMatchEntry(targets, normalized);
  if (strMatch) return strMatch;

  // Phase 2: semantic search fallback
  await ensureSynced();
  const results = await searchMemory(db, query, { maxResults: 5, minScore: 0.3 });
  const memoryResults = results.filter((r) => r.source === "memory");
  if (memoryResults.length === 0) return null;

  for (const result of memoryResults) {
    const absPath = path.resolve(workspaceDir, result.path);
    if (!fs.existsSync(absPath)) continue;
    const content = fs.readFileSync(absPath, "utf-8");
    const allLines = content.split("\n");
    const entry = pickBestEntry(allLines, result.startLine, result.endLine, normalized);
    if (entry) return { filePath: absPath, lineIndex: entry.idx, line: entry.text };
  }

  return null;
}

/** Extract content words for overlap comparison (strips punctuation). */
function contentWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\s-]/g, " ").replace(/\s+/g, " ").trim()
      .split(" ").filter((w) => w.length > 1),
  );
}

// ---------------------------------------------------------------------------

const REF_RE = /\[ref:(memory\/evidence\/[^\]]+)\]/;

/** Delete the evidence file referenced in a memory entry line. */
function cleanupEvidence(line: string): void {
  const m = line.match(REF_RE);
  if (!m) return;
  const absPath = path.join(resolveWorkspaceDir(), m[1]!);
  try { fs.unlinkSync(absPath); } catch {}
}

server.tool(
  "memory_forget",
  "Remove a memory entry that is outdated, incorrect, or no longer relevant. " +
    "Use when the user corrects a previous statement, or when stored information contradicts newer facts.",
  {
    content: z.string().describe("Describe the memory to remove — matched semantically, not just by exact text"),
    category: z
      .string()
      .optional()
      .describe("Category file to search in (e.g. 'preferences'). If omitted, searches all memory files."),
  },
  async ({ content, category }) => {
    await ensureSynced();
    const match = await findMemoryEntry(content, category);
    if (!match) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ removed: false, reason: "no matching entry found" }) }],
      };
    }

    const fileContent = fs.readFileSync(match.filePath, "utf-8");
    const lines = fileContent.split("\n");
    lines.splice(match.lineIndex, 1);
    fs.writeFileSync(match.filePath, lines.join("\n"), "utf-8");
    lastSyncAt = 0;

    // Clean up orphan evidence file
    cleanupEvidence(match.line);

    const relPath = path.relative(resolveWorkspaceDir(), match.filePath).replace(/\\/g, "/");
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ removed: true, path: relPath, removedContent: match.line }),
      }],
    };
  },
);

server.tool(
  "memory_update",
  "Update an existing memory entry with new content. " +
    "Use when information has changed (e.g. user changed preferences) or to refine a vague memory into a precise one.",
  {
    old_content: z.string().describe("Describe the memory to update — matched semantically, not just by exact text"),
    new_content: z.string().describe("The replacement content"),
    category: z
      .string()
      .optional()
      .describe("Category file to search in (e.g. 'preferences'). If omitted, searches all memory files."),
    source: z
      .string()
      .optional()
      .describe("Origin of the updated knowledge (e.g. 'user corrected', 'observed change')"),
    evidence: z
      .string()
      .optional()
      .describe("New supporting context for the updated fact. Replaces old evidence if present."),
  },
  async ({ old_content, new_content, category, source, evidence }) => {
    await ensureSynced();
    const match = await findMemoryEntry(old_content, category);
    if (!match) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ updated: false, reason: "no matching entry found" }) }],
      };
    }

    // Clean up old evidence file
    cleanupEvidence(match.line);

    // Write new evidence if provided
    let evidencePath: string | undefined;
    let refTag = "";
    if (evidence && evidence.trim()) {
      const memoryDir = path.join(resolveWorkspaceDir(), "memory");
      const evidenceDir = path.join(memoryDir, "evidence");
      if (!fs.existsSync(evidenceDir)) {
        fs.mkdirSync(evidenceDir, { recursive: true });
      }
      const factId = hashText(new_content).slice(0, 12);
      const evidenceFile = path.join(evidenceDir, `${factId}.md`);
      const evidenceContent = `# Evidence for: ${new_content}\n\n${evidence}\n`;
      fs.writeFileSync(evidenceFile, evidenceContent, "utf-8");
      evidencePath = `memory/evidence/${factId}.md`;
      refTag = ` [ref:${evidencePath}]`;
    }

    const fileContent = fs.readFileSync(match.filePath, "utf-8");
    const lines = fileContent.split("\n");
    const timestamp = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
    let newEntry = `- ${new_content}${refTag}`;
    if (source) newEntry += ` _(source: ${source})_`;
    newEntry += ` — ${timestamp}`;
    lines[match.lineIndex] = newEntry;
    fs.writeFileSync(match.filePath, lines.join("\n"), "utf-8");
    lastSyncAt = 0;

    const relPath = path.relative(resolveWorkspaceDir(), match.filePath).replace(/\\/g, "/");
    const result: Record<string, unknown> = { updated: true, path: relPath, old: match.line, new: newEntry };
    if (evidencePath) result.evidencePath = evidencePath;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(result),
      }],
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
