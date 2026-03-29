import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { DATA_DIR } from "./config.js";
import { serializeVec, deserializeVec } from "./embeddings.js";

export const CACHE_PATH = join(DATA_DIR, "embedding_cache.db");

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function getCacheDb(cachePath?: string): Database.Database {
  const path = cachePath ?? CACHE_PATH;
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      content_hash TEXT PRIMARY KEY,
      embedding BLOB NOT NULL
    )
  `);
  return db;
}

export function lookupBatch(
  contents: string[],
  cachePath?: string,
): Map<string, number[] | null> {
  const db = getCacheDb(cachePath);
  try {
    const result = new Map<string, number[] | null>();
    const hashToContent = new Map<string, string>();

    for (const content of contents) {
      const h = contentHash(content);
      hashToContent.set(h, content);
      result.set(content, null);
    }

    const hashes = [...hashToContent.keys()];
    const CHUNK_SIZE = 500;

    for (let i = 0; i < hashes.length; i += CHUNK_SIZE) {
      const batch = hashes.slice(i, i + CHUNK_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT content_hash, embedding FROM embedding_cache WHERE content_hash IN (${placeholders})`,
        )
        .all(...batch) as Array<{ content_hash: string; embedding: Buffer }>;

      for (const row of rows) {
        const content = hashToContent.get(row.content_hash)!;
        result.set(content, deserializeVec(row.embedding));
      }
    }

    return result;
  } finally {
    db.close();
  }
}

export function storeBatch(
  items: Array<[string, number[]]>,
  cachePath?: string,
): void {
  if (items.length === 0) return;

  const db = getCacheDb(cachePath);
  try {
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO embedding_cache (content_hash, embedding) VALUES (?, ?)",
    );
    const insertMany = db.transaction((entries: Array<[string, number[]]>) => {
      for (const [content, vec] of entries) {
        stmt.run(contentHash(content), Buffer.from(serializeVec(vec).buffer));
      }
    });
    insertMany(items);
  } finally {
    db.close();
  }
}
