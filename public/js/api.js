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

  // ===== 案件ごとの作業計画 =====

  // 案件の作業計画一覧取得（日付順）
  async getTimeAllocations(projectId) {
    const response = await fetch(`/api/projects/${projectId}/time-allocations`);
    return response.json();
  },

  // 作業計画作成
  async createTimeAllocation(projectId, data) {
    const response = await fetch(`/api/projects/${projectId}/time-allocations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return response.json();
  },

  // 作業計画更新
  async updateTimeAllocation(id, data) {
    const response = await fetch(`/api/time-allocations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return response.json();
  },

  // 作業計画削除
  async deleteTimeAllocation(id) {
    const response = await fetch(`/api/time-allocations/${id}`, {
      method: 'DELETE'
    });
    return response.json();
  },

  // ===== 従業員関連 =====

  // 全従業員取得（有効・無効を問わず全件）
  async getAllEmployees() {
    const response = await fetch('/api/employees');
    return response.json();
  },

  // 単一従業員取得（固定勤務スケジュール込み）
  async getEmployee(id) {
    const response = await fetch(`/api/employees/${id}`);
    return response.json();
  },

  // 従業員作成
  async createEmployee(data) {
    const response = await fetch('/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return response.json();
  },

  // 従業員更新
  async updateEmployee(id, data) {
    const response = await fetch(`/api/employees/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return response.json();
  },

  // 従業員を無効化（論理削除）
  async deactivateEmployee(id) {
    const response = await fetch(`/api/employees/${id}`, {
      method: 'DELETE'
    });
    return response.json();
  },

  // ===== NAS関連 =====

  // NASフォルダ内のファイル一覧を取得
  async getNasList(path) {
    const response = await fetch(`/api/nas/list?path=${encodeURIComponent(path)}`);
    return response.json();
  },

  // NASファイルをFinderで開く（サーバーを動かしている端末上でのみ有効）
  async openNasFile(path) {
    const response = await fetch('/api/nas/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    });
    return response.json();
  },

  // NASファイルをブラウザで開く/ダウンロードするためのURL（どの端末からでも利用可）
  getNasFileUrl(path) {
    return `/api/nas/download?path=${encodeURIComponent(path)}`;
  },

  // ===== 統計関連 =====

  // 担当者別作業時間
  async getDailyWorkload(date) {
    const response = await fetch(`/api/stats/daily-workload?date=${date}`);
    return response.json();
  },

};
