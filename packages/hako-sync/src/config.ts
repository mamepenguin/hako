import { readFileSync } from "node:fs";
import { resolveConfigPath } from "hako-db";
import TOML from "@iarna/toml";
import type { SyncConfig } from "./types.js";

export function loadSyncConfig(dbPath?: string): SyncConfig | null {
  const configPath = resolveConfigPath(dbPath);
  if (!configPath) return null;

  const raw = readFileSync(configPath, "utf-8");
  const cfg = TOML.parse(raw) as Record<string, Record<string, unknown>>;
  const sync = cfg["sync"];
  if (!sync) return null;

  const repo = sync["repo"];
  const machineId = sync["machine_id"];
  if (typeof repo !== "string" || typeof machineId !== "string") return null;

  return {
    repo,
    machine_id: machineId,
    import_max_age_days:
      typeof sync["import_max_age_days"] === "number"
        ? sync["import_max_age_days"]
        : 90,
    compaction_threshold:
      typeof sync["compaction_threshold"] === "number"
        ? sync["compaction_threshold"]
        : 2000,
  };
}
