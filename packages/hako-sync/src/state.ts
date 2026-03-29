import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDbPath } from "hako-db";
import type { SyncState } from "./types.js";

function getStatePath(dbPath?: string): string {
  const resolved = resolveDbPath(dbPath);
  return join(dirname(resolved), "sync-state.json");
}

export function loadState(
  machineId: string,
  dbPath?: string,
): SyncState {
  const statePath = getStatePath(dbPath);

  if (!existsSync(statePath)) {
    return {
      machine_id: machineId,
      last_push_ids: [],
      offsets: {},
    };
  }

  const raw = readFileSync(statePath, "utf-8");
  const data = JSON.parse(raw) as SyncState;

  return {
    machine_id: machineId,
    last_push_ids: data.last_push_ids ?? [],
    offsets: data.offsets ?? {},
  };
}

export function saveState(
  state: SyncState,
  dbPath?: string,
): void {
  const statePath = getStatePath(dbPath);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}
