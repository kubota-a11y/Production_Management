// ========================================
// 納品履歴ページ ロジック
// ========================================

const deliveryHistoryApp = {
  // ===== ステート =====
  records: [],

  // ===== 初期化 =====
  async init() {
    console.log('🚀 納品履歴ページ初期化中...');
    await this.loadRecords();
    this.renderTable();
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

  // ===== 一覧表示 =====
  renderTable() {
    const tbody = document.getElementById('delivery-history-tbody');
    tbody.innerHTML = '';

    if (this.records.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="folder-notice" style="text-align: center;">納品履歴はありません</td></tr>';
      return;
    }

    this.records.forEach(record => {
      const deliveredByName = record.delivered_by_staff_name || record.delivered_by_employee_name || '-';
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${this.escapeHtml(record.project_name)}</td>
        <td>${formatDate(record.delivered_date)}</td>
        <td>${this.escapeHtml(record.delivery_method)}</td>
        <td>${this.escapeHtml(deliveredByName)}</td>
      `;
      tbody.appendChild(row);
    });
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
