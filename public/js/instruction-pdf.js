// ========================================
// 指示書PDFの紐づけ部品(共有モジュール・2026-09-11)
// 納品モーダル(index.html)と納品履歴の「📎 指示書PDF」モーダルで同じ実装を使う。
//
//   InstructionPdfPicker.load(container, projectId)  … 状況を取りに行って描画する
//   InstructionPdfPicker.getSelection(container)     … { mode, inboxPath, file } / { error }
//   InstructionPdfPicker.save(projectId, selection)  … 受信箱 or アップロードのPDFを案件フォルダへ保存
//
// mode: 'existing'(案件フォルダに既にある) / 'inbox'(受信箱から) / 'upload'(PCから) / 'later'(後で保存する)
// ========================================

const InstructionPdfPicker = {
  _seq: 0,

  async load(container, projectId) {
    container.dataset.projectId = projectId;
    container.innerHTML = '<div class="folder-loading">指示書PDFの状況を確認しています...</div>';
    let status;
    try {
      status = await API.getInstructionPdfStatus(projectId);
      if (status.error) throw new Error(status.error);
    } catch (err) {
      console.error('指示書PDF状況の取得エラー:', err);
      container.innerHTML = '<p class="empty-notice">指示書PDFの状況を確認できませんでした。「後で保存する」で進めてください</p>' + this._laterOnly(container);
      return null;
    }
    this._render(container, status);
    return status;
  },

  _laterOnly(container) {
    const name = this._radioName(container);
    return `
      <div class="pdf-picker">
        <label class="checkbox-pill pdf-picker-option">
          <input type="radio" name="${name}" value="later" checked> ⏳ 後で保存する
        </label>
      </div>`;
  },

  _radioName(container) {
    if (!container.dataset.radioName) {
      this._seq += 1;
      container.dataset.radioName = `pdf_mode_${this._seq}`;
    }
    return container.dataset.radioName;
  },

  _render(container, status) {
    const esc = (t) => this.escapeHtml(t);
    const name = this._radioName(container);
    const hintName = status.receipt_no
      ? `「${esc(status.receipt_no)}」か案件名`
      : '案件名';

    // 既に案件フォルダにある → それで完了。選択肢は出さない
    if (status.existing && status.existing.length > 0) {
      const list = status.existing.map(f =>
        `<li><button type="button" class="btn-small pdf-picker-open" data-path="${esc(f.path)}">📄 ${esc(f.name)}</button></li>`).join('');
      container.innerHTML = `
        <div class="pdf-picker pdf-picker-saved">
          <div class="pdf-picker-status">✅ 案件フォルダに指示書PDFがあります</div>
          <ul class="pdf-picker-list">${list}</ul>
          <input type="hidden" name="${name}" value="existing">
        </div>`;
      container.querySelectorAll('.pdf-picker-open').forEach(btn => {
        btn.addEventListener('click', () => window.open(`/api/nas/download?path=${encodeURIComponent(btn.dataset.path)}`, '_blank'));
      });
      return;
    }

    const files = (status.inbox && status.inbox.files) || [];
    const matched = files.filter(f => f.matched_here);
    const others = files.filter(f => !f.matched_here);
    const optionHtml = (f, star) =>
      `<option value="${esc(f.path)}">${star ? '★ ' : ''}${esc(f.name)}${f.match && !f.matched_here ? `(別案件「${esc(f.match.project_name)}」と一致)` : ''}</option>`;
    const selectHtml = files.length === 0
      ? '<div class="field-hint">受信箱にPDFはありません。iPadのGoodNotesから共有ドライブの「DESIGN/_指示書受信箱」へ書き出すと、ここに出てきます</div>'
      : `<select class="pdf-picker-select" aria-label="受信箱のPDF">
           <option value="">-- 受信箱のPDFを選ぶ --</option>
           ${matched.length ? `<optgroup label="この案件と一致">${matched.map(f => optionHtml(f, true)).join('')}</optgroup>` : ''}
           ${others.length ? `<optgroup label="その他のPDF">${others.map(f => optionHtml(f, false)).join('')}</optgroup>` : ''}
         </select>`;

    const defaultMode = matched.length > 0 ? 'inbox' : 'later';
    container.innerHTML = `
      <div class="pdf-picker">
        <div class="pdf-picker-status">${matched.length > 0
          ? '📥 受信箱にこの案件のPDFがあります。そのまま保存できます'
          : '案件フォルダにまだ指示書PDFがありません'}</div>
        <div class="pdf-picker-option-block">
          <label class="checkbox-pill pdf-picker-option">
            <input type="radio" name="${name}" value="inbox" ${defaultMode === 'inbox' ? 'checked' : ''} ${files.length === 0 ? 'disabled' : ''}> 📥 受信箱から選ぶ
          </label>
          <div class="pdf-picker-detail" data-for="inbox">${selectHtml}</div>
        </div>
        <div class="pdf-picker-option-block">
          <label class="checkbox-pill pdf-picker-option">
            <input type="radio" name="${name}" value="upload"> 💻 このパソコンのPDFを選ぶ
          </label>
          <div class="pdf-picker-detail" data-for="upload">
            <input type="file" class="pdf-picker-file" accept="application/pdf,.pdf" aria-label="指示書PDFファイル">
          </div>
        </div>
        <div class="pdf-picker-option-block">
          <label class="checkbox-pill pdf-picker-option">
            <input type="radio" name="${name}" value="later" ${defaultMode === 'later' ? 'checked' : ''}> ⏳ 後で保存する
          </label>
          <div class="pdf-picker-detail" data-for="later">
            <div class="field-hint">納品履歴に「指示書PDF未保存」として残ります。あとから受信箱か案件フォルダにPDFが入れば自動で消えます</div>
          </div>
        </div>
        <div class="field-hint pdf-picker-hint">
          GoodNotesのノート名に${hintName}を入れて受信箱へ書き出すと、HiBoardが自動でこの案件のフォルダに移します(5分ごと)。
          保存先: ${status.folder_path ? esc(status.folder_path) : '案件フォルダ未設定のため、DESIGN/客先名/年月_案件名 を自動で作ります'}
        </div>
      </div>`;

    // 受信箱のプルダウンで一致ファイルがあれば最初から選んでおく
    const select = container.querySelector('.pdf-picker-select');
    if (select && matched.length > 0) select.value = matched[0].path;

    // プルダウン/ファイル欄を触ったら、そのラジオを選んだことにする(ラジオを別に押す手間を省く)
    const pick = (mode) => {
      const radio = container.querySelector(`input[type="radio"][value="${mode}"]`);
      if (radio && !radio.disabled) radio.checked = true;
    };
    if (select) select.addEventListener('change', () => { if (select.value) pick('inbox'); });
    const fileInput = container.querySelector('.pdf-picker-file');
    if (fileInput) fileInput.addEventListener('change', () => { if (fileInput.files.length) pick('upload'); });
  },

  getSelection(container) {
    const checked = container.querySelector('input[type="radio"]:checked, input[type="hidden"][value="existing"]');
    const mode = checked ? checked.value : 'later';
    if (mode === 'inbox') {
      const select = container.querySelector('.pdf-picker-select');
      const inboxPath = select ? select.value : '';
      if (!inboxPath) return { error: '受信箱のPDFを選んでください' };
      return { mode, inboxPath };
    }
    if (mode === 'upload') {
      const fileInput = container.querySelector('.pdf-picker-file');
      const file = fileInput && fileInput.files[0];
      if (!file) return { error: '保存するPDFファイルを選んでください' };
      return { mode, file };
    }
    return { mode };
  },

  // 受信箱 or アップロードのPDFを案件フォルダへ保存する。existing/later は何もしない
  async save(projectId, selection) {
    if (selection.mode === 'inbox') return API.attachInstructionPdf(projectId, { inboxPath: selection.inboxPath });
    if (selection.mode === 'upload') return API.attachInstructionPdf(projectId, { file: selection.file });
    return { ok: true, skipped: true };
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  },
};
