import type { Hako } from "hako-db";
import { loadState } from "./state.js";
import { listMachines, readEpoch, readOps } from "./oplog.js";
import type { SyncConfig, SyncStatus } from "./types.js";

export function status(
  hako: Hako,
  config: SyncConfig,
  dbPath?: string,
): SyncStatus {
  const state = loadState(config.machine_id, dbPath);
  const currentIds = new Set(
    hako.allIds({ excludeSources: config.exclude_sources }),
  );
  const existingIds = new Set(hako.allIds());
  const lastPushIds = new Set(state.last_push_ids);

  const unpushedAdds = [...currentIds].filter(
    (id) => !lastPushIds.has(id),
  ).length;
  const unpushedDeletes = [...lastPushIds].filter(
    (id) => !existingIds.has(id),
  ).length;

  const machines = listMachines(config.repo).filter(
    (m) => m !== config.machine_id,
  );

  let unreadMachines = 0;
  for (const machine of machines) {
    // Same offset rule as pull: offsets count characters, and a compaction
    // makes pull re-read the oplog from the start.
    const compacted =
      readEpoch(config.repo, machine) !== (state.epochs[machine] ?? 0);
    const offset = compacted ? 0 : (state.offsets[machine] ?? 0);
    if (readOps(config.repo, machine, offset).ops.length > 0) unreadMachines++;
  }

  return {
    unpushed_adds: unpushedAdds,
    unpushed_deletes: unpushedDeletes,
    unread_machines: unreadMachines,
    last_push_at: state.last_push_at,
  };
}
