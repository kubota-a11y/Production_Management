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
  selectedItemId: null,  // タップ移動用に選択中のタスクID
  draggingItemId: null,
  availabilityDate: null,

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
      this.designerName = data.designer_name;
      this.selectedItemId = null;
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

    // 未予定タスク
    const uc = document.getElementById('unscheduled-chips');
    uc.innerHTML = this.unscheduled.map(i => this.chipHtml(i)).join('');
    document.getElementById('unscheduled-count').textContent = this.unscheduled.length;
    document.getElementById('unscheduled-empty').style.display = this.unscheduled.length ? 'none' : 'block';

    this.renderSheetTodos();

    // 日カード
    const todayISO = this.toISO(new Date());
    document.getElementById('days').innerHTML = this.days.map(day => {
      const items = this.scheduled.filter(i => i.scheduled_date === day.date);
      const planned = items.reduce((s, i) => s + (Number(i.estimated_hours) || 0), 0);
      const over = day.hours > 0 && planned > day.hours;
      const capHtml = day.is_day_off
        ? `<span class="day-off-badge">稼働なし</span>`
        : `<span class="day-cap"><span class="${over ? 'over' : ''}">${this.round(planned)}h</span> / ${this.round(day.hours)}h</span>`;
      const overrideBadge = day.source === 'override' ? `<span class="day-override-badge">変更申告あり</span>` : '';
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
            ${overrideBadge}
            <button type="button" class="btn-availability" onclick="event.stopPropagation(); board.openAvailabilityModal('${day.date}')">⚙ 稼働変更</button>
          </div>
          ${modeButtons}
          <div class="day-chips">
            ${items.map(i => this.chipHtml(i)).join('') || '<div class="day-drop-hint">ここにドラッグ / タップで移動</div>'}
          </div>
        </div>
      `;
    }).join('');
  },

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
    document.getElementById('sheet-todos-count').textContent = this.sheetTodos.length;
    document.getElementById('sheet-todos-empty').style.display = this.sheetTodos.length ? 'none' : 'block';
    document.getElementById('sheet-todos-chips').innerHTML = this.sheetTodos.map(t => {
      const inProgress = t.status === '進行中';
      const deadline = this.fmtSheetDate(t.deadline);
      const metaParts = [];
      if (deadline) metaParts.push(`期限 ${deadline}`);
      if (t.memo) metaParts.push(this.esc(t.memo));
      return `
        <div class="todo-chip">
          <span class="todo-status-badge ${inProgress ? 'todo-status-inprogress' : 'todo-status-notstarted'}">${inProgress ? '進行中' : '未着手'}</span>
          <div class="chip-main">
            <div class="chip-name">${this.esc(t.task)}</div>
            ${metaParts.length ? `<div class="chip-meta">${metaParts.join(' ｜ ')}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');
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

  chipHtml(i) {
    const done = i.status === '完了';
    const selected = this.selectedItemId === i.id;
    const deadline = i.deadline ? this.fmtDate(i.deadline) : '—';
    const soon = i.deadline && !done && this.daysUntil(i.deadline) <= 3;
    return `
      <div class="chip${done ? ' completed' : ''}${selected ? ' selected' : ''}" draggable="true"
           data-item-id="${i.id}"
           ondragstart="board.onChipDragStart(event, ${i.id})" ondragend="board.onChipDragEnd(event)"
           onclick="event.stopPropagation(); board.onChipTap(${i.id})">
        <div class="chip-main">
          <div class="chip-name">${this.esc(i.project_name)}</div>
          <div class="chip-meta">${this.esc(i.preparation_item_name)} ｜ 納期 <span class="${soon ? 'chip-deadline-soon' : ''}">${deadline}</span></div>
        </div>
        <div class="chip-controls" onclick="event.stopPropagation()">
          <input type="number" class="chip-hours" min="0" max="14" step="0.5"
                 value="${i.estimated_hours ?? ''}" placeholder="h"
                 onchange="board.onHoursChange(${i.id}, this.value)">
          <span class="chip-hours-label">h</span>
          <label class="chip-done-label">
            <input type="checkbox" ${done ? 'checked' : ''} onchange="board.onDoneChange(${i.id}, this.checked)"> 完了
          </label>
        </div>
      </div>
    `;
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
      await this.moveItem(this.draggingItemId, dateISO);
      this.draggingItemId = null;
    }
  },

  // ===== タップ移動(スマホ・タブレット) =====
  onChipTap(itemId) {
    this.selectedItemId = this.selectedItemId === itemId ? null : itemId;
    this.render();
    if (this.selectedItemId) this.toast('移動先の日付をタップしてください');
  },

  async onDayTap(dateISO) {
    if (!this.selectedItemId) return;
    const id = this.selectedItemId;
    this.selectedItemId = null;
    await this.moveItem(id, dateISO);
  },

  // ===== 更新API =====
  async moveItem(itemId, dateISO) {
    await this.updateItem(itemId, { scheduled_date: dateISO }, `${this.fmtDate(dateISO)} に移動しました`);
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
    document.getElementById('hours-input').value = '';
    document.getElementById('availability-modal').classList.add('active');
  },

  closeAvailabilityModal() {
    document.getElementById('availability-modal').classList.remove('active');
    this.availabilityDate = null;
  },

  showHoursInput() {
    document.getElementById('hours-input-row').classList.add('active');
    document.getElementById('hours-input').focus();
  },

  async submitAvailability(mode) {
    if (!this.availabilityDate) return;
    const body = { work_date: this.availabilityDate, mode };
    if (mode === 'hours') {
      const h = Number(document.getElementById('hours-input').value);
      if (!h || Number.isNaN(h)) return this.toast('稼働時間を入力してください');
      body.hours = h;
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
        this.toast({ off: '稼働なしで申告しました', hours: '稼働時間を申告しました', clear: '通常の予定に戻しました' }[mode]);
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
