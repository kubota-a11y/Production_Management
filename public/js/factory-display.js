// ========================================
// 工場モニター表示(閲覧専用) /schedule/display
//
// 工場のテレビに映す「今日の作業予定」。データは /api/factory-display 1本で受け取り、
// 1人1行・大きな文字で描くだけ。編集の仕組み(ドラッグ・モーダル・提案)は一切持たない。
// 60秒ごとに再取得するので、週間ボードで予定を動かせばテレビ側も自動で追いつく。
// ?date=YYYY-MM-DD を付けると任意の日を表示できる(動作確認・前日の準備用)
// ========================================

const factoryDisplay = {
  REFRESH_MS: 60000,
  STALE_MS: 5 * 60000,
  lastOkAt: null,
  hasRendered: false,

  // 週間ボード(schedule-board.js の colorPalette)と同じ並び。案件の色をボードと揃えるため、
  // 片方を変えたらもう片方も直す
  colorPalette: [
    '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899',
    '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#06b6d4'
  ],

  // 遠くから読むための短い加工名。無いものは utils.js の getProcessLabel にフォールバック
  shortProcessLabels: {
    SILK_SCREEN_PRINT: 'シルク',
    DTF_PRINT: 'DTF',
    RUBBER_TRANSFER_PRINT: 'ラバー',
    SUBLIMATION_PRINT: '昇華',
    STANDARD_EMBROIDERY: '刺繍',
    HAT_EMBROIDERY: '帽子刺繍',
    PATCH_EMBROIDERY: 'ワッペン',
    PRINT: 'プリント',
    EMBROIDERY: '刺繍',
    COMBINED: '複合',
  },

  init() {
    this.tickClock();
    setInterval(() => this.tickClock(), 1000);
    this.setupFullscreenButton();
    this.load();
    setInterval(() => this.load(), this.REFRESH_MS);
  },

  // ===== 通信 =====
  async load() {
    const params = new URLSearchParams(location.search);
    const date = params.get('date');
    const url = date ? `/api/factory-display?date=${encodeURIComponent(date)}` : '/api/factory-display';
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.lastOkAt = new Date();
      this.render(data);
      this.hasRendered = true;
    } catch (error) {
      console.error('工場モニター表示の取得に失敗しました:', error);
      // 前回の表示は残したまま、更新できていないことだけ知らせる
      if (!this.hasRendered) {
        document.getElementById('fd-rows').innerHTML = '<div class="fd-error">予定を読み込めませんでした。しばらく待つと自動で再試行します</div>';
      }
    }
    this.renderUpdatedLabel();
  },

  // ===== 描画 =====
  render(data) {
    this.renderHeader(data.today);
    this.renderRows(data.today);
    this.renderNext(data.next, data.next_is_tomorrow);
  },

  renderHeader(day) {
    document.getElementById('fd-date').textContent = this.formatDateLabel(day.date);
    document.getElementById('fd-holiday').textContent = day.holiday_name || '';
  },

  renderRows(day) {
    const container = document.getElementById('fd-rows');
    const employees = day.employees || [];
    // 行数に合わせて文字サイズを決める(CSSの --fd-base が参照する)
    document.documentElement.style.setProperty('--fd-rows', String(Math.max(employees.length, 1)));

    if (employees.length === 0) {
      container.innerHTML = '<div class="fd-empty">有効な従業員が登録されていません</div>';
      return;
    }

    container.innerHTML = employees.map(emp => this.renderRow(emp)).join('');
  },

  renderRow(emp) {
    const stateCls = emp.state === 'off' ? ' is-off' : emp.state === 'over' ? ' is-over' : '';
    const noteHtml = emp.note ? `<div class="fd-note" title="${this.escapeHtml(emp.note)}">📝 ${this.escapeHtml(emp.note)}</div>` : '';

    if (emp.state === 'off') {
      return `
        <div class="fd-row is-off">
          <div class="fd-name">${this.escapeHtml(emp.name)}</div>
          <div class="fd-load"><span class="fd-chip fd-chip-off">休み</span>${noteHtml}</div>
          <div class="fd-items">${emp.items.length ? emp.items.map(i => this.renderItem(i)).join('') : ''}</div>
        </div>`;
    }

    const fillPct = Math.min((emp.planned_hours / Math.max(emp.reference_hours, 0.1)) * 100, 100);
    const chip = emp.state === 'over'
      ? '<span class="fd-chip fd-chip-over">🔥 入りきらない</span>'
      : emp.state === 'short'
        ? '<span class="fd-chip fd-chip-short">🕗 空きあり</span>'
        : '';
    const itemsHtml = emp.items.length
      ? emp.items.map(i => this.renderItem(i)).join('')
      : '<span class="fd-empty">今日の予定はまだ入っていません</span>';

    return `
      <div class="fd-row${stateCls}">
        <div class="fd-name">${this.escapeHtml(emp.name)}</div>
        <div class="fd-load">
          <div class="fd-hours">${this.formatHours(emp.planned_hours)}h <span class="fd-hours-ref">/ ${this.formatHours(emp.reference_hours)}h</span></div>
          <div class="fd-bar"><div class="fd-bar-fill" style="width:${fillPct}%;"></div></div>
          ${chip}
          ${noteHtml}
        </div>
        <div class="fd-items">${itemsHtml}</div>
      </div>`;
  },

  renderItem(item) {
    const cls = ['fd-item'];
    if (item.proposed) cls.push('is-proposed');
    if (item.done) cls.push('is-done');

    const color = item.kind === 'work' ? this.getProjectColor(item.case_id) : null;
    const dot = color ? `<span class="fd-item-dot" style="background:${color};"></span>` : '';

    const tags = [];
    if (item.kind === 'prep') tags.push('<span class="fd-tag fd-tag-prep">準備</span>');
    if (item.kind === 'todo') tags.push('<span class="fd-tag fd-tag-todo">TODO</span>');
    if (item.proposed) tags.push('<span class="fd-tag fd-tag-proposed">提案中</span>');
    if (item.done) tags.push('<span class="fd-tag fd-tag-done">✓ 完了</span>');

    const subParts = [];
    if (item.kind === 'prep' && item.sub) subParts.push(item.sub);
    if (item.kind === 'work') {
      // 案件名に数量が入っていない場合だけ数量を添える(「Tシャツ 18枚」のような名前と二重にしない)
      if (item.quantity && !String(item.title || '').includes(String(item.quantity))) subParts.push(`${item.quantity}点`);
      const process = this.formatProcess(item.process_type);
      if (process) subParts.push(process);
    }
    if (item.hours > 0) subParts.push(`${this.formatHours(item.hours)}h`);
    const sub = subParts.length ? `<span class="fd-item-sub">${this.escapeHtml(subParts.join(' ・ '))}</span>` : '';

    return `<span class="${cls.join(' ')}">${dot}${tags.join('')}<span class="fd-item-name">${this.escapeHtml(item.title)}</span>${sub}</span>`;
  },

  renderNext(day, isTomorrow) {
    const footer = document.getElementById('fd-next');
    if (!day) {
      footer.innerHTML = '';
      return;
    }
    const label = `${isTomorrow ? '明日' : '次の出勤日'} ${this.formatDateLabel(day.date, true)}`;
    const working = day.employees.filter(e => e.state !== 'off');
    let listHtml;
    if (working.length === 0) {
      listHtml = '<span class="fd-next-empty">全員休み</span>';
    } else {
      listHtml = working.map(e => {
        const names = e.items.filter(i => !i.done).map(i => i.kind === 'prep' ? `準備:${i.title}` : i.title);
        const body = names.length ? names.join('、') : '予定なし';
        return `<span class="fd-next-emp"><b>${this.escapeHtml(this.shortName(e.name))}</b>${this.escapeHtml(body)}</span>`;
      }).join('');
    }
    footer.innerHTML = `<span class="fd-next-label">${this.escapeHtml(label)}</span><div class="fd-next-list">${listHtml}</div>`;
  },

  renderUpdatedLabel() {
    const meta = document.getElementById('fd-meta');
    const label = document.getElementById('fd-updated');
    if (!this.lastOkAt) {
      label.textContent = '更新できません';
      meta.classList.add('is-stale');
      return;
    }
    const hh = String(this.lastOkAt.getHours()).padStart(2, '0');
    const mm = String(this.lastOkAt.getMinutes()).padStart(2, '0');
    const stale = Date.now() - this.lastOkAt.getTime() > this.STALE_MS;
    label.textContent = stale ? `⚠ ${hh}:${mm} から更新できていません` : `更新 ${hh}:${mm}`;
    meta.classList.toggle('is-stale', stale);
  },

  tickClock() {
    const now = new Date();
    document.getElementById('fd-clock').textContent =
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    // 取得に失敗し続けているときは、時計の更新のたびに「更新できていません」へ切り替わる
    if (this.lastOkAt && Date.now() - this.lastOkAt.getTime() > this.STALE_MS) this.renderUpdatedLabel();
  },

  // 全画面ボタン。Fullscreen API が使える環境(PC・スティック端末・iPadOSのSafari)でだけ出す
  setupFullscreenButton() {
    const btn = document.getElementById('fd-fullscreen');
    const root = document.documentElement;
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!request) return;
    btn.hidden = false;
    btn.addEventListener('click', () => {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      const active = document.fullscreenElement || document.webkitFullscreenElement;
      if (active) exit.call(document);
      else request.call(root);
    });
    const syncLabel = () => {
      const active = document.fullscreenElement || document.webkitFullscreenElement;
      btn.textContent = active ? '全画面を解除' : '全画面';
    };
    document.addEventListener('fullscreenchange', syncLabel);
    document.addEventListener('webkitfullscreenchange', syncLabel);
  },

  // ===== 整形 =====
  // 'YYYY-MM-DD' → '9月4日(金)'。short=true なら '9/5(土)'
  formatDateLabel(iso, short = false) {
    const [y, m, d] = iso.split('-').map(Number);
    const weekday = ['日', '月', '火', '水', '木', '金', '土'][new Date(y, m - 1, d).getDay()];
    return short ? `${m}/${d}(${weekday})` : `${m}月${d}日(${weekday})`;
  },

  // 時間は小数1桁まで(2.27h → 2.3h)。遠くから読むので桁を減らす
  formatHours(hours) {
    const rounded = Math.round((hours || 0) * 10) / 10;
    return String(rounded);
  },

  formatProcess(csv) {
    if (!csv) return '';
    return String(csv).split(',').map(p => p.trim()).filter(Boolean)
      .map(p => this.shortProcessLabels[p] || (typeof getProcessLabel === 'function' ? getProcessLabel(p) : p))
      .join('・');
  },

  // 「渡邉　颯」→「渡邉」。明日の1行は幅が限られるので姓だけにする
  shortName(name) {
    return String(name || '').split(/[\s　]+/)[0] || name;
  },

  getProjectColor(caseId) {
    return this.colorPalette[(caseId || 0) % this.colorPalette.length];
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  },
};

document.addEventListener('DOMContentLoaded', () => factoryDisplay.init());
