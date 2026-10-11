import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { loadSyncConfig } from "../src/config.js";

let tempDir: string;
let dbPath: string;

function writeConfig(body: string): void {
  writeFileSync(join(tempDir, "config.toml"), body, "utf-8");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "hako-config-test-"));
  dbPath = join(tempDir, "hako.db");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true });
});

describe("loadSyncConfig", () => {
  it.each([
    ["sync", () => join(tempDir, "sync")],
    ["./nested/sync", () => join(tempDir, "nested", "sync")],
    ["~/hako-sync", () => join(homedir(), "hako-sync")],
    ["~", () => homedir()],
    ["/abs/sync", () => "/abs/sync"],
  ])("resolves repo %s independently of the working directory", (repo, expected) => {
    writeConfig(`[sync]\nrepo = "${repo}"\nmachine_id = "m"\n`);
    expect(loadSyncConfig(dbPath)?.repo).toBe(expected());
  });

  it("reads exclude_sources", () => {
    writeConfig(
      `[sync]\nrepo = "sync"\nmachine_id = "m"\nexclude_sources = ["transcript"]\n`,
    );
    expect(loadSyncConfig(dbPath)?.exclude_sources).toEqual(["transcript"]);
  });

  it("defaults exclude_sources to empty", () => {
    writeConfig(`[sync]\nrepo = "sync"\nmachine_id = "m"\n`);
    expect(loadSyncConfig(dbPath)?.exclude_sources).toEqual([]);
  });
});
