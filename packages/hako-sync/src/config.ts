import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveConfigPath } from "hako-db";
import TOML from "@iarna/toml";
import type { SyncConfig } from "./types.js";

// Hooks run with the project as the working directory, so a relative repo
// must not follow cwd.
function resolveRepoPath(repo: string, configDir: string): string {
  if (repo === "~") return homedir();
  if (repo.startsWith("~/")) return join(homedir(), repo.slice(2));
  return resolve(configDir, repo);
}

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

  const excludeSources = sync["exclude_sources"];

  return {
    repo: resolveRepoPath(repo, dirname(configPath)),
    machine_id: machineId,
    import_max_age_days:
      typeof sync["import_max_age_days"] === "number"
        ? sync["import_max_age_days"]
        : 90,
    compaction_threshold:
      typeof sync["compaction_threshold"] === "number"
        ? sync["compaction_threshold"]
        : 2000,
    exclude_sources: Array.isArray(excludeSources)
      ? excludeSources.filter((s): s is string => typeof s === "string")
      : [],
  };
}
