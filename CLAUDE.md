# Hako

TypeScript/Node.js data store with hybrid search (FTS5 + vector).
Japanese text optimized. SQLite single-file DB.

## Quick Reference

```bash
pnpm install                    # Install dependencies
pnpm --filter hako-db test      # Run library tests (84 tests)
pnpm --filter hako-mcp test     # Run MCP server tests (7 tests)
pnpm --filter hako-sync test    # Run sync tests (24 tests)
pnpm --filter hako-db build     # Build library
pnpm --filter hako-cli build    # Build CLI
pnpm --filter hako-mcp build    # Build MCP server
pnpm --filter hako-sync build   # Build sync package
```

## Architecture

Monorepo with 4 packages:

- **packages/hako-db** — Library. `import { Hako } from 'hako-db'` for use from other Node.js backends.
- **packages/hako-cli** — CLI. `hako add`, `hako search`, `hako update`, `hako export`, `hako web <url>`, `hako sync push/pull`, etc.
- **packages/hako-mcp** — MCP server. `hako-mcp serve` for Claude Code integration, `hako-mcp save-transcript` for session capture.
- **packages/hako-sync** — Multi-machine sync via Git + JSONL oplog.

Dependency direction: hako-cli → hako-sync → hako-db, hako-mcp → hako-db (never reverse).

## Key Files (packages/hako-db/src/)

| File | Responsibility |
|------|---------------|
| `index.ts` | `Hako` class — public API: save, search, update, exportEntries, getUpdatedSince, etc. |
| `types.ts` | All TypeScript interfaces (`Entry`, `SearchResult`, `SaveInput`, etc.) |
| `config.ts` | Config resolution per-DB (`resolveConfigPath`, `resolveDbPath`, `resolveCachePath`), merges with defaults |
| `db.ts` | SQLite schema (entries + FTS5 trigram + vec0), CRUD operations, Nano ID migration |
| `search.ts` | Hybrid search: FTS5 + vec0 → RRF fusion → time decay |
| `save.ts` | Validation + deduplication (URL, exact, semantic) + capacity enforcement |
| `embeddings.ts` | Transformers.js wrapper for ruri-v3-30m ONNX model |
| `embedding-cache.ts` | SHA256-keyed embedding cache in separate SQLite DB |
| `fetchers/web.ts` | fetch + cheerio for HTML title/content extraction |

## Key Files (packages/hako-sync/src/)

| File | Responsibility |
|------|---------------|
| `push.ts` | Diff detection (current IDs vs last push) → op:add/op:delete → auto-compaction → Git commit & push |
| `pull.ts` | Git pull → read other machines' oplog (epoch-based compaction detection) → delete-wins → age filter → import |
| `oplog.ts` | JSONL oplog read/write/rewrite, machine listing, epoch tracking, input validation |
| `git.ts` | Git operations (pull, add/commit/push, init) via `child_process.execFile` |
| `state.ts` | Sync state management (`sync-state.json` — outside Git repo) |
| `config.ts` | Reads `[sync]` section from config.toml |

## Tech Stack

- **Runtime**: Node.js 20+
- **DB**: better-sqlite3 + sqlite-vec (vec0 virtual table) + FTS5 trigram
- **ID**: nanoid (globally unique TEXT primary keys for sync)
- **Embedding**: @huggingface/transformers with `sirasagi62/ruri-v3-30m-ONNX` (256-dim, Japanese)
- **HTML parsing**: cheerio
- **CLI**: commander
- **Test**: vitest (mocked embeddings — no model download needed for tests)
- **Build**: tsup (ESM only)
- **Package manager**: pnpm workspaces

## Data Locations

- `~/.hako/hako.db` — Main database (default)
- `~/.hako/embedding_cache.db` — Embedding cache (follows DB directory)
- `~/.hako/config.toml` — User config (optional, global fallback)
- `~/.hako/sync-state.json` — Sync state (local only, not in Git repo)
- `~/.cache/huggingface/hub/` — Downloaded ONNX model (managed by Transformers.js)

DB path is configurable: `--db` flag > `HAKO_DB` env > `~/.hako/hako.db`. Embedding cache and config.toml are resolved relative to the DB directory first, falling back to `~/.hako/`.

## DB Schema

3 tables, all in `hako.db`:

- **entries** — Main table (id TEXT PK via nanoid, source, title, content, url, namespace, scope, priority, tags, happened_at, created_at, updated_at, accessed_at, access_count)
- **entries_fts** — FTS5 virtual table with trigram tokenizer (title, content, tags). Uses `content_rowid='rowid'` (SQLite implicit rowid)
- **entries_vec** — vec0 virtual table (entry_id TEXT PK, embedding float[256])

FTS5 and vec0 are kept in sync via SQLite triggers (INSERT/UPDATE/DELETE).

## Important Implementation Notes

- Entry IDs are Nano ID strings (TEXT PRIMARY KEY), not integers
- vec0 entry_id is TEXT PRIMARY KEY — no BigInt conversion needed
- FTS5 uses `content_rowid='rowid'` (implicit rowid), not `content_rowid='id'` since id is TEXT
- FTS5 triggers use `new.rowid` / `old.rowid`, not `new.id` / `old.id`
- `SaveInput.id` is optional: if provided (e.g. sync import), that ID is used; if already exists, entry is skipped
- Existing INTEGER-id databases are auto-migrated to Nano ID on first open
- `Hako.update()` is a partial update: only specified fields change, `undefined` = no change, `null` = clear nullable fields (`content`, `url`)
- `updateEntry` wraps read + update in a SQLite transaction; re-embeds only when title or content changes
- Embedding tests mock `@huggingface/transformers` to avoid model download
- `vi.mock` factory functions cannot reference top-level variables (use local `const` inside factory)
- better-sqlite3 native module must be built (`node-gyp rebuild` if bindings not found)

## Search Algorithm

1. Query → FTS5 search (top 50) + vector search via vec0 (top 50)
2. Scope filtering: `scope_mode` controls namespace/scope visibility (scoped, global_only, scoped_then_global, all)
3. Reciprocal Rank Fusion: `score = Σ 1/(k + rank + 1)`, default k=60
4. Time decay: `decay = 0.5^(days_old / 180)`, floor=0.1
5. Priority boost: `high` priority entries get ×1.5 score
6. Namespace boost: matching namespace in `scoped_then_global` mode gets ×1.3
7. Final score = RRF × decay × priority_boost × namespace_boost, sorted descending

## Deduplication Strategy

- **URL entries**: URL match → UPDATE existing
- **priority=normal** (e.g. transcript): namespace + title + content exact match → SKIP
- **priority=high** (e.g. explicit save): namespace-scoped cosine similarity ≥ 0.90 → UPDATE (access_count++)
- **ID-based (sync import)**: `SaveInput.id` provided and already exists → SKIP

## Multi-Machine Sync (hako-sync)

Oplog-based sync via Git repository. Each machine appends operations to its own JSONL file (no conflicts).

### Sync Model

- **Oplog format**: `{"op":"add","id":"...","ts":"...","entry":{...}}`, `{"op":"delete","id":"...","ts":"..."}`, and `{"op":"update","id":"...","ts":"...","entry":{...}}`
- **Per-machine files**: `<repo>/<machine_id>/ops.jsonl` (append-only, compacted periodically)
- **Compaction epoch**: `<repo>/<machine_id>/ops.epoch` (counter incremented on each compaction)
- **delete-wins** (for `op:add`): If any machine has a delete for an ID, that entry is deleted everywhere
- **update-wins** (for `op:update`): `op:update` unconditionally wins over `op:delete` — if any machine updates an entry, it survives
- **Embedding excluded**: Not in JSONL. Recomputed locally via embedding cache

### Sync Flow

```
push: diff current DB IDs vs last_push_ids → op:add/op:delete + detect updated_at > last_push_at → op:update → auto-compact if threshold exceeded → git commit & push
pull: git pull → check epoch per machine (reset offset if compacted → upsert mode for op:add) → read ops from offset → apply deletes → import adds → apply updates (with age filter)
```

### Auto-Compaction

- **Trigger**: push 後に自マシンの ops.jsonl の行数から同期対象のエントリ数を引いた値（無駄な ops）が `compaction_threshold`（デフォルト 2000）以上になったら自動発火。add だけの oplog は縮まないので数えない
- **動作**: 現在のDB全エントリを op:add として ops.jsonl を書き直し（atomic write via tmp+rename）、`ops.epoch` をインクリメント
- **pull 側検知**: 保存済み epoch と現在の epoch を比較。不一致なら offset=0 から再読み込み（既存IDはskipで冪等）
- **制約**: compaction で delete ops は失われる。各マシンが独立して prune する運用が前提
- **効果**: prune で削除が発生した後に compaction すると、add+delete ペアが消えてファイルサイズが大幅に縮小

### Prune Compatibility

- hako-db prunes freely (no constraint from sync)
- hako-sync filters old entries on import via `import_max_age_days`
- Pruned entries generate op:delete on next push
- Recommend setting `import_max_age_days` = prune days

### Config

```toml
[sync]
repo = "~/.hako/sync"           # Git repo path (user does git clone)
machine_id = "macbook"           # This machine's identifier
import_max_age_days = 90         # Skip entries older than this on import
compaction_threshold = 2000      # Auto-compact when redundant ops reach this count
exclude_sources = ["transcript"] # Sources neither pushed nor imported (default: none)
```

`repo` は `~` を展開し、相対パスは config.toml のあるディレクトリを基準に解決する（hook はプロジェクトを cwd にして動くため）。

### CLI

```bash
hako sync init                   # Initialize sync repo
hako sync push                   # Push local changes
hako sync pull                   # Pull remote changes
hako sync status                 # Show sync status
```

### Security

- `machine_id` validated: alphanumeric + hyphen + underscore only (path traversal prevention)
- Oplog entries validated on read (schema check before import)
- scope/priority validated on import (unknown values default to "default"/"normal")
- Symlinks excluded from machine listing

## MCP Server (hako-mcp)

Tools: `save`, `search`, `update`, `delete`, `prune`, `stats`, `list_namespaces`

CLI: `hako-mcp serve` (stdio MCP), `hako-mcp save-transcript` (JSONL → Q&A chunks)

Settings.json integration:
```json
{
  "mcpServers": {
    "hako": {
      "command": "<path-to>/hako-mcp",
      "args": ["serve"]
    }
  }
}
```

## Migration from engram

```bash
npx tsx packages/hako-mcp/src/migrate-engram.ts --dry-run          # Preview
npx tsx packages/hako-mcp/src/migrate-engram.ts                    # Import from JSONL
npx tsx packages/hako-mcp/src/migrate-engram.ts --source db        # Import from memory.db
```

Field mapping: content→title+content, project→namespace, memory_type→priority, scope→scope
