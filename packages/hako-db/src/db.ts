import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
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
    id            TEXT PRIMARY KEY,
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
    content_rowid='rowid',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, title, content, tags)
    VALUES (new.rowid, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    INSERT INTO entries_fts(rowid, title, content, tags)
    VALUES (new.rowid, new.title, new.content, new.tags);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS entries_vec USING vec0(
    entry_id TEXT PRIMARY KEY,
    embedding FLOAT[${EMBEDDING_DIM}]
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_url ON entries(url) WHERE url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_happened_at ON entries(happened_at);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
CREATE INDEX IF NOT EXISTS idx_entries_namespace ON entries(namespace);
CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope);
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
  migrateIfNeeded(db);
  db.exec(SCHEMA_SQL);
}

function migrateIfNeeded(db: Database.Database): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'")
    .all() as Array<{ name: string }>;

  if (tables.length === 0) return;

  const columns = db.pragma("table_info(entries)") as Array<{
    name: string;
    type: string;
  }>;
  const colMap = new Map(columns.map((c) => [c.name, c.type]));

  // Add namespace/scope/priority/updated_at if missing (pre-v2 migration)
  if (!colMap.has("namespace")) {
    for (const stmt of [
      "ALTER TABLE entries ADD COLUMN namespace TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE entries ADD COLUMN scope TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE entries ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'",
      "ALTER TABLE entries ADD COLUMN updated_at TEXT",
    ]) {
      db.exec(stmt);
    }
  }

  // Migrate INTEGER id to TEXT (Nano ID)
  const idType = colMap.get("id");
  if (idType === "INTEGER") {
    migrateToNanoId(db);
  }
}

function migrateToNanoId(db: Database.Database): void {
  const rows = db.prepare("SELECT * FROM entries").all() as Array<
    Record<string, unknown>
  >;

  // Drop virtual tables and triggers
  db.exec("DROP TABLE IF EXISTS entries_vec");
  db.exec("DROP TABLE IF EXISTS entries_fts");
  db.exec("DROP TRIGGER IF EXISTS entries_ai");
  db.exec("DROP TRIGGER IF EXISTS entries_ad");
  db.exec("DROP TRIGGER IF EXISTS entries_au");

  // Rename old table and drop indexes
  db.exec("DROP INDEX IF EXISTS idx_entries_url");
  db.exec("DROP INDEX IF EXISTS idx_entries_happened_at");
  db.exec("DROP INDEX IF EXISTS idx_entries_source");
  db.exec("DROP INDEX IF EXISTS idx_entries_namespace");
  db.exec("DROP INDEX IF EXISTS idx_entries_scope");
  db.exec("ALTER TABLE entries RENAME TO entries_old");

  // Create new table with TEXT PK
  db.exec(`
    CREATE TABLE entries (
        id            TEXT PRIMARY KEY,
        source        TEXT DEFAULT '',
        title         TEXT NOT NULL,
        content       TEXT,
        url           TEXT,
        namespace     TEXT NOT NULL DEFAULT '',
        scope         TEXT NOT NULL DEFAULT 'default',
        priority      TEXT NOT NULL DEFAULT 'normal',
        happened_at   TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT,
        tags          TEXT DEFAULT '',
        accessed_at   TEXT NOT NULL,
        access_count  INTEGER DEFAULT 0
    );
  `);

  // Insert with new Nano IDs
  const insert = db.prepare(`
    INSERT INTO entries (id, source, title, content, url, namespace, scope, priority,
                         happened_at, created_at, updated_at, tags, accessed_at, access_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    insert.run(
      nanoid(),
      row.source ?? "",
      row.title,
      row.content ?? null,
      row.url ?? null,
      row.namespace ?? "",
      row.scope ?? "default",
      row.priority ?? "normal",
      row.happened_at,
      row.created_at,
      row.updated_at ?? null,
      row.tags ?? "",
      row.accessed_at ?? row.created_at,
      row.access_count ?? 0,
    );
  }

  db.exec("DROP TABLE entries_old");
  // Schema (FTS, vec0, indexes, triggers) will be created by ensureSchema
  // vec0 embeddings are lost — will be recomputed on next save/search
}

export async function insertEntry(
  db: Database.Database,
  opts: {
    id?: string;
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
): Promise<{ id: string; status: "created" | "updated" | "skipped" }> {
  const source = opts.source ?? "";
  const content = opts.content ?? null;
  const url = opts.url ?? null;
  const tags = opts.tags ?? "";
  const namespace = opts.namespace ?? "";
  const scope = opts.scope ?? "default";
  const priority = opts.priority ?? "normal";

  // If a specific ID is provided and already exists, skip
  if (opts.id) {
    const existing = db
      .prepare("SELECT id FROM entries WHERE id = ?")
      .get(opts.id) as { id: string } | undefined;
    if (existing) {
      return { id: opts.id, status: "skipped" };
    }
  }

  const embeddingInput = makeEmbeddingInput(opts.title, content);
  const vec = await embed(embeddingInput);
  cacheStoreBatch([[embeddingInput, vec]], opts.cachePath);
  const serialized = serializeVec(vec);

  // URL dedup: update existing entry
  if (url !== null) {
    const existing = db
      .prepare("SELECT id FROM entries WHERE url = ?")
      .get(url) as { id: string } | undefined;

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
      ).run(serialized, existing.id);

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
        ).run(serialized, dupId);

        return { id: dupId, status: "updated" };
      }
    } else {
      // Exact dedup: namespace + title + content match → SKIP
      const existing = db
        .prepare(
          "SELECT id FROM entries WHERE namespace = ? AND title = ? AND content IS ? LIMIT 1",
        )
        .get(namespace, opts.title, content) as { id: string } | undefined;

      if (existing) {
        return { id: existing.id, status: "skipped" };
      }
    }
  }

  // New entry
  const entryId = opts.id ?? nanoid();

  db.prepare(
    `INSERT INTO entries (id, source, title, content, url, namespace, scope, priority, happened_at, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entryId,
    source,
    opts.title,
    content,
    url,
    namespace,
    scope,
    priority,
    opts.happened_at,
    tags,
  );

  db.prepare(
    "INSERT INTO entries_vec (entry_id, embedding) VALUES (?, ?)",
  ).run(entryId, serialized);

  return { id: entryId, status: "created" };
}

const DEDUP_SIMILARITY_THRESHOLD = 0.9;

function findSemanticDuplicate(
  db: Database.Database,
  serializedVec: Float32Array,
  namespace: string,
): string | null {
  const rows = db
    .prepare(
      `SELECT v.entry_id, v.distance
       FROM entries_vec v
       WHERE v.embedding MATCH ?
         AND k = 5
       ORDER BY v.distance`,
    )
    .all(serializedVec) as Array<{ entry_id: string; distance: number }>;

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

export function deleteEntry(db: Database.Database, entryId: string): boolean {
  const result = db.prepare("DELETE FROM entries WHERE id = ?").run(entryId);

  if (result.changes === 0) return false;

  db.prepare("DELETE FROM entries_vec WHERE entry_id = ?").run(entryId);
  return true;
}

export function getEntry(
  db: Database.Database,
  entryId: string,
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

  const where =
    conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  const limit = opts?.limit ?? 20;
  params.push(limit);

  return db
    .prepare(
      `SELECT * FROM entries ${where} ORDER BY happened_at DESC LIMIT ?`,
    )
    .all(...params) as Entry[];
}

export function getStats(db: Database.Database, dbPath: string): Stats {
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
    .all() as Array<{
    namespace: string;
    count: number;
    last_updated: string | null;
  }>;

  return rows.map((r) => ({
    namespace: r.namespace || "(default)",
    count: r.count,
    last_updated: r.last_updated,
  }));
}

export function touchAccessed(
  db: Database.Database,
  entryIds: string[],
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

export function getAllEntryIds(db: Database.Database): string[] {
  const rows = db.prepare("SELECT id FROM entries").all() as Array<{
    id: string;
  }>;
  return rows.map((r) => r.id);
}

export function getEntriesByIds(
  db: Database.Database,
  ids: string[],
): Entry[] {
  if (ids.length === 0) return [];

  const CHUNK = 500;
  const results: Entry[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT * FROM entries WHERE id IN (${placeholders})`)
      .all(...batch) as Entry[];
    results.push(...rows);
  }
  return results;
}
