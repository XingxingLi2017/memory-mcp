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

/** Delete the config file (reset to defaults). */
export function deleteConfigFile(filePath?: string): boolean {
  const p = filePath ?? configFilePath();
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Load config (file > defaults)
// ---------------------------------------------------------------------------

let cachedConfig: MemoryConfig | null = null;

/**
 * Load and merge configuration.
 * Priority: overrides > config file > defaults.
 * The result is cached for the process lifetime (only when no overrides are given).
 */
export function loadConfig(overrides?: MemoryConfigFile, configPath?: string): MemoryConfig {
  if (!overrides && !configPath && cachedConfig) return cachedConfig;

  const file = readConfigFile(configPath);
  const workspace = overrides?.workspace ?? file.workspace ?? DEFAULTS.workspace;

  const config: MemoryConfig = {
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

  // Only cache when using default config (no overrides)
  if (!overrides && !configPath) {
    cachedConfig = config;
  }
  return config;
}

/** Reset the cached config (for testing or after config file changes). */
export function resetConfigCache(): void {
  cachedConfig = null;
}

/**
 * Resolve extraDirs to undefined if empty (for backward compat with callers
 * that check `if (extraDirs)` / pass to functions expecting `string[] | undefined`).
 */
export function resolvedExtraDirs(config: MemoryConfig): string[] | undefined {
  return config.extraDirs.length > 0 ? config.extraDirs : undefined;
}
