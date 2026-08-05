# NAS廃止 → Googleドライブ共有ドライブ 移行手順

会社NAS(I-O DATA LAN DISK)を廃止し、**Google共有ドライブ1本**に切り替えるための手順書。
2026-08-05の社長判断による。Dropboxは契約しない(コスト圧縮のため)。

## 移行後の構成

```
社員PC → Googleドライブ(デスクトップ版) → G:\共有ドライブ\HiYOSHi共有\
本番Windows機(HiBoard) ┘
        └ 毎晩2:00 rclone で共有ドライブ → サーバー内蔵ディスクへ全件引き落とし
                                            (--backup-dir で削除・上書き分を日付フォルダへ退避)
```

保管先は「共有ドライブ(クラウド)」と「Windowsサーバーのローカル」の2箇所。
誤削除は共有ドライブのゴミ箱(30日)・版管理と、rclone の `--backup-dir` の2系統で復旧できる。

**HiBoardのコード変更は不要**。HiBoardは「NASという製品」ではなく
「Windowsから見えるフォルダパス」に依存しているだけなので、`.env` とDB内のパスを差し替えれば動く。

---

## 0. 事前に確認すること(移行日より前に済ませる)

| 確認項目 | 方法 | 判定 |
|---|---|---|
| DESIGN配下のアイテム数 | 本番Windows機で下記コマンド | **40万未満**であること(共有ドライブの上限) |
| データ総量 | エクスプローラーでZ:\DESIGNのプロパティ | 10TB未満(Workspace Business Standard 5人分のプール) |
| 回線の上り速度 | 速度測定サイト | 初回アップロードの所要日数の目安に使う |

アイテム数の数え方(コマンドプロンプト):

```bat
dir /s /b "Z:\DESIGN" | find /c /v ""
```

> 40万を超えた場合は、共有ドライブを用途別に分割する(例: `DESIGN_現行` と `DESIGN_アーカイブ`)。
> その場合 `NAS_BASE_PATH` は1つしか指定できないため、HiBoardから見せるのは現行側だけにして、
> アーカイブはエクスプローラーから直接開く運用にする。

---

## 1. 共有ドライブを作る

1. Google管理コンソール → アプリ → Google Workspace → ドライブとドキュメント → 共有ドライブを作成
2. **マイドライブではなく必ず共有ドライブにする**(個人アカウントに紐づくと退職・アカウント停止でデータが人質になる)
3. メンバーを追加する。5人全員に権限を渡せる(Dropboxのようなライセンス数の制限がない)
   - 久保田・三浦・鈴木: コンテンツ管理者以上
   - 山本・渡邉: 閲覧者または投稿者(業務内容に合わせる)
4. **本番Windows機がログインするアカウントにも権限を付ける**こと。ここを忘れるとHiBoardからフォルダが見えない

> 経理フォルダなど社長のみが見るものは、**別の共有ドライブ**に分ける。
> 同じ共有ドライブ内のサブフォルダは権限を絞りにくいため。

## 2. 本番Windows機に Googleドライブ(デスクトップ版) を入れる

1. [Googleドライブ(デスクトップ版)](https://www.google.com/drive/download/) をインストール
2. 会社アカウントでログイン
3. 設定 → **ドライブ文字を `G:` に固定する**
   - **ここが最重要**。ドライブ文字が変わると`.env`とDB内のパスが全部壊れる
4. ストリーミング(既定)のままでよい。共有ドライブはミラーリング非対応
5. **ログオン時に自動起動する**設定にする

> **注意: Windowsサービス化は引き続きできない。**
> HiBoardの常駐は今までどおり「タスクスケジューラ方式」(`run-server-loop.bat` をログオン時トリガー)のまま。
> Googleドライブもユーザーセッションで動くため、LocalSystemで動かすと `G:` が見えなくなる。
> NASのZ:ドライブと事情はまったく同じ。詳細は `docs/Windowsサービス化手順.md`

## 3. データをコピーする

**移行対象はDESIGNだけではない。** NAS直下には26フォルダ・合計約142GBがある(2026-08-05実測)。
内訳の主なもの: `DESIGN` 116.0GB / `WEB作成素材` 8.5GB / `動画用音楽` 8.4GB /
`design print service` 5.4GB / `DTF用 AIデータ` 2.0GB / 残り約1.5GB。

除外するもの:

| フォルダ | 理由 |
|---|---|
| `My Mac (kubotayuuyanoMacBook-Pro.local)` | MacのTime Machine用の受け皿。Googleドライブに載せる意味がない(実測0.1GBで実質空) |
| `ProductionManagement_Backup` | HiBoardのDBバックアップ先。NASに残したまま使い続ける(4-3参照) |

手順:

1. NASを**読み取り専用**にする(移行中に片方だけ更新されるのを防ぐ)
2. まず小さいフォルダ1つ(`価格改定` 0.2GB程度)でテストコピーし、G:に入ることとWeb版ドライブで見えることを確認する
3. 本番のコピーはエクスプローラーのドラッグではなく robocopy で行う(失敗したファイルがログに残るため):

```bat
robocopy "Z:\" "G:\共有ドライブ\HiYOSHi共有" /e ^
  /xd "My Mac (kubotayuuyanoMacBook-Pro.local)" "ProductionManagement_Backup" ^
  /xf "sync_test_0706.txt.pdf" ^
  /r:2 /w:5 /tee /log:C:\migration_copy.log
```

- `/e` … フォルダ構成をそのまま維持する。**構成は絶対に変えない**。
  変えるとDBに入っている案件ごとのパスが単純な置換で移行できなくなり、案件1件ずつの手作業になる。
  フォルダの整理は移行が落ち着いてから別作業でやること
- `/r:2 /w:5` … リトライを2回に制限する。**付けないと1ファイルの失敗で事実上無限に止まる**(既定は100万回)
- `/mt`(マルチスレッド)は付けない。Googleドライブの仮想ドライブへの並列書き込みは不安定になりやすい

4. **robocopyが終わってもアップロードは終わっていない。**
   robocopyはローカルのキャッシュに書くところまでで、そこからGoogleへ上がるのは別処理。
   タスクトレイのGoogleドライブアイコンが「同期完了」になるまで待つ
5. Google側は**1日750GBのアップロード上限**がある。142GBなら一晩で収まる
6. コピー中はキャッシュのぶんC:の空きが一時的に減る(2026-08-05時点で366GB空きがあるため問題なし)
7. コピー後、件数と容量が一致することを確認する

## 4. HiBoardを切り替える(ここは30分程度)

### 4-1. サーバーを止める

タスクトレイ/タスクマネージャーから `node.exe` を終了する。

### 4-2. 現在のパスを確認する

```bat
cd C:\Production_Management_v2
node scripts/migrate-storage-path.js --scan
```

DBに保存されているパスの「ルート部分」と件数が出る(顧客名が入るため、それより深い階層は表示されない)。
`Z:\DESIGN` と `\\192.168.1.25\disk1\DESIGN` のように**複数のルートが出ることがある**。その場合は4-4を複数回実行する。

### 4-3. `.env` を書き換える

メモ帳で `C:\Production_Management_v2\.env` を開き、次の3項目を差し替える。**他の項目は触らない。**

| 項目 | 変更前(例) | 変更後 |
|---|---|---|
| `NAS_BASE_PATH` | `Z:\DESIGN` | `G:\共有ドライブ\HiYOSHi共有\DESIGN` |
| `WEB_ORDER_RECEIVED_PATH` | `\\192.168.1.25\disk1\DESIGN\WEB_ORDER_RECEIVED` | `G:\共有ドライブ\HiYOSHi共有\DESIGN\WEB_ORDER_RECEIVED` |
| `PARTNER_ORDER_RECEIVED_PATH` | `\\192.168.1.25\disk1\DESIGN\PARTNER_ORDER_RECEIVED` | `G:\共有ドライブ\HiYOSHi共有\DESIGN\PARTNER_ORDER_RECEIVED` |

> **`DB_BACKUP_EXTRA_DIR` は変更しない。**
> NASは廃棄せず、rcloneのバックアップ先として残す(手順6)。DBのバックアップ先も
> `Z:\ProductionManagement_Backup` のまま据え置きでよい。
>
> **Googleドライブ配下には絶対に向けないこと。** 同期キャッシュを挟むフォルダは
> DBファイルのコピー先として危険(コピー途中の状態が同期される・ストリーミングだと実体がローカルにない)。

### 4-4. DBに保存されたパスを一括置換する

まずドライラン(DBは変更されない)。

```bat
node scripts/migrate-storage-path.js --from "Z:\DESIGN" --to "G:\共有ドライブ\HiYOSHi共有\DESIGN"
```

対象件数が想定どおりなら、`--apply` を付けて本実行する(自動でDBバックアップを取ってから書き換える)。

```bat
node scripts/migrate-storage-path.js --from "Z:\DESIGN" --to "G:\共有ドライブ\HiYOSHi共有\DESIGN" --apply
```

置き換わるのは次の5箇所:

- `projects.nas_folder_path` — 案件のフォルダ
- `line_messages.image_path` — LINE受信画像
- `ai_extracted_intake.reference_link` — 受注候補の代表画像
- `ai_extracted_intake.notes` — 受注候補の要約文に書かれた保存先
- `ai_extracted_intake.raw_ai_response` — 受注候補の明細JSONに入っている画像パス

補足:

- 大文字小文字の違い(`Z:\DESIGN` と `z:\design`)は自動で吸収される
- ルートが複数ある場合(Z:形式とUNC形式の混在など)は、`--from` を変えて**複数回実行**する
- 「0件」と出たら`--from`の指定ミス。`--scan` の出力と見比べる
- 元に戻す場合は、実行時に表示されたバックアップファイルを `db\projects.db` に戻す

### 4-5. 起動して確認する

```bat
npm start
```

- 起動ログにエラーが出ないこと
- 案件一覧 → 案件詳細 → 「フォルダを見る」でGoogleドライブ上のファイルが一覧表示されること
- 案件詳細に指示書PDFなどの書類が拾えていること
- 「エクスプローラーで開く」でG:配下が開くこと
- `/order`(注文フォーム)からテスト送信し、`G:\...\WEB_ORDER_RECEIVED\<番号>\` に画像が保存されること
  → **確認後にテストデータを消すこと**

## 5. 社員PCを切り替える

1. 各PCにGoogleドライブ(デスクトップ版)を入れ、会社アカウントでログイン
2. **ドライブ文字を全PCで `G:` に統一する**(HiBoardが表示するパス文字列をそのまま使えるようにするため)
3. デスクトップのNASエイリアス(`N_HIYOSHI1` / `N_HIYOSHI2`)とネットワークドライブの割り当てを削除
4. **鈴木さんのPC**: よく使うフォルダを右クリック →「オフラインで使用可能にする」でローカル固定する
   - 共有ドライブはストリーミング(都度ダウンロード)のため、大きいPSD/AIを直接開くと遅い
   - ピン留めしたフォルダはローカル並みの速度になる。作業中の案件フォルダだけ指定するのがコツ
   - ディスク空き容量に注意

## 6. NASへの毎晩のバックアップ(rclone)

**バックアップ先はNASを再利用する**(2026-08-05判断)。本番機とサーバー機は同一のPCで、
ドライブはC:1本しかないため、C:内にバックアップを置いても同じディスクの道連れになる。
NASは本番機とは独立した別の機械なので、外付けHDDを買い足さずにこの条件を満たせる。

**引き落とす向き**になる点だけが当初のDropbox案と逆になる。

### 6-0. NASの空き容量を確認する(最初にやる)

検証期間中はNASに旧データ(約142GB)が残ったままなので、バックアップぶんを足すと約284GB必要になる。

```powershell
Get-PSDrive Z | Select-Object @{n='使用GB';e={[math]::Round($_.Used/1GB,1)}},@{n='空きGB';e={[math]::Round($_.Free/1GB,1)}}
```

空きが150GB未満なら、旧データを消す(=検証期間の終了)まで夜間バックアップの開始を待つ。

### 6-1. rclone を配置する

[rclone.org/downloads](https://rclone.org/downloads/) から Windows AMD64 版のzipを取得し、
`rclone.exe` を `C:\rclone\rclone.exe` に置く。

### 6-2. リモートを設定する

```bat
C:\rclone\rclone.exe config --config C:\rclone\rclone.conf
```

対話形式で進む。要点だけ:

| 質問 | 答え |
|---|---|
| n/s/q | `n` (New remote) |
| name | `gdrive` |
| Storage | `drive` (Google Drive) |
| client_id / client_secret | 空のままEnter |
| scope | **`2` (drive.readonly)** |
| service_account_file | 空のままEnter |
| Edit advanced config | `n` |
| Use auto config | `y` → ブラウザが開くのでログイン |
| Configure this as a Shared Drive (Team Drive) | **`y`** → `HiYOSHi共有` を選ぶ |

> **scope は必ず `drive.readonly` にする。** バックアップはGoogleから読むだけなので書き込み権限は不要。
> 読み取り専用にしておけば、設定ミスやコマンドの打ち間違いでGoogle側のデータが消える事故が原理的に起きない。

接続確認:

```bat
C:\rclone\rclone.exe lsd gdrive: --config C:\rclone\rclone.conf
```

共有ドライブ直下のフォルダ一覧(`DESIGN` など)が出れば成功。

### 6-3. 置き場を作る

```bat
mkdir Z:\_Backup\SharedDrive
mkdir Z:\_Backup\_deleted
mkdir C:\rclone\logs
```

### 6-4. バッチを作る

`C:\rclone\nightly-backup.bat` をメモ帳で作成する。
**バッチ内のパスに日本語を含めないこと**(日本語WindowsでのバッチのエンコードはCP932依存で事故りやすい。
`gdrive:` は共有ドライブのルートを指すので、日本語のパスを書く必要はない)。

```bat
@echo off
setlocal
set RCLONE=C:\rclone\rclone.exe
set CONF=C:\rclone\rclone.conf
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set STAMP=%%i
"%RCLONE%" sync gdrive: "Z:\_Backup\SharedDrive" --config "%CONF%" ^
  --backup-dir "Z:\_Backup\_deleted\%STAMP%" ^
  --log-file "C:\rclone\logs\%STAMP%.log" --log-level INFO ^
  --transfers 4 --checkers 8
endlocal
```

- 日付は `%date%` から切り出さずPowerShellで作る(`%date%` の書式はロケール依存で壊れやすい)
- `sync` + `--backup-dir` の組み合わせで、Google側で消えた・上書きされたファイルは
  削除されずに `_deleted\日付\` へ退避される

### 6-5. 手動で初回実行する

```bat
C:\rclone\nightly-backup.bat
```

初回は約142GBの全件ダウンロードなので数時間かかる。時間に余裕のある日に流す。

### 6-6. タスクスケジューラに登録する

タスクスケジューラ → 基本タスクの作成:

- 名前: `rclone-nightly-backup`
- トリガー: 毎日 2:00
- 操作: プログラムの開始 → `C:\rclone\nightly-backup.bat`
- **「ユーザーがログオンしているときのみ実行する」を選ぶ**
  - Z:のネットワークドライブはログオンセッションにしか存在しない。
    「ユーザーがログオンしているかどうかにかかわらず実行する」にするとZ:が見えず失敗する。
    HiBoardをサービス化できないのとまったく同じ理由(`docs/Windowsサービス化手順.md`)
- プロパティ → 条件 → 「**タスクを実行するためにスリープを解除する**」にチェック

### 6-7. 運用上の注意

- 翌朝 `C:\rclone\logs\<日付>.log` を確認する。`ERROR` が出ていないこと
- `Z:\_Backup\_deleted\` は日付フォルダが増え続ける。**3ヶ月をめどに古いものを手で削除する**
- NAS本体のディスクエラーログを一度確認しておく(バックアップ先として使い続けられる状態か)

> **ランサムウェア対策としては不完全**。NASは常時マウントされているため、
> 本番機が汚染されればNAS側も巻き込まれうる。より強くするなら、
> 外付けドライブを月1回だけ繋いで世代を取り、普段は外しておく運用を足す。

## 7. NASを「共有フォルダ」としては廃止する

NAS本体はバックアップ先として残るが、**社員がファイルを置く場所としては廃止する**。

- 移行後**2〜4週間は読み取り専用でNASの旧データを残す**(取りこぼしの確認期間)
- 期間中に「あのファイルがない」が出なければ、旧データを消して手順6のバックアップ専用機に切り替える
- 切り替え前に一度だけ、NASとGoogle側のファイル数を突き合わせる

> **既知の差分(2026-08-05)**: NAS側だけに残るファイルが1件ある。
> `Z:\DESIGN\真義\真義様手提げバッグ\` にスペース有り・無しの同名PDFが2つあり、
> スペース無しのほうはコピー済み、スペース有りのほうは重複のため意図的にコピーしていない
> (社長判断)。ファイル数を突き合わせたときに1件ズレるのはこれが理由。

---

## 動作確認チェックリスト

- [x] `dir /s /b "Z:\DESIGN" | find /c /v ""` が40万未満 → **25,580件**(2026-08-05実測)
- [x] NAS全体の容量を把握した → **約142GB**(うちDESIGN 116GB)
- [x] 共有ドライブに本番Windows機のアカウントの権限がある → `HiYOSHi共有`
- [x] `dir G:\` で `共有ドライブ`(日本語表記)を確認した
- [ ] Googleドライブのドライブ文字が `G:` に**明示指定**されている(「自動」のままにしない)
- [ ] ログオン時にGoogleドライブが自動起動する
- [ ] `.env` の3項目を書き換えた
- [ ] `migrate-storage-path.js --scan` の結果が想定どおり
- [ ] `--apply` 実行後、案件詳細からフォルダが開ける
- [ ] 注文フォームのテスト送信で画像が共有ドライブに保存される(→テストデータ削除)
- [ ] `/manual`(社員向けガイド)のNAS記述を更新した
- [ ] rcloneの初回バックアップが完走した
- [ ] NASを読み取り専用にした

## うまくいかないときは

| 症状 | 原因と対処 |
|---|---|
| フォルダ一覧が空になる | Googleドライブが起動していない / `G:` が割り当たっていない。タスクトレイのアイコンを確認 |
| 「不正なパスです」と出る | `.env` の `NAS_BASE_PATH` とDB内のパスがずれている。`--scan` で突き合わせる |
| フォルダを開くのが遅い | ストリーミングのため初回は取得に時間がかかる。頻繁に使うフォルダは「オフラインで使用可能」に指定 |
| 再起動後にHiBoardからフォルダが見えない | Googleドライブの起動よりHiBoardの起動が早いことがある。`run-server-loop.bat` は5秒後に再起動するため通常は自然復旧する |
| 全部壊した | `db\backups\projects_manual_before-path-migration_*.db` を `db\projects.db` に戻し、`.env` を元に戻せば元の状態に戻る |

## 関連ドキュメント

- `CLAUDE.md` — 開発ルール・本番反映手順
- `docs/Windowsサービス化手順.md` — 常駐化がタスクスケジューラ方式である理由
- `docs/サーバー機移行手順.md` — サーバー機を入れ替える場合の手順
- `README.md` — DBのバックアップ・復元
