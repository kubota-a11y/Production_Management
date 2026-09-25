'use strict';

// 公式LINE AI受付「返信キュー」(2026-09-24・10月影運転)。
//
// 受信 → 一定秒の沈黙 → Claude が会話・HiBoardの情報・返信ルール・価格ルールを読んで
// 「返信の下書き・用件の分類・注文になりそうか・不足情報」をJSONで作る → line_reply_drafts(pending)
// → HiBoardの /line-reply で人が [送信]/[直して送信]/[送らない] → Messaging API で push 送信
// → 送信も line_messages(direction='out') に残す(次回以降のAIの文脈になる)。
//
// 設計書: docs/AI受付_影運転設計_20260923.md
// 返信ルール: 共有ドライブ Claude設定/共通/AI受付_返信ルール.md(価格ルール.md と一緒に読み込む)
//
// .env:
//   AI_REPLY_ENABLED=off            … 下書き生成を止める(既定 on。ANTHROPIC_API_KEY が無ければ自動で off)
//   AI_REPLY_MODEL                  … 既定 claude-opus-5
//   AI_REPLY_QUIET_SECONDS          … 受信後の沈黙秒数(連投待ち)。既定 90
//   AI_REPLY_RULE_PATHS             … 返信ルール・価格ルールのパス(カンマ区切り)。未設定時は共有ドライブの既定
//   AI_REPLY_GCHAT_WEBHOOK          … Googleチャット「LINE返信キュー」の Webhook URL(未設定なら通知しない)
//   AI_REPLY_NOTIFY_BASE_URL        … 通知に載せるHiBoardのURL(既定 http://192.168.0.31:3000)
//   AI_REPLY_SIGNATURE              … 署名(既定 HiYOSHi 担当:三浦)
//   AI_REPLY_AUTO_AFTER_HOURS=on    … 営業時間外の「受付確認」だけ自動送信(既定 off。久保田がOKを出すまで off)
//   AI_REPLY_SEND_MODE=dry          … 送信を実際には行わずログだけ(開発機の検証用)
//   AI_REPLY_CONTEXT_DAYS           … AIが読むLINE履歴・受注候補/案件の期間(日)。既定 7(2026-09-24 30→7。前回の注文を拾わないため)

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const priceTool = require('./price-tool');
const lineFiles = require('./line-files');
const { isJpHoliday } = require('./jp-holidays');

const JST = 9 * 3600e3;
const CATEGORIES = ['受付確認', '不足情報の質問', 'パック定額案内', '定型案内', '個別見積', '納期確定', 'データ確認', '納品連絡', '修正・不具合', '権利物・AI画像', '挨拶のみ', '時間外受付確認', 'その他'];
const ORDER_TYPES = ['KRATVSカスタムオーダー', 'ユニフォーム(昇華)', '1枚からパック', '一般加工', '八木繊維(卸)', '顧客別定価', '仕入品', '不明'];
const FLAGS = ['価格に触れた', '納期に触れた', '権利物', 'クレーム', '社長確認', '画像あり', '日程'];
const AFTER_HOURS_TEXT = 'お問い合わせありがとうございます。\n営業時間(平日10:00〜17:00)外のため、営業日に担当よりご連絡いたします。\nよろしくお願いいたします。';

const state = { db: null, lineClient: null, client: null, timers: new Map(), running: new Set(), rules: { text: '', loadedAt: 0, stamp: '' } };

function cfg() {
  const env = process.env;
  return {
    enabled: env.AI_REPLY_ENABLED !== 'off' && Boolean(env.ANTHROPIC_API_KEY),
    model: env.AI_REPLY_MODEL || 'claude-opus-5',
    quietSeconds: Math.max(10, parseInt(env.AI_REPLY_QUIET_SECONDS, 10) || 90),
    rulePaths: env.AI_REPLY_RULE_PATHS ? env.AI_REPLY_RULE_PATHS.split(',').map((s) => s.trim()).filter(Boolean) : defaultRulePaths(),
    gchat: env.AI_REPLY_GCHAT_WEBHOOK || '',
    baseUrl: (env.AI_REPLY_NOTIFY_BASE_URL || 'http://192.168.0.31:3000').replace(/\/$/, ''),
    signature: env.AI_REPLY_SIGNATURE || 'HiYOSHi 担当:三浦',
    autoAfterHours: env.AI_REPLY_AUTO_AFTER_HOURS === 'on',
    dryRun: env.AI_REPLY_SEND_MODE === 'dry',
    contextDays: contextDays(),
  };
}

function defaultRulePaths() {
  const names = ['AI受付_返信ルール.md', '価格ルール.md'];
  if (process.platform === 'win32') return names.map((n) => path.join('G:\\共有ドライブ\\HiYOSHi共有\\Claude設定\\共通', n));
  const mac = '/Users/kubota/Library/CloudStorage/GoogleDrive-kubota@hiyoshi1954.com/共有ドライブ/HiYOSHi共有/Claude設定/共通';
  return names.map((n) => path.join(mac, n));
}

function init({ db, lineClient }) {
  state.db = db;
  state.lineClient = lineClient;
  const c = cfg();
  if (c.enabled) state.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const rules = loadRules();
  console.log(`[AI受付] ${c.enabled ? `有効(model=${c.model}・沈黙${c.quietSeconds}秒・AIが読む期間${c.contextDays}日・時間外自動送信=${c.autoAfterHours ? 'on' : 'off'}${c.dryRun ? '・送信はdry-run' : ''})` : '無効(AI_REPLY_ENABLED=off か ANTHROPIC_API_KEY 未設定)'}・ルール文書 ${rules.files.length}本(${rules.files.map((f) => path.basename(f)).join(', ') || '無し'})・通知=${c.gchat ? 'あり' : '無し'}`);
}

// ---- ルール文書(返信ルール+価格ルール)。5分ごとに mtime を見て差し替える ----
function loadRules() {
  const c = cfg();
  const now = Date.now();
  if (state.rules.loadedAt && now - state.rules.loadedAt < 5 * 60 * 1000) return state.rules;
  const files = [];
  const parts = [];
  const stamps = [];
  for (const p of c.rulePaths) {
    try {
      const st = fs.statSync(p);
      const text = fs.readFileSync(p, 'utf8');
      files.push(p);
      stamps.push(`${p}:${st.mtimeMs}`);
      parts.push(`<document name="${path.basename(p)}">\n${text}\n</document>`);
    } catch (err) {
      // 無いファイルは飛ばす(開発機で共有ドライブが無い場合など)。起動ログにだけ出す
      if (!state.rules.loadedAt) console.warn(`[AI受付] ルール文書を読めません: ${p} (${err.message})`);
    }
  }
  const stamp = stamps.join('|');
  if (stamp !== state.rules.stamp && state.rules.loadedAt) console.log('[AI受付] ルール文書を再読込しました');
  state.rules = { text: parts.join('\n\n'), files, loadedAt: now, stamp };
  return state.rules;
}

// ---- 営業時間(平日10〜17時・祝日除く)。設計書§10 ----
function jstParts(d = new Date()) {
  const j = new Date(d.getTime() + JST);
  return { ymd: j.toISOString().slice(0, 10), hour: j.getUTCHours(), minute: j.getUTCMinutes(), dow: j.getUTCDay() };
}
function isBusinessTime(d = new Date()) {
  const { ymd, hour, dow } = jstParts(d);
  if (dow === 0 || dow === 6) return false;
  if (isJpHoliday(ymd)) return false;
  return hour >= 10 && hour < 17;
}
function describeNow(d = new Date()) {
  const { ymd, hour, minute, dow } = jstParts(d);
  const dows = ['日', '月', '火', '水', '木', '金', '土'];
  const holiday = isJpHoliday(ymd);
  return `${ymd}(${dows[dow]})${holiday ? '・祝日' : ''} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} 日本時間。${isBusinessTime(d) ? '営業時間内' : '営業時間外(営業時間は平日10:00〜17:00)'}`;
}

// ---- 受信のたびに呼ばれる(server.js の /webhook から) ----
function onInbound(lineUserId) {
  if (!state.db) return;
  try { maybeAutoAck(lineUserId); } catch (err) { console.error('[AI受付] 時間外の受付確認でエラー:', err.message); }
  const c = cfg();
  if (!c.enabled) return;
  const prev = state.timers.get(lineUserId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    state.timers.delete(lineUserId);
    generateDraft(lineUserId, { reason: 'inbound' }).catch((err) => console.error(`[AI受付] 下書き生成に失敗 user=${lineUserId.slice(0, 8)}:`, err.message));
  }, c.quietSeconds * 1000);
  state.timers.set(lineUserId, t);
}

// 営業時間外の受付確認(AI_REPLY_AUTO_AFTER_HOURS=on のときだけ)。同じ相手には12時間に1回まで。
function maybeAutoAck(lineUserId) {
  const c = cfg();
  if (!c.autoAfterHours || isBusinessTime()) return;
  const db = state.db;
  const user = db.prepare('SELECT ai_reply_muted, price_profile FROM line_users WHERE line_user_id = ?').get(lineUserId);
  if (!user || user.ai_reply_muted) return;
  const recent = db.prepare(`
    SELECT 1 FROM line_messages WHERE line_user_id = ? AND direction = 'out' AND received_at >= ? LIMIT 1
  `).get(lineUserId, new Date(Date.now() - 12 * 3600e3).toISOString());
  if (recent) return;
  const info = db.prepare(`
    INSERT INTO line_reply_drafts (line_user_id, trigger_message_ids, last_inbound_at, created_at, category, summary, reply_text, order_likelihood, flags, status, final_text, decided_by, decided_at, model)
    VALUES (?, '[]', ?, ?, '時間外受付確認', '営業時間外の受付確認(自動)', ?, 'low', '[]', 'pending', ?, 'AI(自動)', ?, 'rule')
  `).run(lineUserId, new Date().toISOString(), new Date().toISOString(), AFTER_HOURS_TEXT, AFTER_HOURS_TEXT, new Date().toISOString());
  pushText(lineUserId, AFTER_HOURS_TEXT, { sentBy: 'AI(自動)', draftId: info.lastInsertRowid, status: 'auto_sent' })
    .catch((err) => console.error('[AI受付] 時間外の受付確認の送信に失敗:', err.message));
}

// ---- 取りこぼし(再起動など)の拾い上げ。server.js から60秒ごと ----
async function runReplyCycle() {
  const c = cfg();
  if (!c.enabled || !state.db) return;
  const since = new Date(Date.now() - c.quietSeconds * 1000).toISOString();
  const rows = state.db.prepare(`
    SELECT m.line_user_id, MAX(m.received_at) AS last_in
    FROM line_messages m
    JOIN line_users u ON u.line_user_id = m.line_user_id
    WHERE m.direction = 'in' AND u.ai_reply_muted = 0
      AND m.received_at >= ?
    GROUP BY m.line_user_id
    HAVING MAX(m.received_at) <= ?
  `).all(new Date(Date.now() - 24 * 3600e3).toISOString(), since);
  for (const r of rows) {
    if (state.timers.has(r.line_user_id) || state.running.has(r.line_user_id)) continue;
    const lastOut = state.db.prepare(`SELECT MAX(received_at) AS t FROM line_messages WHERE line_user_id = ? AND direction = 'out'`).get(r.line_user_id).t || '';
    const lastDraft = state.db.prepare(`SELECT MAX(last_inbound_at) AS t FROM line_reply_drafts WHERE line_user_id = ? AND status != 'superseded'`).get(r.line_user_id).t || '';
    if (r.last_in > lastOut && r.last_in > lastDraft) {
      await generateDraft(r.line_user_id, { reason: 'cycle' }).catch((err) => console.error(`[AI受付] 巡回で下書き生成に失敗 user=${r.line_user_id.slice(0, 8)}:`, err.message));
    }
  }
}

// ---- 文脈の組み立て ----
// 返信先になれるLINEのID: 個人(U…)・グループ(C…)・複数人トーク(R…)。グループは2026-09-25から
function isLineUser(id) { return /^[UCR][0-9a-f]{32}$/.test(String(id || '')); }
function isGroupChat(id) { return /^[CR]/.test(String(id || '')); }

// AIが読む期間(日)。人が見る返信キューの画面表示(conversation・30日)とは別
function contextDays() {
  const n = parseInt(process.env.AI_REPLY_CONTEXT_DAYS, 10);
  return n >= 1 && n <= 90 ? n : 7;
}

function buildContext(lineUserId) {
  const db = state.db;
  const user = db.prepare('SELECT * FROM line_users WHERE line_user_id = ?').get(lineUserId);
  const days = contextDays();
  const sinceIso = new Date(Date.now() - days * 86400e3).toISOString();
  const messages = db.prepare(`
    SELECT id, direction, message_type, text_content, image_path, received_at, sent_by, sent_file_id, sender_name
    FROM line_messages WHERE line_user_id = ? AND received_at >= ?
    ORDER BY received_at ASC
  `).all(lineUserId, sinceIso).slice(-60);
  const lastOutAt = [...messages].reverse().find((m) => m.direction === 'out');
  const trigger = messages.filter((m) => m.direction === 'in' && (!lastOutAt || m.received_at > lastOutAt.received_at)).slice(-20);
  const intakes = db.prepare(`
    SELECT id, line_user_id, extracted_at, status, customer_name, items, quantity, deadline, notes, case_id, triage_type
    FROM ai_extracted_intake WHERE (line_user_id = ? OR linked_line_user_id = ?) AND extracted_at >= ?
    ORDER BY extracted_at DESC LIMIT 6
  `).all(lineUserId, lineUserId, sinceIso);
  const caseIds = [...new Set(intakes.map((i) => i.case_id).filter(Boolean))];
  const projects = caseIds.length ? db.prepare(`
    SELECT id, project_name, item_name, status, deadline, ops_stage, payment_status, quantity, process_type, received_date
    FROM projects WHERE id IN (${caseIds.map(() => '?').join(',')})
  `).all(...caseIds) : [];
  const quotes = caseIds.length ? db.prepare(`
    SELECT case_id, total, discount_name, created_at FROM case_quotes WHERE case_id IN (${caseIds.map(() => '?').join(',')}) ORDER BY created_at DESC
  `).all(...caseIds) : [];
  return { user, messages, trigger, intakes, projects, quotes, forms: formIntakes(lineUserId), days };
}

function fmtJst(iso) {
  const j = new Date(Date.parse(iso) + JST);
  return `${j.toISOString().slice(5, 10).replace('-', '/')} ${j.toISOString().slice(11, 16)}`;
}

function imageBlock(imagePath) {
  try {
    const buf = fs.readFileSync(imagePath);
    if (buf.length > 4 * 1024 * 1024) return { type: 'text', text: '[画像(4MB超のため省略)]' };
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } };
  } catch (err) {
    return { type: 'text', text: '[画像(読み込み失敗)]' };
  }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    needs_reply: { type: 'boolean', description: '返信が必要か。お礼・スタンプだけなら false' },
    category: { type: 'string', enum: CATEGORIES },
    order_type: { type: 'string', enum: ORDER_TYPES },
    summary: { type: 'string', description: '用件の1行要約(40字以内・キュー一覧用)' },
    reply_text: { type: 'string', description: '返信本文。needs_reply=false なら空文字' },
    order_likelihood: { type: 'string', enum: ['high', 'low'] },
    flags: { type: 'array', items: { type: 'string', enum: FLAGS } },
    missing_info: { type: 'array', items: { type: 'string' }, description: '見積・受注に足りない項目' },
    intake_patch: {
      type: 'object', additionalProperties: false,
      properties: {
        customer_name: { type: ['string', 'null'] }, items: { type: ['string', 'null'] },
        quantity: { type: ['string', 'null'] }, deadline: { type: ['string', 'null'] }, notes: { type: ['string', 'null'] },
      },
      required: ['customer_name', 'items', 'quantity', 'deadline', 'notes'],
    },
    confidence: { type: 'number', description: '0〜1' },
    reasoning_note: { type: 'string', description: '承認者向けの補足(何を根拠にしたか・迷った点)。60字以内' },
  },
  required: ['needs_reply', 'category', 'order_type', 'summary', 'reply_text', 'order_likelihood', 'flags', 'missing_info', 'intake_patch', 'confidence', 'reasoning_note'],
};

function systemPrompt() {
  const c = cfg();
  const rules = loadRules();
  const fixed = `あなたは有限会社HiYOSHi(静岡県長泉町・プリント/刺繍加工・チームウェアブランドKRATVS)の公式LINEの受付AIです。
受付担当の三浦さんの代わりに、お客様への「返信の下書き」を作ります。下書きは人が確認してから送ります。

## 守ること(要点。詳細は下のルール文書)
- 返信ルール文書の文体・型・禁止事項に従う。署名は「${c.signature}」を最後の行に入れる(短い受け答えには不要)
- 価格は「注文タイプ」を先に判定し、価格ルールの判定順(§0)に沿って該当の表だけを使う。金額を書くときは必ずツール(calc_processing / lookup_body / calc_pack / calc_kratvs_custom / lookup_uniform_catalog / lookup_repair / lookup_common)を呼び、ツールが返した数字だけを書く。自分で計算しない
- 定額(1枚からパック・KRATVSカスタムオーダー・ユニリペア・ユニフォームのカタログ定価)はそのまま案内してよい。一般加工は「概算」と明記し「正式な金額はお見積もりでご案内いたします」を添える。税区分(税込/税抜)を必ず書く
- 距離割引・値引き・社長確認ケース(価格ルール§0のリスト)は金額を出さず「担当より改めてご案内いたします」。flags に「社長確認」
- 納期の目安は「2週間ほど」。確定の日付は書かない(「正式な納期は担当よりご案内いたします」)
- 在庫・作業の進捗・打ち合わせの日程は推測で答えない(「お調べします」「確認のうえご連絡いたします」)
- 修正・クレームは謝罪と事実確認の質問だけ。作り直し・値引き・返金の約束は書かない。flags に「クレーム」「社長確認」
- 「久保田に確認した」「社長と相談した」とは書かない(あなたは確認していない)
- 名乗りがあれば「◯◯様」、なければ呼びかけ無し。LINEの表示名は使わない
- 営業時間外に届いた受信でも、下書きは通常どおり用件に答える形で作る(時間外の受付確認は別の仕組みが送る)
- 分からないことは質問で返す。1通で聞く質問は2つまで
- 当社からの送信履歴が無い(または古い)会話では、前回の返信内容を推測しない。「以前のやり取り」は履歴にある範囲だけを根拠にする

## 出力
JSONのみ。category は用件、order_type は注文タイプ(不明なら「不明」)、order_likelihood は「この会話が注文につながりそうか」、
missing_info は見積・受注に足りない項目、intake_patch は受注候補に足せる情報(分からない項目は null)、
flags は該当するものすべて(金額を書いたら必ず「価格に触れた」、画像が来ていたら「画像あり」)。
needs_reply=false(お礼・了解・スタンプだけ)のときは reply_text を空にする。

## ルール文書
${rules.text || '(ルール文書が読み込めていません。価格に触れる返信は作らず「担当より改めてご案内いたします」にしてください)'}`;
  return [{ type: 'text', text: fixed, cache_control: { type: 'ephemeral', ttl: '1h' } }];
}

function userContent(ctx) {
  const blocks = [];
  const lines = [];
  const imgs = [];
  for (const m of ctx.messages) {
    // グループでは誰の発言かを添える(返信はグループ全員に見える)
    const who = m.direction === 'out' ? `当社(${m.sent_by || '担当'})` : (m.sender_name ? `お客様(${m.sender_name})` : 'お客様');
    if (m.message_type === 'text') lines.push(`[${fmtJst(m.received_at)}] ${who}: ${m.text_content || ''}`);
    else if (m.message_type === 'image') { lines.push(`[${fmtJst(m.received_at)}] ${who}: [画像 #${m.id}]`); if (m.direction === 'in' && m.image_path) imgs.push(m); }
    else if (m.message_type === 'file' && m.direction === 'out') lines.push(`[${fmtJst(m.received_at)}] ${who}: ${m.text_content || '[ファイルを送信]'}`);
    else lines.push(`[${fmtJst(m.received_at)}] ${who}: [${m.message_type}]`);
  }
  const triggerIds = ctx.trigger.map((m) => m.id);
  const hb = {
    表示名: ctx.user ? ctx.user.display_name : null,
    トーク: ctx.user && isGroupChat(ctx.user.line_user_id) ? 'グループ(返信はメンバー全員に見える。誰への返信か分かるよう、必要なら発言者の名前を添える)' : '個人トーク',
    価格プロファイル: ctx.user && ctx.user.price_profile ? ctx.user.price_profile : '一般',
    受注候補: ctx.intakes.map((i) => ({ 受付番号: `${i.line_user_id === ctx.user?.line_user_id ? 'L' : 'Q'}-${i.id}`, 日時: fmtJst(i.extracted_at), 状態: i.status, 仕分け: i.triage_type, 顧客名: i.customer_name, 内容: i.items, 数量: i.quantity, 希望納期: i.deadline, メモ: i.notes ? String(i.notes).slice(0, 400) : null, 案件ID: i.case_id })),
    案件: ctx.projects.map((p) => ({ 案件ID: p.id, 案件名: p.project_name, 品目: p.item_name, 状態: p.status, 進行段階: p.ops_stage, 入金: p.payment_status, 納期: p.deadline || '未定', 数量: p.quantity, 加工: p.process_type, 受付日: p.received_date })),
    見積: ctx.quotes.map((q) => ({ 案件ID: q.case_id, 合計税抜: q.total, 割引: q.discount_name, 日時: fmtJst(q.created_at) })),
  };
  blocks.push({ type: 'text', text: `## 今の状況\n${describeNow()}\n\n## 会話履歴(直近${ctx.days || contextDays()}日・古い順。当社の送信はHiBoardから送った分だけ記録されています)\n${lines.join('\n') || '(履歴なし)'}\n\n## 今回返信する対象(最新の受信 #${triggerIds.join(', #')})\n${ctx.trigger.map((m) => m.message_type === 'text' ? m.text_content : `[${m.message_type}]`).join('\n---\n')}\n\n## HiBoardの情報\n${JSON.stringify(hb, null, 1)}` });
  for (const m of imgs.slice(-4)) {
    blocks.push({ type: 'text', text: `画像 #${m.id}(${fmtJst(m.received_at)} お客様):` });
    blocks.push(imageBlock(m.image_path));
  }
  // フォーム(Q-/W-/T-/P-)に添付された参考画像も見せる(LINEの画像と合わせて最大4枚)
  let budget = 4 - Math.min(4, imgs.length);
  for (const f of ctx.forms || []) {
    for (const im of f.images) {
      if (budget <= 0) break;
      blocks.push({ type: 'text', text: `フォーム ${f.receipt} の参考画像(${im.name}):` });
      blocks.push(imageBlock(im.path));
      budget--;
    }
  }
  blocks.push({ type: 'text', text: '上の「今回返信する対象」に対する返信の下書きを、指定のJSON形式で作ってください。' });
  return blocks;
}

// ---- 下書き生成 ----
async function generateDraft(lineUserId, { reason = 'manual', force = false } = {}) {
  const c = cfg();
  const db = state.db;
  if (!c.enabled || !state.client) return { skipped: 'disabled' };
  if (!isLineUser(lineUserId)) return { skipped: 'not-line-user' };
  if (state.running.has(lineUserId)) return { skipped: 'running' };
  const user = db.prepare('SELECT * FROM line_users WHERE line_user_id = ?').get(lineUserId);
  if (!user) return { skipped: 'no-user' };
  if (user.ai_reply_muted && !force) return { skipped: 'muted' };
  const ctx = buildContext(lineUserId);
  if (!ctx.trigger.length && !force) return { skipped: 'nothing-to-reply' };
  state.running.add(lineUserId);
  const startedAt = Date.now();
  const lastInboundAt = ctx.trigger.length ? ctx.trigger[ctx.trigger.length - 1].received_at : (ctx.messages.length ? ctx.messages[ctx.messages.length - 1].received_at : new Date().toISOString());
  const triggerIds = ctx.trigger.map((m) => m.id);
  try {
    // 未処理の古い下書きは作り直し扱い
    db.prepare(`UPDATE line_reply_drafts SET status = 'superseded' WHERE line_user_id = ? AND status = 'pending'`).run(lineUserId);

    let messages = [{ role: 'user', content: userContent(ctx) }];
    const usage = { input: 0, output: 0, cacheRead: 0 };
    const toolCalls = [];
    let finalText = null;
    for (let i = 0; i < 8; i++) {
      const res = await state.client.messages.create({
        model: c.model,
        max_tokens: 6000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        system: systemPrompt(),
        tools: priceTool.TOOLS,
        messages,
      });
      usage.input += res.usage?.input_tokens || 0;
      usage.output += res.usage?.output_tokens || 0;
      usage.cacheRead += res.usage?.cache_read_input_tokens || 0;
      if (res.stop_reason === 'refusal') throw new Error('モデルが応答を拒否しました(refusal)');
      const toolUses = res.content.filter((b) => b.type === 'tool_use');
      if (res.stop_reason === 'tool_use' && toolUses.length) {
        messages.push({ role: 'assistant', content: res.content });
        const results = toolUses.map((t) => {
          const out = priceTool.runTool(t.name, t.input);
          toolCalls.push({ name: t.name, input: t.input, ok: out && out.ok !== false });
          return { type: 'tool_result', tool_use_id: t.id, content: JSON.stringify(out) };
        });
        messages.push({ role: 'user', content: results });
        continue;
      }
      if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
      finalText = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      break;
    }
    if (!finalText) throw new Error('JSONの応答が得られませんでした');
    const parsed = JSON.parse(finalText);
    const flags = Array.isArray(parsed.flags) ? parsed.flags : [];
    if (ctx.trigger.some((m) => m.message_type === 'image') && !flags.includes('画像あり')) flags.push('画像あり');
    if (/\d[\d,]*\s*円/.test(parsed.reply_text || '') && !flags.includes('価格に触れた')) flags.push('価格に触れた');
    const info = db.prepare(`
      INSERT INTO line_reply_drafts
        (line_user_id, trigger_message_ids, last_inbound_at, created_at, category, summary, reply_text, order_likelihood, flags, missing_info, intake_patch, confidence, order_type, status, model, input_tokens, output_tokens, cache_read_tokens, tool_calls)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      lineUserId, JSON.stringify(triggerIds), lastInboundAt, new Date().toISOString(),
      parsed.needs_reply === false ? '挨拶のみ' : parsed.category, String(parsed.summary || '').slice(0, 120), parsed.reply_text || '',
      parsed.order_likelihood || 'low', JSON.stringify(flags), JSON.stringify(parsed.missing_info || []), JSON.stringify({ ...(parsed.intake_patch || {}), reasoning_note: parsed.reasoning_note || '' }),
      typeof parsed.confidence === 'number' ? parsed.confidence : null, parsed.order_type || '不明',
      c.model, usage.input, usage.output, usage.cacheRead, JSON.stringify(toolCalls),
    );
    const draftId = info.lastInsertRowid;
    console.log(`[AI受付] 下書き #${draftId} 作成 user=${lineUserId.slice(0, 8)} 分類=${parsed.category} 注文=${parsed.order_likelihood} ツール${toolCalls.length}回 ${Math.round((Date.now() - startedAt) / 1000)}秒 (in ${usage.input}/cache ${usage.cacheRead}/out ${usage.output}) reason=${reason}`);
    notifyDraft(draftId, user, parsed, flags);
    // 受注候補との連動(2026-09-24): 会話ごとに候補を乱発せず、注文の可能性が高いときだけ1件にまとめる。
    // 対象の受信は processed=1 にして、15分ごとの旧抽出(ai-extraction.js)が別の候補を作らないようにする
    try { syncIntakeFromDraft(draftId, { lineUserId, triggerIds, parsed, user }); } catch (err) { console.error('[AI受付] 受注候補の連動でエラー:', err.message); }
    return { draftId };
  } catch (err) {
    db.prepare(`
      INSERT INTO line_reply_drafts (line_user_id, trigger_message_ids, last_inbound_at, created_at, status, error, model)
      VALUES (?, ?, ?, ?, 'error', ?, ?)
    `).run(lineUserId, JSON.stringify(triggerIds), lastInboundAt, new Date().toISOString(), String(err.message || err).slice(0, 500), c.model);
    throw err;
  } finally {
    state.running.delete(lineUserId);
  }
}

// ---- 受注候補との連動(2026-09-24) ----
// 旧: LINEの会話が15分途切れるたびに受注候補が1件立ち、9割が却下されていた(9/23棚卸し: 473件→確定32件)。
// 新: 返信キューのAIが「注文の可能性: 高」と判断したときだけ、そのお客様の未処理候補を1件に保つ(あれば更新・無ければ作成)。
//     下書きの対象になった受信は processed=1 にして旧抽出の対象から外す(旧しくみはAI受付を止めたときの予備)。
const INTAKE_WINDOW_DAYS = 14;
function findOpenIntake(lineUserId) {
  const since = new Date(Date.now() - INTAKE_WINDOW_DAYS * 86400e3).toISOString();
  return state.db.prepare(`
    SELECT * FROM ai_extracted_intake WHERE line_user_id = ? AND status = 'pending' AND extracted_at >= ?
    ORDER BY extracted_at DESC LIMIT 1
  `).get(lineUserId, since) || null;
}
function syncIntakeFromDraft(draftId, { lineUserId, triggerIds, parsed, user, force = false }) {
  const db = state.db;
  const ids = (triggerIds || []).filter((n) => n > 0);
  if (ids.length) db.prepare(`UPDATE line_messages SET processed = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  const high = parsed && parsed.order_likelihood === 'high';
  if (!high && !force) return null;
  const patch = (parsed && parsed.intake_patch) || {};
  const now = new Date().toISOString();
  const existing = findOpenIntake(lineUserId);
  const mergeIds = (oldJson) => {
    let old = [];
    try { old = JSON.parse(oldJson || '[]'); } catch { old = []; }
    return JSON.stringify([...new Set([...old, ...ids])]);
  };
  const noteLine = `[${now.slice(0, 16).replace('T', ' ')} AI受付 #${draftId}] ${parsed.summary || ''}${patch.notes ? ` / ${patch.notes}` : ''}`;
  let intakeId;
  if (existing) {
    // 空欄だけ埋め、メモは追記する(人が直した内容を上書きしない)
    db.prepare(`
      UPDATE ai_extracted_intake SET
        customer_name = COALESCE(NULLIF(customer_name, ''), ?),
        items = COALESCE(NULLIF(items, ''), ?),
        quantity = COALESCE(NULLIF(quantity, ''), ?),
        deadline = COALESCE(NULLIF(deadline, ''), ?),
        notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || char(10) || ? END,
        message_ids = ?
      WHERE id = ?
    `).run(patch.customer_name || null, patch.items || null, patch.quantity || null, patch.deadline || null, noteLine, noteLine, mergeIds(existing.message_ids), existing.id);
    intakeId = existing.id;
    console.log(`[AI受付] 受注候補 L-${intakeId} を更新(下書き #${draftId})`);
  } else {
    const raw = { source: 'ai_reply', draft_id: draftId, category: parsed.category, order_type: parsed.order_type, order_likelihood: parsed.order_likelihood, missing_info: parsed.missing_info || [], created_at: now };
    const info = db.prepare(`
      INSERT INTO ai_extracted_intake (line_user_id, extracted_at, customer_name, items, quantity, deadline, notes, raw_ai_response, message_ids, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(lineUserId, now, patch.customer_name || null, patch.items || parsed.summary || null, patch.quantity || null, patch.deadline || null, noteLine, JSON.stringify(raw), JSON.stringify(ids));
    intakeId = info.lastInsertRowid;
    console.log(`[AI受付] 受注候補 L-${intakeId} を作成(下書き #${draftId})`);
    try {
      const { notifyIntakeTask } = require('./todo-notify');
      notifyIntakeTask(`公式LINE問い合わせ対応: ${patch.customer_name || (user && user.display_name) || '(表示名なし)'} — ${patch.items || parsed.summary || '内容は受注候補を確認'}(受付 L-${intakeId})`);
    } catch (_) { /* 通知は業務を止めない */ }
  }
  db.prepare('UPDATE line_reply_drafts SET intake_id = ? WHERE id = ?').run(intakeId, draftId);
  return intakeId;
}

// 画面の「受注候補にする」: 注文の可能性が低いと判断された会話でも、人の判断で候補を作る/更新する
function createIntakeFromDraft(draftId) {
  const d = getDraft(draftId);
  if (!d) return { ok: false, error: '下書きが見つかりません' };
  const parsed = { order_likelihood: 'high', intake_patch: d.intake_patch || {}, summary: d.summary, category: d.category, order_type: d.order_type, missing_info: d.missing_info || [] };
  const user = state.db.prepare('SELECT display_name FROM line_users WHERE line_user_id = ?').get(d.line_user_id);
  const intakeId = syncIntakeFromDraft(draftId, { lineUserId: d.line_user_id, triggerIds: d.trigger_message_ids, parsed, user, force: true });
  return { ok: true, intake_id: intakeId };
}

// このお客様のLINE由来の受注候補(直近30日)。返信キューの詳細に出す
function lineIntakes(lineUserId) {
  const since = new Date(Date.now() - 30 * 86400e3).toISOString();
  return state.db.prepare(`
    SELECT id, extracted_at, status, customer_name, items, quantity, deadline, triage_type, case_id
    FROM ai_extracted_intake WHERE line_user_id = ? AND extracted_at >= ? ORDER BY extracted_at DESC LIMIT 5
  `).all(lineUserId, since).map((r) => ({ ...r, receipt: `L-${r.id}` }));
}

// ---- Googleチャット通知(本文は載せない) ----
function notifyDraft(draftId, user, parsed, flags) {
  const c = cfg();
  if (!c.gchat) return;
  if (parsed.needs_reply === false) return; // 返信不要の下書きは通知しない(通知疲れ対策)
  const mark = flags.includes('社長確認') ? '🔴' : flags.includes('価格に触れた') ? '💴' : '💬';
  const text = `${mark} LINE返信の下書き #${draftId}｜${user.display_name || '(表示名なし)'}｜${parsed.category}${parsed.order_likelihood === 'high' ? '・注文の可能性:高' : ''}｜${String(parsed.summary || '').slice(0, 60)}\n${c.baseUrl}/line-reply#draft-${draftId}`;
  fetch(c.gchat, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text }) })
    .then((r) => { if (!r.ok) console.error(`[AI受付] Googleチャット通知に失敗 (HTTP ${r.status})`); })
    .catch((err) => console.error('[AI受付] Googleチャット通知に失敗:', err.message));
}

// ---- 送信 ----
async function pushMessages(lineUserId, messages) {
  const c = cfg();
  if (c.dryRun) {
    console.log(`[AI受付] (dry-run) 送信: user=${lineUserId.slice(0, 8)} ${messages.map((m) => m.type).join('+')}`);
    return { sentMessages: messages.map((_, i) => ({ id: `dry-${Date.now()}-${i}` })) };
  }
  return state.lineClient.pushMessage({ to: lineUserId, messages });
}

// 個人宛ての送信の前に、届く相手か(公式LINEを友だち追加しているか)を確かめる(2026-09-25)。
// LINEは友だちでない・ブロック中の相手への push をエラーにせず黙って捨てるため、確かめないと
// 「送信済み」と記録されたのに届いていない状態になる。グループ・複数人トークは確認しない
async function checkReachable(lineUserId) {
  if (isGroupChat(lineUserId) || cfg().dryRun || !state.lineClient) return { ok: true };
  try {
    await state.lineClient.getProfile(lineUserId);
    return { ok: true };
  } catch (err) {
    const status = err && (err.status || err.statusCode || (err.response && err.response.status));
    if (status === 404) {
      return { ok: false, error: 'このお客様は公式LINEを友だち追加していない(またはブロック中の)ため、送っても届きません。グループ内のやり取りなら、グループ(👥)の会話から返信してください。届かなかったので送信はしていません' };
    }
    // 通信の不調などで確認できないときは止めない(確認のせいで返信できなくなるのを避ける)
    console.warn('[AI受付] 友だち確認に失敗(送信は続行):', err && err.message);
    return { ok: true };
  }
}

// 本文(text)と添付(attachmentIds: line_sent_files.id の配列)を送る。本文 → ファイルごとに[画像…, リンク] の順。
// LINEの push は1回5件までなので分割する。送った分は line_messages(direction='out') に残す
async function pushText(lineUserId, text, { sentBy, draftId = null, status = 'sent', attachmentIds = [] }) {
  const db = state.db;
  const now = new Date().toISOString();
  let firstMessageId = null;
  let firstRowId = null;
  if (text) {
    const res = await pushMessages(lineUserId, [{ type: 'text', text }]);
    firstMessageId = res && res.sentMessages && res.sentMessages[0] ? res.sentMessages[0].id : null;
    const info = db.prepare(`
      INSERT INTO line_messages (line_user_id, line_message_id, message_type, text_content, image_path, received_at, processed, case_id, direction, sent_by, reply_draft_id)
      VALUES (?, ?, 'text', ?, NULL, ?, 1, NULL, 'out', ?, ?)
    `).run(lineUserId, firstMessageId, text, now, sentBy || null, draftId);
    firstRowId = info.lastInsertRowid;
  }
  for (const fileId of attachmentIds || []) {
    const { messages, file } = lineFiles.messagesFor(fileId);
    for (let i = 0; i < messages.length; i += 5) await pushMessages(lineUserId, messages.slice(i, i + 5));
    const label = `[ファイル送信] ${file.file_name}${file.preview_count ? `(画像${file.preview_count}枚+リンク)` : '(リンク)'} ${file.url}`;
    const info = db.prepare(`
      INSERT INTO line_messages (line_user_id, line_message_id, message_type, text_content, image_path, received_at, processed, case_id, direction, sent_by, reply_draft_id, sent_file_id)
      VALUES (?, NULL, 'file', ?, NULL, ?, 1, NULL, 'out', ?, ?, ?)
    `).run(lineUserId, label, new Date().toISOString(), sentBy || null, draftId, fileId);
    lineFiles.markSent(fileId, { sentBy, messageRowId: info.lastInsertRowid });
    if (!firstRowId) firstRowId = info.lastInsertRowid;
  }
  if (draftId) {
    db.prepare(`UPDATE line_reply_drafts SET status = ?, sent_line_message_id = ?, decided_at = COALESCE(decided_at, ?) WHERE id = ?`).run(status, firstMessageId, now, draftId);
  }
  return { messageRowId: firstRowId, messageId: firstMessageId };
}

function similarity(a, b) {
  const s = String(a || '').trim(); const t = String(b || '').trim();
  if (!s && !t) return 1;
  if (!s || !t) return 0;
  const m = s.length, n = t.length;
  if (m > 3000 || n > 3000) return s === t ? 1 : 0;
  let prev = new Array(n + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

function normalizeAttachmentIds(ids) {
  const list = Array.isArray(ids) ? ids.map((n) => parseInt(n, 10)).filter((n) => n > 0) : [];
  if (list.length && !lineFiles.isReady()) throw new Error('PUBLIC_ORDER_BASE_URL が未設定のためファイルを送れません');
  for (const id of list) { if (!lineFiles.get(id)) throw new Error(`添付ファイル #${id} が見つかりません`); }
  return list;
}

async function sendDraft(draftId, { text, sentBy, attachmentIds }) {
  const db = state.db;
  const d = db.prepare('SELECT * FROM line_reply_drafts WHERE id = ?').get(draftId);
  if (!d) return { ok: false, error: '下書きが見つかりません' };
  if (!['pending'].includes(d.status)) return { ok: false, error: `この下書きは既に処理済みです(${d.status})` };
  const finalText = String(text || d.reply_text || '').trim();
  let files;
  try { files = normalizeAttachmentIds(attachmentIds); } catch (err) { return { ok: false, error: err.message }; }
  if (!finalText && !files.length) return { ok: false, error: '本文が空です' };
  const reach = await checkReachable(d.line_user_id);
  if (!reach.ok) return { ok: false, error: reach.error };
  const edited = finalText !== String(d.reply_text || '').trim();
  const now = new Date().toISOString();
  const ratio = edited ? Math.round((1 - similarity(d.reply_text, finalText)) * 1000) / 1000 : 0;
  const respMin = d.last_inbound_at ? Math.round(((Date.now() - Date.parse(d.last_inbound_at)) / 60000) * 10) / 10 : null;
  db.prepare(`UPDATE line_reply_drafts SET final_text = ?, decided_by = ?, decided_at = ?, edit_ratio = ?, response_minutes = ? WHERE id = ?`)
    .run(finalText, sentBy || null, now, ratio, respMin, draftId);
  const sent = await pushText(d.line_user_id, finalText, { sentBy, draftId, status: edited ? 'edited' : 'sent', attachmentIds: files });
  return { ok: true, status: edited ? 'edited' : 'sent', edit_ratio: ratio, response_minutes: respMin, files: files.length, ...sent };
}

async function sendManual(lineUserId, { text, sentBy, attachmentIds }) {
  const t = String(text || '').trim();
  let files;
  try { files = normalizeAttachmentIds(attachmentIds); } catch (err) { return { ok: false, error: err.message }; }
  if (!t && !files.length) return { ok: false, error: '本文が空です' };
  if (!isLineUser(lineUserId)) return { ok: false, error: 'LINEのユーザーではありません' };
  const reach = await checkReachable(lineUserId);
  if (!reach.ok) return { ok: false, error: reach.error };
  const db = state.db;
  // 未処理の下書きがあれば「手動で返信した」として閉じる(統計では discarded/manual と区別する)
  db.prepare(`UPDATE line_reply_drafts SET status = 'discarded', discard_reason = 'manual', decided_by = ?, decided_at = ? WHERE line_user_id = ? AND status = 'pending'`).run(sentBy || null, new Date().toISOString(), lineUserId);
  const sent = await pushText(lineUserId, t, { sentBy, draftId: null, attachmentIds: files });
  return { ok: true, files: files.length, ...sent };
}

function discardDraft(draftId, { reason, by }) {
  const db = state.db;
  const d = db.prepare('SELECT status FROM line_reply_drafts WHERE id = ?').get(draftId);
  if (!d) return { ok: false, error: '下書きが見つかりません' };
  if (d.status !== 'pending') return { ok: false, error: `この下書きは既に処理済みです(${d.status})` };
  db.prepare(`UPDATE line_reply_drafts SET status = 'discarded', discard_reason = ?, decided_by = ?, decided_at = ? WHERE id = ?`)
    .run(String(reason || '').slice(0, 100), by || null, new Date().toISOString(), draftId);
  return { ok: true };
}

function setMuted(lineUserId, muted, priceProfile) {
  const db = state.db;
  if (typeof priceProfile === 'string') db.prepare('UPDATE line_users SET ai_reply_muted = ?, price_profile = ? WHERE line_user_id = ?').run(muted ? 1 : 0, priceProfile || null, lineUserId);
  else db.prepare('UPDATE line_users SET ai_reply_muted = ? WHERE line_user_id = ?').run(muted ? 1 : 0, lineUserId);
  return { ok: true };
}

// ---- 画面用の読み出し ----
function listDrafts({ status = 'pending', limit = 100 } = {}) {
  const db = state.db;
  const where = status === 'done' ? `d.status IN ('sent','edited','discarded','auto_sent')` : status === 'all' ? '1=1' : 'd.status = ?';
  const params = status === 'done' || status === 'all' ? [] : [status];
  const rows = db.prepare(`
    SELECT d.*, u.display_name, u.ai_reply_muted, u.price_profile
    FROM line_reply_drafts d LEFT JOIN line_users u ON u.line_user_id = d.line_user_id
    WHERE ${where}
    ORDER BY CASE WHEN d.status = 'pending' THEN 0 ELSE 1 END, d.created_at DESC
    LIMIT ?
  `).all(...params, limit);
  return rows.map(shapeDraft);
}
function shapeDraft(r) {
  const j = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
  return { ...r, flags: j(r.flags, []), missing_info: j(r.missing_info, []), intake_patch: j(r.intake_patch, {}), trigger_message_ids: j(r.trigger_message_ids, []), tool_calls: j(r.tool_calls, []) };
}
function getDraft(id) {
  const r = state.db.prepare(`SELECT d.*, u.display_name, u.ai_reply_muted, u.price_profile FROM line_reply_drafts d LEFT JOIN line_users u ON u.line_user_id = d.line_user_id WHERE d.id = ?`).get(id);
  return r ? shapeDraft(r) : null;
}
function conversation(lineUserId, { days = 30, limit = 80 } = {}) {
  const sinceIso = new Date(Date.now() - days * 86400e3).toISOString();
  const user = state.db.prepare('SELECT line_user_id, display_name, ai_reply_muted, price_profile, first_seen_at FROM line_users WHERE line_user_id = ?').get(lineUserId);
  const messages = state.db.prepare(`
    SELECT id, direction, message_type, text_content, image_path, received_at, sent_by, reply_draft_id, sent_file_id, sender_name
    FROM line_messages WHERE line_user_id = ? AND received_at >= ? ORDER BY received_at ASC
  `).all(lineUserId, sinceIso).slice(-limit).map((m) => (m.sent_file_id ? { ...m, sent_file: lineFiles.get(m.sent_file_id) } : m));
  const pendingCount = state.db.prepare(`SELECT COUNT(*) AS n FROM line_reply_drafts WHERE status = 'pending'`).get().n;
  // 「案件フォルダから選ぶ」用: このお客様に紐づく案件のフォルダ
  const folders = state.db.prepare(`
    SELECT DISTINCT p.id, p.project_name, p.customer_name, p.nas_folder_path
    FROM ai_extracted_intake i JOIN projects p ON p.id = i.case_id
    WHERE (i.line_user_id = ? OR i.linked_line_user_id = ?) AND p.nas_folder_path IS NOT NULL AND p.nas_folder_path != ''
    ORDER BY p.id DESC LIMIT 10
  `).all(lineUserId, lineUserId);
  return { user, messages, pendingCount, folders, intakes: formIntakes(lineUserId), lineIntakes: lineIntakes(lineUserId), filesReady: lineFiles.isReady() };
}

// このお客様に紐づく「フォーム由来の受注候補」(公式LINE入口フォーム Q- / Web注文 W- / チーム追加 T- / 取引先 P-)。
// 問い合わせ内容(notes)と添付画像(raw_ai_response.images)を返信キューの画面で見られるようにする(2026-09-24 社長要望)
const RECEIPT_PREFIX = { WEB: 'W', TEAM: 'T', PARTNER: 'P', MAIL: 'M', PHONE: 'D', INQ_TEAM: 'Q', INQ_CLASS_T: 'Q', INQ_ORIGINAL: 'Q' };
const KIND_LABEL = { INQ_TEAM: 'チーム・サッカーウェア', INQ_CLASS_T: 'クラスTシャツ', INQ_ORIGINAL: 'オリジナルアイテム', WEB: 'Web注文フォーム', TEAM: 'チーム追加注文', PARTNER: '取引先加工依頼', MAIL: 'メール', PHONE: '電話' };
function formIntakes(lineUserId) {
  const rows = state.db.prepare(`
    SELECT id, line_user_id, extracted_at, status, customer_name, items, quantity, deadline, notes, raw_ai_response, case_id, triage_type, reference_link
    FROM ai_extracted_intake
    WHERE (linked_line_user_id = ? OR line_user_id = ?) AND line_user_id NOT LIKE 'U%' AND line_user_id NOT LIKE 'C%' AND line_user_id NOT LIKE 'R%'
    ORDER BY extracted_at DESC LIMIT 5
  `).all(lineUserId, lineUserId);
  return rows.map((r) => {
    let raw = {};
    try { raw = JSON.parse(r.raw_ai_response || '{}'); } catch { raw = {}; }
    const images = Array.isArray(raw.images) ? raw.images.filter((im) => im && im.unc_path).map((im) => ({ path: im.unc_path, name: im.file_name || im.original_name || im.name || im.unc_path.split(/[\\/]/).pop() })) : [];
    const prefix = RECEIPT_PREFIX[r.line_user_id] || 'L';
    return {
      id: r.id, receipt: `${prefix}-${r.id}`, kind: KIND_LABEL[r.line_user_id] || r.line_user_id, extracted_at: r.extracted_at, status: r.status,
      customer_name: r.customer_name, items: r.items, quantity: r.quantity, deadline: r.deadline, notes: r.notes || '', case_id: r.case_id, triage_type: r.triage_type,
      images,
    };
  });
}
function pendingCount() {
  return state.db.prepare(`SELECT COUNT(*) AS n FROM line_reply_drafts WHERE status = 'pending' AND category != '挨拶のみ'`).get().n;
}

// ---- 集計(/api/ops-inventory の lineReply に載せる) ----
function replyStats(from, to) {
  const db = state.db;
  const toIso = `${to}T23:59:59+09:00`;
  const fromIso = `${from}T00:00:00+09:00`;
  const rows = db.prepare(`SELECT * FROM line_reply_drafts WHERE created_at >= ? AND created_at <= ?`).all(new Date(fromIso).toISOString(), new Date(toIso).toISOString());
  const byCat = {};
  const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
  const st = { total: rows.length, byStatus: {}, byCategory: {}, byOrderType: {}, unmodifiedRateByCategory: {}, editRatio: [], responseMinutes: [], discardReasons: {}, tokens: { input: 0, output: 0, cacheRead: 0 }, flags: {}, likelihood: { high: 0, low: 0 } };
  for (const r of rows) {
    inc(st.byStatus, r.status);
    inc(st.byOrderType, r.order_type || '(未設定)');
    if (r.order_likelihood) inc(st.likelihood, r.order_likelihood);
    st.tokens.input += r.input_tokens || 0; st.tokens.output += r.output_tokens || 0; st.tokens.cacheRead += r.cache_read_tokens || 0;
    try { for (const f of JSON.parse(r.flags || '[]')) inc(st.flags, f); } catch { /* noop */ }
    if (r.status === 'error' || r.status === 'superseded') continue;
    const cat = r.category || '(未設定)';
    inc(st.byCategory, cat);
    const b = byCat[cat] || (byCat[cat] = { decided: 0, sent: 0 });
    if (['sent', 'edited', 'discarded'].includes(r.status)) { b.decided++; if (r.status === 'sent') b.sent++; }
    if (r.status === 'edited' && typeof r.edit_ratio === 'number') st.editRatio.push(r.edit_ratio);
    if (['sent', 'edited'].includes(r.status) && typeof r.response_minutes === 'number') st.responseMinutes.push(r.response_minutes);
    if (r.status === 'discarded') inc(st.discardReasons, r.discard_reason || '(理由なし)');
  }
  for (const [cat, b] of Object.entries(byCat)) st.unmodifiedRateByCategory[cat] = b.decided ? { decided: b.decided, unmodified: b.sent, rate: Math.round((b.sent / b.decided) * 100) } : { decided: 0, unmodified: 0, rate: null };
  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  st.editRatio = { n: st.editRatio.length, median: med(st.editRatio) };
  st.responseMinutes = { n: st.responseMinutes.length, median: med(st.responseMinutes) };
  st.outboundViaHiBoard = db.prepare(`SELECT COUNT(*) AS n FROM line_messages WHERE direction = 'out' AND received_at >= ? AND received_at <= ?`).get(new Date(fromIso).toISOString(), new Date(toIso).toISOString()).n;
  st.outboundManual = db.prepare(`SELECT COUNT(*) AS n FROM line_messages WHERE direction = 'out' AND reply_draft_id IS NULL AND received_at >= ? AND received_at <= ?`).get(new Date(fromIso).toISOString(), new Date(toIso).toISOString()).n;
  // 注文可能性の判定 vs 受注候補の結果(下書きの後24時間以内に同じ相手の候補が確定/却下されたか)
  const cmp = { high_confirmed: 0, high_rejected: 0, low_confirmed: 0, low_rejected: 0 };
  for (const r of rows) {
    if (!r.order_likelihood) continue;
    const it = db.prepare(`SELECT status FROM ai_extracted_intake WHERE line_user_id = ? AND extracted_at >= ? AND extracted_at <= ? AND status IN ('confirmed','rejected') ORDER BY extracted_at ASC LIMIT 1`)
      .get(r.line_user_id, r.created_at, new Date(Date.parse(r.created_at) + 24 * 3600e3).toISOString());
    if (it) inc(cmp, `${r.order_likelihood}_${it.status}`);
  }
  st.likelihoodVsIntake = cmp;
  return st;
}

// ---- 返信キューからの見積作成(2026-09-24) ----
// AIが会話・フォーム・HiBoardの情報から「見積シミュレーターに入れる条件」を組み立てる。
// 金額はここでは決めない(シミュレーターで人が確認して freee に発行する)。
const QUOTE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    customer_name: { type: ['string', 'null'], description: '取引先名(会社名・チーム名・個人名+様なし)。会話で名乗りがなければ null' },
    title: { type: ['string', 'null'], description: '品名(例: クラスTシャツ、スタッフポロシャツ)' },
    mode: { type: 'string', enum: ['normal', 'yagi', 'kratvs'] },
    bodies: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: {
          sku: { type: ['string', 'null'], description: 'lookup_body で確かめた品番(例 5001-01)。持込・不明なら null' },
          name_hint: { type: ['string', 'null'], description: '品番が分からないときの手がかり(綿T・ドライT・パーカーなど)' },
          qty: { type: 'integer' },
          manual_unit: { type: ['integer', 'null'], description: '持込など、リストに無いときの税抜単価(通常 null)' },
          note: { type: ['string', 'null'] },
          // 色・サイズの内訳(2026-09-24)。見積書は「色名　M:2 / L:4」の行に分かれ、単価も色区分・サイズ帯で決まる
          breakdown: {
            type: 'array', description: '色ごとのサイズ別枚数。会話に内訳が無ければ空配列',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                color: { type: 'string', description: 'お客様の言う色名そのまま(例 ホワイト×ブラック、アッシュ、ネイビー)' },
                price_class: { type: ['string', 'null'], description: 'lookup_body の size_bands にある色区分(ホワイト/カラー/アッシュ 等)。区分が無い品番は null' },
                sizes: {
                  type: 'array',
                  items: { type: 'object', additionalProperties: false, properties: { size: { type: 'string', description: 'S/M/L/XL/XXL/XXXL/150 など' }, qty: { type: 'integer' } }, required: ['size', 'qty'] },
                },
              },
              required: ['color', 'price_class', 'sizes'],
            },
          },
        },
        required: ['sku', 'name_hint', 'qty', 'manual_unit', 'note', 'breakdown'],
      },
    },
    rows: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: {
          location_name: { type: 'string', description: '箇所名(左胸・背面・袖 など)' },
          method: { type: 'string', enum: ['auto', 'silk', 'dtf', 'rubber', 'marking', 'emb', 'cap', 'nameEmb', 'dtfName'] },
          size: { type: 'string', enum: ['B8', 'B7', 'A5', 'A4', 'A3'] },
          colors: { type: 'string', description: '1〜4 か full' },
          surcharges: { type: 'array', items: { type: 'string' }, description: 'bring / special / specialInk / overlay / blousonS / blousonL / sheetNylon 等' },
        },
        required: ['location_name', 'method', 'size', 'colors', 'surcharges'],
      },
    },
    express: { type: 'boolean' },
    shipping: { type: 'string', enum: ['none', 's80', 's100'] },
    bagging: { type: 'string', enum: ['none', 'tee', 'sweat'] },
    kratvs: {
      type: ['object', 'null'], additionalProperties: false,
      properties: { item_code: { type: 'string' }, size_band: { type: ['string', 'null'] }, qty: { type: 'integer' }, prints: { type: 'array', items: { type: 'string' } } },
      required: ['item_code', 'size_band', 'qty', 'prints'],
    },
    missing: { type: 'array', items: { type: 'string' }, description: '見積に足りない情報(人が確認する項目)' },
    notes: { type: 'string', description: '担当者向けの補足(根拠・迷った点)。80字以内' },
    confidence: { type: 'number' },
  },
  required: ['customer_name', 'title', 'mode', 'bodies', 'rows', 'express', 'shipping', 'bagging', 'kratvs', 'missing', 'notes', 'confidence'],
};

async function buildQuoteConditions(draftId) {
  const c = cfg();
  const db = state.db;
  if (!c.enabled || !state.client) throw new Error('AI受付が無効のため見積条件を作れません');
  const d = db.prepare('SELECT * FROM line_reply_drafts WHERE id = ?').get(draftId);
  if (!d) throw new Error('下書きが見つかりません');
  const ctx = buildContext(d.line_user_id);
  const system = `あなたは有限会社HiYOSHi(プリント/刺繍加工)の見積担当アシスタントです。お客様とのLINEのやり取り・フォームの内容・HiBoardの情報から、
社内の見積シミュレーターに入れる「見積条件」だけをJSONで組み立てます。金額は決めません(人がシミュレーターで確認してfreeeに発行します)。

ルール:
- ボディ(無地の服)は lookup_body ツールで品番を確かめてから sku に入れる。会話に品番が無く種類だけ分かる場合は、その種類の代表的な品番を lookup_body で探して入れ、notes に「仮」と書く(綿Tは 5001-01、ドライTは 300-ACT、綿厚手Tは 00085、ドライポロは 5050-01 を目安)。持込なら sku=null・manual_unit=0
- 色・サイズの内訳が分かるボディは breakdown に「色ごと」に1件ずつ入れる(sizes はサイズ別の枚数。qty は内訳の合計と一致させる)。
  price_class は lookup_body の size_bands の頭にある色区分から選ぶ: 白系の生地(ホワイト)ならホワイト、アッシュはアッシュ、それ以外の色はカラー。
  ホワイト×ブラック等の2色切り替え(ラグラン等)で区分が1つしかない品番は null。2XL/3XLは XXL/XXXL と書く。内訳が会話に無ければ空配列にして missing に「サイズ・色の内訳」
- 持込のシャツ(お客様の手持ちに加工するだけ)は sku=null・manual_unit=0・name_hint に「持込シャツ」等・breakdown は空配列。加工行は持込分も含めた総枚数に載る
- 加工行は「箇所ごと」に1行。大きさは 左胸・袖・小さいロゴ=B8、A4程度=A4、背中全面=A3。色数が分からないフルカラー画像は full。単色なら 1
- 1〜5枚・対象ボディ・データ支給の小口は mode=normal のまま rows を作り、missing に「1枚からパック(定額)で案内する案件か確認」と書く
- KRATVSカスタムオーダー(T-01 等)の話なら mode=kratvs と kratvs を埋める。八木繊維様なら mode=yagi
- 分からない項目は推測で埋めず missing に書く(枚数・サイズ内訳・箇所・色数・データの有無・希望納期・持込か手配か)
- 出力はJSONのみ

参考(価格ルールの判定順・表の名前だけ):
${loadRules().text.slice(0, 6000)}`;
  const messages = [{ role: 'user', content: [...userContent(ctx).slice(0, -1), { type: 'text', text: '上のやり取りから見積条件をJSONで作ってください。' }] }];
  let finalText = null;
  const toolCalls = [];
  for (let i = 0; i < 6; i++) {
    const res = await state.client.messages.create({
      model: c.model, max_tokens: 4000, thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: QUOTE_SCHEMA } },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      tools: priceTool.TOOLS.filter((t) => t.name === 'lookup_body' || t.name === 'calc_kratvs_custom'),
      messages,
    });
    if (res.stop_reason === 'refusal') throw new Error('モデルが応答を拒否しました');
    const toolUses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason === 'tool_use' && toolUses.length) {
      messages.push({ role: 'assistant', content: res.content });
      messages.push({ role: 'user', content: toolUses.map((t) => { toolCalls.push(t.name); return { type: 'tool_result', tool_use_id: t.id, content: JSON.stringify(priceTool.runTool(t.name, t.input)) }; }) });
      continue;
    }
    finalText = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    break;
  }
  if (!finalText) throw new Error('見積条件のJSONが得られませんでした');
  const cond = JSON.parse(finalText);
  cond.generated_at = new Date().toISOString();
  cond.tool_calls = toolCalls;
  if (!cond.customer_name && ctx.user && ctx.user.display_name) cond.customer_name_hint = ctx.user.display_name;
  db.prepare('UPDATE line_reply_drafts SET quote_conditions = ? WHERE id = ?').run(JSON.stringify(cond), draftId);
  console.log(`[AI受付] 見積条件を作成 draft=#${draftId} bodies=${cond.bodies.length} rows=${cond.rows.length} missing=${cond.missing.length}`);
  return cond;
}

function getQuoteContext(draftId) {
  const d = getDraft(draftId);
  if (!d) return null;
  let cond = null;
  try { cond = d.quote_conditions ? JSON.parse(d.quote_conditions) : null; } catch { cond = null; }
  // 見積→案件登録(2026-09-24): この会話の受注候補(未処理なら「案件として登録」の行き先)と、登録済みの案件
  const it = d.intake_id ? state.db.prepare('SELECT id, status FROM ai_extracted_intake WHERE id = ?').get(d.intake_id) : null;
  const caseId = require('./quote-carry').resolveCaseForDraft(state.db, d.id);
  return {
    draft_id: d.id, line_user_id: d.line_user_id, display_name: d.display_name, summary: d.summary, conditions: cond,
    freee_quotation_number: d.freee_quotation_number, freee_report_url: d.freee_report_url, quote_file_id: d.quote_file_id,
    intake_id: it && it.status === 'pending' ? it.id : null, case_id: caseId || null,
  };
}

// freeeで発行した見積書を下書きに紐づけ、PDFが取れていれば添付ファイルとして預かる。本文も「見積送付」の型に差し替える
async function attachFreeeQuote(draftId, { quotationId, quotationNumber, reportUrl, pdfBuffer, sentBy }) {
  const db = state.db;
  const d = db.prepare('SELECT * FROM line_reply_drafts WHERE id = ?').get(draftId);
  if (!d) return { ok: false, error: '下書きが見つかりません' };
  let file = null;
  if (pdfBuffer && lineFiles.isReady()) {
    const tmp = path.join(require('os').tmpdir(), `freee-quote-${draftId}-${Date.now()}.pdf`);
    fs.writeFileSync(tmp, pdfBuffer);
    try {
      file = await lineFiles.storeFile({ sourcePath: tmp, originalName: `見積書_${quotationNumber || quotationId}.pdf`, lineUserId: d.line_user_id, source: 'freee', sourceLabel: reportUrl || null });
    } finally { try { fs.unlinkSync(tmp); } catch { /* noop */ } }
  }
  const c = cfg();
  const text = `お世話になっております。\n担当の三浦です。\n\nお見積もり作成いたしましたのでご確認お願いいたします。\nご不明な点がございましたらお知らせください。\n\nよろしくお願いいたします。\n${c.signature}`;
  db.prepare(`UPDATE line_reply_drafts SET freee_quotation_id = ?, freee_quotation_number = ?, freee_report_url = ?, quote_file_id = COALESCE(?, quote_file_id),
      reply_text = CASE WHEN status = 'pending' THEN ? ELSE reply_text END, category = CASE WHEN status = 'pending' THEN '見積送付' ELSE category END WHERE id = ?`)
    .run(quotationId || null, quotationNumber || null, reportUrl || null, file ? file.id : null, text, draftId);
  return { ok: true, file, draft_id: draftId };
}

module.exports = {
  init, onInbound, runReplyCycle, generateDraft, sendDraft, sendManual, discardDraft, setMuted,
  buildQuoteConditions, getQuoteContext, attachFreeeQuote, createIntakeFromDraft, lineIntakes,
  listDrafts, getDraft, conversation, pendingCount, replyStats, isBusinessTime, describeNow, loadRules, cfg,
  CATEGORIES, ORDER_TYPES, FLAGS, AFTER_HOURS_TEXT,
  _internal: { buildContext, userContent, systemPrompt, similarity, OUTPUT_SCHEMA },
};
