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

import { Kura } from "../src/index.js";

describe("Kura", () => {
  let tempDir: string;
  let kura: Kura;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kura-api-test-"));
    kura = new Kura({ dbPath: join(tempDir, "test.db") });
  });

  afterEach(() => {
    kura.close();
    rmSync(tempDir, { recursive: true });
  });

  it("saves and retrieves an entry", async () => {
    const result = await kura.save({
      title: "Test Entry",
      content: "Some content",
      source: "test",
    });

    expect(result.status).toBe("created");

    const entry = kura.get(result.id);
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("Test Entry");
  });

  it("searches entries", async () => {
    await kura.save({ title: "Node.js入門", content: "JavaScript runtime" });
    await kura.save({ title: "Python入門", content: "Programming language" });

    const results = await kura.search("Node.js");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("score");
  });

  it("lists entries", async () => {
    await kura.save({ title: "Entry 1" });
    await kura.save({ title: "Entry 2" });

    const entries = kura.list();
    expect(entries).toHaveLength(2);
  });

  it("deletes an entry", async () => {
    const { id } = await kura.save({ title: "To delete" });
    expect(kura.delete(id)).toBe(true);
    expect(kura.get(id)).toBeNull();
  });

  it("returns sources", async () => {
    await kura.save({ title: "A", source: "web", url: "https://a.com" });
    await kura.save({ title: "B", source: "memo" });

    const sources = kura.sources();
    expect(sources.length).toBeGreaterThan(0);
  });

  it("returns stats", async () => {
    await kura.save({ title: "Test" });

    const stats = kura.stats();
    expect(stats.total_entries).toBe(1);
  });
});
