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

  // 担当者候補モーダルから特定の担当者を割り当てる(作業時間もcase_time_allocationsへ登録される)
  async assignEmployee(id, employeeId) {
    const response = await fetch(`/api/projects/${id}/assign-employee`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: employeeId })
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

  // 案件を納品済みにする(納品日・発送方法・納品者を記録し、statusをCOMPLETEDへ)
  async deliverProject(id, data) {
    const response = await fetch(`/api/projects/${id}/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return response.json();
  },

  // 納品履歴一覧取得
  async getDeliveryRecords() {
    const response = await fetch('/api/delivery-records');
    return response.json();
  },

  // 案件のプリント箇所を取得
  async getPrintLocations(id) {
    const response = await fetch(`/api/projects/${id}/print-locations`);
    return response.json();
  },

  // 案件のプリント箇所を一括更新
  async savePrintLocations(id, locations) {
    const response = await fetch(`/api/projects/${id}/print-locations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations })
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

  // ===== 準備項目 =====

  // 準備項目マスター一覧取得
  async getPreparationItemsMaster() {
    const response = await fetch('/api/preparation-items/master');
    return response.json();
  },

  // 案件への準備項目タスク一括登録(既存分はスキップされる)
  async registerCasePreparationItems(projectId, preparationItemIds) {
    const response = await fetch(`/api/projects/${projectId}/preparation-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preparation_item_ids: preparationItemIds })
    });
    return response.json();
  },

  // 準備項目タスク一覧取得(paramsは { case_id, start, end, date, staff_id, unassigned } のうち任意の組み合わせ)
  async getPreparationItems(params = {}) {
    const query = new URLSearchParams(params).toString();
    const response = await fetch(`/api/preparation-items${query ? `?${query}` : ''}`);
    return response.json();
  },

  // 準備項目タスクの担当者・予定日・工数・ステータス更新
  async updatePreparationItem(id, data) {
    const response = await fetch(`/api/preparation-items/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return response.json();
  },

  // 準備項目タスクの完了
  async completePreparationItem(id) {
    const response = await fetch(`/api/preparation-items/${id}/complete`, { method: 'PUT' });
    return response.json();
  },

  // 準備項目タスクの完了取り消し
  async incompletePreparationItem(id) {
    const response = await fetch(`/api/preparation-items/${id}/incomplete`, { method: 'PUT' });
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

  // 従業員の曜日ごとの標準勤務パターンを取得
  async getEmployeeDefaultSchedule(id) {
    const response = await fetch(`/api/employees/${id}/default-schedule`);
    return response.json();
  },

  // 従業員の曜日ごとの標準勤務パターンを一括更新
  async saveEmployeeDefaultSchedule(id, schedules) {
    const response = await fetch(`/api/employees/${id}/default-schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedules })
    });
    return response.json();
  },

  // 従業員の作業別生産性を取得
  async getEmployeeProcessRates(id) {
    const response = await fetch(`/api/employees/${id}/process-rates`);
    return response.json();
  },

  // 従業員の作業別生産性を一括更新
  async saveEmployeeProcessRates(id, rates) {
    const response = await fetch(`/api/employees/${id}/process-rates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rates })
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

  // ===== AI受注候補(LINEから自動収集) =====

  // pending等ステータス指定で候補一覧取得
  async getAiIntakeList(status = 'pending') {
    const response = await fetch(`/api/ai-intake?status=${encodeURIComponent(status)}`);
    return response.json();
  },

  // 候補1件の詳細(LINEメッセージの書き起こし込み)取得
  async getAiIntake(id) {
    const response = await fetch(`/api/ai-intake/${id}`);
    return response.json();
  },

  // 編集後の内容で正式な案件として登録
  async confirmAiIntake(id, data) {
    const response = await fetch(`/api/ai-intake/${id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return response.json();
  },

  // 却下(データは削除せずstatusのみ更新)
  async rejectAiIntake(id) {
    const response = await fetch(`/api/ai-intake/${id}/reject`, {
      method: 'POST'
    });
    return response.json();
  },

  // ===== 統計関連 =====

  // 担当者別作業時間
  async getDailyWorkload(date) {
    const response = await fetch(`/api/stats/daily-workload?date=${date}`);
    return response.json();
  },

};
