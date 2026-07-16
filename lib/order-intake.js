// 公開注文フォーム(POST /order)の受け口。
// 「見積・イメージ依頼」と「正式発注」を1フォームで受け、いずれも
// ai_extracted_intake(status=pending, line_user_id='WEB', message_ids='[]') に着地させる。
// - 構造化明細(アイテム指定/マトリクス/名簿/画像パス)は raw_ai_response のJSONに保全
// - notes は人が読める要約(既存レビューUIにそのまま表示)
// - 画像は NAS の \\...\WEB_ORDER_RECEIVED\{intake_id}\ にUNC直指定で保存し、代表1枚を reference_link に
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { isMailerConfigured, sendOrderConfirmation, sendOrderNotificationToAdmin } = require('./order-mailer');

// ===== 設定(未設定でも動くようコード側にデフォルトを持つ。運用値は .env で外出し) =====
const MIN_LEAD_DAYS = (() => {
  const n = parseInt(process.env.MIN_LEAD_DAYS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 14;
})();

// 画像の保存先ルート。本番(Windows)はUNC直指定、開発(mac/その他)はリポジトリ内の一時フォルダにフォールバック。
const WEB_ORDER_RECEIVED_PATH = process.env.WEB_ORDER_RECEIVED_PATH
  || (process.platform === 'win32'
        ? '\\\\192.168.1.25\\disk1\\DESIGN\\WEB_ORDER_RECEIVED'
        : path.join(__dirname, '..', 'web_order_received_dev'));

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';   // 空ならTurnstile検証をスキップ(開発用)
const TURNSTILE_SITEKEY = process.env.TURNSTILE_SITEKEY || ''; // 空ならフォームにウィジェットを出さない

// レート制限(公開エンドポイント保護)。CF-Connecting-IP 単位。
const RATE_SHORT_WINDOW_MS = (parseInt(process.env.RATE_LIMIT_WINDOW_MIN, 10) || 10) * 60 * 1000;
const RATE_SHORT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 5;
const RATE_DAILY_MAX = parseInt(process.env.RATE_LIMIT_DAILY_MAX, 10) || 20;

// 1案件あたりのアイテム数上限(暴走入力対策)
const MAX_ITEMS = 20;

// アップロード制限
const MAX_FILES = 10;
const MAX_FILE_BYTES = 15 * 1024 * 1024;   // 1ファイル15MB
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.pdf', '.ai', '.svg']);
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/svg+xml', 'application/pdf',
  'application/postscript', 'application/illustrator', 'application/octet-stream',
]);

// 文字列長の上限(DoS/暴走入力対策)
const LEN = { short: 200, mid: 500, long: 3000 };

const REQUEST_TYPES = new Set(['quote', 'order', 'consult']);
// かんたん相談の希望連絡時間帯
const CONTACT_TIME_LABEL = {
  anytime: 'いつでも',
  morning: '午前(9時〜12時)',
  afternoon: '午後(12時〜17時)',
  evening: '夕方以降(17時〜)',
};
const CATEGORIES = new Set(['tshirt', 'polo', 'sweat', 'hoodie', 'zip_hoodie', 'pants', 'cap', 'bag', 'workwear', 'other']);
const METHODS = new Set(['print', 'embroidery', 'both']);
const IMAGE_ROLES = new Set(['reference', 'logo', 'design']);

// 大カテゴリ→第2カテゴリ(任意)の連動マスタ。フロント public/js/order.js の SUB_CATEGORIES と値を一致させること。
// ここに無い大カテゴリ(other 等)は第2カテゴリを持たない。
const SUB_CATEGORIES = {
  tshirt: new Set(['cotton_regular', 'cotton_heavy', 'dry', 'big_silhouette', 'import_other']),
  polo: new Set(['cotton', 'dry']),
  workwear: new Set(['jacket', 'pants']),
};

const METHOD_LABEL = { print: 'プリント', embroidery: '刺繍', both: 'プリント+刺繍' };
const CATEGORY_LABEL = {
  tshirt: 'Tシャツ', polo: 'ポロシャツ', sweat: 'トレーナー', hoodie: 'パーカー',
  zip_hoodie: 'ジップアップパーカー', pants: 'パンツ', cap: '帽子', bag: 'バッグ',
  workwear: '作業着', other: 'その他',
};
// 第2カテゴリの表示名(値はカテゴリをまたいで一意。'dry'/'cotton' は共通ラベル)
const SUB_CATEGORY_LABEL = {
  cotton_regular: '綿素材(通常)', cotton_heavy: '綿素材(厚手)', dry: 'ドライ素材',
  big_silhouette: 'ビッグシルエット', import_other: '他(インポートブランドなど)',
  cotton: '綿素材', jacket: 'ジャケット', pants: 'パンツ',
};
const REQUEST_TYPE_LABEL = { quote: '見積・イメージ依頼', order: '正式発注', consult: 'かんたん相談' };

// 第2カテゴリが、選択中の大カテゴリに属する有効値かどうか
function isValidSubCategory(category, sub) {
  const set = SUB_CATEGORIES[category];
  return !!set && set.has(sub);
}

// ===== 汎用ヘルパー =====
function isNonEmptyStr(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
function s(v, max = LEN.short) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}
function pathSep(base) {
  // UNC/Windowsパス(バックスラッシュを含む or \\で始まる)は '\\'、それ以外は '/'
  return (base.startsWith('\\\\') || base.includes('\\')) ? '\\' : '/';
}
function todayPlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function getClientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip || req.connection?.remoteAddress || 'unknown';
}
function hashIp(ip) {
  return 'sha256:' + crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32);
}
function sanitizeFilename(name) {
  const base = path.basename(String(name || 'file'));
  const ext = path.extname(base).toLowerCase();
  const stem = base.slice(0, base.length - ext.length)
    .replace(/[^\p{L}\p{N}.\-_ ]/gu, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60) || 'file';
  return stem + ext;
}
function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (_) { /* noop */ }
}
function cleanupTempFiles(files) {
  for (const f of files || []) safeUnlink(f.path);
}

// ===== レート制限(インメモリのスライディングウィンドウ) =====
const rateHits = new Map(); // ip -> number[] (timestamps ms)
function checkRateLimit(ip) {
  const now = Date.now();
  const arr = (rateHits.get(ip) || []).filter(t => now - t < 24 * 60 * 60 * 1000);
  const inShort = arr.filter(t => now - t < RATE_SHORT_WINDOW_MS).length;
  if (inShort >= RATE_SHORT_MAX) {
    return { ok: false, retryAfter: Math.ceil(RATE_SHORT_WINDOW_MS / 1000) };
  }
  if (arr.length >= RATE_DAILY_MAX) {
    return { ok: false, retryAfter: 3600 };
  }
  arr.push(now);
  rateHits.set(ip, arr);
  // メモリ肥大防止: たまに古いキーを掃除
  if (rateHits.size > 5000) {
    for (const [k, v] of rateHits) {
      if (v.every(t => now - t >= 24 * 60 * 60 * 1000)) rateHits.delete(k);
    }
  }
  return { ok: true };
}

// ===== Turnstile 検証 =====
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return { ok: true, skipped: true }; // 未設定時は検証スキップ(開発)
  if (!isNonEmptyStr(token)) return { ok: false };
  try {
    const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
    if (ip && ip !== 'unknown') body.append('remoteip', ip);
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await resp.json();
    return { ok: !!data.success };
  } catch (err) {
    console.error('[注文] Turnstile検証でエラー:', err.message);
    return { ok: false };
  }
}

// ===== 1アイテム(指定/加工/数量)のバリデーション & 正規化 =====
// 複数アイテム(正式発注)の各要素、および単一形からの正規化に使う。
// 返り値: { errors, item, hasSpec, matrixTotal }
//  - hasSpec: 品番あり or 大カテゴリ選択あり(=アイテム指定の緩和条件を満たす)
//  - 「アイテム指定必須」「数量必須」の判定は呼び出し側が行う(文言/参考画像の扱いが文脈依存のため)
function validateItem(raw, request_type, prefix, label) {
  const errors = [];
  // prefix/label が空(単一形)のときは従来どおりの素のフィールド名・文言にする
  const fld = (suffix) => (prefix ? `${prefix}.${suffix}` : suffix);
  const lbl = (msg) => (label ? `${label}: ${msg}` : msg);
  const push = (suffix, msg) => errors.push({ field: fld(suffix), message: lbl(msg) });
  const ri = (raw && typeof raw === 'object') ? raw : {};

  // アイテム指定(品番/カテゴリ)
  const is = (ri.item_spec && typeof ri.item_spec === 'object') ? ri.item_spec : {};
  const catalog_items = Array.isArray(is.catalog_items)
    ? is.catalog_items
        .map(r => ({ catalog_number: s(r?.catalog_number), color: s(r?.color), maker: s(r?.maker) }))
        .filter(r => isNonEmptyStr(r.catalog_number))
    : [];
  const has1 = catalog_items.length > 0;

  let unknown_spec = null;
  const us = is.unknown_spec;
  const usProvided = us && typeof us === 'object'
    && (isNonEmptyStr(us.category) || isNonEmptyStr(us.sub_category)
        || isNonEmptyStr(us.purpose) || isNonEmptyStr(us.budget) || isNonEmptyStr(us.mood));
  if (usProvided) {
    const category = s(us.category);
    if (!CATEGORIES.has(category)) push('item_spec.unknown_spec.category', 'カテゴリを選択してください');
    let sub_category = s(us.sub_category);
    if (sub_category && !isValidSubCategory(category, sub_category)) sub_category = '';
    const estimateOnly = request_type !== 'order';   // ご予算感/用途/雰囲気は見積のみ
    unknown_spec = {
      category,
      sub_category,
      purpose: estimateOnly ? s(us.purpose, LEN.mid) : '',
      budget: estimateOnly ? s(us.budget) : '',
      mood: estimateOnly ? s(us.mood, LEN.mid) : '',
    };
  }
  const has2 = !!unknown_spec && CATEGORIES.has(unknown_spec.category);
  const hasSpec = has1 || has2;

  // 加工内容
  const d = (ri.decoration && typeof ri.decoration === 'object') ? ri.decoration : {};
  const method = s(d.method);
  if (!METHODS.has(method)) push('decoration.method', '加工方法を選択してください');
  let print_locations = [];
  if (Array.isArray(d.print_locations)) {
    print_locations = d.print_locations
      .map(l => ({ location_name: s(l?.location_name), color_count: parseInt(l?.color_count, 10) }))
      .filter(l => isNonEmptyStr(l.location_name));
    for (const l of print_locations) {
      if (!Number.isInteger(l.color_count) || l.color_count < 1 || l.color_count > 4) {
        push('decoration.print_locations', '各プリント位置の色数は1〜4で指定してください');
        break;
      }
    }
  }
  if ((method === 'print' || method === 'both') && print_locations.length === 0) {
    push('decoration.print_locations', 'プリント位置を1つ以上指定してください');
  }

  // 数量
  const q = (ri.quantity && typeof ri.quantity === 'object') ? ri.quantity : {};
  const approximate = s(q.approximate, LEN.mid);
  let matrix = null;
  if (q.matrix && typeof q.matrix === 'object' && Array.isArray(q.matrix.cells)) {
    const sizes = Array.isArray(q.matrix.sizes) ? q.matrix.sizes.map(x => s(x)).filter(Boolean) : [];
    const colors = Array.isArray(q.matrix.colors) ? q.matrix.colors.map(x => s(x)).filter(Boolean) : [];
    const cells = q.matrix.cells
      .map(c => ({ size: s(c?.size), color: s(c?.color), qty: parseInt(c?.qty, 10) }))
      .filter(c => Number.isInteger(c.qty) && c.qty > 0 && (isNonEmptyStr(c.size) || isNonEmptyStr(c.color)));
    for (const c of q.matrix.cells) {
      const qty = parseInt(c?.qty, 10);
      if (c?.qty !== '' && c?.qty !== null && c?.qty !== undefined && (!Number.isInteger(qty) || qty < 0)) {
        push('quantity.matrix', '数量は0以上の整数で入力してください');
        break;
      }
    }
    const total = cells.reduce((sum, c) => sum + c.qty, 0);
    matrix = { sizes, colors, cells, total };
  }
  const matrixTotal = matrix ? matrix.total : 0;

  const methods_used = [];
  if (has1) methods_used.push('catalog_number');
  if (has2) methods_used.push('unknown');

  const item = {
    item_spec: { methods_used, catalog_items, unknown_spec },
    decoration: { method, print_locations },
    quantity: { approximate, matrix },
  };
  return { errors, item, hasSpec, matrixTotal };
}

// ===== バリデーション & 正規化 =====
// 返り値: { errors: [{field, message}], data } (errors空なら data が正規化済み)
function validateAndNormalize(payload, fileRoles) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });

  const p = (payload && typeof payload === 'object') ? payload : {};

  // 依頼種別
  const request_type = s(p.request_type);
  if (!REQUEST_TYPES.has(request_type)) push('request_type', '依頼種別を選択してください');

  // 注文者情報(共通必須)
  const o = (p.orderer && typeof p.orderer === 'object') ? p.orderer : {};
  const orderer = {
    org_name: s(o.org_name),
    contact_name: s(o.contact_name),
    phone: s(o.phone),
    email: s(o.email),
  };
  // 会社/団体名は任意(個人のお客様もいるため)
  if (!isNonEmptyStr(orderer.contact_name)) push('orderer.contact_name', '担当者名を入力してください');
  if (!isNonEmptyStr(orderer.phone)) push('orderer.phone', '電話番号を入力してください');
  else if (!/^[\d\-+()\s]{7,20}$/.test(orderer.phone)) push('orderer.phone', '電話番号の形式が不正です');
  // メールは見積・正式発注とも任意。入力がある場合のみ形式チェック。
  if (isNonEmptyStr(orderer.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(orderer.email)) {
    push('orderer.email', 'メールアドレスの形式が不正です');
  }

  // ===== 共通項目(名簿/納期/備考) =====
  let roster = [];
  if (Array.isArray(p.roster)) {
    roster = p.roster
      .map(r => ({ player_name: s(r?.player_name), number: s(r?.number, 20), size: s(r?.size, 20) }))
      .filter(r => isNonEmptyStr(r.player_name) || isNonEmptyStr(r.number))
      .map((r, i) => ({ row_no: i + 1, ...r }));
  }

  // 納期(任意)。日付が入っている時だけ 14日ガードを適用。自由記述(未定/なる早等)は常に許容。
  const dl = (p.deadline && typeof p.deadline === 'object') ? p.deadline : {};
  const deadlineDate = s(dl.date, 20);
  const deadlineNote = s(dl.note, LEN.short);
  if (isNonEmptyStr(deadlineDate)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadlineDate) || Number.isNaN(Date.parse(deadlineDate))) {
      push('deadline.date', '納期の日付形式が不正です');
    } else if (deadlineDate < todayPlusDays(MIN_LEAD_DAYS)) {
      push('deadline.date', `納期は本日からおよそ${MIN_LEAD_DAYS}日以降でご指定ください`);
    }
  }
  const deadline = { date: isNonEmptyStr(deadlineDate) ? deadlineDate : null, note: deadlineNote };

  const remarks = s(p.remarks, LEN.long);

  let data;
  if (request_type === 'consult') {
    // ===== かんたん相談(最小構成)。詳細はお電話でヒアリングする前提のため、
    // アイテム指定・数量・納期などは要求しない。roster/deadline/remarksは
    // 後段の共通処理(notes組み立て等)が安全に通るよう空で持たせる。
    const c = (p.consult && typeof p.consult === 'object') ? p.consult : {};
    let preferred_time = s(c.preferred_time);
    if (!CONTACT_TIME_LABEL[preferred_time]) preferred_time = 'anytime';
    data = {
      request_type,
      orderer,
      consult: { preferred_time, message: s(c.message, LEN.long) },
      roster: [],
      deadline: { date: null, note: '' },
      remarks: '',
      schema_version: 2,
    };
  } else if (request_type === 'order' && Array.isArray(p.items)) {
    // ===== 正式発注・複数アイテム(schema_version 2) =====
    const rawItems = p.items.slice(0, MAX_ITEMS);
    if (rawItems.length === 0) push('items', 'アイテムを1つ以上入力してください');
    const items = [];
    rawItems.forEach((ri, idx) => {
      const label = `アイテム${idx + 1}`;
      const r = validateItem(ri, request_type, `items[${idx}]`, label);
      for (const e of r.errors) errors.push(e);
      // アイテム指定(品番 or 大カテゴリ)必須。参考画像はアイテム単位の充足条件に含めない。
      if (!r.hasSpec) push(`items[${idx}].item_spec`, `${label}: 品番 または カテゴリ を入力してください`);
      // 数量(サイズ内訳合計≥1 or 概数)必須
      if (r.matrixTotal < 1 && !isNonEmptyStr(r.item.quantity.approximate)) {
        push(`items[${idx}].quantity`, `${label}: 数量(サイズ内訳 または 概数)を入力してください`);
      }
      items.push(r.item);
    });
    data = { request_type, orderer, items, roster, deadline, remarks, schema_version: 2 };
    // 代表(先頭アイテム)を従来キーにも複製し、既存の読み手(カラム/引き継ぎ)との後方互換を保つ。
    if (items[0]) {
      data.item_spec = items[0].item_spec;
      data.decoration = items[0].decoration;
      data.quantity = items[0].quantity;
    }
  } else {
    // ===== 単一アイテム(見積、または items を持たない旧/LINE形式) =====
    const r = validateItem(p, request_type, '', '');
    // フィールド名を単一形(接頭辞なし)に整え、文言も従来のものに寄せる
    const has3 = (fileRoles || []).some(rr => rr === 'reference');
    // validateItem の item_spec/decoration/matrix エラーはそのまま採用(prefix='' なので従来と同じフィールド名)
    for (const e of r.errors) errors.push(e);
    if (!r.hasSpec && !has3) {
      push('item_spec', 'アイテム指定(品番・品番不明・参考画像のいずれか)を入力してください');
    }
    if (request_type === 'order' && r.matrixTotal < 1 && !isNonEmptyStr(r.item.quantity.approximate)) {
      push('quantity', '正式発注では数量(サイズ内訳 または 概数)を入力してください');
    }
    const methods_used = r.item.item_spec.methods_used.slice();
    if (has3) methods_used.push('reference');
    data = {
      request_type,
      orderer,
      item_spec: { ...r.item.item_spec, methods_used },
      decoration: r.item.decoration,
      quantity: r.item.quantity,
      roster,
      deadline,
      remarks,
    };
  }

  return { errors, data };
}

// ===== 要約(notes)とカラム値の組み立て =====
// 1アイテムの短いラベル(カテゴリ名 or 先頭品番)
function itemShortLabel(it) {
  const u = it.item_spec.unknown_spec;
  if (u && u.category) return CATEGORY_LABEL[u.category] || u.category;
  const c0 = it.item_spec.catalog_items[0];
  if (c0) return c0.catalog_number;
  return 'アイテム';
}
function itemsColumn(data) {
  if (data.request_type === 'consult') {
    const msg = data.consult && isNonEmptyStr(data.consult.message) ? data.consult.message : '';
    return `【電話相談】${msg ? msg.slice(0, 80) : '内容はお電話でヒアリング'}`.slice(0, 500);
  }
  if (Array.isArray(data.items)) {
    const parts = data.items.map(it => `${itemShortLabel(it)}(${METHOD_LABEL[it.decoration.method] || ''})`);
    return `${data.items.length}点: ${parts.join(' / ')}`.slice(0, 500) || null;
  }
  const parts = [METHOD_LABEL[data.decoration.method] || ''];
  const locs = data.decoration.print_locations
    .map(l => `${l.location_name}(${l.color_count}色)`).join('・');
  if (locs) parts.push(locs);
  return parts.filter(Boolean).join(' / ') || null;
}
function quantityColumn(data) {
  if (data.request_type === 'consult') return null;
  if (Array.isArray(data.items)) {
    const total = data.items.reduce((sum, it) => sum + (it.quantity.matrix ? it.quantity.matrix.total : 0), 0);
    if (total >= 1) return `計${total}枚`;
    const approx = data.items.map(it => it.quantity.approximate).filter(isNonEmptyStr);
    return approx.length ? approx.join(' / ') : null;
  }
  const total = data.quantity.matrix ? data.quantity.matrix.total : 0;
  if (total >= 1) return `計${total}枚`;
  return isNonEmptyStr(data.quantity.approximate) ? data.quantity.approximate : null;
}
function deadlineColumn(data) {
  return [data.deadline.date, data.deadline.note].filter(isNonEmptyStr).join(' / ') || null;
}
// 1アイテムの明細行(指定/加工/数量)。ind=行頭インデント。qtyLabel=数量ラベル。
function itemDetailLines(it, ind, qtyLabel) {
  const L = [];
  if (it.item_spec.unknown_spec) {
    const u = it.item_spec.unknown_spec;
    const catLabel = CATEGORY_LABEL[u.category] || u.category;
    const subLabel = u.sub_category ? (SUB_CATEGORY_LABEL[u.sub_category] || u.sub_category) : '';
    const seg = [`カテゴリ:${catLabel}${subLabel ? ' / ' + subLabel : ''}`];
    if (u.purpose) seg.push(`用途:${u.purpose}`);
    if (u.budget) seg.push(`予算:${u.budget}`);
    if (u.mood) seg.push(`雰囲気:${u.mood}`);
    L.push(`${ind}品番不明: ${seg.join(' / ')}`);
  }
  for (const c of it.item_spec.catalog_items) {
    L.push(`${ind}品番: ${c.catalog_number}${c.color ? ' ' + c.color : ''}${c.maker ? '(' + c.maker + ')' : ''}`);
  }
  const locs = it.decoration.print_locations.map(l => `${l.location_name}(${l.color_count}色)`).join('・');
  L.push(`${ind}加工: ${METHOD_LABEL[it.decoration.method] || it.decoration.method}${locs ? ' / 位置: ' + locs : ''}`);
  const m = it.quantity.matrix;
  if (m && m.total >= 1) {
    const brk = m.cells.slice(0, 12).map(c => `${c.size || ''}${c.color || ''}${c.qty}`).join(', ');
    const more = m.cells.length > 12 ? ` ほか${m.cells.length - 12}明細` : '';
    L.push(`${ind}${qtyLabel}: 合計${m.total}枚 (${brk}${more})`);
  } else if (isNonEmptyStr(it.quantity.approximate)) {
    L.push(`${ind}${qtyLabel}: ${it.quantity.approximate}`);
  }
  return L;
}
function buildNotes(data, savedImages, saveDir, receiptNo) {
  const L = [];
  L.push(`【WEB受注 / ${REQUEST_TYPE_LABEL[data.request_type] || data.request_type}】`);
  // 受付番号(W-xx)はお客様の完了画面・受付控えメールにも表示される問い合わせ用の番号。
  // notesに含めることで、案件登録時にそのまま案件メモへ引き継がれる
  if (receiptNo) L.push(`■受付番号: ${receiptNo}`);
  const o = data.orderer;
  L.push(`■注文者: ${o.org_name || '(会社/団体名なし)'} / ${o.contact_name} / ${o.phone} / ${o.email}`);

  if (data.request_type === 'consult') {
    // かんたん相談: 相談内容と希望連絡時間帯だけを載せ、担当者に架電を促す
    L.push(`■希望連絡時間帯: ${CONTACT_TIME_LABEL[data.consult.preferred_time] || 'いつでも'}`);
    L.push(`■ご相談内容: ${isNonEmptyStr(data.consult.message) ? data.consult.message : '(未記入。お電話でヒアリング)'}`);
    L.push('※お客様へお電話にて詳細をヒアリングしてください');
    const refCount = savedImages.filter(i => i.role === 'reference').length;
    if (refCount > 0) L.push(`■参考画像: ${refCount}点`);
  } else if (Array.isArray(data.items)) {
    // 複数アイテム(正式発注)
    const totalAll = data.items.reduce((sum, it) => sum + (it.quantity.matrix ? it.quantity.matrix.total : 0), 0);
    L.push(`■アイテム(${data.items.length}点)${totalAll >= 1 ? ` / 総数${totalAll}枚` : ''}:`);
    data.items.forEach((it, i) => {
      L.push(`  ・アイテム${i + 1}:`);
      L.push(...itemDetailLines(it, '    ', '数量'));
    });
  } else {
    // 単一アイテム(見積/旧形式)。従来の①②③表記を踏襲。
    const itemLines = [];
    const u = data.item_spec.unknown_spec;
    if (u) {
      const catLabel = CATEGORY_LABEL[u.category] || u.category;
      const subLabel = u.sub_category ? (SUB_CATEGORY_LABEL[u.sub_category] || u.sub_category) : '';
      const seg = [`カテゴリ:${catLabel}${subLabel ? ' / ' + subLabel : ''}`];
      if (u.purpose) seg.push(`用途:${u.purpose}`);
      if (u.budget) seg.push(`予算:${u.budget}`);
      if (u.mood) seg.push(`雰囲気:${u.mood}`);
      itemLines.push(`  ①品番不明: ${seg.join(' / ')}`);
    }
    for (const c of data.item_spec.catalog_items) {
      itemLines.push(`  ②品番: ${c.catalog_number}${c.color ? ' ' + c.color : ''}${c.maker ? '(' + c.maker + ')' : ''}`);
    }
    const refCount = savedImages.filter(i => i.role === 'reference').length;
    if (refCount > 0) itemLines.push(`  ③参考画像: ${refCount}点`);
    if (itemLines.length) { L.push('■アイテム:'); L.push(...itemLines); }

    const locs = data.decoration.print_locations.map(l => `${l.location_name}(${l.color_count}色)`).join('・');
    L.push(`■加工: ${METHOD_LABEL[data.decoration.method] || data.decoration.method}${locs ? ' / 位置: ' + locs : ''}`);

    const m = data.quantity.matrix;
    if (m && m.total >= 1) {
      const brk = m.cells.slice(0, 12).map(c => `${c.size || ''}${c.color || ''}${c.qty}`).join(', ');
      const more = m.cells.length > 12 ? ` ほか${m.cells.length - 12}明細` : '';
      L.push(`■数量: 合計${m.total}枚 (${brk}${more})`);
    } else if (isNonEmptyStr(data.quantity.approximate)) {
      const qtyLabel = data.request_type === 'order' ? '数量' : '数量(概数)';
      L.push(`■${qtyLabel}: ${data.quantity.approximate}`);
    }
  }

  // 参考画像(案件全体)
  if (Array.isArray(data.items)) {
    const refCount = savedImages.filter(i => i.role === 'reference').length;
    if (refCount > 0) L.push(`■参考画像: ${refCount}点`);
  }

  if (data.roster.length) {
    const head = data.roster.slice(0, 5)
      .map(r => `${r.number || '-'} ${r.player_name || ''}${r.size ? '/' + r.size : ''}`).join(', ');
    const more = data.roster.length > 5 ? ` ほか${data.roster.length - 5}名` : '';
    L.push(`■名簿: ${data.roster.length}名 (${head}${more})`);
  }

  const dl = deadlineColumn(data);
  if (dl) L.push(`■納期: ${dl}`);

  if (savedImages.length) {
    const rep = savedImages[0] ? savedImages[0].original_name : '';
    L.push(`■画像: ${savedImages.length}点${rep ? ' (代表:' + rep + ')' : ''} 保存先 ${saveDir}`);
  }
  if (data._imageWarning) L.push('⚠画像保存に失敗しました。手動で確認してください。');
  if (isNonEmptyStr(data.remarks)) L.push(`■備考: ${data.remarks}`);

  return L.join('\n');
}

// ===== 画像を NAS(UNC) に保存 =====
// 二段構え: intake_id 確定後に呼ぶ。temp から {intake_id}\ へ move(rename→copy fallback)。
function saveOrderImages(intakeId, files, fileRoles) {
  if (!files.length) return { images: [], dir: '', warning: false }; // 画像なしなら空フォルダを作らない
  const base = WEB_ORDER_RECEIVED_PATH.replace(/[\\/]+$/, '');
  const sep = pathSep(base);
  const dir = `${base}${sep}${intakeId}`;
  const saved = [];
  let warning = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(`[注文] 保存フォルダ作成失敗 dir=${dir}:`, err.message);
    cleanupTempFiles(files);
    return { images: [], dir, warning: true };
  }
  files.forEach((file, idx) => {
    const role = fileRoles[idx] || 'design';
    const sanitized = sanitizeFilename(file.originalname);
    const stored = `${String(idx + 1).padStart(2, '0')}_${role}_${sanitized}`;
    const dest = `${dir}${sep}${stored}`;
    try {
      try {
        fs.renameSync(file.path, dest);
      } catch (e) {
        // 別デバイス(ローカルtmp→ネットワーク共有)ではrenameが失敗するためcopy+unlink
        fs.copyFileSync(file.path, dest);
        safeUnlink(file.path);
      }
      saved.push({
        file_id: `img_${idx + 1}`,
        role,
        original_name: file.originalname,
        stored_name: stored,
        unc_path: dest,
        size_bytes: file.size,
        content_type: file.mimetype,
      });
    } catch (err) {
      console.error(`[注文] 画像保存失敗 ${file.originalname}:`, err.message);
      safeUnlink(file.path);
      warning = true;
    }
  });
  return { images: saved, dir, warning };
}

// ===== line_users に 'WEB' 疑似ユーザーを用意(FK ON/OFF どちらでも成立させるため) =====
function ensureWebUser(db) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO line_users (line_user_id, display_name, first_seen_at, last_message_at)
    VALUES ('WEB', 'Web注文フォーム', ?, ?)
    ON CONFLICT(line_user_id) DO NOTHING
  `).run(now, now);
}

// ===== ルート登録 =====
function registerOrderRoutes(app, db) {
  ensureWebUser(db);

  const tmpDir = path.join(os.tmpdir(), 'web_order_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ALLOWED_EXT.has(ext) && ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
      cb(new Error(`許可されていないファイル形式です: ${file.originalname}`));
    },
  });

  // 公開フォームHTML。sitekey等を注入して返す。
  app.get('/order', (req, res) => {
    try {
      let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'order.html'), 'utf8');
      html = html
        .replace(/{{TURNSTILE_SITEKEY}}/g, TURNSTILE_SITEKEY)
        .replace(/{{MIN_LEAD_DAYS}}/g, String(MIN_LEAD_DAYS));
      res.type('html').send(html);
    } catch (err) {
      res.status(500).send('フォームの読み込みに失敗しました');
    }
  });

  // multerをラップしてエラー(サイズ超過/形式不正)を400で返す
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

  app.post('/order', uploadMiddleware, async (req, res) => {
    const files = req.files || [];
    try {
      // 1. honeypot(botは静かに破棄)
      if (isNonEmptyStr(req.body.hp_url)) {
        cleanupTempFiles(files);
        return res.status(200).json({ ok: true });
      }

      // 2. レート制限
      const ip = getClientIp(req);
      const rl = checkRateLimit(ip);
      if (!rl.ok) {
        cleanupTempFiles(files);
        res.set('Retry-After', String(rl.retryAfter));
        return res.status(429).json({ ok: false, errors: [{ field: '_', message: '送信が多すぎます。しばらくしてから再度お試しください' }] });
      }

      // 3. Turnstile
      const ts = await verifyTurnstile(req.body['cf-turnstile-response'], ip);
      if (!ts.ok) {
        cleanupTempFiles(files);
        return res.status(403).json({ ok: false, errors: [{ field: '_', message: 'ロボット確認に失敗しました。ページを再読み込みしてお試しください' }] });
      }

      // 4. payload(JSON)パース
      let payload;
      try {
        payload = JSON.parse(req.body.payload || '{}');
      } catch (e) {
        cleanupTempFiles(files);
        return res.status(400).json({ ok: false, errors: [{ field: 'payload', message: '送信データの形式が不正です' }] });
      }

      // 画像の役割(role)をファイル順に取得。payload.images[i].role とアップロード順を対応させる。
      const metaImages = Array.isArray(payload.images) ? payload.images : [];
      const fileRoles = files.map((_, i) => {
        const r = s(metaImages[i]?.role);
        return IMAGE_ROLES.has(r) ? r : 'design';
      });

      // 5. バリデーション
      const { errors, data } = validateAndNormalize(payload, fileRoles);
      if (errors.length) {
        cleanupTempFiles(files);
        return res.status(400).json({ ok: false, errors });
      }

      // 6. INSERT(画像パス未確定の状態でまず着地させ intake_id を得る)
      const now = new Date().toISOString();
      const preRaw = {
        schema_version: 1,
        source: 'web_order_form',
        ...data,
        submitted_at: now,
        images: [],
        meta: { form_version: '1.0', user_agent: s(req.headers['user-agent'], LEN.short), client_ip_hash: hashIp(ip), turnstile_verified: !ts.skipped },
      };
      const insert = db.prepare(`
        INSERT INTO ai_extracted_intake
          (line_user_id, extracted_at, customer_name, items, quantity, deadline, notes, raw_ai_response, message_ids)
        VALUES ('WEB', ?, ?, ?, ?, ?, ?, ?, '[]')
      `);
      const info = insert.run(
        now,
        // 会社/団体名は任意のため、未記入時は担当者名を顧客名として使う
        data.orderer.org_name || data.orderer.contact_name,
        itemsColumn(data),
        quantityColumn(data),
        deadlineColumn(data),
        buildNotes(data, [], ''),
        JSON.stringify(preRaw),
      );
      const intakeId = info.lastInsertRowid;

      // 7. 画像をNASへ保存し、raw/notes/reference_link を確定してUPDATE
      const receiptNo = `W-${intakeId}`;
      const { images, dir, warning } = saveOrderImages(intakeId, files, fileRoles);
      data._imageWarning = warning;
      const finalRaw = { ...preRaw, images };
      const finalNotes = buildNotes(data, images, dir, receiptNo);
      const referenceLink = images.length ? images[0].unc_path : null;
      db.prepare(`
        UPDATE ai_extracted_intake
        SET raw_ai_response = ?, notes = ?, reference_link = ?
        WHERE id = ?
      `).run(JSON.stringify(finalRaw), finalNotes, referenceLink, intakeId);

      console.log(`[注文] 新規Web注文を受付: intake_id=${intakeId} type=${data.request_type} images=${images.length}${warning ? ' (画像保存に一部失敗)' : ''}`);

      // 8. メール送信(受付控え=お客様宛て / 新規注文通知=会社宛て)。
      // メール送信の成否はお客様の受付自体には影響させないため、レスポンスは待たずに返す。
      const mailPayload = {
        receiptNo,
        requestTypeLabel: REQUEST_TYPE_LABEL[data.request_type] || data.request_type,
        orderer: data.orderer,
        summary: {
          items: itemsColumn(data),
          quantity: quantityColumn(data),
          deadline: deadlineColumn(data),
          contact_time: data.request_type === 'consult'
            ? (CONTACT_TIME_LABEL[data.consult.preferred_time] || 'いつでも') : null,
        },
      };
      const willSendMail = isNonEmptyStr(data.orderer.email) && isMailerConfigured();
      if (willSendMail) {
        sendOrderConfirmation({ to: data.orderer.email, ...mailPayload }).then(() => {
          console.log(`[注文] 受付控えメールを送信: ${receiptNo}`);
        }).catch(err => {
          console.error(`[注文] 受付控えメールの送信に失敗(${receiptNo}):`, err.message);
        });
      }
      // 会社側への通知(MAIL_ADMIN_TO設定時のみ)。お客様のメール記入有無に関わらず送る
      sendOrderNotificationToAdmin(mailPayload).then(sent => {
        if (sent) console.log(`[注文] 会社宛て通知メールを送信: ${receiptNo}`);
      }).catch(err => {
        console.error(`[注文] 会社宛て通知メールの送信に失敗(${receiptNo}):`, err.message);
      });

      return res.status(201).json({ ok: true, intake_id: intakeId, receipt_no: receiptNo, receipt_mail: willSendMail, request_type: data.request_type, ...(warning ? { image_warning: true } : {}) });
    } catch (err) {
      console.error('[注文] 受付処理で予期しないエラー:', err);
      cleanupTempFiles(files);
      return res.status(500).json({ ok: false, errors: [{ field: '_', message: 'サーバー側でエラーが発生しました。時間をおいて再度お試しください' }] });
    }
  });
}

module.exports = { registerOrderRoutes, validateAndNormalize, MIN_LEAD_DAYS, WEB_ORDER_RECEIVED_PATH };
