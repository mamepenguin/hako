import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

import { Hako } from "../src/index.js";

describe("Hako", () => {
  let tempDir: string;
  let hako: Hako;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hako-api-test-"));
    hako = new Hako({ dbPath: join(tempDir, "test.db") });
  });

  afterEach(() => {
    hako.close();
    rmSync(tempDir, { recursive: true });
  });

  it("saves and retrieves an entry", async () => {
    const result = await hako.save({
      title: "Test Entry",
      content: "Some content",
      source: "test",
    });

    expect(result.status).toBe("created");

    const entry = hako.get(result.id);
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("Test Entry");
  });

  it("searches entries", async () => {
    await hako.save({ title: "Node.js入門", content: "JavaScript runtime" });
    await hako.save({ title: "Python入門", content: "Programming language" });

    const results = await hako.search("Node.js");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("score");
  });

  it("lists entries", async () => {
    await hako.save({ title: "Entry 1" });
    await hako.save({ title: "Entry 2" });

    const entries = hako.list();
    expect(entries).toHaveLength(2);
  });

  it("deletes an entry", async () => {
    const { id } = await hako.save({ title: "To delete" });
    expect(hako.delete(id)).toBe(true);
    expect(hako.get(id)).toBeNull();
  });

  it("returns sources", async () => {
    await hako.save({ title: "A", source: "web", url: "https://a.com" });
    await hako.save({ title: "B", source: "memo" });

    const sources = hako.sources();
    expect(sources.length).toBeGreaterThan(0);
  });

  it("returns stats", async () => {
    await hako.save({ title: "Test" });

    const stats = hako.stats();
    expect(stats.total_entries).toBe(1);
  });
});
