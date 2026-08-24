# 生産管理アプリ 開発ルール(Claude Code用)

プリント・刺繍加工業向けの案件管理Webアプリ。Node/Express + better-sqlite3。

## 環境

- **開発**: このMac(`/Users/kubota/Projects/GITHUB_Production_Management`)。DBは `db/projects.db`
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
- DBの自動バックアップは `lib/db-backup.js`(サーバー起動中に日次、`db/backups/`)。**`.env` の `DB_BACKUP_EXTRA_DIR` はカンマ区切りで複数の保存先を書ける**(本番=NAS+Google共有ドライブ。社内だけに置くとランサムウェア・火災で全滅するため社外を1本必須とする)。1か所失敗しても他は続行し、結果は `/backup-status` 画面と `db/backups/backup-status.json` で確認できる。update.batも更新前に手動バックアップを1つ作る。**保存先一覧と復元手順はREADME参照**
- **本番機の常駐化は「タスクスケジューラ方式」**(`run-server-loop.bat` をログオン時トリガーで起動。nodeが落ちても5秒後に自動再起動)。**NSSM/Windowsサービスは使えない** — LocalSystemだとNASの割り当てドライブ(Z:)が見えず、デザインデータ閲覧・注文画像保存・NASバックアップが壊れる。同じ理由で `/rl highest` も付けない。手順とハマりどころは `docs/Windowsサービス化手順.md`
- **update.bat 自体が更新されるため、本番反映の1回目はエラーで止まることがある**(もう一度ダブルクリックで正常動作)
- メール送信は `lib/order-mailer.js`(SMTP未設定環境では自動スキップされるので、開発機で気にしなくてよい)
- 顧客名・受注情報などの顧客データをログや出力ファイルに書かない
- **外部公開ガード**(server.js): お客様に配っている公開ドメインでは公開ページ(注文フォーム・ガイド・進捗確認・各トークンページ)だけを許可し、社内画面・社内APIは404にする。判定は**ホスト名**で行い、`.env` の `PUBLIC_HOSTNAMES`(カンマ区切り。未設定時は`PUBLIC_ORDER_BASE_URL`のホスト名+選手専用ドメイン)に載っているホスト名のみが制限対象。**社内用URL・LAN内のIP直打ちは全機能そのまま**。緊急時は `EXTERNAL_GUARD=off` で無効化。起動ログに現在の設定が出る。※社内用URLを外に出している場合はCloudflare Access等での保護が別途必要
- お客様向け進捗確認ページは `/status`(`lib/order-status.js`)。受付番号(W-/T-/P-)+申込時の電話番号下4桁で照合する。総当たり対策のIP単位レート制限あり(既定10回/10分、.envの`STATUS_LOOKUP_MAX_ATTEMPTS`/`STATUS_LOOKUP_WINDOW_MIN`で調整可)
- 主要ファイル: `server.js`(全API)、`public/js/schedule-board.js`(週間スケジュールボード)、`lib/order-intake.js`(Web注文フォーム受付)

## 画面を作るときのルール(2026-07-30のUI全面改修で統一)

- **色・余白・文字サイズ・角丸・影・z-index は `public/styles/tokens.css` のトークンだけを使う**。値の直書きを増やさない。グレーは gray 1系統のみ(slate系は使わない)
- **ヘッダーは書かない**。`<nav class="header-buttons" data-nav="キー">` を置けば `public/js/ui.js` が全画面共通のナビを生成する。リンクを増やすときは ui.js の `navDaily`(日常業務・表に出す) か `navAdmin`(⚙管理メニューに畳む) に足す
- **モーダルは `.modal > .modal-content > .modal-header(h2 + .btn-close)` の形にする**だけで、Esc・背景クリック・フォーカス管理・`role="dialog"` が ui.js から自動で効く(JS生成モーダルにも効く)。各画面に背景クリック処理を書かない
- **ヘッダーの閉じるボタン以外に `.btn-close` を使わない**。Escの共通処理が誤爆する(行削除などは `.btn-icon-remove`)
- **通知は `HiUI.toast()`。`alert()` は使わない**。メッセージ内容から成功/エラー/注意を自動判定する。再読み込みを挟んでも消えない。破壊的操作の `confirm()` はネイティブのままにしている(同期的に真偽値が必要な箇所があるため。意図的な判断)
- ボタンは `btn` + 色クラス(`btn-primary`/`btn-secondary`/`btn-danger`/`btn-danger-soft`/`btn-ghost`) + `btn-small`。**main.css では色クラスをサイズ修飾子より後に定義する**(順序を崩すと `.btn-small.btn-danger` が灰色になる)
- 長いフォームは `<details class="form-section">` で分割し、`.form-actions-sticky` で保存ボタンを下端に固定する。**必須項目を閉じた `details` の中に置かない**(ブラウザ検証がフォーカスできず送信が無言で止まる)。削除ボタンは `.action-destructive` で左端に離す
- 単一の入力に紐づかない見出しは `<label>` ではなく `.form-label`(読み上げの対応先がない誤案内になる)
- 空状態は `.empty-notice`、読み込み中は `.folder-loading`(スピナー付き)
- 社内画面のブレークポイントは **767 / 768〜1180 / 480 の3つのみ**
- **案件一覧の列を増減したら `main.css` の `#projects-table td:nth-child(N)` も直す**。スマホ/タブレットで隠す列を番号で指定しているため、列を1つ削るとそれ以降が全部ずれる
- **日付は `formatDateISO()`(`public/js/utils.js`)を使う**。`new Date().toISOString().split('T')[0]` はUTC基準なので日本時間の0〜9時に前日になる(カレンダーが1日ずれていた原因)

## 実装時に踏みやすい罠(過去に実際にやった)

- **公開ページのAPIで5xxを返してはいけない**。Cloudflare(トンネル)がoriginの5xx応答を独自エラーページ(text/plain)に差し替えるため、画面側はJSONとして読めず「通信エラー」しか出せない。想定内の失敗は **200 + `{ok:false, error}`** で返す。4xxは素通しされるので検証エラーは400のままでよい
- **新しい加工種別を足したら、従業員の「作業別生産性」にその種別の数値を登録しないとボードのドロップで使えない**。加工種別のチェックボックスは案件フォームの2箇所(index.html、新規案件・受注候補確定)にある。**必要スキル(required_skill_tags)は 2026-08-18 に入力欄を廃止し、選択された加工種別をそのまま保存する方式にした**ので、加工種別を足せば必要スキルにも自動で入る
- **納品(`POST /api/projects/:id/deliver`)は「案件の終わり」の後片付けをする場所**。`case_time_allocations` の削除と `case_preparation_items` の完了扱いをここで行っている。案件の終了に伴って消すべきものを増やすときはここに足す(残すと準備項目リストの繰り越し・デザイナーのマイボード・勤務時間編集の割り当て候補に永久に出続ける)
- 案件の「必要スキル」(`required_skill_tags`)の値は**加工種別のコード**(`SILK_SCREEN_PRINT` 等)。従業員の「得意スキル」と突き合わせて担当者の自動提案に使うため、別の文字列を入れても一致しない
- **`projects.deadline` は NOT NULL のまま、未定を空文字で表す**(2026-08-18に納期を任意化した際、SQLiteでNOT NULL解除はテーブル再構築が必要なため空文字で運用)。`createProjectRecord` が `deadline || ''` で吸収している。**空文字の納期を新しい画面で扱うときは、日付として解釈する前に空判定を入れる**(`getDeadlineWarning`・`formatDate`・`groupProjectsByDeadline` は対応済み)。納期が空の案件は `autoProposeForProject` が「締切日が未設定です」を返して自動提案の対象外になる(意図した挙動)
- **`planned_hours` が0の案件は「0時間の案件」ではなく「制作予定時間が未定」**(2026-08-18に必須を外した)。スケジュールボードは `hasUndecidedPlannedHours()` で未定を判定して選択肢に出し、予定(h)に入力された時間を `PATCH /api/projects/:id/planned-hours` で案件へ書き戻す。**残時間の計算を足すときは、0を「割り振り済み」と誤判定しないこと**
- **`case_preparation_items` は status と completed_at がずれることがある**。「未着手なのに completed_at が残っている」行を作らないこと(status を戻すときは completed_at も必ずNULLにする)。**担当の一括解除などを書くときは status だけで判定する** — completed_at を条件に入れると、ボードには出ているのに処理から漏れる行ができる(実際に鈴木さんのボードでカードが消えない不具合になった)
- デザイン担当が自分のボードから外した準備項目は `case_preparation_items.designer_released_at` に記録し、`registerPreparationItems` の寄せ直し(デザイン案件の担当が空の項目をデザイン担当へ寄せる処理)から除外する。**これが無いと案件を編集するたびに本人のボードへ戻る**。担当を割り当て直すとクリアされる。「初校提出」「入稿完了」は段階を進めるトリガーなので外せないようにしている(`NON_RELEASABLE_CODES`)
- 入金・現金預かりは `projects.payment_status`(UNPAID/CASH_RECEIVED/PAID)+ `payment_holder_employee_id`。案件の進行(status)とは別の軸なので `PATCH /api/projects/:id/payment` に分けている。**CASH_RECEIVED 以外へ変えたときは預かり者をNULLに戻す**(前の預かり者が残ると誤解を生む)
- 祝日は `lib/jp-holidays.js` の静的テーブル(2027年分まで)。**毎年、翌年分を手で追加する運用**
- 公開フォームの誤送信対策は `public/js/form-guard.js` を3フォーム(Web注文/チーム追加/取引先加工依頼)で共有。**Enter送信の無効化と確認ウィンドウは両方必要**(確認ウィンドウだけではEnter2回で送信できてしまう)
- 受付番号プレフィックスは4系統: W-=Web注文 / T-=チーム追加 / P-=取引先加工依頼 / LINEはバッジなし(`public/js/app.js` の receiptPrefix)
- **注文フォームは `?sim=` でコーポレートサイトの料金シミュレーターの内容を受け取る**(`order.js` の `applySim`)。**形式の単一の情報源は別リポジトリの `~/Projects/GITHUB_HiYOSHi_WEB/src/lib/sim-handoff.ts`** なので、変えるときは必ず両方を直す(項目を足すだけなら、フォーム側が知らない項目を無視するので壊れない)。**サイトの概算金額は備考に文字として残すだけで、業務データの金額として扱わない**(URLは誰でも書き換えられるため)。想定外の値は黙って無視してフォームを通常表示する
- 進捗確認URLの案内メールは **`PUBLIC_ORDER_BASE_URL` 未設定だと黙って省略される**ので気づきにくい
- TODOシート連携はシート行にIDが無く employee_id+タスク本文で同一視するため、**シート側で文言を書き換えると紐づけが外れる**
- 共有モジュールを壊さない: `js/ui.js`(ヘッダー・モーダル・トースト)・`js/nas-browse.js`(NASフォルダ閲覧)・`js/case-detail.js`(案件詳細)・`js/form-guard.js`。プリント箇所/準備項目の描画・収集は `containerId` 引数で新規案件モーダルと受注候補確定画面が実装を共有している(片方を直せば両方に効く)
- **機能を追加したら社員向けガイド `/manual`(public/manual.html) も更新する**
- NAS周りの検証は実NASに書かず、`NAS_BASE_PATH=<一時ディレクトリ> PORT=3277 node server.js` で別インスタンスを起動して行う(dotenvは既存の環境変数を上書きしないのでこの方法が使える)
- 過去の実装経緯・各機能の設計判断は `docs/開発履歴.md`
