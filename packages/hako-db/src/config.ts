import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import TOML from "@iarna/toml";
import type { HakoConfig, SearchConfig, EmbeddingConfig } from "./types.js";

const DEFAULT_DATA_DIR = join(homedir(), ".hako");
const CONFIG_FILENAME = "config.toml";

/**
 * Resolve the database file path.
 * Priority: explicit dbPath > HAKO_DB env > ~/.hako/hako.db
 */
export function resolveDbPath(dbPath?: string): string {
  if (dbPath) return dbPath;
  const envDb = process.env.HAKO_DB;
  if (envDb) return envDb;
  return join(DEFAULT_DATA_DIR, "hako.db");
}

/**
 * Resolve the embedding cache path based on the database path.
 * Cache lives in the same directory as the database file.
 */
export function resolveCachePath(dbPath?: string): string {
  const resolvedDb = resolveDbPath(dbPath);
  return join(dirname(resolvedDb), "embedding_cache.db");
}

/**
 * Resolve config.toml path based on the database path.
 * Priority: DB directory config.toml > ~/.hako/config.toml > undefined (use defaults)
 */
export function resolveConfigPath(dbPath?: string): string | undefined {
  const resolvedDb = resolveDbPath(dbPath);
  const localConfig = join(dirname(resolvedDb), CONFIG_FILENAME);
  if (existsSync(localConfig)) return localConfig;

  const globalConfig = join(DEFAULT_DATA_DIR, CONFIG_FILENAME);
  if (existsSync(globalConfig)) return globalConfig;

  return undefined;
}

const DEFAULT_CONFIG: HakoConfig = {
  search: {
    rrf_k: 60,
    time_decay_half_life_days: 180.0,
    time_decay_floor: 0.1,
  },
  embedding: {
    model: "sirasagi62/ruri-v3-30m-ONNX",
    max_content_chars: 500,
  },
};

export function loadConfig(dbPath?: string): HakoConfig {
  const path = resolveConfigPath(dbPath);

  if (!path) {
    return DEFAULT_CONFIG;
  }

  const raw = readFileSync(path, "utf-8");
  const cfg = TOML.parse(raw) as Record<string, Record<string, unknown>>;

  return {
    search: { ...DEFAULT_CONFIG.search, ...cfg["search"] } as SearchConfig,
    embedding: {
      ...DEFAULT_CONFIG.embedding,
      ...cfg["embedding"],
    } as EmbeddingConfig,
  };
}

export function getSearchConfig(dbPath?: string): SearchConfig {
  return loadConfig(dbPath).search;
}

export function getEmbeddingConfig(dbPath?: string): EmbeddingConfig {
  return loadConfig(dbPath).embedding;
}
