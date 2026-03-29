import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function exec(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `git ${args[0]} failed: ${stderr.trim() || error.message}`,
          ),
        );
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}

export async function gitInit(repoPath: string): Promise<void> {
  await exec("git", ["init"], repoPath);
}

export async function gitPull(repoPath: string): Promise<void> {
  const hasRemote = await hasGitRemote(repoPath);
  if (!hasRemote) return;

  await exec("git", ["pull", "--ff-only"], repoPath);
}

export async function gitAddCommitPush(
  repoPath: string,
  message: string,
): Promise<boolean> {
  await exec("git", ["add", "-A"], repoPath);

  const { stdout: status } = await exec(
    "git",
    ["status", "--porcelain"],
    repoPath,
  );
  if (!status) return false;

  await exec("git", ["commit", "-m", message], repoPath);

  const hasRemote = await hasGitRemote(repoPath);
  if (hasRemote) {
    try {
      await exec("git", ["push"], repoPath);
    } catch (error) {
      throw new Error(
        `Push failed. Run 'hako sync pull' first, then try again. (${(error as Error).message})`,
      );
    }
  }

  return true;
}

export function isGitRepo(repoPath: string): boolean {
  return existsSync(join(repoPath, ".git"));
}

async function hasGitRemote(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["remote"], repoPath);
    return stdout.length > 0;
  } catch {
    return false;
  }
}
