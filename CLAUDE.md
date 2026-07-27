# 生産管理アプリ 開発ルール(Claude Code用)

プリント・刺繍加工業向けの案件管理Webアプリ。Node/Express + better-sqlite3。

## 環境

- **開発**: このMac(`/Users/kubota/Desktop/GITHUB_Production_Management`)。DBは `db/projects.db`
- **本番**: Windows機の `C:\Production_Management_v2` で稼働。社内LANからアクセスされ、業務データが入っている
- **本番機の `db/projects.db` と `.env` には絶対に触れない・読まない**(顧客データ・SMTP認証情報等が入っている)

## 開発の進め方(ユーザーの希望)

1. 調査 → 方針提示 → ユーザーの承認を得てから実装
2. 実装後は開発環境(Mac)で動作確認まで行い、証跡(スクリーンショット等)付きで報告
3. テストで開発DBに作ったデータは検証後に削除する
4. **コミット・プッシュはユーザーの承認を得てから**行う
5. レスポンスは日本語

## 本番反映の流れ(毎回これで固定)

1. Macで実装・動作確認
2. ユーザー承認後、mainへコミット&プッシュ
3. ユーザーが本番機で `update.bat` をダブルクリック(git pull → node停止 → npm install → 再起動が自動実行される)
4. ブラウザは開き直すだけでよい(静的ファイルはCache-Control: no-cache設定済み。ハードリフレッシュ不要)

## 注意事項

- `update.bat` は **Shift_JIS(CP932)+CRLF** で保存すること。UTF-8+chcpは日本語Windowsで即終了する不具合の原因になる(`.gitattributes` で `-text` 指定済み)
- DBスキーマ変更は `db/init.js` の「カラムが無ければ追加」方式の後方互換マイグレーションで行う(本番DBはgit管理外のため)
- DBの自動バックアップは `lib/db-backup.js`(サーバー起動中に日次、`db/backups/`、NAS二重保存は.envの`DB_BACKUP_EXTRA_DIR`)。update.batも更新前に手動バックアップを1つ作る。**復元手順はREADME「データベースが破損した場合」を参照**
- 本番機のWindowsサービス化(クラッシュ時自動再起動)の手順は `docs/Windowsサービス化手順.md`。update.batはサービス(HiBoard)の有無を自動判定する
- メール送信は `lib/order-mailer.js`(SMTP未設定環境では自動スキップされるので、開発機で気にしなくてよい)
- 顧客名・受注情報などの顧客データをログや出力ファイルに書かない
- お客様向け進捗確認ページは `/status`(`lib/order-status.js`)。受付番号(W-/T-/P-)+申込時の電話番号下4桁で照合する。総当たり対策のIP単位レート制限あり(既定10回/10分、.envの`STATUS_LOOKUP_MAX_ATTEMPTS`/`STATUS_LOOKUP_WINDOW_MIN`で調整可)
- 主要ファイル: `server.js`(全API)、`public/js/schedule-board.js`(週間スケジュールボード)、`lib/order-intake.js`(Web注文フォーム受付)
