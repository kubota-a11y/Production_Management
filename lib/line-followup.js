// 公式LINE入口フォーム(/inquiry/*)で送られたお問い合わせを、公式LINEのトーク(チャット)と結びつける(2026-09-14)。
//
// 背景: 入口フォームはLINEとは別の普通のWebページなので、送信してもお客様は公式LINEのチャット一覧に
// 出てこない。LINE公式アカウントは「お客様が1度でもトークを送った相手」にしか話しかけられないため、
// 電話でヒアリングしたあと「仕上がりイメージはLINEで送ります」と伝えても、こちらからは連絡できなかった
// (株式会社シーラン様の件・2026-09-14)。
//
// 対策は2段:
//   1. 送信完了画面と受付控えメールに「受付番号入りのメッセージが入力済みの状態で公式LINEのトークを開く」
//      リンクを置く(LINEのURLスキーム https://line.me/R/oaMessage/{ベーシックID}/?{本文})。お客様は送信を押すだけ。
//   2. フォームをLIFFアプリとして開いたとき(LINEアプリ内)は、送信と同時に liff.sendMessages で同じ本文を
//      お客様のトークとして自動投稿する(画面側 public/js/inquiry.js)。
// どちらの経路でも、本文はお客様の発言としてWebhookに届く。ここで「Q-番号」を読み取り、受注候補
// (ai_extracted_intake)に linked_line_user_id を書いて結びつける。以後は受注候補カードに「💬 LINE: 表示名」が
// 出るので、担当は公式LINEマネージャーのチャットでその名前を探して返信できる。
//
// 設定(.env・どちらも任意。未設定ならその機能だけ静かに無効になる):
//   LINE_OA_BASIC_ID … 公式アカウントのベーシックID(例 @abc1234。@は省略可)。1のリンクに使う
//   LINE_LIFF_ID     … LIFF ID。2の自動投稿に使う(LINE Developers の LINE Login チャネルで発行)

// 受付番号の読み取り。Q-12 / q-12 / Ｑ-12(全角) / Q−12(全角ハイフン) を許す
const RECEIPT_RE = /[QqＱ][-−ー－‐]\s*(\d{1,9})/;

function normalizeBasicId(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  return v.startsWith('@') ? v : `@${v}`;
}

function getOaBasicId() { return normalizeBasicId(process.env.LINE_OA_BASIC_ID); }
function getLiffId() { return String(process.env.LINE_LIFF_ID || '').trim(); }

// お客様がトークへ送る本文。受付番号が先頭に来るようにする(Webhook側の読み取りとチャット一覧での見つけやすさのため)
function buildFollowupText(receiptNo, customerName) {
  const who = String(customerName || '').trim();
  const L = [`【お問い合わせ】受付番号 ${receiptNo}`];
  L.push(who ? `${who} です。フォームからご相談を送りました。` : 'フォームからご相談を送りました。');
  return L.join('\n');
}

// 完了画面・受付控えメールに載せる { text, url }。ベーシックID未設定なら url は null(画面側は従来の友だち追加リンクに戻る)
function buildFollowup({ receiptNo, customerName }) {
  const text = buildFollowupText(receiptNo, customerName);
  const basicId = getOaBasicId();
  const url = basicId
    ? `https://line.me/R/oaMessage/${encodeURIComponent(basicId)}/?${encodeURIComponent(text)}`
    : null;
  return { text, url };
}

function parseReceiptId(text) {
  const m = String(text || '').match(RECEIPT_RE);
  return m ? Number(m[1]) : null;
}

function parseJsonSafe(s, fallback) {
  try { return JSON.parse(s); } catch (_) { return fallback; }
}

// Webhookで受け取ったテキストに受付番号(Q-)が含まれていれば、その受注候補をLINEユーザーと結びつける。
// 戻り値: { linked: true, intakeId, already } / { linked: false, reason }
//   - 対象は入口フォーム由来(line_user_id が INQ_*)の候補だけ。他の受付番号(W-/T-…)は対象外
//   - 紐づけたメッセージは processed=1 にして、AI抽出が別の受注候補(L-)を作らないようにする。
//     あわせて候補の message_ids に加え、詳細画面のトーク欄にそのまま出るようにする
//   - すでに同じユーザーと紐づいていればメッセージだけ取り込む。別のユーザーが同じ番号を送ってきた場合は上書きしない(先着)
function linkInquiryFromMessage(db, { lineUserId, text, messageRowId }) {
  const receiptId = parseReceiptId(text);
  if (!receiptId) return { linked: false, reason: 'no_receipt' };

  const intake = db.prepare(`
    SELECT id, line_user_id, linked_line_user_id, notes, message_ids
    FROM ai_extracted_intake
    WHERE id = ? AND line_user_id LIKE 'INQ\\_%' ESCAPE '\\'
  `).get(receiptId);
  if (!intake) return { linked: false, reason: 'not_inquiry' };

  if (intake.linked_line_user_id && intake.linked_line_user_id !== lineUserId) {
    return { linked: false, reason: 'linked_to_other', intakeId: intake.id };
  }
  const already = intake.linked_line_user_id === lineUserId;

  const user = db.prepare('SELECT display_name FROM line_users WHERE line_user_id = ?').get(lineUserId);
  const displayName = (user && user.display_name) || '(表示名なし)';
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const ids = parseJsonSafe(intake.message_ids, []);
  const messageIds = Array.isArray(ids) ? ids : [];
  if (messageRowId && !messageIds.includes(messageRowId)) messageIds.push(messageRowId);

  let notes = intake.notes || '';
  if (!already) {
    const line = `■LINEトーク: 紐づけ済み(表示名「${displayName}」・${stamp})。公式LINEマネージャーのチャットでこの名前を探すと返信できます`;
    notes = notes ? `${notes}\n${line}` : line;
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE ai_extracted_intake
      SET linked_line_user_id = ?, linked_line_at = COALESCE(linked_line_at, ?), notes = ?, message_ids = ?
      WHERE id = ?
    `).run(lineUserId, now.toISOString(), notes, JSON.stringify(messageIds), intake.id);
    if (messageRowId) {
      db.prepare('UPDATE line_messages SET processed = 1 WHERE id = ?').run(messageRowId);
    }
  })();

  return { linked: true, intakeId: intake.id, already };
}

module.exports = {
  RECEIPT_RE,
  getOaBasicId,
  getLiffId,
  buildFollowupText,
  buildFollowup,
  parseReceiptId,
  linkInquiryFromMessage,
};
