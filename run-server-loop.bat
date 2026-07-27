@echo off
cd /d "%~dp0"

rem 生産管理アプリ(HiBoard)の常駐起動用ランチャー。
rem node が何らかの理由で落ちても、5秒後に自動で起動し直す。
rem タスクスケジューラの「ログオン時」トリガーから実行する想定
rem (docs\Windowsサービス化手順.md の「方法A」を参照)。
rem
rem ログオンユーザーとして動くため、NASのドライブ(Z: など)にそのままアクセスできる。
rem ※このウィンドウを閉じるとサーバーも止まる。更新時は update.bat を使うこと。

title 生産管理サーバー (自動再起動あり)

:loop
echo.
echo [%date% %time%] サーバーを起動します...
echo ---------------------------------------------
node server.js
echo ---------------------------------------------
echo [%date% %time%] サーバーが終了しました(終了コード %errorlevel%)。
echo 5秒後に自動で起動し直します。完全に止めたい場合はこのウィンドウを閉じてください。
timeout /t 5 /nobreak >nul
goto loop
