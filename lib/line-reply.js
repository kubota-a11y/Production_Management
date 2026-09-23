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

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const priceTool = require('./price-tool');
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
  console.log(`[AI受付] ${c.enabled ? `有効(model=${c.model}・沈黙${c.quietSeconds}秒・時間外自動送信=${c.autoAfterHours ? 'on' : 'off'}${c.dryRun ? '・送信はdry-run' : ''})` : '無効(AI_REPLY_ENABLED=off か ANTHROPIC_API_KEY 未設定)'}・ルール文書 ${rules.files.length}本(${rules.files.map((f) => path.basename(f)).join(', ') || '無し'})・通知=${c.gchat ? 'あり' : '無し'}`);
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
function isLineUser(id) { return /^U[0-9a-f]{32}$/.test(String(id || '')); }

function buildContext(lineUserId) {
  const db = state.db;
  const user = db.prepare('SELECT * FROM line_users WHERE line_user_id = ?').get(lineUserId);
  const sinceIso = new Date(Date.now() - 30 * 86400e3).toISOString();
  const messages = db.prepare(`
    SELECT id, direction, message_type, text_content, image_path, received_at, sent_by
    FROM line_messages WHERE line_user_id = ? AND received_at >= ?
    ORDER BY received_at ASC
  `).all(lineUserId, sinceIso).slice(-60);
  const lastOutAt = [...messages].reverse().find((m) => m.direction === 'out');
  const trigger = messages.filter((m) => m.direction === 'in' && (!lastOutAt || m.received_at > lastOutAt.received_at)).slice(-20);
  const intakes = db.prepare(`
    SELECT id, line_user_id, extracted_at, status, customer_name, items, quantity, deadline, notes, case_id, triage_type
    FROM ai_extracted_intake WHERE line_user_id = ? OR linked_line_user_id = ?
    ORDER BY extracted_at DESC LIMIT 6
  `).all(lineUserId, lineUserId);
  const caseIds = [...new Set(intakes.map((i) => i.case_id).filter(Boolean))];
  const projects = caseIds.length ? db.prepare(`
    SELECT id, project_name, item_name, status, deadline, ops_stage, payment_status, quantity, process_type, received_date
    FROM projects WHERE id IN (${caseIds.map(() => '?').join(',')})
  `).all(...caseIds) : [];
  const quotes = caseIds.length ? db.prepare(`
    SELECT case_id, total, discount_name, created_at FROM case_quotes WHERE case_id IN (${caseIds.map(() => '?').join(',')}) ORDER BY created_at DESC
  `).all(...caseIds) : [];
  return { user, messages, trigger, intakes, projects, quotes };
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
    const who = m.direction === 'out' ? `当社(${m.sent_by || '担当'})` : 'お客様';
    if (m.message_type === 'text') lines.push(`[${fmtJst(m.received_at)}] ${who}: ${m.text_content || ''}`);
    else if (m.message_type === 'image') { lines.push(`[${fmtJst(m.received_at)}] ${who}: [画像 #${m.id}]`); if (m.direction === 'in' && m.image_path) imgs.push(m); }
    else lines.push(`[${fmtJst(m.received_at)}] ${who}: [${m.message_type}]`);
  }
  const triggerIds = ctx.trigger.map((m) => m.id);
  const hb = {
    表示名: ctx.user ? ctx.user.display_name : null,
    価格プロファイル: ctx.user && ctx.user.price_profile ? ctx.user.price_profile : '一般',
    受注候補: ctx.intakes.map((i) => ({ 受付番号: `${i.line_user_id === ctx.user?.line_user_id ? 'L' : 'Q'}-${i.id}`, 日時: fmtJst(i.extracted_at), 状態: i.status, 仕分け: i.triage_type, 顧客名: i.customer_name, 内容: i.items, 数量: i.quantity, 希望納期: i.deadline, メモ: i.notes ? String(i.notes).slice(0, 400) : null, 案件ID: i.case_id })),
    案件: ctx.projects.map((p) => ({ 案件ID: p.id, 案件名: p.project_name, 品目: p.item_name, 状態: p.status, 進行段階: p.ops_stage, 入金: p.payment_status, 納期: p.deadline || '未定', 数量: p.quantity, 加工: p.process_type, 受付日: p.received_date })),
    見積: ctx.quotes.map((q) => ({ 案件ID: q.case_id, 合計税抜: q.total, 割引: q.discount_name, 日時: fmtJst(q.created_at) })),
  };
  blocks.push({ type: 'text', text: `## 今の状況\n${describeNow()}\n\n## 会話履歴(直近30日・古い順。当社の送信はHiBoardから送った分だけ記録されています)\n${lines.join('\n') || '(履歴なし)'}\n\n## 今回返信する対象(最新の受信 #${triggerIds.join(', #')})\n${ctx.trigger.map((m) => m.message_type === 'text' ? m.text_content : `[${m.message_type}]`).join('\n---\n')}\n\n## HiBoardの情報\n${JSON.stringify(hb, null, 1)}` });
  for (const m of imgs.slice(-4)) {
    blocks.push({ type: 'text', text: `画像 #${m.id}(${fmtJst(m.received_at)} お客様):` });
    blocks.push(imageBlock(m.image_path));
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
async function pushText(lineUserId, text, { sentBy, draftId = null, status = 'sent' }) {
  const c = cfg();
  const db = state.db;
  let messageId = null;
  if (c.dryRun) {
    console.log(`[AI受付] (dry-run) 送信: user=${lineUserId.slice(0, 8)} ${text.length}文字`);
    messageId = `dry-${Date.now()}`;
  } else {
    const res = await state.lineClient.pushMessage({ to: lineUserId, messages: [{ type: 'text', text }] });
    messageId = res && res.sentMessages && res.sentMessages[0] ? res.sentMessages[0].id : null;
  }
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO line_messages (line_user_id, line_message_id, message_type, text_content, image_path, received_at, processed, case_id, direction, sent_by, reply_draft_id)
    VALUES (?, ?, 'text', ?, NULL, ?, 1, NULL, 'out', ?, ?)
  `).run(lineUserId, messageId, text, now, sentBy || null, draftId);
  if (draftId) {
    db.prepare(`UPDATE line_reply_drafts SET status = ?, sent_line_message_id = ?, decided_at = COALESCE(decided_at, ?) WHERE id = ?`).run(status, messageId, now, draftId);
  }
  return { messageRowId: info.lastInsertRowid, messageId };
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

async function sendDraft(draftId, { text, sentBy }) {
  const db = state.db;
  const d = db.prepare('SELECT * FROM line_reply_drafts WHERE id = ?').get(draftId);
  if (!d) return { ok: false, error: '下書きが見つかりません' };
  if (!['pending'].includes(d.status)) return { ok: false, error: `この下書きは既に処理済みです(${d.status})` };
  const finalText = String(text || d.reply_text || '').trim();
  if (!finalText) return { ok: false, error: '本文が空です' };
  const edited = finalText !== String(d.reply_text || '').trim();
  const now = new Date().toISOString();
  const ratio = edited ? Math.round((1 - similarity(d.reply_text, finalText)) * 1000) / 1000 : 0;
  const respMin = d.last_inbound_at ? Math.round(((Date.now() - Date.parse(d.last_inbound_at)) / 60000) * 10) / 10 : null;
  db.prepare(`UPDATE line_reply_drafts SET final_text = ?, decided_by = ?, decided_at = ?, edit_ratio = ?, response_minutes = ? WHERE id = ?`)
    .run(finalText, sentBy || null, now, ratio, respMin, draftId);
  const sent = await pushText(d.line_user_id, finalText, { sentBy, draftId, status: edited ? 'edited' : 'sent' });
  return { ok: true, status: edited ? 'edited' : 'sent', edit_ratio: ratio, response_minutes: respMin, ...sent };
}

async function sendManual(lineUserId, { text, sentBy }) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: '本文が空です' };
  if (!isLineUser(lineUserId)) return { ok: false, error: 'LINEのユーザーではありません' };
  const db = state.db;
  // 未処理の下書きがあれば「手動で返信した」として閉じる(統計では discarded/manual と区別する)
  db.prepare(`UPDATE line_reply_drafts SET status = 'discarded', discard_reason = 'manual', decided_by = ?, decided_at = ? WHERE line_user_id = ? AND status = 'pending'`).run(sentBy || null, new Date().toISOString(), lineUserId);
  const sent = await pushText(lineUserId, t, { sentBy, draftId: null });
  return { ok: true, ...sent };
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
    SELECT id, direction, message_type, text_content, image_path, received_at, sent_by, reply_draft_id
    FROM line_messages WHERE line_user_id = ? AND received_at >= ? ORDER BY received_at ASC
  `).all(lineUserId, sinceIso).slice(-limit);
  const pendingCount = state.db.prepare(`SELECT COUNT(*) AS n FROM line_reply_drafts WHERE status = 'pending'`).get().n;
  return { user, messages, pendingCount };
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

module.exports = {
  init, onInbound, runReplyCycle, generateDraft, sendDraft, sendManual, discardDraft, setMuted,
  listDrafts, getDraft, conversation, pendingCount, replyStats, isBusinessTime, describeNow, loadRules, cfg,
  CATEGORIES, ORDER_TYPES, FLAGS, AFTER_HOURS_TEXT,
  _internal: { buildContext, userContent, systemPrompt, similarity, OUTPUT_SCHEMA },
};
