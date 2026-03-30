export type Scope = "default" | "global";
export type Priority = "normal" | "high";
export type ScopeMode = "scoped" | "global_only" | "scoped_then_global" | "all";

export interface Entry {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly content: string | null;
  readonly url: string | null;
  readonly tags: string;
  readonly namespace: string;
  readonly scope: Scope;
  readonly priority: Priority;
  readonly happened_at: string;
  readonly created_at: string;
  readonly updated_at: string | null;
  readonly accessed_at: string;
  readonly access_count: number;
}

export interface SearchResult extends Entry {
  readonly score: number;
}

export interface SaveInput {
  readonly id?: string;
  readonly title: string;
  readonly content?: string | null;
  readonly source?: string;
  readonly url?: string | null;
  readonly tags?: string;
  readonly namespace?: string;
  readonly scope?: Scope;
  readonly priority?: Priority;
  readonly happened_at?: string | null;
}

export interface SaveOutput {
  readonly id: string;
  readonly status: "created" | "updated" | "skipped";
}

export interface SearchOptions {
  readonly source?: string;
  readonly namespace?: string;
  readonly scope_mode?: ScopeMode;
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

export interface NamespaceCount {
  readonly namespace: string;
  readonly count: number;
  readonly last_updated: string | null;
}

export interface Stats {
  readonly total_entries: number;
  readonly sources: readonly SourceCount[];
  readonly namespaces: readonly NamespaceCount[];
  readonly db_size_bytes: number;
  readonly db_size_mb: number;
}

export interface SearchConfig {
  readonly rrf_k: number;
  readonly time_decay_half_life_days: number;
  readonly time_decay_floor: number;
  readonly priority_boost: number;
  readonly namespace_boost: number;
  readonly max_entries: number;
}

export interface EmbeddingConfig {
  readonly model: string;
  readonly max_content_chars: number;
}

export interface HakoConfig {
  readonly search: SearchConfig;
  readonly embedding: EmbeddingConfig;
}

export interface ExportOptions {
  readonly source?: string;
  readonly namespace?: string;
  readonly since?: string;
  readonly until?: string;
}

export interface UpdateInput {
  readonly title?: string;
  readonly content?: string | null;
  readonly tags?: string;
  readonly url?: string | null;
  readonly scope?: Scope;
  readonly priority?: Priority;
  readonly namespace?: string;
  readonly source?: string;
}

export interface UpdateOutput {
  readonly id: string;
  readonly status: "updated" | "not_found";
}

export interface PageInfo {
  readonly title: string;
  readonly content: string;
  readonly url: string;
}
