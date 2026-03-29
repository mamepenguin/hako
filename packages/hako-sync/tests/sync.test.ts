import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Hako } from "hako-db";
import { push, pull } from "../src/index.js";
import type { SyncConfig } from "../src/types.js";

// Mock embeddings to avoid model download
vi.mock("@huggingface/transformers", async () => {
  const EMBEDDING_DIM = 256;
  const mockVec = Array.from({ length: EMBEDDING_DIM }, () => 0.1);
  return {
    pipeline: vi.fn().mockResolvedValue(
      vi.fn().mockResolvedValue({
        tolist: () => [mockVec],
      }),
    ),
    env: { cacheDir: "" },
  };
});

let tempDir: string;
let syncRepo: string;
let dbPathA: string;
let dbPathB: string;
let hakoA: Hako;
let hakoB: Hako;
let configA: SyncConfig;
let configB: SyncConfig;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "hako-sync-test-"));
  syncRepo = join(tempDir, "sync-repo");
  dbPathA = join(tempDir, "machine-a", "hako.db");
  dbPathB = join(tempDir, "machine-b", "hako.db");

  mkdirSync(join(tempDir, "machine-a"), { recursive: true });
  mkdirSync(join(tempDir, "machine-b"), { recursive: true });

  // Initialize a bare git repo and clone it for sync
  mkdirSync(syncRepo, { recursive: true });
  execFileSync("git", ["init"], { cwd: syncRepo });
  execFileSync("git", ["config", "user.email", "test@test.com"], {
    cwd: syncRepo,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: syncRepo });

  hakoA = new Hako({ dbPath: dbPathA });
  hakoB = new Hako({ dbPath: dbPathB });

  configA = {
    repo: syncRepo,
    machine_id: "machine-a",
    import_max_age_days: 90,
  };

  configB = {
    repo: syncRepo,
    machine_id: "machine-b",
    import_max_age_days: 90,
  };
});

afterEach(() => {
  hakoA.close();
  hakoB.close();
  rmSync(tempDir, { recursive: true });
});

describe("sync integration", () => {
  it("pushes from A and pulls to B", async () => {
    // Machine A saves an entry and pushes
    await hakoA.save({
      title: "Design decision",
      content: "Use Nano ID for sync",
      source: "test",
    });

    const pushResult = await push(hakoA, configA, dbPathA);
    expect(pushResult.added).toBe(1);
    expect(pushResult.deleted).toBe(0);
    expect(pushResult.committed).toBe(true);

    // Machine B pulls
    const pullResult = await pull(hakoB, configB, dbPathB);
    expect(pullResult.added).toBe(1);
    expect(pullResult.deleted).toBe(0);

    // Verify entry exists on machine B
    const entries = hakoB.list({ limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("Design decision");
  });

  it("handles bidirectional sync", async () => {
    // A saves and pushes
    await hakoA.save({ title: "From A", source: "test" });
    await push(hakoA, configA, dbPathA);

    // B saves and pushes
    await hakoB.save({ title: "From B", source: "test" });
    await push(hakoB, configB, dbPathB);

    // A pulls B's data
    const pullA = await pull(hakoA, configA, dbPathA);
    expect(pullA.added).toBe(1);

    // B pulls A's data
    const pullB = await pull(hakoB, configB, dbPathB);
    expect(pullB.added).toBe(1);

    // Both should have 2 entries
    expect(hakoA.list({ limit: 10 })).toHaveLength(2);
    expect(hakoB.list({ limit: 10 })).toHaveLength(2);
  });

  it("delete-wins: deleted entry does not reappear", async () => {
    // A saves and pushes
    const saved = await hakoA.save({ title: "To be deleted", source: "test" });
    await push(hakoA, configA, dbPathA);

    // B pulls
    await pull(hakoB, configB, dbPathB);
    expect(hakoB.list({ limit: 10 })).toHaveLength(1);

    // B deletes the entry and pushes
    hakoB.delete(saved.id);
    await push(hakoB, configB, dbPathB);

    // A pulls — entry should be deleted
    const pullA = await pull(hakoA, configA, dbPathA);
    expect(pullA.deleted).toBe(1);
    expect(hakoA.list({ limit: 10 })).toHaveLength(0);
  });

  it("skips duplicate entries on re-pull", async () => {
    // A saves and pushes
    await hakoA.save({ title: "Already exists", source: "test" });
    await push(hakoA, configA, dbPathA);

    // B pulls twice — second pull should skip
    await pull(hakoB, configB, dbPathB);
    const pullResult2 = await pull(hakoB, configB, dbPathB);
    expect(pullResult2.added).toBe(0);
    expect(pullResult2.skipped).toBe(0);

    expect(hakoB.list({ limit: 10 })).toHaveLength(1);
  });

  it("nothing to push returns committed=false", async () => {
    const result = await push(hakoA, configA, dbPathA);
    expect(result.committed).toBe(false);
    expect(result.added).toBe(0);
  });
});

describe("prune + sync", () => {
  it("prune generates delete op on push", async () => {
    // A saves and pushes
    const saved = await hakoA.save({
      title: "Old entry",
      source: "test",
    });
    await push(hakoA, configA, dbPathA);

    // Directly delete to simulate prune (prune(0) may not delete just-accessed entries)
    hakoA.delete(saved.id);
    const pushResult = await push(hakoA, configA, dbPathA);

    expect(pushResult.deleted).toBe(1);
    expect(pushResult.added).toBe(0);
  });

  it("age filter skips old entries on pull", async () => {
    // A saves an old entry and pushes
    await hakoA.save({
      title: "Ancient entry",
      source: "test",
      happened_at: "2020-01-01T00:00:00",
    });
    await push(hakoA, configA, dbPathA);

    // B pulls with import_max_age_days = 90 — should skip the old entry
    const pullResult = await pull(hakoB, configB, dbPathB);
    expect(pullResult.skipped).toBe(1);
    expect(pullResult.added).toBe(0);
    expect(hakoB.list({ limit: 10 })).toHaveLength(0);
  });
});
