import type Database from "better-sqlite3";
import { getSearchConfig } from "./config.js";
import { touchAccessed } from "./db.js";
import { embed, serializeVec } from "./embeddings.js";
import type { Entry, SearchResult } from "./types.js";

export async function hybridSearch(
  db: Database.Database,
  query: string,
  opts?: { source?: string; limit?: number; dbPath?: string },
): Promise<SearchResult[]> {
  const cfg = getSearchConfig(opts?.dbPath);
  const source = opts?.source ?? "";
  const limit = opts?.limit ?? 10;

  const ftsResults = ftsSearch(db, query, source, 50);
  const vecResults = await vecSearch(db, query, source, 50);

  const rrfScores = rrfFusion(ftsResults, vecResults, cfg.rrf_k);

  const now = new Date();
  const scored: SearchResult[] = [];

  for (const [entryId, rrfScore] of rrfScores) {
    const row = db
      .prepare("SELECT * FROM entries WHERE id = ?")
      .get(entryId) as Entry | undefined;

    if (!row) continue;

    const decay = timeDecay(
      row.happened_at,
      row.created_at,
      cfg.time_decay_half_life_days,
      cfg.time_decay_floor,
      now,
    );

    const finalScore = Math.round(rrfScore * decay * 1e6) / 1e6;

    scored.push({ ...row, score: finalScore });
  }

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, limit);

  touchAccessed(
    db,
    results.map((r) => r.id),
  );

  return results;
}

function ftsSearch(
  db: Database.Database,
  query: string,
  source: string,
  limit: number,
): number[] {
  const ftsQuery = buildFtsQuery(query);

  const rows = source
    ? (db
        .prepare(
          `SELECT e.id FROM entries e
           JOIN entries_fts f ON f.rowid = e.id
           WHERE entries_fts MATCH ?
             AND e.source = ?
           LIMIT ?`,
        )
        .all(ftsQuery, source, limit) as Array<{ id: number }>)
    : (db
        .prepare(
          `SELECT e.id FROM entries e
           JOIN entries_fts f ON f.rowid = e.id
           WHERE entries_fts MATCH ?
           LIMIT ?`,
        )
        .all(ftsQuery, limit) as Array<{ id: number }>);

  return rows.map((r) => r.id);
}

async function vecSearch(
  db: Database.Database,
  query: string,
  source: string,
  limit: number,
): Promise<number[]> {
  const vec = await embed(query);
  const serialized = serializeVec(vec);

  const rows = db
    .prepare(
      `SELECT v.entry_id, v.distance
       FROM entries_vec v
       WHERE v.embedding MATCH ?
         AND k = ?
       ORDER BY v.distance`,
    )
    .all(serialized, limit) as Array<{ entry_id: number; distance: number }>;

  if (!source) {
    return rows.map((r) => r.entry_id);
  }

  const filtered: number[] = [];
  for (const r of rows) {
    const entry = db
      .prepare("SELECT source FROM entries WHERE id = ?")
      .get(r.entry_id) as { source: string } | undefined;

    if (entry && entry.source === source) {
      filtered.push(r.entry_id);
    }
  }
  return filtered;
}

function rrfFusion(
  ftsIds: number[],
  vecIds: number[],
  k: number = 60,
): Map<number, number> {
  const scores = new Map<number, number>();

  for (let rank = 0; rank < ftsIds.length; rank++) {
    const eid = ftsIds[rank];
    scores.set(eid, (scores.get(eid) ?? 0) + 1.0 / (k + rank + 1));
  }

  for (let rank = 0; rank < vecIds.length; rank++) {
    const eid = vecIds[rank];
    scores.set(eid, (scores.get(eid) ?? 0) + 1.0 / (k + rank + 1));
  }

  return scores;
}

function timeDecay(
  happenedAt: string,
  createdAt: string,
  halfLife: number = 180.0,
  floor: number = 0.1,
  now?: Date,
): number {
  const ref = now ?? new Date();
  const reference = new Date(
    Math.max(
      new Date(happenedAt).getTime(),
      new Date(createdAt).getTime(),
    ),
  );

  const daysOld = Math.max(
    Math.floor((ref.getTime() - reference.getTime()) / (1000 * 60 * 60 * 24)),
    0,
  );

  const decay = Math.pow(0.5, daysOld / halfLife);
  return Math.max(decay, floor);
}

function buildFtsQuery(query: string): string {
  const escaped = query.replace(/"/g, '""');
  return `"${escaped}"`;
}
