import type { Hako } from "hako-db";
import { loadState, saveState } from "./state.js";
import { appendOps } from "./oplog.js";
import { gitAddCommitPush } from "./git.js";
import type { SyncConfig, Op, PushResult } from "./types.js";

export async function push(
  hako: Hako,
  config: SyncConfig,
  dbPath?: string,
): Promise<PushResult> {
  const state = loadState(config.machine_id, dbPath);
  const currentIds = new Set(hako.allIds());
  const lastPushIds = new Set(state.last_push_ids);

  const newIds = [...currentIds].filter((id) => !lastPushIds.has(id));
  const deletedIds = [...lastPushIds].filter((id) => !currentIds.has(id));

  const ops: Op[] = [];
  const ts = new Date().toISOString().slice(0, 19);

  if (newIds.length > 0) {
    const entries = hako.getMany(newIds);
    for (const entry of entries) {
      ops.push({
        op: "add",
        id: entry.id,
        ts,
        entry: {
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
        },
      });
    }
  }

  for (const id of deletedIds) {
    ops.push({ op: "delete", id, ts });
  }

  if (ops.length === 0) {
    return { added: 0, deleted: 0, committed: false };
  }

  appendOps(config.repo, config.machine_id, ops);

  const committed = await gitAddCommitPush(
    config.repo,
    `sync: ${config.machine_id} +${newIds.length} -${deletedIds.length}`,
  );

  saveState(
    {
      ...state,
      last_push_ids: [...currentIds],
    },
    dbPath,
  );

  return { added: newIds.length, deleted: deletedIds.length, committed };
}
