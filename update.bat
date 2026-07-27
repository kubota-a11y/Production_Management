@echo off
cd /d "%~dp0"

rem 注意: このファイル自体が git pull で更新された場合、その1回目の実行は途中で
rem 意味不明なエラーで止まることがある(実行中のbatファイルが書き換わるため)。
rem その場合はもう一度ダブルクリックすれば正常に動く。
rem 順序は「バックアップ→取得→install→停止→起動」。取得やinstallに失敗しても
rem サーバーは旧コードのまま動き続ける(以前の「先に停止」方式は失敗時に止まったままになった)。

set SERVICE_NAME=HiBoard

echo === 生産管理アプリ 更新スクリプト ===
echo.

rem Windowsサービス(NSSM)導入済みならサービスで停止・起動する(docs/Windowsサービス化手順.md)
sc query "%SERVICE_NAME%" >nul 2>&1
if errorlevel 1 (set USE_SERVICE=0) else (set USE_SERVICE=1)

echo [1/5] 更新前バックアップを作成しています...
node scripts\backup-db.js
if errorlevel 1 goto BACKUP_FAIL

echo [2/5] 最新のコードを取得しています ^(git pull^)...
git pull
if errorlevel 1 goto PULL_FAIL

echo [3/5] 依存パッケージを確認しています ^(npm install^)...
call npm install --no-audit --no-fund
if not errorlevel 1 goto INSTALL_OK
echo   [注意] npm install に失敗しました。使用中ファイルの可能性があるため、サーバーを停止して再試行します...
call :STOP_NODE
if errorlevel 1 exit /b 1
call npm install --no-audit --no-fund
if not errorlevel 1 goto INSTALL_OK
echo   [注意] npm install が再度失敗しました。現在サーバーは停止しています。
echo          上のエラーメッセージを確認し、このスクリプトをもう一度実行してください。
pause
exit /b 1

:INSTALL_OK
echo [4/5] サーバーを停止しています...
call :STOP_NODE
if errorlevel 1 exit /b 1

echo [5/5] サーバーを起動しています...
if "%USE_SERVICE%"=="1" goto START_SERVICE
start "生産管理サーバー" cmd /k npm start
goto DONE

:START_SERVICE
net start "%SERVICE_NAME%"
if not errorlevel 1 goto DONE
echo   [注意] サービスの起動に失敗しました。念のため通常の方法で起動します...
start "生産管理サーバー" cmd /k npm start
goto DONE

:DONE
echo.
echo 更新が完了しました。ブラウザで画面を開き直せば新しいバージョンが表示されます。
echo.
pause
exit /b 0

:BACKUP_FAIL
echo   [注意] バックアップに失敗しました。安全のため更新を中断します。サーバーは動いたままです。
pause
exit /b 1

:PULL_FAIL
echo   [注意] git pull に失敗しました。ネットワーク接続を確認してから再実行してください。サーバーは動いたままです。
pause
exit /b 1

:STOP_NODE
if "%USE_SERVICE%"=="1" net stop "%SERVICE_NAME%" >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul
tasklist | findstr /i "node.exe" >nul
if errorlevel 1 exit /b 0
echo   [注意] node.exe がまだ残っています。タスクマネージャーで終了してから、もう一度実行してください。
pause
exit /b 1
