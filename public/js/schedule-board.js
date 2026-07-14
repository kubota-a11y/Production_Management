// ========================================
// 週間作業スケジュールボード ロジック
// ========================================

const scheduleBoard = {
  // ===== ステート =====
  employees: [],
  projects: [],
  scheduleOverrides: [],
  defaultSchedules: [],
  allocations: [],
  preparationItems: [],
  unassignedPreparationItems: [],
  projectProgress: [],
  proposals: [],
  highlightedCaseId: null,
  proposalFilters: { employeeId: '', minScore: '' },
  // ドラッグ中の対象。提案カード({type:'proposal', caseId})か、
  // ボード上の確定済みブロック({type:'allocation', allocationId, caseId})のいずれか
  dragPayload: null,
  // タッチドラッグ(iPad等)中に指に追従させる複製要素
  touchDragGhost: null,
  // スマホ幅でのタブ状態('schedule' | 'proposals')。デスクトップでは未使用
  mobileTab: 'schedule',
  // スマホ用ボードで表示中の従業員
  mobileEmployeeId: null,
  currentWeekStart: null,
  detailModalContext: null,
  overrideModalContext: null,
  // タブレット幅の判定条件。CSS側(main.css/schedule-board.css)の
  // @media (min-width: 768px) and (max-width: 1180px) と必ず同じ値にすること
  TABLET_MEDIA_QUERY: '(min-width: 768px) and (max-width: 1180px)',

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
    await this.loadDefaultSchedules();
    await this.loadWeekAllocations();
    await this.loadWeekPreparationItems();
    await this.loadProjectProgress();
    await this.loadProposals();
    this.render();
    // タブレット幅では、提案確認パネルがボードの表示スペースを圧迫しないよう
    // 初期状態で折りたたんでおく(必要な時だけ開閉ボタンで開く)
    if (this.isTabletWidth()) {
      document.querySelector('.sb-proposals-sidebar')?.classList.add('is-tablet-collapsed');
      const btn = document.getElementById('sb-tablet-collapse-btn');
      if (btn) btn.textContent = '▶';
    }
    window.addEventListener('resize', () => this.resetTabletProposalsOnResize());
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

  // 曜日ごとの標準勤務パターン(schedule_overridesが無い日のフォールバックに使う)。
  // バックエンド(autoProposeForProject等)は個別override→無ければdefault_scheduleの順で
  // 空き時間を判定しているが、以前はこのボードがoverrideしか見ておらず、defaultのみで
  // 勤務している従業員の割り当てが常に「休み」扱いで表示されない不具合があった
  async loadDefaultSchedules() {
    try {
      const results = await Promise.all(
        this.employees.map(async e => {
          const schedules = await (await fetch(`/api/employees/${e.id}/default-schedule`)).json();
          return schedules.map(s => ({ ...s, employee_id: e.id }));
        })
      );
      this.defaultSchedules = results.flat();
    } catch (error) {
      console.error('標準勤務パターン取得エラー:', error);
      this.defaultSchedules = [];
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

  async loadProposals() {
    try {
      this.proposals = await (await fetch('/api/proposals')).json();
    } catch (error) {
      console.error('提案一覧取得エラー:', error);
      alert('提案確認パネルの取得に失敗しました');
      this.proposals = [];
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

  // ===== 自動スケジュール(日次/週次) =====
  // 未割り当て・未提案の案件について、指定期間内で候補者を選定し'提案'状態で登録する。
  // ボタンをローディング状態にし、完了後は結果を反映して再描画する
  async runAutoProposeRange(startDate, endDate, buttonEl, loadingText) {
    const originalHtml = buttonEl.innerHTML;
    buttonEl.disabled = true;
    buttonEl.innerHTML = loadingText;
    try {
      const res = await fetch('/api/schedule-board/auto-propose-range', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || '自動割り当てに失敗しました');
        return;
      }

      await this.loadProposals();
      await this.loadWeekAllocations();
      await this.loadProjectProgress();
      await this.loadProjects();
      this.renderBoard();
      this.renderMobileBoard();
      this.renderProgress();
      this.renderProposals();

      let message = `${data.proposed_count}件の提案を追加しました`;
      if (data.skipped_expired_count > 0) {
        message += `（納期超過等のため${data.skipped_expired_count}件は対象外）`;
      }
      alert(message);
    } catch (error) {
      console.error('自動割り当てエラー:', error);
      alert('自動割り当てに失敗しました');
    } finally {
      buttonEl.disabled = false;
      buttonEl.innerHTML = originalHtml;
    }
  },

  // デスクトップの表とスマホの日別カードの両方に同じ日付のボタンが存在しうるため、
  // idではなくクリックされたボタン要素自体を受け取ってローディング状態を出し分ける
  async autoProposeDay(dateISO, btn) {
    if (!btn) return;
    await this.runAutoProposeRange(dateISO, dateISO, btn, '…');
  },

  async autoProposeWeek() {
    const btn = document.getElementById('sb-auto-propose-week-btn');
    if (!btn) return;
    const dates = this.getWeekDates();
    const startISO = this.toISODate(dates[0]);
    const endISO = this.toISODate(dates[dates.length - 1]);
    await this.runAutoProposeRange(startISO, endISO, btn, '🤖 実行中…');
  },

  // ===== ヘルパー =====
  getOverrideFor(employeeId, dateISO) {
    return this.scheduleOverrides.find(o => o.employee_id === employeeId && o.work_date === dateISO);
  },

  roundHours(hours) {
    return Math.round(hours * 100) / 100;
  },

  // その日の基準勤務時間（横棒グラフの100%幅・計画不足判定の基準）を決定する。
  // schedule_overrides にその日のレコードがあればそれを優先し、無ければ
  // employee_default_schedule(曜日ごとの標準勤務パターン)にフォールバックする。
  // 以前はoverrideしか見ておらず、標準勤務パターンのみで勤務している従業員が
  // 常に「休み」表示になり、割り当てた作業がボードに反映されない不具合があった
  getReferenceInfo(employeeId, dateISO) {
    const override = this.getOverrideFor(employeeId, dateISO);

    if (override) {
      if (override.is_day_off) return { hours: 0, override };
      const hours = (override.start_time && override.end_time)
        ? Math.max(this.timeToHours(override.end_time) - this.timeToHours(override.start_time) - (override.break_minutes || 0) / 60, 0)
        : 0;
      return { hours, override };
    }

    // タイムゾーンのずれを避けるため、日付文字列からローカル日付を直接組み立てる
    const [y, m, d] = dateISO.split('-').map(Number);
    const weekday = new Date(y, m - 1, d).getDay();
    const def = this.defaultSchedules.find(s => s.employee_id === employeeId && s.weekday === weekday);
    if (!def || !def.is_working) {
      return { hours: 0, override: null };
    }
    const hours = (def.start_time && def.end_time)
      ? Math.max(this.timeToHours(def.end_time) - this.timeToHours(def.start_time) - (def.break_minutes || 0) / 60, 0)
      : 0;
    return { hours, override: null };
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
    this.renderMobileBoard();
    this.renderLegend();
    this.renderProgress();
    this.renderProposals();
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

    head.innerHTML = '<th>従業員</th>' + dates.map(d => {
      const dateISO = this.toISODate(d);
      return `
      <th>${getDayOfWeekLabel(this.jsDayToOurDay(d.getDay()))}
        <span class="sb-day-header-date">${d.getMonth() + 1}/${d.getDate()}</span>
        <button type="button" class="sb-auto-propose-day-btn"
                onclick="scheduleBoard.autoProposeDay('${dateISO}', this)" title="この日を自動割り当て">🤖 自動割当</button>
      </th>
    `;
    }).join('');

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
    // 【2】提案カードのドラッグ&ドロップ先として、全セルでドラッグオーバー/ドロップを受け付ける
    const dropHandlers = `ondragover="scheduleBoard.onCellDragOver(event)" ` +
      `ondragleave="scheduleBoard.onCellDragLeave(event)" ` +
      `ondrop="scheduleBoard.onCellDrop(event, ${employee.id}, '${dateISO}')"`;
    const content = this.renderCellContent(employee, dateISO, referenceHours);
    // data-*属性はタッチドラッグ(iPad等)でドロップ先セルを特定するために使う
    return `<td class="sb-cell" data-employee-id="${employee.id}" data-date-iso="${dateISO}" onclick="${cellOnclick}" ${dropHandlers}>${content}</td>`;
  },

  // デスクトップの<td>とスマホの縦積み日別カードの両方から使う、セル内側(空き時間バー等)の
  // HTML組み立て。ドラッグ&ドロップのハンドラは各呼び出し元(セル/カード)側で付与する
  renderCellContent(employee, dateISO, referenceHours) {
    if (referenceHours <= 0) {
      return `<div class="sb-cell-off">休み</div>`;
    }

    const dayAllocations = this.getAllocationsFor(employee.id, dateISO);
    const dayPrepItems = this.getPrepItemsFor(employee.id, dateISO);
    // 自動割当ボタン(日次/週次)専用の前準備・後片付け(setup_minutes/cleanup_minutes)も
    // その日の消費時間としてカウントする。通常の割り当て(setup/cleanup=0)には影響しない
    const overheadHoursOf = (a) => ((a.setup_minutes || 0) + (a.cleanup_minutes || 0)) / 60;
    const allocationHours = dayAllocations.reduce((sum, a) => sum + a.planned_hours + overheadHoursOf(a), 0);
    const prepHours = dayPrepItems.reduce((sum, i) => sum + (i.estimated_hours || 0), 0);
    const plannedTotal = allocationHours + prepHours;
    const scaleMax = Math.max(referenceHours, plannedTotal, 0.1);
    const referencePct = Math.min((referenceHours / scaleMax) * 100, 100);
    const isShort = plannedTotal < referenceHours;

    // 提案中(未確定)・確定済みのどちらのブロックもドラッグしてボード上の別セルへ
    // 移動できるようにする。ドラッグ元によって、ドロップ時の処理(確定 or 単純な移動)が変わる。
    // 前準備・後片付けがある行は、既存の【準備】ブロックとは別物と分かるよう、
    // 作業ブロックの前後に薄いグレーの小ブロックとして表示する
    const segments = dayAllocations.map(a => {
      const widthPct = (a.planned_hours / scaleMax) * 100;
      const color = this.getProjectColor(a.case_id);
      const isProposed = a.status === '提案';
      const setupMin = a.setup_minutes || 0;
      const cleanupMin = a.cleanup_minutes || 0;
      const overheadNote = (setupMin > 0 || cleanupMin > 0) ? `（準備${setupMin}分+片付け${cleanupMin}分込み）` : '';
      const title = `${a.project_name}: 実作業${a.planned_hours}h${overheadNote}${a.actual_hours != null ? ` / 実績${a.actual_hours}h` : ''}${isProposed ? '（提案中・未確定・ドラッグで確定/移動可）' : '（ドラッグで移動可）'}`;
      const proposedCls = isProposed ? ' sb-bar-segment-proposed' : '';
      const highlightCls = isProposed && this.highlightedCaseId === a.case_id ? ' is-highlighted' : '';
      const proposedClick = isProposed
        ? ` onclick="event.stopPropagation(); scheduleBoard.highlightFromBoard(${a.case_id})"`
        : '';
      const dragStart = isProposed
        ? `scheduleBoard.onProposalDragStart(event, ${a.case_id})`
        : `scheduleBoard.onAllocationDragStart(event, ${a.id})`;
      // タッチドラッグ(iPad等)用。ネイティブHTML5 D&Dが効かないタッチ端末向けのフォールバック
      const touchPayload = isProposed
        ? `{type:'proposal', caseId:${a.case_id}}`
        : `{type:'allocation', allocationId:${a.id}}`;
      const workHtml = `<div class="sb-bar-segment${proposedCls}${highlightCls}" data-case-id="${a.case_id}" data-allocation-id="${a.id}" draggable="true" ondragstart="event.stopPropagation(); ${dragStart}" ondragend="scheduleBoard.onDragEnd()" ontouchstart="event.stopPropagation(); scheduleBoard.onDragTouchStart(event, ${touchPayload})" ontouchmove="scheduleBoard.onDragTouchMove(event)" ontouchend="scheduleBoard.onDragTouchEnd(event)" style="width:${widthPct}%; background:${color};" title="${this.escapeHtml(title)}"${proposedClick}>${this.escapeHtml(a.project_name)}</div>`;

      const setupHtml = setupMin > 0
        ? `<div class="sb-bar-segment sb-bar-segment-overhead" style="width:${(setupMin / 60 / scaleMax) * 100}%;" title="${this.escapeHtml(a.project_name)}: 前準備 ${setupMin}分">準備</div>`
        : '';
      const cleanupHtml = cleanupMin > 0
        ? `<div class="sb-bar-segment sb-bar-segment-overhead" style="width:${(cleanupMin / 60 / scaleMax) * 100}%;" title="${this.escapeHtml(a.project_name)}: 後片付け ${cleanupMin}分">片付</div>`
        : '';
      return setupHtml + workHtml + cleanupHtml;
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
      ${isShort ? `<div class="sb-cell-warning" title="計画時間(${this.roundHours(plannedTotal)}h)が勤務時間(${this.roundHours(referenceHours)}h)に不足しています">⚠️ 計画不足</div>` : ''}
      <div class="sb-cell-hours-label">${this.roundHours(plannedTotal)}h / ${this.roundHours(referenceHours)}h</div>
      <div class="sb-bar-track" onclick="event.stopPropagation(); scheduleBoard.openDetailModal(${employee.id}, '${dateISO}')">
        ${segments}
        ${prepSegments}
        <div class="sb-bar-reference-marker" style="left:${referencePct}%;"></div>
      </div>
    `;
  },

  // ===== スマホ用ボード(従業員を1人選び、その週を日ごとに縦積み表示) =====
  renderMobileBoard() {
    const select = document.getElementById('sb-mobile-employee-select');
    const container = document.getElementById('sb-mobile-days');

    if (this.employees.length === 0) {
      select.innerHTML = '';
      container.innerHTML = `<p class="sb-empty-notice">有効な従業員が登録されていません</p>`;
      return;
    }

    if (!this.mobileEmployeeId || !this.employees.some(e => e.id === this.mobileEmployeeId)) {
      this.mobileEmployeeId = this.employees[0].id;
    }
    select.innerHTML = this.employees.map(e =>
      `<option value="${e.id}" ${e.id === this.mobileEmployeeId ? 'selected' : ''}>${this.escapeHtml(e.name)}</option>`
    ).join('');

    const employee = this.employees.find(e => e.id === this.mobileEmployeeId);
    const dates = this.getWeekDates();
    container.innerHTML = dates.map(date => this.renderMobileDayCell(employee, date)).join('');
  },

  onMobileEmployeeChange() {
    this.mobileEmployeeId = Number(document.getElementById('sb-mobile-employee-select').value);
    this.renderMobileBoard();
  },

  renderMobileDayCell(employee, date) {
    const dateISO = this.toISODate(date);
    const refInfo = this.getReferenceInfo(employee.id, dateISO);
    const dayLabel = getDayOfWeekLabel(this.jsDayToOurDay(date.getDay()));
    const content = this.renderCellContent(employee, dateISO, refInfo.hours);
    return `
      <div class="sb-mobile-day-cell" data-employee-id="${employee.id}" data-date-iso="${dateISO}" onclick="scheduleBoard.openOverrideModal(${employee.id}, '${dateISO}')">
        <div class="sb-mobile-day-header">
          ${dayLabel} <span class="sb-day-header-date">${date.getMonth() + 1}/${date.getDate()}</span>
          <button type="button" class="sb-auto-propose-day-btn"
                  onclick="event.stopPropagation(); scheduleBoard.autoProposeDay('${dateISO}', this)" title="この日を自動割り当て">🤖 自動割当</button>
        </div>
        ${content}
      </div>
    `;
  },

  // ===== スマホ用タブ切り替え(スケジュール ⇔ 提案確認) =====
  switchMobileTab(tab) {
    this.mobileTab = tab;
    document.getElementById('sb-mobile-tab-schedule').classList.toggle('active', tab === 'schedule');
    document.getElementById('sb-mobile-tab-proposals').classList.toggle('active', tab === 'proposals');
    document.querySelector('.sb-main-column').classList.toggle('is-mobile-hidden', tab !== 'schedule');
    document.querySelector('.sb-proposals-sidebar').classList.toggle('is-mobile-hidden', tab !== 'proposals');
  },

  // ===== タブレット用: 提案確認パネルの開閉(768〜1180px) =====
  toggleTabletProposals() {
    const sidebar = document.querySelector('.sb-proposals-sidebar');
    const collapsed = sidebar.classList.toggle('is-tablet-collapsed');
    // 一部環境でposition:sticky+flexの組み合わせだと、CSSクラス切り替えだけでは
    // 幅の再計算が反映されないことがあったため、インラインスタイルでも明示し、
    // displayの一時トグルで強制的にレイアウトを再計算させる
    sidebar.style.flexBasis = collapsed ? '44px' : '';
    sidebar.style.width = collapsed ? '44px' : '';
    const originalDisplay = sidebar.style.display;
    sidebar.style.display = 'none';
    void sidebar.offsetHeight;
    sidebar.style.display = originalDisplay;
    const btn = document.getElementById('sb-tablet-collapse-btn');
    if (btn) btn.textContent = collapsed ? '▶' : '◀';
  },

  isTabletWidth() {
    return window.matchMedia(this.TABLET_MEDIA_QUERY).matches;
  },

  // タブレット幅から抜けた場合(ウィンドウのリサイズ・iPadの回転等)、
  // 折りたたみ状態のインラインスタイルが残ってPC/スマホ表示に影響しないようにする
  resetTabletProposalsOnResize() {
    const sidebar = document.querySelector('.sb-proposals-sidebar');
    if (!sidebar) return;
    const isTablet = this.isTabletWidth();
    if (!isTablet && sidebar.classList.contains('is-tablet-collapsed')) {
      sidebar.classList.remove('is-tablet-collapsed');
      sidebar.style.flexBasis = '';
      sidebar.style.width = '';
      const originalDisplay = sidebar.style.display;
      sidebar.style.display = 'none';
      void sidebar.offsetHeight;
      sidebar.style.display = originalDisplay;
      const btn = document.getElementById('sb-tablet-collapse-btn');
      if (btn) btn.textContent = '◀';
    }
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
      // required_hours(数量÷担当者の生産性)が計算できた案件はそれを基準に表示し、
      // 担当者未割り当て・生産性未登録でフォールバックした案件だけ「見積もり参考値」と明示する
      const sourceNote = p.required_hours_source === 'planned_hours' ? '（見積もり参考値）' : '';
      return `
        <div class="sb-progress-item">
          <div class="sb-progress-name" title="${this.escapeHtml(p.project_name)}">${this.escapeHtml(p.project_name)}</div>
          <div class="sb-progress-bar-track">
            <div class="sb-progress-bar-fill ${isOver ? 'is-over' : ''}" style="width:${barWidth}%;"></div>
          </div>
          <div class="sb-progress-numbers">${p.actual_hours_total}h / ${p.planned_hours_total.toFixed(1)}h${sourceNote}（${pct.toFixed(0)}%）</div>
        </div>
      `;
    }).join('');
  },

  // ===== 提案確認パネル(右サイドバー・カード形式) =====
  onProposalsFilterChange() {
    this.proposalFilters.employeeId = document.getElementById('sb-proposals-filter-employee').value;
    this.proposalFilters.minScore = document.getElementById('sb-proposals-filter-score').value;
    this.renderProposals();
  },

  // フィルタを適用し、納期の近い順に並べた表示用リストを都度計算する(元データthis.proposalsは変更しない)
  getVisibleProposals() {
    let list = this.proposals.slice();

    if (this.proposalFilters.employeeId) {
      list = list.filter(p => String(p.employee_id) === this.proposalFilters.employeeId);
    }
    if (this.proposalFilters.minScore) {
      const min = Number(this.proposalFilters.minScore) / 100;
      list = list.filter(p => (p.score ?? 0) >= min);
    }

    list.sort((a, b) => (a.deadline || '').localeCompare(b.deadline || ''));
    return list;
  },

  renderProposals() {
    const badge = document.getElementById('sb-proposals-badge');
    badge.textContent = `（${this.proposals.length}件）`;
    const mobileBadge = document.getElementById('sb-mobile-proposals-badge');
    if (mobileBadge) mobileBadge.textContent = this.proposals.length > 0 ? `（${this.proposals.length}）` : '';

    // 担当者フィルタのプルダウンは、現在の提案一覧に登場する担当者だけを選択肢にする
    const employeeSelect = document.getElementById('sb-proposals-filter-employee');
    const uniqueEmployees = Array.from(
      new Map(this.proposals.map(p => [p.employee_id, p.employee_name])).entries()
    );
    const prevEmployeeValue = employeeSelect.value;
    employeeSelect.innerHTML = '<option value="">すべて</option>' +
      uniqueEmployees.map(([id, name]) => `<option value="${id}">${this.escapeHtml(name)}</option>`).join('');
    employeeSelect.value = uniqueEmployees.some(([id]) => String(id) === prevEmployeeValue) ? prevEmployeeValue : '';
    this.proposalFilters.employeeId = employeeSelect.value;

    const visible = this.getVisibleProposals();
    const cards = document.getElementById('sb-proposals-cards');

    if (visible.length === 0) {
      cards.innerHTML = `<p class="sb-empty-notice">${this.proposals.length === 0 ? '確認待ちの提案はありません' : '絞り込み条件に一致する提案はありません'}</p>`;
      return;
    }

    // スマホではドラッグ操作の代わりに、担当者・日付を選んで確定するボタン操作を使う
    // (却下はドラッグ不要のためデスクトップと共通のボタンのまま)。デフォルト日付は
    // 表示中の週の月曜日にしておき、必要なら日付入力で変更してもらう
    const defaultMobileDateISO = this.toISODate(this.getWeekDates()[0]);

    cards.innerHTML = visible.map(p => {
      const scoreLabel = p.score != null ? `${(p.score * 100).toFixed(0)}%` : '-';
      const availableLabel = p.available_hours != null ? `${p.available_hours}h` : '-';
      const highlightCls = this.highlightedCaseId === p.case_id ? ' is-highlighted' : '';
      const employeeOptions = this.employees.map(e =>
        `<option value="${e.id}" ${e.id === p.employee_id ? 'selected' : ''}>${this.escapeHtml(e.name)}</option>`
      ).join('');
      return `
        <div class="sb-proposal-card${highlightCls}" data-case-id="${p.case_id}" draggable="true"
             ondragstart="scheduleBoard.onProposalDragStart(event, ${p.case_id})"
             ondragend="scheduleBoard.onDragEnd()"
             ontouchstart="scheduleBoard.onDragTouchStart(event, {type:'proposal', caseId:${p.case_id}})"
             ontouchmove="scheduleBoard.onDragTouchMove(event)"
             ontouchend="scheduleBoard.onDragTouchEnd(event)"
             onmouseenter="scheduleBoard.highlightProposal(${p.case_id})"
             onmouseleave="scheduleBoard.clearHighlight()">
          <div class="sb-proposal-card-name">${this.escapeHtml(p.project_name)}</div>
          <div class="sb-proposal-card-customer">${this.escapeHtml(p.customer_name || '')}</div>
          <div class="sb-proposal-card-meta">納期 ${this.escapeHtml(p.deadline || '-')} ・ 数量 ${p.quantity ?? '-'} ・ ${this.escapeHtml(p.process_type || '-')}</div>
          <div class="sb-proposal-card-meta">担当 ${this.escapeHtml(p.employee_name)} ・ スコア ${scoreLabel} ・ 空き ${availableLabel}</div>
          <div class="sb-proposal-card-actions">
            <span class="sb-proposal-card-hint">🖱️ ドラッグしてボードへ</span>
            <button type="button" class="btn btn-danger btn-small" onclick="scheduleBoard.rejectProposal(${p.case_id})">却下</button>
          </div>
          <div class="sb-proposal-mobile-confirm">
            <select class="sb-proposal-mobile-employee">${employeeOptions}</select>
            <input type="date" class="sb-proposal-mobile-date" value="${defaultMobileDateISO}">
            <button type="button" class="btn btn-primary btn-small" onclick="scheduleBoard.confirmProposalFromMobile(${p.case_id}, this)">この内容で確定</button>
          </div>
        </div>
      `;
    }).join('');
  },

  confirmProposalFromMobile(caseId, buttonEl) {
    const card = buttonEl.closest('.sb-proposal-card');
    const employeeId = Number(card.querySelector('.sb-proposal-mobile-employee').value);
    const dateISO = card.querySelector('.sb-proposal-mobile-date').value;
    if (!employeeId || !dateISO) {
      alert('担当者と日付を選択してください');
      return;
    }
    this.confirmProposalAt(caseId, employeeId, dateISO);
  },

  // パネルカードのホバー、およびボード上の提案ブロックのクリックの両方から呼ばれる
  // 共通のハイライト処理。両側に同じcase_idを持つ要素を探してハイライトクラスを付け替える
  highlightProposal(caseId) {
    this.highlightedCaseId = caseId;
    this.applyHighlight();
  },

  highlightFromBoard(caseId) {
    this.highlightedCaseId = caseId;
    this.applyHighlight();
    const card = document.querySelector(`.sb-proposal-card[data-case-id="${caseId}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  clearHighlight() {
    this.highlightedCaseId = null;
    this.applyHighlight();
  },

  applyHighlight() {
    document.querySelectorAll('.sb-proposal-card[data-case-id]').forEach(el => {
      el.classList.toggle('is-highlighted', Number(el.dataset.caseId) === this.highlightedCaseId);
    });
    document.querySelectorAll('.sb-bar-segment-proposed').forEach(el => {
      el.classList.toggle('is-highlighted', Number(el.dataset.caseId) === this.highlightedCaseId);
    });
  },

  async rejectProposal(caseId) {
    if (!confirm('この提案を却下しますか？（提案分の割り当ては削除され、未割り当てに戻ります）')) return;
    try {
      const res = await fetch(`/api/projects/${caseId}/reject-proposal`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || '提案の却下に失敗しました');
        return;
      }
      await this.loadProposals();
      await this.loadWeekAllocations();
      await this.loadProjectProgress();
      await this.loadProjects();
      this.renderBoard();
      this.renderMobileBoard();
      this.renderProgress();
      this.renderProposals();
    } catch (error) {
      console.error('提案却下エラー:', error);
      alert('提案の却下に失敗しました');
    }
  },

  // ===== ドラッグ&ドロップ(提案カードの確定 / 確定済みブロックの移動) =====
  onProposalDragStart(event, caseId) {
    this.dragPayload = { type: 'proposal', caseId };
    event.dataTransfer.setData('text/plain', JSON.stringify(this.dragPayload));
    event.dataTransfer.effectAllowed = 'move';
  },

  // 確定済み(提案中以外)のブロックをドラッグして別セルへ移動する
  onAllocationDragStart(event, allocationId) {
    this.dragPayload = { type: 'allocation', allocationId };
    event.dataTransfer.setData('text/plain', JSON.stringify(this.dragPayload));
    event.dataTransfer.effectAllowed = 'move';
  },

  onDragEnd() {
    this.dragPayload = null;
    document.querySelectorAll('.sb-cell.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
  },

  onCellDragOver(event) {
    if (!this.dragPayload) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    event.currentTarget.classList.add('is-drop-target');
  },

  onCellDragLeave(event) {
    event.currentTarget.classList.remove('is-drop-target');
  },

  async onCellDrop(event, employeeId, dateISO) {
    event.preventDefault();
    event.currentTarget.classList.remove('is-drop-target');

    let payload = this.dragPayload;
    if (!payload) {
      try { payload = JSON.parse(event.dataTransfer.getData('text/plain')); } catch (error) { payload = null; }
    }
    this.dragPayload = null;
    if (!payload) return;

    if (payload.type === 'proposal') {
      await this.confirmProposalAt(payload.caseId, employeeId, dateISO);
    } else if (payload.type === 'allocation') {
      await this.moveAllocation(payload.allocationId, employeeId, dateISO);
    }
  },

  // ===== タッチドラッグ(iPad等) =====
  // iOS/iPadOS SafariはネイティブのHTML5 Drag and Drop APIをタッチ操作では
  // 発火しない(dragstartが起きない)ため、touchstart/touchmove/touchendで
  // 同等の操作(指の下に「ドロップ先セル」を探す)を独自に実装する。
  // 提案カードの確定・確定済みブロックの移動のどちらも、上のonCellDropと
  // 同じdragPayload/confirmProposalAt/moveAllocationをそのまま使う
  onDragTouchStart(event, payload) {
    // 提案カード内のボタン・セレクト・日付入力(スマホ用の確定操作/却下ボタン)への
    // タップまでドラッグ扱いにしてしまわないよう、それらの上で始まったタッチは無視する
    if (event.target.closest('button, select, input, option')) return;
    this.dragPayload = payload;
    const touch = event.touches[0];
    this.touchDragGhost = this.createDragGhost(event.currentTarget, touch);
    // ドラッグ中はページのスクロールと衝突しないよう抑制する
    event.preventDefault();
  },

  onDragTouchMove(event) {
    if (!this.dragPayload || !this.touchDragGhost) return;
    event.preventDefault();
    const touch = event.touches[0];
    this.touchDragGhost.style.left = `${touch.clientX + 14}px`;
    this.touchDragGhost.style.top = `${touch.clientY + 14}px`;

    document.querySelectorAll('.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
    const target = this.findDropTargetAt(touch.clientX, touch.clientY);
    if (target) target.classList.add('is-drop-target');
  },

  async onDragTouchEnd(event) {
    if (!this.dragPayload) return;
    const touch = event.changedTouches[0];
    const target = this.findDropTargetAt(touch.clientX, touch.clientY);
    this.removeDragGhost();
    document.querySelectorAll('.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));

    const payload = this.dragPayload;
    this.dragPayload = null;
    if (!target) return;

    const employeeId = Number(target.dataset.employeeId);
    const dateISO = target.dataset.dateIso;
    if (payload.type === 'proposal') {
      await this.confirmProposalAt(payload.caseId, employeeId, dateISO);
    } else if (payload.type === 'allocation') {
      await this.moveAllocation(payload.allocationId, employeeId, dateISO);
    }
  },

  findDropTargetAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('.sb-cell, .sb-mobile-day-cell') : null;
  },

  createDragGhost(sourceEl, touch) {
    const ghost = sourceEl.cloneNode(true);
    ghost.classList.add('sb-drag-ghost');
    ghost.style.position = 'fixed';
    ghost.style.left = `${touch.clientX + 14}px`;
    ghost.style.top = `${touch.clientY + 14}px`;
    ghost.style.pointerEvents = 'none';
    document.body.appendChild(ghost);
    return ghost;
  },

  removeDragGhost() {
    if (this.touchDragGhost) {
      this.touchDragGhost.remove();
      this.touchDragGhost = null;
    }
  },

  // ドロップ先の従業員・日付を優先して確定する(AIが提案していた担当者・開始日は上書きされる)
  async confirmProposalAt(caseId, employeeId, dateISO) {
    try {
      const res = await fetch(`/api/projects/${caseId}/confirm-proposal-at`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee_id: employeeId, work_date: dateISO }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || '確定に失敗しました');
        return;
      }
      await this.loadProposals();
      await this.loadWeekAllocations();
      await this.loadProjectProgress();
      await this.loadProjects();
      this.renderBoard();
      this.renderMobileBoard();
      this.renderProgress();
      this.renderProposals();
    } catch (error) {
      console.error('ドラッグ&ドロップ確定エラー:', error);
      alert('確定に失敗しました');
    }
  },

  // 確定済みブロックを別の従業員×日付へ移動する(配置ミスの修正用)。
  // 既存のPUT /api/time-allocations/:id がemployee_id・work_dateの更新に対応済みのため、
  // 新しいAPIは追加せずそのまま再利用する
  async moveAllocation(allocationId, employeeId, dateISO) {
    try {
      const res = await fetch(`/api/time-allocations/${allocationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee_id: employeeId, work_date: dateISO }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'ブロックの移動に失敗しました');
        return;
      }
      await this.loadWeekAllocations();
      await this.loadProjectProgress();
      this.renderBoard();
      this.renderMobileBoard();
      this.renderProgress();
    } catch (error) {
      console.error('ブロック移動エラー:', error);
      alert('ブロックの移動に失敗しました');
    }
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
      this.renderMobileBoard();
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
      this.renderMobileBoard();
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
    document.getElementById('ov-reserved-hours').value = override?.reserved_hours ?? 0;
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
    const reservedHours = parseFloat(document.getElementById('ov-reserved-hours').value) || 0;

    const overrideData = {
      employee_id: employeeId,
      work_date: dateISO,
      start_time: startTime,
      end_time: endTime,
      break_minutes: breakMinutes,
      is_day_off: isDayOff,
      reserved_hours: reservedHours
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
          // スケジュールボードの空きマスからの新規登録は、自動割当ボタンと同じ考え方で
          // 前準備10分・後片付け10分を自動付与する(サーバー側がフラグを見て付与する)
          await fetch(`/api/projects/${row.caseId}/time-allocations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, apply_default_overhead: true })
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
      await this.loadProposals();
      // 案件ごとの割り当て済み時間(allocated_hours_total)を最新化し、次回モーダルを開いた時の
      // 案件割り当てプルダウンの絞り込みに反映させる
      await this.loadProjects();
      this.renderBoard();
      this.renderMobileBoard();
      this.renderLegend();
      this.renderProgress();
      this.renderProposals();
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
      this.renderMobileBoard();
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

// ========================================================================
// 【一時デバッグ】iPadでタブレット向けレイアウトが適用されない不具合の切り分け用。
// 原因(画面幅がそもそも768-1180pxの範囲外なのか、matchMediaの判定は合っているのに
// CSSクラスの切り替えがうまくいっていないのか等)を特定したら、この一時デバッグ表示
// (この行から本ファイル末尾まで)は削除してよい。
// index.html/employees.htmlには読み込んでいないため、スケジュールボード画面
// (schedule-board.html)でのみ表示される
// ========================================================================
(function () {
  function renderDebugOverlay() {
    let el = document.getElementById('sb-debug-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sb-debug-overlay';
      // 調査対象のCSS(main.css/schedule-board.css)に依存すると、それ自体の
      // 不具合でこの表示まで隠れてしまいかねないため、あえて全てインラインstyleで
      // 指定し、外部CSSの影響を受けないようにする
      el.style.cssText = [
        'position: fixed',
        'top: 4px',
        'right: 4px',
        'z-index: 2147483647',
        'background: rgba(0, 0, 0, 0.85)',
        'color: #00ff66',
        'font-family: -apple-system, monospace',
        'font-size: 10px',
        'line-height: 1.5',
        'padding: 6px 9px',
        'border-radius: 6px',
        'max-width: 220px',
        'white-space: pre-wrap',
        'word-break: break-all',
        'pointer-events: none',
        'box-shadow: 0 2px 8px rgba(0,0,0,0.4)'
      ].join(';');
      document.body.appendChild(el);
    }

    const isTablet = window.matchMedia('(min-width: 768px) and (max-width: 1180px)').matches;
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    const isPortrait = window.matchMedia('(orientation: portrait)').matches;
    const desktopBoard = document.querySelector('.sb-desktop-board');
    const mobileBoard = document.querySelector('.sb-mobile-board');
    const sidebar = document.querySelector('.sb-proposals-sidebar');
    const layout = document.querySelector('.sb-layout');
    const collapseBtn = document.querySelector('.sb-tablet-collapse-btn');
    const cell = document.querySelector('.sb-cell');
    const barSegment = document.querySelector('.sb-bar-segment');

    const lines = [
      `[DEBUG] ${new Date().toLocaleTimeString('ja-JP')}`,
      `innerWidth: ${window.innerWidth}`,
      `innerHeight: ${window.innerHeight}`,
      `devicePixelRatio: ${window.devicePixelRatio}`,
      `orientation: ${isPortrait ? 'portrait' : 'landscape'}`,
      `matchMedia tablet(768-1180): ${isTablet}`,
      `matchMedia mobile(<=767): ${isMobile}`,
      `body.class: "${document.body.className || '(なし)'}"`,
      `.sb-layout flex-direction: ${layout ? getComputedStyle(layout).flexDirection : '(要素なし)'}`,
      `.sb-desktop-board display: ${desktopBoard ? getComputedStyle(desktopBoard).display : '(要素なし)'}`,
      `.sb-mobile-board display: ${mobileBoard ? getComputedStyle(mobileBoard).display : '(要素なし)'}`,
      `.sb-proposals-sidebar class: "${sidebar ? sidebar.className : '(要素なし)'}"`,
      `.sb-proposals-sidebar width: ${sidebar ? getComputedStyle(sidebar).width : '(要素なし)'}`,
      `.sb-tablet-collapse-btn display: ${collapseBtn ? getComputedStyle(collapseBtn).display : '(要素なし)'}`,
      `.sb-cell width(実測1つ目): ${cell ? Math.round(cell.getBoundingClientRect().width) + 'px' : '(要素なし)'}`,
      `.sb-bar-segment font-size(実測1つ目): ${barSegment ? getComputedStyle(barSegment).fontSize : '(要素なし・その日は割当なし)'}`
    ];
    el.textContent = lines.join('\n');
  }

  document.addEventListener('DOMContentLoaded', renderDebugOverlay);
  window.addEventListener('resize', renderDebugOverlay);
  window.addEventListener('orientationchange', () => setTimeout(renderDebugOverlay, 200));
  // DOMContentLoadedが既に発火済みの場合(このスクリプトはbody末尾で読み込まれるため
  // ほぼ発火前だが念のため)にも表示されるようにする
  if (document.readyState !== 'loading') {
    renderDebugOverlay();
  }

  // scheduleBoard.init()は従業員・案件・週の割り当てなどをfetchで非同期に
  // 読み込んでから描画するため、DOMContentLoaded直後の1回目の表示だけだと
  // .sb-cell/.sb-bar-segmentがまだ存在しない「読み込み中の一瞬」を
  // 捉えてしまうことがある。init完了後にも必ず再表示し、念のため
  // 少し時間を置いてからもう一度表示して読み込み後の実態を反映する
  const originalInit = scheduleBoard.init.bind(scheduleBoard);
  scheduleBoard.init = async function (...args) {
    const result = await originalInit(...args);
    renderDebugOverlay();
    setTimeout(renderDebugOverlay, 800);
    setTimeout(renderDebugOverlay, 2000);
    return result;
  };
})();
