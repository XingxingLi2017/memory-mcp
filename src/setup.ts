#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COPILOT_DIR_NAME = ".copilot";
const MCP_CONFIG_FILE = "mcp-config.json";
const INSTRUCTIONS_FILE = "copilot-instructions.md";
const MCP_SERVER_NAME = "memory";

const INSTRUCTIONS_BLOCK = `
## Memory Recall

Before answering questions about prior work, decisions, dates, people, preferences, project context, or todos:

1. Run \`memory_search\` with a relevant query to check MEMORY.md and memory/*.md files
2. If results look relevant, use \`memory_get\` to pull only the needed lines
3. If low confidence after search, say you checked but found nothing relevant

Do not skip the memory search step — it ensures continuity across sessions.
`.trim();

const INSTRUCTIONS_MARKER = "## Memory Recall";

function getHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

function getCopilotDir(): string {
  return path.join(getHomeDir(), COPILOT_DIR_NAME);
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

function setupMcpConfig(copilotDir: string): { changed: boolean; message: string } {
  const configPath = path.join(copilotDir, MCP_CONFIG_FILE);
  const serverEntryPath = resolveServerPath();

  const config: McpConfig = (readJsonFile(configPath) as McpConfig) ?? {};

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;
  const existing = servers[MCP_SERVER_NAME] as Record<string, unknown> | undefined;

  // Build the expected server config
  const expected = {
    command: "node",
    args: [serverEntryPath],
  };

  if (existing) {
    const existingArgs = (existing as { args?: string[] }).args;
    if (
      (existing as { command?: string }).command === expected.command &&
      Array.isArray(existingArgs) &&
      existingArgs[0] === expected.args[0]
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

function setupInstructions(copilotDir: string): { changed: boolean; message: string } {
  const instrPath = path.join(copilotDir, INSTRUCTIONS_FILE);

  let content = "";
  try {
    content = fs.readFileSync(instrPath, "utf-8");
  } catch {}

  // Idempotent: check if our block already exists
  if (content.includes(INSTRUCTIONS_MARKER)) {
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

function uninstall(copilotDir: string): void {
  // Remove MCP server entry
  const configPath = path.join(copilotDir, MCP_CONFIG_FILE);
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
  const instrPath = path.join(copilotDir, INSTRUCTIONS_FILE);
  try {
    let content = fs.readFileSync(instrPath, "utf-8");
    if (content.includes(INSTRUCTIONS_MARKER)) {
      content = content.replace(INSTRUCTIONS_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();
      fs.writeFileSync(instrPath, content ? content + "\n" : "", "utf-8");
      console.log(`✓ Removed memory recall instructions from ${instrPath}`);
    }
  } catch {}

  // Notify about residual data
  const dbPath = path.join(copilotDir, "memory.db");
  if (fs.existsSync(dbPath)) {
    console.log(`\n  Note: Memory database retained at ${dbPath}`);
    console.log(`  To remove all data: rm ${dbPath} ${dbPath}-wal ${dbPath}-shm`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== "setup" && command !== "uninstall") {
    console.log(`memory-mcp — Local memory management for Copilot CLI

Usage:
  memory-mcp setup       Configure Copilot CLI to use the memory MCP server
  memory-mcp uninstall   Remove memory MCP configuration from Copilot CLI

The MCP server itself is started automatically by Copilot CLI.`);
    process.exit(0);
  }

  const copilotDir = getCopilotDir();
  if (!fs.existsSync(copilotDir)) {
    fs.mkdirSync(copilotDir, { recursive: true });
  }

  if (command === "uninstall") {
    uninstall(copilotDir);
    console.log("\nDone. Restart Copilot CLI to apply changes.");
    return;
  }

  // --- setup ---
  console.log("Setting up memory-mcp for Copilot CLI...\n");

  const mcpResult = setupMcpConfig(copilotDir);
  console.log(mcpResult.changed ? `✓ ${mcpResult.message}` : `  ${mcpResult.message}`);

  const instrResult = setupInstructions(copilotDir);
  console.log(instrResult.changed ? `✓ ${instrResult.message}` : `  ${instrResult.message}`);

  console.log("\nDone! Restart Copilot CLI to activate memory search.");
  console.log("Create MEMORY.md or memory/*.md in your project to start storing memories.");
}

main();
