import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lookupBatch, storeBatch } from "../src/embedding-cache.js";

describe("embedding-cache", () => {
  let tempDir: string;
  let cachePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hako-cache-test-"));
    cachePath = join(tempDir, "cache.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true });
  });

  it("returns null for uncached content", () => {
    const result = lookupBatch(["hello"], cachePath);
    expect(result.get("hello")).toBeNull();
  });

  it("stores and retrieves embeddings", () => {
    const vec = Array.from({ length: 256 }, (_, i) => i * 0.001);
    storeBatch([["hello world", vec]], cachePath);

    const result = lookupBatch(["hello world"], cachePath);
    const cached = result.get("hello world");
    expect(cached).not.toBeNull();
    expect(cached!.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      expect(cached![i]).toBeCloseTo(vec[i], 5);
    }
  });

  it("handles batch lookup with mixed hits and misses", () => {
    const vec = Array.from({ length: 256 }, () => 0.5);
    storeBatch([["cached", vec]], cachePath);

    const result = lookupBatch(["cached", "missing"], cachePath);
    expect(result.get("cached")).not.toBeNull();
    expect(result.get("missing")).toBeNull();
  });

  it("overwrites existing entry on store", () => {
    const vec1 = Array.from({ length: 256 }, () => 0.1);
    const vec2 = Array.from({ length: 256 }, () => 0.9);

    storeBatch([["key", vec1]], cachePath);
    storeBatch([["key", vec2]], cachePath);

    const result = lookupBatch(["key"], cachePath);
    const cached = result.get("key")!;
    expect(cached[0]).toBeCloseTo(0.9, 5);
  });
});
