import type { Hako } from "hako-db";
import { loadState } from "./state.js";
import { listMachines, getFileSize } from "./oplog.js";
import type { SyncConfig, SyncStatus } from "./types.js";

export function status(
  hako: Hako,
  config: SyncConfig,
  dbPath?: string,
): SyncStatus {
  const state = loadState(config.machine_id, dbPath);
  const currentIds = new Set(hako.allIds());
  const lastPushIds = new Set(state.last_push_ids);

  const unpushedAdds = [...currentIds].filter(
    (id) => !lastPushIds.has(id),
  ).length;
  const unpushedDeletes = [...lastPushIds].filter(
    (id) => !currentIds.has(id),
  ).length;

  const machines = listMachines(config.repo).filter(
    (m) => m !== config.machine_id,
  );

  let unreadMachines = 0;
  for (const machine of machines) {
    const size = getFileSize(config.repo, machine);
    const offset = state.offsets[machine] ?? 0;
    if (size > offset) unreadMachines++;
  }

  return {
    unpushed_adds: unpushedAdds,
    unpushed_deletes: unpushedDeletes,
    unread_machines: unreadMachines,
    last_push_at:
      state.last_push_ids.length > 0 ? new Date().toISOString() : null,
  };
}
