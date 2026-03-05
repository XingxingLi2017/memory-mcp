#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig, readConfigFile, saveConfigFile, deleteConfigFile,
  configFilePath, DEFAULTS, migrateFromLegacyDirs,
  listProfiles, getDefaultProfile, createProfile, deleteProfile,
  saveProfileConfig, setDefaultProfile, resetProfile,
  DEFAULT_PROFILE, DEFAULT_WORKDIR, validateProfileName,
  type MemoryConfig, type MemoryConfigFile,
} from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MCP_SERVER_NAME = "memory";

const INSTRUCTIONS_BLOCK = `
<memory_recall>
Before answering questions about prior work, decisions, dates, people, preferences, project context, or todos:

1. Run \`memory_search\` with a relevant query to check MEMORY.md and memory/*.md files (also .txt, .json, .jsonl, .yaml)
2. If results look relevant, use \`memory_get\` to pull only the needed lines
3. If low confidence after search, say you checked but found nothing relevant

Do not skip the memory search step — it ensures continuity across sessions.
</memory_recall>

<memory_write>
You are building a personal memory of this user. As memories grow, you understand them better and they need to explain less.
Call \`memory_write\` proactively — do not wait for "remember this."

When calling memory_write:
- \`content\`: one clear fact — what you learned (the compressed knowledge)
- \`evidence\`: the raw context — conversation excerpt, code snippet, or observation that supports the fact (optional but valuable)

The system auto-chunks evidence and links it to the fact. Search returns facts first; use \`memory_get\` to drill into evidence when needed.
Think of it as: content = the answer, evidence = the receipts.

Write when:
- User reveals preferences, coding style, tools, workflow, or naming conventions
- A decision is made with reasoning worth preserving
- User corrects you — store it so the mistake never repeats
- Project structure, architecture, or deployment details emerge
- You discover gotchas, workarounds, or non-obvious patterns
- User mentions people, teams, or responsibilities
- Anything that would save the user from re-explaining next session

Do NOT write:
- Ephemeral context: current task details, temporary debugging, one-off commands
- Generic knowledge not specific to this user
- Secrets, passwords, API keys, or personal identifiers

When search results include \`distillHint: true\`, the data is raw session history — consider distilling key learnings into a fact via memory_write.
</memory_write>

<memory_maintenance>
Stale or contradictory memories are worse than no memories.

- User corrects a fact → \`memory_update\` to replace it
- Information becomes obsolete → \`memory_forget\` to remove it
- Contradiction detected → ask the user, then update or forget
</memory_maintenance>
`.trim();

const INSTRUCTIONS_MARKER = "<memory_recall>";
// Detect old prompt formats for backward compatibility
const LEGACY_MARKERS = ["## Memory Recall", "## Memory Write", "## Memory Maintenance"];

// ---------------------------------------------------------------------------
// Target profiles: Copilot CLI vs Claude Code CLI
// ---------------------------------------------------------------------------

type TargetProfile = {
  name: string;
  /** Directory that holds memory files and DB */
  workspaceDir: string;
  /** Path to MCP config JSON */
  mcpConfigPath: string;
  /** Path to instructions file */
  instructionsPath: string;
  /** Extra env vars to pass to the MCP server */
  serverEnv?: Record<string, string>;
};

function getHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

function buildProfile(target: "copilot" | "claude"): TargetProfile {
  const home = getHomeDir();
  const config = loadConfig();
  const workspaceDir = config.workspace; // resolved from default profile
  if (target === "claude") {
    const claudeDir = path.join(home, ".claude");
    return {
      name: "Claude Code",
      workspaceDir,
      mcpConfigPath: path.join(home, ".claude.json"),
      instructionsPath: path.join(claudeDir, "CLAUDE.md"),
    };
  }
  const copilotDir = path.join(home, ".copilot");
  return {
    name: "Copilot CLI",
    workspaceDir,
    mcpConfigPath: path.join(copilotDir, "mcp-config.json"),
    instructionsPath: path.join(copilotDir, "copilot-instructions.md"),
  };
}

/**
 * Resolve the path to the server.js entry point.
 * Works whether installed globally (npm -g) or run from source.
 */
function resolveServerPath(): string {
  // server.js is in the same directory as this setup.js
  return path.join(__dirname, "server.js");
}

/**
 * Read and parse a JSON file, or return null if missing/invalid.
 */
function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Write a JSON file with pretty formatting.
 */
function writeJsonFile(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// MCP config
// ---------------------------------------------------------------------------

type McpConfig = {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
};

function setupMcpConfig(profile: TargetProfile): { changed: boolean; message: string } {
  const configPath = profile.mcpConfigPath;
  const serverEntryPath = resolveServerPath();

  // Ensure parent directory exists
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const config: McpConfig = (readJsonFile(configPath) as McpConfig) ?? {};

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;
  const existing = servers[MCP_SERVER_NAME] as Record<string, unknown> | undefined;

  // Build the expected server config
  const expected: Record<string, unknown> = {
    command: "node",
    args: [serverEntryPath],
  };
  if (profile.serverEnv) {
    expected.env = profile.serverEnv;
  }

  if (existing) {
    const existingArgs = (existing as { args?: string[] }).args;
    if (
      (existing as { command?: string }).command === expected.command &&
      Array.isArray(existingArgs) &&
      existingArgs[0] === (expected.args as string[])[0]
    ) {
      return { changed: false, message: `MCP server "${MCP_SERVER_NAME}" already configured.` };
    }
    // Update existing entry (path may have changed after reinstall)
    servers[MCP_SERVER_NAME] = expected;
    writeJsonFile(configPath, config);
    return { changed: true, message: `MCP server "${MCP_SERVER_NAME}" updated in ${configPath}` };
  }

  servers[MCP_SERVER_NAME] = expected;
  writeJsonFile(configPath, config);
  return { changed: true, message: `MCP server "${MCP_SERVER_NAME}" added to ${configPath}` };
}

// ---------------------------------------------------------------------------
// Copilot instructions
// ---------------------------------------------------------------------------

function setupInstructions(profile: TargetProfile): { changed: boolean; message: string } {
  const instrPath = profile.instructionsPath;

  // Ensure parent directory exists
  const instrDir = path.dirname(instrPath);
  if (!fs.existsSync(instrDir)) {
    fs.mkdirSync(instrDir, { recursive: true });
  }

  let content = "";
  try {
    content = fs.readFileSync(instrPath, "utf-8");
  } catch {}

  // Idempotent: check if our block already exists (current or legacy format)
  if (content.includes(INSTRUCTIONS_MARKER) || LEGACY_MARKERS.some((m) => content.includes(m))) {
    return { changed: false, message: "Memory recall instructions already present." };
  }

  // Append our block (with a blank line separator if the file isn't empty)
  const separator = content.length > 0 && !content.endsWith("\n\n") ? "\n\n" : "";
  const newContent = content + separator + INSTRUCTIONS_BLOCK + "\n";
  fs.writeFileSync(instrPath, newContent, "utf-8");
  return { changed: true, message: `Memory recall instructions added to ${instrPath}` };
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

function uninstall(profile: TargetProfile): void {
  // Remove MCP server entry
  const configPath = profile.mcpConfigPath;
  const config = readJsonFile(configPath) as McpConfig | null;
  if (config?.mcpServers) {
    const servers = config.mcpServers as Record<string, unknown>;
    if (servers[MCP_SERVER_NAME]) {
      delete servers[MCP_SERVER_NAME];
      writeJsonFile(configPath, config);
      console.log(`✓ Removed MCP server "${MCP_SERVER_NAME}" from ${configPath}`);
    } else {
      console.log(`  MCP server "${MCP_SERVER_NAME}" not found in config.`);
    }
  }

  // Remove instructions block
  const instrPath = profile.instructionsPath;
  try {
    let content = fs.readFileSync(instrPath, "utf-8");
    if (content.includes(INSTRUCTIONS_MARKER)) {
      content = content.replace(INSTRUCTIONS_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();
      fs.writeFileSync(instrPath, content ? content + "\n" : "", "utf-8");
      console.log(`✓ Removed memory recall instructions from ${instrPath}`);
    }
  } catch {}

  // Notify about residual data
  const dbPath = path.join(profile.workspaceDir, "memory.db");
  if (fs.existsSync(dbPath)) {
    console.log(`\n  Note: Memory database retained at ${dbPath}`);
    const isWin = process.platform === "win32";
    const cmd = isWin
      ? `del "${dbPath}" "${dbPath}-wal" "${dbPath}-shm"`
      : `rm ${dbPath} ${dbPath}-wal ${dbPath}-shm`;
    console.log(`  To remove all data: ${cmd}`);
  }
}

// ---------------------------------------------------------------------------
// Config command
// ---------------------------------------------------------------------------

const CONFIG_KEYS: (keyof MemoryConfig)[] = [
  "workspace", "dbPath", "chunkSize", "tokenMax",
  "sessionDays", "sessionMax", "sessionDirs", "extraDirs", "model",
];

function handleConfig(args: string[]): void {
  // Extract --profile flag from args
  let profileName: string | undefined;
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile" && args[i + 1]) {
      profileName = args[++i];
    } else {
      filteredArgs.push(args[i]!);
    }
  }
  const sub = filteredArgs[0];

  // Profile management subcommands
  if (sub === "profile") {
    const action = filteredArgs[1];
    if (!action || action === "list") {
      const profiles = listProfiles();
      const defaultP = getDefaultProfile();
      for (const p of profiles) {
        console.log(p === defaultP ? `  ${p} (default)` : `  ${p}`);
      }
      return;
    }
    if (action === "create") {
      const name = filteredArgs[2];
      if (!name) { console.error("Usage: memory-mcp config profile create <name>"); process.exit(1); }
      if (createProfile(name)) {
        console.log(`✓ Profile "${name}" created.`);
      } else {
        console.log(`  Profile "${name}" already exists.`);
      }
      return;
    }
    if (action === "delete") {
      const name = filteredArgs[2];
      if (!name) { console.error("Usage: memory-mcp config profile delete <name>"); process.exit(1); }
      if (deleteProfile(name)) {
        console.log(`✓ Profile "${name}" deleted.`);
        const wsDir = path.join(DEFAULT_WORKDIR, name);
        if (fs.existsSync(wsDir)) {
          console.log(`  Note: Workspace directory retained at ${wsDir} — remove manually if no longer needed.`);
        }
      } else {
        console.log(`  Profile "${name}" not found.`);
      }
      return;
    }
    if (action === "default") {
      const name = filteredArgs[2];
      if (!name) { console.error("Usage: memory-mcp config profile default <name>"); process.exit(1); }
      setDefaultProfile(name);
      console.log(`✓ Default profile set to "${name}".`);
      return;
    }
    console.error("Usage: memory-mcp config profile [list|create|delete|default] [name]");
    process.exit(1);
  }

  if (!sub || sub === "show") {
    const merged = loadConfig({ profile: profileName });
    const filePath = configFilePath();
    const label = profileName ?? getDefaultProfile();
    console.log(`Config file: ${filePath}`);
    console.log(`Profile: ${label}\n`);
    console.log(JSON.stringify(merged, null, 2));
    return;
  }

  if (sub === "path") {
    console.log(configFilePath());
    return;
  }

  if (sub === "reset") {
    if (profileName) {
      // Reset profile config to empty (keeps the profile entry)
      if (resetProfile(profileName)) {
        console.log(`✓ Profile "${profileName}" reset to defaults.`);
      } else {
        console.log(`  Profile "${profileName}" not found.`);
      }
    } else {
      const filePath = configFilePath();
      if (deleteConfigFile(filePath)) {
        console.log(`✓ Config file deleted: ${filePath}`);
        console.log("  All profiles and settings reset to defaults.");
      } else {
        console.log("  No config file found — already using defaults.");
      }
    }
    return;
  }

  if (sub === "set") {
    const key = filteredArgs[1] as keyof MemoryConfig | undefined;
    const value = filteredArgs[2];
    if (!key || value === undefined) {
      console.error("Usage: memory-mcp config [--profile <name>] set <key> <value>");
      console.error(`Valid keys: ${CONFIG_KEYS.join(", ")}`);
      process.exit(1);
    }
    if (!CONFIG_KEYS.includes(key)) {
      console.error(`Unknown config key: ${key}`);
      console.error(`Valid keys: ${CONFIG_KEYS.join(", ")}`);
      process.exit(1);
    }

    // Build the partial config to save
    const partial: MemoryConfigFile = {};

    // Parse and validate value
    if (key === "extraDirs") {
      partial.extraDirs = value
        .split(",").map((d) => d.trim()).filter(Boolean).map((d) => path.resolve(d));
    } else if (key === "sessionDirs") {
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) throw new Error("must be an array");
        for (const item of parsed) {
          if (!item.dir || !item.kind || !["copilot", "claude"].includes(item.kind)) {
            throw new Error(`each entry needs {dir, kind: "copilot"|"claude"}`);
          }
        }
        partial.sessionDirs = parsed;
      } catch (err) {
        console.error(`sessionDirs must be valid JSON array, e.g. '[{"dir":"/path","kind":"copilot"}]'`);
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    } else if (key === "chunkSize" || key === "tokenMax" || key === "sessionDays" || key === "sessionMax") {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        console.error(`${key} must be a number, got "${value}"`);
        process.exit(1);
      }
      const ranges: Record<string, [number, number]> = {
        chunkSize: [64, 4096],
        tokenMax: [100, 16384],
        sessionDays: [0, Infinity],
        sessionMax: [-1, Infinity],
      };
      const [min, max] = ranges[key]!;
      if (n < min || n > max) {
        console.error(`${key} must be between ${min} and ${max === Infinity ? "∞" : max}, got ${n}`);
        process.exit(1);
      }
      partial[key] = n;
    } else {
      (partial as Record<string, unknown>)[key] = value;
    }

    // Save to the specified profile, or the default profile if not specified
    const targetProfile = profileName ?? getDefaultProfile();
    saveProfileConfig(targetProfile, partial);
    console.log(`✓ [${targetProfile}] ${key} = ${JSON.stringify(partial[key])}`);
    console.log(`  Saved to ${configFilePath()}`);
    return;
  }

  console.error(`Unknown config subcommand: ${sub}`);
  console.error("Usage: memory-mcp config [show|set|reset|path|profile]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const flags = new Set(args.slice(1));

  const validCommands = ["setup", "uninstall", "config"];
  if (!command || !validCommands.includes(command)) {
    console.log(`memory-mcp — Local memory management for AI coding assistants

Usage:
  memory-mcp setup [--claude]                  Configure MCP server
  memory-mcp uninstall [--claude]              Remove memory MCP configuration
  memory-mcp config [--profile <name>] [show]  Show config (optionally for a profile)
  memory-mcp config [--profile <name>] set <key> <val>  Set a config value
  memory-mcp config [--profile <name>] reset   Reset config/profile
  memory-mcp config path                       Show config file path
  memory-mcp config profile list               List all profiles
  memory-mcp config profile create <name>      Create a new profile
  memory-mcp config profile delete <name>      Delete a profile
  memory-mcp config profile default <name>     Set the default profile

Options:
  --claude    Target Claude Code CLI instead of GitHub Copilot CLI

The MCP server itself is started automatically by the host CLI.
Use --profile <name> with the server: node dist/server.js --profile <name>`);
    process.exit(0);
  }

  if (command === "config") {
    handleConfig(args.slice(1));
    return;
  }

  const target = flags.has("--claude") ? "claude" : "copilot";
  const profile = buildProfile(target);

  if (!fs.existsSync(profile.workspaceDir)) {
    fs.mkdirSync(profile.workspaceDir, { recursive: true });
  }

  if (command === "uninstall") {
    uninstall(profile);
    console.log(`\nDone. Restart ${profile.name} to apply changes.`);
    return;
  }

  // --- setup ---
  console.log(`Setting up memory-mcp for ${profile.name}...\n`);

  // Initialize config file with default profile if it doesn't exist
  const cfgPath = configFilePath();
  if (!fs.existsSync(cfgPath)) {
    createProfile(DEFAULT_PROFILE);
    console.log(`✓ Created config with "${DEFAULT_PROFILE}" profile at ${cfgPath}`);
  }

  // Migrate from legacy dirs if this is a fresh workspace
  migrateFromLegacyDirs(profile.workspaceDir);

  const mcpResult = setupMcpConfig(profile);
  console.log(mcpResult.changed ? `✓ ${mcpResult.message}` : `  ${mcpResult.message}`);

  const instrResult = setupInstructions(profile);
  console.log(instrResult.changed ? `✓ ${instrResult.message}` : `  ${instrResult.message}`);

  console.log(`\nDone! Restart ${profile.name} to activate memory search.`);
  console.log(`Create MEMORY.md or memory/*.md in ${profile.workspaceDir} to start storing memories.`);
}

main();
