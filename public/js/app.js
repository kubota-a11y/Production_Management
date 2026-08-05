// ========================================
// メインアプリケーションロジック
// ========================================

// 受注候補の受付番号の頭文字。line_users の疑似ユーザーIDと対応する。
// W-=Web注文 / T-=チーム追加 / P-=取引先加工依頼 / M-=メール貼り付け / D-=電話メモ。
// LINE由来(実在のLINEユーザーID)はバッジを出さない
const RECEIPT_PREFIX = { WEB: 'W', TEAM: 'T', PARTNER: 'P', MAIL: 'M', PHONE: 'D' };

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
  deliveringProjectId: null,
  currentMonth: new Date(),
  sortColumn: 'deadline',
  sortOrder: 'asc',
  groupBy: null, // null | 'deadline' | 'status'
  nasEntriesCache: [],
  prepItemsMaster: [],
  preparationItems: [],
  aiIntakeList: [],
  editingAiIntakeId: null,
  // 受注候補の振り分け(2026-08-05)。フィルタは画面の状態、操作者はこの端末の設定としてlocalStorageに残す
  triageFilter: 'all',
  // 振り分ける人の候補。タブ切替や振り分けのたびに読み直す必要がないので初回だけ取得する
  triageMembers: null,
  printLocationRows: [],
  printLocationRowCounter: 0,

  // ===== 初期化 =====
  async init() {
    console.log('🚀 アプリケーション初期化中...');
    await this.loadProjects();
    await this.loadStaff();
    await this.loadEmployees();
    await this.loadPrepItemsMaster();
    await this.loadAiIntakeList();
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
      HiUI.toast('案件の取得に失敗しました');
    }
  },

  async loadStaff() {
    try {
      this.staff = await API.getAllStaff();
    } catch (error) {
      console.error('担当者取得エラー:', error);
      HiUI.toast('担当者の取得に失敗しました');
    }
  },

  async loadEmployees() {
    try {
      this.employees = await API.getAllEmployees();
    } catch (error) {
      console.error('従業員取得エラー:', error);
      HiUI.toast('従業員の取得に失敗しました');
    }
  },

  async loadPrepItemsMaster() {
    try {
      this.prepItemsMaster = await API.getPreparationItemsMaster();
      this.renderPrepItemsCheckboxGroup();
    } catch (error) {
      console.error('準備項目マスター取得エラー:', error);
      HiUI.toast('準備項目マスターの取得に失敗しました');
    }
  },

  // 準備項目の選択肢をマスターデータから動的に生成する。
  // value は既存の prep_items CSV(projects.prep_items)と互換性を保つため code を使う
  // containerId を渡すと受注候補モーダル側にも同じ選択肢を描ける(実装は1つに保つ)
  renderPrepItemsCheckboxGroup(containerId = 'prep-items-checkbox-group') {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = this.prepItemsMaster.map(item => `
      <label class="checkbox-pill"><input type="checkbox" name="prep_items" value="${this.escapeHtml(item.code)}"> ${this.escapeHtml(item.name)}</label>
    `).join('');
  },

  // ===== プリント箇所（案件フォーム内） =====
  printLocationRowHtml(rowKey, locationName, colorCount, containerId = 'print-locations-container') {
    const options = [1, 2, 3, 4].map(n =>
      `<option value="${n}" ${Number(colorCount) === n ? 'selected' : ''}>${n}色</option>`
    ).join('');
    return `
      <div class="print-location-row" data-row-key="${rowKey}">
        <input type="text" class="pl-location-name" data-row-key="${rowKey}" placeholder="箇所名(例: 胸ロゴ)" value="${this.escapeHtml(locationName || '')}">
        <select class="pl-color-count" data-row-key="${rowKey}">${options}</select>
        <button type="button" class="btn btn-small btn-danger" onclick="app.removePrintLocationRow('${rowKey}', '${containerId}')" aria-label="このプリント箇所を削除">🗑️</button>
      </div>
    `;
  },

  renderPrintLocationRows(locations = [], containerId = 'print-locations-container') {
    this.printLocationRowCounter = 0;
    this.printLocationRows = locations.map(l => ({
      rowKey: `existing-${this.printLocationRowCounter++}`,
      location_name: l.location_name,
      color_count: l.color_count
    }));

    const container = document.getElementById(containerId);
    if (!container) return;

    if (this.printLocationRows.length === 0) {
      container.innerHTML = '<div class="folder-notice">プリント箇所はまだありません</div>';
      return;
    }

    container.innerHTML = this.printLocationRows.map(row =>
      this.printLocationRowHtml(row.rowKey, row.location_name, row.color_count, containerId)
    ).join('');
  },

  addPrintLocationRow(containerId = 'print-locations-container') {
    const rowKey = `new-${this.printLocationRowCounter++}`;
    const container = document.getElementById(containerId);
    if (!container) return;

    const emptyNotice = container.querySelector('.folder-notice');
    if (emptyNotice) emptyNotice.remove();

    container.insertAdjacentHTML('beforeend', this.printLocationRowHtml(rowKey, '', 1, containerId));
  },

  removePrintLocationRow(rowKey, containerId = 'print-locations-container') {
    const container = document.getElementById(containerId);
    if (!container) return;
    const rowEl = container.querySelector(`[data-row-key="${rowKey}"]`);
    if (rowEl) rowEl.remove();

    if (container.children.length === 0) {
      container.innerHTML = '<div class="folder-notice">プリント箇所はまだありません</div>';
    }
  },

  collectPrintLocationData(containerId = 'print-locations-container') {
    const rows = [...document.querySelectorAll(`#${containerId} .print-location-row`)];
    return rows
      .map(rowEl => ({
        location_name: rowEl.querySelector('.pl-location-name').value.trim(),
        color_count: parseInt(rowEl.querySelector('.pl-color-count').value, 10) || 1
      }))
      .filter(row => row.location_name !== '');
  },

  async loadPreparationItems() {
    try {
      this.preparationItems = await API.getPreparationItems();
    } catch (error) {
      console.error('準備項目タスク取得エラー:', error);
      HiUI.toast('準備項目タスクの取得に失敗しました');
    }
  },

  getPreparationItemsForCase(caseId) {
    return this.preparationItems.filter(item => item.case_id === caseId);
  },

  // ===== UI: タブ切り替え =====
  // data-tab属性でボタンを特定するため、onclick経由(event.target)だけでなく
  // JavaScriptからの直接呼び出し(例: AI受注候補の登録後に一覧タブへ遷移)でも安全に動作する
  switchTab(tabName) {
    this.currentTab = tabName;

    // タブボタンのアクティブ状態を更新(スクリーンリーダー向けの aria-selected も揃える)
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.remove('active');
      btn.setAttribute('aria-selected', 'false');
    });
    const activeTabBtn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    activeTabBtn?.classList.add('active');
    activeTabBtn?.setAttribute('aria-selected', 'true');

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
    } else if (tabName === 'import') {
      this.loadAiIntakeList();
    }
  },

  // ===== UI: 一覧ビュー =====
  renderListView() {
    const projects = this.getFilteredProjects();
    const tbody = document.getElementById('projects-tbody');
    tbody.innerHTML = '';

    this.updateGroupHeaderUI();
    this.updateSortHeaderUI();

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

    const kindBadge = project.project_kind === 'INTERNAL_DESIGN'
      ? ' <span class="kind-badge-internal-design">🎨 社内デザイン</span>'
      : '';
    // 行の背景色だけでは意味が伝わらないため、納期の状態を文字でも併記する
    const deadlineFlag = this.deadlineFlagHtml(deadlineWarning);
    row.innerHTML = `
      <td class="cell-project-name">${this.escapeHtml(project.project_name)}${kindBadge}</td>
      <td>${formatDate(project.received_date)}</td>
      <td class="deadline-cell">${formatDate(project.deadline)}${deadlineFlag}</td>
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
      <td>
        <div class="row-actions">
          <button class="btn btn-small" onclick="app.openProjectModal(${project.id})">
            ✎ 編集
          </button>
          <button class="btn btn-small" onclick="app.openSuggestModal(${project.id})">
            🔎 提案
          </button>
          <button class="btn btn-small" onclick="app.openDeliverModal(${project.id})">
            📦 納品済み
          </button>
          ${this.designOpsButtonHtml(project)}
        </div>
      </td>
    `;

    return row;
  },

  // 「デザイン案件全般」ボードへの載せ替えボタン。
  // 載っている案件は押すと外れる(ボード側のカード右上「✕」と同じ動き)
  designOpsButtonHtml(project) {
    const on = !!project.is_design_ops;
    return `
      <button class="btn btn-small ${on ? 'btn-primary' : ''}"
        onclick="app.toggleDesignOps(${project.id}, ${on ? 'false' : 'true'})"
        title="${on ? 'デザイン案件全般のボードから外す' : 'デザイン案件全般のボードに載せる'}">
        🗂 ${on ? '全般から外す' : '全般へ'}
      </button>
    `;
  },

  async toggleDesignOps(projectId, include) {
    try {
      const res = await fetch(`/api/ops/cases/${projectId}/membership`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ include }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '更新に失敗しました');
      HiUI.toast(include
        ? `「${json.project_name}」をデザイン案件全般に載せました`
        : `「${json.project_name}」をデザイン案件全般から外しました`);
      await this.loadProjects();
      this.renderListView();
    } catch (error) {
      console.error('デザイン案件全般の切り替えエラー:', error);
      HiUI.toast('切り替えに失敗しました', 'error');
    }
  },

  deadlineFlagHtml(warning) {
    const flags = {
      overdue: { cls: 'is-overdue', label: '納期超過' },
      urgent: { cls: 'is-urgent', label: '3日以内' },
      warning: { cls: 'is-warning', label: '7日以内' }
    };
    const flag = flags[warning];
    return flag ? ` <span class="deadline-flag ${flag.cls}">${flag.label}</span>` : '';
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

    // 納品済み(COMPLETED)の案件は、削除はせず記録を残したまま一覧ビューには表示しない
    let filtered = this.projects.filter(p => p.status !== 'COMPLETED');

    if (statusFilter) {
      filtered = filtered.filter(p => p.status === statusFilter);
    }
    if (processFilter) {
      filtered = filtered.filter(p => (p.process_type || '').split(',').map(s => s.trim()).includes(processFilter));
    }
    if (staffFilter === 'UNASSIGNED') {
      filtered = filtered.filter(p => !p.assigned_staff_id);
    } else if (staffFilter) {
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

  // どの列で並び替え中かを列見出しの矢印で示す(押せる列は ⇅、並び替え中は ▲▼)
  updateSortHeaderUI() {
    const columnByThIndex = {
      0: 'project_name',
      1: 'received_date',
      2: 'deadline',
      5: 'quantity'
    };
    document.querySelectorAll('#projects-table thead th').forEach((th, index) => {
      th.classList.remove('sorted-asc', 'sorted-desc');
      th.removeAttribute('aria-sort');
      if (columnByThIndex[index] !== this.sortColumn) return;
      const isAsc = this.sortOrder === 'asc';
      th.classList.add(isAsc ? 'sorted-asc' : 'sorted-desc');
      th.setAttribute('aria-sort', isAsc ? 'ascending' : 'descending');
    });
  },

  // ===== UI: カンバンビュー =====
  kanbanActiveStatus: null,

  renderKanbanView() {
    const board = document.getElementById('kanban-board');
    const mobileTabs = document.getElementById('kanban-mobile-tabs');
    board.innerHTML = '';
    mobileTabs.innerHTML = '';

    const statuses = [
      { key: 'PRE_ORDER', label: '受注前' },
      { key: 'CONFIRMED', label: '受注確定' },
      { key: 'WAITING', label: '生産待ち' },
      { key: 'PREP_COMPLETE', label: '準備完了' },
      { key: 'IN_PROGRESS', label: '生産中' },
      { key: 'INSPECTION', label: '検品' },
      { key: 'DELIVERED', label: '納品待ち' }
    ];

    if (!this.kanbanActiveStatus || !statuses.some(s => s.key === this.kanbanActiveStatus)) {
      this.kanbanActiveStatus = statuses[0].key;
    }

    statuses.forEach(status => {
      const cardsInStatus = this.projects.filter(p => p.status === status.key);
      const isActive = status.key === this.kanbanActiveStatus;

      // モバイル用タブボタン（件数バッジ入り）
      const tabBtn = document.createElement('button');
      tabBtn.className = `kanban-tab-btn${isActive ? ' active' : ''}`;
      tabBtn.textContent = `${status.label} (${cardsInStatus.length})`;
      tabBtn.onclick = () => {
        this.kanbanActiveStatus = status.key;
        this.renderKanbanView();
      };
      mobileTabs.appendChild(tabBtn);

      const column = document.createElement('div');
      column.className = `kanban-column${isActive ? ' active' : ''}`;
      column.dataset.status = status.key;

      const header = document.createElement('div');
      header.className = 'kanban-header';
      header.innerHTML = `<h3>${status.label} <span class="kanban-count-badge">${cardsInStatus.length}</span></h3>`;
      column.appendChild(header);

      const content = document.createElement('div');
      content.className = 'kanban-cards';
      content.ondragover = (e) => e.preventDefault();
      content.ondrop = (e) => this.handleCardDrop(e, status.key);

      cardsInStatus.forEach(project => {
        const card = document.createElement('div');
        card.className = `kanban-card priority-${project.priority.toLowerCase()}`;
        card.draggable = true;
        card.ondragstart = (e) => this.handleCardDragStart(e, project.id);
        const prepItems = this.getPreparationItemsForCase(project.id);
        const prepProgressHtml = prepItems.length > 0
          ? `<div class="card-prep-progress">準備: ${prepItems.filter(i => i.status === '完了').length}/${prepItems.length}完了</div>`
          : '';
        const cardKindBadge = project.project_kind === 'INTERNAL_DESIGN'
          ? '<span class="kind-badge-internal-design">🎨 社内デザイン</span>'
          : '';
        card.innerHTML = `
          <div class="card-title">${this.escapeHtml(project.project_name)} ${cardKindBadge}</div>
          <div class="card-customer">${this.escapeHtml(project.customer_name)}</div>
          <div class="card-deadline">${formatDate(project.deadline)}</div>
          <div class="card-info">
            <span>${project.project_kind === 'INTERNAL_DESIGN' ? 'デザイン' : getProcessLabels(project.process_type)}</span>
            <span>${project.project_kind === 'INTERNAL_DESIGN' ? '' : `×${project.quantity}`}</span>
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
        HiUI.toast('ステータスの更新に失敗しました');
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
          const dateStr = formatDateISO(currentDate);
          if (dateStr === formatDateISO(new Date())) cell.classList.add('is-today');

          // この日付の案件を取得(納品済み(COMPLETED)は一覧ビューと同様に除外する)
          const projectsOnDate = this.projects.filter(p => p.deadline === dateStr && p.status !== 'COMPLETED');

          cell.innerHTML = `<div class="date-number">${date}</div>`;

          if (projectsOnDate.length > 0) {
            const itemsDiv = document.createElement('div');
            itemsDiv.className = 'calendar-items';
            projectsOnDate.forEach(p => {
              // 案件バーの色はステータスバッジと同じ配色にする(全部同じ青だと状態が読めない)
              const item = document.createElement('button');
              item.type = 'button';
              item.className = `calendar-item ${getStatusClass(p.status)}`;
              item.textContent = p.project_name.substring(0, 15);
              item.title = `${p.project_name}（${getStatusLabel(p.status)}）`;
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

  // テキスト中のキーワードから加工種別を推測する(コピペ取り込み・AI受注候補の両方で使用)
  detectProcessType(text) {
    return text.includes('刺繍') ? 'STANDARD_EMBROIDERY' : text.includes('帽子') ? 'HAT_EMBROIDERY' : text.includes('ワッペン') ? 'PATCH_EMBROIDERY' : text.includes('DTF') || text.includes('DTFプリント') ? 'DTF_PRINT' : text.includes('ラバー') ? 'RUBBER_TRANSFER_PRINT' : text.includes('昇華') ? 'SUBLIMATION_PRINT' : text.includes('シルク') ? 'SILK_SCREEN_PRINT' : 'STANDARD_EMBROIDERY';
  },

  // ===== UI: メール・電話で受けた注文の取り込み =====
  // どちらも案件を直接は作らず、他チャネルと同じ受注候補キューへ入れる。
  // 振り分け(生産/デザイン/要相談)を必ず通すため

  async submitPastedIntake() {
    const textarea = document.getElementById('import-textarea');
    const text = textarea.value;
    if (!text.trim()) {
      HiUI.toast('取り込む本文を貼り付けてください');
      return;
    }

    // AI抽出は数秒かかるので、二重送信を防ぎつつ待っていることが分かるようにする
    const button = document.getElementById('import-paste-btn');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = '読み取り中…';

    try {
      const result = await API.createPasteIntake(text);
      if (!result || result.error) {
        HiUI.toast(result?.error || '受注候補への取り込みに失敗しました');
        return;
      }
      textarea.value = '';
      HiUI.toast(result.used_ai
        ? `✓ 受注候補 ${result.receipt_no} に追加しました`
        : `✓ 受注候補 ${result.receipt_no} に追加しました(AI読み取りなし。内容を確認してください)`);
      await this.loadAiIntakeList();
    } catch (error) {
      console.error('貼り付け取り込みエラー:', error);
      HiUI.toast('受注候補への取り込みに失敗しました');
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  },

  async submitPhoneIntake() {
    const form = document.getElementById('phone-intake-form');
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const data = Object.fromEntries(new FormData(form));
    const button = document.getElementById('phone-intake-btn');
    button.disabled = true;

    try {
      const result = await API.createPhoneIntake(data);
      if (!result || result.error) {
        HiUI.toast(result?.error || '受注候補への取り込みに失敗しました');
        return;
      }
      this.resetPhoneIntakeForm();
      HiUI.toast(`✓ 受注候補 ${result.receipt_no} に追加しました`);
      await this.loadAiIntakeList();
    } catch (error) {
      console.error('電話メモの取り込みエラー:', error);
      HiUI.toast('受注候補への取り込みに失敗しました');
    } finally {
      button.disabled = false;
    }
  },

  resetPhoneIntakeForm() {
    document.getElementById('phone-intake-form').reset();
  },

  // ===== UI: AI受注候補(LINEから自動収集) =====
  currentAiIntakeDetail: null,

  async loadAiIntakeList() {
    try {
      this.aiIntakeList = await API.getAiIntakeList('pending');
    } catch (error) {
      console.error('AI受注候補取得エラー:', error);
      this.aiIntakeList = [];
    }
    this.populateTriageOperatorSelect();
    this.renderAiIntakeList();
  },

  renderAiIntakeList() {
    const badge = document.getElementById('ai-intake-badge');
    const grid = document.getElementById('ai-intake-list');
    const empty = document.getElementById('ai-intake-empty');
    if (!grid) return;

    // タブのバッジは未振り分け件数。「まだ誰も握っていない注文が何件あるか」が一番見たい数字のため
    const untriagedCount = this.aiIntakeList.filter(i => !i.triage_type).length;
    if (badge) {
      badge.textContent = untriagedCount;
      badge.style.display = untriagedCount > 0 ? 'inline-flex' : 'none';
    }

    const visible = this.aiIntakeList.filter(intake => {
      if (this.triageFilter === 'all') return true;
      if (this.triageFilter === 'none') return !intake.triage_type;
      return intake.triage_type === this.triageFilter;
    });

    grid.innerHTML = '';
    if (visible.length === 0) {
      empty.style.display = 'block';
      empty.textContent = this.aiIntakeList.length === 0
        ? '現在、確認待ちの受注候補はありません'
        : 'この絞り込みに該当する受注候補はありません';
      return;
    }
    empty.style.display = 'none';

    visible.forEach(intake => {
      const card = document.createElement('div');
      card.className = intake.triage_type ? 'ai-intake-card' : 'ai-intake-card is-untriaged';
      card.onclick = () => this.openAiIntakeModal(intake.id);

      if (intake.thumbnail_path) {
        const img = document.createElement('img');
        img.className = 'ai-intake-card-thumb';
        img.src = API.getNasFileUrl(intake.thumbnail_path);
        img.alt = '';
        card.appendChild(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'ai-intake-card-thumb ai-intake-card-thumb-empty';
        placeholder.textContent = '📷';
        card.appendChild(placeholder);
      }

      const body = document.createElement('div');
      body.className = 'ai-intake-card-body';

      const sender = document.createElement('div');
      sender.className = 'ai-intake-card-sender';
      sender.textContent = intake.display_name || '不明な送信者';
      // フォーム由来・手入力由来の候補には受付番号を併記する。
      // W-/T-/P- はお客様の完了画面・受付控えメールに出る番号と同一なので、問い合わせ対応時に突き合わせられる
      const receiptPrefix = RECEIPT_PREFIX[intake.line_user_id];
      if (receiptPrefix) {
        const receipt = document.createElement('span');
        receipt.className = 'receipt-badge';
        receipt.textContent = `${receiptPrefix}-${intake.id}`;
        sender.appendChild(receipt);
      }
      body.appendChild(sender);

      const items = document.createElement('div');
      items.className = 'ai-intake-card-items';
      items.textContent = intake.items || '(内容未抽出)';
      body.appendChild(items);

      const dateEl = document.createElement('div');
      dateEl.className = 'ai-intake-card-date';
      dateEl.textContent = formatDateTime(intake.extracted_at);
      body.appendChild(dateEl);

      card.appendChild(body);
      card.appendChild(this.buildTriageBar(intake));
      grid.appendChild(card);
    });
  },

  // ===== 受注候補の振り分け(三浦さん・山本さんの2名で行き先を決める) =====

  TRIAGE_LABELS: {
    production: { icon: '🏭', text: '生産', hint: '加工のみ・データ支給あり(三浦さん先導)' },
    design: { icon: '🎨', text: 'デザイン', hint: 'デザイン工程あり(山本さん先導)' },
    consult: { icon: '🤝', text: '要相談', hint: '二人で決めきれない・社長へ相談' },
  },

  // カード下部の振り分けバー。未振り分けなら3つのボタン、振り分け済みなら結果と取り消しを出す
  buildTriageBar(intake) {
    const bar = document.createElement('div');
    bar.className = 'triage-bar';
    // カード全体のクリックは確認モーダルを開くので、バー内のクリックは伝播させない
    bar.onclick = (e) => e.stopPropagation();

    if (intake.triage_type) {
      const label = this.TRIAGE_LABELS[intake.triage_type];
      const done = document.createElement('div');
      done.className = 'triage-done';

      const chip = document.createElement('span');
      chip.className = `triage-chip triage-chip-${intake.triage_type}`;
      chip.textContent = label ? `${label.icon} ${label.text}へ` : intake.triage_type;
      done.appendChild(chip);

      const by = document.createElement('span');
      by.className = 'triage-by';
      by.textContent = intake.triage_by
        ? `${intake.triage_by} / ${formatDateTime(intake.triage_at)}`
        : formatDateTime(intake.triage_at);
      done.appendChild(by);

      bar.appendChild(done);

      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'btn btn-small btn-ghost';
      undo.textContent = '取り消す';
      undo.onclick = () => this.triageIntake(intake.id, null);
      bar.appendChild(undo);
      return bar;
    }

    const buttons = document.createElement('div');
    buttons.className = 'triage-buttons';
    Object.entries(this.TRIAGE_LABELS).forEach(([type, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-small';
      btn.textContent = `${label.icon} ${label.text}`;
      btn.title = label.hint;
      btn.onclick = () => this.triageIntake(intake.id, type);
      buttons.appendChild(btn);
    });
    bar.appendChild(buttons);
    return bar;
  },

  async triageIntake(id, type) {
    const operator = this.getTriageOperator();
    if (type && !operator) {
      HiUI.toast('先に「振り分ける人」を選んでください');
      document.getElementById('triage-operator-select')?.focus();
      return;
    }
    try {
      const res = await API.triageAiIntake(id, type, operator);
      if (!res || res.error) {
        HiUI.toast(res?.error || '振り分けに失敗しました');
        return;
      }
      const label = type ? this.TRIAGE_LABELS[type] : null;
      HiUI.toast(label ? `${label.icon} ${label.text}へ振り分けました` : '振り分けを取り消しました');
      await this.loadAiIntakeList();
    } catch (error) {
      console.error('振り分けエラー:', error);
      HiUI.toast('振り分けに失敗しました');
    }
  },

  setTriageFilter(filter) {
    this.triageFilter = filter;
    document.querySelectorAll('.triage-filter').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.triageFilter === filter);
    });
    this.renderAiIntakeList();
  },

  // 振り分けた人は端末ごとの設定として覚えておく(HiBoardにログインの仕組みがないため)
  getTriageOperator() {
    return document.getElementById('triage-operator-select')?.value || '';
  },

  saveTriageOperator() {
    try {
      localStorage.setItem('hiboard.triageOperator', this.getTriageOperator());
    } catch {
      // プライベートモード等でlocalStorageが使えなくても振り分け自体は動かす
    }
  },

  async populateTriageOperatorSelect() {
    const select = document.getElementById('triage-operator-select');
    if (!select) return;
    let saved = '';
    try {
      saved = localStorage.getItem('hiboard.triageOperator') || '';
    } catch {
      saved = '';
    }
    const current = select.value || saved;

    if (!this.triageMembers) {
      try {
        const fetched = await API.getTriageMembers();
        this.triageMembers = Array.isArray(fetched) ? fetched : [];
      } catch (error) {
        console.error('振り分け担当者の取得エラー:', error);
        this.triageMembers = [];
      }
    }
    const names = this.triageMembers;

    select.innerHTML = '<option value="">選択してください</option>';
    names.forEach(name => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });
    if (current && names.includes(current)) select.value = current;
  },

  openAiIntakeModal(id) {
    this.editingAiIntakeId = id;
    this.currentAiIntakeDetail = null;

    document.getElementById('ai-intake-modal-title').textContent = 'AI受注候補の確認';
    document.getElementById('ai-intake-form').reset();
    document.getElementById('ai-intake-chat-transcript').innerHTML = '<p class="folder-notice">読み込み中…</p>';
    document.getElementById('ai-intake-deadline-hint').textContent = '';
    document.getElementById('ai-intake-quantity-hint').textContent = '';
    this.populateAiIntakeStaffSelect();

    document.getElementById('ai-intake-modal').style.display = 'flex';

    API.getAiIntake(id).then(intake => {
      if (!intake || intake.error) {
        HiUI.toast('AI受注候補の取得に失敗しました');
        this.closeAiIntakeModal();
        return;
      }
      this.currentAiIntakeDetail = intake;
      // Web注文フォーム(W-)・チーム追加注文(T-)・取引先加工依頼(P-)由来なら、タイトルに受付番号バッジを表示する
      const modalReceiptPrefix = RECEIPT_PREFIX[intake.line_user_id];
      const title = document.getElementById('ai-intake-modal-title');
      if (modalReceiptPrefix) {
        title.textContent = 'AI受注候補の確認 ';
        const receipt = document.createElement('span');
        receipt.className = 'receipt-badge';
        receipt.textContent = `${modalReceiptPrefix}-${intake.id}`;
        title.appendChild(receipt);
      }
      // 振り分け済みならその行き先をタイトルに出す(登録時に判断をなぞり直さなくて済むように)
      const triageLabel = this.TRIAGE_LABELS[intake.triage_type];
      if (triageLabel) {
        const chip = document.createElement('span');
        chip.className = `triage-chip triage-chip-${intake.triage_type}`;
        chip.textContent = `${triageLabel.icon} ${triageLabel.text}へ`;
        title.appendChild(document.createTextNode(' '));
        title.appendChild(chip);
      }
      this.renderAiIntakeChatTranscript(intake.messages || []);
      this.prefillAiIntakeForm(intake);
    }).catch(error => {
      console.error('AI受注候補取得エラー:', error);
      HiUI.toast('AI受注候補の取得に失敗しました');
      this.closeAiIntakeModal();
    });
  },

  closeAiIntakeModal() {
    document.getElementById('ai-intake-modal').style.display = 'none';
    document.getElementById('ai-intake-form').reset();
    document.getElementById('ai-intake-chat-transcript').innerHTML = '';
    this.editingAiIntakeId = null;
    this.currentAiIntakeDetail = null;
  },

  populateAiIntakeStaffSelect() {
    const select = document.getElementById('ai-intake-staff-select');
    if (!select) return;
    select.innerHTML = '<option value="">未割り当て</option>';
    this.staff.forEach(staff => {
      const option = document.createElement('option');
      option.value = staff.id;
      option.textContent = staff.name;
      select.appendChild(option);
    });
  },

  // LINEでのやり取りを時系列の吹き出しとして描画する
  renderAiIntakeChatTranscript(messages) {
    const container = document.getElementById('ai-intake-chat-transcript');
    container.innerHTML = '';

    if (messages.length === 0) {
      container.innerHTML = '<p class="folder-notice">メッセージが見つかりません</p>';
      return;
    }

    messages.forEach(message => {
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';

      if (message.message_type === 'image' && message.image_path) {
        const img = document.createElement('img');
        img.className = 'chat-bubble-image';
        img.src = API.getNasFileUrl(message.image_path);
        img.alt = 'LINE画像';
        img.onclick = () => this.openImageLightbox(img.src);
        bubble.appendChild(img);
      } else if (message.message_type === 'text') {
        const textEl = document.createElement('div');
        textEl.className = 'chat-bubble-text';
        textEl.textContent = message.text_content || '';
        bubble.appendChild(textEl);
      } else {
        const textEl = document.createElement('div');
        textEl.className = 'chat-bubble-text';
        textEl.textContent = `[${message.message_type}メッセージ]`;
        bubble.appendChild(textEl);
      }

      const timeEl = document.createElement('div');
      timeEl.className = 'chat-bubble-time';
      timeEl.textContent = formatDateTime(message.received_at);
      bubble.appendChild(timeEl);

      container.appendChild(bubble);
    });
  },

  // AIの抽出結果(自由記述のquantity/deadlineを含む)を登録フォームの初期値として反映する
  prefillAiIntakeForm(intake) {
    const form = document.getElementById('ai-intake-form');
    const messages = intake.messages || [];
    const firstMessage = messages[0];
    const receivedDate = firstMessage
      ? firstMessage.received_at.split('T')[0]
      : formatDateISO();

    const itemsText = intake.items || '';
    const quantityRaw = (intake.quantity || '').toString().trim();
    const quantityValue = /^\d+$/.test(quantityRaw) ? quantityRaw : (extractNumber(quantityRaw) || '');
    const deadlineValue = extractDate((intake.deadline || '').toString()) || '';

    form.elements['project_name'].value = itemsText.substring(0, 50) || (intake.customer_name ? `${intake.customer_name}様 ご依頼` : '');
    form.elements['customer_name'].value = intake.customer_name || '';
    form.elements['received_date'].value = receivedDate;
    form.elements['deadline'].value = deadlineValue;
    form.elements['contact_method'].value = 'LINE';
    form.elements['quantity'].value = quantityValue;
    form.elements['planned_hours'].value = '';
    form.elements['assigned_staff_id'].value = '';
    form.elements['status'].value = 'PRE_ORDER';
    form.elements['priority'].value = 'MEDIUM';
    form.elements['work_content'].value = itemsText;
    form.elements['memo'].value = intake.notes || '';

    form.elements['required_skill_tags'].value = '';
    form.elements['estimated_hours'].value = '';
    form.elements['nas_folder_path'].value = '';
    form.elements['freee_quote_url'].value = '';
    form.elements['freee_invoice_url'].value = '';

    this.setCheckboxGroupValues(form, 'process_type', this.detectProcessType(itemsText));

    // 振り分けで「🎨 デザイン」にした候補は、デザイン案件全般ボード(山本さん)へ載せる前提なので
    // is_design_ops を既定でONにする。振り分けの判断をここで入れ直さなくて済むようにするため
    if (form.elements['is_design_ops']) {
      form.elements['is_design_ops'].checked = intake.triage_type === 'design';
    }

    // 新規案件モーダルと同じ入力欄をここでも用意する(登録後に編集で入れ直す手間を無くすため)。
    // Web注文フォーム由来の候補はプリント箇所が raw_ai_response に入っているので、あれば初期表示する
    this.renderPrepItemsCheckboxGroup('ai-intake-prep-items-checkbox-group');
    this.renderPrintLocationRows(this.extractIntakePrintLocations(intake), 'ai-intake-print-locations-container');

    // AIが返した生の値が日付/数値としてうまく変換できなかった場合に備え、参考情報として表示する
    document.getElementById('ai-intake-deadline-hint').textContent = intake.deadline ? `AI抽出値: ${intake.deadline}` : '';
    document.getElementById('ai-intake-quantity-hint').textContent = intake.quantity ? `AI抽出値: ${intake.quantity}` : '';
  },

  // Web注文フォーム由来の候補は raw_ai_response にプリント箇所を持っているので取り出す。
  // LINE由来など持っていない候補は空配列(手入力してもらう)
  extractIntakePrintLocations(intake) {
    try {
      const raw = JSON.parse(intake.raw_ai_response || '{}');
      const locations = (raw.decoration && raw.decoration.print_locations) || [];
      return Array.isArray(locations) ? locations : [];
    } catch {
      return [];
    }
  },

  async submitAiIntakeConfirm() {
    if (!this.editingAiIntakeId) return;

    const form = document.getElementById('ai-intake-form');
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const formData = new FormData(form);
    const data = Object.fromEntries(formData);

    data.process_type = formData.getAll('process_type').join(',');
    if (!data.process_type) {
      HiUI.toast('加工種別を1つ以上選択してください');
      return;
    }

    data.quantity = parseInt(data.quantity);
    data.planned_hours = parseFloat(data.planned_hours);
    data.assigned_staff_id = data.assigned_staff_id ? parseInt(data.assigned_staff_id) : null;
    data.estimated_hours = data.estimated_hours ? parseFloat(data.estimated_hours) : null;
    // 必要スキルは複数選択なのでカンマ区切りにまとめる(新規案件モーダルと同じ扱い)
    data.required_skill_tags = formData.getAll('required_skill_tags').join(',');
    // 新規案件モーダルと同じく、プリント箇所と準備項目も一緒に登録する
    // (print_locations は確定処理が case_print_locations へ引き継ぐ)
    data.print_locations = this.collectPrintLocationData('ai-intake-print-locations-container');
    const prepItemCodes = formData.getAll('prep_items');
    data.prep_items = prepItemCodes.join(',');

    try {
      const result = await API.confirmAiIntake(this.editingAiIntakeId, data);
      if (result.error) {
        HiUI.toast(result.error);
        return;
      }
      console.log(`✓ AI受注候補 #${this.editingAiIntakeId} を案件 #${result.id} として登録`);

      // 準備項目は案件作成後に別APIでタスク化する(新規案件モーダルと同じ手順)。
      // デザイン案件全般の案件は、準備項目を1つも選んでいなくても呼ぶ
      // (サーバー側で「初稿提出」等をデザイン担当へ用意するため)
      const codeToId = new Map(this.prepItemsMaster.map(m => [m.code, m.id]));
      const prepItemIds = prepItemCodes.map(code => codeToId.get(code)).filter(Boolean);
      if (prepItemIds.length > 0 || data.is_design_ops) {
        await API.registerCasePreparationItems(result.id, prepItemIds);
      }

      this.closeAiIntakeModal();
      await this.loadAiIntakeList();
      await this.loadProjects();
      this.switchTab('list');
      this.renderListView();
      HiUI.toast('✓ 案件として登録しました');
    } catch (error) {
      console.error('AI受注候補の登録エラー:', error);
      HiUI.toast('案件の登録に失敗しました');
    }
  },

  async rejectAiIntakeConfirm() {
    if (!this.editingAiIntakeId) return;
    if (!confirm('この受注候補を却下してもよろしいですか？(データは削除されません)')) return;

    try {
      await API.rejectAiIntake(this.editingAiIntakeId);
      console.log(`✓ AI受注候補 #${this.editingAiIntakeId} を却下`);
      this.closeAiIntakeModal();
      await this.loadAiIntakeList();
    } catch (error) {
      console.error('AI受注候補の却下エラー:', error);
      HiUI.toast('却下処理に失敗しました');
    }
  },

  openImageLightbox(url) {
    document.getElementById('image-lightbox-img').src = url;
    document.getElementById('image-lightbox').classList.add('active');
  },

  closeImageLightbox() {
    document.getElementById('image-lightbox').classList.remove('active');
    document.getElementById('image-lightbox-img').src = '';
  },

  // ===== 案件種別(通常/社内デザイン)の切り替え =====
  // 社内デザイン選択中は生産系フィールド(.normal-only)を隠し、必須も解除して簡略登録にする。
  // 必須解除は「非表示のrequiredフィールドが送信をブロックする」ブラウザ仕様への対応
  onProjectKindChange() {
    const form = document.getElementById('project-form');
    const isInternalDesign = form.elements['project_kind'].value === 'INTERNAL_DESIGN';
    form.classList.toggle('internal-design-mode', isInternalDesign);
    document.getElementById('internal-design-hint').style.display = isInternalDesign ? 'block' : 'none';
    ['customer_name', 'contact_method', 'quantity', 'planned_hours'].forEach(name => {
      const field = form.elements[name];
      if (field) field.required = !isInternalDesign;
    });
  },

  // ===== 進行タイプの切り替え =====
  // 紙媒体(入稿で完了)を選んだときだけ、出どころ(HiYOSHi / CARVE)の選択を出す
  onOpsFlowChange() {
    const form = document.getElementById('project-form');
    const group = document.getElementById('pf-paper-source-group');
    if (!form || !group || !form.elements['ops_flow']) return;
    group.style.display = form.elements['ops_flow'].value === 'SUBMIT_END' ? 'block' : 'none';
  },

  // ===== UI: モーダル =====
  async openProjectModal(projectId = null) {
    this.editingProjectId = projectId;
    const modal = document.getElementById('project-modal');
    const form = document.getElementById('project-form');
    const title = document.getElementById('modal-title');
    const deleteBtn = document.getElementById('btn-delete');

    form.reset();
    this.onOpsFlowChange();  // 前回の表示状態が残らないようリセット直後にも当てる

    if (projectId) {
      title.textContent = '案件編集';
      deleteBtn.style.display = 'inline-block';

      const project = this.projects.find(p => p.id === projectId);
      if (project) {
        Object.entries(project).forEach(([key, value]) => {
          // チェックボックス群は NodeList になるため value 代入では設定できない。別途処理する
          if (key === 'process_type' || key === 'prep_items' || key === 'required_skill_tags') return;
          const field = form.elements[key];
          if (field && key !== 'id') {
            field.value = value || '';
          }
        });
        this.setCheckboxGroupValues(form, 'process_type', project.process_type);
        this.setCheckboxGroupValues(form, 'prep_items', project.prep_items);
        this.setCheckboxGroupValues(form, 'required_skill_tags', project.required_skill_tags);
        form.elements['project_kind'].value = project.project_kind || 'NORMAL';
        // 「デザイン案件全般」チェックの復元(このフラグが1の案件だけが専用ボードに載る)
        if (form.elements['is_design_ops']) {
          form.elements['is_design_ops'].checked = !!project.is_design_ops;
        }
        // 進行タイプ(加工まで / 紙媒体・入稿で完了)と、紙媒体の出どころの復元
        if (form.elements['ops_flow']) {
          form.elements['ops_flow'].value = project.ops_flow || 'FULL';
        }
        if (form.elements['paper_source']) {
          form.elements['paper_source'].value = project.paper_source || 'HIYOSHI';
        }
        this.onOpsFlowChange();
      }

      try {
        const printLocations = await API.getPrintLocations(projectId);
        this.renderPrintLocationRows(printLocations);
      } catch (error) {
        console.error('プリント箇所取得エラー:', error);
        this.renderPrintLocationRows();
      }

      document.getElementById('time-allocation-disabled-notice').style.display = 'none';
      document.getElementById('time-allocation-body').style.display = 'block';
      this.populateTimeAllocationEmployeeSelect();
      this.cancelEditTimeAllocation();
      this.loadTimeAllocations(projectId);
    } else {
      title.textContent = '新規案件';
      deleteBtn.style.display = 'none';
      this.renderPrintLocationRows();
      form.elements['received_date'].value = formatDateISO();

      document.getElementById('time-allocation-disabled-notice').style.display = 'block';
      document.getElementById('time-allocation-body').style.display = 'none';
      this.timeAllocations = [];
    }

    this.onProjectKindChange();
    setTimeout(() => this.loadNasFiles(), 0);
    modal.style.display = 'flex';
  },

  closeProjectModal() {
    document.getElementById('project-modal').style.display = 'none';
    this.editingProjectId = null;
  },

  // ===== 担当者提案 =====
  async openSuggestModal(projectId) {
    const modal = document.getElementById('suggest-modal');
    const body = document.getElementById('suggest-modal-body');
    const title = document.getElementById('suggest-modal-title');

    body.innerHTML = '<p>候補者を計算中...</p>';
    modal.style.display = 'flex';

    try {
      const res = await fetch(`/api/projects/${projectId}/suggest-assignees`);
      const data = await res.json();

      if (!res.ok) {
        body.innerHTML = `<p>${this.escapeHtml(data.error || '提案を取得できませんでした')}</p>`;
        return;
      }

      title.textContent = `${this.escapeHtml(data.project_name)} の担当者候補`;

      if (data.suggestions.length === 0) {
        body.innerHTML = '<p>対応可能な担当者が見つかりませんでした。</p>';
        return;
      }

      body.innerHTML = data.suggestions.map((s, i) => `
        <div class="suggest-card" style="border:1px solid var(--gray-200); border-radius:8px; padding:14px; margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong>${i + 1}. ${this.escapeHtml(s.employee_name)}</strong>
            <span>スコア: ${(s.score * 100).toFixed(0)}%</span>
          </div>
          <div style="color:var(--gray-600); font-size:14px; margin-top:6px;">
            空き時間: ${s.available_hours}h / 必要時間: ${s.required_hours}h<br>
            ${this.escapeHtml(s.reason)}
          </div>
          <button class="btn btn-primary" style="margin-top:8px;" onclick="app.assignFromSuggestion(${projectId}, ${s.employee_id})">
            この人に割り当てる
          </button>
        </div>
      `).join('');
    } catch (error) {
      console.error('提案取得エラー:', error);
      body.innerHTML = '<p>提案の取得に失敗しました。</p>';
    }
  },

  closeSuggestModal() {
    document.getElementById('suggest-modal').style.display = 'none';
  },

  async assignFromSuggestion(projectId, employeeId) {
    try {
      // assigned_employee_id の更新だけでなく、実際の作業時間もcase_time_allocationsへ
      // 日次分割で登録される(以前はPUT /api/projects/:idで割り当て先だけ更新しており、
      // スケジュールボードに本体の作業時間が反映されない不具合があった)
      const result = await API.assignEmployee(projectId, employeeId);
      if (result.error) {
        HiUI.toast(result.error);
        return;
      }
      this.closeSuggestModal();
      await this.loadProjects();
      this.renderListView();
      if (this.currentTab === 'kanban') this.renderKanbanView();
    } catch (error) {
      console.error('担当者割り当てエラー:', error);
      HiUI.toast('担当者の割り当てに失敗しました');
    }
  },

  // ===== 納品済み登録 =====
  openDeliverModal(projectId) {
    this.deliveringProjectId = projectId;
    const form = document.getElementById('deliver-form');
    form.reset();
    form.elements['delivered_date'].value = formatDateISO();
    this.populateDeliverStaffSelect();
    document.getElementById('deliver-modal').style.display = 'flex';
  },

  closeDeliverModal() {
    document.getElementById('deliver-modal').style.display = 'none';
    this.deliveringProjectId = null;
  },

  // 納品者は staff(担当者マスタ)・employees(従業員マスタ)のどちらからも選べるよう、
  // 1つのセレクトにoptgroupで両方の候補を並べる。値は "staff-<id>" / "employee-<id>" とし、
  // 送信時にどちらのテーブルを参照する納品者かを判別する
  populateDeliverStaffSelect() {
    const select = document.getElementById('deliver-staff-select');
    const staffOptions = this.staff.map(s => `<option value="staff-${s.id}">${this.escapeHtml(s.name)}</option>`).join('');
    const employeeOptions = this.employees
      .filter(e => e.is_active)
      .map(e => `<option value="employee-${e.id}">${this.escapeHtml(e.name)}</option>`).join('');
    select.innerHTML = `
      <option value="">未選択</option>
      <optgroup label="担当者">${staffOptions}</optgroup>
      <optgroup label="従業員">${employeeOptions}</optgroup>
    `;
  },

  async submitDeliverForm(event) {
    event.preventDefault();
    const form = event.target;

    // 指示書PDFのNAS保存は運用ルール(納品後の履歴をNASフォルダに集約する)。
    // 例外もあり得るため必須にはせず、未チェック時は確認だけ挟む
    if (!form.elements['instruction_pdf_saved'].checked) {
      if (!confirm('goodnoteの指示書PDFがまだ案件のNASフォルダに保存されていません。\nこのまま納品済みにしますか?')) {
        return;
      }
    }

    const deliveredBy = form.elements['delivered_by'].value;
    const [deliveredByType, deliveredById] = deliveredBy ? deliveredBy.split('-') : [null, null];

    const data = {
      delivered_date: form.elements['delivered_date'].value,
      delivery_method: form.elements['delivery_method'].value,
      delivered_by_staff_id: deliveredByType === 'staff' ? deliveredById : null,
      delivered_by_employee_id: deliveredByType === 'employee' ? deliveredById : null,
    };

    try {
      const result = await API.deliverProject(this.deliveringProjectId, data);
      if (result.error) {
        HiUI.toast(result.error);
        return;
      }
      this.closeDeliverModal();
      await this.loadProjects();
      this.renderListView();
      if (this.currentTab === 'kanban') this.renderKanbanView();
      if (this.currentTab === 'calendar') this.renderCalendarView();
    } catch (error) {
      console.error('納品済み登録エラー:', error);
      HiUI.toast('納品済みへの更新に失敗しました');
    }
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
      HiUI.toast('作業計画の取得に失敗しました');
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
          <button class="btn btn-small btn-danger" onclick="app.deleteTimeAllocation(${allocation.id})">🗑️ 削除</button>
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
      HiUI.toast('担当従業員・日付・予定時間を入力してください');
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
      HiUI.toast('作業計画の保存に失敗しました');
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
      HiUI.toast('作業計画の削除に失敗しました');
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

  // Freee見積書/請求書リンクを新しいタブで開く(案件モーダルの「📄 開く」ボタン用)
  openFreeeLink(inputId) {
    const url = document.getElementById(inputId)?.value?.trim();
    if (!url) {
      HiUI.toast('リンクが未入力です。Freeeで見積書/請求書を開いたときのURLを貼り付けてください');
      return;
    }
    if (!/^https?:\/\//.test(url)) {
      HiUI.toast('URLは https:// から始まる形式で入力してください');
      return;
    }
    window.open(url, '_blank');
  },

  async openNasFile(filePath) {
    try {
      const result = await API.openNasFile(filePath);
      if (result.success) {
        console.log('Opened file in Finder:', filePath);
      } else {
        HiUI.toast(result.error || 'ファイルを開くことができませんでした');
      }
    } catch (error) {
      console.error('NAS open error:', error);
      HiUI.toast('ファイルを開くことができませんでした');
    }
  },

  async submitProjectForm(e) {
    e.preventDefault();
    const form = document.getElementById('project-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData);
    const isInternalDesign = data.project_kind === 'INTERNAL_DESIGN';

    // 加工種別（複数選択）をカンマ区切りにまとめる。社内デザイン案件は加工なしでよい
    data.process_type = formData.getAll('process_type').join(',');
    if (!data.process_type && !isInternalDesign) {
      HiUI.toast('加工種別を1つ以上選択してください');
      return;
    }

    // 社内デザイン案件の簡略登録: 非表示フィールドへ既定値を入れる。
    // 新規登録時のステータスは「生産待ち」固定 — 準備項目(デザイン作業)が全て完了すると
    // 既存の同期処理で自動的に「準備完了」へ進む(編集時は現在のステータスを維持)
    if (isInternalDesign) {
      data.customer_name = data.customer_name || '社内';
      data.contact_method = data.contact_method || 'OTHER';
      data.quantity = data.quantity || '0';
      data.planned_hours = data.planned_hours || '0';
      if (!this.editingProjectId) data.status = 'WAITING';
    }

    // 作業の準備項目（複数選択・任意）をカンマ区切りにまとめる
    const prepItemCodes = formData.getAll('prep_items');
    data.prep_items = prepItemCodes.join(',');

    // 必要スキル（複数選択・任意）はカンマ区切りにまとめる。
    // 値は加工種別のコード(SILK_SCREEN_PRINT 等)で、従業員の「得意スキル」と突き合わせて
    // 担当者の自動提案に使われる。見積もり工数（任意）はスケジュール計算には使わない
    data.required_skill_tags = formData.getAll('required_skill_tags').join(',');
    data.estimated_hours = data.estimated_hours ? parseFloat(data.estimated_hours) : null;

    // 数値変換
    data.quantity = parseInt(data.quantity) || 0;
    data.planned_hours = parseFloat(data.planned_hours) || 0;
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

      // 選択された準備項目をタスクとして登録(既に登録済みのものはサーバー側でスキップされる)。
      // デザイン案件全般の案件は、準備項目を1つも選んでいなくても呼ぶ。
      // サーバー側が「初稿提出」等をデザイン担当へ用意するので、
      // 準備項目も担当者も未選択のまま登録しても鈴木さんのボードに必ずタスクが出る
      const codeToId = new Map(this.prepItemsMaster.map(m => [m.code, m.id]));
      const prepItemIds = prepItemCodes.map(code => codeToId.get(code)).filter(Boolean);
      if (prepItemIds.length > 0 || data.is_design_ops) {
        await API.registerCasePreparationItems(projectId, prepItemIds);
      }

      await API.savePrintLocations(projectId, this.collectPrintLocationData());

      await this.loadProjects();
      this.closeProjectModal();
      this.renderListView();
      if (this.currentTab === 'kanban') this.renderKanbanView();

      // 他画面の「新規案件」ボタンから来た場合は、登録後にその画面へ戻す
      // (デザイン案件全般ボードから登録したら、そのままボードへ戻る)
      if (this.returnAfterSave) {
        const url = this.returnAfterSave;
        this.returnAfterSave = null;
        window.location.href = url;
      }
    } catch (error) {
      console.error('案件保存エラー:', error);
      HiUI.toast('案件の保存に失敗しました');
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
      HiUI.toast('案件の削除に失敗しました');
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
      HiUI.toast('スタッフの保存に失敗しました');
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
          <button class="btn btn-small btn-danger" onclick="app.deleteStaff(${staff.id})">
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
      HiUI.toast('スタッフの削除に失敗しました');
    }
  },

  updateStaffSelects() {
    // フォームの担当者セレクトと一覧の絞り込みセレクトを更新する。
    // 先頭の選択肢は用途が違うので分ける:
    //   フォーム   … 空欄 = 未割り当てとして保存する
    //   絞り込み   … 空欄 = すべて表示 / UNASSIGNED = 未割り当ての案件だけ
    const staffSelect = document.getElementById('staff-select');
    const filterStaffSelect = document.getElementById('filter-staff');

    [staffSelect, filterStaffSelect].forEach(select => {
      const currentValue = select?.value;
      if (select) {
        select.innerHTML = select === filterStaffSelect
          ? '<option value="">すべて</option><option value="UNASSIGNED">未割り当てのみ</option>'
          : '<option value="">未割り当て</option>';
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
    // 他画面のヘッダーメニュー「担当者マスタ」からは /?open=staff で戻ってくる
    if (params.get('open') === 'staff') {
      this.openStaffModal();
    }

    // デザイン案件全般ボードの「➕ 新規案件」「✎ 案件を編集」からは
    // /?open=new-project&design_ops=1&return=/ops または /?open=edit-project&id=N&return=/ops で来る。
    // 案件フォームは1つしかないので複製せず、この画面のモーダルを開いて使ってもらう
    const open = params.get('open');
    if (open === 'new-project' || open === 'edit-project') {
      // 戻り先は自サイト内の相対パスだけ受け付ける(外部URLへ飛ばさないため)
      const back = params.get('return');
      this.returnAfterSave = back && /^\/[^/]/.test(back) ? back : null;

      if (open === 'edit-project') {
        const id = parseInt(params.get('id'), 10);
        if (Number.isFinite(id)) this.openProjectModal(id);
      } else {
        this.openProjectModal();
        if (params.get('design_ops') === '1') {
          const box = document.getElementById('project-form').elements['is_design_ops'];
          if (box) box.checked = true;
        }
      }
    }
  }
};

// ===== イベントリスナー =====
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('project-form')?.addEventListener('submit', (e) => app.submitProjectForm(e));
  document.getElementById('staff-form')?.addEventListener('submit', (e) => app.submitStaffForm(e));
  document.getElementById('deliver-form')?.addEventListener('submit', (e) => app.submitDeliverForm(e));
  // ボタンはtype="button"でapp.submitAiIntakeConfirm()を直接呼ぶため、
  // フォーム内でEnterキー等により暗黙的にsubmitされた場合のページ遷移だけを防ぐ
  document.getElementById('ai-intake-form')?.addEventListener('submit', (e) => e.preventDefault());

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

  // 背景クリック・Escキーでの閉じる処理は js/ui.js が全モーダル共通で行う
  // (モーダル内の .btn-close をクリックするため、各画面の閉じる処理がそのまま動く)

  // アプリ初期化
  app.init();
});
