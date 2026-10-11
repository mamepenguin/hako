import type { Hako } from "hako-db";
import type { Scope, Priority } from "hako-db";
import { loadState, saveState } from "./state.js";
import { readOps, readEpoch, listMachines } from "./oplog.js";
import { gitPull } from "./git.js";
import type { SyncConfig, OpAdd, OpUpdate, PullResult } from "./types.js";

const VALID_SCOPES = new Set<string>(["default", "global"]);
const VALID_PRIORITIES = new Set<string>(["normal", "high"]);

function validateScope(s: string): Scope {
  return VALID_SCOPES.has(s) ? (s as Scope) : "default";
}

function validatePriority(p: string): Priority {
  return VALID_PRIORITIES.has(p) ? (p as Priority) : "normal";
}

async function importEntry(
  hako: Hako,
  op: OpAdd | OpUpdate,
): Promise<{ status: "created" | "skipped"; present: boolean }> {
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
  return {
    status: result.status === "created" ? "created" : "skipped",
    // "skipped" with the same ID means the entry was already here
    present: result.id === op.id,
  };
}

export async function pull(
  hako: Hako,
  config: SyncConfig,
  dbPath?: string,
): Promise<PullResult> {
  await gitPull(config.repo);

  const state = loadState(config.machine_id, dbPath);
  const idsBeforePull = new Set(hako.allIds());
  const lastPushIds = new Set(state.last_push_ids);
  // Whether each ID this pull touched is present afterwards, last action wins
  const presentAfterPull = new Map<string, boolean>();
  const machines = listMachines(config.repo).filter(
    (m) => m !== config.machine_id,
  );

  let added = 0;
  let deleted = 0;
  let skipped = 0;
  const newOffsets: Record<string, number> = { ...state.offsets };
  const newEpochs: Record<string, number> = { ...state.epochs };

  // Collect all ops from other machines
  const deleteIds = new Set<string>();
  const addOps: Array<{ op: OpAdd; compacted: boolean }> = [];
  const updateOps: OpUpdate[] = [];
  const excluded = new Set(config.exclude_sources);

  for (const machine of machines) {
    const savedOffset = state.offsets[machine] ?? 0;
    const savedEpoch = state.epochs[machine] ?? 0;
    const currentEpoch = readEpoch(config.repo, machine);
    // Detect compaction: epoch changed → read from beginning
    const isCompacted = currentEpoch !== savedEpoch;
    const offset = isCompacted ? 0 : savedOffset;
    const { ops, newOffset } = readOps(config.repo, machine, offset);
    newEpochs[machine] = currentEpoch;
    newOffsets[machine] = newOffset;

    for (const op of ops) {
      if (op.op !== "delete" && excluded.has(op.entry.source)) {
        skipped++;
        continue;
      }
      if (op.op === "delete") {
        deleteIds.add(op.id);
      } else if (op.op === "update") {
        updateOps.push(op);
      } else {
        addOps.push({ op, compacted: isCompacted });
      }
    }
  }

  // Apply deletes first (delete-wins)
  for (const id of deleteIds) {
    presentAfterPull.set(id, false);
    if (hako.delete(id)) {
      deleted++;
    }
  }

  const ageCutoff =
    config.import_max_age_days > 0
      ? new Date(
          Date.now() - config.import_max_age_days * 86400000,
        ).toISOString()
      : null;

  // Apply adds
  for (const { op, compacted } of addOps) {
    // Skip if deleted by any machine, including an unpushed local delete
    if (
      deleteIds.has(op.id) ||
      (lastPushIds.has(op.id) && !idsBeforePull.has(op.id))
    ) {
      skipped++;
      continue;
    }

    // Age filter
    if (ageCutoff && op.entry.happened_at < ageCutoff) {
      skipped++;
      continue;
    }

    try {
      // After compaction (epoch change), treat add as upsert
      if (compacted) {
        presentAfterPull.set(op.id, false);
        hako.delete(op.id); // remove if exists, ignore if not
      }

      const { status, present } = await importEntry(hako, op);
      presentAfterPull.set(op.id, present);
      if (status === "created") {
        added++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  // Apply updates (op:update bypasses deleteIds — update wins over delete)
  for (const op of updateOps) {
    if (ageCutoff && op.entry.happened_at < ageCutoff) {
      skipped++;
      continue;
    }

    try {
      presentAfterPull.set(op.id, false);
      hako.delete(op.id); // remove existing to avoid ID-based dedup skip
      const { status, present } = await importEntry(hako, op);
      presentAfterPull.set(op.id, present);
      if (status === "created") {
        added++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  // Built only from what this pull did, not from the DB afterwards: other
  // sessions may add or delete entries while it runs, and those changes must
  // still reach the next push. Entries this pull removed without re-creating
  // stay out, or the next push would delete them on every machine.
  for (const [id, present] of presentAfterPull) {
    if (present) lastPushIds.add(id);
    else lastPushIds.delete(id);
  }

  saveState(
    {
      ...state,
      last_push_ids: [...lastPushIds],
      last_push_at: state.last_push_at,
      offsets: newOffsets,
      epochs: newEpochs,
    },
    dbPath,
  );

  return { added, deleted, skipped };
}
