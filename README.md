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
```

## Library Usage

```typescript
import { Hako } from 'hako-db'

const hako = new Hako()

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

## Data Locations

| Path | Purpose |
|------|---------|
| `~/.hako/hako.db` | Main database |
| `~/.hako/embedding_cache.db` | Embedding cache |
| `~/.hako/config.toml` | User config (optional) |
| `~/.cache/huggingface/hub/` | ONNX model cache |

## Configuration

Optional `~/.hako/config.toml`:

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
pnpm --filter hako-db test       # Run tests (48 tests, mocked embeddings)
pnpm --filter hako-db test:watch # Watch mode
pnpm --filter hako-db build      # Build library
pnpm --filter hako-cli build     # Build CLI
```

## Tech Stack

- **DB**: better-sqlite3 + sqlite-vec + FTS5 trigram
- **Embedding**: @huggingface/transformers (ONNX runtime)
- **HTML**: cheerio
- **CLI**: commander
- **Test**: vitest
- **Build**: tsup (ESM only)

## License

MIT
