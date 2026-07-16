// 公開注文フォームのクライアントロジック。
// - 依頼種別(見積/正式発注)で表示・バリデーション・送信形式を切替
// - アイテム(指定/加工/数量を1単位)を動的に追加/削除。正式発注は複数、見積は1件。
// - 送信時に payload(JSON) を組み立て、画像とともに multipart で POST /order
//   * 見積: 従来の単一形(item_spec/decoration/quantity をトップレベル)で送信(サーバ互換)
//   * 正式発注: items[] 配列で送信(schema_version 2)
(function () {
  'use strict';
  const CFG = window.__ORDER_CONFIG__ || { turnstileSiteKey: '', minLeadDays: 14 };
  const form = document.getElementById('orderForm');
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // 大カテゴリの選択肢。サーバ側 CATEGORIES / CATEGORY_LABEL と一致させること。
  const CATEGORY_OPTIONS = [
    ['tshirt', 'Tシャツ'], ['polo', 'ポロシャツ'], ['sweat', 'トレーナー'], ['hoodie', 'パーカー'],
    ['zip_hoodie', 'ジップアップパーカー'], ['pants', 'パンツ'], ['cap', '帽子'], ['bag', 'バッグ'],
    ['workwear', '作業着'], ['other', 'その他'],
  ];
  // 大カテゴリ→第2カテゴリ(任意)の連動マスタ。ここに無い大カテゴリは第2カテゴリを出さない。
  // 値(value)はサーバ側 SUB_CATEGORIES と一致させること。
  const SUB_CATEGORIES = {
    tshirt: [
      { value: 'cotton_regular', label: '綿素材(通常)' },
      { value: 'cotton_heavy', label: '綿素材(厚手)' },
      { value: 'dry', label: 'ドライ素材' },
      { value: 'big_silhouette', label: 'ビッグシルエット' },
      { value: 'import_other', label: '他(インポートブランドなど)' },
    ],
    polo: [
      { value: 'cotton', label: '綿素材' },
      { value: 'dry', label: 'ドライ素材' },
    ],
    workwear: [
      { value: 'jacket', label: 'ジャケット' },
      { value: 'pants', label: 'パンツ' },
    ],
  };

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

  // ===== 行テンプレート(アイテム内スコープ) =====
  const CATALOG_ROW_HTML = `
    <input type="text" class="c-num" placeholder="品番" maxlength="200">
    <input type="text" class="c-color" placeholder="カラー" maxlength="200">
    <input type="text" class="c-maker" placeholder="メーカー" maxlength="200">
    <button type="button" class="btn-del" aria-label="削除">×</button>`;
  const PRINTLOC_ROW_HTML = `
    <input type="text" class="p-name" placeholder="位置（例: 前身頃）" maxlength="200">
    <select class="p-colors">
      <option value="1">1色</option><option value="2">2色</option>
      <option value="3">3色</option><option value="4">4色</option>
    </select>
    <button type="button" class="btn-del" aria-label="削除">×</button>`;
  const MATRIX_ROW_HTML = `
    <input type="text" class="m-size" placeholder="サイズ" maxlength="200">
    <input type="text" class="m-color" placeholder="カラー" maxlength="200">
    <input type="number" class="m-qty" placeholder="数量" min="0" inputmode="numeric">
    <button type="button" class="btn-del" aria-label="削除">×</button>`;
  const ROW_DEF = {
    catalog: { cls: 'catalog-rows', html: CATALOG_ROW_HTML },
    printloc: { cls: 'printloc-rows', html: PRINTLOC_ROW_HTML },
    matrix: { cls: 'matrix-rows', html: MATRIX_ROW_HTML },
  };
  // root(アイテムカード or フォーム)配下の指定コンテナに行を追加
  function addRow(root, kind) {
    const def = ROW_DEF[kind];
    const row = document.createElement('div');
    row.className = 'row-line ' + kind + '-row';
    row.innerHTML = def.html;
    root.querySelector('.' + def.cls).appendChild(row);
  }

  // ===== アイテムカードの生成 =====
  const itemsContainer = $('#itemsContainer');
  function buildItemCard() {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.innerHTML = `
      <div class="item-head">
        <h3 class="item-title">アイテム</h3>
        <button type="button" class="btn-del-item" hidden>× このアイテムを削除</button>
      </div>

      <div class="subblock">
        <h4>アイテム指定 <span class="req">品番 または カテゴリ</span></h4>
        <div class="catalog-rows"></div>
        <button type="button" class="btn-add" data-add-row="catalog">＋ 品番を追加</button>
        <div class="grid2" style="margin-top:.5rem">
          <label class="field">カテゴリ
            <select class="i-category">
              <option value="">選択してください</option>
              ${CATEGORY_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
            </select>
          </label>
          <label class="field i-subcat-field" hidden>第2カテゴリ<small>（任意）</small>
            <select class="i-subcategory"><option value="">選択してください</option></select>
          </label>
        </div>
        <div class="estimate-only">
          <div class="grid2">
            <label class="field">ご予算感
              <input type="text" class="i-budget" maxlength="200" placeholder="例: 1枚2,000円くらい">
            </label>
            <label class="field">用途
              <input type="text" class="i-purpose" maxlength="500" placeholder="例: 夏の練習着">
            </label>
          </div>
          <label class="field">希望の雰囲気
            <input type="text" class="i-mood" maxlength="500" placeholder="例: シンプルで濃色">
          </label>
        </div>
      </div>

      <div class="subblock">
        <h4>加工内容</h4>
        <label class="field">加工方法
          <select class="i-method">
            <option value="print">プリント</option>
            <option value="embroidery">刺繍</option>
            <option value="both">プリント＋刺繍</option>
          </select>
        </label>
        <div class="i-printloc-block">
          <h5>プリント位置 <span class="req">プリント時は必須</span></h5>
          <div class="printloc-rows"></div>
          <button type="button" class="btn-add" data-add-row="printloc">＋ プリント位置を追加</button>
        </div>
      </div>

      <div class="subblock">
        <h4>数量</h4>
        <div class="field i-qty-approx">
          <label><span class="i-qty-label">概数（おおよその枚数）</span>
            <input type="text" class="i-approx" maxlength="500" placeholder="全体の総数を入力してください">
          </label>
          <p class="hint i-qty-hint">正式発注をお選びの場合は、下の内訳または概数のいずれかをご入力ください。</p>
        </div>
        <details class="accordion i-qty-matrix">
          <summary>サイズ×カラー×数量の内訳を入力する（任意）</summary>
          <div class="matrix-rows"></div>
          <button type="button" class="btn-add" data-add-row="matrix">＋ 行を追加</button>
          <p class="matrix-total">合計: <span class="matrix-total-val">0</span> 枚</p>
        </details>
      </div>`;
    // 初期行を1つずつ
    addRow(card, 'catalog');
    addRow(card, 'printloc');
    addRow(card, 'matrix');
    return card;
  }

  function itemCards() { return $$('.item-card', itemsContainer); }
  function visibleItemCards() { return itemCards().filter(c => c.style.display !== 'none'); }

  function addItem() {
    const card = buildItemCard();
    itemsContainer.appendChild(card);
    applyItemUI(card);
    applyCategoryUI(card);
    applyMethodUI(card);
    refreshItemChrome();
    return card;
  }
  // アイテムのタイトル番号と削除ボタン表示を更新
  function refreshItemChrome() {
    const isOrder = currentType() === 'order';
    const cards = visibleItemCards();
    cards.forEach((card, i) => {
      $('.item-title', card).textContent = isOrder ? `アイテム ${i + 1}` : 'アイテム指定';
      // 削除は「正式発注 かつ 2件以上」のときだけ出す
      $('.btn-del-item', card).hidden = !(isOrder && cards.length > 1);
    });
  }

  // 初期アイテムを1件用意
  addItem();

  // ===== 依頼種別による表示切替 =====
  function currentType() {
    const el = $('input[name="request_type"]:checked');
    return el ? el.value : 'quote';
  }
  // 1アイテムカードの見た目を種別に合わせる
  function applyItemUI(card) {
    const isOrder = currentType() === 'order';
    $('.estimate-only', card).style.display = isOrder ? 'none' : '';
    $('.i-qty-label', card).textContent = isOrder ? '数量' : '概数（おおよその枚数）';
    $('.i-qty-hint', card).style.display = isOrder ? 'none' : '';
    $('.i-qty-matrix', card).open = isOrder;
  }
  function applyTypeUI() {
    const isOrder = currentType() === 'order';
    // メールアドレス: 見積・正式発注とも任意
    $('#emailReq').textContent = '任意';
    $('#ordererEmail').removeAttribute('required');
    // アイテム: 見積は1件のみ(2件目以降は隠す)。正式発注は全件表示＋追加ボタン。
    itemCards().forEach((card, i) => {
      card.style.display = (isOrder || i === 0) ? '' : 'none';
      applyItemUI(card);
    });
    $('#addItemBtn').hidden = !isOrder;
    $('#itemsMultiHint').hidden = !isOrder;
    refreshItemChrome();
  }
  $$('input[name="request_type"]').forEach(r => r.addEventListener('change', applyTypeUI));

  // ===== カテゴリ2段階(連動プルダウン): アイテム単位 =====
  function applyCategoryUI(card) {
    const cat = $('.i-category', card).value;
    const subs = SUB_CATEGORIES[cat] || null;
    const sel = $('.i-subcategory', card);
    // 大カテゴリ変更のたびに作り直す = 第2カテゴリの選択は自動リセット
    sel.innerHTML = '<option value="">選択してください</option>';
    if (subs) {
      subs.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      });
      $('.i-subcat-field', card).hidden = false;
    } else {
      $('.i-subcat-field', card).hidden = true;
    }
  }
  // ===== 加工方法によるプリント位置の要否表示: アイテム単位 =====
  function applyMethodUI(card) {
    const m = $('.i-method', card).value;
    $('.i-printloc-block', card).style.display = (m === 'print' || m === 'both') ? '' : 'none';
  }
  function recalcMatrix(card) {
    let total = 0;
    $$('.matrix-row', card).forEach(r => {
      const q = parseInt($('.m-qty', r).value, 10);
      if (Number.isFinite(q) && q > 0) total += q;
    });
    $('.matrix-total-val', card).textContent = total;
  }

  // ===== イベント委譲(アイテムは動的生成のため container 側で受ける) =====
  $('#addItemBtn').addEventListener('click', () => {
    const card = addItem();
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  itemsContainer.addEventListener('click', (e) => {
    const t = e.target;
    if (t.matches('[data-add-row]')) {
      addRow(t.closest('.item-card'), t.getAttribute('data-add-row'));
    } else if (t.classList.contains('btn-del')) {
      const card = t.closest('.item-card');
      t.closest('.row-line').remove();
      recalcMatrix(card);
    } else if (t.classList.contains('btn-del-item')) {
      t.closest('.item-card').remove();
      refreshItemChrome();
    }
  });
  itemsContainer.addEventListener('change', (e) => {
    const card = e.target.closest('.item-card');
    if (!card) return;
    if (e.target.classList.contains('i-category')) applyCategoryUI(card);
    else if (e.target.classList.contains('i-method')) applyMethodUI(card);
  });
  itemsContainer.addEventListener('input', (e) => {
    if (e.target.classList.contains('m-qty')) recalcMatrix(e.target.closest('.item-card'));
  });

  // 名簿(グローバル)
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
  addRosterRow();
  $('[data-add="roster"]').addEventListener('click', addRosterRow);
  $('#rosterRows').addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-del')) e.target.closest('.row-line').remove();
  });

  // 種別UIを初期適用(初期アイテム生成後に呼ぶ)
  applyTypeUI();

  // ===== payload 収集 =====
  function collectCatalog(card) {
    return $$('.catalog-row', card).map(r => ({
      catalog_number: $('.c-num', r).value.trim(),
      color: $('.c-color', r).value.trim(),
      maker: $('.c-maker', r).value.trim(),
    })).filter(x => x.catalog_number);
  }
  function collectUnknown(card, isOrder) {
    const category = $('.i-category', card).value.trim();
    const sub_category = $('.i-subcategory', card).value.trim();
    // 正式発注ではご予算感/用途/希望の雰囲気は非表示 → サーバへ送らない
    const purpose = isOrder ? '' : $('.i-purpose', card).value.trim();
    const budget = isOrder ? '' : $('.i-budget', card).value.trim();
    const mood = isOrder ? '' : $('.i-mood', card).value.trim();
    if (!category && !sub_category && !purpose && !budget && !mood) return null;
    return { category, sub_category, purpose, budget, mood };
  }
  function collectPrintLocs(card) {
    return $$('.printloc-row', card).map(r => ({
      location_name: $('.p-name', r).value.trim(),
      color_count: parseInt($('.p-colors', r).value, 10),
    })).filter(x => x.location_name);
  }
  function collectMatrix(card) {
    const cells = $$('.matrix-row', card).map(r => ({
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
  // 1アイテムを { item_spec, decoration, quantity } 形にまとめる
  function collectItem(card, isOrder) {
    return {
      item_spec: { catalog_items: collectCatalog(card), unknown_spec: collectUnknown(card, isOrder) },
      decoration: { method: $('.i-method', card).value, print_locations: collectPrintLocs(card) },
      quantity: { approximate: $('.i-approx', card).value.trim(), matrix: collectMatrix(card) },
    };
  }
  function collectRoster() {
    return $$('.roster-row').map(r => ({
      player_name: $('.r-name', r).value.trim(),
      number: $('.r-num', r).value.trim(),
      size: $('.r-size', r).value.trim(),
    })).filter(x => x.player_name || x.number);
  }
  function val(path) {
    const el = $(`[data-path="${path}"]`);
    return el ? el.value.trim() : '';
  }

  function buildPayloadAndFiles() {
    // 画像: 参考画像(role=reference) → デザイン(role=design) の順で append し、rolesを対応させる
    const refFiles = Array.from($('#referenceImages').files || []);
    const designFiles = Array.from($('#designImages').files || []);
    const files = [];
    const imagesMeta = [];
    refFiles.forEach(f => { files.push(f); imagesMeta.push({ role: 'reference' }); });
    designFiles.forEach(f => { files.push(f); imagesMeta.push({ role: 'design' }); });

    const isOrder = currentType() === 'order';
    const payload = {
      request_type: currentType(),
      orderer: {
        org_name: val('orderer.org_name'),
        contact_name: val('orderer.contact_name'),
        phone: val('orderer.phone'),
        email: val('orderer.email'),
      },
      roster: collectRoster(),
      deadline: { date: $('#deadlineDate').value || '', note: val('deadline.note') },
      remarks: val('remarks'),
      images: imagesMeta,
    };

    if (isOrder) {
      // 正式発注: 複数アイテムを items[] で送る(表示中のカードのみ)
      payload.items = visibleItemCards().map(card => collectItem(card, true));
    } else {
      // 見積: 従来の単一形(トップレベル)。サーバの互換のため items は付けない。
      const it = collectItem(itemCards()[0], false);
      payload.item_spec = it.item_spec;
      payload.decoration = it.decoration;
      payload.quantity = it.quantity;
    }
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

  // ===== フロント側バリデーション(アイテム指定の緩和条件) =====
  // 各アイテムで「品番あり または 大カテゴリ選択あり」のいずれかで有効。
  // 見積(1件)は従来どおり参考画像でも可。
  function cardHasSpec(card) {
    const hasCatalog = $$('.catalog-row', card).some(r => $('.c-num', r).value.trim());
    const hasCategory = !!$('.i-category', card).value;
    return { hasCatalog, hasCategory };
  }
  function clientValidate() {
    const errs = [];
    const isOrder = currentType() === 'order';
    const hasReference = (($('#referenceImages').files) || []).length > 0;
    if (isOrder) {
      const cards = visibleItemCards();
      cards.forEach((card, i) => {
        const { hasCatalog, hasCategory } = cardHasSpec(card);
        if (!hasCatalog && !hasCategory) {
          errs.push({ message: `アイテム ${i + 1}: 品番 または カテゴリ を1つ以上ご入力ください。` });
        }
      });
    } else {
      const { hasCatalog, hasCategory } = cardHasSpec(itemCards()[0]);
      if (!hasCatalog && !hasCategory && !hasReference) {
        errs.push({ message: 'アイテム指定: 品番 または カテゴリ を1つ以上ご入力ください(参考画像でも可)。' });
      }
    }
    return errs;
  }

  // ===== 送信 =====
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showErrors(null);
    const clientErrors = clientValidate();
    if (clientErrors.length) { showErrors(clientErrors); return; }
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
