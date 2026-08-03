// オペレーションボード(/ops)。デザイン案件が「いま誰待ちで止まっているか」を5段階で管理する。
// 段階の定義とサーバー側の遷移は lib/ops-board.js を参照。

const opsBoardApp = {
  data: null,
  currentCaseId: null,

  // 各段階の主担当。カード列の副題に出す
  STAGE_OWNER: {
    BRIEF: '山本',
    DESIGN: '鈴木',
    REVIEW: '山本 / お客様',
    PRODUCTION: '外注・三浦',
    BILLING: '山本',
    DONE: '',
  },

  async init() {
    document.getElementById('ops-include-done').addEventListener('change', () => this.load());
    document.getElementById('ops-rough-input').addEventListener('change', (e) => this.uploadRough(e));
    await this.load();
  },

  async load() {
    const includeDone = document.getElementById('ops-include-done').checked;
    try {
      const res = await fetch(`/api/ops/board?include_done=${includeDone ? '1' : '0'}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '読み込みに失敗しました');
      this.data = json;
      this.renderToday();
      this.renderPipeline();
    } catch (err) {
      HiUI.toast(err.message || 'ボードの読み込みに失敗しました', 'error');
      document.getElementById('ops-today').innerHTML =
        '<p class="empty-notice">読み込みに失敗しました。画面を開き直してください。</p>';
    }
  },

  // ===== 今日やること =====
  renderToday() {
    const container = document.getElementById('ops-today');
    const rows = this.data.today || [];
    if (!rows.length) {
      container.innerHTML = '<p class="empty-notice">いま手を動かす案件はありません。</p>';
      return;
    }
    container.innerHTML = rows.map(c => `
      <div class="ops-today-row">
        ${this.badgeHtml(c)}
        <div class="ops-today-main">
          <div class="ops-today-title">${this.esc(c.project_name)}</div>
          <div class="ops-today-reason">${this.esc(c.customer_name)}／${this.esc(c.reason.label)}</div>
        </div>
        <div class="ops-card-meta">
          <span class="${this.deadlineClass(c.deadline)}">納期 ${this.esc(c.deadline || '未設定')}</span>
        </div>
        <button type="button" class="btn btn-secondary btn-small" data-case="${c.id}">開く</button>
      </div>
    `).join('');
    container.querySelectorAll('button[data-case]').forEach(btn => {
      btn.addEventListener('click', () => this.openCaseModal(Number(btn.dataset.case)));
    });
  },

  // ===== パイプライン =====
  renderPipeline() {
    const includeDone = document.getElementById('ops-include-done').checked;
    const stages = this.data.stages.filter(st => includeDone || st.key !== 'DONE');
    const container = document.getElementById('ops-pipeline');
    container.classList.toggle('with-done', includeDone);

    container.innerHTML = stages.map(stage => {
      const cards = this.data.cases.filter(c => c.ops_stage === stage.key);
      const body = cards.length
        ? cards.map(c => this.cardHtml(c)).join('')
        : '<p class="empty-notice">なし</p>';
      return `
        <div class="ops-column">
          <div class="ops-column-head">${this.esc(stage.label)}（${cards.length}）</div>
          <div class="ops-column-owner">${this.esc(this.STAGE_OWNER[stage.key] || '')}</div>
          ${body}
        </div>
      `;
    }).join('');

    container.querySelectorAll('.ops-card').forEach(card => {
      card.addEventListener('click', () => this.openCaseModal(Number(card.dataset.case)));
    });
  },

  cardHtml(c) {
    const stale = this.isStale(c);
    const days = c.days_in_stage;
    return `
      <button type="button" class="ops-card" data-case="${c.id}">
        <div class="ops-card-name">${this.esc(c.project_name)}</div>
        <div class="ops-card-customer">${this.esc(c.customer_name)}</div>
        <div class="ops-card-meta">
          <span class="${this.deadlineClass(c.deadline)}">納期 ${this.esc(c.deadline || '未設定')}</span>
          ${days !== null ? `<span class="${stale ? 'is-stale' : ''}">${days}日経過</span>` : ''}
          ${c.rough_count ? `<span>ラフ${c.rough_count}件</span>` : ''}
        </div>
        ${c.ops_stage === 'REVIEW' ? `<div style="margin-top:6px;">${this.badgeHtml(c)}</div>` : ''}
      </button>
    `;
  },

  // 確認段階の待ち先バッジ。それ以外の段階は段階名を出す
  badgeHtml(c) {
    if (c.ops_stage === 'REVIEW') {
      return c.ops_wait_on === 'CUSTOMER'
        ? `<span class="ops-badge ${this.isStale(c) ? 'ops-badge-alert' : 'ops-badge-review-customer'}">お客様の返事待ち</span>`
        : '<span class="ops-badge ops-badge-review-self">山本さんの番</span>';
    }
    const cls = {
      BRIEF: 'ops-badge-brief', DESIGN: 'ops-badge-design',
      PRODUCTION: 'ops-badge-production', BILLING: 'ops-badge-billing', DONE: 'ops-badge-done',
    }[c.ops_stage] || 'ops-badge-done';
    const label = (this.data.stages.find(s => s.key === c.ops_stage) || {}).label || c.ops_stage;
    return `<span class="ops-badge ${cls}">${this.esc(label)}</span>`;
  },

  // お客様の返事待ちが既定日数を超えたか
  isStale(c) {
    return c.ops_stage === 'REVIEW' && c.ops_wait_on === 'CUSTOMER'
      && c.days_in_stage !== null && c.days_in_stage >= this.data.remind_days;
  },

  deadlineClass(deadline) {
    if (!deadline) return '';
    return deadline < formatDateISO() ? 'is-overdue' : '';
  },

  // ===== 案件モーダル =====
  openCaseModal(caseId) {
    const c = this.data.cases.find(x => x.id === caseId);
    if (!c) return;
    this.currentCaseId = caseId;

    document.getElementById('ops-modal-title').textContent = c.project_name;
    document.getElementById('ops-modal-summary').textContent =
      `${c.customer_name}／納期 ${c.deadline || '未設定'}${c.days_in_stage !== null ? `／この段階に入って${c.days_in_stage}日` : ''}`;

    // 段階の切り替えボタン
    document.getElementById('ops-stage-picker').innerHTML = this.data.stages.map(st => `
      <button type="button" class="btn btn-small ${st.key === c.ops_stage ? 'btn-primary' : 'btn-secondary'}"
        data-stage="${st.key}">${this.esc(st.label)}</button>
    `).join('');
    document.getElementById('ops-stage-picker').querySelectorAll('button[data-stage]').forEach(btn => {
      btn.addEventListener('click', () => this.setStage(btn.dataset.stage));
    });

    // 確認段階のときだけ待ち先を出す
    const waitGroup = document.getElementById('ops-wait-group');
    waitGroup.hidden = c.ops_stage !== 'REVIEW';
    if (c.ops_stage === 'REVIEW') {
      const options = [
        { key: 'YAMAMOTO', label: '山本さんが確認中' },
        { key: 'CUSTOMER', label: 'お客様の返事待ち' },
      ];
      document.getElementById('ops-wait-picker').innerHTML = options.map(o => `
        <button type="button" class="btn btn-small ${o.key === c.ops_wait_on ? 'btn-primary' : 'btn-secondary'}"
          data-wait="${o.key}">${o.label}</button>
      `).join('');
      document.getElementById('ops-wait-picker').querySelectorAll('button[data-wait]').forEach(btn => {
        btn.addEventListener('click', () => this.setStage('REVIEW', btn.dataset.wait));
      });
      document.getElementById('ops-wait-hint').textContent =
        `お客様へ送ったら「お客様の返事待ち」に切り替えてください。返事がないまま${this.data.remind_days}日を過ぎると、今日やることへ催促として戻ります。`;
    }

    this.loadRough(caseId);
    document.getElementById('ops-case-modal').style.display = 'flex';
  },

  closeCaseModal() {
    document.getElementById('ops-case-modal').style.display = 'none';
    this.currentCaseId = null;
  },

  openCaseDetail() {
    if (this.currentCaseId) CaseDetail.open(this.currentCaseId);
  },

  async setStage(stage, waitOn) {
    try {
      const res = await fetch(`/api/ops/cases/${this.currentCaseId}/stage`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage, wait_on: waitOn || null }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '更新に失敗しました');
      HiUI.toast('段階を変更しました');
      const caseId = this.currentCaseId;
      await this.load();
      this.openCaseModal(caseId);
    } catch (err) {
      HiUI.toast(err.message || '更新に失敗しました', 'error');
    }
  },

  // ===== デザインラフ =====
  async loadRough(caseId) {
    const list = document.getElementById('ops-rough-list');
    list.innerHTML = '<p class="folder-loading">読み込み中…</p>';
    try {
      const res = await fetch(`/api/ops/cases/${caseId}/rough`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      if (!json.files.length) {
        list.innerHTML = '<p class="empty-notice">まだ添付がありません。</p>';
        return;
      }
      list.innerHTML = json.files.map(f => {
        const url = `/api/ops/rough/${f.id}/file`;
        const isImage = (f.mime_type || '').startsWith('image/');
        return `
          <div class="ops-rough-item">
            ${isImage ? `<img class="ops-rough-thumb" src="${url}" alt="">` : '<span>📄</span>'}
            <a href="${url}" target="_blank" rel="noopener">${this.esc(f.original_name)}</a>
            <button type="button" class="btn btn-danger-soft btn-small" data-file="${f.id}">削除</button>
          </div>
        `;
      }).join('');
      list.querySelectorAll('button[data-file]').forEach(btn => {
        btn.addEventListener('click', () => this.deleteRough(Number(btn.dataset.file)));
      });
    } catch (err) {
      list.innerHTML = '<p class="empty-notice">添付の読み込みに失敗しました。</p>';
    }
  },

  async uploadRough(event) {
    const input = event.target;
    if (!input.files.length || !this.currentCaseId) return;
    const form = new FormData();
    Array.from(input.files).forEach(f => form.append('files', f));
    try {
      const res = await fetch(`/api/ops/cases/${this.currentCaseId}/rough`, { method: 'POST', body: form });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'アップロードに失敗しました');
      HiUI.toast('ラフを添付しました');
      input.value = '';
      await this.loadRough(this.currentCaseId);
      await this.load();
    } catch (err) {
      HiUI.toast(err.message || 'アップロードに失敗しました', 'error');
      input.value = '';
    }
  },

  async deleteRough(fileId) {
    if (!confirm('この添付を削除します。よろしいですか?')) return;
    try {
      const res = await fetch(`/api/ops/rough/${fileId}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '削除に失敗しました');
      HiUI.toast('削除しました');
      await this.loadRough(this.currentCaseId);
      await this.load();
    } catch (err) {
      HiUI.toast(err.message || '削除に失敗しました', 'error');
    }
  },

  esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
};

document.addEventListener('DOMContentLoaded', () => opsBoardApp.init());
