import type { Hako } from "hako-db";
import type { Scope, Priority } from "hako-db";
import { loadState, saveState } from "./state.js";
import { readOps, listMachines } from "./oplog.js";
import { gitPull } from "./git.js";
import type { SyncConfig, OpAdd, PullResult } from "./types.js";

const VALID_SCOPES = new Set<string>(["default", "global"]);
const VALID_PRIORITIES = new Set<string>(["normal", "high"]);

function validateScope(s: string): Scope {
  return VALID_SCOPES.has(s) ? (s as Scope) : "default";
}

function validatePriority(p: string): Priority {
  return VALID_PRIORITIES.has(p) ? (p as Priority) : "normal";
}

export async function pull(
  hako: Hako,
  config: SyncConfig,
  dbPath?: string,
): Promise<PullResult> {
  await gitPull(config.repo);

  const state = loadState(config.machine_id, dbPath);
  const machines = listMachines(config.repo).filter(
    (m) => m !== config.machine_id,
  );

  let added = 0;
  let deleted = 0;
  let skipped = 0;
  const newOffsets: Record<string, number> = { ...state.offsets };

  // Collect all ops from other machines
  const deleteIds = new Set<string>();
  const addOps: OpAdd[] = [];

  for (const machine of machines) {
    const offset = state.offsets[machine] ?? 0;
    const { ops, newOffset } = readOps(config.repo, machine, offset);
    newOffsets[machine] = newOffset;

    for (const op of ops) {
      if (op.op === "delete") {
        deleteIds.add(op.id);
      } else {
        addOps.push(op);
      }
    }
  }

  // Apply deletes first (delete-wins)
  for (const id of deleteIds) {
    if (hako.delete(id)) {
      deleted++;
    }
  }

  // Apply adds
  const ageCutoff =
    config.import_max_age_days > 0
      ? new Date(
          Date.now() - config.import_max_age_days * 86400000,
        ).toISOString()
      : null;

  for (const op of addOps) {
    // Skip if deleted by any machine
    if (deleteIds.has(op.id)) {
      skipped++;
      continue;
    }

    // Age filter
    if (ageCutoff && op.entry.happened_at < ageCutoff) {
      skipped++;
      continue;
    }

    try {
      const result = await hako.save({
        id: op.id,
        title: op.entry.title,
        content: op.entry.content,
        source: op.entry.source,
        url: op.entry.url,
        namespace: op.entry.namespace,
        scope: validateScope(op.entry.scope),
        priority: validatePriority(op.entry.priority),
        happened_at: op.entry.happened_at,
        tags: op.entry.tags,
      });

      if (result.status === "created") {
        added++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  // Update state: offsets + current DB IDs as last_push_ids
  // This ensures the next push correctly detects changes since this pull
  saveState(
    {
      ...state,
      last_push_ids: hako.allIds(),
      offsets: newOffsets,
    },
    dbPath,
  );

  return { added, deleted, skipped };
}
