# Hako: JSON Export & Explicit Update

Date: 2026-03-30

## Overview

hako-db に2つの機能を追加する:

1. **JSON Export** — フィルタ付きの JSONL エクスポート
2. **Explicit Update** — パーシャルアップデート（指定フィールドのみ更新）

加えて、update が sync で正しく伝播するよう hako-sync の push ロジックを拡張する。

## 1. JSON Export

### 要件

- フィルタ: source, namespace, since, until（すべて optional）
- limit なし（全件出力）
- 出力フォーマット: JSONL（1行1エントリ）
- 全フィールドをそのまま出力

### データ型

```typescript
// types.ts
export interface ExportOptions {
  readonly source?: string
  readonly namespace?: string
  readonly since?: string
  readonly until?: string
}
```

### hako-db API

```typescript
// Hako class
exportEntries(options?: ExportOptions): Entry[]
```

`listEntries` と同様のクエリだが `limit` なし、`namespace` フィルタ追加。`since`/`until` は `happened_at` カラムでフィルタ（`listEntries` と同じ）。

### hako-cli

```bash
hako export [--source <source>] [--namespace <ns>] [--since <date>] [--until <date>] [--output <file>]
```

- デフォルト: stdout に JSONL 出力
- `--output` 指定時: ファイルに書き出し、件数を stderr に表示

### hako-mcp

エクスポートは MCP に追加しない。MCP 経由でファイル書き出しするユースケースが薄いため。

## 2. Explicit Update

### 要件

- パーシャルアップデート: 指定フィールドのみ更新、未指定は変更なし
- `undefined` = 変更なし、`null` = フィールドをクリア
- title か content が変わった場合のみエンベディング再計算
- `updated_at` を自動設定
- 存在しない ID は `not_found` を返す

### データ型

```typescript
// types.ts
export interface UpdateInput {
  readonly title?: string
  readonly content?: string | null
  readonly tags?: string
  readonly url?: string | null
  readonly scope?: Scope
  readonly priority?: Priority
  readonly namespace?: string
  readonly source?: string
}

export interface UpdateOutput {
  readonly id: string
  readonly status: "updated" | "not_found"
}
```

### hako-db API

```typescript
// Hako class
async update(id: string, fields: UpdateInput): Promise<UpdateOutput>
```

### ロジック (db.ts)

1. `getEntry()` で既存エントリ取得。なければ `{ id, status: "not_found" }` を返す
2. 指定フィールドだけマージした UPDATE 文を構築
3. エンベディング再計算の判定:
   ```typescript
   const titleChanged = fields.title !== undefined && fields.title !== existing.title
   const contentChanged = fields.content !== undefined && fields.content !== existing.content
   const needsReembed = titleChanged || contentChanged
   ```
4. `needsReembed` の場合、新しい title/content でエンベディングを計算し `entries_vec` を更新
5. `updated_at` を自動設定
6. `{ id, status: "updated" }` を返す

### URL ユニーク制約

update で `url` を変更する場合、`idx_entries_url` のユニーク制約に抵触する可能性がある。SQLite の UNIQUE constraint エラーをキャッチし、`Error("URL already exists: <url>")` を throw する。

### トランザクション

`updateEntry` は read → update entries → update entries_vec を一つの SQLite トランザクションで包む（`db.transaction()` を使用）。

### null セマンティクスの明確化

- `undefined` = 変更なし（フィールド未指定）
- `null` = フィールドをクリア。**nullable カラム（`content`, `url`）のみ適用**
- `tags`, `namespace`, `source` 等の非 nullable フィールドは `""` でリセット

### MCP バリデーション

MCP handler 側でも `id` 以外のフィールドが1つも指定されていない場合はエラーを返す。

### hako-cli

```bash
hako update <id> [--title <title>] [--content <content>] [--tags <tags>] [--url <url>]
                 [--scope <scope>] [--priority <priority>] [--namespace <ns>] [--source <source>]
```

- 少なくとも1つのフィールドが指定されていなければエラー
- 更新後にエントリの概要を表示
- `not_found` の場合はエラーメッセージ + exit 1

### hako-mcp

```typescript
{
  name: "update",
  description: "Update an existing entry by ID. Only specified fields are updated.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The ID of the entry to update" },
      title: { type: "string", description: "New title" },
      content: { type: ["string", "null"], description: "New content (null to clear)" },
      tags: { type: "string", description: "New comma-separated tags" },
      url: { type: ["string", "null"], description: "New URL (null to clear)" },
      scope: { type: "string", enum: ["default", "global"] },
      priority: { type: "string", enum: ["normal", "high"] },
      namespace: { type: "string" },
      source: { type: "string" },
    },
    required: ["id"],
  },
}
```

## 3. Sync 対応 (hako-sync)

### 問題

現状の push は ID の差分（新規/削除）のみ検出する。update でエントリ内容が変わっても、ID は変わらないため sync に反映されない。

### 解決策: `op:update` の新設

`op:delete` + `op:add` で表現する案は、pull 側の delete-wins ロジック（`deleteIds.has(op.id)` で add を skip）により、update したエントリが pull 先で消失する問題がある。

そのため `op:update` を新設する。

### 変更内容

#### OpUpdate 型の追加

```typescript
// types.ts
export interface OpUpdate {
  readonly op: "update"
  readonly id: string
  readonly ts: string
  readonly entry: SyncEntry   // 更新後の全フィールド
}

export type Op = OpAdd | OpDelete | OpUpdate
```

#### SyncState に `last_push_at` を追加

```typescript
export interface SyncState {
  readonly machine_id: string
  readonly last_push_ids: readonly string[]
  readonly last_push_at: string | null   // 追加
  readonly offsets: Readonly<Record<string, number>>
  readonly epochs: Readonly<Record<string, number>>
}
```

後方互換: 既存の `sync-state.json` に `last_push_at` がない場合は `null` として扱う。`last_push_at === null` の場合、update 検出をスキップする（初回 push 扱い）。

#### PushResult に `updated` を追加

```typescript
export interface PushResult {
  readonly added: number
  readonly deleted: number
  readonly updated: number   // 追加
  readonly committed: boolean
  readonly compacted: boolean
}
```

#### push ロジックの拡張

```
既存: newIds = currentIds - lastPushIds → op:add
既存: deletedIds = lastPushIds - currentIds → op:delete
追加: updatedIds = (currentIds ∩ lastPushIds) のうち updated_at > last_push_at → op:update
```

パフォーマンス最適化のため、hako-db に `getUpdatedSince(since: string): Entry[]` メソッドを追加。`WHERE updated_at > ?` で DB 側でフィルタし、全フィールドを含む `Entry[]` を返す（`OpUpdate.entry` の構築に必要）。返った結果を `currentIds ∩ lastPushIds` でアプリケーション側フィルタする（SQLite パラメータ上限を回避）。

コミットメッセージ: `sync: <machine_id> +N -N ~N`（`~` が update 数）

#### pull 側の変更

`op:update` の処理を追加:

1. 対象 ID のエントリがローカルに存在する場合 → delete + save with `id: op.id`（内容を上書き。delete が先でないと ID-based dedup で skip される）
2. 存在しない場合 → save with `id: op.id`（新規作成として扱う、冪等性を確保）
3. `deleteIds` による skip は `op:update` には適用しない。op:update は op:delete より無条件に優先する（タイムスタンプ比較なし）。意図: いずれかのマシンがエントリを更新する価値があると判断したなら、そのエントリは生存すべき

#### compaction との相互作用

compaction は全エントリを `op:add` として書き直す。compaction 後に他マシンが pull すると epoch 変更により offset=0 から再読み込みするが、既存 ID の `op:add` は現状 skip される。これにより update 済みエントリの変更が伝播しない。

**対策**: pull 側で epoch 変更を検出した場合（= compaction 後の再読み込み）、`op:add` を upsert として扱う。具体的には、既存 ID のエントリに対して delete + save を行い、最新の内容で上書きする。これは `op:update` の pull ロジックと同じ処理。

この変更により、compaction 経由でも update 内容が正しく伝播する。なお、このupsert動作は他マシンの ops にのみ適用される（自マシンは pull で既にフィルタ済み）。

#### push での `last_push_at` の保存

`saveState` 時に `last_push_at: ts`（push 実行時のタイムスタンプ）を保存する。

#### pull での `last_push_at` の保持

`pull` が `saveState` する際、既存の `last_push_at` をそのまま保持する（`loadState` から読んだ値をスプレッド）。

#### `SyncStatus.last_push_at` の修正

`status.ts` の `SyncStatus.last_push_at` は現在 `new Date().toISOString()` を返しているが、これは不正確。`state.last_push_at` を返すように修正する。

#### oplog バリデーション

`isValidOp` に `op: "update"` を追加。`op:add` と同じバリデーション（`entry` オブジェクトに `title` と `happened_at` が必要）。古いバージョンの hako-sync が `op:update` を読んだ場合は `isValidOp` が false を返し、行がスキップされる（エラーにはならない）。

## 4. 変更ファイル一覧

### hako-db (packages/hako-db/)

| ファイル | 変更内容 |
|---|---|
| `src/types.ts` | `UpdateInput`, `UpdateOutput`, `ExportOptions` 追加 |
| `src/db.ts` | `updateEntry()`, `exportEntries()`, `getUpdatedSince()` 追加 |
| `src/index.ts` | `Hako.update()`, `Hako.exportEntries()`, `Hako.getUpdatedSince()` 追加、型の re-export |

### hako-cli (packages/hako-cli/)

| ファイル | 変更内容 |
|---|---|
| `src/index.ts` | `hako export` コマンド、`hako update <id>` コマンド追加 |

### hako-mcp (packages/hako-mcp/)

| ファイル | 変更内容 |
|---|---|
| `src/server.ts` | `update` ツール追加 |

### hako-sync (packages/hako-sync/)

| ファイル | 変更内容 |
|---|---|
| `src/types.ts` | `OpUpdate` 追加、`SyncState.last_push_at` 追加、`PushResult.updated` 追加 |
| `src/push.ts` | updated エントリの検出 + `op:update` 生成 |
| `src/pull.ts` | `op:update` の処理追加（delete + save で上書き） |
| `src/oplog.ts` | `op:update` のバリデーション追加 |
| `src/state.ts` | `last_push_at` の読み書き対応 |
| `src/status.ts` | `last_push_at` を state から読むように修正 |

### テスト

| 対象 | 内容 |
|---|---|
| hako-db | update: 部分更新、not_found、エンベディング再計算、URL重複エラー |
| hako-db | export: フィルタ、全件出力 |
| hako-mcp | update ツール |
| hako-sync | push: updated エントリ検出、pull: op:update 処理、compaction 後の upsert 動作 |
