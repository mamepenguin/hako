# Hako

TypeScript/Node.js data store with hybrid search (FTS5 + vector).
Japanese text optimized. SQLite single-file DB.

## Quick Reference

```bash
pnpm install                    # Install dependencies
pnpm --filter hako-db test      # Run library tests (54 tests)
pnpm --filter hako-db build     # Build library
pnpm --filter hako-cli build    # Build CLI
```

## Architecture

Monorepo with 2 packages:

- **packages/hako-db** — Library. `import { Hako } from 'hako-db'` for use from other Node.js backends.
- **packages/hako-cli** — CLI. `hako add`, `hako search`, `hako web <url>`, etc.

Dependency direction: hako-cli → hako-db (never reverse).

## Key Files (packages/hako-db/src/)

| File | Responsibility |
|------|---------------|
| `index.ts` | `Hako` class — public API wrapping all modules |
| `types.ts` | All TypeScript interfaces (`Entry`, `SearchResult`, `SaveInput`, etc.) |
| `config.ts` | Config resolution per-DB (`resolveConfigPath`, `resolveDbPath`, `resolveCachePath`), merges with defaults |
| `db.ts` | SQLite schema (entries + FTS5 trigram + vec0), CRUD operations |
| `search.ts` | Hybrid search: FTS5 + vec0 → RRF fusion → time decay |
| `save.ts` | Validation + deduplication (by URL or content) |
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

- **entries** — Main table (id, source, title, content, url, tags, happened_at, created_at, accessed_at, access_count)
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
2. Reciprocal Rank Fusion: `score = Σ 1/(k + rank + 1)`, default k=60
3. Time decay: `decay = 0.5^(days_old / 180)`, floor=0.1
4. Final score = RRF × decay, sorted descending
