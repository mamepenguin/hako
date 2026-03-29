import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gitInit, isGitRepo } from "./git.js";

export async function init(
  repoPath: string,
  machineId: string,
): Promise<void> {
  mkdirSync(repoPath, { recursive: true });

  if (!isGitRepo(repoPath)) {
    await gitInit(repoPath);
  }

  const machineDir = join(repoPath, machineId);
  if (!existsSync(machineDir)) {
    mkdirSync(machineDir, { recursive: true });
  }
}
