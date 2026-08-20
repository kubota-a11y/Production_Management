// 業務量レポート(/workload)のフロント。
//
// 「その日1日の業務量が適正だったか」を後から確かめるための画面。
// マイスケジュールボードで当日終わらなかったタスクを翌日以降へ動かすと
// scheduled_date が書き換わって元の日が空に見えるため、
// サーバー側(lib/task-moves.js)が予定日の変更履歴から当日の計画を復元して返す。

const workloadApp = {
  data: null,

  async init() {
    await this.loadEmployees();
    this.setPreset('this-week');
  },

  async loadEmployees() {
    try {
      const res = await fetch('/api/workload/employees');
      const data = await res.json();
      if (!data.ok) return this.showError(data.error || '対象者を取得できませんでした');
      const select = document.getElementById('employee-select');
      // マイスケジュールボードを持っている人(has_board)を先に出す。持ち越しの記録が貯まるのは基本この人たち
      select.innerHTML = data.employees
        .map(e => `<option value="${e.id}">${this.esc(e.name)}${e.has_board ? '' : '（マイスケなし）'}</option>`)
        .join('');
    } catch (e) {
      console.error(e);
      this.showError('通信エラーが発生しました');
    }
  },

  // ===== 期間 =====
  setPreset(key) {
    const today = new Date();
    let start, end;
    if (key === 'this-week') {
      start = this.mondayOf(today);
      end = this.addDays(start, 6);
    } else if (key === 'last-week') {
      start = this.addDays(this.mondayOf(today), -7);
      end = this.addDays(start, 6);
    } else if (key === 'this-month') {
      start = new Date(today.getFullYear(), today.getMonth(), 1);
      end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    } else {
      end = today;
      start = this.addDays(today, -29);
    }
    document.getElementById('start-input').value = formatDateISO(start);
    document.getElementById('end-input').value = formatDateISO(end);
    this.load();
  },

  mondayOf(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = d.getDay();
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    return d;
  },

  addDays(date, delta) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
    return d;
  },

  // ===== 取得 =====
  async load() {
    const employeeId = document.getElementById('employee-select').value;
    const start = document.getElementById('start-input').value;
    const end = document.getElementById('end-input').value;
    if (!employeeId || !start || !end) return;

    document.getElementById('loading').style.display = 'block';
    document.getElementById('report').style.display = 'none';
    document.getElementById('error-box').style.display = 'none';

    try {
      const res = await fetch(`/api/workload/report?employee_id=${employeeId}&start=${start}&end=${end}`);
      const data = await res.json();
      if (!data.ok) return this.showError(data.error || '集計できませんでした');
      this.data = data;
      this.render();
    } catch (e) {
      console.error(e);
      this.showError('通信エラーが発生しました');
    } finally {
      document.getElementById('loading').style.display = 'none';
    }
  },

  showError(msg) {
    const box = document.getElementById('error-box');
    box.textContent = msg;
    box.style.display = 'block';
    document.getElementById('loading').style.display = 'none';
  },

  // ===== 描画 =====
  render() {
    const d = this.data;
    document.getElementById('report').style.display = 'block';
    this.renderSummary(d.summary);
    this.renderDays(d.days, d.today);
    this.renderTasks(d.carryover_tasks);
    this.renderReasons(d.summary, d.carryover_reasons);
  },

  renderSummary(s) {
    // 消化率は低いほど問題。80%以上なら概ね計画どおり、60%未満は業務量か見込みを疑う
    const doneClass = s.done_rate === null ? '' : (s.done_rate >= 80 ? ' is-good' : (s.done_rate < 60 ? ' is-warn' : ''));
    // 稼働時間に対する計画の詰まり具合。100%を超えていれば初めから入りきらない量を入れている
    const loadClass = s.load_rate !== null && s.load_rate > 100 ? ' is-warn' : '';
    const repeatClass = s.repeat_carryover_tasks > 0 ? ' is-warn' : '';

    document.getElementById('summary').innerHTML = `
      <div class="wl-card${doneClass}">
        <div class="wl-card-label">消化率（完了 ÷ 計画）</div>
        <div class="wl-card-value">${s.done_rate === null ? '—' : s.done_rate + '%'}</div>
        <div class="wl-card-note">計画 ${s.total_planned_hours}h → 完了 ${s.total_done_hours}h</div>
      </div>
      <div class="wl-card${loadClass}">
        <div class="wl-card-label">稼働に対する計画量</div>
        <div class="wl-card-value">${s.load_rate === null ? '—' : s.load_rate + '%'}</div>
        <div class="wl-card-note">稼働 ${s.total_capacity_hours}h に計画 ${s.total_planned_hours}h</div>
      </div>
      <div class="wl-card">
        <div class="wl-card-label">持ち越し</div>
        <div class="wl-card-value">${s.carryover_moves}回</div>
        <div class="wl-card-note">${s.carryover_task_count}件のタスク・計 ${s.total_carried_hours}h</div>
      </div>
      <div class="wl-card${repeatClass}">
        <div class="wl-card-label">3回以上流れたタスク</div>
        <div class="wl-card-value">${s.repeat_carryover_tasks}件</div>
        <div class="wl-card-note">${s.repeat_carryover_tasks > 0 ? 'タスク自体を見直す候補' : '流れ続けているものはありません'}</div>
      </div>
      <div class="wl-card">
        <div class="wl-card-label">集計した稼働日</div>
        <div class="wl-card-value">${s.working_days}日</div>
        <div class="wl-card-note">休みの日と未来の日は除いています</div>
      </div>
    `;
  },

  renderDays(days, today) {
    const dows = ['日', '月', '火', '水', '木', '金', '土'];
    document.getElementById('days-tbody').innerHTML = days.map(day => {
      const [y, m, dd] = day.date.split('-').map(Number);
      const dow = dows[new Date(y, m - 1, dd).getDay()];
      const classes = [
        day.is_day_off ? 'is-day-off' : '',
        day.is_future ? 'is-future' : '',
        day.date === today ? 'is-today' : '',
      ].filter(Boolean).join(' ');

      if (day.is_day_off && day.planned_count === 0) {
        return `<tr class="${classes}"><td>${m}/${dd}(${dow})</td><td colspan="7">稼働なし</td></tr>`;
      }

      return `
        <tr class="${classes}">
          <td>${m}/${dd}(${dow})${day.is_day_off ? ' <span class="wl-task-meta">休</span>' : ''}</td>
          <td>${this.h(day.capacity_hours)}</td>
          <td>${this.h(day.planned_hours)}</td>
          <td>${this.h(day.done_hours)}</td>
          <td class="${day.carried_hours > 0 ? 'wl-carried' : ''}">${this.h(day.carried_hours)}${day.carried_count ? `<span class="wl-task-meta">(${day.carried_count})</span>` : ''}</td>
          <td>${this.h(day.left_hours)}</td>
          <td class="wl-col-count">${day.done_count}/${day.planned_count}</td>
          <td>${this.rateHtml(day)}</td>
        </tr>
      `;
    }).join('');

    // 見込み時間が未入力のタスクが多いと時間の集計そのものが当てにならないので明示する
    const unknown = days.reduce((s, d) => s + d.unknown_hours_count, 0);
    const note = document.getElementById('unknown-note');
    if (unknown > 0) {
      note.textContent = `※ 見込み時間が未入力のタスクが ${unknown} 件あります。件数には入っていますが、時間の合計には含まれていません。`;
      note.style.display = 'block';
    } else {
      note.style.display = 'none';
    }
  },

  // 消化率のバー。未来の日と計画0の日は率を出さない
  rateHtml(day) {
    if (day.done_rate === null) return '<span class="wl-num-zero">—</span>';
    const cls = day.done_rate >= 80 ? '' : (day.done_rate < 50 ? ' is-low' : ' is-mid');
    return `
      <div class="wl-bar">
        <span class="wl-bar-track"><span class="wl-bar-fill${cls}" style="width:${Math.min(100, day.done_rate)}%"></span></span>
        <span class="wl-rate">${day.done_rate}%</span>
      </div>
    `;
  },

  renderTasks(tasks) {
    const list = document.getElementById('task-list');
    const empty = document.getElementById('task-empty');
    if (!tasks.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    list.innerHTML = tasks.map(t => `
      <div class="wl-task${t.done ? ' is-done' : ''}">
        <div class="wl-task-head">
          <span class="wl-task-count">⏩ ${t.count}回</span>
          <span class="wl-task-name">${this.esc(t.name)}</span>
          <span class="wl-task-meta">
            ${formatDate(t.first_date)} から
            ${t.done ? '・完了済み' : (t.current_date ? `・現在は ${formatDate(t.current_date)} の予定` : '・現在は日付未定')}
          </span>
        </div>
        ${this.notesHtml(t.notes)}
      </div>
    `).join('');
  },

  // 本人が書いたひとことメモ。選択肢では分からない具体的な事情が入っている
  notesHtml(notes) {
    if (!notes || !notes.length) return '';
    return `<div class="wl-task-notes">${notes.map(n => `
      <div class="wl-task-note"><span class="wl-note-date">${formatDate(n.date)}</span> ${this.esc(n.text)}</div>
    `).join('')}</div>`;
  },

  renderReasons(summary, reasons) {
    const box = document.getElementById('reason-breakdown');
    if (!summary.carryover_moves) return (box.innerHTML = '');
    const parts = (reasons || []).map(r =>
      `<span class="wl-reason">${this.esc(r.label)} <strong>${summary.reason_counts[r.key] || 0}</strong></span>`);
    if (summary.reason_unanswered) {
      parts.push(`<span class="wl-reason">理由の記入なし <strong>${summary.reason_unanswered}</strong></span>`);
    }
    box.innerHTML = parts.join('');
  },

  // 0時間は薄く出して、値が入っている日を目で追いやすくする
  h(v) {
    return v > 0 ? `${v}h` : '<span class="wl-num-zero">0</span>';
  },

  esc(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  },
};

document.addEventListener('DOMContentLoaded', () => workloadApp.init());
