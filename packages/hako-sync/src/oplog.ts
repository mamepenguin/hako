import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { Op } from "./types.js";

function validateMachineId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid machine ID: ${id}`);
  }
  return id;
}

function isValidOp(data: unknown): data is Op {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.ts !== "string") return false;
  if (obj.op === "delete") return true;
  if ((obj.op === "add" || obj.op === "update") && typeof obj.entry === "object" && obj.entry !== null) {
    const e = obj.entry as Record<string, unknown>;
    return typeof e.title === "string" && typeof e.happened_at === "string";
  }
  return false;
}

export function appendOps(
  repoPath: string,
  machineId: string,
  ops: readonly Op[],
): void {
  if (ops.length === 0) return;

  const filePath = join(repoPath, validateMachineId(machineId), "ops.jsonl");
  mkdirSync(dirname(filePath), { recursive: true });
  const lines = ops.map((op) => JSON.stringify(op)).join("\n") + "\n";
  appendFileSync(filePath, lines, "utf-8");
}

export function readOps(
  repoPath: string,
  machineId: string,
  fromOffset: number = 0,
): { ops: Op[]; newOffset: number } {
  const filePath = join(repoPath, validateMachineId(machineId), "ops.jsonl");
  if (!existsSync(filePath)) return { ops: [], newOffset: 0 };

  const content = readFileSync(filePath, "utf-8");
  if (fromOffset >= content.length) return { ops: [], newOffset: content.length };

  const slice = content.slice(fromOffset);
  const lines = slice.split("\n").filter((l) => l.trim());
  const ops: Op[] = [];

  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isValidOp(parsed)) {
        ops.push(parsed);
      }
    } catch {
      // Skip malformed lines (e.g. partial write from interrupted push)
    }
  }

  return { ops, newOffset: content.length };
}

export function getFileSize(
  repoPath: string,
  machineId: string,
): number {
  const filePath = join(repoPath, validateMachineId(machineId), "ops.jsonl");
  if (!existsSync(filePath)) return 0;
  return statSync(filePath).size;
}

export function countOps(
  repoPath: string,
  machineId: string,
): number {
  const filePath = join(repoPath, validateMachineId(machineId), "ops.jsonl");
  if (!existsSync(filePath)) return 0;

  const content = readFileSync(filePath, "utf-8");
  return content.split("\n").filter((l) => l.trim()).length;
}

export function writeOps(
  repoPath: string,
  machineId: string,
  ops: readonly Op[],
): void {
  const dir = join(repoPath, validateMachineId(machineId));
  const filePath = join(dir, "ops.jsonl");
  mkdirSync(dir, { recursive: true });

  const lines = ops.length > 0
    ? ops.map((op) => JSON.stringify(op)).join("\n") + "\n"
    : "";
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, lines, "utf-8");
  renameSync(tmpPath, filePath);

  // Increment epoch to signal compaction to other machines
  const epochPath = join(dir, "ops.epoch");
  const currentEpoch = readEpoch(repoPath, machineId);
  writeFileSync(epochPath, String(currentEpoch + 1), "utf-8");
}

export function readEpoch(
  repoPath: string,
  machineId: string,
): number {
  const epochPath = join(
    repoPath,
    validateMachineId(machineId),
    "ops.epoch",
  );
  if (!existsSync(epochPath)) return 0;
  const val = parseInt(readFileSync(epochPath, "utf-8").trim(), 10);
  return Number.isFinite(val) ? val : 0;
}

export function listMachines(repoPath: string): string[] {
  if (!existsSync(repoPath)) return [];

  return readdirSync(repoPath, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        !d.isSymbolicLink() &&
        /^[a-zA-Z0-9_-]+$/.test(d.name),
    )
    .filter((d) => existsSync(join(repoPath, d.name, "ops.jsonl")))
    .map((d) => d.name);
}
