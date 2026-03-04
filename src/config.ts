/**
 * Centralized configuration for memory-mcp.
 *
 * Priority: config file (~/memory-mcp.json) > built-in defaults.
 * No environment variables — all settings go through the config file.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryConfig {
  workspace: string;
  dbPath: string;
  chunkSize: number;
  tokenMax: number;
  sessionDays: number;
  sessionMax: number;
  extraDirs: string[];
  model: string;
}

/** Partial config as stored in the JSON file (all fields optional). */
export type MemoryConfigFile = Partial<MemoryConfig>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "~";

export const DEFAULT_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

export const DEFAULTS: Readonly<MemoryConfig> = {
  workspace: path.join(HOME, ".copilot"),
  dbPath: "", // derived from workspace if empty
  chunkSize: 512,
  tokenMax: 4096,
  sessionDays: 30,
  sessionMax: -1,
  extraDirs: [],
  model: DEFAULT_MODEL,
};

export const CONFIG_FILENAME = "memory-mcp.json";

// ---------------------------------------------------------------------------
// Config file I/O
// ---------------------------------------------------------------------------

/** Return the config file path (always ~/memory-mcp.json, cross-platform). */
export function configFilePath(): string {
  return path.join(HOME, CONFIG_FILENAME);
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
 * Priority: config file > defaults.
 * The result is cached for the process lifetime.
 */
export function loadConfig(): MemoryConfig {
  if (cachedConfig) return cachedConfig;

  const file = readConfigFile();
  const workspace = file.workspace ?? DEFAULTS.workspace;

  const config: MemoryConfig = {
    workspace,
    dbPath: file.dbPath ?? path.join(workspace, "memory.db"),
    chunkSize: file.chunkSize ?? DEFAULTS.chunkSize,
    tokenMax: file.tokenMax ?? DEFAULTS.tokenMax,
    sessionDays: file.sessionDays ?? DEFAULTS.sessionDays,
    sessionMax: file.sessionMax ?? DEFAULTS.sessionMax,
    extraDirs: file.extraDirs ?? DEFAULTS.extraDirs,
    model: file.model ?? DEFAULTS.model,
  };

  cachedConfig = config;
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
