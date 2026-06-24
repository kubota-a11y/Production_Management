// ========================================
// API層（バックエンド通信）
// ========================================

const API = {
  // ===== 案件関連 =====

  // 全案件取得
  async getAllProjects() {
    const response = await fetch('/api/projects');
    return response.json();
  },

  // 単一案件取得
  async getProject(id) {
    const response = await fetch(`/api/projects/${id}`);
    return response.json();
  },

  // 案件作成
  async createProject(data) {
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return response.json();
  },

  // 案件更新
  async updateProject(id, data) {
    const response = await fetch(`/api/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return response.json();
  },

  // 案件削除
  async deleteProject(id) {
    const response = await fetch(`/api/projects/${id}`, {
      method: 'DELETE'
    });
    return response.json();
  },

  // ===== 担当者関連 =====

  // 全担当者取得
  async getAllStaff() {
    const response = await fetch('/api/staff');
    return response.json();
  },

  // 担当者作成
  async createStaff(data) {
    const response = await fetch('/api/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return response.json();
  },

  // 担当者更新
  async updateStaff(id, data) {
    const response = await fetch(`/api/staff/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return response.json();
  },

  // 担当者削除
  async deleteStaff(id) {
    const response = await fetch(`/api/staff/${id}`, {
      method: 'DELETE'
    });
    return response.json();
  },

  // ===== 統計関連 =====

  // 担当者別作業時間
  async getDailyWorkload(date) {
    const response = await fetch(`/api/stats/daily-workload?date=${date}`);
    return response.json();
  }
};
