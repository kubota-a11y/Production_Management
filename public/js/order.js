// 公開注文フォームのクライアントロジック。
// - 依頼種別(見積/正式発注)で数量欄の表示を切替
// - 品番/プリント位置/マトリクス/名簿の動的行
// - 送信時に payload(JSON) を組み立て、画像とともに multipart で POST /order
(function () {
  'use strict';
  const CFG = window.__ORDER_CONFIG__ || { turnstileSiteKey: '', minLeadDays: 14 };
  const form = document.getElementById('orderForm');
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ===== 納期: 日付ピッカーの下限を「今日+minLeadDays」に =====
  function localDatePlus(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${dd}`;
  }
  const deadlineInput = $('#deadlineDate');
  if (deadlineInput) deadlineInput.min = localDatePlus(CFG.minLeadDays);

  // ===== 動的行テンプレート =====
  function addCatalogRow() {
    const row = document.createElement('div');
    row.className = 'row-line catalog-row';
    row.innerHTML = `
      <input type="text" class="c-num" placeholder="品番" maxlength="200">
      <input type="text" class="c-color" placeholder="カラー" maxlength="200">
      <input type="text" class="c-maker" placeholder="メーカー" maxlength="200">
      <button type="button" class="btn-del" aria-label="削除">×</button>`;
    $('#catalogRows').appendChild(row);
  }
  function addPrintLocRow() {
    const row = document.createElement('div');
    row.className = 'row-line printloc-row';
    row.innerHTML = `
      <input type="text" class="p-name" placeholder="位置（例: 前身頃）" maxlength="200">
      <select class="p-colors">
        <option value="1">1色</option><option value="2">2色</option>
        <option value="3">3色</option><option value="4">4色</option>
      </select>
      <button type="button" class="btn-del" aria-label="削除">×</button>`;
    $('#printLocRows').appendChild(row);
  }
  function addMatrixRow() {
    const row = document.createElement('div');
    row.className = 'row-line matrix-row';
    row.innerHTML = `
      <input type="text" class="m-size" placeholder="サイズ" maxlength="200">
      <input type="text" class="m-color" placeholder="カラー" maxlength="200">
      <input type="number" class="m-qty" placeholder="数量" min="0" inputmode="numeric">
      <button type="button" class="btn-del" aria-label="削除">×</button>`;
    $('#matrixRows').appendChild(row);
  }
  function addRosterRow() {
    const row = document.createElement('div');
    row.className = 'row-line roster-row';
    row.innerHTML = `
      <input type="text" class="r-name" placeholder="選手名" maxlength="200">
      <input type="text" class="r-num" placeholder="背番号" maxlength="20">
      <input type="text" class="r-size" placeholder="サイズ" maxlength="20">
      <button type="button" class="btn-del" aria-label="削除">×</button>`;
    $('#rosterRows').appendChild(row);
  }

  // 初期行を1つずつ用意
  addCatalogRow();
  addPrintLocRow();
  addMatrixRow();
  addRosterRow();

  // 行追加ボタン
  $$('[data-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.getAttribute('data-add');
      if (kind === 'catalog') addCatalogRow();
      else if (kind === 'printloc') addPrintLocRow();
      else if (kind === 'matrix') addMatrixRow();
      else if (kind === 'roster') addRosterRow();
    });
  });

  // 行削除(委譲)＋マトリクス合計の再計算
  form.addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-del')) {
      e.target.closest('.row-line').remove();
      recalcMatrix();
    }
  });
  form.addEventListener('input', (e) => {
    if (e.target.classList.contains('m-qty')) recalcMatrix();
  });
  function recalcMatrix() {
    let total = 0;
    $$('.matrix-row').forEach(r => {
      const q = parseInt($('.m-qty', r).value, 10);
      if (Number.isFinite(q) && q > 0) total += q;
    });
    $('#matrixTotal').textContent = total;
  }

  // ===== 依頼種別による表示切替 =====
  function currentType() {
    const el = $('input[name="request_type"]:checked');
    return el ? el.value : 'quote';
  }
  function applyTypeUI() {
    const isOrder = currentType() === 'order';
    // 正式発注ではマトリクスのアコーディオンを開いた状態で促す(概数も併用可)
    $('#qtyMatrix').open = isOrder;
  }
  $$('input[name="request_type"]').forEach(r => r.addEventListener('change', applyTypeUI));
  applyTypeUI();

  // ===== 加工方法によるプリント位置の要否表示 =====
  function applyMethodUI() {
    const m = $('#decoMethod').value;
    $('#printLocBlock').style.display = (m === 'print' || m === 'both') ? '' : 'none';
  }
  $('#decoMethod').addEventListener('change', applyMethodUI);
  applyMethodUI();

  // ===== payload 組み立て =====
  function val(path) {
    const el = $(`[data-path="${path}"]`);
    return el ? el.value.trim() : '';
  }
  function collectCatalog() {
    return $$('.catalog-row').map(r => ({
      catalog_number: $('.c-num', r).value.trim(),
      color: $('.c-color', r).value.trim(),
      maker: $('.c-maker', r).value.trim(),
    })).filter(x => x.catalog_number);
  }
  function collectUnknown() {
    const category = val('item_spec.unknown_spec.category');
    const purpose = val('item_spec.unknown_spec.purpose');
    const budget = val('item_spec.unknown_spec.budget');
    const mood = val('item_spec.unknown_spec.mood');
    if (!category && !purpose && !budget && !mood) return null;
    return { category, purpose, budget, mood };
  }
  function collectPrintLocs() {
    return $$('.printloc-row').map(r => ({
      location_name: $('.p-name', r).value.trim(),
      color_count: parseInt($('.p-colors', r).value, 10),
    })).filter(x => x.location_name);
  }
  function collectMatrix() {
    const cells = $$('.matrix-row').map(r => ({
      size: $('.m-size', r).value.trim(),
      color: $('.m-color', r).value.trim(),
      qty: parseInt($('.m-qty', r).value, 10),
    })).filter(c => Number.isFinite(c.qty) && c.qty > 0 && (c.size || c.color));
    if (cells.length === 0) return null;
    const sizes = [...new Set(cells.map(c => c.size).filter(Boolean))];
    const colors = [...new Set(cells.map(c => c.color).filter(Boolean))];
    const total = cells.reduce((s, c) => s + c.qty, 0);
    return { sizes, colors, cells, total };
  }
  function collectRoster() {
    return $$('.roster-row').map(r => ({
      player_name: $('.r-name', r).value.trim(),
      number: $('.r-num', r).value.trim(),
      size: $('.r-size', r).value.trim(),
    })).filter(x => x.player_name || x.number);
  }

  function buildPayloadAndFiles() {
    // 画像: 参考画像(role=reference) → デザイン(role=design) の順で append し、rolesを対応させる
    const refFiles = Array.from($('#referenceImages').files || []);
    const designFiles = Array.from($('#designImages').files || []);
    const files = [];
    const imagesMeta = [];
    refFiles.forEach(f => { files.push(f); imagesMeta.push({ role: 'reference' }); });
    designFiles.forEach(f => { files.push(f); imagesMeta.push({ role: 'design' }); });

    const payload = {
      request_type: currentType(),
      orderer: {
        org_name: val('orderer.org_name'),
        contact_name: val('orderer.contact_name'),
        phone: val('orderer.phone'),
        email: val('orderer.email'),
      },
      item_spec: {
        catalog_items: collectCatalog(),
        unknown_spec: collectUnknown(),
      },
      decoration: {
        method: $('#decoMethod').value,
        print_locations: collectPrintLocs(),
      },
      quantity: {
        approximate: val('quantity.approximate'),
        matrix: collectMatrix(),
      },
      roster: collectRoster(),
      deadline: {
        date: $('#deadlineDate').value || '',
        note: val('deadline.note'),
      },
      remarks: val('remarks'),
      images: imagesMeta,
    };
    return { payload, files };
  }

  // ===== エラー表示 =====
  function showErrors(errors) {
    const box = $('#formErrors');
    if (!errors || !errors.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<strong>入力内容をご確認ください：</strong><ul>' +
      errors.map(e => `<li>${escapeHtml(e.message)}</li>`).join('') + '</ul>';
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ===== Turnstile(サイトキーがある時のみ) =====
  let turnstileWidgetId = null;
  function initTurnstile() {
    if (!CFG.turnstileSiteKey) return;
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      turnstileWidgetId = window.turnstile.render('#turnstileContainer', { sitekey: CFG.turnstileSiteKey });
    };
    document.head.appendChild(script);
  }
  function getTurnstileToken() {
    if (!CFG.turnstileSiteKey || !window.turnstile) return '';
    return window.turnstile.getResponse(turnstileWidgetId) || '';
  }
  initTurnstile();

  // ===== 送信 =====
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showErrors(null);
    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = '送信中...';

    try {
      const { payload, files } = buildPayloadAndFiles();
      const fd = new FormData();
      fd.append('payload', JSON.stringify(payload));
      fd.append('hp_url', form.hp_url.value || '');
      fd.append('cf-turnstile-response', getTurnstileToken());
      files.forEach(f => fd.append('images', f));

      const resp = await fetch('/order', { method: 'POST', body: fd });
      const data = await resp.json().catch(() => ({}));

      if (resp.ok && data.ok) {
        form.hidden = true;
        const done = $('#donePanel');
        done.hidden = false;
        $('#doneMessage').textContent = data.request_type === 'order'
          ? 'ご注文を受け付けました。'
          : 'お見積り・イメージのご依頼を受け付けました。';
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        showErrors(data.errors && data.errors.length ? data.errors
          : [{ message: '送信に失敗しました。時間をおいて再度お試しください。' }]);
        if (CFG.turnstileSiteKey && window.turnstile) window.turnstile.reset(turnstileWidgetId);
      }
    } catch (err) {
      showErrors([{ message: '通信エラーが発生しました。接続をご確認のうえ再度お試しください。' }]);
    } finally {
      btn.disabled = false;
      btn.textContent = '送信する';
    }
  });
})();
