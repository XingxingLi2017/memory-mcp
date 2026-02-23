import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** File extensions indexed by the memory system. */
export const MEMORY_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);

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
