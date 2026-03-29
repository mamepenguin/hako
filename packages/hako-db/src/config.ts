import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import TOML from "@iarna/toml";
import type { HakoConfig, SearchConfig, EmbeddingConfig } from "./types.js";

export const DATA_DIR = join(homedir(), ".hako");
export const CONFIG_PATH = join(DATA_DIR, "config.toml");

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

export function loadConfig(configPath?: string): HakoConfig {
  const path = configPath ?? CONFIG_PATH;

  if (!existsSync(path)) {
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

export function getSearchConfig(configPath?: string): SearchConfig {
  return loadConfig(configPath).search;
}

export function getEmbeddingConfig(configPath?: string): EmbeddingConfig {
  return loadConfig(configPath).embedding;
}
