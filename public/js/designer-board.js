// デザイナー向けマイスケジュールボード(/designer/{token})のフロント。
// トークンはURLパスから取得し、APIは /api/designer/{token}/... を呼ぶ。
// D&D: PCはHTML5ドラッグ&ドロップ、タッチ端末は「チップをタップで選択→日カードをタップで移動」方式。
const board = {
  token: '',
  weekStart: null,   // Date(その週の月曜)
  days: [],          // [{date, hours, is_day_off, source, mode}]
  scheduled: [],
  unscheduled: [],
  sheetTodos: null,  // 社員用TODOリスト(スプレッドシート)の本人分。null=連携なし
  designerName: '',
  selectedItemId: null,     // タップ移動用に選択中の準備項目ID
  selectedTodoText: null,   // タップ移動用に選択中のTODO(タスク本文で同一視)
  draggingItemId: null,
  draggingTodoText: null,
  availabilityDate: null,
  carryoverReasons: [],
  carryoverNoteMax: 200,    // 持ち越しメモの文字数上限(サーバーから受け取る)
  pendingMove: null,        // 持ち越し確認ダイアログで承認待ちの移動

  init() {
    const m = location.pathname.match(/^\/designer\/([^/]+)/);
    if (!m) return this.showError('URLが正しくありません');
    this.token = m[1];
    this.goThisWeek();
  },

  // ===== 週操作 =====
  mondayOf(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = d.getDay();
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    return d;
  },

  toISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  goThisWeek() {
    this.weekStart = this.mondayOf(new Date());
    this.load();
  },

  moveWeek(delta) {
    this.weekStart.setDate(this.weekStart.getDate() + delta * 7);
    this.load();
  },

  // ===== データ取得 =====
  async load() {
    try {
      const res = await fetch(`/api/designer/${this.token}/board?start=${this.toISO(this.weekStart)}`);
      const data = await res.json();
      if (!res.ok || !data.ok) return this.showError(data.error || '読み込みに失敗しました');

      this.days = data.days;
      this.scheduled = data.scheduled;
      this.unscheduled = data.unscheduled;
      this.sheetTodos = data.sheet_todos ?? null;
      this.roughFiles = data.rough_files || {};
      this.carveStages = data.carve_stages || [];
      this.proofStages = data.proof_stages || [];
      this.carryoverReasons = data.carryover_reasons || [];
      this.carryoverNoteMax = data.carryover_note_max || 200;
      this.designerName = data.designer_name;
      this.selectedItemId = null;
      this.selectedTodoText = null;
      this.render();
    } catch (e) {
      console.error(e);
      this.showError('通信エラーが発生しました。電波状況をご確認のうえ再読み込みしてください。');
    }
  },

  showError(msg) {
    const box = document.getElementById('error-box');
    box.textContent = msg;
    box.style.display = 'block';
    document.getElementById('designer-name').textContent = '—';
  },

  toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  },

  // ===== 描画 =====
  render() {
    document.getElementById('designer-name').textContent = `🎨 ${this.designerName} さん`;
    document.getElementById('week-nav').style.display = 'flex';
    document.getElementById('unscheduled-section').style.display = 'block';
    document.getElementById('week-section').style.display = 'block';
    document.getElementById('error-box').style.display = 'none';

    const first = this.days[0].date, last = this.days[6].date;
    document.getElementById('week-label').textContent = `${this.fmtDate(first)} 〜 ${this.fmtDate(last)}`;

    // 未予定タスク。CARVE案件は小見出しを挟んで下側にまとめる(2026-08-07 社長指示)。
    // グループ内の並び順(納期の早い順)はサーバーから来た順のまま
    const normalItems = this.unscheduled.filter(i => !i.is_carve);
    const carveItems = this.unscheduled.filter(i => i.is_carve);
    document.getElementById('unscheduled-chips').innerHTML = normalItems.map(i => this.chipHtml(i)).join('');
    // CARVE案件は独立した折りたたみにする(2026-08-19)。0件のときは見出しごと隠す
    document.getElementById('carve-group').style.display = carveItems.length ? 'block' : 'none';
    document.getElementById('carve-count').textContent = carveItems.length;
    document.getElementById('carve-chips').innerHTML = carveItems.map(i => this.chipHtml(i)).join('');
    document.getElementById('unscheduled-count').textContent = this.unscheduled.length;
    document.getElementById('unscheduled-empty').style.display = this.unscheduled.length ? 'none' : 'block';

    this.renderSheetTodos();
    this.applySectionStates();

    // 日カード
    const todayISO = this.toISO(new Date());
    document.getElementById('days').innerHTML = this.days.map(day => {
      const items = this.scheduled.filter(i => i.scheduled_date === day.date);
      const dayTodos = (this.sheetTodos || []).filter(t => t.scheduled_date === day.date);
      const planned = this.dayLoad(day.date).planned;
      const over = day.hours > 0 && planned > day.hours;
      const capHtml = day.is_day_off
        ? `<span class="day-off-badge">稼働なし</span>`
        : `<span class="day-cap"><span class="${over ? 'over' : ''}">${this.round(planned)}h</span> / ${this.round(day.hours)}h</span>`;
      const overrideBadge = day.source === 'override' ? `<span class="day-override-badge">変更申告あり</span>` : '';
      // その日の稼働時刻。申告した時間帯(override)は色を変えて区別し、未申告の日は基本の勤務時間を出す。
      // 稼働なしの日は時刻が無いので出さない
      const timeHtml = (!day.is_day_off && day.start_time && day.end_time)
        ? `<span class="day-time${day.source === 'override' ? ' is-override' : ''}">${day.start_time}〜${day.end_time}</span>`
        : '';
      const dow = this.dowLabel(day.date);
      // 日別モード(この日の仕事の種類の意向)。選択中のボタンをもう一度押すと解除
      const modeButtons = `
        <div class="day-mode-row" onclick="event.stopPropagation()">
          <button type="button" class="mode-btn mode-btn-design${day.mode === 'DESIGN' ? ' active' : ''}"
                  onclick="board.setDayMode('${day.date}', 'DESIGN')">🎨 デザイン</button>
          <button type="button" class="mode-btn mode-btn-related${day.mode === 'DESIGN_RELATED' ? ' active' : ''}"
                  onclick="board.setDayMode('${day.date}', 'DESIGN_RELATED')">📋 デザイン関連業務</button>
        </div>`;
      return `
        <div class="day-card${day.date === todayISO ? ' today' : ''}${day.is_day_off ? ' day-off' : ''}"
             data-date="${day.date}"
             ondragover="board.onDayDragOver(event)" ondragleave="board.onDayDragLeave(event)"
             ondrop="board.onDayDrop(event, '${day.date}')"
             onclick="board.onDayTap('${day.date}')">
          <div class="day-head">
            <span class="day-title">${dow.html} <span style="font-weight:400;font-size:.82rem;">${this.fmtDate(day.date)}</span></span>
            ${capHtml}
            ${timeHtml}
            ${overrideBadge}
            <button type="button" class="btn-availability" onclick="event.stopPropagation(); board.openAvailabilityModal('${day.date}')">⚙ 稼働変更</button>
          </div>
          ${modeButtons}
          <div class="day-chips">
            ${items.map(i => this.chipHtml(i)).join('')}
            ${dayTodos.map(t => this.todoChipHtml(t)).join('')}
            ${items.length || dayTodos.length ? '' : '<div class="day-drop-hint">ここにドラッグ / タップで移動</div>'}
          </div>
        </div>
      `;
    }).join('');
  },

  // ===== セクションの折りたたみ(2026-08-19 社長要望) =====
  // タスクが多いと右ペインの中で「TODOリスト」等が下へ押し出されて見失うため、
  // 見出しは固定表示にして中身だけ開閉する。開閉状態は端末ごとに覚える。
  // 既定は「未定タスク・CARVE案件は閉じ / TODOリストは開き」
  SECTION_KEYS: ['unscheduled', 'carve', 'sheet-todos'],
  SECTION_DEFAULT_COLLAPSED: { unscheduled: true, carve: true, 'sheet-todos': false },

  sectionStorageKey(key) { return `hiboard.designer.collapsed.${key}`; },

  isSectionCollapsed(key) {
    let saved = null;
    try { saved = localStorage.getItem(this.sectionStorageKey(key)); } catch (e) { /* 保存不可でも動かす */ }
    if (saved === null) return !!this.SECTION_DEFAULT_COLLAPSED[key];
    return saved === '1';
  },

  toggleSection(key) {
    const next = !this.isSectionCollapsed(key);
    try { localStorage.setItem(this.sectionStorageKey(key), next ? '1' : '0'); } catch (e) { /* 同上 */ }
    this.applySectionState(key);
  },

  applySectionState(key) {
    const head = document.getElementById(`${key}-head`);
    const body = document.getElementById(`${key}-body`);
    if (!head || !body) return;
    const collapsed = this.isSectionCollapsed(key);
    body.style.display = collapsed ? 'none' : '';
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    head.querySelector('.sec-caret').textContent = collapsed ? '▸' : '▾';
  },

  applySectionStates() { this.SECTION_KEYS.forEach(k => this.applySectionState(k)); },

  // ===== TODOリスト(スプレッドシート連携)の表示 =====
  // 社員用TODOリストの本人タブから「未着手」「進行中」を自動表示する(閲覧のみ)。
  // sheetTodos が null のとき(連携未設定・取得失敗)はセクションごと隠す
  renderSheetTodos() {
    const section = document.getElementById('sheet-todos-section');
    if (this.sheetTodos === null) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';
    this.applySectionState('sheet-todos');
    // 日付に置いたTODOは日カード側に出るので、ここでは未計画のものだけ並べる。
    // 「未着手」は件数が多く確認の負担になるため一覧には出さず、「進行中」だけを表示する
    // (2026-07-27 社長指示)。日付に置き済みのものは状態を問わず日カードに残す。
    //
    // ただし予定日が「表示中の週の外」にあるTODOは、日カード(今週分だけ)にも
    // 出ないためどこからも見えなくなる(2026-08-19 社長報告「操作していたら消えた」)。
    // 取りこぼすと誰も気づけないので、この一覧に予定日つきで出す
    const weekDates = new Set(this.days.map(d => d.date));
    const unplanned = this.sheetTodos.filter(t =>
      t.status === '進行中' && (!t.scheduled_date || !weekDates.has(t.scheduled_date)));
    document.getElementById('sheet-todos-count').textContent = unplanned.length;
    document.getElementById('sheet-todos-empty').style.display = unplanned.length ? 'none' : 'block';
    document.getElementById('sheet-todos-chips').innerHTML = unplanned.map(t => this.todoChipHtml(t)).join('');
  },

  // TODOチップ。準備項目と同じくD&D(タッチ端末はタップ選択→日付タップ)で日付に置ける。
  // 状態バッジに加えて完了ボタンを持ち、押すとスプレッドシート側も「完了」に更新する
  todoChipHtml(t) {
    const inProgress = t.status === '進行中';
    const deadline = this.fmtSheetDate(t.deadline);
    const selected = this.selectedTodoText === t.task;
    // 表示中の週の外に予定されているTODOはTODOリスト側に出るので、いつの予定かを明示する
    const outOfWeek = t.scheduled_date && !this.days.some(d => d.date === t.scheduled_date);
    const metaParts = [];
    if (deadline) metaParts.push(`期限 ${deadline}`);
    if (t.memo) metaParts.push(this.esc(t.memo));
    const encoded = encodeURIComponent(t.task);
    return `
      <div class="todo-chip${selected ? ' selected' : ''}" draggable="true"
           ondragstart="board.onTodoDragStart(event, '${encoded}')" ondragend="board.onChipDragEnd(event)"
           onclick="event.stopPropagation(); board.onTodoTap('${encoded}')">
        <span class="todo-status-badge ${inProgress ? 'todo-status-inprogress' : 'todo-status-notstarted'}">${inProgress ? '進行中' : '未着手'}</span>
        ${outOfWeek ? `<span class="todo-otherweek-badge">📅 ${this.fmtDate(t.scheduled_date)} に予定</span>` : ''}
        <div class="chip-main">
          <div class="chip-name">📝 ${this.esc(t.task)}${this.carryoverBadgeHtml(t.carryover_count)}</div>
          ${metaParts.length ? `<div class="chip-meta">${metaParts.join(' ｜ ')}</div>` : ''}
        </div>
        <div class="chip-controls" onclick="event.stopPropagation()">
          <select class="chip-date" onchange="board.onTodoDateChange('${encoded}', this.value)">
            ${this.dateOptionsHtml(t.scheduled_date)}
          </select>
          <input type="number" class="chip-hours" min="0" max="14" step="0.5"
                 value="${t.estimated_hours ?? ''}" placeholder="h"
                 onchange="board.onTodoHoursChange('${encoded}', this.value)">
          <span class="chip-hours-label">h</span>
          ${t.scheduled_date ? `<button type="button" class="btn-unplan" onclick="board.onTodoDateChange('${encoded}', '')" title="このタスクをTODOリストに戻します">↩︎ 未定に戻す</button>` : ''}
          <button type="button" class="btn-todo-done" onclick="board.onTodoComplete('${encoded}')"
                  title="TODOリスト(スプレッドシート)も完了に更新します">✓ 完了</button>
        </div>
      </div>
    `;
  },

  // ===== TODOの予定操作 =====
  onTodoDragStart(event, encodedTask) {
    this.draggingTodoText = decodeURIComponent(encodedTask);
    this.draggingItemId = null;
    event.dataTransfer.effectAllowed = 'move';
    event.target.classList.add('dragging');
  },

  onTodoTap(encodedTask) {
    const task = decodeURIComponent(encodedTask);
    this.selectedTodoText = this.selectedTodoText === task ? null : task;
    this.selectedItemId = null;
    this.render();
    if (this.selectedTodoText) this.toast('移動先の日付をタップしてください');
  },

  async saveTodoPlan(taskText, body, successMsg) {
    try {
      const res = await fetch(`/api/designer/${this.token}/sheet-todo-plan`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_text: taskText, ...body }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        this.toast(data.error || '保存に失敗しました');
      } else {
        this.toast(successMsg);
      }
    } catch (e) {
      console.error(e);
      this.toast('通信エラーで保存できませんでした');
    }
    await this.load();
  },

  async moveTodo(taskText, dateISO) {
    await this.requestMove({ kind: 'todo', task: taskText }, dateISO);
  },

  // TODOの完了。スプレッドシート側の状態を「完了」に更新し、一覧からも消える。
  // シートがマスターなので取り消しはスプレッドシート側で行う ⇒ 押す前に確認する
  async onTodoComplete(encodedTask) {
    const task = decodeURIComponent(encodedTask);
    if (!confirm(`このタスクを完了にしますか?\n\n${task}\n\nTODOリスト(スプレッドシート)も完了に更新されます。`)) return;
    try {
      const res = await fetch(`/api/designer/${this.token}/sheet-todo-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_text: task }),
      });
      const data = await res.json();
      this.toast(!res.ok || !data.ok ? (data.error || '完了にできませんでした') : '完了にしました');
    } catch (e) {
      console.error(e);
      this.toast('通信エラーで完了にできませんでした');
    }
    await this.load();
  },

  async onTodoHoursChange(encodedTask, value) {
    const task = decodeURIComponent(encodedTask);
    const h = value === '' ? null : Number(value);
    if (h !== null && (Number.isNaN(h) || h < 0 || h > 14)) return this.toast('0〜14時間で入力してください');
    const current = this.sheetTodos.find(t => t.task === task);
    await this.saveTodoPlan(task, {
      scheduled_date: current ? current.scheduled_date : null,
      estimated_hours: h,
    }, '見込み時間を保存しました');
  },

  // シートの期限は "YYYY/MM/DD" 形式。表示用に M/D へ(不正な値はそのまま返す)
  fmtSheetDate(v) {
    if (!v) return '';
    const m = String(v).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (!m) return String(v);
    return `${Number(m[2])}/${Number(m[3])}`;
  },

  // ===== 日別モード申告(デザイン/デザイン関連業務) =====
  // 選択中のモードをもう一度押すと解除。保存後は社内スケジュールボードにもバッジ表示される
  async setDayMode(dateISO, mode) {
    const day = this.days.find(d => d.date === dateISO);
    const newMode = day && day.mode === mode ? null : mode;
    try {
      const res = await fetch(`/api/designer/${this.token}/day-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_date: dateISO, mode: newMode }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        this.toast(data.error || '保存に失敗しました');
      } else {
        const labels = { DESIGN: '🎨 デザインの日にしました', DESIGN_RELATED: '📋 デザイン関連業務の日にしました' };
        this.toast(newMode ? labels[newMode] : '設定を解除しました');
      }
    } catch (e) {
      console.error(e);
      this.toast('通信エラーで保存できませんでした');
    }
    await this.load();
  },

  // 社内(山本さん)が添付したデザインラフへのリンク。会社のNASを見られなくても中身を開ける
  roughLinksHtml(caseId) {
    const files = (this.roughFiles || {})[caseId];
    if (!files || !files.length) return '';
    const links = files.map(f =>
      `<a href="${f.url}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${this.esc(f.original_name)}</a>`
    ).join('　');
    return `<div class="chip-meta chip-rough">🖼 ラフ: ${links}</div>`;
  },

  // CARVE案件の作業段階(ラフアップ→写真入れアップ→修正アップ→入稿)のバッジ。
  // 切り替えは chip-controls のプルダウンから本人が行う(社内側もボードから切り替えられる)
  carveStageLabel(key) {
    const st = (this.carveStages || []).find(s => s.key === key);
    return st ? st.label : 'ラフアップ';
  },

  carveSelectHtml(i) {
    if (!i.is_carve) return '';
    const options = (this.carveStages || []).map((s, idx) =>
      `<option value="${s.key}" ${s.key === i.carve_stage ? 'selected' : ''}>${idx + 1}. ${this.esc(s.label)}</option>`
    ).join('');
    return `
      <select class="carve-stage-select" title="CARVEの作業段階"
              onchange="board.onCarveStageChange(${i.case_id}, this.value)">${options}</select>
    `;
  },

  // 校正の状態バッジ(初校/修正/校了)。3つとも常に出し、押すとその状態になる。
  // 選択中のバッジをもう一度押すと未選択に戻る(日別モードのボタンと同じ操作感)。
  // 案件単位なので、同じ案件のカードが複数あればすべて同時に切り替わる
  proofBadgesHtml(i) {
    const buttons = (this.proofStages || []).map(p => `
      <button type="button" class="proof-badge${i.proof_stage === p.key ? ' active' : ''}"
              onclick="event.stopPropagation(); board.onProofStageChange(${i.case_id}, '${p.key}')"
              title="校正の状態を「${this.esc(p.label)}」にします（もう一度押すと未選択）">${this.esc(p.label)}</button>
    `).join('');
    return `<div class="proof-row" onclick="event.stopPropagation()">${buttons}</div>`;
  },

  // 校正の状態を切り替える。選択中のものを押したら未選択(空)にする
  async onProofStageChange(caseId, stage) {
    const current = [...this.unscheduled, ...this.scheduled].find(i => i.case_id === caseId);
    const next = current && current.proof_stage === stage ? '' : stage;
    try {
      const res = await fetch(`/api/designer/${this.token}/cases/${caseId}/proof-stage`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: next }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        this.toast(data.error || '保存に失敗しました');
      } else {
        const label = (this.proofStages || []).find(p => p.key === stage);
        this.toast(next ? `校正の状態を「${label ? label.label : stage}」にしました` : '校正の状態を未選択に戻しました');
      }
    } catch (e) {
      console.error(e);
      this.toast('通信エラーで保存できませんでした');
    }
    await this.load();
  },

  chipHtml(i) {
    const done = i.status === '完了';
    const selected = this.selectedItemId === i.id;
    // 紙媒体案件は工程ごとの納期(初校の納期 / 入稿の納期)が入る。無ければ案件の納期
    const dueDate = i.due_date || i.deadline;
    const dueLabel = i.due_label || '納期';
    const deadline = dueDate ? this.fmtDate(dueDate) : '—';
    const soon = dueDate && !done && this.daysUntil(dueDate) <= 3;
    return `
      <div class="chip${done ? ' completed' : ''}${selected ? ' selected' : ''}${i.is_carve ? ' is-carve' : ''}" draggable="true"
           data-item-id="${i.id}"
           ondragstart="board.onChipDragStart(event, ${i.id})" ondragend="board.onChipDragEnd(event)"
           onclick="event.stopPropagation(); board.onChipTap(${i.id})">
        <div class="chip-main">
          <div class="chip-name">${this.esc(i.project_name)} ${i.is_carve ? `<span class="carve-badge">🔶 ${this.esc(this.carveStageLabel(i.carve_stage))}</span>` : ''}${i.revision_round ? ` <span class="revision-badge">🔁 修正${i.revision_round}回目</span>` : ''}${this.carryoverBadgeHtml(i.carryover_count)}</div>
          <div class="chip-meta">${this.esc(i.preparation_item_name)} ｜ ${this.esc(dueLabel)} <span class="${soon ? 'chip-deadline-soon' : ''}">${deadline}</span></div>
          ${i.revision_round && i.revision_note ? `<div class="chip-meta chip-revision-note">✏️ 修正指示: ${this.esc(i.revision_note)}</div>` : ''}
          ${this.roughLinksHtml(i.case_id)}
          ${this.proofBadgesHtml(i)}
        </div>
        <div class="chip-controls" onclick="event.stopPropagation()">
          ${this.carveSelectHtml(i)}
          <select class="chip-date" onchange="board.onItemDateChange(${i.id}, this.value)">
            ${this.dateOptionsHtml(i.scheduled_date)}
          </select>
          <input type="number" class="chip-hours" min="0" max="14" step="0.5"
                 value="${i.estimated_hours ?? ''}" placeholder="h"
                 onchange="board.onHoursChange(${i.id}, this.value)">
          <span class="chip-hours-label">h</span>
          <label class="chip-done-label">
            <input type="checkbox" ${done ? 'checked' : ''} onchange="board.onDoneChange(${i.id}, this.checked)"> 完了
          </label>
          ${i.scheduled_date ? `<button type="button" class="btn-unplan" onclick="board.onItemDateChange(${i.id}, '')" title="このタスクを「日付が未定のタスク」に戻します">↩︎ 未定に戻す</button>` : ''}
          ${i.releasable ? `<button type="button" class="btn-release" onclick="board.onReleaseItem(${i.id})" title="このタスクを自分のボードから外します。案件からは消えず、三浦さんが担当を決め直せる状態に戻ります">🙅 自分の担当ではない</button>` : ''}
        </div>
      </div>
    `;
  },

  // その日の割り当て済み時間と稼働可能時間。日カードの残量表示と日付プルダウンで共有する
  // (両方で別々に足すと数字がずれるため1か所にまとめている)
  dayLoad(dateISO) {
    const planned = this.scheduled
        .filter(i => i.scheduled_date === dateISO)
        .reduce((s, i) => s + (Number(i.estimated_hours) || 0), 0)
      + (this.sheetTodos || [])
        .filter(t => t.scheduled_date === dateISO)
        .reduce((s, t) => s + (Number(t.estimated_hours) || 0), 0);
    const day = this.days.find(d => d.date === dateISO);
    return { planned, hours: day ? day.hours : 0 };
  },

  // 表示中の週の日付プルダウン。長い画面をドラッグしなくても日付を決められるようにする
  // (ドラッグ&ドロップも従来どおり使える)
  dateOptionsHtml(selectedDate) {
    const options = [`<option value="" ${!selectedDate ? 'selected' : ''}>日付を選ぶ</option>`];
    this.days.forEach(day => {
      // 日カードまでスクロールしなくても空き具合で選べるように残り時間を出す(2026-08-19 社長要望)
      let load = '（稼働なし）';
      if (!day.is_day_off) {
        const { planned, hours } = this.dayLoad(day.date);
        const free = hours - planned;
        load = hours > 0
          ? (free < 0 ? `（${this.round(-free)}h超過 / ${this.round(hours)}h）`
                      : `（残り${this.round(free)}h / ${this.round(hours)}h）`)
          : '';
      }
      const label = `${this.dowLabel(day.date).text.replace('曜', '')} ${this.fmtDate(day.date)}${load}`;
      options.push(`<option value="${day.date}" ${selectedDate === day.date ? 'selected' : ''}>${label}</option>`);
    });
    // 表示中の週の外に予定が入っている場合も、選択中の日付が分かるようにしておく
    if (selectedDate && !this.days.some(d => d.date === selectedDate)) {
      options.push(`<option value="${selectedDate}" selected>${this.fmtDate(selectedDate)}</option>`);
    }
    return options.join('');
  },

  async onItemDateChange(itemId, value) {
    await this.requestMove({ kind: 'item', id: itemId }, value || null);
  },

  // 「自分の担当ではない」でタスクを手放す。ボードから消えるだけで案件からは消えない
  // (未割り当ての準備項目として社内の週間スケジュールボードに残り、三浦さんが担当を決め直せる)。
  // 元に戻すには社内側で割り当て直す必要があるため、押す前に確認する
  async onReleaseItem(itemId) {
    const item = this.findItem(itemId);
    const name = item ? `${item.project_name} / ${item.preparation_item_name}` : 'このタスク';
    if (!confirm(`このタスクを自分のボードから外しますか?\n\n${name}\n\n案件からは消えません。社内側で担当を決め直す状態に戻ります。\n(自分で戻すことはできません)`)) return;

    try {
      const res = await fetch(`/api/designer/${this.token}/items/${itemId}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        this.toast(data.error || '外すことができませんでした');
      } else {
        this.toast('自分のボードから外しました');
      }
    } catch (e) {
      console.error(e);
      this.toast('通信エラーで外せませんでした');
    }
    await this.load();
  },

  // 表示中のタスクをIDで探す(確認メッセージに作業名を出すため)
  findItem(itemId) {
    const all = [...(this.unscheduled || []), ...(this.scheduled || [])];
    return all.find(i => i.id === itemId) || null;
  },

  // CARVE案件の作業段階を切り替える(同じ案件のチップすべてに反映される)
  async onCarveStageChange(caseId, stage) {
    try {
      const res = await fetch(`/api/designer/${this.token}/cases/${caseId}/carve-stage`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        this.toast(data.error || '保存に失敗しました');
      } else {
        this.toast(`作業段階を「${this.carveStageLabel(stage)}」にしました`);
      }
    } catch (e) {
      console.error(e);
      this.toast('通信エラーで保存できませんでした');
    }
    await this.load();
  },

  async onTodoDateChange(encodedTask, value) {
    await this.requestMove({ kind: 'todo', task: decodeURIComponent(encodedTask) }, value || null);
  },

  // ===== 持ち越し(予定日が来ているタスクを後ろへ動かす) =====
  // 予定していた日が既に来ているのに、その日から外す操作を「持ち越し」と呼ぶ。
  // 黙って通すと1日で終わらない作業がそのまま翌日へ流れ続け、
  // その日の業務量が適正だったのか誰にも分からなくなるため、
  //   ・残り何時間かかるかを申告してもらう(翌日の計画時間に正しく乗る)
  //   ・理由をワンタップで選んでもらう(業務量オーバーか割り込みかを後で切り分ける)
  //   ・ひとことメモ(任意)で具体的な事情を書けるようにする
  //     (選択肢だけでは「何に時間を取られたのか」が分からないため。2026-08-20 社長要望)
  // だけ確認してから通す。サーバー側(lib/task-moves.js)でも同じ規則で判定する。

  carryoverBadgeHtml(count) {
    if (!count) return '';
    return ` <span class="carryover-badge" title="このタスクは予定日を過ぎてから${count}回動かされています">⏩ ${count}回持ち越し</span>`;
  },

  // 移動対象の現在の状態。kind に応じて準備項目・TODOのどちらかを返す
  moveTarget(target) {
    if (target.kind === 'item') {
      const item = this.findItem(target.id);
      if (!item) return null;
      return {
        name: `${item.project_name} / ${item.preparation_item_name}`,
        from: item.scheduled_date,
        hours: item.estimated_hours,
        carryoverCount: item.carryover_count || 0,
        done: item.status === '完了',
      };
    }
    const todo = (this.sheetTodos || []).find(t => t.task === target.task);
    if (!todo) return null;
    return {
      name: todo.task,
      from: todo.scheduled_date,
      hours: todo.estimated_hours,
      carryoverCount: todo.carryover_count || 0,
      done: false, // シートTODOは完了にするとボードから消えるので、ここに来るのは未完了のものだけ
    };
  },

  // サーバー(lib/task-moves.js の isCarryover)と同じ判定
  isCarryoverMove(fromDate, toDate) {
    if (!fromDate) return false;
    const today = this.toISO(new Date());
    if (fromDate > today) return false;
    if (!toDate) return true;
    return toDate > fromDate;
  },

  async requestMove(target, toDate) {
    const current = this.moveTarget(target);
    if (!current) return;
    if (current.from === toDate) return;

    // 完了済みのタスクを片付けのために動かすのは業務量の持ち越しではないので確認しない
    // (サーバー側も status が完了なら履歴を残さない)
    if (current.done || !this.isCarryoverMove(current.from, toDate)) {
      return this.commitMove(target, toDate, {});
    }
    this.openCarryoverModal(target, toDate, current);
  },

  // 実際の保存。持ち越しダイアログを通った場合は残り時間と理由も一緒に送る
  async commitMove(target, toDate, extra) {
    const msg = toDate ? `${this.fmtDate(toDate)} に移動しました`
      : (target.kind === 'item' ? '日付を未定に戻しました' : 'TODOリストへ戻しました');
    const body = { scheduled_date: toDate, ...extra };
    if (target.kind === 'item') {
      await this.updateItem(target.id, body, msg);
    } else {
      await this.saveTodoPlan(target.task, body, msg);
    }
  },

  openCarryoverModal(target, toDate, current) {
    this.pendingMove = { target, toDate, reason: null };

    const daysOver = -this.daysUntil(current.from);
    const overText = daysOver > 0 ? `（${daysOver}日前の予定）` : '（今日の予定）';
    const toText = toDate ? `${this.fmtDate(toDate)}` : '日付未定';

    document.getElementById('carryover-task').textContent = current.name;
    document.getElementById('carryover-from').textContent =
      `${this.fmtDate(current.from)} の予定${overText} → ${toText}`;

    const repeat = document.getElementById('carryover-repeat');
    if (current.carryoverCount > 0) {
      repeat.textContent = `このタスクはこれまでに ${current.carryoverCount} 回持ち越しています。`;
      repeat.style.display = 'block';
    } else {
      repeat.style.display = 'none';
    }

    // 残り時間の初期値は今の見込み時間。丸ごと持ち越すならそのまま、
    // 半分進んだなら減らして出す(翌日の計画時間が実態に合う)
    document.getElementById('carryover-hours').value = current.hours ?? '';

    document.getElementById('carryover-reasons').innerHTML = this.carryoverReasons.map(r => `
      <button type="button" class="carryover-reason" data-reason="${r.key}"
              onclick="board.selectCarryoverReason('${r.key}')">${this.esc(r.label)}</button>
    `).join('');

    // メモは毎回まっさらにする(前のタスクの事情が残っていると誤った記録になる)
    const noteInput = document.getElementById('carryover-note');
    noteInput.value = '';
    if (this.carryoverNoteMax) noteInput.maxLength = this.carryoverNoteMax;

    document.getElementById('carryover-modal').classList.add('active');
  },

  selectCarryoverReason(key) {
    // 選択中のものをもう一度押すと未選択に戻す(日別モードのボタンと同じ操作感)
    this.pendingMove.reason = this.pendingMove.reason === key ? null : key;
    document.querySelectorAll('#carryover-reasons .carryover-reason').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.reason === this.pendingMove.reason);
    });
  },

  async submitCarryover() {
    if (!this.pendingMove) return;
    const raw = document.getElementById('carryover-hours').value;
    const hours = raw === '' ? null : Number(raw);
    if (hours !== null && (Number.isNaN(hours) || hours < 0 || hours > 14)) {
      return this.toast('残り時間は0〜14時間で入力してください');
    }

    const note = document.getElementById('carryover-note').value.trim();
    const { target, toDate, reason } = this.pendingMove;
    this.pendingMove = null;
    document.getElementById('carryover-modal').classList.remove('active');

    const extra = { carryover_reason: reason, carryover_note: note };
    // 準備項目は estimated_hours が必須(nullを送れない)ので、未入力なら0として送る
    if (hours !== null || target.kind === 'todo') {
      extra.estimated_hours = target.kind === 'item' ? (hours ?? 0) : hours;
    }
    await this.commitMove(target, toDate, extra);
  },

  // 取りやめ。日付プルダウンから操作した場合は選択が変わったままなので描画し直す
  cancelCarryover() {
    this.pendingMove = null;
    document.getElementById('carryover-modal').classList.remove('active');
    this.render();
  },

  // ===== D&D(PC) =====
  onChipDragStart(e, itemId) {
    this.draggingItemId = itemId;
    e.dataTransfer.effectAllowed = 'move';
    e.target.classList.add('dragging');
  },

  onChipDragEnd(e) {
    e.target.classList.remove('dragging');
  },

  onDayDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('dropover');
  },

  onDayDragLeave(e) {
    e.currentTarget.classList.remove('dropover');
  },

  async onDayDrop(e, dateISO) {
    e.preventDefault();
    e.currentTarget.classList.remove('dropover');
    if (this.draggingItemId) {
      const id = this.draggingItemId;
      this.draggingItemId = null;
      await this.moveItem(id, dateISO);
    } else if (this.draggingTodoText) {
      const task = this.draggingTodoText;
      this.draggingTodoText = null;
      await this.moveTodo(task, dateISO);
    }
  },

  // ===== タップ移動(スマホ・タブレット) =====
  onChipTap(itemId) {
    this.selectedItemId = this.selectedItemId === itemId ? null : itemId;
    this.selectedTodoText = null;
    this.render();
    if (this.selectedItemId) this.toast('移動先の日付をタップしてください');
  },

  async onDayTap(dateISO) {
    if (this.selectedItemId) {
      const id = this.selectedItemId;
      this.selectedItemId = null;
      await this.moveItem(id, dateISO);
    } else if (this.selectedTodoText) {
      const task = this.selectedTodoText;
      this.selectedTodoText = null;
      await this.moveTodo(task, dateISO);
    }
  },

  // ===== 更新API =====
  async moveItem(itemId, dateISO) {
    await this.requestMove({ kind: 'item', id: itemId }, dateISO);
  },

  async onHoursChange(itemId, value) {
    const h = value === '' ? null : Number(value);
    if (h !== null && (Number.isNaN(h) || h < 0 || h > 14)) return this.toast('0〜14時間で入力してください');
    await this.updateItem(itemId, { estimated_hours: h ?? 0 }, '見込み時間を保存しました');
  },

  async onDoneChange(itemId, checked) {
    await this.updateItem(itemId, { status: checked ? '完了' : '未着手' }, checked ? '完了にしました' : '完了を取り消しました');
  },

  async updateItem(itemId, body, successMsg) {
    try {
      const res = await fetch(`/api/designer/${this.token}/items/${itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        this.toast(data.error || '保存に失敗しました');
      } else {
        this.toast(successMsg);
      }
    } catch (e) {
      console.error(e);
      this.toast('通信エラーで保存できませんでした');
    }
    await this.load();
  },

  // ===== 稼働申告 =====
  openAvailabilityModal(dateISO) {
    this.availabilityDate = dateISO;
    document.getElementById('availability-modal-date').textContent = `${this.dowLabel(dateISO).text} ${this.fmtDate(dateISO)}`;
    document.getElementById('hours-input-row').classList.remove('active');
    // すでに時間帯を申告している日は、その値を初期表示して直しやすくする
    const day = (this.days || []).find(d => d.date === dateISO);
    document.getElementById('start-input').value = (day && day.start_time) || '09:00';
    document.getElementById('end-input').value = (day && day.end_time) || '17:00';
    this.updateHoursHint();
    document.getElementById('availability-modal').classList.add('active');
  },

  // 指定した時間帯が何時間になるかを表示する(終了が開始より前なら注意を出す)
  updateHoursHint() {
    const hint = document.getElementById('hours-hint');
    const hours = this.rangeHours();
    if (hours === null) {
      hint.textContent = '終了時刻は開始時刻より後にしてください。';
      hint.style.color = '#b91c1c';
    } else {
      hint.textContent = `この時間帯の稼働時間: ${hours}時間`;
      hint.style.color = '#64748b';
    }
  },

  // 入力中の開始〜終了から稼働時間を求める。不正な並びなら null
  rangeHours() {
    const toMin = v => { const [h, m] = String(v || '').split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN; };
    const s = toMin(document.getElementById('start-input').value);
    const e = toMin(document.getElementById('end-input').value);
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
    return Math.round(((e - s) / 60) * 100) / 100;
  },

  closeAvailabilityModal() {
    document.getElementById('availability-modal').classList.remove('active');
    this.availabilityDate = null;
  },

  showHoursInput() {
    document.getElementById('hours-input-row').classList.add('active');
    document.getElementById('start-input').focus();
  },

  async submitAvailability(mode) {
    if (!this.availabilityDate) return;
    const body = { work_date: this.availabilityDate, mode };
    if (mode === 'hours') {
      if (this.rangeHours() === null) return this.toast('終了時刻は開始時刻より後にしてください');
      body.start_time = document.getElementById('start-input').value;
      body.end_time = document.getElementById('end-input').value;
    }
    try {
      const res = await fetch(`/api/designer/${this.token}/availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        this.toast(data.error || '保存に失敗しました');
      } else {
        this.toast({ off: '稼働なしで申告しました', hours: '稼働できる時間帯を申告しました', clear: '通常の予定に戻しました' }[mode]);
      }
    } catch (e) {
      console.error(e);
      this.toast('通信エラーで保存できませんでした');
    }
    this.closeAvailabilityModal();
    await this.load();
  },

  // ===== ユーティリティ =====
  fmtDate(iso) {
    const [, m, d] = iso.split('-').map(Number);
    return `${m}/${d}`;
  },

  dowLabel(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    const names = ['日', '月', '火', '水', '木', '金', '土'];
    const cls = dow === 0 ? 'dow-sun' : (dow === 6 ? 'dow-sat' : '');
    return { html: `<span class="${cls}">${names[dow]}</span>`, text: `${names[dow]}曜` };
  },

  daysUntil(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const today = new Date();
    return Math.round((new Date(y, m - 1, d) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  },

  round(h) {
    return Math.round(h * 10) / 10;
  },

  esc(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  },
};

document.addEventListener('DOMContentLoaded', () => board.init());
