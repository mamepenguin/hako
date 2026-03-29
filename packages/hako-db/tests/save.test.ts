import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";

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

import { getConnection } from "../src/db.js";
import { saveEntry } from "../src/save.js";

describe("save", () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hako-save-test-"));
    db = getConnection(join(tempDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true });
  });

  it("saves a new entry", async () => {
    const result = await saveEntry(db, {
      title: "Test",
      content: "Content",
      source: "test",
    }, { cachePath: join(tempDir, "embedding_cache.db") });

    expect(result.status).toBe("created");
    expect(result.id).toBeGreaterThan(0);
  });

  it("throws on empty title", async () => {
    await expect(
      saveEntry(db, { title: "   " }, { cachePath: join(tempDir, "embedding_cache.db") }),
    ).rejects.toThrow("title is required");
  });

  it("throws when web source has no url", async () => {
    await expect(
      saveEntry(db, { title: "Test", source: "web" }, { cachePath: join(tempDir, "embedding_cache.db") }),
    ).rejects.toThrow("url is required for source 'web'");
  });

  it("sets happened_at to now if not provided", async () => {
    const before = new Date().toISOString().slice(0, 16);
    const result = await saveEntry(db, { title: "Auto time" }, { cachePath: join(tempDir, "embedding_cache.db") });

    const entry = db
      .prepare("SELECT happened_at FROM entries WHERE id = ?")
      .get(result.id) as { happened_at: string };

    expect(entry.happened_at.slice(0, 16)).toBe(before);
  });

  it("deduplicates by URL", async () => {
    const cacheOpts = { cachePath: join(tempDir, "embedding_cache.db") };
    await saveEntry(db, {
      title: "First",
      source: "web",
      url: "https://example.com",
    }, cacheOpts);
    const second = await saveEntry(db, {
      title: "Second",
      source: "web",
      url: "https://example.com",
    }, cacheOpts);

    expect(second.status).toBe("updated");
  });
});
