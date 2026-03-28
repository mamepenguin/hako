# Lifelog システム設計案

2026-03-28 壁打ちメモ

---

## 背景と動機

Claude Code用に構築したengram（長期記憶システム）を起点に、より汎用的な個人記憶システムの構想を検討した。engramはClaude Codeの作業履歴に特化しているため、そのまま拡張せず新規に設計する。

### 解決したい課題

- ブラウザやGoogleアプリで見た記事が後から見つからない
- AIとのやりとりや日常のメモが長期保存されず、各サービスの履歴に散在している
- 保存しておくべきメールをGmail以外でも参照したい

---

## 設計思想

**保存はシンプルに、取り出し時にAIが要約・解釈する。**

- 保存時にAIコストをかけない（全文 or 冒頭テキストをそのまま保存）
- 検索結果の解釈・要約はAIが担当
- 人間が直接DBを検索しても使えるが、AI経由の方が体験が良い

---

## データソース

| ソース     | 取り込み方法                             | 頻度       |
| ------- | ---------------------------------- | -------- |
| Web記事   | ブラウザ拡張で1クリック or 閲覧履歴の定期取込（除外リスト付き） | 随時       |
| 保存済みメール | Gmail APIでスター付きのみ取得                | 随時 or 定期 |
| AIチャット  | Telegram Bot経由で直接記録                | 随時       |
| Craft   | Craft MCP/APIで定期インポート              | 定期       |
| Drafts  | iCloud Driveからファイルスキャン             | 定期       |

### Web記事について

- 全文保存にはこだわらない
- タイトル + URL + 冒頭テキストがあれば検索で見つかり、詳細は元ページを見ればいい
- 「その時意識していないが後で振り返りたい記事」の問題は、閲覧履歴の定期取込+除外リストで対応可能

---

## データ設計

```
id            : INTEGER PRIMARY KEY
source\_type   : TEXT (web, email, ai\_chat, memo, craft, drafts)
title         : TEXT
content       : TEXT (全文 or 冒頭テキスト)
url           : TEXT (あれば)
happened\_at   : DATETIME (情報が発生した日時)
created\_at    : DATETIME (DBに保存した日時)
tags          : TEXT (カンマ区切り)
```

### happened_at と created_at の分離

- happened_at = 記事の閲覧日、メールの受信日、メモを書いた日
- created_at = DBに保存した日時
- Gmailから3日後にインポートしても happened_at は受信日
- これがないと時系列の振り返りが壊れる

### インデックス

- **FTS5** — title + content のキーワード検索
- **sqlite-vec** — タイトル+冒頭のembedding（ruri-v3-310m）によるセマンティック検索
- **happened_at** — 時系列一覧・範囲絞り込み

### 検索要件

- キーワード検索（「あの記事」）
- 時系列の振り返り（「今月何をしていたか」）
- テーマ横断検索（「この話題について過去に考えたこと」）

---

## アーキテクチャ

```
入力側:
  Telegram Bot ← 人間がメモ・URL・質問を送る
  ブラウザ拡張 → Telegram Webhook or 直接API
  Gmail       → 定期取得（スター付きのみ）
  Craft/Drafts → 定期インポート
        ↓
  ローカルシステム:
    取り込み処理（タイトル+URL+冒頭テキスト抽出）
    Embedding生成（ruri-v3-310m, 310Mパラメータ）
    SQLite保存（FTS5 + sqlite-vec）
        ↓
  検索・取り出し:
    Telegram Bot ← 人間が自然言語で質問
      → DB検索 → AIが要約して返答
```

### Telegram Botを中継に使う理由

- キューの問題が解消（Telegram自体がメッセージを永続化）
- UIが不要（スマホでもPCでもTelegramで送るだけ）
- Bot APIが整備されており実装がシンプル
- 1対1でBotと会話する形が自然
- メモ送信・URL送信・自然言語検索を同一UIで実現

### DBの配置

- ローカルSQLite（engram同様）
- 外部からはTelegram Bot経由でアクセス

---

## 技術スタック（想定）

- **DB**: SQLite + FTS5 + sqlite-vec
- **Embedding**: ruri-v3-310m（日本語に強い軽量モデル）
- **検索**: ハイブリッド（FTS + ベクトル + RRF融合 + 時間減衰）
- **中継/UI**: Telegram Bot API
- **Web記事取込**: ブラウザ拡張（タイトル+URL+冒頭テキスト送信）

---

## engram との違い

|        | engram                   | Lifelog                               |
| ------ | ------------------------ | ------------------------------------- |
| 用途     | Claude Codeの作業履歴         | 個人の全情報記録                              |
| データソース | セッションログ+手動保存             | Web, メール, チャット, メモ等                   |
| 検索者    | AI（Claude Code）          | AI（Telegram Bot経由）                    |
| スキーマ   | content + tags + project | source_type, title, url, happened_at等 |
| UI     | なし（MCP経由）                | Telegram                              |

---

## 未決事項

- Telegram Bot の構築（Token設定で挫折中、再挑戦が必要）
- ブラウザ拡張の具体的な実装
- Gmail/Craft/Drafts取り込みの詳細仕様
- 検索時に使うAIモデル（ローカル or API）
- Embeddingの入力上限（512トークン）を超える長文の扱い方針の最終確認