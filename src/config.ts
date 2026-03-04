/**
 * Centralized configuration for memory-mcp.
 *
 * Priority: config file (~/memory-mcp.json) > built-in defaults.
 * Copilot CLI and Claude Code share the same config and database.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionDirConfig = {
  dir: string;
  /** 'copilot' scans {dir}/{uuid}/events.jsonl, 'claude' scans {dir}/{project}/*.jsonl */
  kind: "copilot" | "claude";
};

export interface MemoryConfig {
  workspace: string;
  dbPath: string;
  chunkSize: number;
  tokenMax: number;
  sessionDays: number;
  sessionMax: number;
  sessionDirs: SessionDirConfig[];
  extraDirs: string[];
  model: string;
}

/** Partial config as stored in the JSON file (all fields optional). */
export type MemoryConfigFile = Partial<MemoryConfig>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "~";

export const DEFAULT_WORKDIR = path.join(HOME, ".memory-mcp-workdir");

export const DEFAULT_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

export const DEFAULT_SESSION_DIRS: readonly SessionDirConfig[] = [
  { dir: path.join(HOME, ".copilot", "session-state"), kind: "copilot" },
  { dir: path.join(HOME, ".claude", "projects"), kind: "claude" },
];

export const DEFAULTS: Readonly<MemoryConfig> = {
  workspace: DEFAULT_WORKDIR,
  dbPath: "", // derived from workspace if empty
  chunkSize: 512,
  tokenMax: 4096,
  sessionDays: 30,
  sessionMax: -1,
  sessionDirs: DEFAULT_SESSION_DIRS as SessionDirConfig[],
  extraDirs: [],
  model: DEFAULT_MODEL,
};

export const CONFIG_FILENAME = "memory-mcp.json";

// ---------------------------------------------------------------------------
// Config file I/O
// ---------------------------------------------------------------------------

/** Return the config file path (inside the workdir: ~/.memory-mcp-workdir/memory-mcp.json). */
export function configFilePath(): string {
  return path.join(DEFAULT_WORKDIR, CONFIG_FILENAME);
}

/** Read the config file. Returns {} if missing or invalid. */
export function readConfigFile(filePath?: string): MemoryConfigFile {
  const p = filePath ?? configFilePath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as MemoryConfigFile;
    }
  } catch {
    // missing or invalid — fine
  }
  return {};
}

/** Save partial config to the file (only non-default values). */
export function saveConfigFile(partial: MemoryConfigFile, filePath?: string): void {
  const p = filePath ?? configFilePath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(p, JSON.stringify(partial, null, 2) + "\n", "utf-8");
}

/** Delete the config file (reset to defaults). Returns true if deleted. */
export function deleteConfigFile(filePath?: string): boolean {
  const p = filePath ?? configFilePath();
  try {
    fs.unlinkSync(p);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Load config (file > defaults)
// ---------------------------------------------------------------------------

/**
 * Load and merge configuration.
 * Priority: overrides > config file > defaults.
 */
export function loadConfig(overrides?: MemoryConfigFile, configPath?: string): MemoryConfig {
  const file = readConfigFile(configPath);
  const workspace = overrides?.workspace ?? file.workspace ?? DEFAULTS.workspace;

  return {
    workspace,
    dbPath: overrides?.dbPath ?? file.dbPath ?? path.join(workspace, "memory.db"),
    chunkSize: overrides?.chunkSize ?? file.chunkSize ?? DEFAULTS.chunkSize,
    tokenMax: overrides?.tokenMax ?? file.tokenMax ?? DEFAULTS.tokenMax,
    sessionDays: overrides?.sessionDays ?? file.sessionDays ?? DEFAULTS.sessionDays,
    sessionMax: overrides?.sessionMax ?? file.sessionMax ?? DEFAULTS.sessionMax,
    sessionDirs: overrides?.sessionDirs ?? file.sessionDirs ?? DEFAULTS.sessionDirs,
    extraDirs: overrides?.extraDirs ?? file.extraDirs ?? DEFAULTS.extraDirs,
    model: overrides?.model ?? file.model ?? DEFAULTS.model,
  };
}

/**
 * Resolve extraDirs to undefined if empty (for backward compat with callers
 * that check `if (extraDirs)` / pass to functions expecting `string[] | undefined`).
 */
export function resolvedExtraDirs(config: MemoryConfig): string[] | undefined {
  return config.extraDirs.length > 0 ? config.extraDirs : undefined;
}

// ---------------------------------------------------------------------------
// Migration from legacy directories (~/.copilot, ~/.claude)
// ---------------------------------------------------------------------------

const MEMORY_ROOT_FILES = ["MEMORY.md", "memory.md", "MEMORY.txt", "memory.txt"];

function copyIfMissing(src: string, dest: string): boolean {
  if (fs.existsSync(dest)) return false;
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function copyDirMerge(srcDir: string, destDir: string): number {
  if (!fs.existsSync(srcDir)) return 0;
  let count = 0;
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += copyDirMerge(srcPath, destPath);
    } else if (entry.isFile()) {
      if (copyIfMissing(srcPath, destPath)) count++;
    }
  }
  return count;
}

/**
 * Migrate memory files from legacy directories (~/.copilot, ~/.claude) to the new workdir.
 * Only runs if the new workdir has no MEMORY.md and no memory/ directory.
 * Safe to call from both setup.ts and server.ts.
 */
export function migrateFromLegacyDirs(workspaceDir: string): void {
  const hasMemoryFile = MEMORY_ROOT_FILES.some((f) => fs.existsSync(path.join(workspaceDir, f)));
  const hasMemoryDir = fs.existsSync(path.join(workspaceDir, "memory"));
  if (hasMemoryFile || hasMemoryDir) return;

  const legacyDirs = [
    path.join(HOME, ".copilot"),
    path.join(HOME, ".claude"),
  ];

  let migrated = false;

  for (const legacyDir of legacyDirs) {
    if (!fs.existsSync(legacyDir)) continue;
    const label = path.basename(legacyDir);

    for (const file of MEMORY_ROOT_FILES) {
      const src = path.join(legacyDir, file);
      if (fs.existsSync(src) && copyIfMissing(src, path.join(workspaceDir, file))) {
        if (!migrated) {
          console.error(`[memory-mcp] Migrating memory files to ${workspaceDir}:`);
          migrated = true;
        }
        console.error(`[memory-mcp]   ✓ Copied ${file} from ~/${label}/`);
      }
    }

    const srcMemDir = path.join(legacyDir, "memory");
    if (fs.existsSync(srcMemDir)) {
      const count = copyDirMerge(srcMemDir, path.join(workspaceDir, "memory"));
      if (count > 0) {
        if (!migrated) {
          console.error(`[memory-mcp] Migrating memory files to ${workspaceDir}:`);
          migrated = true;
        }
        console.error(`[memory-mcp]   ✓ Copied memory/ (${count} files) from ~/${label}/`);
      }
    }
  }

  if (migrated) {
    console.error("[memory-mcp]   Note: Original files retained. Remove manually when ready.");
  }
}
