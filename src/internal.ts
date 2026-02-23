import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** File extensions indexed by the memory system. */
export const MEMORY_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl", ".yaml", ".yml"]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

export type MemoryFileEntry = {
  /** Relative path from workspace root */
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  /** File content (cached from initial read) */
  content: string;
};

export type MemoryChunk = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
};

export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Discover all .md files in MEMORY.md, memory.md, and memory/ directory.
 */
export async function listMemoryFiles(workspaceDir: string): Promise<string[]> {
  const result: string[] = [];
  const skippedSymlinks: string[] = [];

  // Check top-level memory files
  for (const name of ["MEMORY.md", "memory.md", "MEMORY.txt", "memory.txt"]) {
    const p = path.join(workspaceDir, name);
    try {
      const stat = await fs.lstat(p);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        result.push(p);
      } else if (stat.isSymbolicLink()) {
        skippedSymlinks.push(p);
      }
    } catch {}
  }

  // Walk memory/ directory
  const memoryDir = path.join(workspaceDir, "memory");
  try {
    const stat = await fs.lstat(memoryDir);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await walkDir(memoryDir, result, skippedSymlinks);
    }
  } catch {}

  if (skippedSymlinks.length > 0) {
    console.error(`[memory-mcp] Skipped ${skippedSymlinks.length} symlink(s): ${skippedSymlinks.join(", ")}`);
  }

  // Dedupe by realpath
  if (result.length <= 1) return result;
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of result) {
    let key = entry;
    try { key = await fs.realpath(entry); } catch {}
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(entry);
    }
  }
  return deduped;
}

async function walkDir(dir: string, files: string[], skippedSymlinks?: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      skippedSymlinks?.push(full);
      continue;
    }
    if (entry.isDirectory()) {
      await walkDir(full, files, skippedSymlinks);
    } else if (entry.isFile() && MEMORY_EXTENSIONS.has(extOf(entry.name))) {
      files.push(full);
    }
  }
}

export async function buildFileEntry(
  absPath: string,
  workspaceDir: string,
): Promise<MemoryFileEntry> {
  const stat = await fs.stat(absPath);
  const content = await fs.readFile(absPath, "utf-8");
  return {
    path: path.relative(workspaceDir, absPath).replace(/\\/g, "/"),
    absPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash: hashText(content),
    content,
  };
}

/**
 * Route to the appropriate chunker based on file extension.
 */
const DEFAULT_MAX_CHUNK_CHARS = 512 * 4; // Same as markdown default

export function chunkFile(content: string, filePath: string, chunkSize?: number): MemoryChunk[] {
  const maxChars = (chunkSize ?? 512) * 4;
  const ext = extOf(filePath);
  let chunks: MemoryChunk[];
  switch (ext) {
    case ".json":
      chunks = chunkJson(content);
      break;
    case ".jsonl":
      chunks = chunkJsonl(content);
      break;
    case ".yaml":
    case ".yml":
      chunks = chunkYaml(content);
      break;
    default:
      return chunkMarkdown(content, chunkSize ? { tokens: chunkSize, overlap: Math.floor(chunkSize / 8) } : undefined);
  }
  // Split oversized chunks (JSON/YAML may produce very large chunks)
  return splitOversized(chunks, maxChars);
}

/**
 * Split chunks that exceed maxChars into smaller line-based sub-chunks.
 */
function splitOversized(chunks: MemoryChunk[], maxChars: number): MemoryChunk[] {
  const result: MemoryChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.text.length <= maxChars) {
      result.push(chunk);
      continue;
    }
    const lines = chunk.text.split("\n");
    let buf: string[] = [];
    let bufStart = chunk.startLine;
    let bufChars = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (bufChars + line.length + 1 > maxChars && buf.length > 0) {
        const text = buf.join("\n");
        result.push({
          startLine: bufStart,
          endLine: bufStart + buf.length - 1,
          text,
          hash: hashText(text),
        });
        buf = [];
        bufStart = chunk.startLine + i;
        bufChars = 0;
      }
      buf.push(line);
      bufChars += line.length + 1;
    }
    if (buf.length > 0) {
      const text = buf.join("\n");
      result.push({
        startLine: bufStart,
        endLine: bufStart + buf.length - 1,
        text,
        hash: hashText(text),
      });
    }
  }
  return result;
}

/**
 * Chunk JSON content by top-level keys.
 * Each top-level key becomes a separate chunk.
 * Falls back to single-chunk if parsing fails or content is not an object/array.
 */
export function chunkJson(content: string): MemoryChunk[] {
  const lines = content.split("\n");

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return singleChunk(content, lines);
  }

  if (Array.isArray(parsed)) {
    return chunkJsonArray(parsed, lines, content);
  }

  if (typeof parsed !== "object" || parsed === null) {
    return singleChunk(content, lines);
  }

  const keys = Object.keys(parsed);
  if (keys.length === 0) return singleChunk(content, lines);

  // Find each top-level key's line position using brace depth tracking (single pass)
  const chunks: MemoryChunk[] = [];
  const keyPositions: Array<{ key: string; startLine: number }> = [];
  const keySet = new Set(keys);
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // At depth 1 (inside root object), check if this line starts a top-level key
    if (depth === 1) {
      const m = line.match(/^\s*"([^"]+)"\s*:/);
      if (m && keySet.has(m[1]!)) {
        keyPositions.push({ key: m[1]!, startLine: i });
        keySet.delete(m[1]!);
      }
    }
    for (const ch of line) {
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
    }
  }

  if (keyPositions.length === 0) return singleChunk(content, lines);

  // Sort by line number (usually already in order)
  keyPositions.sort((a, b) => a.startLine - b.startLine);

  for (let i = 0; i < keyPositions.length; i++) {
    const start = keyPositions[i]!.startLine;
    const end = i + 1 < keyPositions.length
      ? keyPositions[i + 1]!.startLine - 1
      : lines.length - 1;
    const text = lines.slice(start, end + 1).join("\n").replace(/,\s*$/, "");
    if (text.trim().length === 0) continue;
    chunks.push({
      startLine: start + 1,
      endLine: end + 1,
      text,
      hash: hashText(text),
    });
  }

  return chunks.length > 0 ? chunks : singleChunk(content, lines);
}

/**
 * Chunk a JSON array by element — each element becomes a chunk.
 * Uses brace/bracket depth tracking to find element boundaries.
 */
function chunkJsonArray(arr: unknown[], lines: string[], content: string): MemoryChunk[] {
  if (arr.length <= 1) return singleChunk(content, lines);

  const chunks: MemoryChunk[] = [];
  let depth = 0;
  let elemStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const ch of line) {
      if (ch === "{" || ch === "[") {
        depth++;
        // depth 2 = start of array element (depth 1 is the outer array)
        if (depth === 2 && elemStart === -1) {
          elemStart = i;
        }
      }
      if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 1 && elemStart !== -1) {
          const text = lines.slice(elemStart, i + 1).join("\n").replace(/,\s*$/, "");
          if (text.trim().length > 0) {
            chunks.push({
              startLine: elemStart + 1,
              endLine: i + 1,
              text,
              hash: hashText(text),
            });
          }
          elemStart = -1;
        }
      }
    }
  }

  return chunks.length > 0 ? chunks : singleChunk(content, lines);
}

/**
 * Chunk JSONL content — each non-empty line becomes a chunk.
 */
export function chunkJsonl(content: string): MemoryChunk[] {
  const lines = content.split("\n");
  const chunks: MemoryChunk[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    chunks.push({
      startLine: i + 1,
      endLine: i + 1,
      text: line,
      hash: hashText(line),
    });
  }
  return chunks;
}

/**
 * Chunk YAML content by top-level keys or `---` document separators.
 * Each top-level key (non-indented) becomes a separate chunk.
 */
export function chunkYaml(content: string): MemoryChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  // Check for multi-document YAML (--- separators)
  const docStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i]!)) {
      docStarts.push(i);
    }
  }

  // Multi-document: split by ---
  if (docStarts.length >= 2) {
    return chunkYamlDocs(lines, docStarts);
  }

  // Single document: split by top-level keys
  const keyStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Top-level key: valid YAML key name followed by colon
    if (/^[A-Za-z_][A-Za-z0-9_.\-]*\s*:/.test(line)) {
      keyStarts.push(i);
    }
  }

  if (keyStarts.length <= 1) return singleChunk(content, lines);

  const chunks: MemoryChunk[] = [];
  for (let i = 0; i < keyStarts.length; i++) {
    const start = keyStarts[i]!;
    const end = i + 1 < keyStarts.length
      ? keyStarts[i + 1]! - 1
      : lines.length - 1;
    const text = lines.slice(start, end + 1).join("\n");
    if (text.trim().length === 0) continue;
    chunks.push({
      startLine: start + 1,
      endLine: end + 1,
      text,
      hash: hashText(text),
    });
  }

  return chunks.length > 0 ? chunks : singleChunk(content, lines);
}

function chunkYamlDocs(lines: string[], docStarts: number[]): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];
  for (let i = 0; i < docStarts.length; i++) {
    const start = docStarts[i]!;
    const end = i + 1 < docStarts.length
      ? docStarts[i + 1]! - 1
      : lines.length - 1;
    const text = lines.slice(start, end + 1).join("\n");
    if (text.replace(/^---\s*$/gm, "").trim().length === 0) continue;
    chunks.push({
      startLine: start + 1,
      endLine: end + 1,
      text,
      hash: hashText(text),
    });
  }
  return chunks;
}

function singleChunk(content: string, lines: string[]): MemoryChunk[] {
  if (content.trim().length === 0) return [];
  return [{
    startLine: 1,
    endLine: lines.length,
    text: content,
    hash: hashText(content),
  }];
}

/**
 * Chunk markdown content using a sliding window with line-aware boundaries.
 * maxChars ≈ tokens * 4, overlap in chars.
 */
export function chunkMarkdown(
  content: string,
  opts: { tokens: number; overlap: number } = { tokens: 512, overlap: 64 },
): MemoryChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const maxChars = Math.max(32, opts.tokens * 4);
  const overlapChars = Math.max(0, opts.overlap * 4);
  const chunks: MemoryChunk[] = [];
  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((e) => e.line).join("\n");
    chunks.push({
      startLine: current[0]!.lineNo,
      endLine: current[current.length - 1]!.lineNo,
      text,
      hash: hashText(text),
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: typeof current = [];
    for (let i = current.length - 1; i >= 0; i--) {
      acc += current[i]!.line.length + 1;
      kept.unshift(current[i]!);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = kept.reduce((s, e) => s + e.line.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const lineSize = line.length + 1;
    const isHeading = /^#{1,6}\s/.test(line);

    // Break before headings to keep them with their content
    if (isHeading && current.length > 0) {
      flush();
      current = [];
      currentChars = 0;
    } else if (currentChars + lineSize > maxChars && current.length > 0) {
      flush();
      carryOverlap();
    }
    current.push({ line, lineNo });
    currentChars += lineSize;
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// Session transcript discovery & parsing
// ---------------------------------------------------------------------------

export type SessionFileEntry = MemoryFileEntry;

type SessionSource = {
  dir: string;
  /** 'copilot' scans {dir}/{uuid}/events.jsonl, 'claude' scans {dir}/{project}/*.jsonl */
  kind: "copilot" | "claude";
};

/**
 * Resolve session directories for supported host CLIs.
 * Copilot CLI: ~/.copilot/session-state/{uuid}/events.jsonl
 * Claude Code: ~/.claude/projects/{project}/*.jsonl
 */
function resolveSessionSources(): SessionSource[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return [];
  return [
    { dir: path.join(home, ".copilot", "session-state"), kind: "copilot" },
    { dir: path.join(home, ".claude", "projects"), kind: "claude" },
  ];
}

/**
 * Discover session JSONL files from all supported CLIs,
 * filtered by maxDays and maxCount.
 * maxCount=0 disables session indexing. maxCount=-1 means no count limit.
 */
export async function listSessionFiles(
  workspaceDir: string,
  opts?: { maxDays?: number; maxCount?: number },
): Promise<string[]> {
  const maxCount = opts?.maxCount ?? -1;
  if (maxCount === 0) return [];

  const maxDays = opts?.maxDays ?? 30;
  const cutoff = maxDays > 0 ? Date.now() - maxDays * 24 * 60 * 60 * 1000 : 0;

  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const src of resolveSessionSources()) {
    try {
      const entries = await fs.readdir(src.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (src.kind === "copilot") {
          // Copilot: {dir}/{uuid}/events.jsonl
          const eventsFile = path.join(src.dir, entry.name, "events.jsonl");
          try {
            const stat = await fs.stat(eventsFile);
            if (stat.isFile() && stat.size > 0 && stat.mtimeMs >= cutoff) {
              candidates.push({ path: eventsFile, mtimeMs: stat.mtimeMs });
            }
          } catch {}
        } else if (src.kind === "claude") {
          // Claude: {dir}/{project}/*.jsonl — each jsonl is a session
          const projDir = path.join(src.dir, entry.name);
          try {
            const projEntries = await fs.readdir(projDir, { withFileTypes: true });
            for (const pe of projEntries) {
              if (!pe.isFile() || !pe.name.endsWith(".jsonl")) continue;
              const filePath = path.join(projDir, pe.name);
              try {
                const stat = await fs.stat(filePath);
                if (stat.size > 0 && stat.mtimeMs >= cutoff) {
                  candidates.push({ path: filePath, mtimeMs: stat.mtimeMs });
                }
              } catch {}
            }
          } catch {}
        }
      }
    } catch {}
  }

  // Sort by mtime descending (newest first), then apply count limit
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited = maxCount > 0 ? candidates.slice(0, maxCount) : candidates;
  return limited.map((c) => c.path);
}

/** Extract text from Claude Code message content (string or content-block array). */
function extractClaudeText(content: unknown): string | null {
  if (typeof content === "string") {
    const t = content.trim();
    return t || null;
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const t = (block as { text?: string }).text;
        if (t && typeof t === "string") texts.push(t);
      }
    }
    const joined = texts.join("\n").trim();
    return joined || null;
  }
  return null;
}

const CLAUDE_CMD_RE = /^<(?:command-|local-command-)/;
/** Returns true if text is a Claude Code internal command (not real user input). */
function isClaudeCommand(text: string): boolean {
  return text.startsWith("/") || CLAUDE_CMD_RE.test(text);
}

/**
 * Parse a session JSONL file (Copilot CLI or Claude Code) and extract
 * user/assistant messages. Auto-detects format from JSON structure.
 * Returns a MemoryFileEntry with the extracted text as content.
 */
export async function buildSessionEntry(
  absPath: string,
  workspaceDir: string,
): Promise<SessionFileEntry | null> {
  try {
    const stat = await fs.stat(absPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    const collected: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const recType = record.type as string | undefined;
      if (!recType) continue;

      // --- Copilot CLI format ---
      // {type:"user.message", data:{content:"..."}}
      if (recType === "user.message") {
        const data = record.data as { content?: string } | undefined;
        const text = data?.content;
        if (text && typeof text === "string" && text.trim() && !text.startsWith("/")) {
          collected.push(`User: ${text.trim()}`);
        }
        continue;
      }
      if (recType === "assistant.message") {
        const data = record.data as { content?: string } | undefined;
        const text = data?.content;
        if (text && typeof text === "string" && text.trim()) {
          collected.push(`Assistant: ${text.trim()}`);
        }
        continue;
      }

      // --- Claude Code format ---
      // {type:"user", message:{role:"user", content:"..." | [{type:"text",text:"..."}]}}
      if (recType === "user") {
        const msg = record.message as { content?: unknown } | undefined;
        const content = msg?.content;
        const text = extractClaudeText(content);
        if (text && !isClaudeCommand(text)) {
          collected.push(`User: ${text}`);
        }
        continue;
      }
      // {type:"assistant", message:{role:"assistant", content:[{type:"text",text:"..."}]}}
      if (recType === "assistant") {
        const msg = record.message as { content?: unknown } | undefined;
        const text = extractClaudeText(msg?.content);
        if (text) collected.push(`Assistant: ${text}`);
        continue;
      }
    }

    if (collected.length === 0) return null;

    const content = collected.join("\n");
    // Derive session ID from file path:
    //   Copilot: dirname is the UUID  (session-state/{uuid}/events.jsonl)
    //   Claude:  filename is the UUID ({project}/{uuid}.jsonl)
    const basename = path.basename(absPath, ".jsonl");
    const sessionId = basename === "events" ? path.basename(path.dirname(absPath)) : basename;
    const relPath = `sessions/${sessionId}.jsonl`;

    return {
      path: relPath,
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashText(content),
      content,
    };
  } catch {
    return null;
  }
}
