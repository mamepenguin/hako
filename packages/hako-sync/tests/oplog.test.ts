import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendOps,
  readOps,
  writeOps,
  countOps,
  listMachines,
} from "../src/oplog.js";
import type { Op } from "../src/types.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "hako-oplog-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true });
});

describe("oplog", () => {
  it("appends ops and reads them back", () => {
    const ops: Op[] = [
      {
        op: "add",
        id: "abc123",
        ts: "2026-03-30T10:00:00",
        entry: {
          source: "test",
          title: "Test Entry",
          content: "Content",
          url: null,
          namespace: "/test",
          scope: "default",
          priority: "normal",
          happened_at: "2026-03-30T10:00:00",
          created_at: "2026-03-30T10:00:00",
          tags: "tag1",
        },
      },
      { op: "delete", id: "xyz789", ts: "2026-03-30T10:01:00" },
    ];

    appendOps(tempDir, "machine-a", ops);
    const { ops: readBack, newOffset } = readOps(tempDir, "machine-a");

    expect(readBack).toHaveLength(2);
    expect(readBack[0].op).toBe("add");
    expect(readBack[0].id).toBe("abc123");
    expect(readBack[1].op).toBe("delete");
    expect(readBack[1].id).toBe("xyz789");
    expect(newOffset).toBeGreaterThan(0);
  });

  it("reads from offset", () => {
    const ops1: Op[] = [
      {
        op: "add",
        id: "first",
        ts: "2026-03-30T10:00:00",
        entry: {
          source: "",
          title: "First",
          content: null,
          url: null,
          namespace: "",
          scope: "default",
          priority: "normal",
          happened_at: "2026-03-30T10:00:00",
          created_at: "2026-03-30T10:00:00",
          tags: "",
        },
      },
    ];

    appendOps(tempDir, "machine-a", ops1);
    const { newOffset: offset1 } = readOps(tempDir, "machine-a");

    const ops2: Op[] = [
      {
        op: "add",
        id: "second",
        ts: "2026-03-30T11:00:00",
        entry: {
          source: "",
          title: "Second",
          content: null,
          url: null,
          namespace: "",
          scope: "default",
          priority: "normal",
          happened_at: "2026-03-30T11:00:00",
          created_at: "2026-03-30T11:00:00",
          tags: "",
        },
      },
    ];

    appendOps(tempDir, "machine-a", ops2);
    const { ops: newOps } = readOps(tempDir, "machine-a", offset1);

    expect(newOps).toHaveLength(1);
    expect(newOps[0].id).toBe("second");
  });

  it("returns empty for nonexistent file", () => {
    const { ops, newOffset } = readOps(tempDir, "nonexistent");
    expect(ops).toHaveLength(0);
    expect(newOffset).toBe(0);
  });

  it("returns empty when offset is at end", () => {
    const ops: Op[] = [
      { op: "delete", id: "x", ts: "2026-03-30T10:00:00" },
    ];
    appendOps(tempDir, "machine-a", ops);
    const { newOffset } = readOps(tempDir, "machine-a");
    const { ops: empty } = readOps(tempDir, "machine-a", newOffset);
    expect(empty).toHaveLength(0);
  });

  it("lists machines with ops.jsonl", () => {
    appendOps(tempDir, "macbook", [
      { op: "delete", id: "x", ts: "2026-03-30T10:00:00" },
    ]);
    appendOps(tempDir, "mac-mini", [
      { op: "delete", id: "y", ts: "2026-03-30T10:00:00" },
    ]);

    const machines = listMachines(tempDir);
    expect(machines.sort()).toEqual(["mac-mini", "macbook"]);
  });
});

describe("countOps", () => {
  it("counts lines in ops.jsonl", () => {
    const ops: Op[] = [
      { op: "delete", id: "a", ts: "2026-03-30T10:00:00" },
      { op: "delete", id: "b", ts: "2026-03-30T10:01:00" },
      { op: "delete", id: "c", ts: "2026-03-30T10:02:00" },
    ];
    appendOps(tempDir, "machine-a", ops);
    expect(countOps(tempDir, "machine-a")).toBe(3);
  });

  it("returns 0 for nonexistent file", () => {
    expect(countOps(tempDir, "nonexistent")).toBe(0);
  });
});

describe("writeOps", () => {
  it("replaces ops.jsonl content atomically", () => {
    // Write initial ops
    const initial: Op[] = [
      { op: "delete", id: "old1", ts: "2026-03-30T10:00:00" },
      { op: "delete", id: "old2", ts: "2026-03-30T10:01:00" },
    ];
    appendOps(tempDir, "machine-a", initial);
    expect(countOps(tempDir, "machine-a")).toBe(2);

    // Overwrite with snapshot
    const snapshot: Op[] = [
      {
        op: "add",
        id: "snap1",
        ts: "2026-03-30T12:00:00",
        entry: {
          source: "test",
          title: "Snapshot entry",
          content: null,
          url: null,
          namespace: "",
          scope: "default",
          priority: "normal",
          happened_at: "2026-03-30T12:00:00",
          created_at: "2026-03-30T12:00:00",
          tags: "",
        },
      },
    ];
    writeOps(tempDir, "machine-a", snapshot);

    // Should only have the snapshot entry
    const { ops } = readOps(tempDir, "machine-a");
    expect(ops).toHaveLength(1);
    expect(ops[0].id).toBe("snap1");
    expect(countOps(tempDir, "machine-a")).toBe(1);
  });

  it("results in smaller file size than original offset", () => {
    // Simulate a large oplog
    const manyOps: Op[] = Array.from({ length: 50 }, (_, i) => ({
      op: "add" as const,
      id: `entry-${i}`,
      ts: "2026-03-30T10:00:00",
      entry: {
        source: "test",
        title: `Entry ${i}`,
        content: `Content for entry ${i}`,
        url: null,
        namespace: "/test",
        scope: "default",
        priority: "normal",
        happened_at: "2026-03-30T10:00:00",
        created_at: "2026-03-30T10:00:00",
        tags: "",
      },
    }));
    appendOps(tempDir, "machine-a", manyOps);
    const { newOffset: originalOffset } = readOps(tempDir, "machine-a");

    // Compact to only 10 entries (simulating prune removed 40)
    const snapshot = manyOps.slice(0, 10);
    writeOps(tempDir, "machine-a", snapshot);
    const { newOffset: compactedOffset } = readOps(tempDir, "machine-a");

    expect(compactedOffset).toBeLessThan(originalOffset);
  });
});
