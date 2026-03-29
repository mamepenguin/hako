import type Database from "better-sqlite3";
import { insertEntry } from "./db.js";
import type { SaveInput, SaveOutput } from "./types.js";

export async function saveEntry(
  db: Database.Database,
  input: SaveInput,
  opts: { cachePath: string },
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

  return insertEntry(db, {
    source,
    title: input.title,
    content: input.content ?? null,
    url: input.url ?? null,
    happened_at: happenedAt,
    tags: input.tags ?? "",
    cachePath: opts.cachePath,
  });
}
