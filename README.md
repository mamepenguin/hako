# Hako

**[日本語版 README はこちら](README.ja.md)**

Hako is a personal knowledge store with hybrid search (FTS5 full-text + vector similarity). Save design decisions, research notes, bookmarks, conversation highlights — anything worth recalling later — and find them instantly across projects.

  * As an **MCP server**, give AI assistants like Claude Code long-term memory
  * As a **CLI tool**, integrate with other tools
  * As a **Node.js library**, embed in your own tools

Japanese-optimized. Single-file SQLite. All data stored locally when used standalone. No external servers.

## Quick Start (MCP)

Requires Node.js 20+.

Add to your Claude Code settings (`~/.claude.json`):

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

The database is created automatically at `~/.hako/hako.db` on first launch.

### Custom DB Path

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

## MCP Tools

| Tool | Description |
|------|-------------|
| `save` | Save an entry (title, content, tags, namespace, scope, priority) |
| `search` | Hybrid search (FTS5 + vector) with scope_mode filtering |
| `update` | Partial update of an existing entry by ID |
| `delete` | Delete an entry by ID |
| `prune` | Bulk-delete entries not accessed within N days |
| `stats` | Entry counts, DB size, per-namespace breakdown |
| `list_namespaces` | List all namespaces with counts and last update times |

## Core Concepts

### Namespace

Identifies which project an entry belongs to. Resolved automatically in the following order:

1. Explicit `namespace` parameter in tool call
2. `HAKO_PROJECT` environment variable
3. Git root of the current working directory (default)

### Scope and Priority

**Scope** — cross-project visibility:

- `default` — searchable only within the owning namespace
- `global` — searchable from all namespaces (e.g., general design principles)

**Priority** — affects deduplication and search ranking:

- `high` — explicitly saved entries. Deduplicated by semantic similarity (cosine >= 0.90). Search score x1.5
- `normal` — auto-captured entries (e.g., transcripts). Deduplicated by exact content match

**scope_mode** — search scope:

- `scoped_then_global` (default) — current namespace + global entries from other namespaces
- `scoped` — current namespace only
- `global_only` — global entries only
- `all` — unrestricted cross-namespace search

## Search Algorithm

1. Parallel search with FTS5 (trigram tokenizer) and vec0 (256-dim embedding), ranking the top 50 from each
2. Merged via Reciprocal Rank Fusion: `score = sum(1 / (k + rank + 1))`, k=60
3. Time decay applied: `0.5 ^ (days_old / 180)`, floor=0.1 (default)
4. Priority boost (high = x1.5), namespace boost (scoped_then_global match = x1.3)

Embedding model: [ruri-v3-30m-ONNX](https://huggingface.co/sirasagi62/ruri-v3-30m-ONNX) (256-dim, Japanese-optimized). Runs locally via Transformers.js.

## Transcript Ingestion

Save Claude Code or Codex session transcripts as searchable Q&A pairs. The `hako-mcp` command is the CLI provided by the MCP server package (`packages/hako-mcp`), which offers transcript ingestion in addition to serving the MCP server.

```bash
cat transcript.jsonl | hako-mcp save-transcript
hako-mcp save-transcript transcript.jsonl
hako-mcp save-transcript --format codex rollout.jsonl
hako-mcp save-transcript --namespace /path/to/project < transcript.jsonl
```

`--format` can be `auto`, `claude`, or `codex` (`auto` is the default). Saved with `source: "transcript"`, `priority: "normal"`. Exact-match deduplication prevents duplicates when re-importing the same file.

### Automatic Transcript Capture (hooks)

You can use assistant hooks to save each completed session automatically. The examples below use `npx -y hako-mcp`; if you are developing hako locally, replace it with `node /path/to/hako/packages/hako-mcp/dist/index.js` after running `pnpm --filter hako-mcp build`.

The hook scripts require `jq`. The Codex script also requires `sqlite3` so it can resolve `~/.codex/state_5.sqlite` to the current rollout JSONL.

#### Claude Code

Create the hook directory and write `~/.claude/hooks/hako-save-transcript.sh`:

```bash
mkdir -p ~/.claude/hooks
```

```bash
#!/bin/bash
set -euo pipefail

HAKO_MCP=(npx -y hako-mcp)
INPUT=$(cat)

TRANSCRIPT_PATH=$(printf "%s" "$INPUT" | jq -r '.transcript_path // empty')
NAMESPACE=$(printf "%s" "$INPUT" | jq -r '.cwd // .project_dir // empty')
[ -n "$NAMESPACE" ] || NAMESPACE="$PWD"

if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  "${HAKO_MCP[@]}" save-transcript \
    --format claude \
    --namespace "$NAMESPACE" \
    "$TRANSCRIPT_PATH"
fi
```

Make it executable and register it as a Stop hook:

```bash
chmod +x ~/.claude/hooks/hako-save-transcript.sh
```

Add the command to `~/.claude/settings.json`. If you already have hooks configured, merge this `Stop` entry into the existing `hooks` object.

```json
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "~/.claude/hooks/hako-save-transcript.sh"
      }
    ]
  }
}
```

#### Codex

Codex stores the actual transcript path as `threads.rollout_path` in `~/.codex/state_5.sqlite`. The hook below first uses any direct `transcript_path` / `rollout_path` in hook input, then falls back to resolving the current thread id, then finally to the latest thread for the current cwd.

Create the hook directory and write `~/.codex/hooks/hako-save-transcript.sh`:

```bash
mkdir -p ~/.codex/hooks
```

```bash
#!/bin/bash
set -euo pipefail

HAKO_MCP=(npx -y hako-mcp)
CODEX_STATE_DB="${CODEX_STATE_DB:-$HOME/.codex/state_5.sqlite}"
INPUT=$(cat)

json_get() {
  printf "%s" "$INPUT" | jq -r "$1 // empty" 2>/dev/null | head -n 1
}

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

NAMESPACE=$(json_get '.cwd // .project_dir // .workspace.current_dir // .workspace.cwd')
[ -n "$NAMESPACE" ] || NAMESPACE="$PWD"

FORMAT="auto"
TRANSCRIPT_PATH=$(json_get '.transcript_path')
if [ -z "$TRANSCRIPT_PATH" ]; then
  TRANSCRIPT_PATH=$(json_get '.rollout_path // .thread.rollout_path // .session.rollout_path')
  [ -z "$TRANSCRIPT_PATH" ] || FORMAT="codex"
fi

if [ -z "$TRANSCRIPT_PATH" ] && [ -f "$CODEX_STATE_DB" ]; then
  THREAD_ID=$(json_get '.thread_id // .threadId // .session_id // .sessionId // .id // .thread.id')
  case "$THREAD_ID" in
    ""|*[!0-9a-fA-F-]*) ;;
    *)
      TRANSCRIPT_PATH=$(sqlite3 "$CODEX_STATE_DB" \
        "select rollout_path from threads where id = '$(sql_escape "$THREAD_ID")' limit 1;" \
        2>/dev/null)
      [ -z "$TRANSCRIPT_PATH" ] || FORMAT="codex"
      ;;
  esac
fi

if [ -z "$TRANSCRIPT_PATH" ] && [ -f "$CODEX_STATE_DB" ]; then
  TRANSCRIPT_PATH=$(sqlite3 "$CODEX_STATE_DB" \
    "select rollout_path from threads where cwd = '$(sql_escape "$NAMESPACE")' order by updated_at_ms desc limit 1;" \
    2>/dev/null)
  [ -z "$TRANSCRIPT_PATH" ] || FORMAT="codex"
fi

if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  "${HAKO_MCP[@]}" save-transcript \
    --format "$FORMAT" \
    --namespace "$NAMESPACE" \
    "$TRANSCRIPT_PATH"
fi
```

Make it executable and register it as a Stop hook:

```bash
chmod +x ~/.codex/hooks/hako-save-transcript.sh
```

Add the command to `~/.codex/hooks.json`. If you already have hooks configured, merge this `Stop` entry into the existing `hooks` object.

```json
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "~/.codex/hooks/hako-save-transcript.sh"
      }
    ]
  }
}
```

Codex may ask you to approve the hook after changing `hooks.json` or the script.

## Configuring Claude Code to Use Hako

Installing the MCP server makes the tools available, but Claude Code won't use them automatically. You need to tell Claude **when** to save and search via your `CLAUDE.md` (project or global).

### Minimal Example

```markdown
# hako (long-term memory)

## Search
- Before starting work, search hako for prior decisions and context
- The current code shows *what* the code does; hako shows *why* it's that way

## Save
- Save important decisions, conclusions, and rationale after discussion
- Use scope "global" for knowledge reusable across projects
```

### Software Development Example

```markdown
# hako (long-term memory)

## Search
- Before modifying code, search hako for past decisions about that area
- Even if the user doesn't mention prior context, proactively search and share relevant findings

## Save
- Save design decisions with rationale ("chose X over Y because...")
- Save investigation results and root cause analyses
- Save architecture constraints and trade-offs
- Use scope "global" for language/framework-level learnings
```

### Research / Note-taking Example

```markdown
# hako (long-term memory)

## Search
- Search hako when the user asks about a topic previously discussed
- Cross-reference related entries using scope_mode "all"

## Save
- Save key findings, conclusions, and source references
- Save user preferences and recurring instructions
- Use scope "global" for general knowledge not tied to a specific project
```

## Packages

| Package | Description |
|---------|-------------|
| [hako-mcp](packages/hako-mcp) | MCP server (AI assistant integration) |
| [hako-db](packages/hako-db) | Core library (embed in any Node.js backend) |
| [hako-cli](packages/hako-cli) | CLI tool |
| [hako-sync](packages/hako-sync) | Multi-machine sync via Git + JSONL oplog |

Dependency direction: hako-cli -> hako-sync -> hako-db, hako-mcp -> hako-db

## CLI

```bash
hako add --title "Meeting notes" --content "Discussed Q3 roadmap" --tags "meeting,roadmap"
hako web https://example.com --tags "reference"
hako search "roadmap planning"
hako list --since 2025-01-01 --limit 50
hako show V1StGXR8_Z5jdHi
hako delete V1StGXR8_Z5jdHi
hako stats
hako --db ~/work/hako.db search "meeting"
```

## Library

```typescript
import { Hako } from 'hako-db'

const hako = new Hako()                              // ~/.hako/hako.db
const { id, status } = await hako.save({
  title: 'Design doc',
  content: 'Architecture overview...',
  source: 'notes',
  tags: 'architecture,design',
})
const results = await hako.search('architecture', { limit: 10 })
hako.close()
```

## Multi-Machine Sync

Sync Hako's DB across multiple machines. Data is synchronized via a Git repository, with each machine maintaining its own JSONL oplog — zero Git conflicts. Requires Git.

### First Machine

Create a private repo on GitHub (or similar), then place `config.toml` in the same directory as the DB (default: `~/.hako`).

```toml
# ~/.hako/config.toml
[sync]
# Local path for the sync Git repo
repo = "~/.hako/sync"

# Unique name for this machine (must not overlap with other machines)
machine_id = "macbook"

# Entries older than this are skipped on import
import_max_age_days = 90

# Sources that are neither pushed nor imported (optional)
exclude_sources = ["transcript"]
```

`repo` expands `~`; a relative path is resolved from the directory of `config.toml`. Entries skipped by `exclude_sources` are not imported later if you remove the source from the list, until the machine that pushed them compacts its oplog.

The init command creates the local repository and initializes the machine directory. Then set up the remote and perform the first push.

```bash
hako sync init
git -C ~/.hako/sync remote add origin git@github.com:user/hako-sync.git
hako sync push
```

### Additional Machines

Clone the remote repo, then create a `config.toml` with a different `machine_id`.

```bash
git clone git@github.com:user/hako-sync.git ~/.hako/sync
```

```toml
# ~/.hako/config.toml
[sync]
repo = "~/.hako/sync"
machine_id = "mac-mini"         # Different from the first machine
import_max_age_days = 90
```

```bash
hako sync init                  # Create this machine's directory
hako sync pull                  # Import data from other machines
```

### Daily Usage

```bash
hako sync pull     # Import remote changes
hako sync push     # Export local changes -> Git commit & push
hako sync status   # Show sync status
```

### Claude Code Integration (hooks)

Set up Claude Code hooks to auto-sync at session start/end.

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "npx -y hako-cli sync pull" }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y hako-cli sync pull && npx -y hako-cli sync push"
          }
        ]
      }
    ]
  }
}
```

If you have the CLI installed globally (`npm install -g hako-cli`), you can use `hako sync pull` directly instead.

## Data Locations

| Path | Purpose |
|------|---------|
| `~/.hako/hako.db` | Main database (default) |
| `~/.hako/embedding_cache.db` | Embedding cache |
| `~/.hako/config.toml` | User config (optional) |
| `~/.hako/sync-state.json` | Sync state (local only) |
| `~/.cache/huggingface/hub/` | ONNX model cache |

DB path priority: `--db` flag > `HAKO_DB` env > `~/.hako/hako.db`

## Configuration

Resolved per-DB: `<db-dir>/config.toml` > `~/.hako/config.toml` > built-in defaults:

```toml
[search]
# Reciprocal Rank Fusion parameter.
# Higher values reduce the impact of rank differences. Usually no need to change.
rrf_k = 60

# Number of days until time decay halves the score.
# Lower values make older entries less likely to appear.
time_decay_half_life_days = 180.0

# Floor for time decay.
# No matter how old, the score won't drop below this ratio.
time_decay_floor = 0.1

[embedding]
# Embedding model for vector search.
# ruri-v3-30m-ONNX is a lightweight model optimized for Japanese.
model = "sirasagi62/ruri-v3-30m-ONNX"

# Max characters of content used for embedding generation.
# Title is always used in full; content is truncated to this length.
# Increasing this significantly won't improve accuracy due to model input length constraints.
max_content_chars = 500

[sync]
repo = "~/.hako/sync"
machine_id = "macbook"
import_max_age_days = 90
exclude_sources = []
```

## Development

```bash
pnpm install
pnpm --filter hako-db test       # Library tests
pnpm --filter hako-mcp test      # MCP server tests
pnpm --filter hako-sync test     # Sync tests
pnpm build                       # Build all packages
```

## Tech Stack

- **DB**: better-sqlite3 + sqlite-vec + FTS5 trigram
- **ID**: nanoid
- **Embedding**: @huggingface/transformers (ONNX)
- **MCP**: @modelcontextprotocol/sdk (stdio)
- **Sync**: Git + JSONL oplog
- **Build**: tsup (ESM), vitest, pnpm workspaces

## License

MIT
