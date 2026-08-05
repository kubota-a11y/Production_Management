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
      document.getElementById('leadText').textContent = '持ち込み品の加工依頼をお送りいただけます。まずご依頼の種類をお選びください。';
      const statusHref = `/partner/${encodeURIComponent(this.token)}`;
      // 種別の選択画面・両フォーム・送信完了画面のどこからでも納期確認ページへ行けるようにする
      document.getElementById('c_statusLink').href = statusHref;
      document.getElementById('statusLink').href = statusHref;
      document.getElementById('a_statusLink').href = statusHref;
      document.getElementById('doneStatusLink').href = statusHref;
      document.getElementById('typeChooser').hidden = false;
    } catch (e) {
      this.showLoadError('通信に失敗しました。電波状況をご確認のうえ再度お試しください。');
    }
  },

  showLoadError(msg) {
    const el = document.getElementById('loadError');
    el.textContent = msg;
    el.hidden = false;
  },

  // 案件種別の選択 → 対応するフォームを表示
  chooseType(type) {
    document.getElementById('typeChooser').hidden = true;
    if (type === 'additional') {
      document.getElementById('additionalForm').hidden = false;
      document.getElementById('a_contactName').focus();
    } else {
      const form = document.getElementById('partnerOrderForm');
      form.hidden = false;
      // 初回だけ品物行を1つ用意(戻る→新規で二重に増やさない)
      if (!document.querySelector('.proc-row')) this.addRow();
    }
  },

  // 種別の選択画面に戻る(入力はそのまま保持)
  backToChooser() {
    document.getElementById('additionalForm').hidden = true;
    document.getElementById('partnerOrderForm').hidden = true;
    document.getElementById('formErrors').hidden = true;
    document.getElementById('a_formErrors').hidden = true;
    document.getElementById('typeChooser').hidden = false;
    window.scrollTo(0, 0);
  },

  // 送信完了画面から、続けて次の依頼を入力する。
  // 1件ごとにページを開き直す手間をなくすため、入力欄を空に戻して指定の種別のフォームを出す
  continueEntry(type) {
    this.resetForms();
    document.getElementById('donePanel').hidden = true;
    document.getElementById('typeChooser').hidden = true;
    this.chooseType(type);
    window.scrollTo(0, 0);
  },

  // 両方のフォームを未入力の状態に戻す。
  // ご担当者名・電話番号・メールアドレスは同じ方が続けて入力するため引き継ぐ
  // (引き継ぐ旨は完了画面に明記している)。品物行・添付ファイルは必ず消す
  resetForms() {
    const val = id => document.getElementById(id).value.trim();
    const keep = {
      name: val('contactName') || val('a_contactName'),
      phone: val('contactPhone') || val('a_contactPhone'),
      email: val('contactEmail') || val('a_contactEmail'),
    };

    // reset() で入力値と添付ファイル(file input)を既定値に戻す
    document.getElementById('partnerOrderForm').reset();
    document.getElementById('additionalForm').reset();

    // 動的に足した品物行は reset() では消えないため、明示的に作り直す
    document.getElementById('procContainer').innerHTML = '';
    this.rowSeq = 0;

    document.getElementById('formErrors').hidden = true;
    document.getElementById('a_formErrors').hidden = true;

    document.getElementById('contactName').value = keep.name;
    document.getElementById('contactPhone').value = keep.phone;
    document.getElementById('contactEmail').value = keep.email;
    document.getElementById('a_contactName').value = keep.name;
    document.getElementById('a_contactPhone').value = keep.phone;
    document.getElementById('a_contactEmail').value = keep.email;
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

  // 新規案件: 送信ボタン押下 → 確認ウィンドウを出すところまで。実送信は sendNew()
  submit(ev) {
    ev.preventDefault();
    const errBox0 = document.getElementById('formErrors');
    errBox0.hidden = true;
    const items = this.collectItems();
    // サイズ超過はアップロード後にしか分からないと待ち時間が無駄になるため送信前に確認
    const oversize = Array.from(document.getElementById('images').files).find(f => f.size > 15 * 1024 * 1024);
    if (oversize) {
      errBox0.textContent = `ファイル「${oversize.name}」が大きすぎます(上限15MB)。サイズを小さくして再度お試しください。`;
      errBox0.hidden = false;
      errBox0.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const fileCount = document.getElementById('images').files.length;
    FormGuard.confirm([
      ['ご担当者名', document.getElementById('contactName').value || '(未入力)'],
      ['メールアドレス', document.getElementById('contactEmail').value || '(未入力)'],
      ['持ち込み予定', document.getElementById('dropoffDate').value || '(未入力)'],
      ['指図書番号', document.getElementById('instructionNo').value || '(なし)'],
      ['品物', items.length ? `${items.length}点` : '(未入力)'],
      ['希望納期', document.getElementById('deadlineDate').value || document.getElementById('deadlineNote').value || '(指定なし)'],
      ['添付ファイル', fileCount ? `${fileCount}点` : '(なし)'],
    ], () => this.sendNew());
  },

  async sendNew() {
    const errBox = document.getElementById('formErrors');
    errBox.hidden = true;
    const btn = document.getElementById('submitBtn');

    const payload = {
      order_type: 'new',
      website: document.getElementById('website').value,
      dropoff: {
        date: document.getElementById('dropoffDate').value,
        instruction_no: document.getElementById('instructionNo').value,
        contact_name: document.getElementById('contactName').value,
        phone: document.getElementById('contactPhone').value,
        email: document.getElementById('contactEmail').value,
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
        // サーバーのエラーメッセージにはアップロードファイル名等が入ることがあるため、
        // innerHTMLではなくtextContentで表示する(改行はwhite-spaceで表現)
        errBox.textContent = (data.errors || [{ message: '送信に失敗しました' }]).map(e => e.message).join('\n');
        errBox.style.whiteSpace = 'pre-line';
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

  // 追加案件(簡易版): 必須チェックを済ませてから確認ウィンドウを出す。実送信は sendAdditional()
  submitAdditional(ev) {
    ev.preventDefault();
    const errBox = document.getElementById('a_formErrors');
    errBox.hidden = true;

    // 送信前の軽いチェック(本チェックはサーバー側でも実施)
    const contactName = document.getElementById('a_contactName').value.trim();
    const files = document.getElementById('a_images').files;
    const clientErrors = [];
    if (!contactName) clientErrors.push('ご担当者名を入力してください');
    if (!files.length) clientErrors.push('指図書の添付が必須です(写真またはPDF)');
    const oversizeA = Array.from(files).find(f => f.size > 15 * 1024 * 1024);
    if (oversizeA) clientErrors.push(`ファイル「${oversizeA.name}」が大きすぎます(上限15MB)`);
    if (clientErrors.length) {
      // ファイル名が混ざるためinnerHTMLではなくtextContentで表示
      errBox.textContent = clientErrors.join('\n');
      errBox.style.whiteSpace = 'pre-line';
      errBox.hidden = false;
      errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    FormGuard.confirm([
      ['ご担当者名', contactName],
      ['メールアドレス', document.getElementById('a_contactEmail').value || '(未入力)'],
      ['指図書番号', document.getElementById('a_instructionNo').value || '(なし)'],
      ['指図書の添付', `${files.length}点`],
      ['希望納期', document.getElementById('a_deadlineDate').value || document.getElementById('a_deadlineNote').value || '(指定なし)'],
    ], () => this.sendAdditional());
  },

  async sendAdditional() {
    const errBox = document.getElementById('a_formErrors');
    errBox.hidden = true;
    const btn = document.getElementById('a_submitBtn');
    const contactName = document.getElementById('a_contactName').value.trim();
    const files = document.getElementById('a_images').files;

    const payload = {
      order_type: 'additional',
      website: document.getElementById('a_website').value,
      dropoff: {
        contact_name: contactName,
        phone: document.getElementById('a_contactPhone').value,
        email: document.getElementById('a_contactEmail').value,
        instruction_no: document.getElementById('a_instructionNo').value,
      },
      deadline: {
        date: document.getElementById('a_deadlineDate').value,
        note: document.getElementById('a_deadlineNote').value,
      },
      remarks: document.getElementById('a_remarks').value,
    };

    const fd = new FormData();
    fd.append('payload', JSON.stringify(payload));
    for (const f of files) fd.append('images', f);

    btn.disabled = true;
    btn.textContent = '送信中…';
    try {
      const res = await fetch(`/api/partner-order/${encodeURIComponent(this.token)}`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        // サーバーのエラーメッセージにはアップロードファイル名等が入ることがあるため、
        // innerHTMLではなくtextContentで表示する(改行はwhite-spaceで表現)
        errBox.textContent = (data.errors || [{ message: '送信に失敗しました' }]).map(e => e.message).join('\n');
        errBox.style.whiteSpace = 'pre-line';
        errBox.hidden = false;
        errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      document.getElementById('doneReceiptNo').textContent = data.receipt_no || '';
      document.getElementById('additionalForm').hidden = true;
      document.getElementById('donePanel').hidden = false;
      window.scrollTo(0, 0);
    } catch (e) {
      errBox.textContent = '通信に失敗しました。時間をおいて再度お試しください。';
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = '追加案件を送信する';
    }
  },
};

document.getElementById('partnerOrderForm').addEventListener('submit', ev => partnerOrder.submit(ev));
document.getElementById('additionalForm').addEventListener('submit', ev => partnerOrder.submitAdditional(ev));

// 入力途中のEnterキーによる誤送信を防ぐ(送信は必ずボタン→確認ウィンドウ経由で行う)
FormGuard.blockEnterSubmit();

partnerOrder.init();
