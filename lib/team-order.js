const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isMailerConfigured, sendOrderConfirmation, sendOrderNotificationToAdmin } = require('./order-mailer');
const { notifyIntakeTask } = require('./todo-notify');
const { MIN_LEAD_DAYS } = require('./order-intake');

// チーム追加注文フォーム。
// 管理画面(チームリンク管理)で発行した専用URL(/team/{token})から、既存チームが
// 追加メンバー分などを注文できる。受付は Web注文フォームと同じ ai_extracted_intake に
// line_user_id='TEAM'・受付番号 T-{id} で入り、通知メールも order-mailer を流用する。
// 単価はあくまで「参考価格」で、正式な金額は受付後に案内する運用。

const LEN = { short: 200, note: 500, remarks: 1000 };
const MAX_LINES = 200;
const MAX_ITEMS_PER_LINK = 50;

function s(v, max = LEN.short) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}
function isNonEmptyStr(v) { return typeof v === 'string' && v.trim().length > 0; }
function todayPlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ===== レート制限(order-intakeと同方式の簡易版。トークンが門番なので上限は同等でよい) =====
const RATE_SHORT_WINDOW_MS = (parseInt(process.env.RATE_LIMIT_WINDOW_MIN, 10) || 10) * 60 * 1000;
const RATE_SHORT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 5;
const RATE_DAILY_MAX = parseInt(process.env.RATE_LIMIT_DAILY_MAX, 10) || 20;
const rateMap = new Map(); // ipHash -> timestamps[]

function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 16);
}
function checkRateLimit(ipHash) {
  const now = Date.now();
  const arr = (rateMap.get(ipHash) || []).filter(t => now - t < 24 * 60 * 60 * 1000);
  const inShort = arr.filter(t => now - t < RATE_SHORT_WINDOW_MS).length;
  if (inShort >= RATE_SHORT_MAX) return { ok: false, retryAfter: Math.ceil(RATE_SHORT_WINDOW_MS / 1000) };
  if (arr.length >= RATE_DAILY_MAX) return { ok: false, retryAfter: 24 * 60 * 60 };
  arr.push(now);
  rateMap.set(ipHash, arr);
  return { ok: true };
}

// ===== 共通ヘルパ =====
function ensureTeamUser(db) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO line_users (line_user_id, display_name, first_seen_at, last_message_at)
    VALUES ('TEAM', 'チーム追加注文フォーム', ?, ?)
    ON CONFLICT(line_user_id) DO NOTHING
  `).run(now, now);
}

function parseSizeOptions(raw) {
  // DBにはJSON配列文字列で保存。壊れていたら空配列扱い
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter(isNonEmptyStr).map(v => s(v, 20)) : [];
  } catch { return []; }
}

function getLinkWithItems(db, where, param) {
  const link = db.prepare(`SELECT * FROM team_order_links WHERE ${where}`).get(param);
  if (!link) return null;
  const items = db.prepare(`
    SELECT id, item_no, item_name, unit_price, size_options
    FROM team_order_link_items WHERE link_id = ? ORDER BY item_no
  `).all(link.id).map(it => ({ ...it, size_options: parseSizeOptions(it.size_options) }));
  return { ...link, items };
}

// 管理画面から受け取ったアイテム配列を検証・正規化する。エラー時は {errors} を返す
function normalizeLinkPayload(body) {
  const errors = [];
  const team_name = s(body.team_name);
  const memo = s(body.memo, LEN.note);
  if (!isNonEmptyStr(team_name)) errors.push('チーム名を入力してください');

  const rawItems = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS_PER_LINK) : [];
  const items = [];
  rawItems.forEach((it, i) => {
    const item_name = s(it && it.item_name);
    if (!isNonEmptyStr(item_name)) return; // 空行は黙って捨てる
    let unit_price = null;
    if (it.unit_price !== null && it.unit_price !== undefined && it.unit_price !== '') {
      const n = Number(it.unit_price);
      if (!Number.isInteger(n) || n < 0 || n > 10000000) {
        errors.push(`アイテム${i + 1}「${item_name}」の参考単価は0以上の整数で入力してください`);
      } else {
        unit_price = n;
      }
    }
    const size_options = Array.isArray(it.size_options)
      ? it.size_options.filter(isNonEmptyStr).map(v => s(v, 20)).slice(0, 30)
      : [];
    // お客様側を常にプルダウン選択にするため、サイズは1つ以上必須
    if (size_options.length === 0) {
      errors.push(`アイテム${i + 1}「${item_name}」のサイズを1つ以上選択してください`);
    }
    items.push({ item_name, unit_price, size_options });
  });
  if (items.length === 0) errors.push('アイテムを1件以上登録してください');
  return errors.length ? { errors } : { team_name, memo, items };
}

const replaceLinkItems = (db) => db.transaction((linkId, items) => {
  db.prepare('DELETE FROM team_order_link_items WHERE link_id = ?').run(linkId);
  const ins = db.prepare(`
    INSERT INTO team_order_link_items (link_id, item_no, item_name, unit_price, size_options)
    VALUES (?, ?, ?, ?, ?)
  `);
  items.forEach((it, i) => ins.run(linkId, i + 1, it.item_name, it.unit_price, JSON.stringify(it.size_options)));
});

// ===== 注文内容の整形 =====
function formatPrice(n) { return `${Number(n).toLocaleString('ja-JP')}円`; }

// 注文行をアイテムごとにまとめ、notes・メール用の明細行と参考合計を作る
function buildOrderSummary(link, lines) {
  const byItem = new Map(); // item_id -> {item, rows[]}
  for (const line of lines) {
    const item = link.items.find(it => it.id === line.item_id);
    if (!byItem.has(line.item_id)) byItem.set(line.item_id, { item, rows: [] });
    byItem.get(line.item_id).rows.push(line);
  }
  const detail = [];
  let totalQty = 0;
  let totalPrice = 0;
  let hasUnpriced = false;
  const shortParts = [];
  for (const { item, rows } of byItem.values()) {
    const itemQty = rows.reduce((sum, r) => sum + r.qty, 0);
    totalQty += itemQty;
    shortParts.push(`${item.item_name}×${itemQty}`);
    const priceNote = item.unit_price !== null ? `(参考単価 ${formatPrice(item.unit_price)})` : '';
    detail.push(`▼${item.item_name}${priceNote} 計${itemQty}枚`);
    rows.forEach(r => {
      const seg = [];
      if (r.name) seg.push(`名前:${r.name}`);
      if (r.number) seg.push(`番号:${r.number}`);
      seg.push(`サイズ:${r.size}`);
      seg.push(`${r.qty}枚`);
      detail.push(`  ・${seg.join(' / ')}`);
    });
    if (item.unit_price !== null) totalPrice += item.unit_price * itemQty;
    else hasUnpriced = true;
  }
  const totalLabel = totalPrice > 0
    ? `${formatPrice(totalPrice)}${hasUnpriced ? '(単価未設定のアイテムを除く)' : ''}(参考)`
    : null;
  return { detail, totalQty, totalLabel, short: shortParts.join('、').slice(0, 500) };
}

function buildNotes(link, data, summary, receiptNo) {
  const L = [];
  L.push(`【チーム追加注文】チーム: ${link.team_name}`);
  if (receiptNo) L.push(`■受付番号: ${receiptNo}`);
  const o = data.orderer;
  L.push(`■注文者: ${o.contact_name} / ${o.phone} / ${o.email || '(メールなし)'}`);
  L.push(...summary.detail);
  L.push(`■合計: 計${summary.totalQty}枚`);
  if (summary.totalLabel) L.push(`■参考合計金額: ${summary.totalLabel} ※正式な金額は要見積`);
  if (data.deadline.date || data.deadline.note) {
    L.push(`■希望納期: ${[data.deadline.date, data.deadline.note].filter(isNonEmptyStr).join(' / ')}`);
  }
  if (data.remarks) L.push(`■備考: ${data.remarks}`);
  L.push('※デザイン・仕様は過去案件と同じ想定です。納品履歴からの「再注文」複製が使えます');
  return L.join('\n');
}

// ===== 受注データの検証 =====
function validateOrderPayload(link, body) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });

  const o = (body.orderer && typeof body.orderer === 'object') ? body.orderer : {};
  const orderer = { contact_name: s(o.contact_name), phone: s(o.phone), email: s(o.email) };
  if (!isNonEmptyStr(orderer.contact_name)) push('orderer.contact_name', 'ご担当者名を入力してください');
  if (!isNonEmptyStr(orderer.phone)) push('orderer.phone', '電話番号を入力してください');
  else if (!/^[\d\-+()\s]{7,20}$/.test(orderer.phone)) push('orderer.phone', '電話番号の形式が不正です');
  if (isNonEmptyStr(orderer.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(orderer.email)) {
    push('orderer.email', 'メールアドレスの形式が不正です');
  }

  const itemIds = new Set(link.items.map(it => it.id));
  const rawLines = Array.isArray(body.lines) ? body.lines.slice(0, MAX_LINES) : [];
  const lines = [];
  rawLines.forEach((ln, i) => {
    const item_id = Number(ln && ln.item_id);
    const size = s(ln && ln.size, 20);
    const qty = Number(ln && ln.qty);
    const name = s(ln && ln.name, 50);
    const number = s(ln && ln.number, 20);
    // 完全空行(サイズも枚数も無い)は黙って捨てる
    if (!isNonEmptyStr(size) && !(qty >= 1) && !isNonEmptyStr(name) && !isNonEmptyStr(number)) return;
    if (!itemIds.has(item_id)) { push(`lines.${i}`, '不正なアイテムが含まれています'); return; }
    if (!isNonEmptyStr(size)) { push(`lines.${i}`, `${i + 1}行目: サイズを選択してください`); return; }
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) { push(`lines.${i}`, `${i + 1}行目: 枚数は1〜999で入力してください`); return; }
    lines.push({ item_id, name, number, size, qty });
  });
  if (lines.length === 0 && !errors.some(e => e.field.startsWith('lines'))) {
    push('lines', '注文内容を1行以上入力してください');
  }

  const dl = (body.deadline && typeof body.deadline === 'object') ? body.deadline : {};
  const deadlineDate = s(dl.date, 20);
  if (isNonEmptyStr(deadlineDate)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadlineDate) || Number.isNaN(Date.parse(deadlineDate))) {
      push('deadline.date', '納期の日付形式が不正です');
    } else if (deadlineDate < todayPlusDays(MIN_LEAD_DAYS)) {
      push('deadline.date', `納期は本日からおよそ${MIN_LEAD_DAYS}日以降でご指定ください`);
    }
  }
  const deadline = { date: isNonEmptyStr(deadlineDate) ? deadlineDate : null, note: s(dl.note, LEN.note) };
  const remarks = s(body.remarks, LEN.remarks);

  if (errors.length) return { errors };
  return { orderer, lines, deadline, remarks };
}

// ===== ルート登録 =====
function registerTeamOrderRoutes(app, db) {
  ensureTeamUser(db);

  // ---- 公開: フォームHTML ----
  app.get('/team/:token', (req, res) => {
    try {
      let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'team-order.html'), 'utf8');
      html = html.replace(/{{MIN_LEAD_DAYS}}/g, String(MIN_LEAD_DAYS));
      res.type('html').send(html);
    } catch {
      res.status(500).send('フォームの読み込みに失敗しました');
    }
  });

  // ---- 公開: リンク情報(チーム名+アイテム)。無効化済み・不明トークンは404 ----
  app.get('/api/team-order/:token', (req, res) => {
    const link = getLinkWithItems(db, 'token = ?', s(req.params.token, 64));
    if (!link || link.disabled_at) {
      return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。お手数ですが担当者にお問い合わせください。' });
    }
    res.json({
      ok: true,
      team_name: link.team_name,
      min_lead_days: MIN_LEAD_DAYS,
      items: link.items.map(it => ({
        id: it.id, item_name: it.item_name, unit_price: it.unit_price, size_options: it.size_options,
      })),
    });
  });

  // ---- 公開: 注文受付 ----
  app.post('/api/team-order/:token', async (req, res) => {
    try {
      // honeypot(botは静かに受け付けたふり)
      if (isNonEmptyStr(req.body && req.body.website)) return res.json({ ok: true, receipt_no: 'T-0' });

      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
      const rate = checkRateLimit(hashIp(ip));
      if (!rate.ok) {
        return res.status(429).json({ ok: false, errors: [{ field: '', message: '送信回数が上限に達しました。しばらく時間をおいてお試しください。' }] });
      }

      const link = getLinkWithItems(db, 'token = ?', s(req.params.token, 64));
      if (!link || link.disabled_at) {
        return res.status(404).json({ ok: false, errors: [{ field: '', message: 'このページは現在ご利用いただけません。' }] });
      }

      const data = validateOrderPayload(link, req.body || {});
      if (data.errors) return res.status(400).json({ ok: false, errors: data.errors });

      const summary = buildOrderSummary(link, data.lines);
      const now = new Date().toISOString();
      const raw = {
        schema_version: 1,
        source: 'team_order_form',
        link_id: link.id,
        team_name: link.team_name,
        orderer: data.orderer,
        lines: data.lines,
        deadline: data.deadline,
        remarks: data.remarks,
        submitted_at: now,
        meta: { user_agent: s(req.headers['user-agent'] || ''), client_ip_hash: hashIp(ip) },
      };
      const info = db.prepare(`
        INSERT INTO ai_extracted_intake
          (line_user_id, extracted_at, customer_name, items, quantity, deadline, notes, raw_ai_response, message_ids)
        VALUES ('TEAM', ?, ?, ?, ?, ?, ?, ?, '[]')
      `).run(
        now,
        link.team_name,
        `【追加注文】${summary.short}`,
        `計${summary.totalQty}枚`,
        [data.deadline.date, data.deadline.note].filter(isNonEmptyStr).join(' / ') || null,
        '',
        JSON.stringify(raw),
      );
      const intakeId = info.lastInsertRowid;
      const receiptNo = `T-${intakeId}`;
      db.prepare('UPDATE ai_extracted_intake SET notes = ? WHERE id = ?')
        .run(buildNotes(link, data, summary, receiptNo), intakeId);

      console.log(`[チーム注文] 新規受付: ${receiptNo}(リンク#${link.id})`);

      // 社員TODOリスト(TODO_三浦)へ対応タスクを通知(失敗しても受付処理には影響しない)
      notifyIntakeTask(`チーム追加注文の確認: ${link.team_name} — ${summary.short} 計${summary.totalQty}枚(受付 ${receiptNo})`);

      // メール送信(受付控え=お客様宛て / 通知=会社宛て)。失敗しても受付自体は成立させる
      const mailOrderer = { org_name: link.team_name, ...data.orderer };
      const mailSummary = {
        items: summary.short,
        quantity: `計${summary.totalQty}枚${summary.totalLabel ? `(参考合計 ${summary.totalLabel})` : ''}`,
        deadline: [data.deadline.date, data.deadline.note].filter(isNonEmptyStr).join(' / ') || null,
        contact_time: null,
      };
      if (isMailerConfigured() && data.orderer.email) {
        try {
          const sent = await sendOrderConfirmation({
            to: data.orderer.email, receiptNo, requestTypeLabel: '追加注文', orderer: mailOrderer, summary: mailSummary,
          });
          if (sent) console.log(`[チーム注文] 受付控えメールを送信: ${receiptNo}`);
        } catch (err) {
          console.error(`[チーム注文] 受付控えメールの送信に失敗(${receiptNo}):`, err.message);
        }
      }
      try {
        const sent = await sendOrderNotificationToAdmin({
          receiptNo, requestTypeLabel: '追加注文', orderer: mailOrderer, summary: mailSummary,
        });
        if (sent) console.log(`[チーム注文] 会社宛て通知メールを送信: ${receiptNo}`);
      } catch (err) {
        console.error(`[チーム注文] 会社宛て通知メールの送信に失敗(${receiptNo}):`, err.message);
      }

      res.status(201).json({ ok: true, receipt_no: receiptNo, total_label: summary.totalLabel });
    } catch (err) {
      console.error('[チーム注文] 受付処理でエラー:', err.message);
      res.status(500).json({ ok: false, errors: [{ field: '', message: 'サーバーエラーが発生しました。お手数ですがお電話にてご連絡ください。' }] });
    }
  });

  // ---- 管理: 一覧 ----
  // public_base: チームに配る公開URLのベース。本番は .env の PUBLIC_ORDER_BASE_URL に
  // 公開ドメイン(例: https://order.kubota-tunnel.com)を設定する。未設定なら画面側で自オリジンを使う
  app.get('/api/team-links', (req, res) => {
    const links = db.prepare('SELECT * FROM team_order_links ORDER BY created_at DESC').all()
      .map(l => getLinkWithItems(db, 'id = ?', l.id));
    res.json({ public_base: process.env.PUBLIC_ORDER_BASE_URL || '', links });
  });

  // ---- 管理: 発行 ----
  app.post('/api/team-links', (req, res) => {
    const p = normalizeLinkPayload(req.body || {});
    if (p.errors) return res.status(400).json({ errors: p.errors });
    const now = new Date().toISOString();
    const token = crypto.randomBytes(16).toString('hex');
    const info = db.prepare(`
      INSERT INTO team_order_links (token, team_name, memo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(token, p.team_name, p.memo, now, now);
    replaceLinkItems(db)(info.lastInsertRowid, p.items);
    console.log(`[チームリンク] 発行: #${info.lastInsertRowid}`);
    res.status(201).json(getLinkWithItems(db, 'id = ?', info.lastInsertRowid));
  });

  // ---- 管理: 更新(チーム名・メモ・アイテム差し替え) ----
  app.put('/api/team-links/:id', (req, res) => {
    const link = db.prepare('SELECT id FROM team_order_links WHERE id = ?').get(req.params.id);
    if (!link) return res.status(404).json({ error: 'リンクが見つかりません' });
    const p = normalizeLinkPayload(req.body || {});
    if (p.errors) return res.status(400).json({ errors: p.errors });
    db.prepare('UPDATE team_order_links SET team_name = ?, memo = ?, updated_at = ? WHERE id = ?')
      .run(p.team_name, p.memo, new Date().toISOString(), link.id);
    replaceLinkItems(db)(link.id, p.items);
    res.json(getLinkWithItems(db, 'id = ?', link.id));
  });

  // ---- 管理: 無効化/再有効化のトグル ----
  app.post('/api/team-links/:id/toggle', (req, res) => {
    const link = db.prepare('SELECT id, disabled_at FROM team_order_links WHERE id = ?').get(req.params.id);
    if (!link) return res.status(404).json({ error: 'リンクが見つかりません' });
    const now = new Date().toISOString();
    db.prepare('UPDATE team_order_links SET disabled_at = ?, updated_at = ? WHERE id = ?')
      .run(link.disabled_at ? null : now, now, link.id);
    console.log(`[チームリンク] #${link.id} を${link.disabled_at ? '再有効化' : '無効化'}`);
    res.json(getLinkWithItems(db, 'id = ?', link.id));
  });

  // ---- 管理: 画面 ----
  app.get('/team-links', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'team-links.html'));
  });
}

module.exports = { registerTeamOrderRoutes };
