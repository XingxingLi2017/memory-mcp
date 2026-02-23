#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

When search results show source="sessions", consider: does this contain lasting knowledge? If yes, distill it into a fact via memory_write.
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
  if (target === "claude") {
    const claudeDir = path.join(home, ".claude");
    return {
      name: "Claude Code",
      workspaceDir: claudeDir,
      mcpConfigPath: path.join(home, ".claude.json"),
      instructionsPath: path.join(claudeDir, "CLAUDE.md"),
      serverEnv: { MEMORY_WORKSPACE: claudeDir },
    };
  }
  const copilotDir = path.join(home, ".copilot");
  return {
    name: "Copilot CLI",
    workspaceDir: copilotDir,
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
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const flags = new Set(args.slice(1));

  const validCommands = ["setup", "uninstall"];
  if (!command || !validCommands.includes(command)) {
    console.log(`memory-mcp — Local memory management for AI coding assistants

Usage:
  memory-mcp setup [--claude]       Configure MCP server for Copilot CLI (or Claude Code)
  memory-mcp uninstall [--claude]   Remove memory MCP configuration

Options:
  --claude    Target Claude Code CLI instead of GitHub Copilot CLI

The MCP server itself is started automatically by the host CLI.`);
    process.exit(0);
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

  const mcpResult = setupMcpConfig(profile);
  console.log(mcpResult.changed ? `✓ ${mcpResult.message}` : `  ${mcpResult.message}`);

  const instrResult = setupInstructions(profile);
  console.log(instrResult.changed ? `✓ ${instrResult.message}` : `  ${instrResult.message}`);

  console.log(`\nDone! Restart ${profile.name} to activate memory search.`);
  console.log(`Create MEMORY.md or memory/*.md in ${profile.workspaceDir} to start storing memories.`);
}

main();
