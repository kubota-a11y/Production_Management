# 本番機の常駐化手順(サーバーが落ちても自動で復活させる)

サーバー(node)が落ちたときに**自動で再起動**し、PC起動後も勝手に立ち上がるようにする設定。
一度設定すれば以後の運用は変わらない(本番反映はこれまでどおり `update.bat` をダブルクリックするだけ)。

## なぜ必要か

現在は update.bat が開く「生産管理サーバー」ウィンドウで node が動いている。この方式には次の弱点がある:

- 未捕捉の例外で node が落ちると、**誰かが「画面が開かない」と気づくまで止まったまま**
- ウィンドウを誤って閉じるとサーバーが止まる
- PC再起動後は誰かが update.bat を実行するまで起動しない

---

## 方法A: タスクスケジューラ(推奨・ダウンロード不要)

Windows標準の機能だけで完結する。**このアプリにはこちらが適している**(理由は下の「NASについての注意」を参照)。

`run-server-loop.bat` が node を起動し、落ちても5秒後に自動で起動し直す。
それをタスクスケジューラの「ログオン時」トリガーで自動起動する。

### 手順(本番機で1回だけ)

**2026-07-28に本番機(DESKTOP-VTQCQ4A)で実施済み。** 以下は再設定・移設時の手順。

1. **Windowsキー + X** →「**ターミナル(管理者)**」を選ぶ(タイトルに「管理者:」と付くこと)
2. 次の1行を実行する。**シェルによって書き方が違うので注意**

**PowerShell の場合**(「管理者: Windows PowerShell」と表示されている):

```powershell
schtasks /create /tn "HiBoard" /tr "C:\Production_Management_v2\run-server-loop.bat" /sc onlogon /ru "$env:USERNAME" /f
```

**コマンドプロンプト(cmd)の場合**:

```bat
schtasks /create /tn "HiBoard" /tr "C:\Production_Management_v2\run-server-loop.bat" /sc onlogon /ru "%USERNAME%" /f
```

> **つまずきやすい点(実際に発生したもの):**
> - PowerShellで `%USERNAME%` と書くと展開されず、
>   「アカウント名とセキュリティ ID の間のマッピングは実行されませんでした」になる
>   → PowerShellでは `$env:USERNAME` を使う
> - 管理者として実行していないと「アクセスが拒否されました」になる
>   → プロンプトが `C:\Users\...>` なら管理者ではない(管理者は `C:\Windows\System32>` から始まる)
> - **`/rl highest`(最上位の権限で実行)は付けないこと。**
>   管理者権限で動くプロセスからは、通常ユーザーが割り当てたドライブ(`Z:` など)が
>   見えなくなるWindowsの仕様があり、NASにアクセスできなくなる。
>   このアプリは管理者権限を必要としないため、通常の権限のままでよい

3. タスクが正しく作られたか確認する(「タスクの実行ユーザー」が普段使うアカウントであること)

```bat
schtasks /query /tn "HiBoard" /v /fo list
```

> 管理者として実行したときのアカウントが普段業務で使うアカウントと違う場合、
> ログオン時の自動起動が働かない。その場合は `/ru` に普段のアカウント名を明記して作り直す。

4. 現在動いている node を止めて、タスクから起動し直す

```bat
taskkill /F /IM node.exe
schtasks /run /tn "HiBoard"
```

> update.bat が開いていた古い「生産管理サーバー」ウィンドウが残っていれば閉じる
> (中身は停止済み。残すとどちらが動いているか分からなくなる)。
> 新しく開く**「生産管理サーバー (自動再起動あり)」**が正しいウィンドウ。

5. 動作確認(3点)

- ブラウザで `http://localhost:3000` が開ける
- **NASのデザインデータが開ける** — 「➕ 新規案件」→「NASデザインフォルダパス」欄の
  「📁 参照...」ボタンでフォルダ一覧が表示されればOK(案件は登録せず閉じてよい)
- **自動復活する** — 下記の手順で node.exe を強制終了し、5秒ほどで画面が再び開けばOK

### 自動復活のテスト方法

1. **Ctrl + Shift + Esc** でタスクマネージャーを開く
2. 「詳細」タブ(見当たらなければ左下の「詳細」で展開)
3. `node.exe` を選んで「タスクの終了」
4. 5秒ほど待ってブラウザを再読み込み → HiBoardが再び開けば成功

「生産管理サーバー (自動再起動あり)」ウィンドウには次のように表示される:

```
[日付 時刻] サーバーが終了しました(終了コード 1)。
5秒後に自動で起動し直します。
```

### 元に戻したいとき

```bat
schtasks /delete /tn "HiBoard" /f
```

---

## 方法B: Windowsサービス化(NSSM)

ログオンしていなくても動く点が方法Aより優れているが、**NASにアクセスできなくなる問題がある**(下記注意を参照)。
NASを使わない構成に変えた場合や、サービスの実行アカウントを設定できる場合のみ選ぶ。

### 1. NSSMのダウンロード

https://nssm.cc/download を開く。

- **Windows 10/11 では「Featured pre-release」の `nssm 2.24-101-g897c7ad` を使うこと**
  (安定版の2.24はWindows 10 Creators Update以降でサービスが起動しない不具合がある。ページ冒頭に注意書きあり)
- 直接リンク: https://nssm.cc/ci/nssm-2.24-101-g897c7ad.zip
- ※ページ上の「nssm 2.24-101-g897c7ad」という**文字自体がダウンロードリンク**(ボタンではない)

zipを展開し、`win64\nssm.exe` を `C:\nssm\nssm.exe` に置く。

### 2. サービス登録(管理者権限のコマンドプロンプト)

```bat
C:\nssm\nssm.exe install HiBoard "C:\Program Files\nodejs\node.exe" server.js
C:\nssm\nssm.exe set HiBoard AppDirectory C:\Production_Management_v2
C:\nssm\nssm.exe set HiBoard AppStdout C:\Production_Management_v2\db\service-out.log
C:\nssm\nssm.exe set HiBoard AppStderr C:\Production_Management_v2\db\service-err.log
C:\nssm\nssm.exe set HiBoard AppRotateFiles 1
C:\nssm\nssm.exe set HiBoard AppRotateBytes 10485760
C:\nssm\nssm.exe set HiBoard AppExit Default Restart
C:\nssm\nssm.exe set HiBoard AppRestartDelay 5000
C:\nssm\nssm.exe set HiBoard Start SERVICE_AUTO_START
```

※ node.exe の場所が違う場合は `where node` で確認して1行目のパスを差し替える。

### 3. 実行アカウントの設定(NASを使う場合は必須)

1. `services.msc` を開く → 「HiBoard」を右クリック → プロパティ
2. 「ログオン」タブ → 「アカウント」を選び、**普段業務で使っているWindowsユーザー**を指定してパスワードを入力
3. OK → サービスを再起動

これをしないと、サービスは LocalSystem という特殊なアカウントで動き、NASのドライブ(Z: など)が見えない。

### 4. 切り替え

```bat
taskkill /F /IM node.exe
net start HiBoard
```

### 元に戻したいとき

```bat
net stop HiBoard
C:\nssm\nssm.exe remove HiBoard confirm
```

---

## ⚠️ NASについての注意(方法選択の決め手)

このアプリは次の4か所でNAS上のフォルダを読み書きする:

| 用途 | 設定名 |
|---|---|
| デザインデータの閲覧・ダウンロード | `NAS_BASE_PATH` |
| Web注文フォームの添付画像の保存先 | `WEB_ORDER_RECEIVED_PATH` |
| 取引先 加工依頼フォームの画像の保存先 | `PARTNER_ORDER_RECEIVED_PATH` |
| DBバックアップのNAS二重保存 | `DB_BACKUP_EXTRA_DIR` |

`Z:` のような**割り当てドライブはユーザーごとの設定**のため、Windowsサービス(LocalSystem)からは見えない。
方法Bを選ぶ場合は、上記「3. 実行アカウントの設定」を必ず行うこと。
**方法Aはログオンユーザーとして動くため、この問題が起きない。**

---

## 以後の運用(方法A・Bとも共通)

- **本番反映はこれまでどおり `update.bat` をダブルクリックするだけ**。
  update.bat はタスク(方法A)・サービス(方法B)の有無を自動判定し、適切な方法で停止・起動する
- サーバーのログ:
  - 方法A → 「生産管理サーバー」ウィンドウに表示
  - 方法B → `db\service-out.log` / `db\service-err.log`
- クラッシュの記録: `db\crash.log`(server.js が終了直前に原因を書き残す)
- 手動での停止/起動:
  - 方法A → `schtasks /end /tn HiBoard` / `schtasks /run /tn HiBoard`
  - 方法B → `net stop HiBoard` / `net start HiBoard`(管理者cmd)
