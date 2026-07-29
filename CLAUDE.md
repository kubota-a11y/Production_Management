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
- **本番機の常駐化は「タスクスケジューラ方式」**(`run-server-loop.bat` をログオン時トリガーで起動。nodeが落ちても5秒後に自動再起動)。**NSSM/Windowsサービスは使えない** — LocalSystemだとNASの割り当てドライブ(Z:)が見えず、デザインデータ閲覧・注文画像保存・NASバックアップが壊れる。同じ理由で `/rl highest` も付けない。手順とハマりどころは `docs/Windowsサービス化手順.md`
- **update.bat 自体が更新されるため、本番反映の1回目はエラーで止まることがある**(もう一度ダブルクリックで正常動作)
- メール送信は `lib/order-mailer.js`(SMTP未設定環境では自動スキップされるので、開発機で気にしなくてよい)
- 顧客名・受注情報などの顧客データをログや出力ファイルに書かない
- **外部公開ガード**(server.js): お客様に配っている公開ドメインでは公開ページ(注文フォーム・ガイド・進捗確認・各トークンページ)だけを許可し、社内画面・社内APIは404にする。判定は**ホスト名**で行い、`.env` の `PUBLIC_HOSTNAMES`(カンマ区切り。未設定時は`PUBLIC_ORDER_BASE_URL`のホスト名+選手専用ドメイン)に載っているホスト名のみが制限対象。**社内用URL・LAN内のIP直打ちは全機能そのまま**。緊急時は `EXTERNAL_GUARD=off` で無効化。起動ログに現在の設定が出る。※社内用URLを外に出している場合はCloudflare Access等での保護が別途必要
- お客様向け進捗確認ページは `/status`(`lib/order-status.js`)。受付番号(W-/T-/P-)+申込時の電話番号下4桁で照合する。総当たり対策のIP単位レート制限あり(既定10回/10分、.envの`STATUS_LOOKUP_MAX_ATTEMPTS`/`STATUS_LOOKUP_WINDOW_MIN`で調整可)
- 主要ファイル: `server.js`(全API)、`public/js/schedule-board.js`(週間スケジュールボード)、`lib/order-intake.js`(Web注文フォーム受付)

## 実装時に踏みやすい罠(過去に実際にやった)

- **公開ページのAPIで5xxを返してはいけない**。Cloudflare(トンネル)がoriginの5xx応答を独自エラーページ(text/plain)に差し替えるため、画面側はJSONとして読めず「通信エラー」しか出せない。想定内の失敗は **200 + `{ok:false, error}`** で返す。4xxは素通しされるので検証エラーは400のままでよい
- **新しい加工種別を足したら、従業員の「作業別生産性」にその種別の数値を登録しないとボードのドロップで使えない**。案件の作業予定時間(planned_hours)が0/未入力の案件も置けない
- 祝日は `lib/jp-holidays.js` の静的テーブル(2027年分まで)。**毎年、翌年分を手で追加する運用**
- 公開フォームの誤送信対策は `public/js/form-guard.js` を3フォーム(Web注文/チーム追加/取引先加工依頼)で共有。**Enter送信の無効化と確認ウィンドウは両方必要**(確認ウィンドウだけではEnter2回で送信できてしまう)
- 受付番号プレフィックスは4系統: W-=Web注文 / T-=チーム追加 / P-=取引先加工依頼 / LINEはバッジなし(`public/js/app.js` の receiptPrefix)
- 進捗確認URLの案内メールは **`PUBLIC_ORDER_BASE_URL` 未設定だと黙って省略される**ので気づきにくい
- TODOシート連携はシート行にIDが無く employee_id+タスク本文で同一視するため、**シート側で文言を書き換えると紐づけが外れる**
- 共有モジュールを壊さない: `js/nas-browse.js`(NASフォルダ閲覧)・`js/case-detail.js`(案件詳細)・`js/form-guard.js`。プリント箇所/準備項目の描画・収集は `containerId` 引数で新規案件モーダルと受注候補確定画面が実装を共有している(片方を直せば両方に効く)
- **機能を追加したら社員向けガイド `/manual`(public/manual.html) も更新する**
- NAS周りの検証は実NASに書かず、`NAS_BASE_PATH=<一時ディレクトリ> PORT=3277 node server.js` で別インスタンスを起動して行う(dotenvは既存の環境変数を上書きしないのでこの方法が使える)
- 過去の実装経緯・各機能の設計判断は `docs/開発履歴.md`
