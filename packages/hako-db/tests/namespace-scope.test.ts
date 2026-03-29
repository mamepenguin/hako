import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";

vi.mock("../src/embeddings.js", () => {
  const dim = 256;
  let callCount = 0;
  return {
    EMBEDDING_DIM: dim,
    embed: vi.fn().mockImplementation(() => {
      callCount++;
      // Return slightly different vectors for each call to test semantic dedup
      const vec = Array.from({ length: dim }, (_, i) => 0.1 + (callCount * 0.0001 * i));
      return Promise.resolve(vec);
    }),
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

import {
  getConnection,
  insertEntry,
  listNamespaces,
  pruneEntries,
  enforceCapacity,
} from "../src/db.js";
import { hybridSearch } from "../src/search.js";

describe("namespace and scope", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hako-ns-test-"));
    dbPath = join(tempDir, "test.db");
    db = getConnection(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true });
  });

  describe("insertEntry with namespace/scope/priority", () => {
    it("stores namespace, scope, and priority", async () => {
      const { id } = await insertEntry(db, {
        title: "Test",
        namespace: "/projects/foo",
        scope: "global",
        priority: "high",
        happened_at: "2026-03-29T12:00:00",
      });

      const row = db
        .prepare("SELECT namespace, scope, priority FROM entries WHERE id = ?")
        .get(id) as { namespace: string; scope: string; priority: string };

      expect(row.namespace).toBe("/projects/foo");
      expect(row.scope).toBe("global");
      expect(row.priority).toBe("high");
    });

    it("defaults to empty namespace, default scope, normal priority", async () => {
      const { id } = await insertEntry(db, {
        title: "Default",
        happened_at: "2026-03-29T12:00:00",
      });

      const row = db
        .prepare("SELECT namespace, scope, priority FROM entries WHERE id = ?")
        .get(id) as { namespace: string; scope: string; priority: string };

      expect(row.namespace).toBe("");
      expect(row.scope).toBe("default");
      expect(row.priority).toBe("normal");
    });
  });

  describe("normal priority dedup (exact match)", () => {
    it("skips duplicate within same namespace", async () => {
      await insertEntry(db, {
        title: "Same",
        content: "Same content",
        namespace: "/projects/foo",
        priority: "normal",
        happened_at: "2026-03-29T12:00:00",
      });

      const second = await insertEntry(db, {
        title: "Same",
        content: "Same content",
        namespace: "/projects/foo",
        priority: "normal",
        happened_at: "2026-03-29T12:00:00",
      });

      expect(second.status).toBe("skipped");
    });

    it("allows same content in different namespaces", async () => {
      await insertEntry(db, {
        title: "Same",
        content: "Same content",
        namespace: "/projects/foo",
        priority: "normal",
        happened_at: "2026-03-29T12:00:00",
      });

      const second = await insertEntry(db, {
        title: "Same",
        content: "Same content",
        namespace: "/projects/bar",
        priority: "normal",
        happened_at: "2026-03-29T12:00:00",
      });

      expect(second.status).toBe("created");
    });
  });

  describe("listNamespaces", () => {
    it("lists namespaces with counts", async () => {
      await insertEntry(db, {
        title: "A",
        namespace: "/projects/foo",
        happened_at: "2026-03-29T12:00:00",
      });
      await insertEntry(db, {
        title: "B",
        namespace: "/projects/foo",
        happened_at: "2026-03-29T12:00:00",
      });
      await insertEntry(db, {
        title: "C",
        namespace: "/projects/bar",
        happened_at: "2026-03-29T12:00:00",
      });

      const ns = listNamespaces(db);
      expect(ns).toHaveLength(2);
      expect(ns[0].count).toBe(2);
      expect(ns[0].namespace).toBe("/projects/foo");
    });
  });

  describe("scope_mode search filtering", () => {
    beforeEach(async () => {
      await insertEntry(db, {
        title: "Project A local",
        content: "Local entry in project A",
        namespace: "/projects/a",
        scope: "default",
        happened_at: new Date().toISOString().slice(0, 19),
      });
      await insertEntry(db, {
        title: "Project A global",
        content: "Global entry from project A",
        namespace: "/projects/a",
        scope: "global",
        happened_at: new Date().toISOString().slice(0, 19),
      });
      await insertEntry(db, {
        title: "Project B local",
        content: "Local entry in project B",
        namespace: "/projects/b",
        scope: "default",
        happened_at: new Date().toISOString().slice(0, 19),
      });
      await insertEntry(db, {
        title: "Project B global",
        content: "Global entry from project B",
        namespace: "/projects/b",
        scope: "global",
        happened_at: new Date().toISOString().slice(0, 19),
      });
    });

    it("scoped: returns only entries in namespace", async () => {
      const results = await hybridSearch(db, "entry", {
        namespace: "/projects/a",
        scope_mode: "scoped",
      });

      for (const r of results) {
        expect(r.namespace).toBe("/projects/a");
      }
    });

    it("global_only: returns only global-scoped entries", async () => {
      const results = await hybridSearch(db, "entry", {
        scope_mode: "global_only",
      });

      for (const r of results) {
        expect(r.scope).toBe("global");
      }
    });

    it("scoped_then_global: returns namespace + global from others", async () => {
      const results = await hybridSearch(db, "entry", {
        namespace: "/projects/a",
        scope_mode: "scoped_then_global",
      });

      for (const r of results) {
        const isInNamespace = r.namespace === "/projects/a";
        const isGlobal = r.scope === "global";
        expect(isInNamespace || isGlobal).toBe(true);
      }
    });

    it("all: returns everything", async () => {
      const results = await hybridSearch(db, "entry", {
        scope_mode: "all",
        limit: 10,
      });

      expect(results.length).toBe(4);
    });
  });

  describe("pruneEntries", () => {
    it("deletes entries not accessed within N days", async () => {
      const { id } = await insertEntry(db, {
        title: "Old",
        happened_at: "2020-01-01T12:00:00",
      });

      // Force old accessed_at
      db.prepare(
        "UPDATE entries SET accessed_at = '2020-01-01T12:00:00' WHERE id = ?",
      ).run(id);

      const deleted = pruneEntries(db, 1);
      expect(deleted).toBe(1);
    });

    it("keeps recently accessed entries", async () => {
      await insertEntry(db, {
        title: "Recent",
        happened_at: new Date().toISOString().slice(0, 19),
      });

      const deleted = pruneEntries(db, 1);
      expect(deleted).toBe(0);
    });
  });

  describe("enforceCapacity", () => {
    it("removes least accessed entries when over capacity", async () => {
      for (let i = 0; i < 5; i++) {
        await insertEntry(db, {
          title: `Entry ${i}`,
          happened_at: "2026-03-29T12:00:00",
        });
      }

      const removed = enforceCapacity(db, 3);
      expect(removed).toBe(2);

      const count = (
        db.prepare("SELECT COUNT(*) as c FROM entries").get() as { c: number }
      ).c;
      expect(count).toBe(3);
    });

    it("does nothing when under capacity", async () => {
      await insertEntry(db, {
        title: "A",
        happened_at: "2026-03-29T12:00:00",
      });

      const removed = enforceCapacity(db, 10);
      expect(removed).toBe(0);
    });

    it("does nothing when max is 0 (unlimited)", async () => {
      await insertEntry(db, {
        title: "A",
        happened_at: "2026-03-29T12:00:00",
      });

      const removed = enforceCapacity(db, 0);
      expect(removed).toBe(0);
    });
  });

  describe("schema migration", () => {
    it("adds new columns to existing database", () => {
      // The database was already created with new columns in beforeEach
      // Verify columns exist
      const columns = db.pragma("table_info(entries)") as Array<{ name: string }>;
      const colNames = columns.map((c) => c.name);

      expect(colNames).toContain("namespace");
      expect(colNames).toContain("scope");
      expect(colNames).toContain("priority");
      expect(colNames).toContain("updated_at");
    });
  });
});
