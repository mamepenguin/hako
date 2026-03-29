import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kura-test-"));
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
