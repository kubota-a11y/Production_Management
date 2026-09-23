'use strict';

// AI受付(LINE返信キュー)が金額を出すときに使う「価格ツール」(2026-09-24)。
// 見積シミュレーターと同じデータ(public/js/quote-sim-data.js)をサーバー側で読み、
// 枚数の段・割増・ボディ単価・パック・KRATVSカスタムオーダーを計算する。
// AIは条件を抽出してこのツールを呼び、返ってきた数字だけを文にする(自分で計算しない)。
// 計算方針は quote-sim.js の calcRowBase / calcKratvs と同じ(税抜。KRATVSとパックだけ税込)。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DATA_PATH = path.join(__dirname, '..', 'public', 'js', 'quote-sim-data.js');

let QS = null;
function loadData() {
  if (QS) return QS;
  const w = {};
  vm.runInNewContext(fs.readFileSync(DATA_PATH, 'utf8'), { window: w });
  QS = w;
  return QS;
}

const TAX = 10;
const up10 = (n) => Math.ceil(Math.round(n * 100) / 1000) * 10;
const taxOut = (n) => Math.round((n * 100) / (100 + TAX));
const taxIn = (n) => Math.round((n * (100 + TAX)) / 100);
const SMALL_PLATE = new Set(['B8', 'B7', 'A5', 'A4']);

function tierOf(table, qty) {
  let hit = null;
  for (const t of Object.keys(table).map(Number).sort((a, b) => a - b)) {
    if (qty >= t) hit = t;
  }
  return hit;
}

function tables(mode) {
  const w = loadData();
  if (mode === 'yagi') {
    return { silk: w.QS_YAGI.silk, dtf: w.QS_YAGI.dtf, rubber: w.QS_YAGI.rubber, minFeeApplies: false, bringFree: true };
  }
  return { silk: w.QS_SILK, dtf: w.QS_DTF, rubber: w.QS_RUBBER, minFeeApplies: true, bringFree: false };
}

function surRate(key, mode) {
  const s = loadData().QS_SURCHARGE[key];
  if (!s) return 1;
  return mode === 'yagi' && s.yagiRate ? s.yagiRate : s.rate;
}

// ---- 加工1箇所の単価(税抜) ----
// method: auto / silk / dtf / rubber / marking / emb / cap / nameEmb / dtfName
function calcProcessing(input) {
  const w = loadData();
  const mode = input.mode === 'yagi' ? 'yagi' : 'general';
  const tbl = tables(mode);
  const method = input.method || 'auto';
  const size = String(input.size || 'A4').toUpperCase();
  const qty = Math.max(1, parseInt(input.qty, 10) || 1);
  const minQty = Math.max(1, parseInt(input.min_qty, 10) || qty);
  const colors = input.colors === 'full' ? 'full' : Math.max(1, parseInt(input.colors, 10) || 1);
  const surcharges = Array.isArray(input.surcharges) ? input.surcharges : [];
  const express = Boolean(input.express);
  const noInitial = Boolean(input.no_initial);

  const sur = surcharges.filter((k) => w.QS_SURCHARGE[k] && !(tbl.bringFree && k === 'bring')).reduce((m, k) => m * surRate(k, mode), 1);
  const minFee = tbl.minFeeApplies && minQty < 10 ? w.QS_COMMON.minFeeRate : 1;
  const expr = express ? 1.5 : 1;
  const mul = (u) => up10(u * sur * minFee * expr);
  const mulNoMin = (u) => up10(u * sur * expr);
  const notes = [];
  if (express) notes.push('特急料金(1週間納期)1.5倍を適用');
  if (surcharges.length) notes.push(`割増: ${surcharges.map((k) => (w.QS_SURCHARGE[k] || {}).name || k).join('・')}`);

  if (method === 'marking') {
    if (mode === 'yagi') return { ok: false, error: '八木繊維様のマーキングは個別見積(表に無い)' };
    const m = w.QS_MARKING.find((x) => x.key === input.mark_key) || w.QS_MARKING[0];
    return { ok: true, tax: '税抜', method: 'マーキング', label: `マーキング ${m.name}(${m.size})`, unit: mulNoMin(m.p), initial: 0, notes: [...notes, '当社保有の書体で作る場合の価格。指定書体は別途'] };
  }
  if (method === 'nameEmb') {
    return { ok: true, tax: '税抜', method: 'ネーム刺繍', label: 'ネーム刺繍(1.5×8cm以内)', unit: mulNoMin(w.QS_EMB.nameOnly), initial: 0, notes };
  }
  if (method === 'dtfName') {
    return { ok: true, tax: '税抜', method: 'DTFネームプリント', label: 'DTFネームプリント', unit: mulNoMin(w.QS_COMMON.dtfName), initial: 0, notes: [...notes, '登録業者様向けの単価'] };
  }
  if (method === 'emb' || method === 'cap') {
    if (mode === 'yagi') return { ok: false, error: '八木繊維様の刺繍は個別見積(表に無い)' };
    const isCap = method === 'cap';
    const t = isCap ? w.QS_EMB.cap : w.QS_EMB.normal;
    const placesTotal = Math.max(1, parseInt(input.emb_places_total, 10) || qty);
    const placesKey = placesTotal >= 50 ? '50箇所〜' : placesTotal >= 10 ? '10〜49箇所' : placesTotal >= 3 ? '3〜9箇所' : '1〜2箇所';
    const timeKey = input.emb_time === '16〜30分' ? '16〜30分' : '〜15分';
    const sizeIdx = Math.min(2, Math.max(0, parseInt(input.emb_size_index, 10) || 0));
    const base = isCap ? t.rows[placesKey][timeKey] : t.rows[placesKey][timeKey][sizeIdx];
    const punch = noInitial ? 0 : (isCap ? t.punching : t.punching[sizeIdx]);
    const patchFee = input.patch ? w.QS_EMB.patch : 0;
    const sizeName = isCap ? '100cm²以内' : w.QS_EMB.normal.sizes[sizeIdx];
    return {
      ok: true, tax: '税抜', method: isCap ? '帽子刺繍' : '刺繍',
      label: `${isCap ? '帽子刺繍' : '刺繍'} ${placesKey}・${timeKey}・${sizeName}${input.patch ? '・ワッペン用資材一式' : ''}`,
      unit: mulNoMin(base) + patchFee, initial: punch, initial_label: 'パンチング代(初回のみ)',
      notes: [...notes, '加工時間は刺繍データ完成後に確定するので概算(〜15分で仮置き)。合計箇所数で段が決まる'],
    };
  }
  if (method === 'rubber') {
    const table = tbl.rubber[size];
    if (!table) return { ok: false, error: `ラバー転写に ${size} の設定なし(B7/A5/A4/A3)` };
    const u = table[tierOf(table, qty)];
    return { ok: true, tax: '税抜', method: 'ラバー転写', label: `ラバー転写プリント(${size}以内)`, unit: mulNoMin(u), initial: 0, tier: tierOf(table, qty), notes };
  }

  // シルク / DTF / 自動
  if (!tbl.dtf[size]) return { ok: false, error: `サイズは B8/B7/A5/A4/A3 のいずれか(指定: ${size})` };
  const dtfTier = tierOf(tbl.dtf[size], qty);
  const dtfUnit = tbl.dtf[size][dtfTier];
  const dtf = { ok: true, tax: '税抜', method: 'DTF', label: `DTFプリント フルカラー(${size}以内)`, unit: mulNoMin(dtfUnit), initial: 0, tier: dtfTier, notes: [...notes, 'DTFにミニマム手数料は掛からない'] };

  const silkTable = colors !== 'full' && colors <= tbl.silk.maxColors ? tbl.silk.print[colors] : null;
  let silkTier = silkTable ? tierOf(silkTable, qty) : null;
  const silkBelowMin = Boolean(silkTable) && silkTier === null && method === 'silk';
  if (silkBelowMin) silkTier = Math.min(...Object.keys(silkTable).map(Number));
  const silkUnit = silkTier !== null && silkTable ? silkTable[silkTier] : null;
  const plateOne = tbl.silk.plate[SMALL_PLATE.has(size) ? 'small' : 'large'];
  const silkPlate = noInitial ? 0 : plateOne * (colors === 'full' ? 0 : colors);
  const silk = silkUnit === null ? null : {
    ok: true, tax: '税抜', method: 'シルク', label: `シルクプリント ${colors === 1 ? '単色' : `${colors}色`}(${size}以内)`,
    unit: mul(silkUnit), initial: silkPlate, initial_label: `製版代 ${colors}版(初回のみ・版は1年保管)`, tier: silkTier,
    notes: [...notes, ...(minFee > 1 ? ['同一型番10枚未満のためミニマム手数料(5割増)を適用'] : []), ...(silkBelowMin ? ['10枚未満のシルクは原則お受けしない(特別対応の単価)'] : [])],
  };

  if (method === 'dtf' || colors === 'full') return dtf;
  if (method === 'silk') return silk || { ...dtf, notes: [...dtf.notes, 'この色数・枚数はシルク設定なし→DTFで計算'] };
  if (silk && silk.unit * qty + silk.initial < dtf.unit * qty) return { ...silk, notes: [...silk.notes, 'シルク/DTFの安い方(総額比較)としてシルクを採用'] };
  return { ...dtf, notes: [...dtf.notes, silk ? 'この枚数・大きさではDTFのほうがお得' : 'シルク設定が無いためDTFで計算'] };
}

// ---- ボディ(無地の服)の単価(税抜) ----
function lookupBody(input) {
  const w = loadData();
  const q = String(input.query || '').trim();
  if (!q) return { ok: false, error: '品番または商品名を指定してください' };
  const norm = (s) => String(s).toLowerCase().replace(/[\s　-]/g, '');
  const nq = norm(q);
  const hits = w.QS_BODIES.filter((b) => norm(b.sku).startsWith(nq) || norm(b.name).includes(nq) || nq.includes(norm(b.sku)));
  if (!hits.length) return { ok: true, tax: '税抜', found: 0, bodies: [], note: '該当なし。品番(例: 5001)や商品名の一部で再検索' };
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const bodies = hits.slice(0, 8).map((b) => {
    const quoteOnly = w.QS_isQuoteOnly(b, today);
    const sizes = w.QS_BODY_SIZES[b.sku];
    const bands = sizes ? sizes.v.flatMap((v) => v.b.map(([label, price]) => `${label}:${price}円`)).slice(0, 12) : [];
    return {
      sku: b.sku, name: b.name, category: b.cat, unit: b.body, open_price: Boolean(b.open),
      quote_only: quoteOnly, quote_reason: quoteOnly ? (w.QS_quoteOnlyReason(b, today) || 'material') : null,
      size_bands: bands,
    };
  });
  return { ok: true, tax: '税抜', found: hits.length, bodies, note: 'unit は基準サイズの1枚単価(税抜)。サイズ帯で単価が変わる品番は size_bands を見る。quote_only=true は概算を出さず「個別にお見積もり」と案内する' };
}

// ---- 1枚からパック(税込) ----
function calcPack(input) {
  const qty = Math.max(1, parseInt(input.qty, 10) || 1);
  if (qty > 5) return { ok: false, error: '1枚からパックは1〜5枚が対象。6枚以上は一般加工(calc_processing + lookup_body)で概算' };
  const unit = qty === 1 ? 4290 : 3850;
  const a3 = Math.max(0, parseInt(input.a3_places, 10) || 0);          // A3拡大の箇所数(1箇所ごと+550)
  const extra = Math.max(0, parseInt(input.extra_places, 10) || 0);    // 追加プリント箇所数(1箇所ごと+550)
  const xl = Math.max(0, parseInt(input.xl_count, 10) || 0);           // 2XL・3XLの枚数(+220)
  const caps = Math.max(0, parseInt(input.caps, 10) || 0);             // キャップ(プリント込み・ウェア同時のみ)+1,870
  const shipping = input.shipping ? 1100 : 0;
  const lines = [{ label: `1枚からパック ${qty}枚(ボディ+DTF A4以内1箇所+袋入れ)`, amount: unit * qty }];
  if (a3) lines.push({ label: `A3サイズへの拡大 ${a3}箇所×${qty}枚`, amount: 550 * a3 * qty });
  if (extra) lines.push({ label: `追加プリント ${extra}箇所×${qty}枚`, amount: 550 * extra * qty });
  if (xl) lines.push({ label: `2XL・3XL割増 ${xl}枚`, amount: 220 * xl });
  if (caps) lines.push({ label: `キャップ(プリント込み) ${caps}個`, amount: 1870 * caps });
  if (shipping) lines.push({ label: '送料(80サイズ・全国一律)', amount: 1100 });
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return {
    ok: true, tax: '税込', unit_per_piece: unit, lines, total,
    conditions: ['対象ボディ: 綿 United Athle 5001 / ドライ glimmer 300-ACT / 綿厚手 Printstar 00085(S〜XL)', '完全データ支給が条件。画像加工・デザイン制作は+3,300円〜(税込)', '前払い・納期は入金から2週間', 'デザイン修正は2回まで無料、3回目以降1回2,200円(税込)', '店頭(工場)受取は送料無料'],
  };
}

// ---- KRATVSカスタムオーダー(税込) ----
function calcKratvsCustom(input) {
  const w = loadData();
  const k = w.QS_KRATVS;
  const q = String(input.item || '').trim().toUpperCase();
  const item = k.items.find((i) => i.code === q) || k.items.find((i) => i.name.includes(String(input.item || '').trim())) || null;
  if (!item) return { ok: false, error: `品目が見つからない。コード(${k.items.map((i) => i.code).join('/')})か品名で指定`, items: k.items.map((i) => `${i.code} ${i.name}`) };
  const qty = Math.max(1, parseInt(input.qty, 10) || 1);
  let band = null;
  if (item.qtyTier) {
    band = [...item.price].filter((b) => (b.min || 1) <= qty).sort((a, b) => (b.min || 1) - (a.min || 1))[0] || item.price[item.price.length - 1];
  } else if (input.size) {
    const s = String(input.size).trim();
    band = item.price.find((b) => b.size === s) || item.price.find((b) => b.size.includes(s)) || null;
  }
  const printList = item.kind === 'towel' ? [] : item.kind === 'shorts' ? k.printsShorts : item.kind === 'bib' ? k.printsBib : item.kind === 'cap' ? k.printsCap : k.printsShirt;
  const wanted = Array.isArray(input.prints) ? input.prints : [];
  const picked = printList.filter((p) => wanted.some((n) => p.t === n || p.t.includes(String(n))));
  let setApplied = null; let rest = [...picked];
  for (const s of [...k.sets].sort((a, b) => b.count - a.count)) {
    if (s.scope !== item.kind) continue;
    const names = rest.map((p) => p.t);
    if (!s.need.every((n) => names.includes(n))) continue;
    let anyPick = null;
    if (s.any) { anyPick = s.any.from.find((n) => names.includes(n)); if (!anyPick) continue; }
    const used = [...s.need, ...(anyPick ? [anyPick] : [])];
    setApplied = { name: s.t, price: s.p, used };
    rest = rest.filter((p) => !used.includes(p.t));
    break;
  }
  const prints = [...(setApplied ? [{ label: `${setApplied.name}(${setApplied.used.join('+')})`, price: setApplied.price }] : []), ...rest.map((p) => ({ label: `${p.t}(${p.size})`, price: p.p }))];
  const printTotal = prints.reduce((s, p) => s + p.price, 0);
  const body = band ? band.p : null;
  return {
    ok: true, tax: '税込', item: `${item.code} ${item.name}`, size_band: band ? band.size : null,
    body_unit: body, size_bands: item.price.map((b) => `${b.size}:${b.p}円`),
    prints, print_unit_total: printTotal,
    unit_per_piece: body === null ? null : body + printTotal,
    total: body === null ? null : (body + printTotal) * qty,
    available_prints: printList.map((p) => `${p.t}(${p.size}) ${p.p}円`),
    notes: ['KRATVSカスタムオーダーは税込の定額。小口(1〜5枚)に距離割引は無い', body === null ? 'サイズ帯を指定すると本体単価が出る' : null].filter(Boolean),
  };
}

// ---- KRATVS昇華フルオーダー(ユニフォーム)カタログ定価 ----
const UNIFORM_CATALOG = [
  { item: 'FP用ゲームシャツ(半袖)', bands: [['140-160cm', 8600], ['S-O', 9600], ['XO-3XO', 10800]] },
  { item: 'FP用ゲームシャツ(長袖)', bands: [['140-160cm', 10600], ['S-O', 12400], ['XO-3XO', 13200]] },
  { item: 'FP用ゲームパンツ', bands: [['140-160cm', 7400], ['S-XO', 7700], ['2XO-3XO', 8400]] },
  { item: 'GK用シャツ(半袖)', bands: [['140-160cm', 11100], ['S-O', 11900], ['XO-3XO', 13700]] },
  { item: 'GK用シャツ(長袖)', bands: [['140-160cm', 12400], ['S-O', 13200], ['XO-3XO', 13700]] },
  { item: 'GK用パンツ', bands: [['140-160cm', 8700], ['S-3XO', 9200]] },
  { item: 'ジャージジャケット(スタンドネック)', bands: [['140-160cm', 15000], ['S-3XO', 15600]] },
  { item: 'ジャージジャケット(ラウンドネック)', bands: [['140-160cm', 15000], ['S-3XO', 15600]] },
  { item: 'フルデザインジャージパンツ', bands: [['140-160cm', 11000], ['S-3XO', 11500]] },
];
function lookupUniformCatalog(input) {
  const q = String(input.item || '').trim();
  const rows = UNIFORM_CATALOG.filter((r) => !q || r.item.includes(q) || q.split(/\s+/).every((t) => r.item.includes(t)));
  return {
    ok: true, tax: '税抜(税込も併記)',
    items: rows.map((r) => ({ item: r.item, prices: r.bands.map(([s, p]) => ({ size: s, price_ex: p, price_in: taxIn(p) })) })),
    conditions: ['カタログ定価(上代)。チーム向けの特別価格(割引)は担当から見積でご案内(社長判断)', '新規5枚〜', '納期の目安は工場作製開始後5週間程度', 'ピステ・ウィンドブレーカーは未掲載(要相談)'],
  };
}

// ---- ユニリペア(税込) ----
function lookupRepair() {
  return {
    ok: true, tax: '税込',
    items: [
      { item: '背番号(大・縦25cm以下)', repair: 3300, attach_only: 2200 },
      { item: '胸番号・背番号(小・縦10cm以下)', repair: 2200, attach_only: 1320 },
      { item: '背ネーム(個人名)', repair: 2200, attach_only: 1540 },
      { item: 'チーム名・スポンサー名', repair: 3300, attach_only: 2200 },
    ],
    extras: ['下地処理が重い場合(糊残り・自己アイロン跡)+1,100円', '送料1,100円(店頭受取は無料)'],
    conditions: ['競技用ユニフォームのみ(記念品・コレクション目的は不可)', '別番号への付け替えは不可(同じ番号の入れ直しだけ)', '写真で一次判断→現物確認→正式見積。直せないと判断したら無償返却', '5枚以上のまとめ持込は個別見積'],
  };
}

// ---- 共通費用 ----
function lookupCommon() {
  const w = loadData();
  return {
    ok: true, tax: '税抜',
    shipping: { s80: w.QS_COMMON.shipping.s80, s100: w.QS_COMMON.shipping.s100, pack_tax_in: 1100 },
    bagging: w.QS_COMMON.bagging, design_fee_tax_in_from: 3300,
    notes: ['送料は80サイズ/100サイズ(税抜)。パックは税込1,100円全国一律', '袋入れはTシャツ40円/スウェット60円(1枚)', 'デザイン制作・画像加工は3,300円〜(税込)。支給データがそのまま使えない案件は必ず課金'],
  };
}

// ---- Claude に渡すツール定義 ----
const TOOLS = [
  {
    name: 'calc_processing',
    description: '一般加工(または八木繊維様の卸表)の「加工1箇所あたりの単価(税抜)」を料金表から計算する。シルク/DTF/ラバー転写/マーキング/刺繍/帽子刺繍/ネーム刺繍。ボディ代は含まない(lookup_body で別に引く)。1〜5枚の小口で対象ボディなら calc_pack を優先する。',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['auto', 'silk', 'dtf', 'rubber', 'marking', 'emb', 'cap', 'nameEmb', 'dtfName'], description: 'auto=シルク/DTFの安い方' },
        size: { type: 'string', enum: ['B8', 'B7', 'A5', 'A4', 'A3'], description: 'プリントの大きさ(B8〜58cm²/B7〜116/A5〜313/A4〜624/A3〜1247)' },
        colors: { type: 'string', description: 'シルクの色数 1〜4、フルカラーは full' },
        qty: { type: 'integer', description: 'その加工を刷る総枚数(枚数の段の判定)' },
        min_qty: { type: 'integer', description: '同一型番の枚数(シルクのミニマム判定)。省略時は qty' },
        mode: { type: 'string', enum: ['general', 'yagi'] },
        surcharges: { type: 'array', items: { type: 'string' }, description: '割増キー: express/special/bring/specialInk/overlay/colorChange/blousonS/blousonL/sheetNylon/sheetNylonGold/sheetMetallic/sheetPearl/sheetReflex/sheetGlow/embThread/embFabric/emb3D' },
        express: { type: 'boolean' },
        no_initial: { type: 'boolean', description: '版・刺繍データが既にある(追加注文)なら true' },
        mark_key: { type: 'string', enum: ['num_l', 'num_s', 'emblem', 'team', 'name'] },
        emb_places_total: { type: 'integer', description: '刺繍の合計箇所数(枚数×1枚の箇所数)' },
        emb_time: { type: 'string', enum: ['〜15分', '16〜30分'] },
        emb_size_index: { type: 'integer', description: '刺繍サイズ 0=100cm²以内 1=225 2=400' },
        patch: { type: 'boolean' },
      },
      required: ['method', 'qty'],
    },
  },
  {
    name: 'lookup_body',
    description: 'ボディ(無地の服)の品番・商品名から1枚単価(税抜)を引く。quote_only=true の品番は概算を出さず個別見積と案内する。',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: '品番(5001, 00085, 300-ACT 等)か商品名の一部' } }, required: ['query'] },
  },
  {
    name: 'calc_pack',
    description: '1枚からパック(1〜5枚・税込・コミコミ)の金額。対象ボディ3種(UA5001/glimmer 300-ACT/Printstar 00085)・DTF A4以内1箇所・データ支給が条件。',
    input_schema: {
      type: 'object',
      properties: {
        qty: { type: 'integer' }, a3_places: { type: 'integer', description: 'A3に拡大する箇所数' },
        extra_places: { type: 'integer', description: '2箇所目以降の追加プリント箇所数' },
        xl_count: { type: 'integer', description: '2XL・3XLの枚数' }, caps: { type: 'integer', description: 'キャップの個数(ウェア同時のみ)' },
        shipping: { type: 'boolean', description: '発送する場合 true(店頭受取は false)' },
      },
      required: ['qty'],
    },
  },
  {
    name: 'calc_kratvs_custom',
    description: 'KRATVSカスタムオーダー(税込定額)の本体+プリント+セット料金。品目コード T-01/T-02/T-03/T-04/P-01/S-01/S-02/S-03/B-01/C-01/O-01/O-02。',
    input_schema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '品目コードまたは品名' }, size: { type: 'string', description: 'サイズ帯(例 S〜XL, 120〜160, XXL〜XXXXL)' },
        qty: { type: 'integer' }, prints: { type: 'array', items: { type: 'string' }, description: 'プリント名(背番号/胸番号/エンブレム/ワンポイント/チーム名／スポンサー名/選手名/スポンサー名(小)/スポンサー名(大)/選手番号)' },
      },
      required: ['item'],
    },
  },
  {
    name: 'lookup_uniform_catalog',
    description: 'KRATVS昇華フルオーダー(サッカーユニフォーム・ゲームシャツ・ジャージ)のカタログ定価(上代)。割引は出さない。',
    input_schema: { type: 'object', properties: { item: { type: 'string', description: '品名の一部(FP/GK/ゲームシャツ/パンツ/ジャージ)。空なら全件' } } },
  },
  { name: 'lookup_repair', description: 'ユニリペア(剥がれた背番号・ネームの修理)の税込価格と条件。', input_schema: { type: 'object', properties: {} } },
  { name: 'lookup_common', description: '送料・袋入れ・デザイン制作費などの共通費用。', input_schema: { type: 'object', properties: {} } },
];

function runTool(name, input) {
  const i = input || {};
  switch (name) {
    case 'calc_processing': return calcProcessing(i);
    case 'lookup_body': return lookupBody(i);
    case 'calc_pack': return calcPack(i);
    case 'calc_kratvs_custom': return calcKratvsCustom(i);
    case 'lookup_uniform_catalog': return lookupUniformCatalog(i);
    case 'lookup_repair': return lookupRepair();
    case 'lookup_common': return lookupCommon();
    default: return { ok: false, error: `unknown tool ${name}` };
  }
}

module.exports = { TOOLS, runTool, calcProcessing, lookupBody, calcPack, calcKratvsCustom, lookupUniformCatalog, lookupRepair, lookupCommon, taxIn, taxOut, up10 };
