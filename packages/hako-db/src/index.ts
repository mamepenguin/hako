import type Database from "better-sqlite3";
import {
  getConnection,
  deleteEntry,
  getEntry,
  listEntries,
  listSources,
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
  Stats,
} from "./types.js";

export interface HakoOptions {
  readonly dbPath?: string;
}

export class Hako {
  private readonly db: Database.Database;
  private readonly dbPath: string | undefined;

  constructor(options?: HakoOptions) {
    this.dbPath = options?.dbPath;
    this.db = getConnection(this.dbPath);
  }

  async save(input: SaveInput): Promise<SaveOutput> {
    return saveEntry(this.db, input);
  }

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    return hybridSearch(this.db, query, options);
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

  sources(): SourceCount[] {
    return listSources(this.db);
  }

  stats(): Stats {
    return getStats(this.db, this.dbPath);
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
  Stats,
  PageInfo,
} from "./types.js";

// Re-export fetchers
export { fetchPage } from "./fetchers/web.js";
