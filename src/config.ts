/**
 * Centralized configuration for memory-mcp.
 *
 * Priority: environment variable > config file (~/.copilot/memory-mcp.json) > defaults.
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

/** Return the config file path for a given workspace (or the default workspace). */
export function configFilePath(workspaceDir?: string): string {
  return path.join(workspaceDir ?? DEFAULTS.workspace, CONFIG_FILENAME);
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
// Env var parsing helpers
// ---------------------------------------------------------------------------

function envString(key: string): string | undefined {
  const val = process.env[key];
  return val || undefined; // treat empty string as undefined
}

function envInt(key: string, min: number, max: number): number | undefined {
  const raw = envString(key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= min && n <= max) return n;
  return undefined;
}

function envIntLoose(key: string, min: number): number | undefined {
  const raw = envString(key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= min) return n;
  return undefined;
}

function envStringArray(key: string): string[] | undefined {
  const raw = envString(key);
  if (raw === undefined) return undefined;
  const items = raw.split(",").map((d) => d.trim()).filter(Boolean).map((d) => path.resolve(d));
  return items.length > 0 ? items : undefined;
}

// ---------------------------------------------------------------------------
// Load config (merged: env > file > defaults)
// ---------------------------------------------------------------------------

let cachedConfig: MemoryConfig | null = null;

/**
 * Load and merge configuration.
 * Priority: env var > config file > defaults.
 * The result is cached for the process lifetime.
 */
export function loadConfig(): MemoryConfig {
  if (cachedConfig) return cachedConfig;

  // 1. Read file config (need workspace first to find the file)
  const envWorkspace = envString("MEMORY_WORKSPACE");
  const fileForLookup = envWorkspace
    ? configFilePath(envWorkspace)
    : configFilePath();
  const file = readConfigFile(fileForLookup);

  // 2. Merge: env > file > defaults
  const workspace = envWorkspace ?? file.workspace ?? DEFAULTS.workspace;

  const config: MemoryConfig = {
    workspace,
    dbPath:
      envString("MEMORY_DB_PATH") ??
      file.dbPath ??
      path.join(workspace, "memory.db"),
    chunkSize:
      envInt("MEMORY_CHUNK_SIZE", 64, 4096) ??
      file.chunkSize ??
      DEFAULTS.chunkSize,
    tokenMax:
      envInt("MEMORY_TOKEN_MAX", 100, 16384) ??
      file.tokenMax ??
      DEFAULTS.tokenMax,
    sessionDays:
      envIntLoose("MEMORY_SESSION_DAYS", 0) ??
      file.sessionDays ??
      DEFAULTS.sessionDays,
    sessionMax:
      envIntLoose("MEMORY_SESSION_MAX", -1) ??
      file.sessionMax ??
      DEFAULTS.sessionMax,
    extraDirs:
      envStringArray("MEMORY_EXTRA_DIRS") ??
      file.extraDirs ??
      DEFAULTS.extraDirs,
    model:
      envString("MEMORY_MCP_MODEL") ??
      file.model ??
      DEFAULTS.model,
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
