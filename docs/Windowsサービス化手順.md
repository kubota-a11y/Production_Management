# 本番機のWindowsサービス化手順(NSSM)

サーバー(node)が落ちたときに**自動で再起動**し、ログオフや窓の閉じ忘れでも止まらないようにする設定。
一度設定すれば以後の運用は変わらない(update.bat がサービスを自動検出して停止・起動に使う)。

## なぜ必要か

現在は update.bat が開く「生産管理サーバー」ウィンドウで node が動いている。この方式には次の弱点がある:

- 未捕捉の例外で node が落ちると、**誰かが「画面が開かない」と気づくまで止まったまま**
- ウィンドウを誤って閉じる/Windowsからログオフするだけでサーバーが止まる
- PC再起動後は誰かが update.bat を実行するまで起動しない

サービス化するとこの3つとも解消される(クラッシュ時自動再起動・ログオフ無関係・PC起動時に自動開始)。

## 手順(本番機で1回だけ実施)

### 1. NSSMのダウンロード

1. https://nssm.cc/download から最新版(nssm 2.24)のzipをダウンロード
2. zipを展開し、`win64\nssm.exe` を `C:\nssm\nssm.exe` に置く

### 2. サービス登録(管理者権限のコマンドプロンプト)

スタートメニュー →「cmd」と入力 →「管理者として実行」で開き、以下を1行ずつ実行:

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

意味:
- `AppDirectory` — アプリのフォルダ(.envやdbをここから読む)
- `AppStdout/AppStderr` — これまでコンソールに流れていたログをファイルに保存(10MBでローテーション)
- `AppExit Default Restart` + `AppRestartDelay 5000` — 落ちたら5秒後に自動再起動
- `Start SERVICE_AUTO_START` — PC起動時に自動開始(ログオン不要)

※ node.exe の場所が違う場合は `where node` で確認して1行目のパスを差し替える。

### 3. 切り替え

```bat
taskkill /F /IM node.exe
net start HiBoard
```

ブラウザで `http://localhost:3000` が開けば完了。

### 4. 動作確認(任意)

タスクマネージャーで node.exe を強制終了してみる → 5秒ほどで自動復活し、画面が再び開ければOK。

## 以後の運用

- **本番反映はこれまでどおり update.bat をダブルクリックするだけ**。update.bat は `HiBoard` サービスの有無を自動判定し、あればサービスの停止・起動を使う
- サーバーのログ: `db\service-out.log` / `db\service-err.log`
- クラッシュの記録: `db\crash.log`(server.js が終了直前に原因を書き残す)
- 手動での停止/起動: `net stop HiBoard` / `net start HiBoard`(管理者cmd)

## 元に戻したいとき

```bat
net stop HiBoard
C:\nssm\nssm.exe remove HiBoard confirm
```

その後は従来どおり update.bat の通常起動(別ウィンドウ)に自動で戻る。
