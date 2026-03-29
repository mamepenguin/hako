import type Database from "better-sqlite3";
import { getSearchConfig } from "./config.js";
import { touchAccessed } from "./db.js";
import { embed, serializeVec } from "./embeddings.js";
import type { Entry, ScopeMode, SearchResult } from "./types.js";

export interface HybridSearchOptions {
  readonly source?: string;
  readonly namespace?: string;
  readonly scope_mode?: ScopeMode;
  readonly limit?: number;
  readonly dbPath?: string;
}

export async function hybridSearch(
  db: Database.Database,
  query: string,
  opts?: HybridSearchOptions,
): Promise<SearchResult[]> {
  const cfg = getSearchConfig(opts?.dbPath);
  const source = opts?.source ?? "";
  const namespace = opts?.namespace ?? "";
  const scopeMode = opts?.scope_mode ?? "all";
  const limit = opts?.limit ?? 10;

  const scopeFilter = buildScopeFilter(namespace, scopeMode);

  const ftsResults = ftsSearch(db, query, source, scopeFilter, 50);
  const vecResults = await vecSearch(db, query, source, scopeFilter, 50);

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

    const priorityBoost = row.priority === "high" ? cfg.priority_boost : 1.0;
    const namespaceBoost =
      scopeMode === "scoped_then_global" && namespace && row.namespace === namespace
        ? cfg.namespace_boost
        : 1.0;

    const finalScore =
      Math.round(rrfScore * decay * priorityBoost * namespaceBoost * 1e6) / 1e6;

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

interface ScopeFilter {
  readonly kind: ScopeMode;
  readonly where: string;
  readonly params: unknown[];
}

function buildScopeFilter(namespace: string, scopeMode: ScopeMode): ScopeFilter {
  switch (scopeMode) {
    case "scoped":
      return { kind: "scoped", where: "e.namespace = ?", params: [namespace] };
    case "global_only":
      return { kind: "global_only", where: "e.scope = 'global'", params: [] };
    case "scoped_then_global":
      return {
        kind: "scoped_then_global",
        where: "(e.namespace = ? OR e.scope = 'global')",
        params: [namespace],
      };
    case "all":
      return { kind: "all", where: "", params: [] };
  }
}

function ftsSearch(
  db: Database.Database,
  query: string,
  source: string,
  scopeFilter: ScopeFilter,
  limit: number,
): number[] {
  const ftsQuery = buildFtsQuery(query);

  const conditions = ["entries_fts MATCH ?"];
  const params: unknown[] = [ftsQuery];

  if (source) {
    conditions.push("e.source = ?");
    params.push(source);
  }
  if (scopeFilter.where) {
    conditions.push(scopeFilter.where);
    params.push(...scopeFilter.params);
  }

  params.push(limit);

  const sql = `SELECT e.id FROM entries e
     JOIN entries_fts f ON f.rowid = e.id
     WHERE ${conditions.join(" AND ")}
     LIMIT ?`;

  const rows = db.prepare(sql).all(...params) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

async function vecSearch(
  db: Database.Database,
  query: string,
  source: string,
  scopeFilter: ScopeFilter,
  limit: number,
): Promise<number[]> {
  const vec = await embed(query);
  const serialized = serializeVec(vec);

  // vec0 doesn't support arbitrary WHERE — fetch more, then filter
  const rows = db
    .prepare(
      `SELECT v.entry_id, v.distance
       FROM entries_vec v
       WHERE v.embedding MATCH ?
         AND k = ?
       ORDER BY v.distance`,
    )
    .all(serialized, limit * 2) as Array<{ entry_id: number; distance: number }>;

  const filtered: number[] = [];
  for (const r of rows) {
    if (filtered.length >= limit) break;

    const entry = db
      .prepare("SELECT source, namespace, scope FROM entries WHERE id = ?")
      .get(r.entry_id) as { source: string; namespace: string; scope: string } | undefined;

    if (!entry) continue;
    if (source && entry.source !== source) continue;
    if (scopeFilter.where && !matchesScopeFilter(entry, scopeFilter)) continue;

    filtered.push(r.entry_id);
  }
  return filtered;
}

function matchesScopeFilter(
  entry: { namespace: string; scope: string },
  filter: ScopeFilter,
): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "scoped":
      return entry.namespace === filter.params[0];
    case "global_only":
      return entry.scope === "global";
    case "scoped_then_global":
      return entry.namespace === filter.params[0] || entry.scope === "global";
  }
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
