# memory-mcp

Local memory management MCP server for AI coding assistants (GitHub Copilot CLI, Claude Code).

Indexes `MEMORY.md` and `memory/` files into a SQLite database with **hybrid search** — BM25 full-text search + vector semantic search — and exposes them as MCP tools that the host CLI calls automatically.

## Features

- **Hybrid search** — combines BM25 keyword matching with vector cosine similarity for best-of-both-worlds retrieval
- **Fact + Evidence architecture** — `memory_write` stores compressed facts with linked evidence for traceability
- **Semantic dedup** — exact string + vector similarity checks prevent duplicate memories
- **Memory lifecycle** — `memory_forget` and `memory_update` with semantic matching (string match → vector fallback)
- **CJK support** — jieba-wasm pre-segmentation enables Chinese/Japanese/Korean full-text search
- **Multi-format** — indexes `.md`, `.txt`, `.json`, `.jsonl`, `.yaml`, `.yml` files
- **Graceful degradation** — vector search requires optional native dependencies; falls back to FTS-only if unavailable
- **Session transcript indexing** — automatically indexes Copilot CLI (`events.jsonl`) and Claude Code (`~/.claude/projects/`) conversation history for cross-session search
- **Incremental sync** — SHA256-based change detection; unchanged files are skipped
- **Embedding cache** — content-hash keyed cache avoids re-embedding unchanged text across file moves/renames
- **Access tracking** — frequently accessed chunks get a gentle score boost

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

### Vector Search (Optional)

Vector search uses [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) and [sqlite-vec](https://github.com/asg017/sqlite-vec) as optional dependencies. On most platforms (Linux x64/arm64, macOS x64/arm64, Windows x64) these install automatically via prebuilt binaries.

If they fail to install (e.g. missing build tools), the server still works with FTS5-only search — no manual intervention needed.

The default embedding model ([embeddinggemma-300M](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF), ~328 MB) is downloaded automatically on first use to `~/.node-llama-cpp/models/`. You can swap it via config: `memory-mcp config set model /path/to/model.gguf` (see [Configuration](#configuration)).

### Windows: Known Issue with Prebuilt Binaries

The prebuilt `@node-llama-cpp/win-x64` binary (compiled with MinGW64) has a bug where `getMathCores()` returns 0 in certain VM environments (e.g. Hyper-V), causing single-threaded inference (~28x slower than expected). This makes embedding generation too slow to complete within a typical MCP session.

**Fix:** Build node-llama-cpp from source using MSVC instead of the prebuilt binary:

```bash
npx --no node-llama-cpp source download
npx --no node-llama-cpp source build
```

This compiles with the correct Windows API path and restores full multi-threaded performance. See [#1](https://github.com/XingxingLi2017/memory-mcp/issues/1) for details.

## Usage

All memory data lives in a shared directory under your home folder:

```
~/.memory-mcp-workdir/
├── memory-mcp.json              # Configuration file (profiles, settings)
└── default/                     # Default profile workspace
    ├── memory.db                # SQLite database (index + vectors)
    ├── MEMORY.md                # Top-level memory file
    └── memory/
        ├── decisions.md         # Architecture decisions
        ├── preferences.md       # User preferences
        └── evidence/            # Auto-generated evidence files
```

The host CLI will automatically search these files before answering questions about prior work, decisions, or preferences.

## Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid search (BM25 + vector) across all memory files. Supports `query`, `maxResults`, `minScore`, `after`/`before` time filters |
| `memory_get` | Read specific lines from a memory file |
| `memory_write` | Save a fact with optional evidence. The system auto-chunks evidence and links it to the fact via `[ref:evidence/...]` for traceability |
| `memory_forget` | Remove a memory entry by semantic matching. Cleans up linked evidence files |
| `memory_update` | Replace a memory entry with new content and optional new evidence. Cleans up old evidence |
| `memory_status` | Show index status: file/chunk counts, embedding coverage, health checks |

## How it Works

1. The host CLI spawns the MCP server on startup (via stdio)
2. On each search, syncs `MEMORY.md`, `memory.md`, and `memory/` directory
3. Files are chunked intelligently by format: markdown by headings, JSON by top-level keys/array elements, JSONL by line, YAML by top-level keys or `---` document separators
4. Chunks are indexed in **SQLite FTS5** (with jieba pre-segmentation for CJK text)
5. Chunks are embedded with **embeddinggemma-300M** (768-dim vectors) and stored in **sqlite-vec**
6. Search runs both FTS5 (BM25 ranking) and vector (cosine similarity) in parallel
7. Results are **min-max normalized** then merged with configurable FTS/vector weighting (default 50/50, see `ftsWeight`)
8. Access-count boost gently promotes frequently retrieved chunks
9. Top-level `MEMORY.md` results receive a score boost (×1.3) for long-term memory priority
10. Falls back to LIKE search if FTS5 is unavailable

## Configuration

All settings have sensible defaults and work out of the box. To customize, use the config command:

```bash
# Show current config (uses default profile)
memory-mcp config

# Show config for a specific profile
memory-mcp config --profile learning show

# Set a value (on default profile)
memory-mcp config set chunkSize 1024
memory-mcp config set extraDirs /data/obsidian-vault,/data/notes
memory-mcp config set model /path/to/local-model.gguf
memory-mcp config set ftsWeight 0.7
memory-mcp config set minScore 0.05

# Set a value on a specific profile
memory-mcp config --profile learning set chunkSize 256

# Reset to defaults (all profiles and settings)
memory-mcp config reset

# Reset a single profile to defaults (keeps the profile entry)
memory-mcp config --profile learning reset

# Show config file path
memory-mcp config path
```

Config is stored in `~/.memory-mcp-workdir/memory-mcp.json` (cross-platform: `$HOME` on Linux/macOS, `%USERPROFILE%` on Windows). Changes take effect on next server restart.

### Example Config File

```json
{
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "chunkSize": 512,
      "tokenMax": 4096,
      "ftsWeight": 0.5,
      "minScore": 0.01,
      "maxResults": 10,
      "sessionDays": 30,
      "sessionMax": -1,
      "sessionDirs": [
        { "dir": "/home/user/.copilot/session-state", "kind": "copilot" },
        { "dir": "/home/user/.claude/projects", "kind": "claude" }
      ]
    },
    "learning": {
      "extraDirs": ["/path/to/obsidian-vault"],
      "sessionDirs": [],
      "model": "/path/to/local-model.gguf"
    }
  }
}
```

> **Note:** Use absolute paths in the config file. `~` is not expanded by Node.js.

Fields omitted from a profile inherit built-in defaults. Each profile workspace is at `~/.memory-mcp-workdir/<profile-name>/` unless overridden.

### Config Keys

| Key | Default | Description |
|-----|---------|-------------|
| `workspace` | `~/.memory-mcp-workdir/<profile>` | Root directory for memory files and database |
| `dbPath` | `<workspace>/memory.db` | Path to SQLite database |
| `chunkSize` | `512` | Chunk size in tokens for markdown splitting (64–4096). Changing triggers automatic index rebuild |
| `tokenMax` | `4096` | Default max tokens per search response (100–16384). Controls snippet length and result count |
| `sessionDays` | `30` | Only index session transcripts from the last N days (0 = index all) |
| `sessionMax` | `-1` | Max number of sessions to index, newest first (-1 = no limit, 0 = disable session indexing) |
| `sessionDirs` | `[copilot, claude]` | Session transcript sources. Default: `~/.copilot/session-state` (copilot) + `~/.claude/projects` (claude). Set to override entirely. JSON format: `[{"dir":"/path","kind":"copilot"}]` |
| `extraDirs` | `[]` | Extra directories to index (e.g. Obsidian vault). Files are stored with `extra:<dirname>/` prefix |
| `model` | `hf:ggml-org/embeddinggemma-300M-GGUF/...` | Embedding model. Accepts a HuggingFace URI (`hf:org/repo/file.gguf`) for auto-download, or a local file path (`/path/to/model.gguf`) |
| `ftsWeight` | `0.5` | FTS weight in hybrid search (0–1). Vector weight = 1 − ftsWeight. Higher values favor keyword matching; lower values favor semantic similarity |
| `minScore` | `0.01` | Minimum relevance score threshold (0–1). Results below this are dropped |
| `maxResults` | `10` | Maximum number of search results returned (1–100) |

### Profiles

Profiles let you maintain isolated memory spaces for different use cases (e.g. coding vs learning). Each profile has its own workspace, database, and memory files.

```bash
# Create profiles
memory-mcp config profile create coding
memory-mcp config profile create learning

# Configure each profile independently
memory-mcp config --profile coding set sessionDirs '[{"dir":"/home/user/.copilot/session-state","kind":"copilot"},{"dir":"/home/user/.claude/projects","kind":"claude"}]'
memory-mcp config --profile learning set extraDirs /path/to/obsidian-vault
memory-mcp config --profile learning set sessionDirs '[]'

# Set which profile is used by default (e.g. by the MCP server)
memory-mcp config profile default coding

# List profiles
memory-mcp config profile list

# Use a specific profile with the CLI
memory-mcp-cli search "query" --profile learning

# Use a specific profile with the MCP server
# In your MCP host config (e.g. .claude.json):
#   "args": ["dist/server.js", "--profile", "coding"]
# Or via environment variable:
#   "env": { "MEMORY_MCP_PROFILE": "coding" }
```

Each profile workspace lives at `~/.memory-mcp-workdir/<profile-name>/` by default. Deleting a profile removes its config entry but **retains the workspace directory** on disk — remove it manually if no longer needed.

## CLI

A standalone CLI is available for non-MCP integrations (e.g. calling from scripts or other agents):

```bash
# Search
memory-mcp-cli search "query" --max-results 10 --min-score 0.1

# Index status
memory-mcp-cli status
```

All config keys can be temporarily overridden via CLI flags:

```bash
memory-mcp-cli search "query" --workspace /tmp/alt-memory
memory-mcp-cli status --chunk-size 1024 --session-days 7
```

Or run directly: `node dist/cli.js search "query"`

Output is JSON to stdout, suitable for piping into other tools.

## Upgrading

When upgrading from a version that used `~/.copilot/` or `~/.claude/` as the workspace, `memory-mcp setup` (or the MCP server on first start) will automatically copy your memory files to `~/.memory-mcp-workdir/default/`. Original files are preserved — remove them manually when ready.

**Config migration:** If your config file uses the legacy flat format (no `profiles` section), it is automatically treated as the `default` profile. On the first operation that creates profiles (e.g. `config profile create`), legacy `workspace` and `dbPath` fields are migrated into `profiles.default` so custom paths are preserved.

**Breaking changes:**

- All `MEMORY_*` environment variables have been removed. Configuration is now managed entirely through the config file (`~/.memory-mcp-workdir/memory-mcp.json`). Use `memory-mcp config set <key> <value>` to migrate your settings.
- The `--config` CLI flag has been removed. Use `--profile` to select a named profile instead.

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
