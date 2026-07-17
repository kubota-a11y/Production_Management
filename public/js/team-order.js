// チーム追加注文フォーム(/team/{token})のクライアント処理。
// トークンをURLから取り、/api/team-order/{token} でチーム名・アイテムを取得して描画する。
(() => {
  'use strict';
  const $ = (sel, el = document) => el.querySelector(sel);

  const token = location.pathname.split('/').filter(Boolean).pop();
  let linkData = null;

  const yen = n => `${Number(n).toLocaleString('ja-JP')}円`;

  // ===== 行の生成 =====
  function addRow(itemCard) {
    const item = linkData.items.find(it => it.id === Number(itemCard.dataset.itemId));
    const row = document.createElement('div');
    row.className = 'row-line team-row';

    const nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.maxLength = 50; nameIn.placeholder = '名前(任意)'; nameIn.className = 'r-name';
    const numIn = document.createElement('input');
    numIn.type = 'text'; numIn.maxLength = 20; numIn.placeholder = '背番号(任意)'; numIn.className = 'r-number';

    let sizeIn;
    if (item.size_options.length) {
      sizeIn = document.createElement('select');
      sizeIn.className = 'r-size';
      sizeIn.innerHTML = '<option value="">サイズ</option>' +
        item.size_options.map(sz => `<option>${sz.replace(/</g, '&lt;')}</option>`).join('');
    } else {
      sizeIn = document.createElement('input');
      sizeIn.type = 'text'; sizeIn.maxLength = 20; sizeIn.placeholder = 'サイズ'; sizeIn.className = 'r-size';
    }

    const qtyIn = document.createElement('input');
    qtyIn.type = 'number'; qtyIn.min = '1'; qtyIn.max = '999'; qtyIn.value = '1'; qtyIn.className = 'r-qty';
    qtyIn.addEventListener('input', updateTotal);

    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'btn-del'; delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => { row.remove(); updateTotal(); });

    row.append(nameIn, numIn, sizeIn, qtyIn, delBtn);
    $('.rows', itemCard).appendChild(row);
    updateTotal();
  }

  // ===== アイテムカードの描画 =====
  function renderItems() {
    const container = $('#itemsContainer');
    container.innerHTML = '';
    linkData.items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'item-card';
      card.dataset.itemId = item.id;

      const head = document.createElement('div');
      head.className = 'item-head';
      const title = document.createElement('h3');
      title.className = 'item-title';
      title.textContent = item.item_name;
      head.appendChild(title);
      if (item.unit_price !== null) {
        const price = document.createElement('span');
        price.className = 'item-price';
        price.textContent = `参考単価 ${yen(item.unit_price)}`;
        head.appendChild(price);
      }
      card.appendChild(head);

      const rowHead = document.createElement('div');
      rowHead.className = 'team-row-head';
      rowHead.innerHTML = '<span>名前(任意)</span><span>背番号(任意)</span><span>サイズ</span><span>枚数</span><span></span>';
      card.appendChild(rowHead);

      const rows = document.createElement('div');
      rows.className = 'rows';
      card.appendChild(rows);

      const addBtn = document.createElement('button');
      addBtn.type = 'button'; addBtn.className = 'btn-add'; addBtn.textContent = '＋ この商品の行を追加';
      addBtn.addEventListener('click', () => addRow(card));
      card.appendChild(addBtn);

      container.appendChild(card);
    });
  }

  // ===== 行の収集と参考合計 =====
  function collectLines() {
    const lines = [];
    document.querySelectorAll('#itemsContainer .item-card').forEach(card => {
      const itemId = Number(card.dataset.itemId);
      card.querySelectorAll('.row-line').forEach(row => {
        const size = $('.r-size', row).value.trim();
        const qty = parseInt($('.r-qty', row).value, 10);
        const name = $('.r-name', row).value.trim();
        const number = $('.r-number', row).value.trim();
        if (!size && !name && !number && !(qty >= 1)) return; // 完全空行はスキップ
        lines.push({ item_id: itemId, name, number, size, qty: Number.isInteger(qty) ? qty : 0 });
      });
    });
    return lines;
  }

  function updateTotal() {
    const box = $('#totalBox');
    let total = 0;
    let hasUnpriced = false;
    let anyLine = false;
    collectLines().forEach(line => {
      anyLine = true;
      const item = linkData.items.find(it => it.id === line.item_id);
      if (!item || !(line.qty >= 1)) return;
      if (item.unit_price !== null) total += item.unit_price * line.qty;
      else hasUnpriced = true;
    });
    if (!anyLine || total === 0) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `参考合計: ${yen(total)}${hasUnpriced ? '(単価未設定のアイテムを除く)' : ''}` +
      '<small>※参考価格です。正式な金額は受付後に担当者よりご案内します。</small>';
  }

  // ===== エラー表示 =====
  function showErrors(list) {
    const box = $('#formErrors');
    if (!list || !list.length) { box.hidden = true; return; }
    box.innerHTML = '<strong>入力内容をご確認ください</strong><ul>' +
      list.map(e => `<li>${String(e.message || e).replace(/</g, '&lt;')}</li>`).join('') + '</ul>';
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ===== 送信 =====
  async function submit(ev) {
    ev.preventDefault();
    const lines = collectLines();
    const payload = {
      website: document.querySelector('input[name="website"]').value,
      orderer: {
        contact_name: $('#contactName').value,
        phone: $('#contactPhone').value,
        email: $('#contactEmail').value,
      },
      lines,
      deadline: { date: $('#deadlineDate').value, note: $('#deadlineNote').value },
      remarks: $('#remarks').value,
    };

    const btn = $('#submitBtn');
    btn.disabled = true; btn.textContent = '送信中…';
    try {
      const res = await fetch(`/api/team-order/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showErrors(data.errors || [{ message: '送信に失敗しました。時間をおいてお試しください。' }]);
        return;
      }
      $('#teamOrderForm').hidden = true;
      $('#doneReceiptNo').textContent = data.receipt_no;
      if (data.total_label) {
        const t = $('#doneTotal');
        t.textContent = `参考合計金額: ${data.total_label} ※正式な金額は改めてご案内します`;
        t.hidden = false;
      }
      if (payload.orderer.email.trim()) $('#doneMailNote').hidden = false;
      $('#donePanel').hidden = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      showErrors([{ message: '通信エラーが発生しました。電波状況をご確認のうえお試しください。' }]);
    } finally {
      btn.disabled = false; btn.textContent = '注文を送信する';
    }
  }

  // ===== 初期化 =====
  async function init() {
    try {
      const res = await fetch(`/api/team-order/${encodeURIComponent(token)}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        $('#leadText').textContent = '';
        const box = $('#loadError');
        box.textContent = data.error || 'このページは現在ご利用いただけません。';
        box.hidden = false;
        return;
      }
      linkData = data;
      const badge = $('#teamBadge');
      badge.textContent = `${data.team_name} 様 専用ページ`;
      badge.hidden = false;
      $('#leadText').textContent = 'ご登録済みのアイテムから、追加分をご注文いただけます。';
      renderItems();
      // 各アイテムに最初の1行を用意しておく
      document.querySelectorAll('#itemsContainer .item-card').forEach(card => addRow(card));

      // 納期のカレンダー下限(本日+リードタイム)
      const min = new Date();
      min.setDate(min.getDate() + window.MIN_LEAD_DAYS);
      $('#deadlineDate').min = min.toISOString().slice(0, 10);

      $('#teamOrderForm').hidden = false;
      $('#teamOrderForm').addEventListener('submit', submit);
    } catch {
      $('#leadText').textContent = '';
      const box = $('#loadError');
      box.textContent = '読み込みに失敗しました。時間をおいて再度お試しください。';
      box.hidden = false;
    }
  }

  init();
})();
