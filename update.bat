@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo === 生産管理アプリ 更新スクリプト ===
echo.

echo [1/4] Node.exe を停止しています...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

tasklist | findstr /i "node.exe" >nul
if %errorlevel%==0 (
    echo   ！ node.exe がまだ残っています。タスクマネージャーで終了してから再実行してください。
    pause
    exit /b 1
)

echo [2/4] 最新のコードを取得しています (git pull)...
git pull
if errorlevel 1 (
    echo   ！ git pull に失敗しました。ネットワーク接続を確認してから再実行してください。
    pause
    exit /b 1
)

echo [3/4] 依存パッケージを確認しています (npm install)...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo   ！ npm install に失敗しました。上のエラーメッセージを確認してください。
    pause
    exit /b 1
)

echo [4/4] サーバーを起動しています...
start "生産管理サーバー" cmd /k npm start

echo.
echo 更新が完了しました。サーバーは別ウィンドウで起動しています。
echo ブラウザで画面を開き直せば新しいバージョンが表示されます（Ctrl+Shift+R は不要です）。
echo.
pause
