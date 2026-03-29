import { execSync } from "node:child_process";
import { resolve } from "node:path";

export function resolveGitRoot(path: string): string {
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      cwd: path,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const commonPath = resolve(path, commonDir);
    if (commonPath.endsWith("/.git") || commonPath.endsWith("\\.git")) {
      return resolve(commonPath, "..");
    }
  } catch {
    // Not a git repo or git not available
  }
  return path;
}

export function getProject(): string {
  const raw = process.env.HAKO_PROJECT ?? process.cwd();
  return resolveGitRoot(raw);
}
