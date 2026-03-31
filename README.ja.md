# Hako

Hakoはハイブリッド検索（全文検索 + ベクトル類似度）を備えたパーソナルナレッジストアです。設計判断、調査メモ、ブックマーク、会話の要点など、あとで思い出したいものを何でも保存し、プロジェクトを横断して即座に検索できます。

  * MCPサーバーとしてClaude CodeなどのAIアシスタントに長期記憶を与える
  * CLIツールとして他のツールと連携する
  * Node.jsライブラリとして自作ツールに組み込む
など用途に合わせて使い分けられます。

全文検索、ベクトル検索ともに日本語に最適化しています。データはSQLiteの単一ファイルとして保存され、単体で使う場合には全てローカルにのみ保存します。

## クイックスタート（MCP）
Node.js 20+が必要です。

あとはClaude Codeの設定ファイル（`~/.claude.json`）に追加するだけで使えます。

```json
{
  "mcpServers": {
    "hako": {
      "command": "npx",
      "args": ["-y", "hako-mcp", "serve"]
    }
  }
}
```

初回起動時に `~/.hako/hako.db` にデータベースが自動作成されます。

### カスタムDBパス

```json
{
  "mcpServers": {
    "hako": {
      "command": "npx",
      "args": ["-y", "hako-mcp", "serve"],
      "env": {
        "HAKO_DB": "/path/to/custom/hako.db"
      }
    }
  }
}
```

## MCPツール一覧

| ツール | 説明 |
|--------|------|
| `save` | エントリを保存（title, content, tags, namespace, scope, priority） |
| `search` | ハイブリッド検索（FTS5 + ベクトル）、scope_modeでフィルタリング |
| `update` | 既存エントリを部分更新（指定フィールドのみ変更） |
| `delete` | ID指定でエントリを削除 |
| `prune` | N日間アクセスされていないエントリを一括削除 |
| `stats` | エントリ数、DBサイズ、namespace別統計 |
| `list_namespaces` | 全namespaceの一覧（件数・最終更新日時） |

## 主要コンセプト

### Namespace

エントリが属するプロジェクトを識別します。自動解決の優先順位は次の通りです。

1. ツール呼び出し時の`namespace`パラメータ
2. `HAKO_PROJECT`環境変数
3. 現在の作業ディレクトリのGitルート（デフォルト）

### ScopeとPriority

**Scope** — プロジェクト間の可視性:

- `default` — そのプロジェクト内でのみ検索対象
- `global` — 全namespaceから検索可能（汎用的な設計原則など）

**Priority** — 重複排除と検索ランキングに影響:

- `high` — 明示的に保存されたエントリ。コサイン類似度 >= 0.90で重複排除。検索スコアx1.5
- `normal` — 自動キャプチャされたエントリ（トランスクリプトなど）。完全一致で重複排除されます

**scope_mode** — 検索時の対象範囲:

- `scoped_then_global`（デフォルト）— 現在のnamespace + 他namespaceのglobalエントリ
- `scoped` — 現在のnamespaceのみ
- `global_only` — globalエントリのみ
- `all` — 全namespaceを横断検索

## 検索アルゴリズム

1. FTS5（trigramトークナイザ）とvec0（256次元埋め込み）で並列検索し、各top 50件をランク付けの対象とします
2. Reciprocal Rank Fusionで統合します: `score = sum(1 / (k + rank + 1))`, k=60
3. スコアに時間減衰をかけます: `0.5 ^ (経過日数 / 180)`, 下限0.1（デフォルト）
4. 優先度に応じてスコアをブーストします（high = x1.5、scoped_then_globalでのnamespace一致 = x1.3）

埋め込みモデル: [ruri-v3-30m-ONNX](https://huggingface.co/sirasagi62/ruri-v3-30m-ONNX)（256次元、日本語に最適化）。Transformers.jsによりローカルで実行されます。

## トランスクリプト取り込み

Claude CodeのセッションログをQ&Aのペアとして保存できます。

```bash
cat transcript.jsonl | hako-mcp save-transcript
hako-mcp save-transcript transcript.jsonl
hako-mcp save-transcript --namespace /path/to/project < transcript.jsonl
```

`source: "transcript"`, `priority: "normal"` で保存されます。完全一致による重複排除があるため、同じファイルを再度取り込んでも重複は発生しません。

## Claude Codeにhakoを使わせる

MCPサーバーをインストールするとツールは利用可能になりますが、Claude Codeが自動的に使い始めるわけではありません。**いつ保存・検索するか**を`CLAUDE.md`（プロジェクト単位またはグローバル）で指示する必要があります。

### 最小構成の例

```markdown
# hako（長期記憶）

## 検索
- 作業開始前に hako を検索し、過去の判断や経緯を確認する
- コードを読めば「何をしているか」はわかるが、「なぜそうなったか」は hako にある

## 保存
- 議論の結果、重要な判断・結論・方針が出たら保存する
- プロジェクトを問わず再利用できる知識は scope "global" で保存する
```

### ソフトウェア開発向けの例

```markdown
# hako（長期記憶）

## 検索
- コード修正前に、その領域に関する過去の設計判断を検索する
- ユーザーが経緯を意識していない場合でも、自分から検索して必要なら共有する

## 保存
- 設計判断とその理由を保存する（「X ではなく Y を選んだ。理由は...」）
- 調査結果やバグの原因分析を保存する
- アーキテクチャ上の制約やトレードオフを保存する
- 言語やフレームワークレベルの知見は scope "global" で保存する
```

### リサーチ・メモ取り向けの例

```markdown
# hako（長期記憶）

## 検索
- 過去に議論したトピックについて聞かれたら hako を検索する
- scope_mode "all" で関連エントリを横断検索する

## 保存
- 調査の要点、結論、出典を保存する
- ユーザーの好みや繰り返し出る指示を保存する
- 特定プロジェクトに紐づかない一般知識は scope "global" で保存する
```

## パッケージ構成

| パッケージ | 説明 |
|------------|------|
| [hako-mcp](packages/hako-mcp) | MCPサーバー（AIアシスタント連携） |
| [hako-db](packages/hako-db) | コアライブラリ（Node.jsバックエンドに組み込み可能） |
| [hako-cli](packages/hako-cli) | CLIツール |
| [hako-sync](packages/hako-sync) | Git + JSONL oplogによるマルチマシン同期 |

依存方向: hako-cli -> hako-sync -> hako-db, hako-mcp -> hako-db

## CLI

```bash
hako add --title "Meeting notes" --content "Discussed Q3 roadmap" --tags "meeting,roadmap"
hako web https://example.com --tags "reference"
hako search "roadmap planning"
hako list --since 2025-01-01 --limit 50
hako show V1StGXR8_Z5jdHi
hako delete V1StGXR8_Z5jdHi
hako stats
hako --db ~/work/hako.db search "meeting"
```

## ライブラリ

```typescript
import { Hako } from 'hako-db'

const hako = new Hako()                              // ~/.hako/hako.db
const { id, status } = await hako.save({
  title: 'Design doc',
  content: 'Architecture overview...',
  source: 'notes',
  tags: 'architecture,design',
})
const results = await hako.search('architecture', { limit: 10 })
hako.close()
```

## マルチ端末同期

HakoのDBを複数台の端末で同期したい場合に使います。Gitリポジトリを介してデータを同期し、各マシンが独立したJSONL oplogを持つためコンフリクトは発生しません。Gitコマンドが使用可能な環境が必要です。

### 1台目のセットアップ

まずGitHub等にプライベートリポジトリを作成し、DBと同じパス（デフォルトは`~/.hako`）に`config.toml`を配置します。

```toml
# ~/.hako/config.toml
[sync]
# 同期用Gitリポジトリのローカルパス
repo = "~/.hako/sync"

# この端末の識別名（他の端末と重複しない名前にしてください）
machine_id = "macbook"

# これより古いエントリは取り込みをスキップします
import_max_age_days = 90
```

initコマンドでローカルリポジトリの作成とマシンディレクトリの初期化を行います。その後、リモートを設定して最初のpushを行います。

```bash
hako sync init
git -C ~/.hako/sync remote add origin git@github.com:user/hako-sync.git
hako sync push
```

### 2台目以降のセットアップ

リモートリポジトリをcloneしてから、同様に`config.toml`を配置します。

```bash
git clone git@github.com:user/hako-sync.git ~/.hako/sync
```

```toml
# ~/.hako/config.toml
[sync]
repo = "~/.hako/sync"
machine_id = "mac-mini"       # 1台目とは異なる名前
import_max_age_days = 90
```

```bash
hako sync init                # このマシンのディレクトリを作成
hako sync pull                # 他のマシンのデータを取り込み
```

### 日常の使い方

```bash
hako sync pull     # リモートの変更を取り込む
hako sync push     # ローカルの変更をエクスポート → Git commit & push
hako sync status   # 同期状態を表示
```

### Claude Codeとの連携（hooks）

Claude Codeのhooksを設定すると、セッションの開始・終了時に自動で同期できます。

`~/.claude/settings.json`に以下を追加します。

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "npx -y hako-cli sync pull"
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "npx -y hako-cli sync pull && npx -y hako-cli sync push"
      }
    ]
  }
}
```

`npm install -g hako-cli`でグローバルインストールしている場合は、`command`を`hako sync pull`のように直接指定することもできます。

## データの保存場所

| パス | 用途 |
|------|------|
| `~/.hako/hako.db` | メインデータベース（デフォルト） |
| `~/.hako/embedding_cache.db` | 埋め込みキャッシュ |
| `~/.hako/config.toml` | ユーザー設定（オプション） |
| `~/.hako/sync-state.json` | 同期状態（ローカルのみ） |
| `~/.cache/huggingface/hub/` | ONNXモデルキャッシュ |

DBパスの優先順位: `--db`フラグ > `HAKO_DB`環境変数 > `~/.hako/hako.db`

## 設定

`<db-dir>/config.toml` > `~/.hako/config.toml` > ビルトインデフォルト:

```toml
[search]
# Reciprocal Rank Fusionのパラメータ。
# 値が大きいほど順位差による影響が緩やかになります。通常は変更不要です。
rrf_k = 60

# 時間減衰によってスコアが半減するまでの日数。
# 小さくすると古いエントリがヒットしにくくなります。
time_decay_half_life_days = 180.0

# 時間減衰の下限値。
# どれだけ古くても、スコアがこの割合を下回ることはありません。
time_decay_floor = 0.1

[embedding]
# ベクトル検索に使う埋め込みモデル。
# ruri-v3-30m-ONNXは日本語に最適化された軽量モデルです。
model = "sirasagi62/ruri-v3-30m-ONNX"

# 埋め込み生成時に使うcontentの最大文字数。
# titleは全文使われ、contentはこの文字数で切り詰められます。
# モデルの入力長に依存するため、大幅に増やしても精度は上がりません。
max_content_chars = 500

[sync]
repo = "~/.hako/sync"
machine_id = "macbook"
import_max_age_days = 90
```

## 開発

```bash
pnpm install
pnpm --filter hako-db test       # ライブラリテスト
pnpm --filter hako-mcp test      # MCPサーバーテスト
pnpm --filter hako-sync test     # 同期テスト
pnpm build                       # 全パッケージビルド
```

## 技術スタック

- **DB**: better-sqlite3 + sqlite-vec + FTS5 trigram
- **ID**: nanoid
- **Embedding**: @huggingface/transformers (ONNX)
- **MCP**: @modelcontextprotocol/sdk (stdio)
- **Sync**: Git + JSONL oplog
- **Build**: tsup (ESM), vitest, pnpm workspaces

## License

MIT
