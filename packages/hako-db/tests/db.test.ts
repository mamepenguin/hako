import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getConnection,
  insertEntry,
  deleteEntry,
  getEntry,
  listEntries,
  getStats,
  listSources,
} from "../src/db.js";
import type Database from "better-sqlite3";

// Mock embeddings to avoid loading the model
vi.mock("../src/embeddings.js", async () => {
  const EMBEDDING_DIM = 256;
  const mockVec = Array.from({ length: EMBEDDING_DIM }, () => 0.1);
  return {
    EMBEDDING_DIM,
    embed: vi.fn().mockResolvedValue(mockVec),
    embedBatch: vi.fn().mockResolvedValue([mockVec]),
    makeEmbeddingInput: vi.fn((title: string, content: string | null) => {
      return content ? `${title} ${content}` : title;
    }),
    serializeVec: vi.fn((vec: number[]) => new Float32Array(vec)),
    deserializeVec: vi.fn((data: Float32Array) => Array.from(data)),
  };
});

// Mock embedding cache
vi.mock("../src/embedding-cache.js", () => ({
  storeBatch: vi.fn(),
}));

describe("db", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hako-db-test-"));
    dbPath = join(tempDir, "test.db");
    db = getConnection(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true });
  });

  describe("getConnection", () => {
    it("creates database with schema", () => {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as Array<{ name: string }>;

      const names = tables.map((t) => t.name);
      expect(names).toContain("entries");
      expect(names).toContain("entries_fts");
      expect(names).toContain("entries_vec");
    });

    it("sets WAL journal mode", () => {
      const result = db.pragma("journal_mode") as Array<{
        journal_mode: string;
      }>;
      expect(result[0].journal_mode).toBe("wal");
    });
  });

  describe("insertEntry", () => {
    it("creates a new entry", async () => {
      const result = await insertEntry(db, {
        title: "Test Entry",
        content: "Some content",
        source: "test",
        happened_at: "2026-03-29T12:00:00",
      });

      expect(result.status).toBe("created");
      expect(typeof result.id).toBe("string");
      expect(result.id.length).toBeGreaterThan(0);
    });

    it("updates entry with same URL", async () => {
      const first = await insertEntry(db, {
        title: "First",
        url: "https://example.com",
        source: "web",
        happened_at: "2026-03-29T12:00:00",
      });

      const second = await insertEntry(db, {
        title: "Updated",
        url: "https://example.com",
        source: "web",
        happened_at: "2026-03-29T13:00:00",
      });

      expect(second.status).toBe("updated");
      expect(second.id).toBe(first.id);

      const entry = db
        .prepare("SELECT title FROM entries WHERE id = ?")
        .get(first.id) as { title: string };
      expect(entry.title).toBe("Updated");
    });

    it("skips duplicate content without URL", async () => {
      await insertEntry(db, {
        title: "Same",
        content: "Same content",
        happened_at: "2026-03-29T12:00:00",
      });

      const second = await insertEntry(db, {
        title: "Same",
        content: "Same content",
        happened_at: "2026-03-29T12:00:00",
      });

      expect(second.status).toBe("skipped");
    });
  });

  describe("deleteEntry", () => {
    it("deletes existing entry", async () => {
      const { id } = await insertEntry(db, {
        title: "To Delete",
        happened_at: "2026-03-29T12:00:00",
      });

      expect(deleteEntry(db, id)).toBe(true);
      expect(getEntry(db, id)).toBeNull();
    });

    it("returns false for non-existent entry", () => {
      expect(deleteEntry(db, 9999)).toBe(false);
    });
  });

  describe("getEntry", () => {
    it("returns entry and increments access count", async () => {
      const { id } = await insertEntry(db, {
        title: "Access Test",
        happened_at: "2026-03-29T12:00:00",
      });

      const entry = getEntry(db, id);
      expect(entry).not.toBeNull();
      expect(entry!.title).toBe("Access Test");
      expect(entry!.access_count).toBe(1);

      const entry2 = getEntry(db, id);
      expect(entry2!.access_count).toBe(2);
    });

    it("returns null for non-existent entry", () => {
      expect(getEntry(db, 9999)).toBeNull();
    });
  });

  describe("listEntries", () => {
    it("lists entries ordered by happened_at desc", async () => {
      await insertEntry(db, {
        title: "Old",
        happened_at: "2026-03-01T12:00:00",
      });
      await insertEntry(db, {
        title: "New",
        happened_at: "2026-03-29T12:00:00",
      });

      const entries = listEntries(db);
      expect(entries).toHaveLength(2);
      expect(entries[0].title).toBe("New");
      expect(entries[1].title).toBe("Old");
    });

    it("filters by source", async () => {
      await insertEntry(db, {
        title: "Web",
        source: "web",
        url: "https://example.com",
        happened_at: "2026-03-29T12:00:00",
      });
      await insertEntry(db, {
        title: "Memo",
        source: "memo",
        happened_at: "2026-03-29T12:00:00",
      });

      const entries = listEntries(db, { source: "web" });
      expect(entries).toHaveLength(1);
      expect(entries[0].title).toBe("Web");
    });

    it("filters by date range", async () => {
      await insertEntry(db, {
        title: "Old",
        happened_at: "2026-01-01T12:00:00",
      });
      await insertEntry(db, {
        title: "Recent",
        happened_at: "2026-03-15T12:00:00",
      });

      const entries = listEntries(db, { since: "2026-03-01" });
      expect(entries).toHaveLength(1);
      expect(entries[0].title).toBe("Recent");
    });
  });

  describe("getStats", () => {
    it("returns correct statistics", async () => {
      await insertEntry(db, {
        title: "A",
        source: "web",
        url: "https://a.com",
        happened_at: "2026-03-29T12:00:00",
      });
      await insertEntry(db, {
        title: "B",
        source: "web",
        url: "https://b.com",
        happened_at: "2026-03-29T12:00:00",
      });
      await insertEntry(db, {
        title: "C",
        source: "memo",
        happened_at: "2026-03-29T12:00:00",
      });

      const stats = getStats(db, dbPath);
      expect(stats.total_entries).toBe(3);
      expect(stats.sources).toHaveLength(2);
      expect(stats.sources[0].source).toBe("web");
      expect(stats.sources[0].count).toBe(2);
    });
  });

  describe("listSources", () => {
    it("lists sources with counts", async () => {
      await insertEntry(db, {
        title: "A",
        source: "web",
        url: "https://a.com",
        happened_at: "2026-03-29T12:00:00",
      });
      await insertEntry(db, {
        title: "B",
        source: "memo",
        happened_at: "2026-03-29T12:00:00",
      });

      const sources = listSources(db);
      expect(sources).toHaveLength(2);
      expect(sources.map((s) => s.source).sort()).toEqual(["memo", "web"]);
    });
  });
});
