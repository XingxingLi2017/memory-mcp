# memory-mcp

Local memory management MCP server for AI coding assistants (GitHub Copilot CLI, Claude Code).

Indexes `MEMORY.md` and `memory/` files into a SQLite database with **hybrid search** — BM25 full-text search + vector semantic search — and exposes them as MCP tools that the host CLI calls automatically.

## Features

- **Hybrid search** — combines BM25 keyword matching with vector cosine similarity for best-of-both-worlds retrieval
- **CJK support** — jieba-wasm pre-segmentation enables Chinese/Japanese/Korean full-text search
- **Multi-format** — indexes `.md`, `.txt`, `.json`, `.jsonl`, `.yaml`, `.yml` files
- **Graceful degradation** — vector search requires optional native dependencies; falls back to FTS-only if unavailable
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

The embedding model ([embeddinggemma-300M](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF), ~328 MB) is downloaded automatically on first use to `~/.node-llama-cpp/models/`.

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
| `memory_search` | Hybrid search (BM25 + vector) across all memory files. Supports `query`, `maxResults`, `minScore`, `after`/`before` time filters |
| `memory_get` | Read specific lines from a memory file |
| `memory_write` | Save user-specific knowledge (preferences, decisions, context) to persistent memory. The more it learns, the less the user needs to explain |
| `memory_status` | Show index status: file/chunk counts, embedding coverage, health checks |

## How it Works

1. The host CLI spawns the MCP server on startup (via stdio)
2. On each search, syncs `MEMORY.md`, `memory.md`, and `memory/` directory
3. Files are chunked intelligently by format: markdown by headings, JSON by top-level keys/array elements, JSONL by line, YAML by top-level keys or `---` document separators
4. Chunks are indexed in **SQLite FTS5** (with jieba pre-segmentation for CJK text)
5. Chunks are embedded with **embeddinggemma-300M** (768-dim vectors) and stored in **sqlite-vec**
6. Search runs both FTS5 (BM25 ranking) and vector (cosine similarity) in parallel
7. Results are **min-max normalized** then merged with 50/50 weighting
8. Access-count boost gently promotes frequently retrieved chunks
9. Falls back to LIKE search if FTS5 is unavailable

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_WORKSPACE` | `~/.copilot` | Root directory to scan for memory files |
| `MEMORY_DB_PATH` | `~/.copilot/memory.db` | Path to SQLite database |
| `MEMORY_CHUNK_SIZE` | `512` | Chunk size in tokens for markdown splitting (64–4096). Changing triggers automatic index rebuild |
| `MEMORY_TOKEN_MAX` | `4096` | Default max tokens per search response (100–16384). Controls snippet length and result count |

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
