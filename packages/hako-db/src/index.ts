import type Database from "better-sqlite3";
import { resolveDbPath, resolveCachePath, getSearchConfig } from "./config.js";
import {
  getConnection,
  deleteEntry,
  getEntry,
  listEntries,
  listSources,
  listNamespaces,
  pruneEntries,
  getStats,
} from "./db.js";
import { saveEntry } from "./save.js";
import { hybridSearch } from "./search.js";
import type {
  Entry,
  SaveInput,
  SaveOutput,
  SearchOptions,
  SearchResult,
  ListOptions,
  SourceCount,
  NamespaceCount,
  Stats,
} from "./types.js";

export interface HakoOptions {
  readonly dbPath?: string;
}

export class Hako {
  private readonly db: Database.Database;
  private readonly resolvedDbPath: string;
  private readonly cachePath: string;

  constructor(options?: HakoOptions) {
    this.resolvedDbPath = resolveDbPath(options?.dbPath);
    this.cachePath = resolveCachePath(options?.dbPath);
    this.db = getConnection(this.resolvedDbPath);
  }

  async save(input: SaveInput): Promise<SaveOutput> {
    const cfg = getSearchConfig(this.resolvedDbPath);
    return saveEntry(this.db, input, {
      cachePath: this.cachePath,
      maxEntries: cfg.max_entries,
    });
  }

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    return hybridSearch(this.db, query, {
      ...options,
      dbPath: this.resolvedDbPath,
    });
  }

  get(id: number): Entry | null {
    return getEntry(this.db, id);
  }

  list(options?: ListOptions): Entry[] {
    return listEntries(this.db, options);
  }

  delete(id: number): boolean {
    return deleteEntry(this.db, id);
  }

  prune(olderThanDays: number = 90): number {
    return pruneEntries(this.db, olderThanDays);
  }

  sources(): SourceCount[] {
    return listSources(this.db);
  }

  namespaces(): NamespaceCount[] {
    return listNamespaces(this.db);
  }

  stats(): Stats {
    return getStats(this.db, this.resolvedDbPath);
  }

  close(): void {
    this.db.close();
  }
}

// Re-export types
export type {
  Entry,
  SaveInput,
  SaveOutput,
  SearchOptions,
  SearchResult,
  ListOptions,
  SourceCount,
  NamespaceCount,
  Stats,
  PageInfo,
  Scope,
  Priority,
  ScopeMode,
} from "./types.js";

// Re-export fetchers
export { fetchPage } from "./fetchers/web.js";
