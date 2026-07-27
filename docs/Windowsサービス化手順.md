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

1. スタートメニューで「cmd」と入力 → **「管理者として実行」**
2. 次の1行を実行(`%USERNAME%` はそのままでよい。今ログインしているユーザーが対象になる)

```bat
schtasks /create /tn "HiBoard" /tr "C:\Production_Management_v2\run-server-loop.bat" /sc onlogon /ru "%USERNAME%" /rl highest /f
```

3. 現在動いている node を止めて、タスクから起動し直す

```bat
taskkill /F /IM node.exe
schtasks /run /tn "HiBoard"
```

4. ブラウザで `http://localhost:3000` が開けば完了

### 動作確認(任意)

タスクマネージャーで node.exe を強制終了してみる → 5秒ほどで自動復活し、画面が再び開ければOK。

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
