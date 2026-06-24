// ========================================
// メインアプリケーションロジック
// ========================================

const app = {
  // ===== ステート =====
  projects: [],
  staff: [],
  currentTab: 'list',
  editingProjectId: null,
  editingStaffId: null,
  currentMonth: new Date(),
  sortColumn: 'deadline',
  sortOrder: 'asc',

  // ===== 初期化 =====
  async init() {
    console.log('🚀 アプリケーション初期化中...');
    await this.loadProjects();
    await this.loadStaff();
    this.updateStaffSelects();
    this.renderListView();
    console.log('✓ 初期化完了');
  },

  // ===== データ取得 =====
  async loadProjects() {
    try {
      this.projects = await API.getAllProjects();
    } catch (error) {
      console.error('案件取得エラー:', error);
      alert('案件の取得に失敗しました');
    }
  },

  async loadStaff() {
    try {
      this.staff = await API.getAllStaff();
    } catch (error) {
      console.error('担当者取得エラー:', error);
      alert('担当者の取得に失敗しました');
    }
  },

  // ===== UI: タブ切り替え =====
  switchTab(tabName) {
    this.currentTab = tabName;

    // タブボタンのアクティブ状態を更新
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    event.target.classList.add('active');

    // コンテンツの表示/非表示
    document.querySelectorAll('.tab-content').forEach(content => {
      content.classList.remove('active');
    });
    document.getElementById(`tab-${tabName}`).classList.add('active');

    // ビュー固有の処理
    if (tabName === 'kanban') {
      this.renderKanbanView();
    } else if (tabName === 'calendar') {
      this.renderCalendarView();
    } else if (tabName === 'list') {
      this.renderListView();
    }
  },

  // ===== UI: 一覧ビュー =====
  renderListView() {
    const projects = this.getFilteredProjects();
    const tbody = document.getElementById('projects-tbody');
    tbody.innerHTML = '';

    projects.forEach(project => {
      const row = document.createElement('tr');
      const deadlineWarning = getDeadlineWarning(project.deadline);
      
      if (deadlineWarning === 'overdue') {
        row.classList.add('row-overdue');
      } else if (deadlineWarning === 'urgent') {
        row.classList.add('row-urgent');
      } else if (deadlineWarning === 'warning') {
        row.classList.add('row-warning');
      }

      row.innerHTML = `
        <td class="cell-project-name">${this.escapeHtml(project.project_name)}</td>
        <td>${formatDate(project.received_date)}</td>
        <td class="deadline-cell">${formatDate(project.deadline)}</td>
        <td>${this.escapeHtml(project.customer_name)}</td>
        <td>${getProcessLabel(project.process_type)}</td>
        <td class="text-center">${project.quantity}</td>
        <td>${project.assigned_staff_name || '未割り当て'}</td>
        <td>
          <span class="status-badge ${getStatusClass(project.status)}">
            ${getStatusLabel(project.status)}
          </span>
        </td>
        <td>
          <span class="priority-badge ${getPriorityClass(project.priority)}">
            ${getPriorityLabel(project.priority)}
          </span>
        </td>
        <td class="text-center">
          <button class="btn-small" onclick="app.openProjectModal(${project.id})">
            ✎ 編集
          </button>
        </td>
      `;

      tbody.appendChild(row);
    });
  },

  getFilteredProjects() {
    const statusFilter = document.getElementById('filter-status').value;
    const processFilter = document.getElementById('filter-process').value;
    const staffFilter = document.getElementById('filter-staff').value;
    const priorityFilter = document.getElementById('filter-priority').value;

    let filtered = this.projects;

    if (statusFilter) {
      filtered = filtered.filter(p => p.status === statusFilter);
    }
    if (processFilter) {
      filtered = filtered.filter(p => p.process_type === processFilter);
    }
    if (staffFilter) {
      filtered = filtered.filter(p => p.assigned_staff_id == staffFilter);
    }
    if (priorityFilter) {
      filtered = filtered.filter(p => p.priority === priorityFilter);
    }

    // ソート
    filtered.sort((a, b) => {
      let aVal = a[this.sortColumn];
      let bVal = b[this.sortColumn];

      if (aVal < bVal) return this.sortOrder === 'asc' ? -1 : 1;
      if (aVal > bVal) return this.sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return filtered;
  },

  applyFilters() {
    this.renderListView();
  },

  sortTable(column) {
    if (this.sortColumn === column) {
      this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortColumn = column;
      this.sortOrder = 'asc';
    }
    this.renderListView();
  },

  // ===== UI: カンバンビュー =====
  renderKanbanView() {
    const board = document.getElementById('kanban-board');
    board.innerHTML = '';

    const statuses = [
      { key: 'PRE_ORDER', label: '受注前' },
      { key: 'CONFIRMED', label: '受注確定' },
      { key: 'WAITING', label: '生産待ち' },
      { key: 'IN_PROGRESS', label: '生産中' },
      { key: 'INSPECTION', label: '検品' },
      { key: 'DELIVERED', label: '納品済' }
    ];

    statuses.forEach(status => {
      const column = document.createElement('div');
      column.className = 'kanban-column';

      const header = document.createElement('div');
      header.className = 'kanban-header';
      header.innerHTML = `<h3>${status.label}</h3>`;
      column.appendChild(header);

      const content = document.createElement('div');
      content.className = 'kanban-cards';
      content.ondragover = (e) => e.preventDefault();
      content.ondrop = (e) => this.handleCardDrop(e, status.key);

      const cardsInStatus = this.projects.filter(p => p.status === status.key);
      cardsInStatus.forEach(project => {
        const card = document.createElement('div');
        card.className = `kanban-card priority-${project.priority.toLowerCase()}`;
        card.draggable = true;
        card.ondragstart = (e) => this.handleCardDragStart(e, project.id);
        card.innerHTML = `
          <div class="card-title">${this.escapeHtml(project.project_name)}</div>
          <div class="card-customer">${this.escapeHtml(project.customer_name)}</div>
          <div class="card-deadline">${formatDate(project.deadline)}</div>
          <div class="card-info">
            <span>${getProcessLabel(project.process_type)}</span>
            <span>×${project.quantity}</span>
          </div>
          <div class="card-actions">
            <button class="btn-small" onclick="app.openProjectModal(${project.id})">
              ✎ 編集
            </button>
          </div>
        `;
        content.appendChild(card);
      });

      column.appendChild(content);
      board.appendChild(column);
    });
  },

  handleCardDragStart(e, projectId) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('projectId', projectId);
  },

  async handleCardDrop(e, newStatus) {
    e.preventDefault();
    const projectId = e.dataTransfer.getData('projectId');
    const project = this.projects.find(p => p.id == projectId);

    if (project) {
      try {
        await API.updateProject(projectId, { ...project, status: newStatus });
        await this.loadProjects();
        this.renderKanbanView();
        console.log(`✓ プロジェクト #${projectId} のステータスを ${newStatus} に更新`);
      } catch (error) {
        console.error('ステータス更新エラー:', error);
        alert('ステータスの更新に失敗しました');
      }
    }
  },

  // ===== UI: カレンダービュー =====
  renderCalendarView() {
    const monthYearEl = document.getElementById('calendar-month-year');
    monthYearEl.textContent = this.currentMonth.toLocaleString('ja-JP', {
      year: 'numeric',
      month: 'long'
    });

    const container = document.getElementById('calendar-container');
    container.innerHTML = '';

    const year = this.currentMonth.getFullYear();
    const month = this.currentMonth.getMonth();

    // カレンダーレイアウトを作成
    const table = document.createElement('table');
    table.className = 'calendar-table';

    // 曜日ヘッダー
    const headerRow = document.createElement('tr');
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    days.forEach(day => {
      const th = document.createElement('th');
      th.textContent = day;
      headerRow.appendChild(th);
    });
    table.appendChild(headerRow);

    // 日付を取得
    const firstDay = new Date(year, month, 1).getDay();
    const lastDate = new Date(year, month + 1, 0).getDate();

    let date = 1;
    for (let i = 0; i < 6; i++) {
      const row = document.createElement('tr');

      for (let j = 0; j < 7; j++) {
        const cell = document.createElement('td');
        cell.className = 'calendar-cell';

        if (i === 0 && j < firstDay) {
          cell.classList.add('empty');
        } else if (date > lastDate) {
          cell.classList.add('empty');
        } else {
          const currentDate = new Date(year, month, date);
          const dateStr = currentDate.toISOString().split('T')[0];

          // この日付の案件を取得
          const projectsOnDate = this.projects.filter(p => p.deadline === dateStr);

          cell.innerHTML = `<div class="date-number">${date}</div>`;

          if (projectsOnDate.length > 0) {
            const itemsDiv = document.createElement('div');
            itemsDiv.className = 'calendar-items';
            projectsOnDate.forEach(p => {
              const item = document.createElement('div');
              item.className = 'calendar-item';
              item.textContent = p.project_name.substring(0, 15);
              item.onclick = () => app.openProjectModal(p.id);
              itemsDiv.appendChild(item);
            });
            cell.appendChild(itemsDiv);
          }

          date++;
        }

        row.appendChild(cell);
      }

      table.appendChild(row);

      if (date > lastDate) break;
    }

    container.appendChild(table);
  },

  prevMonth() {
    this.currentMonth.setMonth(this.currentMonth.getMonth() - 1);
    this.renderCalendarView();
  },

  nextMonth() {
    this.currentMonth.setMonth(this.currentMonth.getMonth() + 1);
    this.renderCalendarView();
  },

  // ===== UI: コピペ取り込み =====
  extractFromText() {
    const text = document.getElementById('import-textarea').value;

    if (!text.trim()) {
      alert('テキストを入力してください');
      return;
    }

    // テキスト解析
    const extracted = {
      project_name: extractName(text) || '',
      customer_name: extractName(text).split('\n')[0] || '',
      received_date: new Date().toISOString().split('T')[0],
      deadline: extractDate(text) || '',
      contact_method: 'LINE',
      process_type: text.includes('刺繍') ? 'EMBROIDERY' : text.includes('プリント') ? 'PRINT' : 'COMBINED',
      quantity: extractNumber(text) || 1,
      planned_hours: 60,
      work_content: text,
      memo: ''
    };

    // フォームを填める
    const form = document.getElementById('import-form');
    Object.entries(extracted).forEach(([key, value]) => {
      const field = form.elements[key];
      if (field) {
        field.value = value;
      }
    });

    // プレビューを表示
    document.getElementById('import-preview').style.display = 'block';
  },

  async submitImportedProject() {
    const form = document.getElementById('import-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData);

    // 数値変換
    data.quantity = parseInt(data.quantity);
    data.planned_hours = parseFloat(data.planned_hours);
    data.assigned_staff_id = data.assigned_staff_id ? parseInt(data.assigned_staff_id) : null;

    try {
      await API.createProject(data);
      await this.loadProjects();
      
      // UIをリセット
      document.getElementById('import-textarea').value = '';
      document.getElementById('import-preview').style.display = 'none';
      form.reset();
      
      alert('✓ 案件を登録しました');
      this.renderListView();
    } catch (error) {
      console.error('案件登録エラー:', error);
      alert('案件の登録に失敗しました');
    }
  },

  closeImportForm() {
    document.getElementById('import-preview').style.display = 'none';
    document.getElementById('import-textarea').value = '';
    document.getElementById('import-form').reset();
  },

  // ===== UI: モーダル =====
  openProjectModal(projectId = null) {
    this.editingProjectId = projectId;
    const modal = document.getElementById('project-modal');
    const form = document.getElementById('project-form');
    const title = document.getElementById('modal-title');
    const deleteBtn = document.getElementById('btn-delete');

    form.reset();

    if (projectId) {
      title.textContent = '案件編集';
      deleteBtn.style.display = 'inline-block';

      const project = this.projects.find(p => p.id === projectId);
      if (project) {
        Object.entries(project).forEach(([key, value]) => {
          const field = form.elements[key];
          if (field && key !== 'id') {
            field.value = value || '';
          }
        });
      }
    } else {
      title.textContent = '新規案件';
      deleteBtn.style.display = 'none';
      form.elements['received_date'].value = new Date().toISOString().split('T')[0];
    }

    modal.style.display = 'flex';
  },

  closeProjectModal() {
    document.getElementById('project-modal').style.display = 'none';
    this.editingProjectId = null;
  },

  async submitProjectForm(e) {
    e.preventDefault();
    const form = document.getElementById('project-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData);

    // 数値変換
    data.quantity = parseInt(data.quantity);
    data.planned_hours = parseFloat(data.planned_hours);
    data.assigned_staff_id = data.assigned_staff_id ? parseInt(data.assigned_staff_id) : null;

    try {
      if (this.editingProjectId) {
        await API.updateProject(this.editingProjectId, data);
        console.log(`✓ プロジェクト #${this.editingProjectId} を更新`);
      } else {
        await API.createProject(data);
        console.log('✓ 新規プロジェクトを作成');
      }

      await this.loadProjects();
      this.closeProjectModal();
      this.renderListView();
      if (this.currentTab === 'kanban') this.renderKanbanView();
    } catch (error) {
      console.error('案件保存エラー:', error);
      alert('案件の保存に失敗しました');
    }
  },

  async deleteProject() {
    if (!this.editingProjectId) return;

    if (!confirm('この案件を削除してもよろしいですか？')) {
      return;
    }

    try {
      await API.deleteProject(this.editingProjectId);
      console.log(`✓ プロジェクト #${this.editingProjectId} を削除`);
      await this.loadProjects();
      this.closeProjectModal();
      this.renderListView();
    } catch (error) {
      console.error('案件削除エラー:', error);
      alert('案件の削除に失敗しました');
    }
  },

  // ===== 担当者管理 =====
  openStaffModal() {
    document.getElementById('staff-modal').style.display = 'flex';
    this.renderStaffList();
  },

  closeStaffModal() {
    document.getElementById('staff-modal').style.display = 'none';
  },

  openStaffFormModal(staffId = null) {
    this.editingStaffId = staffId;
    const modal = document.getElementById('staff-form-modal');
    const form = document.getElementById('staff-form');
    const title = document.getElementById('staff-form-title');

    form.reset();

    if (staffId) {
      title.textContent = '担当者編集';
      const staff = this.staff.find(s => s.id === staffId);
      if (staff) {
        form.elements['name'].value = staff.name;
        form.elements['role'].value = staff.role;
        form.elements['capacity_minutes'].value = staff.capacity_minutes;
      }
    } else {
      title.textContent = '新規担当者';
    }

    modal.style.display = 'flex';
  },

  closeStaffFormModal() {
    document.getElementById('staff-form-modal').style.display = 'none';
    this.editingStaffId = null;
  },

  async submitStaffForm(e) {
    e.preventDefault();
    const form = document.getElementById('staff-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData);
    data.capacity_minutes = parseFloat(data.capacity_minutes);

    try {
      if (this.editingStaffId) {
        await API.updateStaff(this.editingStaffId, data);
        console.log(`✓ スタッフ #${this.editingStaffId} を更新`);
      } else {
        await API.createStaff(data);
        console.log('✓ 新規スタッフを作成');
      }

      await this.loadStaff();
      this.updateStaffSelects();
      this.closeStaffFormModal();
      this.renderStaffList();
    } catch (error) {
      console.error('スタッフ保存エラー:', error);
      alert('スタッフの保存に失敗しました');
    }
  },

  renderStaffList() {
    const list = document.getElementById('staff-list');
    list.innerHTML = '';

    this.staff.forEach(staff => {
      const item = document.createElement('div');
      item.className = 'staff-item';
      item.innerHTML = `
        <div class="staff-info">
          <div class="staff-name">${staff.name}</div>
          <div class="staff-role">${getRoleLabel(staff.role)} / ${staff.capacity_minutes}分</div>
        </div>
        <div class="staff-actions">
          <button class="btn-small" onclick="app.openStaffFormModal(${staff.id})">
            ✎ 編集
          </button>
          <button class="btn-small btn-danger" onclick="app.deleteStaff(${staff.id})">
            🗑️ 削除
          </button>
        </div>
      `;
      list.appendChild(item);
    });
  },

  async deleteStaff(staffId) {
    if (!confirm('この担当者を削除してもよろしいですか？')) {
      return;
    }

    try {
      await API.deleteStaff(staffId);
      console.log(`✓ スタッフ #${staffId} を削除`);
      await this.loadStaff();
      this.updateStaffSelects();
      this.renderStaffList();
    } catch (error) {
      console.error('スタッフ削除エラー:', error);
      alert('スタッフの削除に失敗しました');
    }
  },

  updateStaffSelects() {
    // フォームの担当者セレクトを更新
    const staffSelect = document.getElementById('staff-select');
    const filterStaffSelect = document.getElementById('filter-staff');

    [staffSelect, filterStaffSelect].forEach(select => {
      const currentValue = select?.value;
      if (select) {
        select.innerHTML = '<option value="">未割り当て</option>';
        this.staff.forEach(staff => {
          const option = document.createElement('option');
          option.value = staff.id;
          option.textContent = staff.name;
          select.appendChild(option);
        });
        if (currentValue) select.value = currentValue;
      }
    });
  },

  // ===== ユーティリティ =====
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

// ===== イベントリスナー =====
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('project-form')?.addEventListener('submit', (e) => app.submitProjectForm(e));
  document.getElementById('staff-form')?.addEventListener('submit', (e) => app.submitStaffForm(e));

  // モーダルのクローズボタン
  window.addEventListener('click', (e) => {
    if (e.target.id === 'project-modal') {
      app.closeProjectModal();
    }
    if (e.target.id === 'staff-modal') {
      app.closeStaffModal();
    }
    if (e.target.id === 'staff-form-modal') {
      app.closeStaffFormModal();
    }
  });

  // アプリ初期化
  app.init();
});
