/**
 * Migrate engram data to hako.
 *
 * Usage:
 *   npx tsx packages/hako-mcp/src/migrate-engram.ts [--source jsonl|db] [--dry-run]
 *
 * Sources:
 *   jsonl (default): Read from ~/.engram/sync/*.jsonl
 *   db: Read from ~/.engram/memory.db
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Hako } from "hako-db";
import type { Scope, Priority } from "hako-db";

interface EngramRecord {
  readonly content: string;
  readonly tags: string;
  readonly project: string;
  readonly memory_type: string;
  readonly scope: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly machine?: string;
}

function mapPriority(memoryType: string): Priority {
  return memoryType === "highlight" ? "high" : "normal";
}

function mapScope(scope: string): Scope {
  return scope === "global" ? "global" : "default";
}

function makeTitle(content: string): string {
  // Use first 200 chars of content as title
  const firstLine = content.split("\n")[0];
  return firstLine.length > 200 ? firstLine.slice(0, 200) : firstLine;
}

async function loadFromJsonl(): Promise<EngramRecord[]> {
  const syncDir = join(homedir(), ".engram", "sync");
  if (!existsSync(syncDir)) {
    console.error(`Sync directory not found: ${syncDir}`);
    return [];
  }

  const files = readdirSync(syncDir).filter((f) => f.endsWith(".jsonl"));
  const records: EngramRecord[] = [];

  for (const file of files) {
    const text = readFileSync(join(syncDir, file), "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as EngramRecord);
      } catch {
        // skip invalid lines
      }
    }
  }

  return records;
}

async function loadFromDb(): Promise<EngramRecord[]> {
  const dbPath = join(homedir(), ".engram", "memory.db");
  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    return [];
  }

  // Dynamic import to avoid requiring better-sqlite3 at top level
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(dbPath, { readonly: true });

  const rows = db
    .prepare(
      "SELECT content, tags, project, memory_type, scope, created_at, updated_at FROM memories ORDER BY created_at",
    )
    .all() as EngramRecord[];

  db.close();
  return rows;
}

async function migrate(source: "jsonl" | "db", dryRun: boolean): Promise<void> {
  console.error(`Loading from ${source}...`);
  const records = source === "jsonl" ? await loadFromJsonl() : await loadFromDb();
  console.error(`Found ${records.length} records`);

  if (records.length === 0) return;

  // Deduplicate by (project, content)
  const seen = new Set<string>();
  const unique: EngramRecord[] = [];
  for (const rec of records) {
    const key = `${rec.project}::${rec.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(rec);
  }
  console.error(`After dedup: ${unique.length} unique records`);

  if (dryRun) {
    console.error("Dry run — no changes made");
    const byProject = new Map<string, number>();
    for (const rec of unique) {
      byProject.set(rec.project, (byProject.get(rec.project) ?? 0) + 1);
    }
    for (const [project, count] of [...byProject.entries()].sort((a, b) => b[1] - a[1])) {
      console.error(`  ${project}: ${count}`);
    }
    return;
  }

  const hako = new Hako({ dbPath: process.env.HAKO_DB });
  let created = 0;
  let skipped = 0;
  let errors = 0;

  try {
    for (let i = 0; i < unique.length; i++) {
      const rec = unique[i];
      try {
        const result = await hako.save({
          title: makeTitle(rec.content),
          content: rec.content,
          tags: rec.tags,
          namespace: rec.project,
          scope: mapScope(rec.scope),
          priority: mapPriority(rec.memory_type),
          source: rec.memory_type === "background" ? "transcript" : "engram",
          happened_at: rec.created_at,
        });

        if (result.status === "created") created++;
        else skipped++;
      } catch (err) {
        errors++;
        if (errors <= 5) {
          console.error(`Error on record ${i}: ${err}`);
        }
      }

      if ((i + 1) % 100 === 0) {
        console.error(`Progress: ${i + 1}/${unique.length} (created: ${created}, skipped: ${skipped})`);
      }
    }
  } finally {
    hako.close();
  }

  console.error(`\nMigration complete:`);
  console.error(`  Created: ${created}`);
  console.error(`  Skipped: ${skipped}`);
  console.error(`  Errors:  ${errors}`);
}

// CLI
const cliArgs = process.argv.slice(2);
const sourceIdx = cliArgs.indexOf("--source");
const source = (sourceIdx >= 0 ? cliArgs[sourceIdx + 1] : "jsonl") as "jsonl" | "db";
const dryRun = cliArgs.includes("--dry-run");

migrate(source, dryRun).catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
