// 取引先(八木繊維)が納期確認ページから送ったコメントの Google Chat 通知(2026-09-16)。
//
// 社内では納期確認ページを見に行かないため、コメントが付いた瞬間に Google Chat の
// 専用スペース「八木繊維　案件コメント」へ投稿して気づけるようにする。
// (案件のメモ欄への追記は lib/partner-portal.js 側で行う。ここは通知だけ)
//
// 設定: .env の PARTNER_NOTIFY_GCHAT_WEBHOOK にそのスペースの Webhook URL を入れる。
//       未設定なら何もしない(開発機ではそのまま動く。バトンタッチ通知と同じ方針)。
// 方針: 通知の失敗でコメントの受付を止めない。fire-and-forget でログだけ残す。

const WEBHOOK_URL = process.env.PARTNER_NOTIFY_GCHAT_WEBHOOK || '';

function isConfigured() {
  return !!WEBHOOK_URL;
}

// 'YYYY-MM-DD' → 'M/D'。納期が空(未定)なら '未定'
function shortDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '未定';
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
}

// 投稿文。顧客名は取引先名そのものなので載せてよい(社内スペース向け)
function commentMessage({ partnerName, authorName, project, body, hiboardUrl }) {
  const lines = [
    `💬【${project.project_name}】${partnerName} ${authorName}様からコメントが届きました`,
    body,
    `(案件#${project.id} / 納品予定 ${shortDate(project.deadline)} / メモ欄にも追記済み)`,
  ];
  if (hiboardUrl) lines.push(hiboardUrl);
  return lines.join('\n');
}

// Google Chat へ投稿(fire-and-forget)。失敗しても呼び出し元へは投げない
function postToChat(text) {
  if (!isConfigured() || !text) return;
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ text }),
  }).then(res => {
    if (!res.ok) console.error(`[取引先コメント通知] Google Chat への投稿に失敗しました (HTTP ${res.status})`);
  }).catch(err => {
    console.error('[取引先コメント通知] Google Chat への投稿に失敗しました:', err.message);
  });
}

function notifyPartnerComment(args) {
  if (!isConfigured()) return;
  try {
    postToChat(commentMessage(args));
  } catch (err) {
    console.error('[取引先コメント通知] 通知の組み立てに失敗しました:', err.message);
  }
}

module.exports = { notifyPartnerComment, isConfigured, commentMessage };
