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

  /* ---------- 加工行の定義 ---------- */
  // method: auto(シルク/DTF安い方) / silk / dtf / rubber / marking / emb / cap
  let rowSeq = 0;
  const rows = []; // {id, method, size, colors, markKey, embPlaces, embTime, embSize, surcharges:Set}

  function newRow() {
    rows.push({
      id: ++rowSeq, method: 'auto', size: 'A4', colors: 1, markKey: 'num_l',
      embPlaces: '1〜2箇所', embTime: '〜15分', embSize: 0, surcharges: new Set(),
    });
  }

  /* ---------- 1行ぶんの単価計算(税抜) ----------
     返り値 {label, unit, initial, initialLabel, note} */
  function calcRow(row, qty, opt) {
    const sur = [...row.surcharges].reduce((m, k) => m * window.QS_SURCHARGE[k].rate, 1);
    const minFee = qty < 10 ? window.QS_COMMON.minFeeRate : 1;
    const expr = opt.express ? 1.5 : 1;
    const mul = (u) => Math.round(u * sur * minFee * expr);

    if (row.method === 'marking') {
      const m = window.QS_MARKING.find((x) => x.key === row.markKey);
      return { label: `マーキング ${m.name}(${m.size})`, unit: mul(m.p), initial: 0, note: '' };
    }
    if (row.method === 'emb' || row.method === 'cap') {
      const isCap = row.method === 'cap';
      const t = isCap ? window.QS_EMB.cap : window.QS_EMB.normal;
      const base = isCap
        ? t.rows[row.embPlaces][row.embTime]
        : t.rows[row.embPlaces][row.embTime][row.embSize];
      const punch = isCap ? t.punching : t.punching[row.embSize];
      const sizeName = isCap ? '100cm²以内' : window.QS_EMB.normal.sizes[row.embSize];
      return {
        label: `${isCap ? '帽子刺繍' : '刺繍'} ${row.embPlaces}・${row.embTime}・${sizeName}`,
        unit: mul(base), initial: punch, initialLabel: 'パンチング代(初回のみ)',
        note: '加工時間は刺繍データ完成後に確定(この金額は概算)',
      };
    }
    if (row.method === 'rubber') {
      const table = window.QS_RUBBER[row.size];
      if (!table) return { label: 'ラバー転写', unit: 0, initial: 0, note: 'B8はラバー転写の設定なし' };
      const u = table[tierOf(table, qty)];
      return { label: `ラバー転写 ${row.size}`, unit: mul(u), initial: 0, note: '' };
    }

    // シルク/DTF/自動
    const dtfUnit = window.QS_DTF[row.size][tierOf(window.QS_DTF[row.size], qty)];
    const silkTier = row.colors <= window.QS_SILK.maxColors
      ? tierOf(window.QS_SILK.print[row.colors], qty) : null;
    const silkUnit = silkTier !== null ? window.QS_SILK.print[row.colors][silkTier] : null;
    const plateOne = window.QS_SILK.plate[SMALL_PLATE.has(row.size) ? 'small' : 'large'];
    const silkPlate = plateOne * row.colors;

    const dtf = { label: `DTFプリント ${row.size}(フルカラー可)`, unit: mul(dtfUnit), initial: 0, note: '' };
    const silk = silkUnit === null ? null : {
      label: `シルク ${row.size}・${row.colors}色`, unit: mul(silkUnit),
      initial: silkPlate, initialLabel: `製版代 ${row.colors}版(初回のみ)`, note: '版の保管期間1年',
    };

    if (row.method === 'dtf' || row.colors === 'full') return dtf;
    if (row.method === 'silk') {
      return silk || { ...dtf, note: '10枚未満はシルク設定なし→DTFで計算' };
    }
    // auto: 総額比較(simulate.jsと同じ)
    if (silk && silk.unit * qty + silk.initial < dtf.unit * qty) return silk;
    return { ...dtf, note: silk ? 'この枚数・大きさではDTFのほうがお得' : '10枚未満のためDTFで計算' };
  }

  /* ---------- 通常加工モードの合計 ---------- */
  function calcNormal() {
    const qty = Math.max(1, parseInt(el('qty').value, 10) || 1);
    const opt = { express: el('opt-express').checked };
    const body = currentBody(); // {name, unit(税抜), estimate, quoteOnly}
    const lines = rows.map((r) => calcRow(r, qty, opt));

    // サイトのsimulate.jsと同じく「箇所ごとに税込へ切り上げ→合算」で1枚単価を作る
    // (税抜合算→税込だと内訳の見た目と1円ずれることがある)
    const printUnitTax = lines.reduce((s, l) => s + taxIn(l.unit), 0);
    const printUnitRaw = lines.reduce((s, l) => s + l.unit, 0);
    const initial = lines.reduce((s, l) => s + l.initial, 0);  // 税抜・初回
    let bodyUnit = body.unit;

    // 割引
    const d = currentDiscount();
    let discountNote = '';
    let unitBeforeDiscount = taxIn(bodyUnit) + printUnitTax;
    let unitAfter;
    if (d.key === 'staff') {
      const cost = Math.round(bodyUnit * 0.55); // 推定仕入値(税抜)
      unitAfter = taxIn(cost) + taxIn(Math.round(printUnitRaw * 0.5));
      discountNote = `社員特価: ボディ${yen(taxIn(cost))}(推定仕入値・要実額確認)+加工賃50%OFF`;
    } else if (d.rate > 0) {
      unitAfter = Math.ceil(unitBeforeDiscount * (100 - d.rate) / 100);
      discountNote = `${d.name} ${d.rate}%OFF(1枚単価に適用・初期費用は対象外)`;
    } else {
      unitAfter = unitBeforeDiscount;
    }

    const shipping = shippingCost();
    const total = unitAfter * qty + taxIn(initial) + shipping;

    return {
      mode: 'normal', qty, body, lines, opt,
      unitBefore: unitBeforeDiscount, unitAfter, discount: d, discountNote,
      initialTax: taxIn(initial), shipping, total,
      perPieceAll: Math.round(total / qty),
    };
  }

  /* ---------- KRATVSモードの合計 ---------- */
  const kSelected = new Set(); // 選択中プリントの t
  function calcKratvs() {
    const qty = Math.max(1, parseInt(el('k-qty').value, 10) || 1);
    const item = window.QS_KRATVS.items[+el('k-item').value];
    const band = item.price[+el('k-size').value];
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
    const unitBefore = band.p + printTotal; // すべて税込

    const d = currentDiscount('k');
    let unitAfter = unitBefore;
    let discountNote = '';
    if (d.key === 'staff') {
      unitAfter = Math.ceil(unitBefore * 0.5);
      discountNote = '社員特価(KRATVSは完成品価格のため一律50%OFFで計算)';
    } else if (d.rate > 0) {
      unitAfter = Math.ceil(unitBefore * (100 - d.rate) / 100);
      discountNote = `${d.name} ${d.rate}%OFF`;
    }
    const shipping = shippingCost();
    return {
      mode: 'kratvs', qty, item, band, picked, setApplied, rest,
      unitBefore, unitAfter, discount: d, discountNote, shipping,
      initialTax: 0, total: unitAfter * qty + shipping,
      perPieceAll: Math.round((unitAfter * qty + shipping) / qty),
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
    let html = `
      <label>加工方法
        <select data-f="method">
          ${sel('auto', '自動(シルク/DTFの安い方)')}${sel('silk', 'シルクスクリーン')}${sel('dtf', 'DTF(フルカラー)')}
          ${sel('rubber', 'ラバー転写')}${sel('marking', 'マーキング')}${sel('emb', '刺繍')}${sel('cap', '帽子刺繍')}
        </select>
      </label>`;
    if (['auto', 'silk', 'dtf', 'rubber'].includes(row.method)) {
      const sizes = row.method === 'rubber' ? SIZES_ALL.slice(1) : SIZES_ALL;
      html += `<label>大きさ
        <select data-f="size">${sizes.map((s) => `<option${s === row.size ? ' selected' : ''}>${s}</option>`).join('')}</select>
      </label>`;
      if (row.method !== 'dtf' && row.method !== 'rubber') {
        html += `<label>色数
          <select data-f="colors">${[1, 2, 3, 4].map((c) => `<option value="${c}"${c === row.colors ? ' selected' : ''}>${c}色</option>`).join('')}
          <option value="full"${row.colors === 'full' ? ' selected' : ''}>フルカラー(DTF)</option></select>
        </label>`;
      }
    }
    if (row.method === 'marking') {
      html += `<label>種類
        <select data-f="markKey">${window.QS_MARKING.map((m) => `<option value="${m.key}"${m.key === row.markKey ? ' selected' : ''}>${m.name} ${m.size}</option>`).join('')}</select>
      </label>`;
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
    }
    // 割増オプション(方法に関係するものだけ表示)
    const surKeys = {
      auto: ['special', 'bring'], silk: ['special', 'specialInk', 'overlay', 'bring'],
      dtf: ['special', 'blousonS', 'blousonL', 'bring'],
      rubber: ['special', 'blousonS', 'blousonL', 'bring', 'sheetMetallic', 'sheetPearl', 'sheetPearlNeon', 'sheetReflex', 'sheetSilver', 'sheet3M', 'sheetGlow'],
      marking: ['bring', 'sheetMetallic', 'sheetPearl', 'sheetPearlNeon', 'sheetReflex', 'sheetSilver', 'sheet3M', 'sheetGlow'],
      emb: ['embThread', 'embFabric', 'emb3D', 'bring'], cap: ['embThread', 'emb3D', 'bring'],
    }[row.method] || [];
    if (surKeys.length) {
      html += `<div class="qs-surcharges">${surKeys.map((k) => `
        <label class="qs-check"><input type="checkbox" data-sur="${k}"${row.surcharges.has(k) ? ' checked' : ''}>
        ${window.QS_SURCHARGE[k].name}(${Math.round((window.QS_SURCHARGE[k].rate - 1) * 100)}%増)</label>`).join('')}</div>`;
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
    if (r.mode === 'normal' && r.body.quoteOnly) {
      box.innerHTML = `<p class="empty-notice">このボディ(中綿・ナイロン等)は概算対象外です。個別見積りにしてください。</p>`;
      return;
    }
    let rowsHtml = '';
    if (r.mode === 'normal') {
      rowsHtml += `<tr><td>ボディ ${r.body.name}</td><td class="qs-num">${yen(taxIn(r.body.unit))}</td></tr>`;
      r.lines.forEach((l) => {
        rowsHtml += `<tr><td>${l.label}${l.note ? `<div class="qs-note">${l.note}</div>` : ''}</td><td class="qs-num">${yen(taxIn(l.unit))}</td></tr>`;
        if (l.initial) rowsHtml += `<tr class="qs-initial"><td>└ ${l.initialLabel}</td><td class="qs-num">${yen(taxIn(l.initial))}</td></tr>`;
      });
    } else {
      rowsHtml += `<tr><td>${r.item.name}(${r.band.size})</td><td class="qs-num">${yen(r.band.p)}</td></tr>`;
      if (r.setApplied) rowsHtml += `<tr><td>${r.setApplied.t}(${r.setApplied.used.join('+')})</td><td class="qs-num">${yen(r.setApplied.p)}</td></tr>`;
      r.rest.forEach((p) => { rowsHtml += `<tr><td>${p.t}(${p.size})</td><td class="qs-num">${yen(p.p)}</td></tr>`; });
    }
    const discountRow = r.discountNote
      ? `<tr class="qs-discount"><td>${r.discountNote}</td><td class="qs-num">${yen(r.unitAfter)}/枚</td></tr>` : '';

    // 原価・粗利(トグル)
    let costHtml = '';
    if (el('toggle-cost').checked && r.mode === 'normal' && r.body.unit > 0) {
      const cost = Math.round(r.body.unit * 0.55);
      const profit = r.total - taxIn(cost) * r.qty - r.shipping;
      costHtml = `<div class="qs-cost">
        <b>原価めやす(社外秘)</b> ボディ推定仕入 ${yen(taxIn(cost))}/枚(表示価格×0.55・要実額確認)
        → 粗利 ${yen(profit)}(${Math.round(profit / r.total * 100)}%)※加工材料費・人件費は含まず</div>`;
    }

    box.innerHTML = `
      <table class="qs-table"><tbody>${rowsHtml}${discountRow}</tbody></table>
      <div class="qs-summary">
        <div>1枚あたり(割引後)<b>${yen(r.unitAfter)}</b>${r.discount.rate > 0 || r.discount.key === 'staff' ? `<s>${yen(r.unitBefore)}</s>` : ''}</div>
        ${r.initialTax ? `<div>初期費用(割引対象外)<b>${yen(r.initialTax)}</b></div>` : ''}
        ${r.shipping ? `<div>送料<b>${yen(r.shipping)}</b></div>` : ''}
        <div class="qs-total">合計(${r.qty}枚・税込)<b>${yen(r.total)}</b><span>実質 ${yen(r.perPieceAll)}/枚</span></div>
      </div>
      ${costHtml}
      <p class="qs-note">金額はすべて税込の概算です。10枚未満はミニマム手数料(加工代5割増)を自動適用しています。</p>`;
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

    if (r.mode === 'normal') {
      const parts = r.lines.map((l) => l.label).join('・');
      let desc = `${title}(${parts})`;
      if (r.discount.rate > 0) desc += `　通常価格 ${r.unitBefore.toLocaleString()}円 → 特別割引 ${r.discount.rate}%OFF`;
      if (r.discount.key === 'staff') desc += '　社員特価';
      lines.push({ desc, qty: r.qty, unit: '枚', price: r.unitAfter });
      r.lines.forEach((l) => {
        if (l.initial) lines.push({ desc: `${l.initialLabel}(${l.label})`, qty: 1, unit: '式', price: taxIn(l.initial) });
      });
    } else {
      let desc = `KRATVSカスタムオーダー ${r.item.name}(${r.band.size})`;
      const prints = [...(r.setApplied ? r.setApplied.used : []), ...r.rest.map((p) => p.t)];
      if (prints.length) desc += `＋${prints.join('・')}`;
      if (r.discount.rate > 0) desc += `　通常価格 ${r.unitBefore.toLocaleString()}円 → 特別割引 ${r.discount.rate}%OFF`;
      if (r.discount.key === 'staff') desc += '　社員特価';
      lines.push({ desc, qty: r.qty, unit: '枚', price: r.unitAfter });
    }
    if (r.shipping) lines.push({ desc: '送料', qty: 1, unit: '式', price: r.shipping });

    const today = new Date();
    const iso = (d) => d.toLocaleDateString('sv-SE');
    const due = new Date(today.getTime() + 30 * 86400000);
    const taxOut = Math.round(r.total / (1 + TAX / 100));

    return {
      customer, title, qty: r.qty, lines,
      date: iso(today), due: iso(due),
      total: r.total, taxOut, tax: r.total - taxOut,
      notes: [
        '※表示金額はすべて税込です。',
        '※納期はデザイン最終確認・ご入金の確認から約2週間です。',
        '※当社工場でのお受け取りは無料です。ご配送をご希望の場合は別途承ります。',
      ],
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
    const mode = document.querySelector('input[name="mode"]:checked').value;
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
      el('k-size').innerHTML = it.price.map((p, i) => `<option value="${i}">${p.size}(${p.p.toLocaleString()}円)</option>`).join('');
      const list = it.kind === 'shorts' ? k.printsShorts : k.printsShirt;
      el('k-prints').innerHTML = list.map((p) => `
        <label class="qs-check"><input type="checkbox" data-kp="${p.t}"${kSelected.has(p.t) ? ' checked' : ''}>
        ${p.t}(${p.size})+${p.p.toLocaleString()}円</label>`).join('');
      el('k-prints').querySelectorAll('[data-kp]').forEach((cb) => {
        cb.onchange = () => { cb.checked ? kSelected.add(cb.dataset.kp) : kSelected.delete(cb.dataset.kp); recalc(); };
      });
    };
    el('k-item').onchange = () => { kSelected.clear(); syncSizes(); recalc(); };
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
      el('panel-normal').hidden = r.value !== 'normal' && r.checked;
      el('panel-kratvs').hidden = r.value !== 'kratvs' && r.checked;
      if (r.checked) {
        el('panel-normal').hidden = r.value !== 'normal';
        el('panel-kratvs').hidden = r.value !== 'kratvs';
      }
      recalc();
    };
  });

  ['qty', 'body-input', 'body-manual', 'k-qty', 'shipping', 'customer', 'item-title'].forEach((id) => {
    el(id).addEventListener('input', recalc);
  });
  el('opt-express').onchange = recalc;
  el('toggle-cost').onchange = recalc;
  el('btn-add-row').onclick = () => { newRow(); renderRows(); recalc(); };

  setupBodyList();
  setupKratvs();
  setupDiscounts('discount', 'discounts', 'custom-rate');
  setupDiscounts('k-discount', 'k-discounts', 'k-custom-rate');
  newRow();
  renderRows();
  recalc();
})();
