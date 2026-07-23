// 取引先 加工依頼フォーム(/partner/{token}/order)。
// 取引先ポータルと同じトークンで、持ち込み品の加工依頼を送る公開フォーム。
// 送信は multipart(payload JSON + images)で POST /api/partner-order/{token}。

const partnerOrder = {
  token: (location.pathname.match(/\/partner\/([^/]+)\/order/) || [])[1] || '',
  rowSeq: 0,

  async init() {
    if (!this.token) return this.showLoadError('URLが正しくありません。担当者にお問い合わせください。');
    try {
      const res = await fetch(`/api/partner-order/${encodeURIComponent(this.token)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) return this.showLoadError(data.error || 'ページの読み込みに失敗しました。');
      const badge = document.getElementById('partnerBadge');
      badge.textContent = `${data.partner_name} 様 専用ページ`;
      badge.hidden = false;
      document.getElementById('leadText').textContent = '持ち込み品の加工依頼をお送りいただけます。指図書の内容をご入力ください。';
      const statusHref = `/partner/${encodeURIComponent(this.token)}`;
      document.getElementById('statusLink').href = statusHref;
      document.getElementById('doneStatusLink').href = statusHref;
      document.getElementById('partnerOrderForm').hidden = false;
      this.addRow();
    } catch (e) {
      this.showLoadError('通信に失敗しました。電波状況をご確認のうえ再度お試しください。');
    }
  },

  showLoadError(msg) {
    const el = document.getElementById('loadError');
    el.textContent = msg;
    el.hidden = false;
  },

  addRow() {
    const n = ++this.rowSeq;
    const container = document.getElementById('procContainer');
    const div = document.createElement('div');
    div.className = 'proc-row';
    div.dataset.row = String(n);
    div.innerHTML = `
      <div class="row-head">
        <span class="row-no">品物 ${document.querySelectorAll('.proc-row').length + 1}</span>
        <button type="button" class="btn-remove item-remove" title="この品物を削除">✕</button>
      </div>
      <div class="grid-proc">
        <label class="field full">品名 <span class="req">必須</span>
          <input type="text" class="p-name" maxlength="200" placeholder="例: 作業着(ブルゾン)">
        </label>
        <label class="field">数量
          <input type="number" class="p-qty" min="1" max="99999" placeholder="例: 20">
        </label>
      </div>
      <div class="proc-sub">
        <div class="proc-sub-label">加工内容(箇所ごと) <span class="req">必須</span></div>
        <div class="proc-list"></div>
        <button type="button" class="btn-add-proc">＋ 加工箇所を追加</button>
      </div>
      <div class="grid-proc">
        <label class="field">加工データの場所 <span class="opt">任意</span>
          <select class="p-dataloc">
            <option value="">(未選択)</option>
            <option value="email">メール</option>
            <option value="line">LINE</option>
            <option value="drive">共有ドライブ</option>
            <option value="other">他</option>
          </select>
        </label>
        <label class="field">データの場所の補足 <span class="opt">任意</span>
          <input type="text" class="p-dataloc-note" maxlength="500" placeholder="例: 共有ドライブ内 八木繊維/2026">
        </label>
      </div>`;
    div.querySelector('.item-remove').onclick = () => { div.remove(); this.renumber(); };
    div.querySelector('.btn-add-proc').onclick = () => this.addProcess(div.querySelector('.proc-list'));
    container.appendChild(div);
    this.addProcess(div.querySelector('.proc-list')); // 初期の加工行を1つ
    this.renumber();
  },

  // 1つの品物に「加工方法+加工箇所+加工内容+色」を追加(同一アイテムの複数箇所加工に対応)
  addProcess(listEl) {
    const p = document.createElement('div');
    p.className = 'proc-item';
    p.innerHTML = `
      <div class="proc-item-head">
        <span class="proc-item-no"></span>
        <button type="button" class="btn-remove proc-item-remove" title="この加工を削除">✕</button>
      </div>
      <div class="grid-proc">
        <label class="field">加工方法 <span class="req">必須</span>
          <select class="pi-method">
            <option value="">選択してください</option>
            <option value="print_auto">プリント(HiYOSHiお任せ)</option>
            <option value="silk">シルクプリント</option>
            <option value="dtf">DTFプリント</option>
            <option value="rubber">ラバープリント</option>
            <option value="embroidery">刺繍</option>
            <option value="cap_embroidery">帽子刺繍</option>
            <option value="other">他</option>
          </select>
        </label>
        <label class="field">加工箇所
          <input type="text" class="pi-location" maxlength="200" placeholder="例: 左胸 / 背中 / 袖">
        </label>
        <label class="field full">加工内容
          <input type="text" class="pi-content" maxlength="500" placeholder="例: 社名ロゴ / 個人名ネーム">
        </label>
        <label class="field">色
          <input type="text" class="pi-color" maxlength="100" placeholder="例: 白 / 指定糸色">
        </label>
      </div>`;
    p.querySelector('.proc-item-remove').onclick = () => { const l = listEl; p.remove(); this.renumberProcesses(l); };
    listEl.appendChild(p);
    this.renumberProcesses(listEl);
  },

  renumber() {
    document.querySelectorAll('.proc-row').forEach((row, i) => {
      row.querySelector('.row-no').textContent = `品物 ${i + 1}`;
    });
  },

  // 加工行の見出し番号を振り直す。1行だけのときは番号を出さない(削除ボタンは残す)
  renumberProcesses(listEl) {
    const rows = listEl.querySelectorAll('.proc-item');
    rows.forEach((r, i) => {
      r.querySelector('.proc-item-no').textContent = rows.length > 1 ? `加工 ${i + 1}` : '';
    });
  },

  collectItems() {
    return Array.from(document.querySelectorAll('.proc-row')).map(row => ({
      item_name: row.querySelector('.p-name').value,
      quantity: row.querySelector('.p-qty').value,
      processes: Array.from(row.querySelectorAll('.proc-item')).map(p => ({
        method: p.querySelector('.pi-method').value,
        location: p.querySelector('.pi-location').value,
        content: p.querySelector('.pi-content').value,
        color: p.querySelector('.pi-color').value,
      })),
      data_location: row.querySelector('.p-dataloc').value,
      data_location_note: row.querySelector('.p-dataloc-note').value,
    }));
  },

  async submit(ev) {
    ev.preventDefault();
    const errBox = document.getElementById('formErrors');
    errBox.hidden = true;
    const btn = document.getElementById('submitBtn');

    const payload = {
      website: document.getElementById('website').value,
      dropoff: {
        date: document.getElementById('dropoffDate').value,
        instruction_no: document.getElementById('instructionNo').value,
        contact_name: document.getElementById('contactName').value,
        phone: document.getElementById('contactPhone').value,
      },
      items: this.collectItems(),
      deadline: {
        date: document.getElementById('deadlineDate').value,
        note: document.getElementById('deadlineNote').value,
      },
      remarks: document.getElementById('remarks').value,
    };

    const fd = new FormData();
    fd.append('payload', JSON.stringify(payload));
    const files = document.getElementById('images').files;
    for (const f of files) fd.append('images', f);

    btn.disabled = true;
    btn.textContent = '送信中…';
    try {
      const res = await fetch(`/api/partner-order/${encodeURIComponent(this.token)}`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        errBox.innerHTML = (data.errors || [{ message: '送信に失敗しました' }]).map(e => e.message).join('<br>');
        errBox.hidden = false;
        errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      document.getElementById('doneReceiptNo').textContent = data.receipt_no || '';
      document.getElementById('partnerOrderForm').hidden = true;
      document.getElementById('donePanel').hidden = false;
      window.scrollTo(0, 0);
    } catch (e) {
      errBox.textContent = '通信に失敗しました。時間をおいて再度お試しください。';
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = '加工依頼を送信する';
    }
  },
};

document.getElementById('partnerOrderForm').addEventListener('submit', ev => partnerOrder.submit(ev));
partnerOrder.init();
