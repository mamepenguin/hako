export interface Entry {
  readonly id: number;
  readonly source: string;
  readonly title: string;
  readonly content: string | null;
  readonly url: string | null;
  readonly tags: string;
  readonly happened_at: string;
  readonly created_at: string;
  readonly accessed_at: string;
  readonly access_count: number;
}

export interface SearchResult extends Entry {
  readonly score: number;
}

export interface SaveInput {
  readonly title: string;
  readonly content?: string | null;
  readonly source?: string;
  readonly url?: string | null;
  readonly tags?: string;
  readonly happened_at?: string | null;
}

export interface SaveOutput {
  readonly id: number;
  readonly status: "created" | "updated" | "skipped";
}

export interface SearchOptions {
  readonly source?: string;
  readonly limit?: number;
}

export interface ListOptions {
  readonly source?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

export interface SourceCount {
  readonly source: string;
  readonly count: number;
}

export interface Stats {
  readonly total_entries: number;
  readonly sources: readonly SourceCount[];
  readonly db_size_bytes: number;
  readonly db_size_mb: number;
}

export interface SearchConfig {
  readonly rrf_k: number;
  readonly time_decay_half_life_days: number;
  readonly time_decay_floor: number;
}

export interface EmbeddingConfig {
  readonly model: string;
  readonly max_content_chars: number;
}

export interface KuraConfig {
  readonly search: SearchConfig;
  readonly embedding: EmbeddingConfig;
}

export interface PageInfo {
  readonly title: string;
  readonly content: string;
  readonly url: string;
}
