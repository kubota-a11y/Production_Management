// ========================================
// 週間作業スケジュールボード ロジック
// ========================================

const scheduleBoard = {
  // ===== ステート =====
  employees: [],
  projects: [],
  scheduleOverrides: [],
  allocations: [],
  preparationItems: [],
  unassignedPreparationItems: [],
  projectProgress: [],
  currentWeekStart: null,
  detailModalContext: null,
  overrideModalContext: null,

  colorPalette: [
    '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899',
    '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#06b6d4'
  ],

  // ===== 初期化 =====
  async init() {
    console.log('🚀 週間作業スケジュールボード初期化中...');
    this.currentWeekStart = this.getMonday(new Date());
    await this.loadEmployees();
    await this.loadProjects();
    await this.loadScheduleOverrides();
    await this.loadWeekAllocations();
    await this.loadWeekPreparationItems();
    await this.loadProjectProgress();
    this.render();
    console.log('✓ 初期化完了');
  },

  // ===== 日付ユーティリティ =====
  getMonday(date) {
    const d = new Date(date);
    const day = d.getDay(); // 0=日,1=月,...6=土
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  },

  toISODate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  },

  getWeekDates() {
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(this.currentWeekStart);
      d.setDate(d.getDate() + i);
      dates.push(d);
    }
    return dates;
  },

  timeToHours(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h + m / 60;
  },

  // ===== データ取得 =====
  async loadEmployees() {
    try {
      const all = await (await fetch('/api/employees')).json();
      this.employees = all.filter(e => e.is_active);
    } catch (error) {
      console.error('従業員取得エラー:', error);
      alert('従業員の取得に失敗しました');
    }
  },

  async loadProjects() {
    try {
      const all = await (await fetch('/api/projects')).json();
      // 生産中・受注確定など進行中ステータスの案件をプルダウンの上位に表示する
      const priorityOrder = ['IN_PROGRESS', 'CONFIRMED', 'WAITING', 'INSPECTION', 'PRE_ORDER', 'DELIVERED'];
      this.projects = [...all].sort((a, b) => {
        const ai = priorityOrder.indexOf(a.status);
        const bi = priorityOrder.indexOf(b.status);
        return (ai === -1 ? priorityOrder.length : ai) - (bi === -1 ? priorityOrder.length : bi);
      });
    } catch (error) {
      console.error('案件取得エラー:', error);
      alert('案件の取得に失敗しました');
      this.projects = [];
    }
  },

  async loadScheduleOverrides() {
    try {
      this.scheduleOverrides = await (await fetch('/api/schedule-overrides')).json();
    } catch (error) {
      console.error('勤務時間の個別変更取得エラー:', error);
      alert('勤務時間の個別変更の取得に失敗しました');
      this.scheduleOverrides = [];
    }
  },

  async loadWeekAllocations() {
    try {
      const dates = this.getWeekDates();
      const start = this.toISODate(dates[0]);
      const end = this.toISODate(dates[6]);
      this.allocations = await (await fetch(`/api/time-allocations?start=${start}&end=${end}`)).json();
    } catch (error) {
      console.error('作業計画取得エラー:', error);
      alert('作業計画の取得に失敗しました');
      this.allocations = [];
    }
  },

  async loadWeekPreparationItems() {
    try {
      const dates = this.getWeekDates();
      const start = this.toISODate(dates[0]);
      const end = this.toISODate(dates[6]);
      this.preparationItems = await (await fetch(`/api/preparation-items?start=${start}&end=${end}`)).json();
    } catch (error) {
      console.error('準備項目タスク取得エラー:', error);
      alert('準備項目タスクの取得に失敗しました');
      this.preparationItems = [];
    }
  },

  async loadUnassignedPreparationItems() {
    try {
      const all = await (await fetch('/api/preparation-items?unassigned=true')).json();
      this.unassignedPreparationItems = all.filter(i => i.status !== '完了');
    } catch (error) {
      console.error('未割当の準備項目タスク取得エラー:', error);
      alert('未割当の準備項目タスクの取得に失敗しました');
      this.unassignedPreparationItems = [];
    }
  },

  async loadProjectProgress() {
    try {
      this.projectProgress = await (await fetch('/api/stats/project-progress')).json();
    } catch (error) {
      console.error('消化率取得エラー:', error);
      alert('案件別消化率の取得に失敗しました');
      this.projectProgress = [];
    }
  },

  // ===== 週送り =====
  async prevWeek() {
    this.currentWeekStart.setDate(this.currentWeekStart.getDate() - 7);
    await this.loadWeekAllocations();
    await this.loadWeekPreparationItems();
    this.render();
  },

  async nextWeek() {
    this.currentWeekStart.setDate(this.currentWeekStart.getDate() + 7);
    await this.loadWeekAllocations();
    await this.loadWeekPreparationItems();
    this.render();
  },

  // ===== ヘルパー =====
  getOverrideFor(employeeId, dateISO) {
    return this.scheduleOverrides.find(o => o.employee_id === employeeId && o.work_date === dateISO);
  },

  roundHours(hours) {
    return Math.round(hours * 100) / 100;
  },

  // その日の基準勤務時間（横棒グラフの100%幅・計画不足判定の基準）を決定する。
  // schedule_overrides にその日のレコードがあり、かつ休みでない場合のみ勤務日として扱う
  getReferenceInfo(employeeId, dateISO) {
    const override = this.getOverrideFor(employeeId, dateISO);

    if (!override || override.is_day_off) {
      return { hours: 0, override: override || null };
    }

    const hours = (override.start_time && override.end_time)
      ? Math.max(this.timeToHours(override.end_time) - this.timeToHours(override.start_time) - (override.break_minutes || 0) / 60, 0)
      : 0;
    return { hours, override };
  },

  getAllocationsFor(employeeId, dateISO) {
    return this.allocations.filter(a => a.employee_id === employeeId && a.work_date === dateISO);
  },

  getPrepItemsFor(employeeId, dateISO) {
    return this.preparationItems.filter(i => i.assigned_staff_id === employeeId && i.scheduled_date === dateISO);
  },

  getProjectColor(projectId) {
    return this.colorPalette[projectId % this.colorPalette.length];
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  },

  // ===== 描画 =====
  render() {
    this.renderWeekLabel();
    this.renderBoard();
    this.renderLegend();
    this.renderProgress();
  },

  renderWeekLabel() {
    const dates = this.getWeekDates();
    const label = document.getElementById('sb-week-label');
    label.textContent = `${formatDate(this.toISODate(dates[0]))} 〜 ${formatDate(this.toISODate(dates[6]))}`;
  },

  renderBoard() {
    const dates = this.getWeekDates();
    const head = document.getElementById('sb-board-head');
    const body = document.getElementById('sb-board-body');

    head.innerHTML = '<th>従業員</th>' + dates.map(d => `
      <th>${getDayOfWeekLabel(this.jsDayToOurDay(d.getDay()))}
        <span class="sb-day-header-date">${d.getMonth() + 1}/${d.getDate()}</span>
      </th>
    `).join('');

    body.innerHTML = '';

    if (this.employees.length === 0) {
      body.innerHTML = `<tr><td colspan="8" class="sb-empty-notice">有効な従業員が登録されていません</td></tr>`;
      return;
    }

    this.employees.forEach(employee => {
      const row = document.createElement('tr');
      const cells = dates.map(date => this.renderCell(employee, date)).join('');
      row.innerHTML = `<td class="sb-employee-cell">${this.escapeHtml(employee.name)}</td>${cells}`;
      body.appendChild(row);
    });
  },

  // JSのgetDay()(0=日〜6=土)を本アプリの day_of_week(0=月〜6=日) に変換
  jsDayToOurDay(jsDay) {
    return jsDay === 0 ? 6 : jsDay - 1;
  },

  renderCell(employee, date) {
    const dateISO = this.toISODate(date);
    const refInfo = this.getReferenceInfo(employee.id, dateISO);
    const referenceHours = refInfo.hours;
    const cellOnclick = `scheduleBoard.openOverrideModal(${employee.id}, '${dateISO}')`;

    if (referenceHours <= 0) {
      return `<td class="sb-cell" onclick="${cellOnclick}"><div class="sb-cell-off">休み</div></td>`;
    }

    const dayAllocations = this.getAllocationsFor(employee.id, dateISO);
    const dayPrepItems = this.getPrepItemsFor(employee.id, dateISO);
    const allocationHours = dayAllocations.reduce((sum, a) => sum + a.planned_hours, 0);
    const prepHours = dayPrepItems.reduce((sum, i) => sum + (i.estimated_hours || 0), 0);
    const plannedTotal = allocationHours + prepHours;
    const scaleMax = Math.max(referenceHours, plannedTotal, 0.1);
    const referencePct = Math.min((referenceHours / scaleMax) * 100, 100);
    const isShort = plannedTotal < referenceHours;

    const segments = dayAllocations.map(a => {
      const widthPct = (a.planned_hours / scaleMax) * 100;
      const color = this.getProjectColor(a.case_id);
      const title = `${a.project_name}: 予定${a.planned_hours}h${a.actual_hours != null ? ` / 実績${a.actual_hours}h` : ''}`;
      return `<div class="sb-bar-segment" style="width:${widthPct}%; background:${color};" title="${this.escapeHtml(title)}">${this.escapeHtml(a.project_name)}</div>`;
    }).join('');

    // 準備項目タスクは案件の作業と区別できるよう【準備】ラベル・専用スタイルで表示する
    const prepSegments = dayPrepItems.map(i => {
      const hours = i.estimated_hours || 0;
      const widthPct = (hours / scaleMax) * 100;
      const label = `【準備】${i.project_name} / ${i.preparation_item_name}`;
      const title = `${label}: 予定${hours}h（${i.status}）`;
      return `<div class="sb-bar-segment sb-bar-segment-prep${i.status === '完了' ? ' is-completed' : ''}" style="width:${widthPct}%;" title="${this.escapeHtml(title)}">${this.escapeHtml(label)}</div>`;
    }).join('');

    return `
      <td class="sb-cell" onclick="${cellOnclick}">
        ${isShort ? `<div class="sb-cell-warning" title="計画時間(${this.roundHours(plannedTotal)}h)が勤務時間(${this.roundHours(referenceHours)}h)に不足しています">⚠️ 計画不足</div>` : ''}
        <div class="sb-cell-hours-label">${this.roundHours(plannedTotal)}h / ${this.roundHours(referenceHours)}h</div>
        <div class="sb-bar-track" onclick="event.stopPropagation(); scheduleBoard.openDetailModal(${employee.id}, '${dateISO}')">
          ${segments}
          ${prepSegments}
          <div class="sb-bar-reference-marker" style="left:${referencePct}%;"></div>
        </div>
      </td>
    `;
  },

  renderLegend() {
    const legend = document.getElementById('sb-legend');
    const seen = new Map();
    this.allocations.forEach(a => {
      if (!seen.has(a.case_id)) seen.set(a.case_id, a.project_name);
    });

    if (seen.size === 0) {
      legend.innerHTML = '';
      return;
    }

    legend.innerHTML = [...seen.entries()].map(([caseId, name]) => `
      <div class="sb-legend-item">
        <span class="sb-legend-swatch" style="background:${this.getProjectColor(caseId)};"></span>
        ${this.escapeHtml(name)}
      </div>
    `).join('');
  },

  renderProgress() {
    const list = document.getElementById('sb-progress-list');

    if (this.projectProgress.length === 0) {
      list.innerHTML = '<p class="sb-empty-notice">作業計画が登録されている案件がありません</p>';
      return;
    }

    list.innerHTML = this.projectProgress.map(p => {
      const pct = p.progress_ratio * 100;
      const barWidth = Math.min(pct, 100);
      const isOver = pct > 100;
      return `
        <div class="sb-progress-item">
          <div class="sb-progress-name" title="${this.escapeHtml(p.project_name)}">${this.escapeHtml(p.project_name)}</div>
          <div class="sb-progress-bar-track">
            <div class="sb-progress-bar-fill ${isOver ? 'is-over' : ''}" style="width:${barWidth}%;"></div>
          </div>
          <div class="sb-progress-numbers">${p.actual_hours_total}h / ${p.planned_hours_total.toFixed(1)}h（${pct.toFixed(0)}%）</div>
        </div>
      `;
    }).join('');
  },

  // ===== セル詳細モーダル =====
  openDetailModal(employeeId, dateISO) {
    const employee = this.employees.find(e => e.id === employeeId);
    if (!employee) return;

    this.detailModalContext = { employeeId, dateISO };
    this.renderDetailModalBody();

    const title = document.getElementById('sb-detail-title');
    title.textContent = `${employee.name} / ${formatDate(dateISO)}`;
    document.getElementById('sb-detail-modal').style.display = 'flex';
  },

  renderDetailModalBody() {
    if (!this.detailModalContext) return;
    const { employeeId, dateISO } = this.detailModalContext;
    const dayAllocations = this.getAllocationsFor(employeeId, dateISO);
    const dayPrepItems = this.getPrepItemsFor(employeeId, dateISO);
    const body = document.getElementById('sb-detail-body');

    if (dayAllocations.length === 0 && dayPrepItems.length === 0) {
      body.innerHTML = '<p class="sb-empty-notice">この日の作業計画は登録されていません</p>';
      return;
    }

    const allocationsHtml = dayAllocations.map(a => `
      <div class="sb-detail-row">
        <div class="sb-detail-row-top">
          <span class="sb-detail-swatch" style="background:${this.getProjectColor(a.case_id)};"></span>
          <span class="sb-detail-project-name">${this.escapeHtml(a.project_name)}</span>
          <span class="sb-detail-meta">予定${a.planned_hours}h（${this.escapeHtml(a.status || '')}）</span>
        </div>
        <div class="sb-detail-row-actual">
          <label>実績時間:</label>
          <input
            type="number" step="0.5" min="0" placeholder="未入力"
            class="sb-actual-input" data-allocation-id="${a.id}"
            value="${a.actual_hours ?? ''}"
            onkeydown="if (event.key === 'Enter') { event.preventDefault(); scheduleBoard.saveActualHours(${a.id}); }"
          >
          <span>h</span>
          <button type="button" class="btn-small btn-primary" onclick="scheduleBoard.saveActualHours(${a.id})">保存</button>
          <span class="sb-actual-save-status" id="sb-actual-save-status-${a.id}"></span>
        </div>
      </div>
    `).join('');

    // 準備項目タスクは案件の作業と区別できるよう【準備】ラベルで表示し、完了チェックボックスのみを持つ
    const prepItemsHtml = dayPrepItems.map(i => `
      <div class="sb-detail-row sb-detail-row-prep">
        <div class="sb-detail-row-top">
          <span class="sb-detail-swatch sb-detail-swatch-prep"></span>
          <span class="sb-detail-project-name">【準備】${this.escapeHtml(i.project_name)} / ${this.escapeHtml(i.preparation_item_name)}</span>
          <span class="sb-detail-meta">予定${i.estimated_hours ?? '-'}h（${this.escapeHtml(i.status)}）</span>
        </div>
        <div class="sb-detail-row-actual">
          <label class="sb-prep-complete-check">
            <input type="checkbox" ${i.status === '完了' ? 'checked' : ''} onchange="scheduleBoard.togglePrepItemComplete(${i.id}, this.checked)">
            完了
          </label>
        </div>
      </div>
    `).join('');

    body.innerHTML = allocationsHtml + prepItemsHtml;
  },

  async togglePrepItemComplete(itemId, isComplete) {
    try {
      await fetch(`/api/preparation-items/${itemId}/${isComplete ? 'complete' : 'incomplete'}`, { method: 'PUT' });
      await this.loadWeekPreparationItems();
      await this.loadProjects();
      this.renderDetailModalBody();
      this.renderBoard();
      console.log(`✓ 準備項目タスクの完了状態を更新 (item #${itemId})`);
    } catch (error) {
      console.error('準備項目タスク完了状態更新エラー:', error);
      alert('完了状態の更新に失敗しました');
    }
  },

  async saveActualHours(allocationId) {
    const input = document.querySelector(`.sb-actual-input[data-allocation-id="${allocationId}"]`);
    const statusEl = document.getElementById(`sb-actual-save-status-${allocationId}`);
    const rawValue = input.value.trim();
    const actualHours = rawValue === '' ? null : parseFloat(rawValue);

    if (rawValue !== '' && Number.isNaN(actualHours)) {
      alert('実績時間には数値を入力してください');
      return;
    }

    try {
      await fetch(`/api/time-allocations/${allocationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actual_hours: actualHours })
      });

      const allocation = this.allocations.find(a => a.id === allocationId);
      if (allocation) allocation.actual_hours = actualHours;

      if (statusEl) {
        statusEl.textContent = '✓ 保存しました';
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
      }

      await this.loadProjectProgress();
      this.renderBoard();
      this.renderProgress();
      console.log(`✓ 実績時間を更新 (allocation #${allocationId})`);
    } catch (error) {
      console.error('実績時間更新エラー:', error);
      alert('実績時間の更新に失敗しました');
    }
  },

  closeDetailModal() {
    document.getElementById('sb-detail-modal').style.display = 'none';
  },

  // ===== 勤務時間編集モーダル（その日だけの勤務時間 + 案件の割り当て） =====
  async openOverrideModal(employeeId, dateISO) {
    const employee = this.employees.find(e => e.id === employeeId);
    if (!employee) return;

    const override = this.getOverrideFor(employeeId, dateISO);
    const dayAllocations = this.getAllocationsFor(employeeId, dateISO);
    const dayPrepItems = this.getPrepItemsFor(employeeId, dateISO);

    await this.loadUnassignedPreparationItems();

    this.overrideModalContext = {
      employeeId,
      dateISO,
      overrideId: override ? override.id : null,
      // 割り当て行の「開いた時点」のスナップショット。保存時にこれと現在のDOMを比較して削除行を判定する
      allocationRows: dayAllocations.map(a => ({
        rowKey: `existing-${a.id}`,
        id: a.id,
        case_id: a.case_id,
        planned_hours: a.planned_hours,
        actual_hours: a.actual_hours
      })),
      newRowCounter: 0,
      // 準備項目タスクは既存タスク(case_preparation_items)への割り当てのみ(新規作成はしない)
      prepItemRows: dayPrepItems.map(i => ({
        id: i.id,
        label: `${i.project_name} / ${i.preparation_item_name}`,
        estimated_hours: i.estimated_hours,
        status: i.status
      })),
      removedPrepItemIds: []
    };

    document.getElementById('sb-override-title').textContent = `${employee.name} / ${formatDate(dateISO)} の勤務時間`;

    const isDayOff = override ? !!override.is_day_off : false;
    document.getElementById('ov-is-day-off').checked = isDayOff;
    document.getElementById('ov-start-time').value = override?.start_time || '';
    document.getElementById('ov-end-time').value = override?.end_time || '';
    document.getElementById('ov-break-minutes').value = override?.break_minutes ?? 0;
    this.toggleOverrideTimeInputs(isDayOff);

    document.getElementById('ov-delete-btn').style.display = override ? 'inline-block' : 'none';

    this.renderAllocationRows();
    this.renderPrepItemRows();
    this.renderPrepItemAddOptions();
    this.updateOverrideSummary();

    document.getElementById('sb-override-modal').style.display = 'flex';
  },

  // 「この日は休み」チェックボックスに応じて時刻・休憩の入力可否を切り替える
  toggleOverrideTimeInputs(isDayOff) {
    document.getElementById('ov-start-time').disabled = isDayOff;
    document.getElementById('ov-end-time').disabled = isDayOff;
    document.getElementById('ov-break-minutes').disabled = isDayOff;
  },

  closeOverrideModal() {
    document.getElementById('sb-override-modal').style.display = 'none';
    this.overrideModalContext = null;
  },

  // ===== 案件の割り当て（モーダル内） =====
  // 割り当てプルダウンに出す案件のみに絞り込む:
  //   1) ステータスが「生産待ち・準備完了・生産中」のいずれかであること
  //   2) 案件の作業予定時間（分→時間換算）に対して、すでに全時間分を作業計画へ割り振り済みでないこと
  //      （例: 3時間の案件に3時間分を割り振り済みなら、以後のプルダウンには表示しない）
  // ただし、その行で現在選択中の案件は上記に当てはまらなくなっていても選択肢から消さない
  ASSIGNABLE_PROJECT_STATUSES: ['WAITING', 'PREP_COMPLETE', 'IN_PROGRESS'],

  isProjectAssignable(project) {
    if (!this.ASSIGNABLE_PROJECT_STATUSES.includes(project.status)) return false;
    const budgetHours = (project.planned_hours || 0) / 60;
    const allocatedHours = project.allocated_hours_total || 0;
    const remainingHours = budgetHours - allocatedHours;
    return remainingHours > 0.001; // 浮動小数点誤差を吸収する程度の許容値
  },

  getProjectOptionsHtml(selectedCaseId) {
    const selectableProjects = this.projects.filter(p =>
      this.isProjectAssignable(p) || String(p.id) === String(selectedCaseId)
    );
    if (selectableProjects.length === 0) return '';
    return selectableProjects.map(p => `
      <option value="${p.id}" ${String(p.id) === String(selectedCaseId) ? 'selected' : ''}>${this.escapeHtml(p.project_name)}</option>
    `).join('');
  },

  allocationRowHtml(rowKey, id, caseId, plannedHours, actualHours) {
    return `
      <div class="sb-allocation-row" data-row-key="${rowKey}" data-id="${id ?? ''}">
        <select class="sb-alloc-project" data-row-key="${rowKey}">
          <option value="">案件を選択してください</option>
          ${this.getProjectOptionsHtml(caseId)}
        </select>
        <input type="number" class="sb-alloc-planned" data-row-key="${rowKey}" step="0.5" min="0"
          placeholder="予定(h)" value="${plannedHours ?? ''}" oninput="scheduleBoard.updateOverrideSummary()">
        <input type="number" class="sb-alloc-actual" data-row-key="${rowKey}" step="0.5" min="0"
          placeholder="実績(h)" value="${actualHours ?? ''}">
        <button type="button" class="btn-small btn-danger" onclick="scheduleBoard.removeAllocationRow('${rowKey}')">🗑️</button>
      </div>
    `;
  },

  renderAllocationRows() {
    const container = document.getElementById('sb-allocation-rows');
    const rows = this.overrideModalContext.allocationRows;

    if (rows.length === 0) {
      container.innerHTML = '<p class="sb-empty-notice">案件の割り当てはまだありません</p>';
      return;
    }

    container.innerHTML = rows.map(row =>
      this.allocationRowHtml(row.rowKey, row.id, row.case_id, row.planned_hours, row.actual_hours)
    ).join('');
  },

  addAllocationRow() {
    if (!this.overrideModalContext) return;
    const rowKey = `new-${this.overrideModalContext.newRowCounter++}`;
    const container = document.getElementById('sb-allocation-rows');

    const emptyNotice = container.querySelector('.sb-empty-notice');
    if (emptyNotice) emptyNotice.remove();

    container.insertAdjacentHTML('beforeend', this.allocationRowHtml(rowKey, null, '', '', ''));
    this.updateOverrideSummary();
  },

  removeAllocationRow(rowKey) {
    const container = document.getElementById('sb-allocation-rows');
    const rowEl = container.querySelector(`[data-row-key="${rowKey}"]`);
    if (rowEl) rowEl.remove();

    if (container.children.length === 0) {
      container.innerHTML = '<p class="sb-empty-notice">案件の割り当てはまだありません</p>';
    }
    this.updateOverrideSummary();
  },

  // ===== 準備項目タスクの割り当て（モーダル内） =====
  renderPrepItemRows() {
    const container = document.getElementById('sb-prep-item-rows');
    const rows = this.overrideModalContext.prepItemRows;

    if (rows.length === 0) {
      container.innerHTML = '<p class="sb-empty-notice">準備項目タスクの割り当てはまだありません</p>';
      return;
    }

    container.innerHTML = rows.map(row => `
      <div class="sb-allocation-row sb-prep-item-row" data-prep-id="${row.id}">
        <span class="sb-prep-item-label">【準備】${this.escapeHtml(row.label)}${row.status === '完了' ? '（完了）' : ''}</span>
        <input type="number" class="sb-prep-hours" data-prep-id="${row.id}" step="0.25" min="0"
          placeholder="工数(h)" value="${row.estimated_hours ?? ''}" oninput="scheduleBoard.updateOverrideSummary()">
        <button type="button" class="btn-small btn-danger" onclick="scheduleBoard.removePrepItemRow(${row.id})">🗑️ 解除</button>
      </div>
    `).join('');
  },

  renderPrepItemAddOptions() {
    const select = document.getElementById('sb-add-prep-item-select');
    if (!select) return;
    if (this.unassignedPreparationItems.length === 0) {
      select.innerHTML = '<option value="">未割当の準備項目タスクはありません</option>';
      return;
    }
    select.innerHTML = '<option value="">準備項目タスクを選択...</option>' +
      this.unassignedPreparationItems.map(i => `
        <option value="${i.id}">${this.escapeHtml(i.project_name)} / ${this.escapeHtml(i.preparation_item_name)}</option>
      `).join('');
  },

  addPrepItemRow() {
    if (!this.overrideModalContext) return;
    const select = document.getElementById('sb-add-prep-item-select');
    const hoursInput = document.getElementById('sb-add-prep-item-hours');
    const itemId = parseInt(select.value, 10);
    if (!itemId) {
      alert('準備項目タスクを選択してください');
      return;
    }
    const hours = parseFloat(hoursInput.value);
    if (hoursInput.value.trim() === '' || Number.isNaN(hours) || hours <= 0) {
      alert('準備項目タスクの工数には0より大きい数値を入力してください');
      return;
    }

    const item = this.unassignedPreparationItems.find(i => i.id === itemId);
    if (!item) return;

    this.overrideModalContext.prepItemRows.push({
      id: item.id,
      label: `${item.project_name} / ${item.preparation_item_name}`,
      estimated_hours: hours,
      status: item.status
    });
    // 選択済みの項目は候補から外し、同一項目の二重追加を防ぐ
    this.unassignedPreparationItems = this.unassignedPreparationItems.filter(i => i.id !== itemId);

    this.renderPrepItemAddOptions();
    this.renderPrepItemRows();
    this.updateOverrideSummary();
    hoursInput.value = '';
  },

  removePrepItemRow(prepId) {
    if (!this.overrideModalContext) return;
    const rows = this.overrideModalContext.prepItemRows;
    const idx = rows.findIndex(r => r.id === prepId);
    if (idx !== -1) rows.splice(idx, 1);
    this.overrideModalContext.removedPrepItemIds.push(prepId);

    this.renderPrepItemRows();
    this.updateOverrideSummary();
  },

  // 「この日は休み」チェック・時刻・休憩の現在の入力値から稼働時間を算出（未保存の編集内容にも追従）
  computeCurrentReferenceHours() {
    const isDayOff = document.getElementById('ov-is-day-off').checked;
    if (isDayOff) return 0;
    const start = document.getElementById('ov-start-time').value;
    const end = document.getElementById('ov-end-time').value;
    const breakMinutes = parseInt(document.getElementById('ov-break-minutes').value, 10) || 0;
    if (!start || !end) return 0;
    return Math.max(this.timeToHours(end) - this.timeToHours(start) - breakMinutes / 60, 0);
  },

  updateOverrideSummary() {
    const referenceHours = this.roundHours(this.computeCurrentReferenceHours());
    let plannedTotal = 0;
    document.querySelectorAll('#sb-allocation-rows .sb-alloc-planned').forEach(input => {
      const v = parseFloat(input.value);
      if (!Number.isNaN(v)) plannedTotal += v;
    });
    document.querySelectorAll('#sb-prep-item-rows .sb-prep-hours').forEach(input => {
      const v = parseFloat(input.value);
      if (!Number.isNaN(v)) plannedTotal += v;
    });
    plannedTotal = this.roundHours(plannedTotal);
    const remaining = this.roundHours(referenceHours - plannedTotal);

    document.getElementById('sb-override-summary').textContent =
      `稼働時間${referenceHours}時間のうち割り当て合計${plannedTotal}時間、残り${remaining}時間`;
  },

  async submitOverrideForm(e) {
    e.preventDefault();
    if (!this.overrideModalContext) return;
    const { employeeId, dateISO, overrideId, allocationRows, removedPrepItemIds } = this.overrideModalContext;

    // ---- 案件の割り当て行をDOMから読み取り、保存前に検証 ----
    const rowEls = [...document.querySelectorAll('#sb-allocation-rows .sb-allocation-row')];
    const currentRows = rowEls.map(rowEl => ({
      id: rowEl.dataset.id ? parseInt(rowEl.dataset.id, 10) : null,
      caseId: rowEl.querySelector('.sb-alloc-project').value,
      plannedRaw: rowEl.querySelector('.sb-alloc-planned').value,
      actualRaw: rowEl.querySelector('.sb-alloc-actual').value
    }));

    for (const row of currentRows) {
      if (!row.caseId) {
        alert('案件の割り当てで、案件が未選択の行があります');
        return;
      }
      const planned = parseFloat(row.plannedRaw);
      if (row.plannedRaw === '' || Number.isNaN(planned) || planned <= 0) {
        alert('案件の割り当てで、予定時間には0より大きい数値を入力してください');
        return;
      }
    }

    // ---- 準備項目タスクの割り当て行をDOMから読み取り、保存前に検証 ----
    const prepRowEls = [...document.querySelectorAll('#sb-prep-item-rows .sb-prep-item-row')];
    const currentPrepRows = prepRowEls.map(rowEl => ({
      id: parseInt(rowEl.dataset.prepId, 10),
      hoursRaw: rowEl.querySelector('.sb-prep-hours').value
    }));

    for (const row of currentPrepRows) {
      const hours = parseFloat(row.hoursRaw);
      if (row.hoursRaw.trim() === '' || Number.isNaN(hours) || hours <= 0) {
        alert('準備項目タスクの工数には0より大きい数値を入力してください');
        return;
      }
    }

    // ---- 勤務時間 ----
    const isDayOff = document.getElementById('ov-is-day-off').checked;
    const startTime = isDayOff ? null : (document.getElementById('ov-start-time').value || null);
    const endTime = isDayOff ? null : (document.getElementById('ov-end-time').value || null);
    const breakMinutes = isDayOff ? 0 : (parseInt(document.getElementById('ov-break-minutes').value, 10) || 0);

    const overrideData = {
      employee_id: employeeId,
      work_date: dateISO,
      start_time: startTime,
      end_time: endTime,
      break_minutes: breakMinutes,
      is_day_off: isDayOff
    };

    try {
      // 勤務時間の保存
      if (overrideId) {
        await fetch(`/api/schedule-overrides/${overrideId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(overrideData)
        });
      } else {
        await fetch('/api/schedule-overrides', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(overrideData)
        });
      }

      // モーダルを開いた時点にあった行のうち、現在のDOMから消えているものを削除
      const currentIds = currentRows.map(r => r.id).filter(Boolean);
      const deletedIds = allocationRows.map(r => r.id).filter(id => id && !currentIds.includes(id));
      for (const id of deletedIds) {
        await fetch(`/api/time-allocations/${id}`, { method: 'DELETE' });
      }

      // 既存行の更新・新規行の作成（実績時間が入力された行はステータスを「実績確定」にする）
      for (const row of currentRows) {
        const planned = parseFloat(row.plannedRaw);
        const actual = row.actualRaw.trim() === '' ? null : parseFloat(row.actualRaw);
        const body = {
          employee_id: employeeId,
          work_date: dateISO,
          case_id: parseInt(row.caseId, 10),
          planned_hours: planned,
          actual_hours: actual
        };
        if (actual != null) body.status = '実績確定';

        if (row.id) {
          await fetch(`/api/time-allocations/${row.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
        } else {
          await fetch(`/api/projects/${row.caseId}/time-allocations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
        }
      }

      // 準備項目タスクの割り当て更新(担当者・予定日・工数)
      for (const row of currentPrepRows) {
        const hours = parseFloat(row.hoursRaw);
        await fetch(`/api/preparation-items/${row.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assigned_staff_id: employeeId, scheduled_date: dateISO, estimated_hours: hours })
        });
      }

      // モーダル内で「解除」した準備項目タスクは担当者・予定日・工数をクリアして未割当に戻す
      for (const id of removedPrepItemIds) {
        await fetch(`/api/preparation-items/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assigned_staff_id: null, scheduled_date: null, estimated_hours: null })
        });
      }

      await this.loadScheduleOverrides();
      await this.loadWeekAllocations();
      await this.loadWeekPreparationItems();
      await this.loadProjectProgress();
      // 案件ごとの割り当て済み時間(allocated_hours_total)を最新化し、次回モーダルを開いた時の
      // 案件割り当てプルダウンの絞り込みに反映させる
      await this.loadProjects();
      this.renderBoard();
      this.renderLegend();
      this.renderProgress();
      this.closeOverrideModal();
      console.log(`✓ 勤務時間・案件割り当てを保存 (employee #${employeeId}, ${dateISO})`);
    } catch (error) {
      console.error('勤務時間・案件割り当ての保存エラー:', error);
      alert('保存に失敗しました');
    }
  },

  async deleteOverride() {
    if (!this.overrideModalContext || !this.overrideModalContext.overrideId) {
      this.closeOverrideModal();
      return;
    }
    if (!confirm('この日の勤務時間の記録を削除してもよろしいですか？（削除すると「休み」表示になります）')) return;

    try {
      await fetch(`/api/schedule-overrides/${this.overrideModalContext.overrideId}`, { method: 'DELETE' });
      await this.loadScheduleOverrides();
      this.renderBoard();
      this.closeOverrideModal();
      console.log('✓ 勤務時間の記録を削除しました');
    } catch (error) {
      console.error('勤務時間の記録削除エラー:', error);
      alert('削除に失敗しました');
    }
  }
};

// ===== イベントリスナー =====
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('sb-override-form')?.addEventListener('submit', (e) => scheduleBoard.submitOverrideForm(e));
  document.getElementById('ov-is-day-off')?.addEventListener('change', (e) => {
    scheduleBoard.toggleOverrideTimeInputs(e.target.checked);
    scheduleBoard.updateOverrideSummary();
  });
  ['ov-start-time', 'ov-end-time', 'ov-break-minutes'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => scheduleBoard.updateOverrideSummary());
  });

  window.addEventListener('click', (e) => {
    if (e.target.id === 'sb-detail-modal') {
      scheduleBoard.closeDetailModal();
    }
    if (e.target.id === 'sb-override-modal') {
      scheduleBoard.closeOverrideModal();
    }
  });

  scheduleBoard.init();
});
