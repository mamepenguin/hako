import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  EMBEDDING_DIM,
  embed,
  makeEmbeddingInput,
  serializeVec,
} from "./embeddings.js";
import { storeBatch as cacheStoreBatch } from "./embedding-cache.js";
import type { Entry, NamespaceCount, SourceCount, Stats } from "./types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT DEFAULT '',
    title         TEXT NOT NULL,
    content       TEXT,
    url           TEXT,
    namespace     TEXT NOT NULL DEFAULT '',
    scope         TEXT NOT NULL DEFAULT 'default',
    priority      TEXT NOT NULL DEFAULT 'normal',
    happened_at   TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
    updated_at    TEXT,
    tags          TEXT DEFAULT '',
    accessed_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
    access_count  INTEGER DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    title, content, tags,
    content='entries',
    content_rowid='id',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, title, content, tags)
    VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, tags)
    VALUES ('delete', old.id, old.title, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, tags)
    VALUES ('delete', old.id, old.title, old.content, old.tags);
    INSERT INTO entries_fts(rowid, title, content, tags)
    VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS entries_vec USING vec0(
    entry_id INTEGER PRIMARY KEY,
    embedding FLOAT[${EMBEDDING_DIM}]
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_url ON entries(url) WHERE url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_happened_at ON entries(happened_at);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
CREATE INDEX IF NOT EXISTS idx_entries_namespace ON entries(namespace);
CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope);
`;

const MIGRATION_SQL = `
ALTER TABLE entries ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
ALTER TABLE entries ADD COLUMN scope TEXT NOT NULL DEFAULT 'default';
ALTER TABLE entries ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE entries ADD COLUMN updated_at TEXT;
`;

export function getConnection(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);
  ensureSchema(db);
  return db;
}

function ensureSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  migrateIfNeeded(db);
}

function migrateIfNeeded(db: Database.Database): void {
  const columns = db.pragma("table_info(entries)") as Array<{ name: string }>;
  const colNames = new Set(columns.map((c) => c.name));

  if (colNames.has("namespace")) return;

  for (const stmt of MIGRATION_SQL.trim().split(";")) {
    const trimmed = stmt.trim();
    if (trimmed) db.exec(trimmed);
  }
}

export async function insertEntry(
  db: Database.Database,
  opts: {
    source?: string;
    title: string;
    content?: string | null;
    url?: string | null;
    happened_at: string;
    tags?: string;
    namespace?: string;
    scope?: string;
    priority?: string;
    cachePath: string;
  },
): Promise<{ id: number; status: "created" | "updated" | "skipped" }> {
  const source = opts.source ?? "";
  const content = opts.content ?? null;
  const url = opts.url ?? null;
  const tags = opts.tags ?? "";
  const namespace = opts.namespace ?? "";
  const scope = opts.scope ?? "default";
  const priority = opts.priority ?? "normal";

  const embeddingInput = makeEmbeddingInput(opts.title, content);
  const vec = await embed(embeddingInput);
  cacheStoreBatch([[embeddingInput, vec]], opts.cachePath);
  const serialized = serializeVec(vec);

  // URL dedup: update existing entry
  if (url !== null) {
    const existing = db
      .prepare("SELECT id FROM entries WHERE url = ?")
      .get(url) as { id: number } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE entries
         SET title = ?, content = ?, tags = ?, happened_at = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'),
             accessed_at = strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')
         WHERE id = ?`,
      ).run(opts.title, content, tags, opts.happened_at, existing.id);

      db.prepare(
        "UPDATE entries_vec SET embedding = ? WHERE entry_id = ?",
      ).run(serialized, BigInt(existing.id));

      return { id: existing.id, status: "updated" };
    }
  }

  // Priority-based dedup (no URL)
  if (url === null) {
    if (priority === "high") {
      // Semantic dedup: cosine similarity >= 0.90 within namespace
      const dupId = findSemanticDuplicate(db, serialized, namespace);
      if (dupId !== null) {
        db.prepare(
          `UPDATE entries
           SET title = ?, content = ?, tags = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'),
               accessed_at = strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'),
               access_count = access_count + 1
           WHERE id = ?`,
        ).run(opts.title, content, tags, dupId);

        db.prepare(
          "UPDATE entries_vec SET embedding = ? WHERE entry_id = ?",
        ).run(serialized, BigInt(dupId));

        return { id: dupId, status: "updated" };
      }
    } else {
      // Exact dedup: namespace + title + content match → SKIP
      const existing = db
        .prepare(
          "SELECT id FROM entries WHERE namespace = ? AND title = ? AND content IS ? LIMIT 1",
        )
        .get(namespace, opts.title, content) as { id: number } | undefined;

      if (existing) {
        return { id: existing.id, status: "skipped" };
      }
    }
  }

  // New entry
  const result = db
    .prepare(
      `INSERT INTO entries (source, title, content, url, namespace, scope, priority, happened_at, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(source, opts.title, content, url, namespace, scope, priority, opts.happened_at, tags);

  const entryId = Number(result.lastInsertRowid);

  db.prepare(
    "INSERT INTO entries_vec (entry_id, embedding) VALUES (?, ?)",
  ).run(BigInt(entryId), serialized);

  return { id: entryId, status: "created" };
}

const DEDUP_SIMILARITY_THRESHOLD = 0.90;

function findSemanticDuplicate(
  db: Database.Database,
  serializedVec: Float32Array,
  namespace: string,
): number | null {
  const rows = db
    .prepare(
      `SELECT v.entry_id, v.distance
       FROM entries_vec v
       WHERE v.embedding MATCH ?
         AND k = 5
       ORDER BY v.distance`,
    )
    .all(serializedVec) as Array<{ entry_id: number; distance: number }>;

  for (const row of rows) {
    const similarity = 1.0 - row.distance;
    if (similarity < DEDUP_SIMILARITY_THRESHOLD) continue;

    const entry = db
      .prepare("SELECT namespace FROM entries WHERE id = ?")
      .get(row.entry_id) as { namespace: string } | undefined;

    if (entry && entry.namespace === namespace) {
      return row.entry_id;
    }
  }
  return null;
}

export function deleteEntry(db: Database.Database, entryId: number): boolean {
  const result = db
    .prepare("DELETE FROM entries WHERE id = ?")
    .run(entryId);

  if (result.changes === 0) return false;

  db.prepare("DELETE FROM entries_vec WHERE entry_id = ?").run(BigInt(entryId));
  return true;
}

export function getEntry(
  db: Database.Database,
  entryId: number,
): Entry | null {
  const row = db
    .prepare("SELECT * FROM entries WHERE id = ?")
    .get(entryId) as Entry | undefined;

  if (!row) return null;

  touchAccessed(db, [entryId]);

  const updated = db
    .prepare("SELECT * FROM entries WHERE id = ?")
    .get(entryId) as Entry;

  return updated;
}

export function listEntries(
  db: Database.Database,
  opts?: {
    source?: string;
    since?: string;
    until?: string;
    limit?: number;
  },
): Entry[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.source) {
    conditions.push("source = ?");
    params.push(opts.source);
  }
  if (opts?.since) {
    conditions.push("happened_at >= ?");
    params.push(opts.since);
  }
  if (opts?.until) {
    conditions.push("happened_at <= ?");
    params.push(opts.until);
  }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  const limit = opts?.limit ?? 20;
  params.push(limit);

  return db
    .prepare(
      `SELECT * FROM entries ${where} ORDER BY happened_at DESC LIMIT ?`,
    )
    .all(...params) as Entry[];
}

export function getStats(
  db: Database.Database,
  dbPath: string,
): Stats {
  const total = (
    db.prepare("SELECT COUNT(*) as c FROM entries").get() as { c: number }
  ).c;

  const sourceCounts = db
    .prepare(
      "SELECT source, COUNT(*) as c FROM entries GROUP BY source ORDER BY c DESC",
    )
    .all() as Array<{ source: string; c: number }>;

  const namespaceCounts = listNamespaces(db);

  let dbSize = 0;
  try {
    dbSize = statSync(dbPath).size;
  } catch {
    // file may not exist yet
  }

  return {
    total_entries: total,
    sources: sourceCounts.map((r) => ({
      source: r.source || "(empty)",
      count: r.c,
    })),
    namespaces: namespaceCounts,
    db_size_bytes: dbSize,
    db_size_mb: Math.round((dbSize / (1024 * 1024)) * 100) / 100,
  };
}

export function listSources(db: Database.Database): SourceCount[] {
  const rows = db
    .prepare(
      "SELECT source, COUNT(*) as count FROM entries GROUP BY source ORDER BY count DESC",
    )
    .all() as Array<{ source: string; count: number }>;

  return rows.map((r) => ({
    source: r.source || "(empty)",
    count: r.count,
  }));
}

export function pruneEntries(
  db: Database.Database,
  olderThanDays: number = 90,
): number {
  const result = db
    .prepare(
      `DELETE FROM entries WHERE id IN (
         SELECT id FROM entries
         WHERE julianday('now') - julianday(accessed_at) > ?
       )`,
    )
    .run(olderThanDays);

  const deleted = result.changes;
  if (deleted > 0) {
    db.prepare(
      "DELETE FROM entries_vec WHERE entry_id NOT IN (SELECT id FROM entries)",
    ).run();
  }
  return deleted;
}

export function enforceCapacity(
  db: Database.Database,
  maxEntries: number,
): number {
  if (maxEntries <= 0) return 0;

  const count = (
    db.prepare("SELECT COUNT(*) as c FROM entries").get() as { c: number }
  ).c;

  if (count <= maxEntries) return 0;

  const overflow = count - maxEntries;
  db.prepare(
    `DELETE FROM entries WHERE id IN (
       SELECT id FROM entries
       ORDER BY access_count ASC, accessed_at ASC
       LIMIT ?
     )`,
  ).run(overflow);

  db.prepare(
    "DELETE FROM entries_vec WHERE entry_id NOT IN (SELECT id FROM entries)",
  ).run();

  return overflow;
}

export function listNamespaces(db: Database.Database): NamespaceCount[] {
  const rows = db
    .prepare(
      `SELECT namespace, COUNT(*) as count,
              MAX(COALESCE(updated_at, created_at)) as last_updated
       FROM entries
       GROUP BY namespace
       ORDER BY count DESC`,
    )
    .all() as Array<{ namespace: string; count: number; last_updated: string | null }>;

  return rows.map((r) => ({
    namespace: r.namespace || "(default)",
    count: r.count,
    last_updated: r.last_updated,
  }));
}

export function touchAccessed(
  db: Database.Database,
  entryIds: number[],
): void {
  if (entryIds.length === 0) return;

  const placeholders = entryIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE entries
     SET accessed_at = strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'),
         access_count = access_count + 1
     WHERE id IN (${placeholders})`,
  ).run(...entryIds);
}
