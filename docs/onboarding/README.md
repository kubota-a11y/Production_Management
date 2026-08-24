# Claude Code 導入用ファイル一式(社員向け)

三浦さん・山本さんに Claude Code を使ってもらうための設定と手順をここにまとめている。
HiBoard の**操作方法**は `docs/操作説明資料/` にある別資料を参照。ここは **Claude Code 側**の話。

## ファイル一覧

| ファイル | 置き場所 | 内容 |
|---|---|---|
| `セットアップ手順.md` | 読むだけ | インストールからログインまで。本人に渡す |
| `三浦さん_CLAUDE.md` | 本人PCの `~/.claude/CLAUDE.md` | 三浦さん個人の役割・ルール |
| `山本さん_CLAUDE.md` | 本人PCの `~/.claude/CLAUDE.md` | 山本さん個人の役割・ルール |
| `三浦さん_settings.local.json` | 本人PCのリポジトリ内 `.claude/settings.local.json` | 三浦さんの権限設定 |
| `山本さん_settings.local.json` | 本人PCのリポジトリ内 `.claude/settings.local.json` | 山本さんの権限設定 |

Windows では `~/.claude/` は `C:\Users\<ユーザー名>\.claude\` にあたる。

## 設計の考え方

**3層で権限を分けている。**

1. **`.claude/settings.json`(リポジトリ共有・git管理)** — 全員に効く。誰であっても触ってはいけないもの(`.env`、鍵ファイル、LINE API資料、`rm -rf`)だけを禁止している
2. **`.claude/settings.local.json`(個人ごと・git管理外)** — 人によって変える。山本さんは本番反映を禁止、三浦さんは許可
3. **`~/.claude/CLAUDE.md`(個人ごと)** — その人の役割と判断基準

久保田の `~/.claude/CLAUDE.md` は経営情報を含むため**そのまま配らない**。ここにある個人別のものを使う。

## 権限の早見表

| 操作 | 久保田 | 三浦さん | 山本さん |
|---|---|---|---|
| コード修正・ローカル動作確認 | ○ | ○ | ○ |
| `git commit`(ローカル) | ○ | ○ | ○ |
| `git push`(mainへ反映) | ○ | ○ | **×** |
| 本番機での `update.bat` | ○ | ○ | **×** |
| `.env`・鍵ファイルの読み取り | × | × | × |

山本さんの `git push` を止めているのは、本番反映を三浦さん経由に固定するため。
慣れてきたら `山本さん_settings.local.json` から該当行を消せば解除できる。
