import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeEmbeddingInput,
  serializeVec,
  deserializeVec,
  EMBEDDING_DIM,
} from "../src/embeddings.js";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({
      data: new Float32Array(EMBEDDING_DIM).fill(0.1),
    }),
  ),
}));

describe("embeddings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("EMBEDDING_DIM is 256", () => {
    expect(EMBEDDING_DIM).toBe(256);
  });

  describe("makeEmbeddingInput", () => {
    it("uses title only when content is null", () => {
      expect(makeEmbeddingInput("hello", null)).toBe("hello");
    });

    it("combines title and content", () => {
      expect(makeEmbeddingInput("hello", "world")).toBe("hello world");
    });

    it("truncates content to max_content_chars", () => {
      const longContent = "a".repeat(1000);
      const result = makeEmbeddingInput("title", longContent);
      // default max_content_chars = 500, so "title " + 500 chars
      expect(result.length).toBe(6 + 500);
    });
  });

  describe("serializeVec / deserializeVec", () => {
    it("round-trips a vector", () => {
      const original = Array.from({ length: 256 }, (_, i) => i * 0.01);
      const serialized = serializeVec(original);
      expect(serialized).toBeInstanceOf(Float32Array);
      expect(serialized.length).toBe(256);

      const buf = Buffer.from(serialized.buffer);
      const deserialized = deserializeVec(buf);
      expect(deserialized.length).toBe(256);
      for (let i = 0; i < 256; i++) {
        expect(deserialized[i]).toBeCloseTo(original[i], 5);
      }
    });

    it("deserializes Float32Array directly", () => {
      const arr = new Float32Array([1.0, 2.0, 3.0]);
      const result = deserializeVec(arr);
      expect(result).toEqual([1.0, 2.0, 3.0]);
    });
  });

  describe("embed", () => {
    it("returns a number array of EMBEDDING_DIM length", async () => {
      const { embed } = await import("../src/embeddings.js");
      const result = await embed("test text");
      expect(result).toHaveLength(EMBEDDING_DIM);
      expect(typeof result[0]).toBe("number");
    });
  });
});
