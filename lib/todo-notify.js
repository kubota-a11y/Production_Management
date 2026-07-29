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

/**
 * 顧客名が取れなかったLINE問い合わせは、個別行を作らず当日1行のサマリに集約する。
 * (1件ごとに行を作ると社員のTODOが埋まって本来の仕事が見えなくなるため)
 */
function notifyIntakeSummary(intakeId) {
  if (!isConfigured()) return;
  try {
    const payload = {
      token: process.env.TODO_SHEET_TOKEN,
      action: 'add_line_summary',
      member: process.env.TODO_SHEET_MEMBER || '三浦',
      intake_id: intakeId,
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
          console.error(`[TODO通知] サマリ集約の応答が想定外: ${text.slice(0, 120)}`);
        } else {
          console.log(`[TODO通知] ${text}`);
        }
      })
      .catch(err => {
        console.error('[TODO通知] サマリ集約の送信失敗(受付処理には影響なし):', err.message);
      });
  } catch (err) {
    console.error('[TODO通知] サマリ集約の実行失敗(受付処理には影響なし):', err.message);
  }
}

/**
 * TODOリスト(スプレッドシート)のタスクを「完了」にする。
 * マイスケジュールボードで完了ボタンを押したときに呼ばれる。
 *
 * 上の2つと違い、成否を画面に返したいので fire&forget にせず結果を待つ。
 * シート行にIDが無いため、担当者名(タブ)とタスク本文の一致で行を特定する
 * (本文をシート側で書き換えると一致しなくなる点は予定紐づけと同じ制約)。
 *
 * 返り値: { ok: true } / { ok: false, error: '理由' }
 * ※ Apps Script 側に action='complete_task' の受け口が必要
 */
async function completeSheetTask({ member, task }) {
  if (!isConfigured()) return { ok: false, error: 'TODOリスト連携が未設定です' };
  try {
    const res = await fetch(process.env.TODO_SHEET_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: process.env.TODO_SHEET_TOKEN,
        action: 'complete_task',
        member: String(member || '').slice(0, 100),
        task: String(task || '').slice(0, 300),
      }),
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const text = (await res.text()).trim();
    if (/^OK/.test(text)) {
      console.log(`[TODO連携] シートのタスクを完了にしました: ${text.slice(0, 120)}`);
      return { ok: true };
    }
    console.error(`[TODO連携] 完了反映の応答が想定外: ${text.slice(0, 200)}`);
    // シートが理由を返した場合(NG: 該当するタスクが見つかりません 等)はそのまま伝える。
    // 受け口が未デプロイのときはHTML等が返るため、その旨を案内する
    if (/^NG:/.test(text)) {
      const reason = text.replace(/^NG:\s*/, '').slice(0, 200);
      // doPost に complete_task の分岐が無いと、末尾の別処理(秘書ボード書き込み)まで流れて
      // 「TypeError: Cannot read properties of undefined (reading 'map')」等のGAS内部エラーが返る。
      // 利用者には何を直せばよいか分からないため、原因の分かる文言に置き換える
      if (/TypeError|undefined|ReferenceError/.test(reason)) {
        return { ok: false, error: 'TODOリスト側の受け口(complete_task)が有効になっていません。Apps Scriptへの追加と再デプロイをご確認ください' };
      }
      return { ok: false, error: reason };
    }
    return { ok: false, error: 'TODOリスト側で完了にできませんでした(受け口が未設定の可能性があります)' };
  } catch (err) {
    console.error('[TODO連携] 完了反映の送信失敗:', err.message);
    return { ok: false, error: 'TODOリストへの接続に失敗しました' };
  }
}

/**
 * 受注候補を「登録」または「却下」したとき、対応するTODO行を完了にする。
 *
 * 追加時のタスク本文には必ず受付番号「(受付 L-123)」形式が入るため、
 * 受注候補IDで突き合わせて閉じる(接頭辞 L-/W-/T-/P- はシート側で吸収)。
 * 日次サマリ行(複数件をまとめた行)は個別IDで閉じられないため対象外。
 *
 * 受付処理を止めないファイア&フォーゲット。失敗してもログのみ。
 * ※ Apps Script 側に action='complete_by_intake' の受け口が必要
 */
function completeIntakeTask(intakeId, reason) {
  if (!isConfigured()) return;
  try {
    const payload = {
      token: process.env.TODO_SHEET_TOKEN,
      action: 'complete_by_intake',
      intake_id: String(intakeId),
      reason: String(reason || '').slice(0, 20),
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
          console.error(`[TODO完了連携] 受け口の応答が想定外: ${text.slice(0, 120)}`);
        } else {
          console.log(`[TODO完了連携] ${text}`);
        }
      })
      .catch(err => {
        console.error('[TODO完了連携] 送信失敗(受注処理には影響なし):', err.message);
      });
  } catch (err) {
    console.error('[TODO完了連携] 実行失敗(受注処理には影響なし):', err.message);
  }
}

module.exports = { notifyIntakeTask, notifyIntakeSummary, completeSheetTask, completeIntakeTask };
