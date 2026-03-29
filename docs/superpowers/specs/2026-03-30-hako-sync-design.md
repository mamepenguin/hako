# hako-sync 設計書

2026-03-30

---

## 概要

複数マシン間で hako データを同期するパッケージ。Git リポジトリ + JSONL oplog 方式で、マシン別ファイルによりコンフリクトを完全回避する。

ユースケース: 昼は外で MacBook、夜は自宅で Mac mini など、複数マシンで Claude Code を切り替えながら使う際に、記憶（hako エントリ）を途切れなく引き継ぐ。

### 設計原則

- hako-db はsyncの存在を知らない（依存方向: hako-sync → hako-db）
- sync はオプション機能。config.toml に `[sync]` セクションがなければ一切影響しない
- priority=normal（transcript）も priority=high（明示保存）も両方同期対象

---

## 同期モデル: Oplog + delete-wins

各マシンが自分の操作ログ（oplog）を追記専用の JSONL ファイルに書き出し、Git で共有する。

### JSONL フォーマット

```jsonl
{"op":"add","id":"V1StGXR8_Z5jdHi","ts":"2026-03-29T21:00:00","entry":{"source":"transcript","title":"...","content":"...","url":null,"tags":"","namespace":"/Users/libre/Sources/X","scope":"default","priority":"normal","happened_at":"2026-03-29T20:55:00","created_at":"2026-03-29T20:55:00"}}
{"op":"delete","id":"V1StGXR8_Z5jdHi","ts":"2026-03-30T10:00:00"}
```

- `op:add` — エントリの追加。entry には embedding を含めない（ローカルで再計算）
- `op:delete` — エントリの削除（prune を含む）
- **delete-wins**: あるIDに対して add と delete が両方存在すれば、delete が勝つ

### Nano ID（グローバル一意ID）

同期のため、エントリIDを `INTEGER AUTOINCREMENT` から `TEXT`（Nano ID）に変更する。

```sql
-- 変更前
id INTEGER PRIMARY KEY AUTOINCREMENT
-- 変更後
id TEXT PRIMARY KEY
```

- Nano ID は各マシンで独立に生成しても衝突しない
- delete の tombstone が ID で一意にエントリを特定できる
- `nanoid` パッケージ（v5、ESM native）を使用

---

## 同期リポジトリ構造

```
~/.hako/sync/                    <- Git repo（ユーザーが git clone で用意）
├── macbook/
│   └── ops.jsonl                <- MacBook の oplog（追記のみ）
└── mac-mini/
    └── ops.jsonl                <- Mac mini の oplog（追記のみ）
```

sync state（読み込み位置、前回push時のIDセット）は **Git リポジトリの外** に保存する。
Git リポジトリ内に置くと、複数マシンの state 書き込みがコンフリクトするため。

```
~/.hako/sync-state.json          <- ローカル専用、Git管理外
```

---

## 差分検出方式

hako-db に操作ログテーブルは追加しない。hako-sync が外側から差分を検出する。

```
push 時:
  1. SELECT id FROM entries → 現在のIDセット
  2. sync-state.json の last_push_ids と比較
  3. 新規ID（現在にあって前回にない） → op:add を追記
  4. 消失ID（前回にあって現在にない） → op:delete を追記
  5. last_push_ids を現在のIDセットに更新
```

---

## 同期フロー

### push

```
hako sync push:
  1. 現在のDBからIDセットを取得
  2. sync-state.json の last_push_ids と比較して差分を検出
  3. 新規エントリを getMany() で取得し、op:add として ops.jsonl に追記
  4. 消失エントリを op:delete として ops.jsonl に追記
  5. sync-state.json の last_push_ids を更新
  6. git add → commit → push
```

### pull

```
hako sync pull:
  1. git pull
  2. 他マシンの ops.jsonl を前回 offset 以降から読み込み
  3. 全 op:delete の ID を収集（delete-wins の準備）
  4. op:delete → hako.delete() で削除
  5. op:add → delete 対象でなく、かつ age フィルタを通過すれば hako.save() で import
  6. sync-state.json の offset を更新
```

### delete-wins の実装

pull 時に、まず全ての delete ID を収集してから add を処理する。
delete 対象の ID は add をスキップする。順序に依存しない。

---

## prune との整合性

### 問題

マシンA で prune されたエントリが、マシンB の oplog に op:add として残っている場合、
マシンA が pull すると復活してしまう。

### 解決策: import 時の age フィルタ

hako-db の prune には制約を加えない。hako-sync 側で import 時にフィルタする。

```toml
[sync]
repo = "~/.hako/sync"
machine_id = "macbook"
import_max_age_days = 90     # これより古いエントリは import しない
```

- prune の日数と `import_max_age_days` を同じ値にすることを推奨
- `import_max_age_days > prune日数` にするとゾンビ化するため非推奨
- age の判定基準は `happened_at`（エントリの発生日時）

### prune 時の挙動

- ローカルで prune → DB からエントリ削除
- 次回 push → 差分検出で「消失ID」を検知 → op:delete が oplog に追記
- 他マシンが pull → op:delete により該当エントリが削除される

---

## hako-db への変更

### 1. ID を Nano ID に変更

```typescript
// types.ts
interface Entry {
  readonly id: string;  // number → string
  // ...
}

interface SaveInput {
  readonly id?: string;  // 新規: sync import 時に ID を指定可能
  // ...
}

interface SaveOutput {
  readonly id: string;  // number → string
  // ...
}
```

### 2. vec0 の entry_id も TEXT に

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS entries_vec USING vec0(
    entry_id TEXT PRIMARY KEY,
    embedding FLOAT[256]
);
```

vec0 の TEXT PRIMARY KEY サポートを事前に検証する必要がある。
サポートされない場合は、別途 integer surrogate key + mapping テーブルで対応。

### 3. FTS5 の rowid マッピング変更

TEXT PK になると `content_rowid='id'` が使えなくなる。
SQLite の暗黙 rowid を使用するように変更:

```sql
-- content_rowid='id' → content_rowid='rowid'（SQLite暗黙rowid）
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    title, content, tags,
    content='entries',
    content_rowid='rowid',
    tokenize='trigram'
);
```

トリガーも `new.id` → `new.rowid` に変更。
search.ts の JOIN も `f.rowid = e.id` → `f.rowid = e.rowid` に変更。

### 4. BigInt 変換の除去

vec0 の entry_id が TEXT になるため、`BigInt()` 変換が不要になる。

### 5. Export API の追加

```typescript
// Hako class に追加
allIds(): string[]           // SELECT id FROM entries
getMany(ids: string[]): Entry[]  // accessed_at を更新しない読み取り専用
```

### 6. SaveInput.id のサポート

sync import 時にオリジナルの Nano ID を保持するため、`save()` に ID 指定を追加。
指定された ID が既に存在する場合は skip（PRIMARY KEY 重複回避）。

### 7. マイグレーション

既存の INTEGER id → Nano ID への変換:
1. 全エントリを読み込み
2. entries_vec, entries_fts, triggers を DROP
3. entries を RENAME → entries_old
4. 新スキーマで entries を作成
5. Nano ID を生成しながら INSERT
6. entries_old を DROP
7. FTS, vec0, triggers を再作成（vec0 の embedding は embedding cache から復元）

---

## パッケージ構成

```
packages/hako-sync/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── src/
│   ├── index.ts          # エクスポート
│   ├── types.ts          # SyncConfig, Op, SyncEntry, SyncState 等
│   ├── config.ts         # config.toml の [sync] セクション読み込み
│   ├── git.ts            # Git 操作（pull, push, commit）child_process.execFile
│   ├── oplog.ts          # ops.jsonl の読み書き
│   ├── state.ts          # sync-state.json の読み書き
│   ├── push.ts           # push ロジック
│   ├── pull.ts           # pull ロジック（age フィルタ、delete-wins）
│   ├── status.ts         # 同期状態の表示
│   └── init.ts           # sync リポジトリの初期化
└── tests/
    ├── oplog.test.ts
    ├── state.test.ts
    ├── git.test.ts
    ├── sync.test.ts      # 2マシンシミュレーション統合テスト
    └── prune-sync.test.ts
```

依存: `hako-db`（workspace:*）、`@iarna/toml`

---

## CLI コマンド

```bash
hako sync init [--remote <url>]    # sync リポジトリの初期化 / clone
hako sync push                     # ローカル変更を push
hako sync pull                     # リモート変更を pull & import
hako sync status                   # 未 push 件数、最終同期時刻
```

hako-cli に `sync` サブコマンドグループとして追加。
`[sync]` セクション未設定の場合は「sync が設定されていません」とガイドを表示。

---

## config.toml

```toml
[sync]
repo = "~/.hako/sync"           # sync Git リポジトリのローカルパス
machine_id = "macbook"           # このマシンの識別子
import_max_age_days = 90         # これより古いエントリは import しない（デフォルト: 90）
```

- `repo`: ユーザーが事前に `git clone` で用意する
- `machine_id`: ops.jsonl のディレクトリ名に使用
- Git remote URL やブランチは Git リポジトリ自身の設定に委ねる

---

## 技術的リスクと対策

| リスク | 影響 | 対策 |
|--------|------|------|
| vec0 が TEXT PK をサポートしない | Phase 1 がブロック | 事前に検証。非対応なら integer surrogate + mapping |
| FTS5 の暗黙 rowid 変更 | 検索結果の不整合 | content_rowid='rowid' のテストを先行実施 |
| 同時 push で git push 失敗 | push が失敗する | エラーメッセージで「pull してから再度 push」をガイド |
| oplog 肥大化 | 数年後にファイルサイズ増大 | 将来 `hako sync compact` で対応（v1 スコープ外） |
| マイグレーション中の embedding 消失 | 最初の検索が vec なし | embedding cache から復元、または初回アクセス時に再計算 |

---

## スコープ外

- oplog の compaction（将来の `hako sync compact`）
- Web UI での同期管理
- 3台以上のマシンでの動作検証（設計上は N 台対応だが、テストは2台）
- リアルタイム同期（常にオフライン前提の push/pull モデル）
