import type { Hako } from "hako-db";
import { loadState, saveState } from "./state.js";
import { appendOps, countOps, writeOps } from "./oplog.js";
import { gitAddCommitPush } from "./git.js";
import type { SyncConfig, Op, OpAdd, OpUpdate, PushResult } from "./types.js";
import type { Entry } from "hako-db";

function entryToSyncEntry(entry: Entry) {
  return {
    source: entry.source,
    title: entry.title,
    content: entry.content,
    url: entry.url,
    namespace: entry.namespace,
    scope: entry.scope,
    priority: entry.priority,
    happened_at: entry.happened_at,
    created_at: entry.created_at,
    tags: entry.tags,
  };
}

function entryToAddOp(entry: Entry, ts: string): OpAdd {
  return { op: "add", id: entry.id, ts, entry: entryToSyncEntry(entry) };
}

function entryToUpdateOp(entry: Entry, ts: string): OpUpdate {
  return { op: "update", id: entry.id, ts, entry: entryToSyncEntry(entry) };
}

export async function push(
  hako: Hako,
  config: SyncConfig,
  dbPath?: string,
): Promise<PushResult> {
  const state = loadState(config.machine_id, dbPath);
  const currentIds = new Set(
    hako.allIds({ excludeSources: config.exclude_sources }),
  );
  const existingIds = new Set(hako.allIds());
  const lastPushIds = new Set(state.last_push_ids);

  const newIds = [...currentIds].filter((id) => !lastPushIds.has(id));
  // Compared against every entry, so excluding a source does not delete its
  // entries on other machines.
  const deletedIds = [...lastPushIds].filter((id) => !existingIds.has(id));

  const ops: Op[] = [];
  const ts = new Date().toISOString().slice(0, 19);

  if (newIds.length > 0) {
    const entries = hako.getMany(newIds);
    for (const entry of entries) {
      ops.push(entryToAddOp(entry, ts));
    }
  }

  for (const id of deletedIds) {
    ops.push({ op: "delete", id, ts });
  }

  // Detect updated entries (content changed since last push)
  let updatedCount = 0;
  if (state.last_push_at !== null) {
    const updatedEntries = hako.getUpdatedSince(state.last_push_at);
    for (const entry of updatedEntries) {
      // Only include entries that existed before (not new adds)
      if (lastPushIds.has(entry.id) && currentIds.has(entry.id)) {
        ops.push(entryToUpdateOp(entry, ts));
        updatedCount++;
      }
    }
  }

  if (ops.length === 0) {
    return { added: 0, deleted: 0, updated: 0, committed: false, compacted: false };
  }

  appendOps(config.repo, config.machine_id, ops);

  // Auto-compaction: if ops count exceeds threshold, rewrite as snapshot
  let compacted = false;
  const opsCount = countOps(config.repo, config.machine_id);
  // Only redundant ops count: an add-only oplog cannot shrink, and counting
  // all ops would rewrite the snapshot on every push past the threshold.
  if (opsCount - currentIds.size >= config.compaction_threshold) {
    const allEntries = hako.getMany([...currentIds]);
    const snapshotOps = allEntries.map((entry) => entryToAddOp(entry, ts));
    writeOps(config.repo, config.machine_id, snapshotOps);
    compacted = true;
  }

  const commitMsg = compacted
    ? `sync: ${config.machine_id} compacted (${[...currentIds].length} entries)`
    : `sync: ${config.machine_id} +${newIds.length} -${deletedIds.length} ~${updatedCount}`;

  const committed = await gitAddCommitPush(config.repo, commitMsg);

  saveState(
    {
      ...state,
      last_push_ids: [...currentIds],
      last_push_at: ts,
    },
    dbPath,
  );

  return { added: newIds.length, deleted: deletedIds.length, updated: updatedCount, committed, compacted };
}
