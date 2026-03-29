# Hako

Hybrid search data store for personal knowledge management. Combines SQLite FTS5 full-text search with vector similarity search (sqlite-vec) and Reciprocal Rank Fusion. Optimized for Japanese text.

Single-file SQLite database. No external servers required.

## Requirements

- Node.js >= 20
- pnpm

## Setup

```bash
git clone <repo-url> && cd hako
pnpm install
pnpm build
```

## Packages

| Package | Description |
|---------|-------------|
| [hako-db](packages/hako-db) | Core library - embed in any Node.js backend |
| [hako-cli](packages/hako-cli) | CLI tool |
| [hako-mcp](packages/hako-mcp) | MCP server for Claude Code integration |

## CLI Usage

```bash
# Add an entry
hako add --title "Meeting notes" --content "Discussed Q3 roadmap" --source work --tags "meeting,roadmap"

# Fetch and save a web page
hako web https://example.com --tags "reference"

# Hybrid search (FTS5 + vector)
hako search "roadmap planning"
hako search "roadmap" --source work --limit 5

# List entries
hako list --since 2025-01-01 --until 2025-03-31
hako list --source web --limit 50

# Show / delete
hako show 42
hako delete 42

# Stats
hako stats
hako sources

# Use a different database
hako --db ~/work/hako.db search "meeting"
```

## Library Usage

```typescript
import { Hako } from 'hako-db'

// Default: ~/.hako/hako.db
const hako = new Hako()

// Custom database path
const workHako = new Hako({ dbPath: '/path/to/work/hako.db' })

// Save
const { id, status } = await hako.save({
  title: 'Design doc',
  content: 'Architecture overview...',
  source: 'notes',
  tags: 'architecture,design',
})

// Hybrid search
const results = await hako.search('architecture', { limit: 10 })

// CRUD
const entry = hako.get(id)
const entries = hako.list({ source: 'notes', limit: 20 })
hako.delete(id)

// Cleanup
hako.close()
```

## Search Algorithm

1. Query runs in parallel against FTS5 (trigram tokenizer) and vec0 (256-dim embedding), each returning top 50 candidates
2. Reciprocal Rank Fusion merges results: `score = sum(1 / (k + rank + 1))`, k=60
3. Time decay applied: `decay = 0.5 ^ (days_old / 180)`, floor=0.1
4. Final score = RRF * decay, sorted descending

Embedding model: [ruri-v3-30m-ONNX](https://huggingface.co/sirasagi62/ruri-v3-30m-ONNX) (256-dim, Japanese-optimized, runs locally via Transformers.js)

## MCP Server

hako-mcp is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes hako as a tool for AI assistants like Claude Code. Runs over stdio.

### Setup

Add to your Claude Code config (`~/.claude.json` or project `.claude.json`):

```json
{
  "mcpServers": {
    "hako": {
      "command": "npx",
      "args": ["-y", "hako-mcp", "serve"]
    }
  }
}
```

For local development builds:

```json
{
  "mcpServers": {
    "hako": {
      "command": "node",
      "args": ["/path/to/packages/hako-mcp/dist/index.js", "serve"]
    }
  }
}
```

To use a custom database path, add `--db` or set `HAKO_DB` via the `env` field:

```json
{
  "mcpServers": {
    "hako": {
      "command": "npx",
      "args": ["-y", "hako-mcp", "serve"],
      "env": {
        "HAKO_DB": "/path/to/custom/hako.db"
      }
    }
  }
}
```

### Available Tools

| Tool | Description |
|------|-------------|
| `save` | Save an entry with title, content, tags, namespace, scope, priority |
| `search` | Hybrid search (FTS5 + vector) with scope_mode filtering |
| `delete` | Delete an entry by ID |
| `prune` | Delete entries not accessed within N days |
| `stats` | Entry statistics, DB size, namespace breakdown |
| `list_namespaces` | List all namespaces with counts and last update times |

### Namespace Resolution

Namespace identifies which project an entry belongs to. Resolved automatically:

1. Explicit `namespace` parameter in tool call
2. `HAKO_PROJECT` environment variable
3. Git root of the current working directory (default)

### Scope and Priority

**Scope** controls cross-project visibility:

- `default` — project-specific entries
- `global` — visible across all namespaces (e.g., general design principles)

**Priority** affects deduplication and search ranking:

- `high` — explicitly saved entries. Deduplicated by semantic similarity (cosine >= 0.90). Boosted x1.5 in search
- `normal` — auto-captured entries (e.g., transcripts). Deduplicated by exact content match

**scope_mode** controls search behavior:

- `scoped_then_global` (default) — this namespace + global entries from other namespaces
- `scoped` — only this namespace
- `global_only` — only global-scoped entries
- `all` — unrestricted cross-namespace search

### Transcript Ingestion

Save Claude Code session transcripts as searchable Q&A chunks:

```bash
# From stdin
cat transcript.jsonl | hako-mcp save-transcript

# From file
hako-mcp save-transcript transcript.jsonl

# With explicit namespace
hako-mcp save-transcript --namespace /path/to/project < transcript.jsonl
```

Transcripts are saved with `source: "transcript"`, `priority: "normal"`, and exact-match deduplication to prevent re-import duplicates.

## Data Locations

| Path | Purpose |
|------|---------|
| `~/.hako/hako.db` | Main database (default) |
| `~/.hako/embedding_cache.db` | Embedding cache (follows DB directory) |
| `~/.hako/config.toml` | User config (optional, global fallback) |
| `~/.cache/huggingface/hub/` | ONNX model cache |

## Multiple Databases

Use `--db` flag or `HAKO_DB` environment variable to switch databases. The embedding cache and `config.toml` are automatically resolved relative to the DB directory first, falling back to `~/.hako/`.

Priority: `--db` flag > `HAKO_DB` env > `~/.hako/hako.db`

```bash
# Per-command
hako --db ~/work/hako.db add --title "Work note" --source work

# Environment variable
export HAKO_DB=~/work/hako.db
hako search "meeting"

# Per-project with direnv
echo 'export HAKO_DB=$PWD/.hako/hako.db' > .envrc
direnv allow
```

## Configuration

Config is resolved per-DB: `<db-dir>/config.toml` > `~/.hako/config.toml` > built-in defaults:

```toml
[search]
rrf_k = 60
time_decay_half_life_days = 180.0
time_decay_floor = 0.1

[embedding]
model = "sirasagi62/ruri-v3-30m-ONNX"
max_content_chars = 500
```

## Development

```bash
pnpm --filter hako-db test       # Run tests (54 tests, mocked embeddings)
pnpm --filter hako-db test:watch # Watch mode
pnpm --filter hako-db build      # Build library
pnpm --filter hako-cli build     # Build CLI
pnpm --filter hako-mcp test      # Run MCP server tests
pnpm --filter hako-mcp build     # Build MCP server
```

## Tech Stack

- **DB**: better-sqlite3 + sqlite-vec + FTS5 trigram
- **Embedding**: @huggingface/transformers (ONNX runtime)
- **HTML**: cheerio
- **MCP**: @modelcontextprotocol/sdk (stdio transport)
- **CLI**: commander
- **Test**: vitest
- **Build**: tsup (ESM only)

## License

MIT
