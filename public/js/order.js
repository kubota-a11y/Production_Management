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
    const type = currentType();
    const isOrder = type === 'order';
    const isConsult = type === 'consult';
    // メールアドレス: 全種別で任意
    $('#emailReq').textContent = '任意';
    $('#ordererEmail').removeAttribute('required');
    // かんたん相談: 相談内容セクションだけを出し、詳細入力(アイテム/名簿/納期/デザイン/備考)は隠す
    $('#consultSection').hidden = !isConsult;
    ['#itemsSection', '#rosterSection', '#deadlineSection', '#designSection', '#remarksSection']
      .forEach(sel => { $(sel).style.display = isConsult ? 'none' : ''; });
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

  // ===== 下書きの自動保存・復元(2026-07-27) =====
  // スマホ(LINE内ブラウザ等)ではタブ破棄・誤リロードで長いフォーム入力が全消失しやすい。
  // 入力のたびにlocalStorageへ自動保存し、次回表示時に復元する。送信成功時と24時間経過で破棄。
  // ファイル添付はブラウザの制約上保存できない(復元後に選び直してもらう)。
  const DRAFT_KEY = 'hiyoshiOrderDraft_v1';
  const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

  // 保存対象の入力欄をDOM順で列挙する。honeypot(hp_url)・hidden(Turnstile)・ファイル・
  // ラジオ(request_typeは別途保存)は対象外。構成(行数)を同じに再現すれば復元時も同じ順序になる
  function draftFields() {
    return $$('input:not([type="file"]):not([type="radio"]):not([type="hidden"]):not([name="hp_url"]), select, textarea', form);
  }

  function collectDraft() {
    return {
      saved_at: Date.now(),
      request_type: currentType(),
      items: itemCards().map(card => ({
        catalog: $$('.catalog-row', card).length,
        printloc: $$('.printloc-row', card).length,
        matrix: $$('.matrix-row', card).length,
      })),
      roster: $$('.roster-row').length,
      values: draftFields().map(el => (el.type === 'checkbox' ? el.checked : el.value)),
    };
  }

  let draftTimer = null;
  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(collectDraft()));
      } catch (_) { /* プライベートモード等で保存不可でも入力は続行できる */ }
    }, 500);
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (_) { /* 何もしない */ }
  }

  function showDraftNotice() {
    const notice = document.createElement('div');
    notice.className = 'draft-notice';
    const span = document.createElement('span');
    span.textContent = '前回の入力内容を復元しました(まだ送信はされていません)。添付ファイルは復元できないため、お手数ですが選び直してください。';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '最初から入力し直す';
    btn.addEventListener('click', () => { clearDraft(); location.reload(); });
    notice.append(span, btn);
    form.prepend(notice);
  }

  function restoreDraft() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (_) { return; }
    if (!d || !Array.isArray(d.values)) return;
    if (!d.saved_at || Date.now() - d.saved_at > DRAFT_TTL_MS) { clearDraft(); return; }
    try {
      const radio = $(`input[name="request_type"][value="${d.request_type}"]`);
      if (radio) radio.checked = true;
      // アイテムカード・各行・名簿行の数を保存時と同じ構成に再現する
      (d.items || []).forEach((st, i) => {
        const card = itemCards()[i] || addItem();
        while ($$('.catalog-row', card).length < (st.catalog || 1)) addRow(card, 'catalog');
        while ($$('.printloc-row', card).length < (st.printloc || 1)) addRow(card, 'printloc');
        while ($$('.matrix-row', card).length < (st.matrix || 1)) addRow(card, 'matrix');
      });
      while ($$('.roster-row').length < (d.roster || 0)) addRosterRow();
      applyTypeUI();
      // 値の流し込みは2回行う: 1回目の後にカテゴリ連動UIを適用すると第2カテゴリの
      // 選択肢が作り直される(=選択が消える)ため、もう一度流し込んで選択状態まで復元する
      const assignValues = () => {
        const fields = draftFields();
        d.values.forEach((v, i) => {
          const el = fields[i];
          if (!el) return;
          if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
        });
      };
      assignValues();
      itemCards().forEach(card => { applyCategoryUI(card); applyMethodUI(card); });
      assignValues();
      itemCards().forEach(card => recalcMatrix(card));
      showDraftNotice();
    } catch (err) {
      console.error('下書きの復元に失敗しました:', err);
    }
  }

  form.addEventListener('input', scheduleDraftSave);
  form.addEventListener('change', scheduleDraftSave);
  restoreDraft();

  // 紹介コード: ?ref= 付きで開かれたら自動入力する(紹介ページ/紹介カードのQR経由)。
  // 下書き復元より後に実行し、空のときだけ入れる(手入力を上書きしない)
  (() => {
    const ref = (new URLSearchParams(location.search).get('ref') || '').trim();
    if (!ref) return;
    const el = $('[data-path="referral_code"]');
    if (el && !el.value) {
      el.value = ref.slice(0, 20);
      scheduleDraftSave();
    }
  })();

  // ===== サイトの料金シミュレーターからの引き継ぎ(?sim=) =====
  // コーポレートサイト(hiyoshi-1954.com)の「この内容で見積りをとる」から遷移してきたとき、
  // 選ばれた仕様をこのフォームへ流し込む。サイト側の送信部は
  // `~/Desktop/GITHUB_HiYOSHi_WEB/src/lib/sim-handoff.ts`(単一の情報源)。
  //
  //   ?sim=<base64url(UTF-8 JSON)>
  //   { v:1, src:'price'|'kratvs',
  //     cat, sub,                    // カテゴリ/第2カテゴリ(上の CATEGORY_OPTIONS / SUB_CATEGORIES と同じ値)
  //     items:[{num,color,maker}],   // 品番行
  //     locs:[{n,c}],                // プリント位置行(n=位置名・c=色数1〜4)
  //     qty,                         // 概数(テキスト)
  //     sum:[...] }                  // 備考に残す要約行(金額を含む)
  //
  // ★金額は「文字」としてしか受け取らない。サイト側の概算を業務データの金額として扱わない
  //   (URLは誰でも書き換えられるため)。正式な金額は従来どおり社内で作成する。
  // ★受け取った値はすべて長さ・件数・選択肢を検証してから入れる。想定外なら黙って無視し、
  //   フォームは通常どおり使える状態を保つ(お客様の入力機会を絶対に奪わない)。
  const SIM_LIMITS = { items: 5, locs: 8, sum: 24, text: 200, qty: 500, line: 120 };
  const SIM_HEAD = '【サイトの料金シミュレーターで選んだ内容】';
  const SIM_FOOT = '※上記の金額はサイト表示の概算です。';

  // 備考の先頭にある「前回の引き継ぎ分」を取り除く(お客様が書いた文章はそのまま残す)
  function stripPrevSim(text) {
    if (!text.startsWith(SIM_HEAD)) return text;
    const i = text.indexOf(SIM_FOOT);
    return i === -1 ? text : text.slice(i + SIM_FOOT.length).replace(/^\n+/, '');
  }

  function simText(v, max) {
    // 制御文字を落として長さを揃える(maxlength と同じ上限に合わせる)
    return typeof v === 'string' ? v.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, max) : '';
  }
  function decodeSim(raw) {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  // 指定種別の行をすべて消してから、必要な数だけ作り直す
  function resetRows(card, kind, count) {
    $$('.' + kind + '-row', card).forEach((r) => r.remove());
    for (let i = 0; i < Math.max(1, count); i++) addRow(card, kind);
  }
  function showSimNotice() {
    const notice = document.createElement('div');
    notice.className = 'sim-notice';
    notice.textContent = 'サイトのシミュレーターで選んだ内容を反映しました。'
      + 'ご連絡先をご入力のうえ、そのまま送信いただけます(内容の修正もできます)。';
    form.prepend(notice);
  }

  function applySim(sim) {
    if (!sim || sim.v !== 1) return;
    const card = itemCards()[0];
    if (!card) return;

    // 依頼種別: 見積・イメージ依頼(アイテム指定欄が出る種別)
    const quote = $('input[name="request_type"][value="quote"]');
    if (quote) { quote.checked = true; applyTypeUI(); }

    // カテゴリ(選択肢に無い値は入れない)
    const cat = simText(sim.cat, 40);
    if (CATEGORY_OPTIONS.some(([v]) => v === cat)) {
      $('.i-category', card).value = cat;
      applyCategoryUI(card);
      const sub = simText(sim.sub, 40);
      if ((SUB_CATEGORIES[cat] || []).some((o) => o.value === sub)) {
        $('.i-subcategory', card).value = sub;
      }
    }

    // 品番行
    const items = Array.isArray(sim.items) ? sim.items.slice(0, SIM_LIMITS.items) : [];
    if (items.length) {
      resetRows(card, 'catalog', items.length);
      $$('.catalog-row', card).forEach((row, i) => {
        const it = items[i] || {};
        $('.c-num', row).value = simText(it.num, SIM_LIMITS.text);
        $('.c-color', row).value = simText(it.color, SIM_LIMITS.text);
        $('.c-maker', row).value = simText(it.maker, SIM_LIMITS.text);
      });
    }

    // プリント位置行
    const locs = Array.isArray(sim.locs) ? sim.locs.slice(0, SIM_LIMITS.locs) : [];
    if (locs.length) {
      $('.i-method', card).value = 'print';
      applyMethodUI(card);
      resetRows(card, 'printloc', locs.length);
      $$('.printloc-row', card).forEach((row, i) => {
        const l = locs[i] || {};
        $('.p-name', row).value = simText(l.n, SIM_LIMITS.text);
        const c = parseInt(l.c, 10);
        $('.p-colors', row).value = String(c >= 1 && c <= 4 ? c : 1);
      });
    }

    // 概数
    const qty = simText(sim.qty, SIM_LIMITS.qty);
    if (qty) $('.i-approx', card).value = qty;

    // 備考: 要約を先頭に足す。お客様が書いた文章は消さない
    const sum = (Array.isArray(sim.sum) ? sim.sum : [])
      .slice(0, SIM_LIMITS.sum)
      .map((l) => simText(l, SIM_LIMITS.line))
      .filter(Boolean);
    // 前回の引き継ぎ分は下書きに残っている。積み上がらないよう置き換える
    if (sum.length) {
      const box = $('[data-path="remarks"]');
      const rest = stripPrevSim(box.value);
      const block = [SIM_HEAD, ...sum.map((l) => '・' + l), SIM_FOOT].join('\n');
      box.value = (block + (rest ? '\n\n' + rest : '')).slice(0, 3000);
    }

    refreshItemChrome();
    scheduleDraftSave();
    showSimNotice();
  }

  // 下書き復元より後に実行する(シミュレーターから来た直後は、そちらの内容を優先する)
  (() => {
    const raw = (new URLSearchParams(location.search).get('sim') || '').trim();
    if (!raw || raw.length > 4000) return;
    let sim = null;
    try { sim = decodeSim(raw); } catch (_) { return; } // 壊れたURLでもフォームは通常どおり使える
    try { applySim(sim); } catch (err) { console.error('シミュレーター内容の反映に失敗しました:', err); }
  })();

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
    const isConsult = currentType() === 'consult';
    // 画像: 参考画像(role=reference) → デザイン(role=design) の順で append し、rolesを対応させる。
    // かんたん相談ではデザイン欄が非表示のため、参考画像のみ送る(切り替え前に選択済みのファイル混入を防ぐ)
    const refFiles = Array.from($('#referenceImages').files || []);
    const designFiles = isConsult ? [] : Array.from($('#designImages').files || []);
    const files = [];
    const imagesMeta = [];
    refFiles.forEach(f => { files.push(f); imagesMeta.push({ role: 'reference' }); });
    designFiles.forEach(f => { files.push(f); imagesMeta.push({ role: 'design' }); });

    const orderer = {
      org_name: val('orderer.org_name'),
      contact_name: val('orderer.contact_name'),
      phone: val('orderer.phone'),
      email: val('orderer.email'),
    };

    if (isConsult) {
      // かんたん相談: 最小構成(連絡先+希望時間帯+自由記述+参考画像)
      return {
        payload: {
          request_type: 'consult',
          orderer,
          consult: {
            preferred_time: $('#consultTime').value,
            message: $('#consultMessage').value.trim(),
          },
          referral_code: val('referral_code'),
          images: imagesMeta,
        },
        files,
      };
    }

    const isOrder = currentType() === 'order';
    const payload = {
      request_type: currentType(),
      orderer,
      roster: collectRoster(),
      deadline: { date: $('#deadlineDate').value || '', note: val('deadline.note') },
      remarks: val('remarks'),
      referral_code: val('referral_code'),
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
    // かんたん相談はアイテム指定不要(連絡先はHTMLのrequiredでチェックされる)
    if (currentType() === 'consult') return errs;
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
  // 入力途中のEnterキーによる誤送信を防ぐ(送信は必ずボタン→確認ウィンドウ経由)
  FormGuard.blockEnterSubmit();

  // 送信ボタン → 内容の確認ウィンドウ → 「送信する」で send() を実行する
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    showErrors(null);
    const clientErrors = clientValidate();
    if (clientErrors.length) { showErrors(clientErrors); return; }
    const typeLabel = { order: '正式発注', consult: 'かんたん相談' }[currentType()] || '見積・イメージ依頼';
    FormGuard.confirm([
      ['ご依頼種別', typeLabel],
      ['会社/団体名', val('orderer.org_name') || '(未入力)'],
      ['ご担当者名', val('orderer.contact_name') || '(未入力)'],
      ['電話番号', val('orderer.phone') || '(未入力)'],
      ['メールアドレス', $('#ordererEmail').value.trim() || '(未入力)'],
    ], send);
  });

  async function send() {
    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = '送信中...';

    try {
      const { payload, files } = buildPayloadAndFiles();
      // サイズ超過はアップロード完了後にサーバーで弾かれるため、モバイル回線だと
      // 長い待ち時間の末にエラーになる。送信前にチェックして即座に知らせる
      const oversize = files.find(f => f.size > 15 * 1024 * 1024);
      if (oversize) {
        showErrors([{ message: `ファイル「${oversize.name}」が大きすぎます(上限15MB)。サイズを小さくして再度お試しください。` }]);
        return;
      }
      const fd = new FormData();
      fd.append('payload', JSON.stringify(payload));
      fd.append('hp_url', form.hp_url.value || '');
      fd.append('cf-turnstile-response', getTurnstileToken());
      files.forEach(f => fd.append('images', f));

      const resp = await fetch('/order', { method: 'POST', body: fd });
      const data = await resp.json().catch(() => ({}));

      if (resp.ok && data.ok) {
        clearDraft();
        form.hidden = true;
        const done = $('#donePanel');
        done.hidden = false;
        $('#doneMessage').textContent = data.request_type === 'order'
          ? 'ご注文を受け付けました。'
          : data.request_type === 'consult'
            ? 'かんたん相談を受け付けました。担当者よりお電話にてご連絡いたします。'
            : 'お見積り・イメージのご依頼を受け付けました。';
        // 受付番号の表示(honeypot応答等でreceipt_noが無い場合は非表示のまま)
        if (data.receipt_no) {
          $('#doneReceiptNo').textContent = data.receipt_no;
          $('#doneReceipt').hidden = false;
        }
        if (data.receipt_mail) {
          $('#doneMailNote').hidden = false;
        }
        // 画像の保存に一部失敗した場合は「受付完了」と併せて必ず知らせる
        // (黙っているとデザインデータ未着のまま進んでしまうため)
        if (data.image_warning) {
          $('#doneImageWarning').hidden = false;
        }
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
  }
})();
