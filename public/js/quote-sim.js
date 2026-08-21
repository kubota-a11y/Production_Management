/* =========================================================
   見積シミュレーター(社内用) /quote-sim

   サイトの料金シミュレーター(GITHUB_HiYOSHi_WEB/functions/api/simulate.js)
   と同じ計算方針:
   - 単価表は税抜で持ち、お客様に見せる金額は taxIn() で税込へ(1円未満切り上げ)
   - モノクロ(1〜4色)はシルクとDTFの両方を計算して安い方を採用
   - 製版代は「箇所×色数」の版の数だけ。小版=A4以内4,000/大版=A3 8,000
   - ミニマム手数料: 同一型番10枚未満は加工代5割増
   価格データはすべて quote-sim-data.js(出典コメントあり)。
   割引はこの画面だけの機能(サイトには無い):
   - 距離基準プリセット(10〜50%)…1枚単価(ボディ+加工)に適用。
     製版代・パンチング代などの初期費用は割引対象外(実費)
   - 社員特価…ボディ=推定仕入値(表示価格×0.55)+加工賃50%OFF
   ========================================================= */
(function () {
  'use strict';

  const TAX = window.QS_COMMON.taxPercent;
  // 浮動小数点誤差を避けるため整数のまま計算(simulate.jsと同じ)
  const taxIn = (n) => Math.ceil((n * (100 + TAX)) / 100);
  const yen = (n) => n.toLocaleString('ja-JP') + '円';

  const SIZES_ALL = ['B8', 'B7', 'A5', 'A4', 'A3'];
  const SMALL_PLATE = new Set(['B8', 'B7', 'A5', 'A4']);

  function tierOf(table, qty) {
    let hit = null;
    for (const t of Object.keys(table).map(Number).sort((a, b) => a - b)) {
      if (qty >= t) hit = t;
    }
    return hit;
  }

  /* ---------- 価格表の切り替え ----------
     八木繊維様モードは画面構成そのままに、参照する料金表と条件だけ差し替える。
     - 卸表に無い加工(マーキング・刺繍)は選択肢から外す=個別見積り
     - ミニマム手数料なし・持込料サービス・版下データ作成料0円
     - 割引プリセットは出さない(卸価格自体が特別価格のため。二重割引の防止) */
  function currentMode() {
    return document.querySelector('input[name="mode"]:checked').value;
  }
  function isYagi() { return currentMode() === 'yagi'; }
  function activeTables() {
    if (isYagi()) {
      return {
        silk: window.QS_YAGI.silk, dtf: window.QS_YAGI.dtf, rubber: window.QS_YAGI.rubber,
        minFeeApplies: false, bringFree: true,
      };
    }
    return {
      silk: window.QS_SILK, dtf: window.QS_DTF, rubber: window.QS_RUBBER,
      minFeeApplies: true, bringFree: false,
    };
  }

  // 割増率。ナイロン・撥水シート系は一般表と八木繊維様専用表で率が違う(yagiRate)
  function surRate(key) {
    const s = window.QS_SURCHARGE[key];
    return (isYagi() && s.yagiRate) ? s.yagiRate : s.rate;
  }

  /* ---------- 加工行の定義 ---------- */
  // method: auto(シルク/DTF安い方) / silk / dtf / rubber / marking / emb / cap
  let rowSeq = 0;
  const rows = []; // {id, method, size, colors, markKey, embPlaces, embTime, embSize, patch, surcharges:Set}

  function newRow() {
    rows.push({
      id: ++rowSeq, method: 'auto', size: 'A4', colors: 1, markKey: 'num_l',
      embPlaces: '1〜2箇所', embTime: '〜15分', embSize: 0, patch: false, surcharges: new Set(),
    });
  }

  /* ---------- 1行ぶんの単価計算(税抜) ----------
     返り値 {label, unit, initial, initialLabel, note} */
  function calcRow(row, qty, opt) {
    const tbl = activeTables();
    // 持込料は八木繊維様は「サービス」なのでチェックが残っていても掛けない
    const sur = [...row.surcharges]
      .filter((k) => !(tbl.bringFree && k === 'bring'))
      .reduce((m, k) => m * surRate(k), 1);
    const minFee = (tbl.minFeeApplies && qty < 10) ? window.QS_COMMON.minFeeRate : 1;
    const expr = opt.express ? 1.5 : 1;
    const mul = (u) => Math.round(u * sur * minFee * expr);

    if (row.method === 'marking') {
      const m = window.QS_MARKING.find((x) => x.key === row.markKey);
      return { label: `マーキング ${m.name}(${m.size})`, unit: mul(m.p), initial: 0, note: window.QS_MARKING_NOTE };
    }
    if (row.method === 'nameEmb') {
      return { label: 'ネーム刺繍(1.5×8cm以内)', unit: mul(window.QS_EMB.nameOnly), initial: 0, note: '' };
    }
    if (row.method === 'dtfName') {
      return { label: 'DTFネームプリント', unit: mul(window.QS_COMMON.dtfName), initial: 0, note: '登録業者様向けの単価です' };
    }
    if (row.method === 'emb' || row.method === 'cap') {
      const isCap = row.method === 'cap';
      const t = isCap ? window.QS_EMB.cap : window.QS_EMB.normal;
      const base = isCap
        ? t.rows[row.embPlaces][row.embTime]
        : t.rows[row.embPlaces][row.embTime][row.embSize];
      const punch = isCap ? t.punching : t.punching[row.embSize];
      const sizeName = isCap ? '100cm²以内' : window.QS_EMB.normal.sizes[row.embSize];
      // ワッペン用資材一式は割増ではなく1枚あたりの実費(円加算)
      const patchFee = row.patch ? window.QS_EMB.patch : 0;
      return {
        label: `${isCap ? '帽子刺繍' : '刺繍'} ${row.embPlaces}・${row.embTime}・${sizeName}${row.patch ? '・ワッペン用資材一式' : ''}`,
        unit: mul(base) + patchFee, initial: punch, initialLabel: 'パンチング代(初回のみ)',
        note: '加工時間は刺繍データ完成後に確定(この金額は概算)',
      };
    }
    if (row.method === 'rubber') {
      const table = tbl.rubber[row.size];
      if (!table) return { label: 'ラバー転写', unit: 0, initial: 0, note: 'B8はラバー転写の設定なし' };
      const u = table[tierOf(table, qty)];
      return { label: `ラバー転写 ${row.size}`, unit: mul(u), initial: 0, note: '' };
    }

    // シルク/DTF/自動
    const dtfUnit = tbl.dtf[row.size][tierOf(tbl.dtf[row.size], qty)];
    const silkTier = (row.colors !== 'full' && row.colors <= tbl.silk.maxColors)
      ? tierOf(tbl.silk.print[row.colors], qty) : null;
    const silkUnit = silkTier !== null ? tbl.silk.print[row.colors][silkTier] : null;
    const plateOne = tbl.silk.plate[SMALL_PLATE.has(row.size) ? 'small' : 'large'];
    const silkPlate = plateOne * row.colors;

    const dtf = { label: `DTFプリント ${row.size}(フルカラー可)`, unit: mul(dtfUnit), initial: 0, note: '' };
    const silk = silkUnit === null ? null : {
      label: `シルク ${row.size}・${row.colors}色`, unit: mul(silkUnit),
      initial: silkPlate, initialLabel: `製版代 ${row.colors}版(初回のみ)`, note: '版の保管期間1年',
    };

    if (row.method === 'dtf' || row.colors === 'full') return dtf;
    if (row.method === 'silk') {
      return silk || { ...dtf, note: 'この枚数・色数はシルク設定なし→DTFで計算' };
    }
    // auto: 総額比較(simulate.jsと同じ)
    if (silk && silk.unit * qty + silk.initial < dtf.unit * qty) return silk;
    return { ...dtf, note: silk ? 'この枚数・大きさではDTFのほうがお得' : 'シルク設定が無いためDTFで計算' };
  }

  /* ---------- サイズ・色別の内訳 ----------
     ボディ単価はサイズ帯・色区分で変わる(QS_BODY_SIZES)。内訳行を入れると
     枚数は自動集計になり、転記シート・freeeの明細も行ごとに分かれる。
     ★枚数帯・ミニマム手数料の判定は「同一型番の総数」のまま(従来ルール) */
  let bdSeq = 0;
  const breakdown = []; // {id, variant(色区分idx), band(サイズ帯idx), sizeText, color(自由記述), qty}

  function currentSku() {
    const v = el('body-input').value.trim();
    const hit = window.QS_BODIES.find((b) => v.startsWith(b.sku) || v === `${b.sku} ${b.name}`);
    return hit ? hit.sku : null;
  }
  function bodySizeData() {
    const sku = currentSku();
    return sku ? (window.QS_BODY_SIZES[sku] || null) : null;
  }

  /** 内訳行 → 計算グループ {label, qty, bodyUnit(税抜)}。内訳なしなら総数1グループ */
  function currentGroups(body) {
    const data = bodySizeData();
    const list = breakdown.filter((r) => r.qty > 0);
    if (!list.length) {
      return [{ label: '', qty: Math.max(1, parseInt(el('qty').value, 10) || 1), bodyUnit: body.unit }];
    }
    return list.map((r) => {
      let unit = body.unit;
      let label = '';
      if (data) {
        const variant = data.v[Math.min(r.variant, data.v.length - 1)];
        const band = variant.b[Math.min(r.band, variant.b.length - 1)];
        unit = band[1];
        label = `${variant.l ? `${variant.l}・` : ''}${band[0]}`;
      } else if (r.sizeText) {
        label = r.sizeText;
      }
      if (r.color) label += `${label ? '・' : ''}${r.color}`;
      return { label, qty: r.qty, bodyUnit: unit };
    });
  }

  /* ---------- 通常加工モードの合計 ---------- */
  function calcNormal() {
    const opt = { express: el('opt-express').checked };
    const body = currentBody(); // {name, unit(税抜), quoteOnly}
    const groups = currentGroups(body);
    const qty = groups.reduce((s, g) => s + g.qty, 0);
    const lines = rows.map((r) => calcRow(r, qty, opt));

    // サイトのsimulate.jsと同じく「箇所ごとに税込へ切り上げ→合算」で1枚単価を作る
    // (税抜合算→税込だと内訳の見た目と1円ずれることがある)
    const printUnitTax = lines.reduce((s, l) => s + taxIn(l.unit), 0);
    const printUnitRaw = lines.reduce((s, l) => s + l.unit, 0);
    const initial = lines.reduce((s, l) => s + l.initial, 0);  // 税抜・初回

    // 割引。八木繊維様は卸価格自体が特別価格のため割引は適用しない
    const d = isYagi() ? { key: 'none', rate: 0, name: '割引なし' } : currentDiscount();
    let discountNote = '';
    groups.forEach((g) => {
      g.unitBefore = taxIn(g.bodyUnit) + printUnitTax;
      if (d.key === 'staff') {
        g.cost = Math.round(g.bodyUnit * 0.55); // 推定仕入値(税抜)
        g.unitAfter = taxIn(g.cost) + taxIn(Math.round(printUnitRaw * 0.5));
      } else if (d.rate > 0) {
        g.unitAfter = Math.ceil(g.unitBefore * (100 - d.rate) / 100);
      } else {
        g.unitAfter = g.unitBefore;
      }
    });
    if (d.key === 'staff') {
      discountNote = '社員特価: ボディ推定仕入値(表示価格×0.55・要実額確認)+加工賃50%OFF';
    } else if (d.rate > 0) {
      discountNote = `${d.name} ${d.rate}%OFF(1枚単価に適用・初期費用は対象外)`;
    }

    const bag = baggingUnit(); // 袋入れは割引対象外の実費(1枚あたり・税込)
    const shipping = shippingCost();
    const goods = groups.reduce((s, g) => s + g.unitAfter * g.qty, 0);
    const total = goods + (bag ? bag.unitTax * qty : 0) + taxIn(initial) + shipping;

    return {
      mode: isYagi() ? 'yagi' : 'normal', qty, body, lines, opt, groups,
      unitBefore: groups[0].unitBefore, unitAfter: groups[0].unitAfter,
      discount: d, discountNote, bag,
      initialTax: taxIn(initial), shipping, total,
      perPieceAll: Math.round(total / qty),
      // 卸表の「100枚以上は要相談」。概算は出すが目立つ警告を添える(2026-08-20社長判断)
      yagiOver100: isYagi() && qty >= 100,
    };
  }

  /* ---------- KRATVSモードの合計 ----------
     サイズ帯ごとに単価が違うため、帯ごとの枚数入力(kBandQty)から
     グループを作って合算する。プリント代は全帯共通の1枚あたり加算 */
  const kSelected = new Set(); // 選択中プリントの t
  let kBandQty = {};           // サイズ帯idx → 枚数
  function calcKratvs() {
    const item = window.QS_KRATVS.items[+el('k-item').value];
    const printList = item.kind === 'shorts' ? window.QS_KRATVS.printsShorts : window.QS_KRATVS.printsShirt;
    const picked = printList.filter((p) => kSelected.has(p.t));

    // セット自動判定(3点→2点の順で1回だけ適用)
    let setApplied = null;
    let rest = [...picked];
    for (const s of window.QS_KRATVS.sets.sort((a, b) => b.count - a.count)) {
      if (s.scope !== item.kind) continue;
      const names = rest.map((p) => p.t);
      if (!s.need.every((n) => names.includes(n))) continue;
      let anyPick = null;
      if (s.any) {
        anyPick = s.any.from.find((n) => names.includes(n));
        if (!anyPick) continue;
      }
      const used = [...s.need, ...(anyPick ? [anyPick] : [])];
      setApplied = { ...s, used };
      rest = rest.filter((p) => !used.includes(p.t));
      break;
    }
    const printTotal = (setApplied ? setApplied.p : 0) + rest.reduce((s, p) => s + p.p, 0);

    const d = currentDiscount('k');
    let discountNote = '';
    if (d.key === 'staff') discountNote = '社員特価(KRATVSは完成品価格のため一律50%OFFで計算)';
    else if (d.rate > 0) discountNote = `${d.name} ${d.rate}%OFF`;

    // サイズ帯ごとのグループ(枚数が入っている帯だけ)。すべて税込
    const groups = item.price
      .map((band, i) => ({ band, qty: kBandQty[i] || 0 }))
      .filter((b) => b.qty > 0)
      .map(({ band, qty }) => {
        const unitBefore = band.p + printTotal;
        let unitAfter = unitBefore;
        if (d.key === 'staff') unitAfter = Math.ceil(unitBefore * 0.5);
        else if (d.rate > 0) unitAfter = Math.ceil(unitBefore * (100 - d.rate) / 100);
        return { label: band.size, band, qty, unitBefore, unitAfter };
      });
    if (!groups.length) return null; // どの帯にも枚数が無い

    const qty = groups.reduce((s, g) => s + g.qty, 0);
    const bag = baggingUnit();
    const shipping = shippingCost();
    const total = groups.reduce((s, g) => s + g.unitAfter * g.qty, 0)
      + (bag ? bag.unitTax * qty : 0) + shipping;
    return {
      mode: 'kratvs', qty, item, groups, picked, setApplied, rest,
      unitBefore: groups[0].unitBefore, unitAfter: groups[0].unitAfter,
      discount: d, discountNote, bag, shipping,
      initialTax: 0, total,
      perPieceAll: Math.round(total / qty),
    };
  }

  /* ---------- 画面部品 ---------- */
  const el = (id) => document.getElementById(id);

  function currentBody() {
    const v = el('body-input').value.trim();
    const hit = window.QS_BODIES.find((b) => v.startsWith(b.sku) || v === `${b.sku} ${b.name}`);
    if (hit) return { name: `${hit.name}(${hit.sku})`, unit: hit.body, quoteOnly: hit.quote };
    const manual = parseInt(el('body-manual').value, 10);
    if (v && manual > 0) return { name: v, unit: Math.round(manual / (1 + TAX / 100)), manual: true };
    return { name: '(ボディなし・加工のみ)', unit: 0, none: true };
  }

  function currentDiscount(prefix) {
    const key = document.querySelector(`input[name="${prefix === 'k' ? 'k-discount' : 'discount'}"]:checked`).value;
    const d = window.QS_DISCOUNTS.find((x) => x.key === key);
    if (d.key === 'custom') {
      const r = Math.min(90, Math.max(0, parseInt(el(prefix === 'k' ? 'k-custom-rate' : 'custom-rate').value, 10) || 0));
      return { ...d, rate: r, name: `任意${r}%` };
    }
    return d;
  }

  function shippingCost() {
    const v = el('shipping').value;
    if (v === 's80') return taxIn(window.QS_COMMON.shipping.s80);
    if (v === 's100') return taxIn(window.QS_COMMON.shipping.s100);
    return 0;
  }

  /** 袋入れ(共通オプション)。1枚あたりの実費なので割引対象外 */
  function baggingUnit() {
    const v = el('bagging').value;
    if (v === 'tee') return { name: '袋入れ(Tシャツ)', unitTax: taxIn(window.QS_COMMON.bagging.tee) };
    if (v === 'sweat') return { name: '袋入れ(スウェット)', unitTax: taxIn(window.QS_COMMON.bagging.sweat) };
    return null;
  }

  /* ---------- サイズ・色別の内訳のUI ---------- */
  function addBreakdownRow(preset) {
    const data = bodySizeData();
    breakdown.push({
      id: ++bdSeq,
      variant: data ? data.base[0] : 0,
      band: data ? data.base[1] : 0,
      sizeText: '', color: '', qty: 0,
      ...(preset || {}),
    });
  }

  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  function renderBreakdown() {
    const wrap = el('breakdown');
    const data = bodySizeData();
    wrap.innerHTML = '';
    breakdown.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'qs-bd-row';
      let selects = '';
      if (data) {
        const vi = Math.min(r.variant, data.v.length - 1);
        const variant = data.v[vi];
        if (data.v.length > 1) {
          selects += `<select data-bf="variant" aria-label="色区分">${data.v.map((v, i) =>
            `<option value="${i}"${i === vi ? ' selected' : ''}>${v.l}</option>`).join('')}</select>`;
        }
        const bi = Math.min(r.band, variant.b.length - 1);
        selects += `<select data-bf="band" aria-label="サイズ帯">${variant.b.map((b, i) =>
          `<option value="${i}"${i === bi ? ' selected' : ''}>${b[0]}(税込${taxIn(b[1]).toLocaleString()}円)</option>`).join('')}</select>`;
      } else {
        selects += `<input type="text" data-bf="sizeText" value="${escAttr(r.sizeText)}" placeholder="サイズ(例: L)" aria-label="サイズ">`;
      }
      div.innerHTML = `
        ${selects}
        <input type="text" data-bf="color" value="${escAttr(r.color)}" placeholder="色(例: 白)" aria-label="色">
        <input type="number" data-bf="qty" min="0" value="${r.qty || ''}" placeholder="枚数" aria-label="枚数">
        <button type="button" class="btn-icon-remove" data-bd-del="${r.id}" aria-label="この内訳行を削除">✕</button>`;
      wrap.appendChild(div);
      div.querySelectorAll('[data-bf]').forEach((input) => {
        const f = input.dataset.bf;
        input.onchange = () => {
          if (f === 'qty') { r.qty = Math.max(0, parseInt(input.value, 10) || 0); syncQtyInput(); }
          else if (f === 'variant' || f === 'band') {
            r[f] = +input.value;
            if (f === 'variant') { r.band = 0; renderBreakdown(); }
          } else r[f] = input.value.trim();
          recalc();
        };
      });
      div.querySelector('[data-bd-del]').onclick = () => {
        const idx = breakdown.findIndex((x) => x.id === r.id);
        if (idx >= 0) breakdown.splice(idx, 1);
        renderBreakdown(); recalc();
      };
    });
    syncQtyInput();
  }

  /** 内訳が入っている間は総数入力を自動集計(読み取り専用)にする */
  function syncQtyInput() {
    const sum = breakdown.reduce((s, r) => s + r.qty, 0);
    const active = breakdown.length > 0;
    el('qty').readOnly = active;
    if (active) el('qty').value = sum;
    el('qty-note').hidden = !active;
  }

  /* ---------- 加工行のUI ---------- */
  function renderRows() {
    const wrap = el('rows');
    wrap.innerHTML = '';
    rows.forEach((row, i) => {
      const div = document.createElement('div');
      div.className = 'qs-row';
      div.innerHTML = `
        <div class="qs-row-head">
          <span class="qs-row-no">加工 ${i + 1}</span>
          <button type="button" class="btn-icon-remove" data-del="${row.id}" aria-label="この加工を削除">✕</button>
        </div>
        <div class="qs-row-body" data-id="${row.id}"></div>`;
      wrap.appendChild(div);
      renderRowBody(row);
    });
    document.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = () => {
        const idx = rows.findIndex((r) => r.id === +b.dataset.del);
        if (idx >= 0) rows.splice(idx, 1);
        renderRows(); recalc();
      };
    });
  }

  function renderRowBody(row) {
    const box = document.querySelector(`.qs-row-body[data-id="${row.id}"]`);
    const sel = (v, t) => `<option value="${v}"${String(row.method) === v ? ' selected' : ''}>${t}</option>`;
    // 八木繊維様の卸表に無い加工(マーキング・刺繍系)は選択肢から外す=個別見積り
    const extraMethods = isYagi() ? ''
      : `${sel('marking', 'マーキング')}${sel('emb', '刺繍')}${sel('cap', '帽子刺繍')}${sel('nameEmb', 'ネーム刺繍(1.5×8cm)')}`;
    let html = `
      <label>加工方法
        <select data-f="method">
          ${sel('auto', '自動(シルク/DTFの安い方)')}${sel('silk', 'シルクスクリーン')}${sel('dtf', 'DTF(フルカラー)')}
          ${sel('rubber', 'ラバー転写')}${sel('dtfName', 'DTFネームプリント(登録業者)')}${extraMethods}
        </select>
      </label>`;
    if (['auto', 'silk', 'dtf', 'rubber'].includes(row.method)) {
      const sizes = row.method === 'rubber' ? SIZES_ALL.slice(1) : SIZES_ALL;
      html += `<label>大きさ
        <select data-f="size">${sizes.map((s) => `<option${s === row.size ? ' selected' : ''}>${s}</option>`).join('')}</select>
      </label>`;
      if (row.method !== 'dtf' && row.method !== 'rubber') {
        const maxColors = activeTables().silk.maxColors;
        const colorOpts = [];
        for (let c = 1; c <= maxColors; c++) colorOpts.push(c);
        html += `<label>色数
          <select data-f="colors">${colorOpts.map((c) => `<option value="${c}"${c === row.colors ? ' selected' : ''}>${c}色</option>`).join('')}
          <option value="full"${row.colors === 'full' ? ' selected' : ''}>フルカラー(DTF)</option></select>
        </label>`;
      }
    }
    if (row.method === 'marking') {
      html += `<label>種類
        <select data-f="markKey">${window.QS_MARKING.map((m) => `<option value="${m.key}"${m.key === row.markKey ? ' selected' : ''}>${m.name} ${m.size}</option>`).join('')}</select>
      </label>
      <div class="qs-note">${window.QS_MARKING_NOTE}</div>`;
    }
    if (row.method === 'emb' || row.method === 'cap') {
      const t = window.QS_EMB.normal;
      html += `<label>箇所数
        <select data-f="embPlaces">${Object.keys(t.rows).map((k) => `<option${k === row.embPlaces ? ' selected' : ''}>${k}</option>`).join('')}</select>
      </label>
      <label>加工時間
        <select data-f="embTime"><option${row.embTime === '〜15分' ? ' selected' : ''}>〜15分</option><option${row.embTime === '16〜30分' ? ' selected' : ''}>16〜30分</option></select>
      </label>`;
      if (row.method === 'emb') {
        html += `<label>大きさ
          <select data-f="embSize">${t.sizes.map((s, i) => `<option value="${i}"${i === row.embSize ? ' selected' : ''}>${s}</option>`).join('')}</select>
        </label>`;
      }
      html += `<label class="qs-check"><input type="checkbox" data-patch${row.patch ? ' checked' : ''}>
        ワッペン用資材一式(+税込${taxIn(window.QS_EMB.patch).toLocaleString()}円/枚)</label>`;
    }
    // 割増オプション(方法に関係するものだけ表示)
    const nylonSheets = ['sheetNylon', 'sheetNylonGold', 'sheetNylonRef'];
    const colorSheets = ['sheetMetallic', 'sheetPearl', 'sheetPearlNeon', 'sheetReflex', 'sheetSilver', 'sheet3M', 'sheetGlow'];
    let surKeys = {
      auto: ['special', 'colorChange', 'bring'], silk: ['special', 'specialInk', 'overlay', 'colorChange', 'bring'],
      dtf: ['special', 'blousonS', 'blousonL', 'bring'],
      rubber: ['special', 'blousonS', 'blousonL', 'bring', ...nylonSheets, ...colorSheets],
      marking: ['special', 'blousonS', 'blousonL', 'bring', ...nylonSheets, ...colorSheets],
      emb: ['embThread', 'embFabric', 'emb3D', 'bring'], cap: ['embThread', 'emb3D', 'bring'],
      nameEmb: ['bring'], dtfName: ['bring'],
    }[row.method] || [];
    // 八木繊維様は持込料サービスなので選択肢ごと出さない
    if (activeTables().bringFree) surKeys = surKeys.filter((k) => k !== 'bring');
    if (surKeys.length) {
      html += `<div class="qs-surcharges">${surKeys.map((k) => `
        <label class="qs-check"><input type="checkbox" data-sur="${k}"${row.surcharges.has(k) ? ' checked' : ''}>
        ${window.QS_SURCHARGE[k].name}(${Math.round((surRate(k) - 1) * 100)}%増)</label>`).join('')}</div>`;
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-f]').forEach((input) => {
      input.onchange = () => {
        const f = input.dataset.f;
        row[f] = (f === 'colors') ? (input.value === 'full' ? 'full' : +input.value)
          : (f === 'embSize') ? +input.value : input.value;
        if (f === 'method') {
          if (row.method === 'rubber' && row.size === 'B8') row.size = 'B7';
          renderRowBody(row);
        }
        recalc();
      };
    });
    box.querySelectorAll('[data-sur]').forEach((cb) => {
      cb.onchange = () => {
        cb.checked ? row.surcharges.add(cb.dataset.sur) : row.surcharges.delete(cb.dataset.sur);
        recalc();
      };
    });
    const patchCb = box.querySelector('[data-patch]');
    if (patchCb) patchCb.onchange = () => { row.patch = patchCb.checked; recalc(); };
  }

  /* ---------- 結果表示 ---------- */
  let lastResult = null;

  function recalc() {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const r = mode === 'kratvs' ? calcKratvs() : calcNormal();
    lastResult = r;
    renderResult(r);
    // 割引の有無で承認欄の出し入れが変わる。転記シートもここで作り直す
    syncApproval();
  }

  function renderResult(r) {
    const box = el('result');
    if (!r) {
      box.innerHTML = `<p class="empty-notice">サイズ帯ごとの枚数を入力してください。</p>`;
      return;
    }
    if (r.mode !== 'kratvs' && r.body.quoteOnly) {
      box.innerHTML = `<p class="empty-notice">このボディ(中綿・ナイロン等)は概算対象外です。個別見積りにしてください。</p>`;
      return;
    }
    const multi = r.groups.length > 1;
    let rowsHtml = '';
    if (r.mode !== 'kratvs') {
      r.groups.forEach((g) => {
        rowsHtml += `<tr><td>ボディ ${r.body.name}${g.label ? `【${g.label}】` : ''}${multi ? ` × ${g.qty}枚` : ''}</td><td class="qs-num">${yen(taxIn(g.bodyUnit))}</td></tr>`;
      });
      r.lines.forEach((l) => {
        rowsHtml += `<tr><td>${l.label}${l.note ? `<div class="qs-note">${l.note}</div>` : ''}</td><td class="qs-num">${yen(taxIn(l.unit))}</td></tr>`;
        if (l.initial) rowsHtml += `<tr class="qs-initial"><td>└ ${l.initialLabel}</td><td class="qs-num">${yen(taxIn(l.initial))}</td></tr>`;
      });
    } else {
      r.groups.forEach((g) => {
        rowsHtml += `<tr><td>${r.item.name}(${g.label})${multi ? ` × ${g.qty}枚` : ''}</td><td class="qs-num">${yen(g.band.p)}</td></tr>`;
      });
      if (r.setApplied) rowsHtml += `<tr><td>${r.setApplied.t}(${r.setApplied.used.join('+')})</td><td class="qs-num">${yen(r.setApplied.p)}</td></tr>`;
      r.rest.forEach((p) => { rowsHtml += `<tr><td>${p.t}(${p.size})</td><td class="qs-num">${yen(p.p)}</td></tr>`; });
    }
    if (r.bag) rowsHtml += `<tr><td>${r.bag.name}(割引対象外)</td><td class="qs-num">${yen(r.bag.unitTax)}</td></tr>`;
    const discountRow = r.discountNote
      ? `<tr class="qs-discount"><td>${r.discountNote}</td><td class="qs-num">${multi ? '下記参照' : `${yen(r.unitAfter)}/枚`}</td></tr>` : '';

    // 1枚あたり。内訳があるときはグループごとに並べる
    const unitHtml = multi
      ? `<div><span>1枚あたり(割引後)</span><span class="qs-unit-lines">${r.groups.map((g) =>
          `<span class="qs-unit-line">${g.label || '標準'} × ${g.qty}枚: <b>${yen(g.unitAfter)}</b>${g.unitAfter !== g.unitBefore ? `<s>${yen(g.unitBefore)}</s>` : ''}</span>`).join('')}</span></div>`
      : `<div>1枚あたり(割引後)<b>${yen(r.unitAfter)}</b>${r.discount.rate > 0 || r.discount.key === 'staff' ? `<s>${yen(r.unitBefore)}</s>` : ''}</div>`;

    // 原価・粗利(トグル)。内訳があるときはグループごとの推定仕入で合算する
    let costHtml = '';
    if (el('toggle-cost').checked && r.mode !== 'kratvs' && r.groups.some((g) => g.bodyUnit > 0)) {
      const costTax = r.groups.reduce((s, g) => s + taxIn(Math.round(g.bodyUnit * 0.55)) * g.qty, 0);
      const profit = r.total - costTax - r.shipping - (r.bag ? r.bag.unitTax * r.qty : 0);
      costHtml = `<div class="qs-cost">
        <b>原価めやす(社外秘)</b> ボディ推定仕入 合計${yen(costTax)}(表示価格×0.55・要実額確認)
        → 粗利 ${yen(profit)}(${Math.round(profit / r.total * 100)}%)※加工材料費・人件費は含まず</div>`;
    }

    box.innerHTML = `
      <table class="qs-table"><tbody>${rowsHtml}${discountRow}</tbody></table>
      <div class="qs-summary">
        ${unitHtml}
        ${r.initialTax ? `<div>初期費用(割引対象外)<b>${yen(r.initialTax)}</b></div>` : ''}
        ${r.bag ? `<div>${r.bag.name}<b>${yen(r.bag.unitTax)}/枚</b></div>` : ''}
        ${r.shipping ? `<div>送料<b>${yen(r.shipping)}</b></div>` : ''}
        <div class="qs-total">合計(${r.qty}枚・税込)<b>${yen(r.total)}</b><span>実質 ${yen(r.perPieceAll)}/枚</span></div>
      </div>
      ${costHtml}
      ${r.yagiOver100 ? '<div class="qs-over100">⚠️ 100枚以上は「要相談」です(八木繊維様専用価格表)。この概算は目安として使い、正式には個別にお見積りしてください。</div>' : ''}
      ${r.mode === 'yagi'
        ? '<p class="qs-note">八木繊維様専用価格表(2026-05-01改定)に基づく税込の概算です。ミニマム手数料なし・持込料サービス・版下データ作成料0円を適用しています。</p>'
        : '<p class="qs-note">金額はすべて税込の概算です。10枚未満はミニマム手数料(加工代5割増)を自動適用しています。</p>'}`;
  }

  /* ---------- freee転記シート ----------
     三浦さん・山本さんは画面を見ながらfreeeへ手入力する。
     久保田さんは同じテキストをClaudeに貼れば /mitsumori で自動入力できる。
     ★人が読める形と機械が読める形を1つの出力で兼ねる(2026-08-20 社長方針) */
  function buildSheet() {
    const r = lastResult;
    if (!r) return null;
    const title = el('item-title').value.trim() || 'オリジナルウェア';
    const customer = el('customer').value.trim();
    const lines = [];

    // 内訳(サイズ・色)があるときはグループごとに明細を分ける(単価が違うため)
    if (r.mode !== 'kratvs') {
      const parts = r.lines.map((l) => l.label).join('・');
      r.groups.forEach((g) => {
        let desc = `${title}(${parts})`;
        if (g.label) desc += `【${g.label}】`;
        if (r.discount.rate > 0) desc += `　通常価格 ${g.unitBefore.toLocaleString()}円 → 特別割引 ${r.discount.rate}%OFF`;
        if (r.discount.key === 'staff') desc += '　社員特価';
        lines.push({ desc, qty: g.qty, unit: '枚', price: g.unitAfter });
      });
      r.lines.forEach((l) => {
        if (l.initial) lines.push({ desc: `${l.initialLabel}(${l.label})`, qty: 1, unit: '式', price: taxIn(l.initial) });
      });
    } else {
      const prints = [...(r.setApplied ? r.setApplied.used : []), ...r.rest.map((p) => p.t)];
      r.groups.forEach((g) => {
        let desc = `KRATVSカスタムオーダー ${r.item.name}(${g.label})`;
        if (prints.length) desc += `＋${prints.join('・')}`;
        if (r.discount.rate > 0) desc += `　通常価格 ${g.unitBefore.toLocaleString()}円 → 特別割引 ${r.discount.rate}%OFF`;
        if (r.discount.key === 'staff') desc += '　社員特価';
        lines.push({ desc, qty: g.qty, unit: '枚', price: g.unitAfter });
      });
    }
    if (r.bag) lines.push({ desc: `${r.bag.name}`, qty: r.qty, unit: '枚', price: r.bag.unitTax });
    if (r.shipping) lines.push({ desc: '送料', qty: 1, unit: '式', price: r.shipping });

    const today = new Date();
    const iso = (d) => d.toLocaleDateString('sv-SE');
    const due = new Date(today.getTime() + 30 * 86400000);
    const taxOut = Math.round(r.total / (1 + TAX / 100));

    const notes = ['※表示金額はすべて税込です。'];
    if (r.mode === 'yagi') {
      notes.push('※八木繊維様専用価格表(2026年5月1日改定)に基づく金額です。');
      if (r.yagiOver100) notes.push('※100枚以上のため要相談です。本見積は目安としてご利用ください。');
    } else {
      notes.push('※納期はデザイン最終確認・ご入金の確認から約2週間です。');
      notes.push('※当社工場でのお受け取りは無料です。ご配送をご希望の場合は別途承ります。');
    }

    return {
      customer, title, qty: r.qty, lines,
      date: iso(today), due: iso(due),
      total: r.total, taxOut, tax: r.total - taxOut,
      notes,
      discount: r.discount,
    };
  }

  /** 転記シートの文字列。この形のままClaudeが読めるので書式を崩さないこと */
  function sheetText(sh) {
    const L = [];
    L.push('【freee見積書 転記シート】');
    L.push(`取引先  : ${sh.customer || '(未入力)'}`);
    L.push(`件名    : ${sh.title} ${sh.qty}枚`);
    L.push(`見積日  : ${sh.date}　有効期限: ${sh.due}`);
    L.push('税区分  : 内税(単価は税込)　★freeeの初期値は外税なので必ず切り替える');
    L.push('─ 明細 ─');
    sh.lines.forEach((l, i) => {
      L.push(`${i + 1}) ${l.desc}`);
      L.push(`   数量 ${l.qty} ${l.unit} ／ 単価 ${l.price.toLocaleString()}円 → ${(l.price * l.qty).toLocaleString()}円`);
    });
    L.push('─ 合計 ─');
    L.push(`${sh.total.toLocaleString()}円（小計 ${sh.taxOut.toLocaleString()}円 ＋ 消費税 ${sh.tax.toLocaleString()}円）`);
    L.push('─ 備考 ─');
    sh.notes.forEach((n) => L.push(n));
    return L.join('\n');
  }

  /** 画面に出す転記シート(見ながらfreeeへ入力してもらう) */
  function renderSheet() {
    const sh = buildSheet();
    const box = el('sheet');
    if (!sh) { box.textContent = ''; return; }
    box.textContent = sheetText(sh);
  }

  el('btn-copy-freee').onclick = () => {
    const sh = buildSheet();
    if (!sh) { HiUI.toast('先に見積内容を入力してください'); return; }
    if (!approvalOk(sh)) return;
    copyText(sheetText(sh));
  };

  /* クリップボードへコピー。本番はLAN内のhttp(非secure context)なので
     navigator.clipboard が使えない。execCommandへフォールバックする */
  function copyText(text) {
    const done = () => HiUI.toast('転記シートをコピーしました。freeeに入力してください');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done));
      return;
    }
    legacyCopy(text, done);
  }
  function legacyCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* 下のフォールバックへ */ }
    ta.remove();
    if (ok) { done(); return; }
    // 最終手段: 選択済みのテキストを見せて手動コピーしてもらう
    window.prompt('自動コピーできませんでした。全選択してコピーしてください', text);
  }

  /* ---------- 割引の社長承認ゲート ----------
     値付けは社長の判断領域。割引を適用した見積は、承認チェックと
     承認者名(誰に確認したか)が入るまでコピー・転記シート出力をさせない。
     ★歯止めは運用ルールではなく画面で担保する(2026-08-20 社長指示) */
  function isDiscounted() {
    const d = currentDiscountForMode();
    return d.key === 'staff' || d.rate > 0;
  }
  function currentDiscountForMode() {
    const mode = currentMode();
    if (mode === 'yagi') return { key: 'none', rate: 0, name: '割引なし' };
    return currentDiscount(mode === 'kratvs' ? 'k' : '');
  }
  function syncApproval() {
    const on = isDiscounted();
    el('approval-box').hidden = !on;
    if (!on) { el('approval-check').checked = false; el('approval-by').value = ''; }
    renderSheet();
  }
  function approvalOk() {
    if (!isDiscounted()) return true;
    if (!el('approval-check').checked) {
      HiUI.toast('割引を適用した見積です。社長の承認チェックを入れてください');
      el('approval-box').scrollIntoView({ block: 'center' });
      return false;
    }
    if (!el('approval-by').value.trim()) {
      HiUI.toast('承認を受けた方のお名前を入力してください');
      el('approval-by').focus();
      return false;
    }
    return true;
  }

  /* ---------- 案件(HiBoard)との連携 ----------
     /quote-sim?case=123 で開くと、案件の取引先名・品名・枚数・プリント箇所
     (箇所数と色数)を自動でセットする。ボディ品番と加工サイズは案件が
     持っていないので人が選ぶ。概算は「案件に記録」で case_quotes へ残し、
     freeeで発行した見積書URLは projects.freee_quote_url へ紐づける */
  let linkedCase = null;

  // 箇所名から加工サイズの初期値を推定する(あくまで初期値。画面で直せる)
  function guessSize(name) {
    const n = String(name || '');
    if (/左胸|胸ポケ|袖|腰/.test(n)) return 'B8';
    if (/背|バック/.test(n)) return 'A3';
    return 'A4';
  }

  async function loadCase(caseId) {
    let data;
    try {
      const resp = await fetch(`/api/projects/${caseId}/quote-context`);
      if (!resp.ok) throw new Error(String(resp.status));
      data = await resp.json();
    } catch (_) {
      HiUI.toast('案件の読み込みに失敗しました。案件と紐づけずに開きます');
      return;
    }
    linkedCase = data.project;
    el('customer').value = linkedCase.customer_name || '';
    el('item-title').value = linkedCase.item_name || linkedCase.project_name || '';
    const q = parseInt(linkedCase.quantity, 10);
    if (q > 0) el('qty').value = q;

    // プリント箇所 → 加工行。既定の1行を置き換える
    if (data.print_locations.length) {
      rows.length = 0;
      data.print_locations.forEach((loc) => {
        newRow();
        const row = rows[rows.length - 1];
        row.size = guessSize(loc.location_name);
        const c = parseInt(loc.color_count, 10);
        row.colors = (c >= 1 && c <= window.QS_SILK.maxColors) ? c : 'full';
      });
      renderRows();
    }

    // バッジと連携ブロックを表示
    showLinkedCase();
    recalc();
  }

  /** 紐づけ済み案件のバッジ・連携ブロックの出し入れ(loadCase/紐づけのみ の両方から使う) */
  function showLinkedCase() {
    el('case-badge').hidden = false;
    el('case-badge-name').textContent =
      `${linkedCase.customer_name || ''}様「${linkedCase.item_name || linkedCase.project_name}」(案件ID: ${linkedCase.id})`;
    el('case-actions').hidden = false;
    el('case-link').hidden = true;
    if (linkedCase.freee_quote_url) el('freee-url').value = linkedCase.freee_quote_url;
  }

  /* ---------- 案件を検索して紐づける ----------
     案件から開かなくても、あとから案件を選べばfreee発行時のURL・概算の
     自動保存(case_id連携)が効くようにする。「読み込む」を選ぶと従来の
     loadCase と同じく画面へ内容を反映し、「紐づけのみ」は入力を変えない */
  async function searchCases() {
    const q = el('case-search').value.trim();
    const note = el('case-search-note');
    const sel = el('case-search-select');
    if (!q) { note.textContent = '顧客名・案件名・品名の一部を入力して検索してください。'; return; }
    note.textContent = '検索中...';
    sel.hidden = true; el('btn-link-case').hidden = true;
    try {
      const resp = await fetch(`/api/projects/quote-search?q=${encodeURIComponent(q)}`);
      if (!resp.ok) throw new Error(String(resp.status));
      const list = await resp.json();
      if (!list.length) { note.textContent = '該当する案件がありません。'; return; }
      sel.innerHTML = list.map((p) => `<option value="${p.id}">#${p.id} ${p.customer_name || ''}様 ${p.item_name || p.project_name || ''}(${p.quantity || '?'}枚・${p.status || ''})</option>`).join('');
      sel.hidden = false;
      el('btn-link-case').hidden = false;
      note.textContent = `${list.length}件見つかりました。案件を選んで「この案件と紐づける」を押してください。`;
    } catch (_) {
      note.textContent = '検索に失敗しました。時間をおいて試してください。';
    }
  }

  el('case-search-btn').onclick = searchCases;
  el('case-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); searchCases(); }
  });
  el('btn-link-case').onclick = async () => {
    const id = parseInt(el('case-search-select').value, 10);
    if (!id) { HiUI.toast('案件を選んでください'); return; }
    // confirmは「入力済みの内容を上書きするか」の確認。キャンセル=紐づけのみ
    if (window.confirm('案件の内容(顧客名・品名・枚数・プリント箇所)を画面に読み込みますか?\n「キャンセル」でも紐づけは行われ、入力中の内容はそのまま残ります。')) {
      await loadCase(id);
      return;
    }
    try {
      const resp = await fetch(`/api/projects/${id}/quote-context`);
      if (!resp.ok) throw new Error(String(resp.status));
      const data = await resp.json();
      linkedCase = data.project;
      showLinkedCase();
      HiUI.toast('案件と紐づけました。freeeで発行すると見積書URLが自動で保存されます');
    } catch (_) {
      HiUI.toast('案件の読み込みに失敗しました');
    }
  };

  el('btn-save-quote').onclick = async () => {
    if (!linkedCase) return;
    const sh = buildSheet();
    if (!sh) { HiUI.toast('先に見積内容を入力してください'); return; }
    if (!approvalOk(sh)) return;
    const d = currentDiscountForMode();
    try {
      const resp = await fetch(`/api/projects/${linkedCase.id}/quotes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sheet_text: sheetText(sh),
          total: sh.total,
          discount_name: (d.key === 'none') ? null : d.name,
          approved_by: el('approval-by').value.trim() || null,
        }),
      });
      const result = await resp.json();
      if (!resp.ok || !result.ok) throw new Error(result.error || '保存に失敗しました');
      HiUI.toast('概算を案件に記録しました(案件詳細の「概算の履歴」から見返せます)');
    } catch (err) {
      HiUI.toast(`記録できませんでした: ${err.message}`);
    }
  };

  el('btn-save-freee-url').onclick = async () => {
    if (!linkedCase) return;
    try {
      const resp = await fetch(`/api/projects/${linkedCase.id}/freee-quote-url`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: el('freee-url').value }),
      });
      const result = await resp.json();
      if (!resp.ok || !result.ok) throw new Error(result.error || '保存に失敗しました');
      HiUI.toast(el('freee-url').value.trim()
        ? '見積書URLを案件に紐づけました(顧客台帳・納品履歴から開けます)'
        : '見積書URLをクリアしました');
    } catch (err) {
      HiUI.toast(`保存できませんでした: ${err.message}`);
    }
  };

  /* ---------- freeeへの見積書発行 ----------
     ★freeeのAPIには「下書き」が無く、発行した時点で見積書番号が採番される。
     取り消しはできても番号は戻らないので、内容の確認は必ず発行前(モーダル)で行う。
     freeeが未連携・障害中でも、転記シートの手入力に切り替えられるようにしておく */
  let freeePartners = [];
  let freeeState = 'unknown';

  async function loadFreeeStatus() {
    const note = el('freee-status-note');
    try {
      const resp = await fetch('/api/freee/status');
      const st = await resp.json();
      freeeState = st.state;
      if (st.state === 'ready') { note.hidden = true; return; }
      note.hidden = false;
      note.textContent = st.state === 'unconfigured'
        ? '⚠️ freee連携が未設定です。転記シートをコピーして手入力してください(設定は社長へ)。'
        : '⚠️ freeeと未連携です。「freeeに見積書を作成」を押すと連携をご案内します。';
    } catch (_) {
      note.hidden = true; // 状態が取れないだけなら黙って通す(発行時に改めて出る)
    }
  }

  /** 未連携のときの案内。認可はfreeeの画面で行う(パスワードはHiBoardに入力しない) */
  function askFreeeAuth(message) {
    HiUI.toast(message || 'freeeとの連携が必要です');
    if (window.confirm('freeeとの連携が必要です。freeeの認可画面を開きますか?')) {
      window.open('/api/freee/authorize', '_blank');
    }
  }

  el('btn-create-freee').onclick = async () => {
    const sh = buildSheet();
    if (!sh) { HiUI.toast('先に見積内容を入力してください'); return; }
    if (!approvalOk(sh)) return;
    if (!sh.customer) { HiUI.toast('取引先名を入力してください'); return; }

    // 連携できない状態でモーダルを開いても何もできない。手入力へ案内して止める
    await loadFreeeStatus();
    if (freeeState === 'unconfigured') {
      HiUI.toast('freee連携が未設定です。転記シートをコピーして手入力してください');
      return;
    }
    if (freeeState === 'unauthorized') { askFreeeAuth(); return; }

    el('freee-preview').textContent = sheetText(sh);
    el('freee-partner-search').value = sh.customer;
    el('freee-display-name').value = sh.customer;
    el('freee-partner-select').innerHTML = '';
    el('freee-partner-note').textContent = '';
    el('freee-modal').style.display = 'flex';
    await searchFreeePartners(sh.customer);
  };

  async function searchFreeePartners(keyword) {
    const note = el('freee-partner-note');
    const sel = el('freee-partner-select');
    note.textContent = '検索中...';
    sel.innerHTML = '';
    try {
      const resp = await fetch(`/api/freee/partners?keyword=${encodeURIComponent(keyword)}`);
      const data = await resp.json();
      if (!data.ok) {
        // ここでは確認ダイアログを出さない(発行ボタン側で案内済み。二重に出すとうるさい)
        note.textContent = data.error || '取引先を取得できませんでした';
        return;
      }
      freeePartners = data.partners || [];
      if (!freeePartners.length) {
        note.textContent = '該当する取引先がありません。別の名前で検索するか、freeeで取引先を登録してください。';
        return;
      }
      freeePartners.forEach((p) => {
        const o = document.createElement('option');
        o.value = String(p.id);
        o.textContent = p.name;
        sel.appendChild(o);
      });
      // 前に選んだ取引先を覚えていればそれを初期選択にする
      const linkedId = data.linked && data.linked.partner_id;
      const preselect = linkedId && freeePartners.some((p) => p.id === linkedId) ? linkedId : freeePartners[0].id;
      sel.value = String(preselect);
      note.textContent = linkedId
        ? '前回この顧客で選んだ取引先を選択しています。'
        : `${freeePartners.length}件見つかりました。発行先を選んでください。`;
      if (data.linked && data.linked.display_name) el('freee-display-name').value = data.linked.display_name;
    } catch (err) {
      note.textContent = `取引先を取得できませんでした: ${err.message}`;
    }
  }

  el('freee-partner-search-btn').onclick = () => {
    searchFreeePartners(el('freee-partner-search').value.trim());
  };

  function closeFreeeModal() { el('freee-modal').style.display = 'none'; }

  /** 発行した見積書へのリンクを画面に残す(案件と紐づいていなくても辿れるように) */
  function showIssuedLink(q, blocked) {
    const box = el('freee-issued');
    box.hidden = false;
    box.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = blocked
      ? `✅ 見積書 No. ${q.quotation_number} を発行しました(タブが開けませんでした): `
      : `✅ 見積書 No. ${q.quotation_number} を発行しました: `;
    const a = document.createElement('a');
    a.href = q.report_url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'freeeで開く';
    box.append(label, a);
  }
  el('freee-modal-close').onclick = closeFreeeModal;
  el('freee-cancel').onclick = closeFreeeModal;

  el('freee-submit').onclick = async () => {
    const sh = buildSheet();
    if (!sh) { HiUI.toast('見積内容を読み直せませんでした'); return; }
    const partnerId = parseInt(el('freee-partner-select').value, 10);
    const partner = freeePartners.find((p) => p.id === partnerId);
    if (!partner) { HiUI.toast('freeeの取引先を選んでください'); return; }

    const btn = el('freee-submit');
    btn.disabled = true;
    btn.textContent = '発行中...';
    try {
      const d = currentDiscountForMode();
      const resp = await fetch('/api/freee/quotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sheet: sh,
          partner: { id: partner.id, name: partner.name, display_name: el('freee-display-name').value.trim() || null },
          case_id: linkedCase ? linkedCase.id : null,
          sheet_text: sheetText(sh),
          discount_name: (d.key === 'none') ? null : d.name,
          approved_by: el('approval-by').value.trim() || null,
        }),
      });
      const data = await resp.json();
      if (!data.ok) {
        if (data.need_auth) askFreeeAuth(data.error);
        else HiUI.toast(`発行できませんでした: ${data.error}`);
        return;
      }
      closeFreeeModal();
      const q = data.quotation;
      HiUI.toast(data.warning || `見積書を発行しました(No. ${q.quotation_number})`);
      if (q.report_url) {
        el('freee-url').value = q.report_url;
        // ★window.open は await のあとなのでポップアップブロックされることがある。
        //   開けなかったときのために、画面にもリンクを残す(案件未紐づけだと
        //   #freee-url は hidden の中にあり、URLがどこにも見えなくなるため)
        const opened = window.open(q.report_url, '_blank');
        showIssuedLink(q, !opened);
      }
    } catch (err) {
      // ★ここに来ても発行済みの可能性がある(送信後に通信が切れた等)。
      //   「もう一度押す」と二重発行になるので、必ずfreeeの確認を促す
      HiUI.toast(`発行の結果を確認できませんでした: ${err.message}。`
        + 'freeeの見積書一覧を確認してください(出来ていたら押し直さないでください)');
    } finally {
      btn.disabled = false;
      btn.textContent = 'この内容で発行する';
    }
  };

  /* ---------- 初期化 ---------- */
  function setupBodyList() {
    const dl = el('body-list');
    window.QS_BODIES.forEach((b) => {
      const o = document.createElement('option');
      o.value = `${b.sku} ${b.name}`;
      o.label = `${b.cat} / 税込${taxIn(b.body).toLocaleString()}円${b.quote ? '(個別見積り)' : ''}`;
      dl.appendChild(o);
    });
  }

  function setupKratvs() {
    const k = window.QS_KRATVS;
    el('k-item').innerHTML = k.items.map((it, i) => `<option value="${i}">${it.code} ${it.name}</option>`).join('');
    const syncSizes = () => {
      const it = k.items[+el('k-item').value];
      // サイズ帯ごとの枚数入力。単価が帯で違うため、総数ではなく帯別に入れてもらう
      el('k-bands').innerHTML = it.price.map((p, i) => `
        <label class="qs-kband">${p.size}(${p.p.toLocaleString()}円)
        <input type="number" min="0" data-kb="${i}" value="${kBandQty[i] || ''}" placeholder="0"></label>`).join('');
      el('k-bands').querySelectorAll('[data-kb]').forEach((inp) => {
        inp.oninput = () => { kBandQty[+inp.dataset.kb] = Math.max(0, parseInt(inp.value, 10) || 0); recalc(); };
      });
      const list = it.kind === 'shorts' ? k.printsShorts : k.printsShirt;
      el('k-prints').innerHTML = list.map((p) => `
        <label class="qs-check"><input type="checkbox" data-kp="${p.t}"${kSelected.has(p.t) ? ' checked' : ''}>
        ${p.t}(${p.size})+${p.p.toLocaleString()}円</label>`).join('');
      el('k-prints').querySelectorAll('[data-kp]').forEach((cb) => {
        cb.onchange = () => { cb.checked ? kSelected.add(cb.dataset.kp) : kSelected.delete(cb.dataset.kp); recalc(); };
      });
    };
    // 帯を選ぶ前でも概算が出るよう、最初の帯に既定の15枚を入れておく(従来の初期値と同じ)
    kBandQty = { 0: 15 };
    el('k-item').onchange = () => { kSelected.clear(); kBandQty = { 0: 15 }; syncSizes(); recalc(); };
    syncSizes();
  }

  function setupDiscounts(name, boxId, customId) {
    el(boxId).innerHTML = window.QS_DISCOUNTS.map((d, i) => `
      <label class="qs-check qs-discount-opt"><input type="radio" name="${name}" value="${d.key}"${i === 0 ? ' checked' : ''}>
      ${d.name}${d.rate > 0 ? `(${d.rate}%)` : ''}</label>`).join('') +
      `<input type="number" id="${customId}" min="0" max="90" value="15" aria-label="任意の割引率(%)" class="qs-custom-rate">%`;
    document.querySelectorAll(`input[name="${name}"]`).forEach((r) => { r.onchange = recalc; });
    el(customId).oninput = recalc;
  }

  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.onchange = () => {
      if (!r.checked) return;
      const mode = r.value;
      // 通常加工と八木繊維様は同じフォーム(panel-normal)を共有する
      el('panel-normal').hidden = mode === 'kratvs';
      el('panel-kratvs').hidden = mode !== 'kratvs';
      // 割引ブロックは八木繊維様では出さない(卸価格自体が特別価格)
      el('discount-block').hidden = mode === 'yagi';
      if (mode === 'yagi') {
        // 卸表に無い加工・色数の行はDTF系へ寄せる(選択肢からも消えるため)
        rows.forEach((row) => {
          if (['marking', 'emb', 'cap', 'nameEmb'].includes(row.method)) row.method = 'auto';
          if (row.colors !== 'full' && row.colors > window.QS_YAGI.silk.maxColors) row.colors = 'full';
        });
        if (!el('customer').value.trim()) el('customer').value = '八木繊維';
      }
      renderRows();
      recalc();
    };
  });

  ['qty', 'body-input', 'body-manual', 'shipping', 'customer', 'item-title'].forEach((id) => {
    el(id).addEventListener('input', recalc);
  });
  el('bagging').onchange = recalc;
  el('opt-express').onchange = recalc;
  el('toggle-cost').onchange = recalc;
  el('btn-add-row').onclick = () => { newRow(); renderRows(); recalc(); };
  el('btn-add-bd').onclick = () => { addBreakdownRow(); renderBreakdown(); recalc(); };

  // ボディの品番が変わったら内訳のサイズ帯・色区分の選択肢を作り直す
  let lastBdSku = null;
  el('body-input').addEventListener('input', () => {
    const sku = currentSku();
    if (sku !== lastBdSku) { lastBdSku = sku; renderBreakdown(); }
  });

  setupBodyList();
  setupKratvs();
  setupDiscounts('discount', 'discounts', 'custom-rate');
  setupDiscounts('k-discount', 'k-discounts', 'k-custom-rate');
  newRow();
  renderRows();
  renderBreakdown();
  recalc();

  loadFreeeStatus();

  const caseId = new URLSearchParams(location.search).get('case');
  if (caseId && /^\d+$/.test(caseId)) loadCase(caseId);
})();
