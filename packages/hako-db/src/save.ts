import type Database from "better-sqlite3";
import { insertEntry, enforceCapacity } from "./db.js";
import type { SaveInput, SaveOutput } from "./types.js";

export async function saveEntry(
  db: Database.Database,
  input: SaveInput,
  opts: { cachePath: string; maxEntries?: number },
): Promise<SaveOutput> {
  if (!input.title.trim()) {
    throw new Error("title is required");
  }

  const source = input.source ?? "";
  if (source === "web" && !input.url) {
    throw new Error("url is required for source 'web'");
  }

  const happenedAt =
    input.happened_at ?? new Date().toISOString().slice(0, 19);

  const result = await insertEntry(db, {
    source,
    title: input.title,
    content: input.content ?? null,
    url: input.url ?? null,
    namespace: input.namespace ?? "",
    scope: input.scope ?? "default",
    priority: input.priority ?? "normal",
    happened_at: happenedAt,
    tags: input.tags ?? "",
    cachePath: opts.cachePath,
  });

  if (opts.maxEntries && opts.maxEntries > 0 && result.status === "created") {
    enforceCapacity(db, opts.maxEntries);
  }

  return result;
}
