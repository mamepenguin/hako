# Hako

TypeScript/Node.js data store with hybrid search (FTS5 + vector).
Japanese text optimized. SQLite single-file DB.

## Quick Reference

```bash
pnpm install                    # Install dependencies
pnpm --filter hako-db test      # Run library tests (69 tests)
pnpm --filter hako-mcp test     # Run MCP server tests (7 tests)
pnpm --filter hako-db build     # Build library
pnpm --filter hako-cli build    # Build CLI
pnpm --filter hako-mcp build    # Build MCP server
```

## Architecture

Monorepo with 3 packages:

- **packages/hako-db** — Library. `import { Hako } from 'hako-db'` for use from other Node.js backends.
- **packages/hako-cli** — CLI. `hako add`, `hako search`, `hako web <url>`, etc.
- **packages/hako-mcp** — MCP server. `hako-mcp serve` for Claude Code integration, `hako-mcp save-transcript` for session capture.

Dependency direction: hako-cli → hako-db, hako-mcp → hako-db (never reverse).

## Key Files (packages/hako-db/src/)

| File | Responsibility |
|------|---------------|
| `index.ts` | `Hako` class — public API wrapping all modules |
| `types.ts` | All TypeScript interfaces (`Entry`, `SearchResult`, `SaveInput`, etc.) |
| `config.ts` | Config resolution per-DB (`resolveConfigPath`, `resolveDbPath`, `resolveCachePath`), merges with defaults |
| `db.ts` | SQLite schema (entries + FTS5 trigram + vec0), CRUD operations |
| `search.ts` | Hybrid search: FTS5 + vec0 → RRF fusion → time decay |
| `save.ts` | Validation + deduplication (URL, exact, semantic) + capacity enforcement |
| `embeddings.ts` | Transformers.js wrapper for ruri-v3-30m ONNX model |
| `embedding-cache.ts` | SHA256-keyed embedding cache in separate SQLite DB |
| `fetchers/web.ts` | fetch + cheerio for HTML title/content extraction |

## Tech Stack

- **Runtime**: Node.js 20+
- **DB**: better-sqlite3 + sqlite-vec (vec0 virtual table) + FTS5 trigram
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
- `~/.cache/huggingface/hub/` — Downloaded ONNX model (managed by Transformers.js)

DB path is configurable: `--db` flag > `HAKO_DB` env > `~/.hako/hako.db`. Embedding cache and config.toml are resolved relative to the DB directory first, falling back to `~/.hako/`.

## DB Schema

3 tables, all in `hako.db`:

- **entries** — Main table (id, source, title, content, url, namespace, scope, priority, tags, happened_at, created_at, updated_at, accessed_at, access_count)
- **entries_fts** — FTS5 virtual table with trigram tokenizer (title, content, tags)
- **entries_vec** — vec0 virtual table (entry_id, embedding float[256])

FTS5 and vec0 are kept in sync via SQLite triggers (INSERT/UPDATE/DELETE).

## Important Implementation Notes

- vec0 primary keys must be passed as `BigInt()` in better-sqlite3
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

## MCP Server (hako-mcp)

Tools: `save`, `search`, `delete`, `prune`, `stats`, `list_namespaces`

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
