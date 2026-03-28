# Lifelog Core 設計書

2026-03-28

---

## 概要

個人の情報（Web記事、メール、メモ、AIチャット等）を蓄積し、ハイブリッド検索で取り出すコアシステム。保存はシンプルに行い、検索時にAIが解釈・要約する設計思想に基づく。

入力元との連携（Telegram Bot、ブラウザ拡張等）は本スコープ外。CLIで動作するコアの蓄積・検索エンジンを構築する。

---

## 技術スタック

| 項目 | 選定 | 理由 |
|---|---|---|
| 言語 | Python | Embedding推論(PyTorch/sentence-transformers)との親和性 |
| パッケージ管理 | uv | 高速な依存解決、重い依存(PyTorch等)に有利 |
| DB | SQLite + FTS5 + sqlite-vec | engramで実績あり。ローカル完結 |
| Embedding | cl-nagoya/ruri-v3-310m (768次元) | 日本語に強い軽量モデル。sentence-transformersで直接ロード |
| CLI | Typer or Click | サブコマンド体系に適合 |

---

## データモデル

### entries テーブル

```sql
CREATE TABLE entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT DEFAULT '',
    title         TEXT NOT NULL,
    content       TEXT,
    url           TEXT,
    happened_at   TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
    tags          TEXT DEFAULT '',
    accessed_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
    access_count  INTEGER DEFAULT 0
);
```

### カラム設計の根拠

- **source**: 入力元を示す自由テキスト（`'email'`, `'web'`, `'craft'`等）。スキーマレベルでは値を制限しない。検索時の事前フィルタに使用。入力プラグインが自己申告する。
- **happened_at / created_at の分離**: happened_atは情報の発生日時（記事の閲覧日、メール受信日等）。created_atはDB保存日時。Gmailから3日後にインポートしてもhappened_atは受信日。時系列の振り返りと時間減衰の基準はhappened_at。
- **accessed_at / access_count**: LRU管理用。将来の容量管理に備える。
- **tags**: カンマ区切りの自由テキスト。入力プラグインが設定する追加メタデータ。

### FTS5 (キーワード検索)

```sql
CREATE VIRTUAL TABLE entries_fts USING fts5(
    title, content,
    content='entries',
    content_rowid='id',
    tokenize='trigram'
);
```

- 外部コンテンツモードでデータ重複を回避
- trigram tokenizerで日本語に対応（engramと同方式）
- トリガーで自動同期:

```sql
CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
END;

CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO entries_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
END;
```

### sqlite-vec (セマンティック検索)

```sql
CREATE VIRTUAL TABLE entries_vec USING vec0(
    entry_id INTEGER PRIMARY KEY,
    embedding FLOAT[768]
);
```

- ruri-v3-310mの出力次元 = 768
- ingest時にembeddingを計算して挿入

---

## Embedding処理

### 入力テキスト構成

```python
def make_embedding_input(title: str, content: str | None) -> str:
    text = title
    if content:
        text += " " + content[:500]
    return text
```

- ruri-v3-310mの最大入力は512トークン
- 日本語1文字 ≒ 1-2トークンなので、500文字で概ね収まる
- タイトルを先頭に配置し、意味が確実に反映されるようにする

### モデルのlazy load

```python
_model = None

def _get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer("cl-nagoya/ruri-v3-310m")
    return _model

def embed(text: str) -> list[float]:
    model = _get_model()
    vec = model.encode(text, normalize_embeddings=True)
    return vec.tolist()
```

- `list`や`show`ではモデル不要。search/ingest初回呼び出し時のみロード

### Embeddingキャッシュ

```
~/.lifelog/embedding_cache.db

CREATE TABLE cache (
    content_hash  TEXT PRIMARY KEY,  -- SHA256(embedding入力テキスト)
    embedding     BLOB               -- float[768]をpackしたバイナリ
);
```

- ingest時にキャッシュヒットすれば再計算しない
- 将来のバッチ再取り込みやDB再構築時に効く

---

## ハイブリッド検索

### 検索フロー

```
search(query, source?, limit) →
  1. sourceが指定されていれば WHERE source = ? で候補を限定
  2. FTS5で上位50件取得
  3. sqlite-vecで上位50件取得（embedding(query)とのコサイン類似度）
  4. RRF融合（K=60）
  5. 時間減衰を乗算（happened_atベース）
  6. accessed_at / access_count を更新
  7. 上位limit件を返却
```

### RRF融合

```python
RRF_K = 60

def rrf_score(rank: int) -> float:
    return 1.0 / (RRF_K + rank + 1)
```

- FTS結果とベクトル結果のそれぞれのランクからスコアを算出
- 両方にヒットしたエントリはスコアが加算される

### 時間減衰

```python
TIME_DECAY_HALF_LIFE_DAYS = 180.0
TIME_DECAY_FLOOR = 0.1

def time_decay(happened_at: str) -> float:
    days_old = (now - parse(happened_at)).days
    decay = 0.5 ** (days_old / TIME_DECAY_HALF_LIFE_DAYS)
    return max(decay, TIME_DECAY_FLOOR)
```

| 経過日数 | 減衰係数 |
|---|---|
| 0日 | 1.0 |
| 30日 | 0.89 |
| 180日 | 0.5 |
| 1年 | 0.25 |
| 2年 | 0.1 (floor) |

- engramの30日半減期はLifelogには短すぎる（「半年前の記事」を探すユースケース）
- floorにより古いデータも関連性が高ければ浮上可能
- 半減期とfloorはconfig.tomlで調整可能

### 最終スコア

```
final_score = rrf_score × time_decay(happened_at)
```

engramにある`memory_type` boost (1.5x) と `project` boost (1.3x) は不要。Lifelogは単一用途で、highlight/backgroundやproject区分がないため。

---

## モジュール構成

```
lifelog/
├── __init__.py
├── cli.py              # CLIコマンド定義
├── db.py               # スキーマ定義、CRUD、DB初期化
├── search.py           # ハイブリッド検索、RRF、時間減衰
├── embeddings.py       # モデルロード、embed()、embed_batch()
├── embedding_cache.py  # SHA256→embeddingキャッシュ
├── ingest.py           # 取り込みロジック（embedding生成、保存）
└── config.py           # config.toml読み込み、デフォルト値
```

---

## CLIコマンド体系

```
lifelog ingest web    --url URL [--title TITLE] [--content TEXT] [--tags TAGS] [--happened-at DATETIME]
lifelog ingest memo   --title TITLE --content TEXT [--tags TAGS] [--happened-at DATETIME]
lifelog ingest email  --title TITLE --content TEXT [--tags TAGS] [--happened-at DATETIME]
lifelog search        QUERY [--source SOURCE] [--limit N]
lifelog list          [--source SOURCE] [--since DATE] [--until DATE] [--limit N]
lifelog show          ID
```

- `ingest`のサブコマンドごとに必須引数が違う（webならURL必須）
- `happened-at`省略時は現在時刻をデフォルトにする
- `ingest web`でtitle省略時はURLからの取得を試みる（将来的に）
- `search`は位置引数でクエリ（最頻出コマンドなので簡潔に）
- `list`は時系列一覧（検索品質の検証用）
- `show`はIDで1件の詳細表示

---

## データディレクトリ

```
~/.lifelog/
├── lifelog.db           # メインDB
├── embedding_cache.db   # embeddingキャッシュ
└── config.toml          # 調整パラメータ
```

### config.toml デフォルト

```toml
[search]
rrf_k = 60
time_decay_half_life_days = 180.0
time_decay_floor = 0.1

[embedding]
model = "cl-nagoya/ruri-v3-310m"
max_content_chars = 500
```

---

## DB初期化

```python
def init_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS entries (...);
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts ...;
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_vec ...;
        -- トリガー3つ
    """)
    return conn
```

---

## スコープ外（今回作らないもの）

- Telegram Bot 連携
- ブラウザ拡張
- Gmail / Craft / Drafts インポーター
- MCP Server
- Web UI
- マルチマシン同期

これらは、コアの検索品質を検証した後に、別プロジェクトまたはプラグインとして構築する。

---

## engramとの関係

| | engram | Lifelog Core |
|---|---|---|
| 用途 | Claude Codeの作業記憶 | 個人の全情報記録 |
| データ構造 | content + tags + project | title + content + url + source + happened_at |
| memory_type | background / highlight | なし（区別不要） |
| scope | project / global | なし（単一用途） |
| 時間減衰 | 半減期30日 | 半減期180日 + floor 0.1 |
| FTS対象 | content, tags | title, content |
| 共通 | SQLite + FTS5(trigram) + sqlite-vec + RRF(K=60) + embedding cache + lazy model load |
