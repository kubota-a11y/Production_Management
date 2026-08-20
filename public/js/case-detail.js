// ========================================
// 案件詳細モーダル(共有モジュール)
// 「この案件で何をどれだけ加工したか」と、指示書・見積書・請求書への導線を1画面にまとめる。
// 顧客台帳・納品履歴の両ページから使うため、モーダルDOMの生成込みでここに集約する。
// 利用側: CaseDetail.open(projectId) を呼ぶだけでよい
// ========================================

const CaseDetail = {
  // 注文フォーム(print/embroidery/both)と取引先フォーム(silk/dtf等)の両方の値を受ける
  METHOD_LABELS: {
    print: 'プリント',
    embroidery: '刺繍',
    both: 'プリント＋刺繍',
    print_auto: 'プリント(お任せ)',
    silk: 'シルクプリント',
    dtf: 'DTFプリント',
    rubber: 'ラバープリント',
    cap_embroidery: '帽子刺繍',
    other: 'その他',
  },

  DOCUMENT_KIND_LABELS: {
    instruction: '指示書',
    quote: '見積書',
    invoice: '請求書',
    other: 'その他',
  },

  ensureModal() {
    if (document.getElementById('case-detail-modal')) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div id="case-detail-modal" class="modal">
        <div class="modal-content">
          <div class="modal-header">
            <h2 id="case-detail-title">案件詳細</h2>
            <button class="btn-close" onclick="CaseDetail.close()">✕</button>
          </div>
          <div id="case-detail-body"></div>
          <div class="form-actions">
            <button type="button" class="btn btn-primary" onclick="CaseDetail.close()">閉じる</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrapper.firstElementChild);
  },

  async open(projectId) {
    this.ensureModal();
    const body = document.getElementById('case-detail-body');
    body.innerHTML = '<p class="folder-notice">読み込み中…</p>';
    document.getElementById('case-detail-modal').style.display = 'flex';

    try {
      const detail = await API.getProjectDetail(projectId);
      if (!detail || detail.error) {
        // サーバーのエラー文は英語("Project not found"等)なので、そのまま画面に出さない
        console.warn('案件詳細の取得に失敗:', detail?.error);
        body.innerHTML = '<p class="empty-notice">この案件の詳細を表示できませんでした。案件が削除されている可能性があります。</p>';
        return;
      }
      this.render(detail);
    } catch (error) {
      console.error('案件詳細取得エラー:', error);
      body.innerHTML = '<p class="folder-notice">案件詳細の取得に失敗しました</p>';
    }
  },

  close() {
    const modal = document.getElementById('case-detail-modal');
    if (modal) modal.style.display = 'none';
  },

  render(detail) {
    const p = detail.project;
    document.getElementById('case-detail-title').textContent = p.project_name;

    const body = document.getElementById('case-detail-body');
    body.innerHTML = `
      ${this.renderSummary(detail)}
      ${this.renderProcessing(detail)}
      ${this.renderQuotes(detail)}
      ${this.renderDocuments(detail)}
    `;

    // 書類・フォルダのボタンはDOM生成後にイベントを結びつける(パスを属性に埋め込まない)
    body.querySelectorAll('[data-doc-path]').forEach(btn => {
      btn.addEventListener('click', () => window.open(API.getNasFileUrl(btn.dataset.docPath), '_blank'));
    });
    const folderBtn = body.querySelector('[data-open-folder]');
    if (folderBtn) {
      folderBtn.addEventListener('click', () =>
        NasBrowse.open(p.nas_folder_path, `${p.project_name} / ${p.customer_name}`));
    }
  },

  // ===== 基本情報 =====
  renderSummary(detail) {
    const p = detail.project;
    const d = detail.delivery;
    const deliveredBy = d?.delivered_by_staff_name || d?.delivered_by_employee_name || '';
    const rows = [
      ['顧客名', this.escapeHtml(p.customer_name)],
      ['受付日 / 納期', `${formatDate(p.received_date)} → ${formatDate(p.deadline)}`],
      ['ステータス', `<span class="status-badge ${getStatusClass(p.status)}">${getStatusLabel(p.status)}</span>`],
      ['納品', d ? `${formatDate(d.delivered_date)}(${this.escapeHtml(d.delivery_method)}${deliveredBy ? ' / ' + this.escapeHtml(deliveredBy) : ''})` : '—'],
      ['担当', this.escapeHtml(p.assigned_employee_name || p.assigned_staff_name || '未割り当て')],
    ];
    return `
      <div class="case-detail-section">
        <h3>案件情報</h3>
        <table class="case-detail-table">
          ${rows.map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`).join('')}
        </table>
      </div>
    `;
  },

  // ===== 加工詳細 =====
  renderProcessing(detail) {
    const p = detail.project;
    const parts = [`
      <table class="case-detail-table">
        <tr><th>加工種別</th><td>${this.escapeHtml(getProcessLabels(p.process_type)) || '—'}</td></tr>
        <tr><th>数量</th><td>${p.quantity ?? '—'}</td></tr>
        ${p.work_content ? `<tr><th>作業内容</th><td class="case-detail-pre">${this.escapeHtml(p.work_content)}</td></tr>` : ''}
        ${p.memo ? `<tr><th>メモ</th><td class="case-detail-pre">${this.escapeHtml(p.memo)}</td></tr>` : ''}
        ${detail.roster_count > 0 ? `<tr><th>名簿</th><td>${detail.roster_count}名分の登録あり</td></tr>` : ''}
      </table>
    `];

    // 案件直下のプリント箇所(LINE/手動登録の案件はこちらに入る)
    if (detail.print_locations.length > 0) {
      parts.push(`
        <h4>プリント箇所</h4>
        <ul class="case-detail-list">
          ${detail.print_locations.map(l =>
            `<li>${this.escapeHtml(l.location_name)} … ${l.color_count}色</li>`).join('')}
        </ul>
      `);
    }

    // Web注文フォーム由来のアイテム明細(品物ごとの仕様・数量内訳)
    if (detail.items.length > 0) {
      parts.push(detail.items.map(item => this.renderItem(item)).join(''));
    }

    if (detail.items.length === 0 && detail.print_locations.length === 0 && !p.work_content) {
      parts.push('<p class="folder-notice">この案件には加工の詳細データが登録されていません(指示書PDFをご確認ください)</p>');
    }

    return `<div class="case-detail-section"><h3>加工詳細</h3>${parts.join('')}</div>`;
  },

  renderItem(item) {
    const name = [item.category, item.sub_category].filter(Boolean).join(' / ')
      || (item.catalog_items[0]?.catalog_number ? `品番 ${item.catalog_items[0].catalog_number}` : '品物');
    const method = this.METHOD_LABELS[item.method] || item.method || '';

    const catalogRows = item.catalog_items
      .map(c => [c.catalog_number, c.color, c.maker].filter(Boolean).join(' / '))
      .filter(Boolean);

    // サイズ×色ごとの数量内訳(注文フォームのマトリクス)
    const cells = item.matrix?.cells || [];

    return `
      <div class="case-detail-item">
        <h4>アイテム${item.item_no}: ${this.escapeHtml(name)}${method ? ` <span class="case-detail-chip">${this.escapeHtml(method)}</span>` : ''}</h4>
        <table class="case-detail-table">
          <tr><th>数量</th><td>${item.quantity_total || 0}</td></tr>
          ${catalogRows.length > 0 ? `<tr><th>品番</th><td>${catalogRows.map(r => this.escapeHtml(r)).join('<br>')}</td></tr>` : ''}
          ${item.print_locations.length > 0 ? `<tr><th>プリント箇所</th><td>${item.print_locations.map(l =>
            `${this.escapeHtml(l.location_name)} … ${l.color_count}色`).join('<br>')}</td></tr>` : ''}
        </table>
        ${cells.length > 0 ? `
          <table class="case-detail-table case-detail-matrix">
            <thead><tr><th>サイズ</th><th>カラー</th><th>枚数</th></tr></thead>
            <tbody>
              ${cells.map(c => `<tr>
                <td>${this.escapeHtml(c.size || '-')}</td>
                <td>${this.escapeHtml(c.color || '-')}</td>
                <td>${c.qty ?? '-'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        ` : ''}
      </div>
    `;
  },

  // ===== 概算の履歴(見積シミュレーターで記録したもの・新しい順) =====
  renderQuotes(detail) {
    const p = detail.project;
    const quotes = detail.quotes || [];
    const rows = quotes.map(q => {
      const date = (q.created_at || '').slice(0, 10);
      const extras = [q.discount_name, q.approved_by ? `承認: ${q.approved_by}` : '']
        .filter(Boolean).join(' / ');
      return `<li>${this.escapeHtml(date)}　<b>${Number(q.total).toLocaleString()}円</b>${extras ? `　<span class="case-quote-extra">${this.escapeHtml(extras)}</span>` : ''}</li>`;
    }).join('');
    return `
      <div class="case-detail-section">
        <h3>概算の履歴</h3>
        ${quotes.length ? `<ul class="case-quote-list">${rows}</ul>`
          : '<p class="folder-notice">この案件にはまだ概算が記録されていません</p>'}
        <a class="btn-small" href="/quote-sim?case=${p.id}">💴 見積シミュレーターで見積を作る</a>
      </div>
    `;
  },

  // ===== 書類(指示書・見積書・請求書・フォルダ) =====
  renderDocuments(detail) {
    const p = detail.project;
    const buttons = [];

    // NASフォルダから拾った書類。指示書→見積書→請求書→その他の順にサーバー側で並んでいる
    detail.documents.forEach(doc => {
      const kindLabel = this.DOCUMENT_KIND_LABELS[doc.kind];
      const prefix = doc.kind === 'other' ? '📎' : '📄';
      const label = doc.kind === 'other' ? doc.name : `${kindLabel}: ${doc.name}`;
      buttons.push(`<button type="button" class="btn-small" data-doc-path="${this.escapeHtml(doc.path)}">${prefix} ${this.escapeHtml(label)}</button>`);
    });

    if (p.freee_quote_url) {
      buttons.push(`<a class="btn-small" href="${this.escapeHtml(p.freee_quote_url)}" target="_blank" rel="noopener">📄 見積書(Freee)</a>`);
    }
    if (p.freee_invoice_url) {
      buttons.push(`<a class="btn-small" href="${this.escapeHtml(p.freee_invoice_url)}" target="_blank" rel="noopener">📄 請求書(Freee)</a>`);
    }
    if (p.nas_folder_path) {
      buttons.push('<button type="button" class="btn-small" data-open-folder="1">📁 案件フォルダを開く</button>');
    }

    let notice = '';
    if (!p.nas_folder_path) {
      notice = '<p class="folder-notice">この案件には共有ドライブのフォルダが設定されていません</p>';
    } else if (detail.documents.length === 0) {
      notice = '<p class="folder-notice">フォルダ内にPDF・画像が見つかりませんでした(指示書PDFが未保存の可能性があります)</p>';
    } else if (detail.documents_truncated) {
      notice = '<p class="folder-notice">ファイルが多いため一部のみ表示しています。すべて見るには「📁 案件フォルダを開く」から確認してください</p>';
    }

    return `
      <div class="case-detail-section">
        <h3>書類</h3>
        <div class="case-detail-docs">${buttons.join('')}</div>
        ${notice}
      </div>
    `;
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  },
};
