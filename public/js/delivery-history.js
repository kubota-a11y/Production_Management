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
        <td>${this.escapeHtml(record.project_name)}</td>
        <td>${this.escapeHtml(record.customer_name)}</td>
        <td>${this.escapeHtml(getProcessLabels(record.process_type))}</td>
        <td>${record.quantity ?? '-'}</td>
        <td>${formatDate(record.delivered_date)}</td>
        <td>${this.escapeHtml(record.delivery_method)}</td>
        <td>${this.escapeHtml(deliveredByName)}</td>
        <td class="delivery-actions"></td>
      `;

      const actions = row.querySelector('.delivery-actions');
      if (record.nas_folder_path) {
        const folderBtn = document.createElement('button');
        folderBtn.className = 'btn-small';
        folderBtn.textContent = '📁 フォルダ';
        folderBtn.title = 'デザインフォルダをサーバー機のエクスプローラーで開く';
        folderBtn.addEventListener('click', () => this.openFolder(record.nas_folder_path));
        actions.appendChild(folderBtn);
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

  // ===== NASフォルダを開く =====
  async openFolder(nasPath) {
    try {
      const result = await API.openNasFile(nasPath);
      if (result.error) alert(`フォルダを開けませんでした: ${result.error}`);
    } catch (error) {
      console.error('NASフォルダ表示エラー:', error);
      alert('フォルダを開けませんでした');
    }
  },

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
      if (confirm('新規案件として登録しました。案件管理画面を開きますか?')) {
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
