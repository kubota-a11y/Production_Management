const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { notifyIntakeTask } = require('./todo-notify');

// 取引先向け 加工依頼フォーム。
// 取引先ポータル(partner_links)と同じトークンで使える公開フォーム(/partner/{token}/order)。
// 初回の想定利用先は株式会社八木繊維。いまは「持ち込み品+紙の指図書+Googleチャット補足」で
// 受けている情報を、そのままフォームで受け取り、Web注文・チーム注文と同じく
// ai_extracted_intake(line_user_id='PARTNER'、受付番号 P-{id})へ着地させる。
// ※ 品物は取引先の持ち込み(作業着等)。単価・金額は扱わず「加工指示」に特化した項目にしている。

const LEN = { short: 200, mid: 500, long: 2000 };
const MAX_ITEMS = 30;
const MAX_PROCESSES = 10; // 1品物あたりの加工(箇所)数の上限
const MAX_FILES = 10;
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 1ファイル15MB
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.pdf', '.heic', '.webp']);

// 加工方法。フロント public/js/partner-order.js の <select> の value と一致させること。
const METHODS = new Set(['print_auto', 'silk', 'dtf', 'rubber', 'embroidery', 'cap_embroidery', 'other']);
const METHOD_LABEL = {
  print_auto: 'プリント(HiYOSHiお任せ)',
  silk: 'シルクプリント',
  dtf: 'DTFプリント',
  rubber: 'ラバープリント',
  embroidery: '刺繍',
  cap_embroidery: '帽子刺繍',
  other: '他',
};

// 加工に必要なデータの場所(任意)。フロントの <select> の value と一致させること。
const DATA_LOCATIONS = new Set(['email', 'line', 'drive', 'other']);
const DATA_LOCATION_LABEL = { email: 'メール', line: 'LINE', drive: '共有ドライブ', other: '他' };

// 画像の保存先ルート。本番(Windows)はUNC直指定、開発はリポジトリ内の一時フォルダにフォールバック。
const PARTNER_ORDER_RECEIVED_PATH = process.env.PARTNER_ORDER_RECEIVED_PATH
  || (process.platform === 'win32'
        ? '\\\\192.168.1.25\\disk1\\DESIGN\\PARTNER_ORDER_RECEIVED'
        : path.join(__dirname, '..', 'partner_order_received_dev'));

function isNonEmptyStr(v) { return typeof v === 'string' && v.trim().length > 0; }
function s(v, max = LEN.short) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}
function pathSep(base) {
  return (base.startsWith('\\\\') || base.includes('\\')) ? '\\' : '/';
}
function parsePatterns(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter(isNonEmptyStr) : [];
  } catch { return []; }
}
function sanitizeFilename(name) {
  const base = path.basename(String(name || 'file'));
  const ext = path.extname(base).toLowerCase();
  const stem = base.slice(0, base.length - ext.length)
    .replace(/[^\p{L}\p{N}.\-_ ]/gu, '_').replace(/\s+/g, '_').slice(0, 60) || 'file';
  return stem + ext;
}
function safeUnlink(p) { try { fs.unlinkSync(p); } catch (_) { /* noop */ } }
function cleanupTempFiles(files) { for (const f of files || []) safeUnlink(f.path); }

// ===== レート制限(order-intakeと同方式の簡易版。トークンが門番なので上限は同等でよい) =====
const RATE_SHORT_WINDOW_MS = (parseInt(process.env.RATE_LIMIT_WINDOW_MIN, 10) || 10) * 60 * 1000;
const RATE_SHORT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 5;
const RATE_DAILY_MAX = parseInt(process.env.RATE_LIMIT_DAILY_MAX, 10) || 20;
const rateMap = new Map();
function hashIp(ip) { return crypto.createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 16); }
function checkRateLimit(ipHash) {
  const now = Date.now();
  const arr = (rateMap.get(ipHash) || []).filter(t => now - t < 24 * 60 * 60 * 1000);
  const inShort = arr.filter(t => now - t < RATE_SHORT_WINDOW_MS).length;
  if (inShort >= RATE_SHORT_MAX) return { ok: false };
  if (arr.length >= RATE_DAILY_MAX) return { ok: false };
  arr.push(now);
  rateMap.set(ipHash, arr);
  return { ok: true };
}

// ===== line_users に 'PARTNER' 疑似ユーザーを用意(FK ON/OFFどちらでも成立させるため) =====
function ensurePartnerUser(db) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO line_users (line_user_id, display_name, first_seen_at, last_message_at)
    VALUES ('PARTNER', '取引先 加工依頼フォーム', ?, ?)
    ON CONFLICT(line_user_id) DO NOTHING
  `).run(now, now);
}

function getLink(db, token) {
  const link = db.prepare('SELECT * FROM partner_links WHERE token = ?').get(s(token, 64));
  if (!link) return null;
  return { ...link, customer_patterns: parsePatterns(link.customer_patterns) };
}

// ===== バリデーション =====
function validatePayload(body) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });

  // 持ち込み予定
  const d = (body.dropoff && typeof body.dropoff === 'object') ? body.dropoff : {};
  const dropoff_date = s(d.date, 20);
  if (isNonEmptyStr(dropoff_date) && !/^\d{4}-\d{2}-\d{2}$/.test(dropoff_date)) {
    push('dropoff.date', '持ち込み予定日の形式が不正です');
  }
  const instruction_no = s(d.instruction_no, 100);
  const contact_name = s(d.contact_name);
  const phone = s(d.phone, 20);
  if (!isNonEmptyStr(contact_name)) push('dropoff.contact_name', 'ご担当者名を入力してください');
  if (isNonEmptyStr(phone) && !/^[\d\-+()\s]{7,20}$/.test(phone)) push('dropoff.phone', '電話番号の形式が不正です');

  // 加工内容(品物ごと)。1品物に複数の加工(方法+箇所+内容+色)をぶら下げられる。
  const rawItems = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
  const items = [];
  rawItems.forEach((it, i) => {
    const item_name = s(it && it.item_name);
    const qtyRaw = it && it.quantity;
    const quantity = qtyRaw === '' || qtyRaw === null || qtyRaw === undefined ? null : Number(qtyRaw);

    // 加工(箇所ごと)を正規化。完全空の加工行は黙って捨てる。
    const rawProcs = Array.isArray(it && it.processes) ? it.processes.slice(0, MAX_PROCESSES) : [];
    const processes = [];
    let procMethodError = false;
    rawProcs.forEach(pr => {
      const method = s(pr && pr.method);
      const location = s(pr && pr.location);
      const content = s(pr && pr.content, LEN.mid);
      const color = s(pr && pr.color, 100);
      if (!isNonEmptyStr(method) && !isNonEmptyStr(location) && !isNonEmptyStr(content) && !isNonEmptyStr(color)) return;
      if (!METHODS.has(method)) { procMethodError = true; return; }
      processes.push({ method, location, content, color });
    });

    // データの場所(任意)
    let data_location = s(it && it.data_location);
    if (data_location && !DATA_LOCATIONS.has(data_location)) data_location = '';
    const data_location_note = s(it && it.data_location_note, LEN.mid);

    // 完全空の品物は黙って捨てる
    if (!isNonEmptyStr(item_name) && processes.length === 0 && !procMethodError
        && quantity === null && !data_location && !isNonEmptyStr(data_location_note)) return;

    if (!isNonEmptyStr(item_name)) { push(`items.${i}`, `品物${i + 1}: 品名を入力してください`); return; }
    if (procMethodError) { push(`items.${i}`, `品物${i + 1}: 加工方法を選択してください`); return; }
    if (processes.length === 0) { push(`items.${i}`, `品物${i + 1}: 加工を1つ以上入力してください`); return; }
    if (quantity !== null && (!Number.isInteger(quantity) || quantity < 1 || quantity > 99999)) {
      push(`items.${i}`, `品物${i + 1}: 数量は1〜99999で入力してください`); return;
    }
    items.push({ item_name, quantity, processes, data_location, data_location_note });
  });
  if (items.length === 0 && !errors.some(e => e.field.startsWith('items'))) {
    push('items', '加工内容を1品物以上入力してください');
  }

  // 納期・備考
  const dl = (body.deadline && typeof body.deadline === 'object') ? body.deadline : {};
  const deadline_date = s(dl.date, 20);
  if (isNonEmptyStr(deadline_date) && !/^\d{4}-\d{2}-\d{2}$/.test(deadline_date)) {
    push('deadline.date', '希望納期の形式が不正です');
  }
  const deadline_note = s(dl.note, LEN.short);
  const remarks = s(body.remarks, LEN.long);

  if (errors.length) return { errors };
  return {
    dropoff: { date: isNonEmptyStr(dropoff_date) ? dropoff_date : null, instruction_no, contact_name, phone },
    items,
    deadline: { date: isNonEmptyStr(deadline_date) ? deadline_date : null, note: deadline_note },
    remarks,
  };
}

// ===== 要約(既存レビューUIにそのまま表示される notes・カラム値)の組み立て =====
function itemsColumn(data) {
  const parts = data.items.map(it => {
    const methods = [...new Set(it.processes.map(p => METHOD_LABEL[p.method] || p.method))].join('・');
    return `${it.item_name}(${methods})`;
  });
  return `${data.items.length}点: ${parts.join(' / ')}`.slice(0, 500);
}
function quantityColumn(data) {
  const total = data.items.reduce((sum, it) => sum + (it.quantity || 0), 0);
  return total > 0 ? `計${total}点` : null;
}
function deadlineColumn(data) {
  return [data.deadline.date, data.deadline.note].filter(isNonEmptyStr).join(' / ') || null;
}
function buildNotes(link, data, savedImages, saveDir, receiptNo) {
  const L = [];
  L.push(`【取引先 加工依頼】取引先: ${link.partner_name}`);
  if (receiptNo) L.push(`■受付番号: ${receiptNo}`);
  const dp = data.dropoff;
  if (dp.date) L.push(`■持ち込み予定日: ${dp.date}`);
  if (dp.instruction_no) L.push(`■指図書番号: ${dp.instruction_no}`);
  L.push(`■先方担当者: ${dp.contact_name}${dp.phone ? ' / ' + dp.phone : ''}`);
  L.push(`■加工内容(${data.items.length}点):`);
  data.items.forEach((it, i) => {
    L.push(`  ・${i + 1}. ${it.item_name}${it.quantity ? ` (${it.quantity}点)` : ''}`);
    it.processes.forEach(p => {
      const seg = [`加工:${METHOD_LABEL[p.method] || p.method}`];
      if (p.location) seg.push(`箇所:${p.location}`);
      if (p.content) seg.push(`内容:${p.content}`);
      if (p.color) seg.push(`色:${p.color}`);
      L.push(`      - ${seg.join(' / ')}`);
    });
    if (it.data_location) {
      const dl = DATA_LOCATION_LABEL[it.data_location] || it.data_location;
      L.push(`      データの場所: ${dl}${it.data_location_note ? ' (' + it.data_location_note + ')' : ''}`);
    } else if (isNonEmptyStr(it.data_location_note)) {
      L.push(`      データの場所: ${it.data_location_note}`);
    }
  });
  const total = data.items.reduce((sum, it) => sum + (it.quantity || 0), 0);
  if (total > 0) L.push(`■合計: ${total}点`);
  const dl = deadlineColumn(data);
  if (dl) L.push(`■希望納期: ${dl}`);
  if (savedImages.length) {
    const rep = savedImages[0] ? savedImages[0].original_name : '';
    L.push(`■添付画像: ${savedImages.length}点${rep ? ' (代表:' + rep + ')' : ''} 保存先 ${saveDir}`);
  }
  if (data._imageWarning) L.push('⚠画像保存に失敗しました。手動で確認してください。');
  if (isNonEmptyStr(data.remarks)) L.push(`■備考: ${data.remarks}`);
  L.push('※指図書(持ち込み)と本フォームの内容をもとに作業指示書を作成してください');
  return L.join('\n');
}

// ===== 画像を保存(intake_id確定後に temp から {intake_id}\ へ move) =====
function saveImages(intakeId, files) {
  if (!files.length) return { images: [], dir: '', warning: false };
  const base = PARTNER_ORDER_RECEIVED_PATH.replace(/[\\/]+$/, '');
  const sep = pathSep(base);
  const dir = `${base}${sep}${intakeId}`;
  const saved = [];
  let warning = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(`[取引先依頼] 保存フォルダ作成失敗 dir=${dir}:`, err.message);
    cleanupTempFiles(files);
    return { images: [], dir, warning: true };
  }
  files.forEach((file, idx) => {
    const sanitized = sanitizeFilename(file.originalname);
    const stored = `${String(idx + 1).padStart(2, '0')}_${sanitized}`;
    const dest = `${dir}${sep}${stored}`;
    try {
      try { fs.renameSync(file.path, dest); }
      catch (e) { fs.copyFileSync(file.path, dest); safeUnlink(file.path); }
      saved.push({ original_name: file.originalname, stored_name: stored, unc_path: dest, size_bytes: file.size });
    } catch (err) {
      console.error(`[取引先依頼] 画像保存失敗 ${file.originalname}:`, err.message);
      safeUnlink(file.path);
      warning = true;
    }
  });
  return { images: saved, dir, warning };
}

// ===== ルート登録 =====
function registerPartnerOrderRoutes(app, db) {
  ensurePartnerUser(db);

  const tmpDir = path.join(os.tmpdir(), 'partner_order_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpDir),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase()),
  });
  const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ALLOWED_EXT.has(ext)) return cb(null, true);
      cb(new Error(`許可されていないファイル形式です: ${file.originalname}`));
    },
  });
  const uploadMiddleware = (req, res, next) => {
    upload.array('images', MAX_FILES)(req, res, (err) => {
      if (err) {
        const message = err instanceof multer.MulterError
          ? (err.code === 'LIMIT_FILE_SIZE' ? 'ファイルサイズが大きすぎます(上限15MB)'
            : err.code === 'LIMIT_FILE_COUNT' ? `添付は最大${MAX_FILES}件までです`
            : 'ファイルのアップロードに失敗しました')
          : err.message;
        return res.status(400).json({ ok: false, errors: [{ field: 'images', message }] });
      }
      next();
    });
  };

  // ---- 公開: フォームHTML ----
  app.get('/partner/:token/order', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'partner-order.html'));
  });

  // ---- 公開: リンク情報(取引先名)。無効化済み・不明トークンは404 ----
  app.get('/api/partner-order/:token', (req, res) => {
    const link = getLink(db, req.params.token);
    if (!link || link.disabled_at) {
      return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。お手数ですが担当者にお問い合わせください。' });
    }
    res.json({ ok: true, partner_name: link.partner_name });
  });

  // ---- 公開: 依頼受付 ----
  app.post('/api/partner-order/:token', uploadMiddleware, (req, res) => {
    const files = req.files || [];
    try {
      // honeypot(botは静かに受け付けたふり)
      if (isNonEmptyStr(req.body && req.body.website)) {
        cleanupTempFiles(files);
        return res.json({ ok: true, receipt_no: 'P-0' });
      }

      const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
      if (!checkRateLimit(hashIp(ip)).ok) {
        cleanupTempFiles(files);
        return res.status(429).json({ ok: false, errors: [{ field: '_', message: '送信回数が上限に達しました。しばらく時間をおいてお試しください。' }] });
      }

      const link = getLink(db, req.params.token);
      if (!link || link.disabled_at) {
        cleanupTempFiles(files);
        return res.status(404).json({ ok: false, errors: [{ field: '_', message: 'このページは現在ご利用いただけません。' }] });
      }

      let payload;
      try { payload = JSON.parse(req.body.payload || '{}'); }
      catch (e) {
        cleanupTempFiles(files);
        return res.status(400).json({ ok: false, errors: [{ field: 'payload', message: '送信データの形式が不正です' }] });
      }

      const data = validatePayload(payload);
      if (data.errors) {
        cleanupTempFiles(files);
        return res.status(400).json({ ok: false, errors: data.errors });
      }

      const now = new Date().toISOString();
      const preRaw = {
        schema_version: 1,
        source: 'partner_order_form',
        link_id: link.id,
        partner_name: link.partner_name,
        ...data,
        images: [],
        submitted_at: now,
        meta: { user_agent: s(req.headers['user-agent'] || ''), client_ip_hash: hashIp(ip) },
      };
      // customer_name は取引先名。案件化されると取引先ポータルの一致パターンにも乗る
      const info = db.prepare(`
        INSERT INTO ai_extracted_intake
          (line_user_id, extracted_at, customer_name, items, quantity, deadline, notes, raw_ai_response, message_ids)
        VALUES ('PARTNER', ?, ?, ?, ?, ?, ?, ?, '[]')
      `).run(
        now, link.partner_name, itemsColumn(data), quantityColumn(data),
        deadlineColumn(data), '', JSON.stringify(preRaw),
      );
      const intakeId = info.lastInsertRowid;
      const receiptNo = `P-${intakeId}`;

      const { images, dir, warning } = saveImages(intakeId, files);
      data._imageWarning = warning;
      const finalRaw = { ...preRaw, images };
      const referenceLink = images.length ? images[0].unc_path : null;
      db.prepare('UPDATE ai_extracted_intake SET notes = ?, raw_ai_response = ?, reference_link = ? WHERE id = ?')
        .run(buildNotes(link, data, images, dir, receiptNo), JSON.stringify(finalRaw), referenceLink, intakeId);

      console.log(`[取引先依頼] 新規受付: ${receiptNo}(リンク#${link.id}、画像${images.length}点)`);

      // 社員TODOリスト(TODO_三浦)へ対応タスクを通知(失敗しても受付処理には影響しない)
      notifyIntakeTask(`取引先 加工依頼の確認: ${link.partner_name} — ${itemsColumn(data)}(受付 ${receiptNo})`);

      return res.status(201).json({ ok: true, receipt_no: receiptNo, ...(warning ? { image_warning: true } : {}) });
    } catch (err) {
      console.error('[取引先依頼] 受付処理でエラー:', err.message);
      cleanupTempFiles(files);
      return res.status(500).json({ ok: false, errors: [{ field: '_', message: 'サーバーエラーが発生しました。お手数ですがお電話にてご連絡ください。' }] });
    }
  });
}

module.exports = { registerPartnerOrderRoutes };
