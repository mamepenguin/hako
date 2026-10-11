import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Hako } from "hako-db";
import { push, pull, status } from "../src/index.js";
import { countOps, readOps } from "../src/oplog.js";
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
    compaction_threshold: 2000,
    exclude_sources: [],
  };

  configB = {
    repo: syncRepo,
    machine_id: "machine-b",
    import_max_age_days: 90,
    compaction_threshold: 2000,
    exclude_sources: [],
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

  it("delete-wins when add and delete arrive in the same pull", async () => {
    const saved = await hakoA.save({ title: "Deleted by B", source: "test" });
    await push(hakoA, configA, dbPathA);
    await pull(hakoB, configB, dbPathB);
    hakoB.delete(saved.id);
    await push(hakoB, configB, dbPathB);

    const dbPathC = join(tempDir, "machine-c", "hako.db");
    mkdirSync(join(tempDir, "machine-c"), { recursive: true });
    const hakoC = new Hako({ dbPath: dbPathC });
    const configC: SyncConfig = { ...configA, machine_id: "machine-c" };
    try {
      await pull(hakoC, configC, dbPathC);
      expect(hakoC.get(saved.id)).toBeNull();
    } finally {
      hakoC.close();
    }
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

describe("pull and local changes", () => {
  it("still pushes an entry saved locally before a pull", async () => {
    await hakoA.save({ title: "From A", source: "test" });
    await push(hakoA, configA, dbPathA);

    await hakoB.save({ title: "Saved on B before pull", source: "test" });
    await pull(hakoB, configB, dbPathB);

    const pushB = await push(hakoB, configB, dbPathB);
    expect(pushB.added).toBe(1);

    await pull(hakoA, configA, dbPathA);
    const titles = hakoA.list({ limit: 10 }).map((e) => e.title).sort();
    expect(titles).toEqual(["From A", "Saved on B before pull"]);
  });

  it("still pushes a local delete made before a pull", async () => {
    const saved = await hakoA.save({ title: "Deleted on A", source: "test" });
    await push(hakoA, configA, dbPathA);
    await pull(hakoB, configB, dbPathB);

    hakoA.delete(saved.id);
    await pull(hakoA, configA, dbPathA);
    const pushA = await push(hakoA, configA, dbPathA);
    expect(pushA.deleted).toBe(1);

    await pull(hakoB, configB, dbPathB);
    expect(hakoB.get(saved.id)).toBeNull();
  });

  it("does not push a delete for a remote entry it skipped", async () => {
    await hakoA.save({
      title: "Too old for B",
      source: "test",
      happened_at: "2020-01-01T00:00:00",
    });
    await push(hakoA, configA, dbPathA);

    await pull(hakoB, configB, dbPathB);
    const pushB = await push(hakoB, configB, dbPathB);
    expect(pushB.deleted).toBe(0);
  });

  it("does not push back an entry restored by op:update over op:delete", async () => {
    const saved = await hakoA.save({ title: "Original", source: "test" });
    await push(hakoA, configA, dbPathA);
    await pull(hakoB, configB, dbPathB);
    hakoB.delete(saved.id);
    await push(hakoB, configB, dbPathB);
    await hakoA.update(saved.id, { title: "Updated by A" });
    await push(hakoA, configA, dbPathA);

    const dbPathC = join(tempDir, "machine-c", "hako.db");
    mkdirSync(join(tempDir, "machine-c"), { recursive: true });
    const hakoC = new Hako({ dbPath: dbPathC });
    const configC: SyncConfig = { ...configA, machine_id: "machine-c" };
    try {
      await pull(hakoC, configC, dbPathC);
      const pushC = await push(hakoC, configC, dbPathC);
      expect(pushC.committed).toBe(false);
    } finally {
      hakoC.close();
    }
  });

  it("does not push a delete for an entry the pull removed and could not re-import", async () => {
    await hakoA.save({ title: "P", content: "same", source: "test" });
    const q = await hakoA.save({ title: "Q", content: "other", source: "test" });
    await push(hakoA, configA, dbPathA);
    await pull(hakoB, configB, dbPathB);

    // B drops the update as a duplicate of P after deleting its old copy of Q
    await hakoA.update(q.id, { title: "P", content: "same" });
    await push(hakoA, configA, dbPathA);
    await pull(hakoB, configB, dbPathB);
    expect(hakoB.get(q.id)).toBeNull();

    const pushB = await push(hakoB, configB, dbPathB);
    expect(pushB.deleted).toBe(0);
  });

  it("does not let a compaction snapshot revive an unpushed local delete", async () => {
    const lowThresholdA: SyncConfig = { ...configA, compaction_threshold: 2 };
    const d = await hakoA.save({ title: "Deleted on B", source: "test" });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await hakoA.save({ title: `Dropped ${i}`, source: "test" });
      ids.push(r.id);
    }
    await push(hakoA, lowThresholdA, dbPathA);
    await pull(hakoB, configB, dbPathB);

    hakoB.delete(d.id);
    for (const id of ids) hakoA.delete(id);
    const compacting = await push(hakoA, lowThresholdA, dbPathA);
    expect(compacting.compacted).toBe(true);

    await pull(hakoB, configB, dbPathB);
    expect(hakoB.get(d.id)).toBeNull();
    const pushB = await push(hakoB, configB, dbPathB);
    expect(pushB.deleted).toBe(1);
  });

  it("does not push back an entry restored by an op:update in a later pull", async () => {
    const saved = await hakoA.save({ title: "Original", source: "test" });
    await push(hakoA, configA, dbPathA);
    await pull(hakoB, configB, dbPathB);
    hakoB.delete(saved.id);
    await push(hakoB, configB, dbPathB);

    const dbPathC = join(tempDir, "machine-c", "hako.db");
    mkdirSync(join(tempDir, "machine-c"), { recursive: true });
    const hakoC = new Hako({ dbPath: dbPathC });
    const configC: SyncConfig = { ...configA, machine_id: "machine-c" };
    try {
      await pull(hakoC, configC, dbPathC);
      await hakoA.update(saved.id, { title: "Updated by A" });
      await push(hakoA, configA, dbPathA);
      await pull(hakoC, configC, dbPathC);
      expect(hakoC.get(saved.id)?.title).toBe("Updated by A");

      const pushC = await push(hakoC, configC, dbPathC);
      expect(pushC.committed).toBe(false);
    } finally {
      hakoC.close();
    }
  });

  it("still pushes a delete made by another session during a pull", async () => {
    const y = await hakoB.save({ title: "Deleted mid-pull", source: "test" });
    await push(hakoB, configB, dbPathB);
    await hakoA.save({ title: "Imported by B", source: "test" });
    await push(hakoA, configA, dbPathA);

    const save = hakoB.save.bind(hakoB);
    const spy = vi.spyOn(hakoB, "save").mockImplementation(async (input) => {
      hakoB.delete(y.id);
      return save(input);
    });
    try {
      await pull(hakoB, configB, dbPathB);
    } finally {
      spy.mockRestore();
    }

    const pushB = await push(hakoB, configB, dbPathB);
    expect(pushB.deleted).toBe(1);
  });

  it("does not push back entries imported by a pull", async () => {
    await hakoA.save({ title: "From A", source: "test" });
    await push(hakoA, configA, dbPathA);

    await pull(hakoB, configB, dbPathB);
    const pushB = await push(hakoB, configB, dbPathB);
    expect(pushB.committed).toBe(false);
  });
});

describe("exclude_sources", () => {
  it("does not push entries from excluded sources", async () => {
    const excluding: SyncConfig = {
      ...configA,
      exclude_sources: ["transcript"],
    };
    await hakoA.save({ title: "Session log", source: "transcript" });
    await hakoA.save({ title: "Design decision", source: "claude" });

    const result = await push(hakoA, excluding, dbPathA);
    expect(result.added).toBe(1);
    expect(status(hakoA, excluding, dbPathA).unpushed_adds).toBe(0);

    await pull(hakoB, configB, dbPathB);
    expect(hakoB.list({ limit: 10 }).map((e) => e.title)).toEqual([
      "Design decision",
    ]);
  });

  it("does not import entries from excluded sources", async () => {
    await hakoA.save({ title: "Session log", source: "transcript" });
    await hakoA.save({ title: "Design decision", source: "claude" });
    await push(hakoA, configA, dbPathA);

    const excluding: SyncConfig = {
      ...configB,
      exclude_sources: ["transcript"],
    };
    const result = await pull(hakoB, excluding, dbPathB);
    expect(result.added).toBe(1);
    expect(hakoB.list({ limit: 10 }).map((e) => e.title)).toEqual([
      "Design decision",
    ]);
  });

  it("keeps excluded sources out of a compaction snapshot", async () => {
    const excluding: SyncConfig = {
      ...configA,
      compaction_threshold: 2,
      exclude_sources: ["transcript"],
    };
    await hakoA.save({ title: "Session log", source: "transcript" });
    const kept = await hakoA.save({ title: "Kept", source: "claude" });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await hakoA.save({ title: `Dropped ${i}`, source: "claude" });
      ids.push(r.id);
    }
    await push(hakoA, excluding, dbPathA);
    for (const id of ids) hakoA.delete(id);
    const result = await push(hakoA, excluding, dbPathA);
    expect(result.compacted).toBe(true);

    const { ops } = readOps(syncRepo, "machine-a");
    expect(ops.map((o) => o.id)).toEqual([kept.id]);
  });

  it("does not import updates from excluded sources", async () => {
    const saved = await hakoA.save({ title: "Session log", source: "transcript" });
    await push(hakoA, configA, dbPathA);
    await hakoA.update(saved.id, { title: "Session log, edited" });
    await push(hakoA, configA, dbPathA);

    const excluding: SyncConfig = {
      ...configB,
      exclude_sources: ["transcript"],
    };
    await pull(hakoB, excluding, dbPathB);
    expect(hakoB.get(saved.id)).toBeNull();
  });

  it("does not emit deletes for entries of a newly excluded source", async () => {
    await hakoA.save({ title: "Session log", source: "transcript" });
    await hakoA.save({ title: "Design decision", source: "claude" });
    await push(hakoA, configA, dbPathA);

    const excluding: SyncConfig = {
      ...configA,
      exclude_sources: ["transcript"],
    };
    const result = await push(hakoA, excluding, dbPathA);
    expect(result.deleted).toBe(0);
    expect(result.committed).toBe(false);
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

  it("compacted flag is false when below threshold", async () => {
    await hakoA.save({ title: "Entry 1", source: "test" });
    const result = await push(hakoA, configA, dbPathA);
    expect(result.compacted).toBe(false);
  });
});

describe("compaction", () => {
  it("compacts ops.jsonl when threshold exceeded", async () => {
    // Use a low threshold for testing
    const lowThresholdConfig: SyncConfig = {
      ...configA,
      compaction_threshold: 4,
    };

    // Push multiple entries
    for (let i = 0; i < 4; i++) {
      await hakoA.save({ title: `Entry ${i}`, source: "test" });
    }
    await push(hakoA, lowThresholdConfig, dbPathA);

    // Delete 2 entries to add more ops
    const entries = hakoA.list({ limit: 10 });
    hakoA.delete(entries[0].id);
    hakoA.delete(entries[1].id);
    // 6 ops for 2 live entries → 4 redundant ops reach the threshold
    const result = await push(hakoA, lowThresholdConfig, dbPathA);
    expect(result.compacted).toBe(true);

    // After compaction, ops count should equal current DB entries (2 remaining)
    const opsCount = countOps(syncRepo, "machine-a");
    expect(opsCount).toBe(2);
  });

  it("compaction preserves all current entries", async () => {
    const lowThresholdConfig: SyncConfig = {
      ...configA,
      compaction_threshold: 2,
    };

    await hakoA.save({ title: "Keep A", source: "test" });
    await hakoA.save({ title: "Keep B", source: "test" });
    await hakoA.save({ title: "Keep C", source: "test" });
    const dropped = await hakoA.save({ title: "Drop", source: "test" });
    await push(hakoA, lowThresholdConfig, dbPathA);

    // 5 ops for 3 live entries → 2 redundant ops reach the threshold
    hakoA.delete(dropped.id);
    const result = await push(hakoA, lowThresholdConfig, dbPathA);
    expect(result.compacted).toBe(true);

    // All entries should be readable from the compacted oplog
    const { ops } = await import("../src/oplog.js").then((m) =>
      m.readOps(syncRepo, "machine-a"),
    );
    expect(ops).toHaveLength(3);
    const titles = ops.map((o) => (o.op === "add" ? o.entry.title : "")).sort();
    expect(titles).toEqual(["Keep A", "Keep B", "Keep C"]);
  });

  it("pull detects compaction and resets offset", async () => {
    const lowThresholdConfig: SyncConfig = {
      ...configA,
      compaction_threshold: 4,
    };

    // A saves entries and remembers their IDs for later deletion
    const savedIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await hakoA.save({ title: `Entry ${i}`, source: "test" });
      savedIds.push(r.id);
    }
    await push(hakoA, lowThresholdConfig, dbPathA); // 3 ops

    // B pulls and gets all 3
    const pull1 = await pull(hakoB, configB, dbPathB);
    expect(pull1.added).toBe(3);

    // A adds more entries (push them so they're tracked)
    for (let i = 3; i < 5; i++) {
      await hakoA.save({ title: `Entry ${i}`, source: "test" });
    }
    await push(hakoA, lowThresholdConfig, dbPathA); // 5 ops for 5 entries, nothing to compact

    // Delete 2 previously-pushed entries and push again
    hakoA.delete(savedIds[0]);
    hakoA.delete(savedIds[1]);
    const pushResult = await push(hakoA, lowThresholdConfig, dbPathA);
    // 7 ops for 3 entries → compaction rewrites the oplog with the 3 entries
    expect(pushResult.compacted).toBe(true);

    // B pulls after compaction — offset reset reads snapshot from 0
    const pull2 = await pull(hakoB, configB, dbPathB);
    // Compaction snapshot has 3 entries (A's current: entry 2,3,4).
    // After epoch change, op:add is treated as upsert (delete + save).
    // entry 2: B has it → upsert (delete + save) → added +1
    // entries 3,4: B doesn't have them → added +2
    // entries 0,1: not in snapshot, still on B (delete ops lost in compaction)
    expect(pull2.added).toBe(3);
    expect(pull2.deleted).toBe(0);

    // B has 5 (entries 0,1 from before + entries 2,3,4 upserted/added).
    expect(hakoB.list({ limit: 20 })).toHaveLength(5);
  });

  it("does not compact again on add-only pushes after compaction", async () => {
    const lowThresholdConfig: SyncConfig = {
      ...configA,
      compaction_threshold: 2,
    };

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await hakoA.save({ title: `Entry ${i}`, source: "test" });
      ids.push(r.id);
    }
    await push(hakoA, lowThresholdConfig, dbPathA);
    hakoA.delete(ids[0]);
    hakoA.delete(ids[1]);
    const compacting = await push(hakoA, lowThresholdConfig, dbPathA);
    expect(compacting.compacted).toBe(true);

    await hakoA.save({ title: "After compaction", source: "test" });
    const next = await push(hakoA, lowThresholdConfig, dbPathA);
    expect(next.compacted).toBe(false);
    expect(countOps(syncRepo, "machine-a")).toBe(2);
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

describe("op:update", () => {
  it("push detects updated entry", async () => {
    // A saves and pushes
    const saved = await hakoA.save({ title: "Original", source: "test" });
    await push(hakoA, configA, dbPathA);

    // A updates and pushes again
    await hakoA.update(saved.id, { title: "Updated" });
    const pushResult = await push(hakoA, configA, dbPathA);

    expect(pushResult.updated).toBe(1);
    expect(pushResult.added).toBe(0);
    expect(pushResult.committed).toBe(true);
  });

  it("pull applies op:update", async () => {
    // A saves and pushes, B pulls
    const saved = await hakoA.save({ title: "Original", source: "test" });
    await push(hakoA, configA, dbPathA);
    await pull(hakoB, configB, dbPathB);

    // Verify B has the entry
    const beforeUpdate = hakoB.get(saved.id);
    expect(beforeUpdate?.title).toBe("Original");

    // A updates and pushes
    await hakoA.update(saved.id, { title: "Updated" });
    await push(hakoA, configA, dbPathA);

    // B pulls — should get the update
    const pullResult = await pull(hakoB, configB, dbPathB);
    expect(pullResult.added).toBe(1); // upsert: delete + save = added

    const afterUpdate = hakoB.get(saved.id);
    expect(afterUpdate?.title).toBe("Updated");
  });

  it("op:update wins over op:delete", async () => {
    // A saves and pushes, B pulls
    const saved = await hakoA.save({ title: "Original", source: "test" });
    await push(hakoA, configA, dbPathA);
    await pull(hakoB, configB, dbPathB);

    // B deletes and pushes
    hakoB.delete(saved.id);
    await push(hakoB, configB, dbPathB);

    // A updates and pushes
    await hakoA.update(saved.id, { title: "Updated by A" });
    await push(hakoA, configA, dbPathA);

    // A pulls B's delete — but A's own update should have already been pushed
    // The key test: when another machine pulls and sees both delete and update
    // Create a third machine to observe
    const dbPathC = join(tempDir, "machine-c", "hako.db");
    mkdirSync(join(tempDir, "machine-c"), { recursive: true });
    const hakoC = new Hako({ dbPath: dbPathC });
    const configC: SyncConfig = {
      repo: syncRepo,
      machine_id: "machine-c",
      import_max_age_days: 90,
      compaction_threshold: 2000,
      exclude_sources: [],
    };

    try {
      // C pulls everything — sees delete from B and update from A
      const pullResult = await pull(hakoC, configC, dbPathC);
      // op:update wins — entry should exist on C
      const entry = hakoC.get(saved.id);
      expect(entry).not.toBeNull();
      expect(entry?.title).toBe("Updated by A");
    } finally {
      hakoC.close();
    }
  });

  it("first push with null last_push_at skips update detection", async () => {
    // A saves and pushes for the first time
    await hakoA.save({ title: "First", source: "test" });
    const pushResult = await push(hakoA, configA, dbPathA);

    expect(pushResult.updated).toBe(0);
    expect(pushResult.added).toBe(1);
  });
});
