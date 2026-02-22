# memory-mcp

Local memory management MCP server for AI coding assistants (GitHub Copilot CLI, Claude Code).

Indexes `MEMORY.md` and `memory/*.md` files into a SQLite database with FTS5 full-text search, and exposes them as MCP tools that the host CLI calls automatically.

## Quick Start

```bash
# Install globally
npm install -g memory-mcp

# Configure for GitHub Copilot CLI
memory-mcp setup

# Or configure for Claude Code CLI
memory-mcp setup --claude
```

Next time you launch `copilot` or `claude`, the memory server starts automatically.

## Usage

Memory files live in a dot-directory under your home folder:

- **Copilot CLI**: `~/.copilot/` (default)
- **Claude Code**: `~/.claude/` (when using `--claude`)

```
~/.copilot/  (or ~/.claude/)
├── MEMORY.md              # Top-level memory file
└── memory/
    ├── decisions.md       # Architecture decisions
    ├── preferences.md     # User preferences
    └── context.md         # Project context
```

The host CLI will automatically search these files before answering questions about prior work, decisions, or preferences.

## Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Full-text search across all memory files |
| `memory_get` | Read specific lines from a memory file |
| `memory_status` | Show index status (file count, chunk count) |

## How it Works

1. Copilot CLI spawns the MCP server on startup (via stdio)
2. On each search, syncs `MEMORY.md`, `memory.md`, and `memory/` directory
3. Files are chunked using a sliding window (512 tokens, 64 token overlap)
4. Chunks are indexed in SQLite FTS5 for full-text search
5. Incremental sync via SHA256 hash — unchanged files are skipped

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_WORKSPACE` | `~/.copilot` | Root directory to scan for memory files |
| `MEMORY_DB_PATH` | `~/.copilot/memory.db` | Path to SQLite database |

## Uninstall

```bash
npm uninstall -g memory-mcp
```

The `preuninstall` hook automatically removes config and instructions for both Copilot CLI and Claude Code.
To remove config manually without uninstalling: `memory-mcp uninstall` or `memory-mcp uninstall --claude`

## Development

```bash
git clone https://github.com/XingxingLi2017/memory-mcp.git
cd memory-mcp
npm install -g .   # Installs dependencies, builds, and registers globally
memory-mcp setup
```

## License

MIT
