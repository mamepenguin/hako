export interface SyncConfig {
  readonly repo: string;
  readonly machine_id: string;
  readonly import_max_age_days: number;
  readonly compaction_threshold: number;
}

export interface SyncEntry {
  readonly source: string;
  readonly title: string;
  readonly content: string | null;
  readonly url: string | null;
  readonly namespace: string;
  readonly scope: string;
  readonly priority: string;
  readonly happened_at: string;
  readonly created_at: string;
  readonly tags: string;
}

export interface OpAdd {
  readonly op: "add";
  readonly id: string;
  readonly ts: string;
  readonly entry: SyncEntry;
}

export interface OpDelete {
  readonly op: "delete";
  readonly id: string;
  readonly ts: string;
}

export type Op = OpAdd | OpDelete;

export interface SyncState {
  readonly machine_id: string;
  readonly last_push_ids: readonly string[];
  readonly offsets: Readonly<Record<string, number>>;
  readonly epochs: Readonly<Record<string, number>>;
}

export interface PushResult {
  readonly added: number;
  readonly deleted: number;
  readonly committed: boolean;
  readonly compacted: boolean;
}

export interface PullResult {
  readonly added: number;
  readonly deleted: number;
  readonly skipped: number;
}

export interface SyncStatus {
  readonly unpushed_adds: number;
  readonly unpushed_deletes: number;
  readonly unread_machines: number;
  readonly last_push_at: string | null;
}
