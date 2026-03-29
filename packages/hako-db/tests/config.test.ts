import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { loadConfig, resolveDbPath, resolveCachePath } from "../src/config.js";

describe("config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hako-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true });
  });

  it("returns default config when no config file exists", () => {
    const cfg = loadConfig(join(tempDir, "nonexistent.toml"));

    expect(cfg.search.rrf_k).toBe(60);
    expect(cfg.search.time_decay_half_life_days).toBe(180.0);
    expect(cfg.search.time_decay_floor).toBe(0.1);
    expect(cfg.embedding.model).toBe("sirasagi62/ruri-v3-30m-ONNX");
    expect(cfg.embedding.max_content_chars).toBe(500);
  });

  it("merges user config with defaults", () => {
    const configPath = join(tempDir, "config.toml");
    writeFileSync(
      configPath,
      `[search]
rrf_k = 30

[embedding]
max_content_chars = 1000
`,
    );

    const cfg = loadConfig(configPath);

    expect(cfg.search.rrf_k).toBe(30);
    expect(cfg.search.time_decay_half_life_days).toBe(180.0);
    expect(cfg.embedding.max_content_chars).toBe(1000);
    expect(cfg.embedding.model).toBe("sirasagi62/ruri-v3-30m-ONNX");
  });
});

describe("resolveDbPath", () => {
  const savedEnv = process.env.HAKO_DB;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.HAKO_DB;
    } else {
      process.env.HAKO_DB = savedEnv;
    }
  });

  it("returns default path when no args or env", () => {
    delete process.env.HAKO_DB;
    expect(resolveDbPath()).toBe(join(homedir(), ".hako", "hako.db"));
  });

  it("uses HAKO_DB env var when set", () => {
    process.env.HAKO_DB = "/tmp/work/hako.db";
    expect(resolveDbPath()).toBe("/tmp/work/hako.db");
  });

  it("explicit dbPath takes priority over env", () => {
    process.env.HAKO_DB = "/tmp/work/hako.db";
    expect(resolveDbPath("/custom/path.db")).toBe("/custom/path.db");
  });
});

describe("resolveCachePath", () => {
  const savedEnv = process.env.HAKO_DB;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.HAKO_DB;
    } else {
      process.env.HAKO_DB = savedEnv;
    }
  });

  it("returns default cache path when no args or env", () => {
    delete process.env.HAKO_DB;
    expect(resolveCachePath()).toBe(
      join(homedir(), ".hako", "embedding_cache.db"),
    );
  });

  it("cache lives alongside the database file", () => {
    expect(resolveCachePath("/data/project/my.db")).toBe(
      "/data/project/embedding_cache.db",
    );
  });

  it("follows HAKO_DB env var directory", () => {
    process.env.HAKO_DB = "/tmp/work/hako.db";
    expect(resolveCachePath()).toBe("/tmp/work/embedding_cache.db");
  });
});
