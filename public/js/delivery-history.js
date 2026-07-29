// ========================================
// 納品履歴ページ ロジック
// 過去案件の検索と「この案件をもとに新規作成」(リピート注文)もここで行う
// ========================================

const deliveryHistoryApp = {
  // ===== ステート =====
  records: [],
  searchQuery: '',
  duplicateSource: null,

  // ===== 初期化 =====
  async init() {
    console.log('🚀 納品履歴ページ初期化中...');
    await this.loadRecords();
    this.renderTable();
    this.setupEvents();
    console.log('✓ 初期化完了');
  },

  async loadRecords() {
    try {
      this.records = await API.getDeliveryRecords();
    } catch (error) {
      console.error('納品履歴取得エラー:', error);
      alert('納品履歴の取得に失敗しました');
    }
  },

  setupEvents() {
    document.getElementById('delivery-search').addEventListener('input', (e) => {
      this.searchQuery = e.target.value.trim();
      this.renderTable();
    });

    document.getElementById('duplicate-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitDuplicate();
    });

    // モーダルの背景クリックで閉じる(project-modal等と同じ挙動)
    document.getElementById('duplicate-modal').addEventListener('click', (e) => {
      if (e.target.id === 'duplicate-modal') this.closeDuplicateModal();
    });
  },

  // ===== 検索 =====
  filteredRecords() {
    if (!this.searchQuery) return this.records;
    const q = this.searchQuery.toLowerCase();
    return this.records.filter(r =>
      (r.customer_name || '').toLowerCase().includes(q) ||
      (r.project_name || '').toLowerCase().includes(q)
    );
  },

  // ===== 一覧表示 =====
  renderTable() {
    const tbody = document.getElementById('delivery-history-tbody');
    tbody.innerHTML = '';

    const records = this.filteredRecords();
    const countEl = document.getElementById('delivery-search-count');
    countEl.textContent = this.searchQuery ? `${records.length}件ヒット` : `全${this.records.length}件`;

    if (records.length === 0) {
      const message = this.searchQuery ? '検索条件に合う納品履歴はありません' : '納品履歴はありません';
      tbody.innerHTML = `<tr><td colspan="8" class="folder-notice" style="text-align: center;">${message}</td></tr>`;
      return;
    }

    records.forEach(record => {
      const deliveredByName = record.delivered_by_staff_name || record.delivered_by_employee_name || '-';
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><a href="#" class="case-detail-link">${this.escapeHtml(record.project_name)}</a></td>
        <td>${this.escapeHtml(record.customer_name)}</td>
        <td>${this.escapeHtml(getProcessLabels(record.process_type))}</td>
        <td>${record.quantity ?? '-'}</td>
        <td>${formatDate(record.delivered_date)}</td>
        <td>${this.escapeHtml(record.delivery_method)}</td>
        <td>${this.escapeHtml(deliveredByName)}</td>
        <td class="delivery-actions"></td>
      `;

      // 案件名クリックでも詳細を開けるようにする(操作列の「🔍 詳細」と同じ)
      row.querySelector('.case-detail-link').addEventListener('click', (e) => {
        e.preventDefault();
        CaseDetail.open(record.case_id);
      });

      const actions = row.querySelector('.delivery-actions');
      const detailBtn = document.createElement('button');
      detailBtn.className = 'btn-small';
      detailBtn.textContent = '🔍 詳細';
      detailBtn.title = '加工内容・指示書・見積書/請求書をまとめて見る';
      detailBtn.addEventListener('click', () => CaseDetail.open(record.case_id));
      actions.appendChild(detailBtn);

      if (record.nas_folder_path) {
        const folderBtn = document.createElement('button');
        folderBtn.className = 'btn-small';
        folderBtn.textContent = '📁 フォルダ';
        folderBtn.title = '案件フォルダの中身(指示書PDF・入稿データ等)をブラウザで見る';
        folderBtn.addEventListener('click', () =>
          NasBrowse.open(record.nas_folder_path, `${record.project_name} / ${record.customer_name}`));
        actions.appendChild(folderBtn);
      }
      if (record.freee_quote_url) {
        const quoteBtn = document.createElement('button');
        quoteBtn.className = 'btn-small';
        quoteBtn.textContent = '📄 見積書';
        quoteBtn.title = 'Freeeの見積書画面を開く';
        quoteBtn.addEventListener('click', () => window.open(record.freee_quote_url, '_blank'));
        actions.appendChild(quoteBtn);
      }
      if (record.freee_invoice_url) {
        const invoiceBtn = document.createElement('button');
        invoiceBtn.className = 'btn-small';
        invoiceBtn.textContent = '📄 請求書';
        invoiceBtn.title = 'Freeeの請求書画面を開く';
        invoiceBtn.addEventListener('click', () => window.open(record.freee_invoice_url, '_blank'));
        actions.appendChild(invoiceBtn);
      }
      const dupBtn = document.createElement('button');
      dupBtn.className = 'btn-small';
      dupBtn.textContent = '↻ 再注文';
      dupBtn.title = 'この案件をもとに新規案件を作成';
      dupBtn.addEventListener('click', () => this.openDuplicateModal(record));
      actions.appendChild(dupBtn);

      tbody.appendChild(row);
    });
  },

  // ===== 案件フォルダ閲覧 =====
  // モーダル本体は js/nas-browse.js の共有モジュール(NasBrowse)に集約(顧客台帳と共用)

  // ===== リピート注文(複製) =====
  openDuplicateModal(record) {
    this.duplicateSource = record;
    const form = document.getElementById('duplicate-form');
    form.reset();
    form.elements['project_name'].value = record.project_name || '';
    form.elements['quantity'].value = record.quantity || 1;
    document.getElementById('duplicate-source-info').textContent =
      `元案件: ${record.project_name} / ${record.customer_name} (納品日 ${formatDate(record.delivered_date)})`;
    document.getElementById('duplicate-modal').style.display = 'flex';
  },

  closeDuplicateModal() {
    this.duplicateSource = null;
    document.getElementById('duplicate-modal').style.display = 'none';
  },

  async submitDuplicate() {
    if (!this.duplicateSource) return;
    const form = document.getElementById('duplicate-form');
    const data = {
      project_name: form.elements['project_name'].value.trim(),
      deadline: form.elements['deadline'].value,
      quantity: parseInt(form.elements['quantity'].value, 10),
    };
    try {
      const result = await API.duplicateProject(this.duplicateSource.case_id, data);
      if (result.error) {
        alert(`登録に失敗しました: ${result.error}`);
        return;
      }
      this.closeDuplicateModal();
      if (confirm('新規案件として登録しました。HiBoardの画面を開きますか?')) {
        window.location.href = '/';
      }
    } catch (error) {
      console.error('複製エラー:', error);
      alert('登録に失敗しました');
    }
  },

  // ===== ユーティリティ =====
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  }
};

// ===== イベントリスナー =====
document.addEventListener('DOMContentLoaded', () => {
  deliveryHistoryApp.init();
});
