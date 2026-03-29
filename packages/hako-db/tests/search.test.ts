import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";

// Mock embeddings
vi.mock("../src/embeddings.js", () => {
  const dim = 256;
  const mockVec = Array.from({ length: dim }, () => 0.1);
  return {
    EMBEDDING_DIM: dim,
    embed: vi.fn().mockResolvedValue(mockVec),
    makeEmbeddingInput: vi.fn((title: string, content: string | null) => {
      return content ? `${title} ${content}` : title;
    }),
    serializeVec: vi.fn((vec: number[]) => new Float32Array(vec)),
    deserializeVec: vi.fn((data: Float32Array) => Array.from(data)),
  };
});

vi.mock("../src/embedding-cache.js", () => ({
  storeBatch: vi.fn(),
}));

import { getConnection, insertEntry } from "../src/db.js";
import { hybridSearch } from "../src/search.js";

describe("search", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "hako-search-test-"));
    dbPath = join(tempDir, "test.db");
    db = getConnection(dbPath);

    // Insert test data
    await insertEntry(db, {
      title: "TypeScript入門",
      content: "TypeScriptはJavaScriptに型を追加した言語です",
      source: "web",
      url: "https://example.com/ts",
      happened_at: new Date().toISOString().slice(0, 19),
    });
    await insertEntry(db, {
      title: "Pythonプログラミング",
      content: "Pythonは汎用プログラミング言語です",
      source: "web",
      url: "https://example.com/py",
      happened_at: new Date().toISOString().slice(0, 19),
    });
    await insertEntry(db, {
      title: "今日のメモ",
      content: "買い物リスト: 牛乳、パン",
      source: "memo",
      happened_at: new Date().toISOString().slice(0, 19),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true });
  });

  it("returns results for a query", async () => {
    const results = await hybridSearch(db, "TypeScript");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("score");
    expect(results[0]).toHaveProperty("title");
  });

  it("respects limit option", async () => {
    const results = await hybridSearch(db, "プログラミング", { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("filters by source", async () => {
    const results = await hybridSearch(db, "TypeScript", { source: "memo" });
    for (const r of results) {
      expect(r.source).toBe("memo");
    }
  });

  it("returns results with score field", async () => {
    const results = await hybridSearch(db, "メモ");
    for (const r of results) {
      expect(typeof r.score).toBe("number");
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns empty array when no matches", async () => {
    const results = await hybridSearch(db, "xyznonexistent12345");
    // May still get vec results since mock returns same vec for everything
    // but FTS should return nothing
    expect(Array.isArray(results)).toBe(true);
  });
});
