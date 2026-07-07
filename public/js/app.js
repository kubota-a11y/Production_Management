// ========================================
// メインアプリケーションロジック
// ========================================

const app = {
  // ===== ステート =====
  projects: [],
  staff: [],
  employees: [],
  timeAllocations: [],
  editingTimeAllocationId: null,
  currentTab: 'list',
  editingProjectId: null,
  editingStaffId: null,
  currentMonth: new Date(),
  sortColumn: 'deadline',
  sortOrder: 'asc',
  groupBy: null, // null | 'deadline' | 'status'
  nasEntriesCache: [],
  prepItemsMaster: [],
  preparationItems: [],

  // ===== 初期化 =====
  async init() {
    console.log('🚀 アプリケーション初期化中...');
    await this.loadProjects();
    await this.loadStaff();
    await this.loadEmployees();
    await this.loadPrepItemsMaster();
    this.updateStaffSelects();
    this.renderListView();
    this.handleQueryParams();
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

  async loadEmployees() {
    try {
      this.employees = await API.getAllEmployees();
    } catch (error) {
      console.error('従業員取得エラー:', error);
      alert('従業員の取得に失敗しました');
    }
  },

  async loadPrepItemsMaster() {
    try {
      this.prepItemsMaster = await API.getPreparationItemsMaster();
      this.renderPrepItemsCheckboxGroup();
    } catch (error) {
      console.error('準備項目マスター取得エラー:', error);
      alert('準備項目マスターの取得に失敗しました');
    }
  },

  // 準備項目の選択肢をマスターデータから動的に生成する。
  // value は既存の prep_items CSV(projects.prep_items)と互換性を保つため code を使う
  renderPrepItemsCheckboxGroup() {
    const container = document.getElementById('prep-items-checkbox-group');
    if (!container) return;
    container.innerHTML = this.prepItemsMaster.map(item => `
      <label class="checkbox-pill"><input type="checkbox" name="prep_items" value="${this.escapeHtml(item.code)}"> ${this.escapeHtml(item.name)}</label>
    `).join('');
  },

  async loadPreparationItems() {
    try {
      this.preparationItems = await API.getPreparationItems();
    } catch (error) {
      console.error('準備項目タスク取得エラー:', error);
      alert('準備項目タスクの取得に失敗しました');
    }
  },

  getPreparationItemsForCase(caseId) {
    return this.preparationItems.filter(item => item.case_id === caseId);
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
      this.loadPreparationItems().then(() => this.renderKanbanView());
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

    this.updateGroupHeaderUI();

    if (this.groupBy === 'deadline') {
      this.renderGroupedRows(tbody, this.groupProjectsByDeadline(projects));
    } else if (this.groupBy === 'status') {
      this.renderGroupedRows(tbody, this.groupProjectsByStatus(projects));
    } else {
      projects.forEach(project => tbody.appendChild(this.buildProjectRow(project)));
    }
  },

  buildProjectRow(project) {
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
      <td>${getProcessLabels(project.process_type)}</td>
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

    return row;
  },

  buildGroupHeaderRow(label, count) {
    const row = document.createElement('tr');
    row.className = 'group-header-row';
    const colCount = document.querySelectorAll('#projects-table thead th').length;
    row.innerHTML = `<td colspan="${colCount}">${this.escapeHtml(label)} (${count}件)</td>`;
    return row;
  },

  renderGroupedRows(tbody, groups) {
    groups.forEach(group => {
      tbody.appendChild(this.buildGroupHeaderRow(group.label, group.projects.length));
      group.projects.forEach(project => tbody.appendChild(this.buildProjectRow(project)));
    });
  },

  groupProjectsByDeadline(projects) {
    const map = new Map();
    projects.forEach(project => {
      const key = project.deadline || '';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(project);
    });

    const keys = Array.from(map.keys()).sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    return keys
      .map(key => ({
        label: key ? formatDate(key) : '納期未設定',
        projects: map.get(key)
      }))
      .filter(group => group.projects.length > 0);
  },

  groupProjectsByStatus(projects) {
    const statusOrder = ['PRE_ORDER', 'CONFIRMED', 'WAITING', 'PREP_COMPLETE', 'IN_PROGRESS', 'INSPECTION', 'DELIVERED'];
    return statusOrder
      .map(statusKey => ({
        label: getStatusLabel(statusKey),
        projects: projects.filter(project => project.status === statusKey)
      }))
      .filter(group => group.projects.length > 0);
  },

  toggleGroupColumn(column) {
    this.groupBy = this.groupBy === column ? null : column;
    this.renderListView();
  },

  updateGroupHeaderUI() {
    const deadlineTh = document.getElementById('th-group-deadline');
    const statusTh = document.getElementById('th-group-status');
    if (deadlineTh) deadlineTh.classList.toggle('grouped-column', this.groupBy === 'deadline');
    if (statusTh) statusTh.classList.toggle('grouped-column', this.groupBy === 'status');
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
      filtered = filtered.filter(p => (p.process_type || '').split(',').map(s => s.trim()).includes(processFilter));
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
      { key: 'PREP_COMPLETE', label: '準備完了' },
      { key: 'IN_PROGRESS', label: '生産中' },
      { key: 'INSPECTION', label: '検品' },
      { key: 'DELIVERED', label: '納品待ち' }
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
        const prepItems = this.getPreparationItemsForCase(project.id);
        const prepProgressHtml = prepItems.length > 0
          ? `<div class="card-prep-progress">準備: ${prepItems.filter(i => i.status === '完了').length}/${prepItems.length}完了</div>`
          : '';
        card.innerHTML = `
          <div class="card-title">${this.escapeHtml(project.project_name)}</div>
          <div class="card-customer">${this.escapeHtml(project.customer_name)}</div>
          <div class="card-deadline">${formatDate(project.deadline)}</div>
          <div class="card-info">
            <span>${getProcessLabels(project.process_type)}</span>
            <span>×${project.quantity}</span>
          </div>
          ${prepProgressHtml}
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
    const detectedProcessType = text.includes('刺繍') ? 'STANDARD_EMBROIDERY' : text.includes('帽子') ? 'HAT_EMBROIDERY' : text.includes('ワッペン') ? 'PATCH_EMBROIDERY' : text.includes('DTF') || text.includes('DTFプリント') ? 'DTF_PRINT' : text.includes('ラバー') ? 'RUBBER_TRANSFER_PRINT' : text.includes('シルク') ? 'SILK_SCREEN_PRINT' : 'STANDARD_EMBROIDERY';
    const extracted = {
      project_name: extractName(text) || '',
      customer_name: extractName(text).split('\n')[0] || '',
      received_date: new Date().toISOString().split('T')[0],
      deadline: extractDate(text) || '',
      contact_method: 'LINE',
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
    this.setCheckboxGroupValues(form, 'process_type', detectedProcessType);

    // プレビューを表示
    document.getElementById('import-preview').style.display = 'block';
  },

  async submitImportedProject() {
    const form = document.getElementById('import-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData);

    // 加工種別（複数選択）をカンマ区切りにまとめる
    data.process_type = formData.getAll('process_type').join(',');
    if (!data.process_type) {
      alert('加工種別を1つ以上選択してください');
      return;
    }

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
          if (key === 'process_type' || key === 'prep_items') return; // チェックボックス群は別途処理
          const field = form.elements[key];
          if (field && key !== 'id') {
            field.value = value || '';
          }
        });
        this.setCheckboxGroupValues(form, 'process_type', project.process_type);
        this.setCheckboxGroupValues(form, 'prep_items', project.prep_items);
      }

      document.getElementById('time-allocation-disabled-notice').style.display = 'none';
      document.getElementById('time-allocation-body').style.display = 'block';
      this.populateTimeAllocationEmployeeSelect();
      this.cancelEditTimeAllocation();
      this.loadTimeAllocations(projectId);
    } else {
      title.textContent = '新規案件';
      deleteBtn.style.display = 'none';
      form.elements['received_date'].value = new Date().toISOString().split('T')[0];

      document.getElementById('time-allocation-disabled-notice').style.display = 'block';
      document.getElementById('time-allocation-body').style.display = 'none';
      this.timeAllocations = [];
    }

    setTimeout(() => this.loadNasFiles(), 0);
    modal.style.display = 'flex';
  },

  closeProjectModal() {
    document.getElementById('project-modal').style.display = 'none';
    this.editingProjectId = null;
  },

  // ===== 作業計画 =====
  populateTimeAllocationEmployeeSelect() {
    const select = document.getElementById('ta-employee-select');
    const currentValue = select.value;
    select.innerHTML = '<option value="">担当従業員を選択</option>';
    this.employees
      .filter(e => e.is_active)
      .forEach(employee => {
        const option = document.createElement('option');
        option.value = employee.id;
        option.textContent = employee.name;
        select.appendChild(option);
      });
    if (currentValue) select.value = currentValue;
  },

  async loadTimeAllocations(projectId) {
    try {
      this.timeAllocations = await API.getTimeAllocations(projectId);
    } catch (error) {
      console.error('作業計画取得エラー:', error);
      alert('作業計画の取得に失敗しました');
      this.timeAllocations = [];
    }
    this.renderTimeAllocationTable();
  },

  renderTimeAllocationTable() {
    const tbody = document.getElementById('time-allocation-tbody');
    const emptyNotice = document.getElementById('time-allocation-empty');
    tbody.innerHTML = '';

    if (this.timeAllocations.length === 0) {
      emptyNotice.style.display = 'block';
      return;
    }
    emptyNotice.style.display = 'none';

    this.timeAllocations.forEach(allocation => {
      const row = document.createElement('tr');
      if (allocation.id === this.editingTimeAllocationId) {
        row.className = 'time-allocation-table-row-editing';
      }
      row.innerHTML = `
        <td>${formatDate(allocation.work_date)}</td>
        <td>${this.escapeHtml(allocation.employee_name)}</td>
        <td>${allocation.planned_hours}</td>
        <td>${allocation.actual_hours ?? '-'}</td>
        <td>${this.escapeHtml(allocation.status || '')}</td>
        <td>
          <button class="btn-small" onclick="app.editTimeAllocation(${allocation.id})">✎ 編集</button>
          <button class="btn-small btn-danger" onclick="app.deleteTimeAllocation(${allocation.id})">🗑️ 削除</button>
        </td>
      `;
      tbody.appendChild(row);
    });
  },

  resetTimeAllocationForm() {
    document.getElementById('ta-employee-select').value = '';
    document.getElementById('ta-work-date').value = '';
    document.getElementById('ta-planned-hours').value = '';
  },

  cancelEditTimeAllocation() {
    this.editingTimeAllocationId = null;
    this.resetTimeAllocationForm();
    document.getElementById('ta-submit-btn').textContent = '➕ 登録';
    document.getElementById('ta-cancel-edit').style.display = 'none';
    this.renderTimeAllocationTable();
  },

  editTimeAllocation(allocationId) {
    const allocation = this.timeAllocations.find(a => a.id === allocationId);
    if (!allocation) return;

    this.editingTimeAllocationId = allocationId;
    document.getElementById('ta-employee-select').value = allocation.employee_id;
    document.getElementById('ta-work-date').value = allocation.work_date;
    document.getElementById('ta-planned-hours').value = allocation.planned_hours;
    document.getElementById('ta-submit-btn').textContent = '✎ 更新';
    document.getElementById('ta-cancel-edit').style.display = 'inline-block';
    this.renderTimeAllocationTable();
  },

  async submitTimeAllocation() {
    if (!this.editingProjectId) return;

    const employeeId = document.getElementById('ta-employee-select').value;
    const workDate = document.getElementById('ta-work-date').value;
    const plannedHours = document.getElementById('ta-planned-hours').value;

    if (!employeeId || !workDate || !plannedHours) {
      alert('担当従業員・日付・予定時間を入力してください');
      return;
    }

    const data = {
      employee_id: parseInt(employeeId),
      work_date: workDate,
      planned_hours: parseFloat(plannedHours)
    };

    try {
      if (this.editingTimeAllocationId) {
        await API.updateTimeAllocation(this.editingTimeAllocationId, data);
        console.log(`✓ 作業計画 #${this.editingTimeAllocationId} を更新`);
      } else {
        await API.createTimeAllocation(this.editingProjectId, data);
        console.log('✓ 新規作業計画を作成');
      }
      this.cancelEditTimeAllocation();
      await this.loadTimeAllocations(this.editingProjectId);
    } catch (error) {
      console.error('作業計画保存エラー:', error);
      alert('作業計画の保存に失敗しました');
    }
  },

  async deleteTimeAllocation(allocationId) {
    if (!confirm('この作業計画を削除してもよろしいですか？')) return;

    try {
      await API.deleteTimeAllocation(allocationId);
      console.log(`✓ 作業計画 #${allocationId} を削除`);
      if (this.editingTimeAllocationId === allocationId) {
        this.cancelEditTimeAllocation();
      }
      await this.loadTimeAllocations(this.editingProjectId);
    } catch (error) {
      console.error('作業計画削除エラー:', error);
      alert('作業計画の削除に失敗しました');
    }
  },

  // チェックボックス群（加工種別など）にカンマ区切りの値を反映
  setCheckboxGroupValues(form, name, csvValue) {
    const values = (csvValue || '').split(',').map(v => v.trim()).filter(Boolean);
    form.querySelectorAll(`input[name="${name}"]`).forEach(cb => {
      cb.checked = values.includes(cb.value);
    });
  },

  // 「参照...」ボタン: パス未入力でもNASのベースフォルダ(ルート)から一覧表示を開始する
  browseNas() {
    this.loadNasFiles({ forceBrowse: true });
  },

  async loadNasFiles({ forceBrowse = false } = {}) {
    const modal = document.getElementById('project-modal');
    const pathField = document.getElementById('nas-folder-path');
    const listContainer = document.getElementById('nas-file-list');
    const notice = document.getElementById('nas-folder-status');
    const searchInput = document.getElementById('nas-search');

    const folderPath = pathField?.value?.trim();
    if (!folderPath && !forceBrowse) {
      notice.textContent = '「参照...」でNAS内のフォルダを選択するか、パスを直接入力してください';
      listContainer.innerHTML = '';
      searchInput.style.display = 'none';
      searchInput.value = '';
      this.nasEntriesCache = [];
      return;
    }

    try {
      // show loading
      const loadingEl = document.getElementById('nas-loading');
      const breadcrumbEl = document.getElementById('nas-breadcrumb');
      loadingEl.style.display = 'block';
      listContainer.innerHTML = '';
      breadcrumbEl.innerHTML = '';
      searchInput.style.display = 'none';
      searchInput.value = '';

      const data = await API.getNasList(folderPath || '');
      loadingEl.style.display = 'none';

      if (!data || !data.exists) {
        notice.textContent = 'フォルダが見つかりません';
        listContainer.innerHTML = '';
        this.nasEntriesCache = [];
        return;
      }

      // フォルダを未入力のまま「参照...」した場合は、表示中のフォルダをそのまま入力欄へ反映する
      if (!folderPath) {
        pathField.value = data.path;
      }

      notice.textContent = `フォルダ: ${data.path}`;
      listContainer.innerHTML = '';

      // breadcrumb (clickable segments) - use string ops so it runs in browser
      try {
        const full = data.path;
        const sep = full.includes('\\') ? '\\' : '/';
        const parts = full.split(/[\\\\/]+/).filter(Boolean);
        parts.forEach((part, idx) => {
          const seg = document.createElement('a');
          seg.href = '#';
          // build path up to this segment using the detected separator
          const resolved = (full.startsWith(sep) ? sep : '') + parts.slice(0, idx + 1).join(sep);
          seg.textContent = (idx === 0 && full.startsWith(sep)) ? sep + part : part;
          seg.style.marginRight = '6px';
          seg.onclick = (e) => {
            e.preventDefault();
            pathField.value = resolved;
            this.loadNasFiles();
          };
          breadcrumbEl.appendChild(seg);
          if (idx < parts.length - 1) breadcrumbEl.appendChild(document.createTextNode(' / '));
        });
      } catch (err) {
        // noop
      }

      // フォルダ/ファイル名でソートしてキャッシュ（検索フィルタで再利用）
      this.nasEntriesCache = [...data.entries].sort((a, b) => a.name.localeCompare(b.name, 'ja'));

      if (this.nasEntriesCache.length === 0) {
        listContainer.innerHTML = '<div class="folder-notice">フォルダ内にファイルが見つかりません</div>';
        return;
      }

      // 件数が多いときだけ絞り込み欄を出す
      if (this.nasEntriesCache.length > 8) {
        searchInput.style.display = 'block';
      }

      this.renderNasEntryList(this.nasEntriesCache);
    } catch (error) {
      console.error('NAS読み込みエラー:', error);
      const loadingEl = document.getElementById('nas-loading');
      loadingEl.style.display = 'none';
      notice.textContent = error?.message || 'NAS一覧の取得に失敗しました';
      listContainer.innerHTML = `<div class="folder-notice">エラー: ${error?.message || '取得失敗'}</div>`;
      this.nasEntriesCache = [];
    }
  },

  // 現在のフォルダの絞り込み（クライアント側フィルタ）
  filterNasEntries() {
    const query = document.getElementById('nas-search')?.value?.trim().toLowerCase() || '';
    const entries = this.nasEntriesCache || [];
    const filtered = query
      ? entries.filter(entry => entry.name.toLowerCase().includes(query))
      : entries;
    this.renderNasEntryList(filtered, query);
  },

  // フォルダ/ファイル一覧のレンダリング（初回表示・検索フィルタ双方から呼ばれる）
  renderNasEntryList(entries, activeQuery = '') {
    const pathField = document.getElementById('nas-folder-path');
    const listContainer = document.getElementById('nas-file-list');
    listContainer.innerHTML = '';

    if (entries.length === 0) {
      listContainer.innerHTML = `<div class="folder-notice">「${this.escapeHtml(activeQuery)}」に一致するフォルダ/ファイルがありません</div>`;
      return;
    }

    entries.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'folder-item';
      const nameEl = document.createElement('span');
      nameEl.textContent = entry.name + (entry.isDirectory ? ' /' : '');
      item.appendChild(nameEl);

      if (entry.isDirectory) {
        item.style.cursor = 'pointer';
        item.onclick = () => {
          pathField.value = entry.path;
          this.loadNasFiles();
        };
      } else {
        // ブラウザで開く/ダウンロード（LAN上のどの端末からでも利用可）
        const openBtn = document.createElement('button');
        openBtn.className = 'btn-small';
        openBtn.textContent = '📂 開く/DL';
        openBtn.style.marginLeft = '8px';
        openBtn.onclick = (e) => {
          e.stopPropagation();
          window.open(API.getNasFileUrl(entry.path), '_blank');
        };
        item.appendChild(openBtn);

        // Finderで開く（サーバーを動かしている端末上でのみ有効）
        const finderBtn = document.createElement('button');
        finderBtn.className = 'btn-small';
        finderBtn.textContent = '🖥️ Finderで開く(サーバー機のみ)';
        finderBtn.style.marginLeft = '8px';
        finderBtn.onclick = async (e) => {
          e.stopPropagation();
          await this.openNasFile(entry.path);
        };
        item.appendChild(finderBtn);
      }

      listContainer.appendChild(item);
    });
  },

  async openNasFile(filePath) {
    try {
      const result = await API.openNasFile(filePath);
      if (result.success) {
        console.log('Opened file in Finder:', filePath);
      } else {
        alert(result.error || 'ファイルを開くことができませんでした');
      }
    } catch (error) {
      console.error('NAS open error:', error);
      alert('ファイルを開くことができませんでした');
    }
  },

  async submitProjectForm(e) {
    e.preventDefault();
    const form = document.getElementById('project-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData);

    // 加工種別（複数選択）をカンマ区切りにまとめる
    data.process_type = formData.getAll('process_type').join(',');
    if (!data.process_type) {
      alert('加工種別を1つ以上選択してください');
      return;
    }

    // 作業の準備項目（複数選択・任意）をカンマ区切りにまとめる
    const prepItemCodes = formData.getAll('prep_items');
    data.prep_items = prepItemCodes.join(',');

    // 数値変換
    data.quantity = parseInt(data.quantity);
    data.planned_hours = parseFloat(data.planned_hours);
    data.assigned_staff_id = data.assigned_staff_id ? parseInt(data.assigned_staff_id) : null;

    try {
      let projectId = this.editingProjectId;
      if (this.editingProjectId) {
        await API.updateProject(this.editingProjectId, data);
        console.log(`✓ プロジェクト #${this.editingProjectId} を更新`);
      } else {
        const result = await API.createProject(data);
        projectId = result.id;
        console.log('✓ 新規プロジェクトを作成');
      }

      // 選択された準備項目をタスクとして登録(既に登録済みのものはサーバー側でスキップされる)
      if (prepItemCodes.length > 0) {
        const codeToId = new Map(this.prepItemsMaster.map(m => [m.code, m.id]));
        const prepItemIds = prepItemCodes.map(code => codeToId.get(code)).filter(Boolean);
        if (prepItemIds.length > 0) {
          await API.registerCasePreparationItems(projectId, prepItemIds);
        }
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
  },

  // Google Calendar integration removed

  handleQueryParams() {
    const params = new URLSearchParams(window.location.search);
    // No special query params to handle
  }
};

// ===== イベントリスナー =====
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('project-form')?.addEventListener('submit', (e) => app.submitProjectForm(e));
  document.getElementById('staff-form')?.addEventListener('submit', (e) => app.submitStaffForm(e));

  const nasFolderPathInput = document.getElementById('nas-folder-path');
  nasFolderPathInput?.addEventListener('input', () => {
    if (document.getElementById('project-modal')?.style.display === 'flex') {
      app.loadNasFiles();
    }
  });

  const nasSearchInput = document.getElementById('nas-search');
  nasSearchInput?.addEventListener('input', () => {
    app.filterNasEntries();
  });

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
