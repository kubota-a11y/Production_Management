// 受注候補(ai_extracted_intake)に新規着地があったとき、
// 社員用TODOリスト(Google スプレッドシートの Apps Script 受け口)へ
// 対応タスクを1件追記する通知モジュール。
//
// .env に以下が設定されている場合のみ動作する(未設定なら何もしない):
//   TODO_SHEET_WEBAPP_URL  … Apps Script ウェブアプリのURL
//   TODO_SHEET_TOKEN       … 受け口の共有トークン
//   TODO_SHEET_MEMBER      … 追記先タブの担当者名(省略時: 三浦)
//
// 送信は非同期のファイア&フォーゲット。失敗してもログを出すだけで、
// 受付処理(LINE抽出/Web注文/チーム注文)には一切影響させない。

function isConfigured() {
  return Boolean(process.env.TODO_SHEET_WEBAPP_URL && process.env.TODO_SHEET_TOKEN);
}

function notifyIntakeTask(task) {
  if (!isConfigured()) return;
  try {
    const payload = {
      token: process.env.TODO_SHEET_TOKEN,
      action: 'add_task',
      member: process.env.TODO_SHEET_MEMBER || '三浦',
      task: String(task || '').slice(0, 300),
      memo: 'HiBoard受付より自動追加',
    };
    fetch(process.env.TODO_SHEET_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    })
      .then(res => res.text())
      .then(text => {
        if (!/^OK/.test(text)) {
          console.error(`[TODO通知] 受け口の応答が想定外: ${text.slice(0, 120)}`);
        } else {
          console.log(`[TODO通知] ${text}`);
        }
      })
      .catch(err => {
        console.error('[TODO通知] 送信失敗(受付処理には影響なし):', err.message);
      });
  } catch (err) {
    // fetch未対応のNode等でも受付処理を巻き込まない
    console.error('[TODO通知] 実行失敗(受付処理には影響なし):', err.message);
  }
}

module.exports = { notifyIntakeTask };
