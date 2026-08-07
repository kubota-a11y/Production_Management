// デザイン案件全般ボード(/ops)。案件が「いま誰待ちで止まっているか」を7段階で管理する。
// 段階の定義とサーバー側の自動遷移は lib/ops-board.js を参照。
// 段階の移動はカードのドラッグ&ドロップ、またはカードを開いてボタンで行う。

const opsBoardApp = {
  data: null,
  currentCaseId: null,
  draggingCaseId: null,

  // Web注文フォーム由来の案件は case_items にカテゴリのコードが入っているので、
  // アイテム名が未入力のときの表示用にここで日本語へ直す(lib/order-intake.js と同じ対応)
  CATEGORY_LABEL: {
    tshirt: 'Tシャツ', polo: 'ポロシャツ', sweat: 'トレーナー', hoodie: 'パーカー',
    zip_hoodie: 'ジップアップパーカー', pants: 'パンツ', cap: '帽子', bag: 'バッグ',
    workwear: '作業着', other: 'その他',
  },

  // カードに出すアイテム名。①手入力のアイテム名 → ②注文フォームのアイテム情報 の順に使う
  itemLabel(c) {
    if (c.item_name) return c.item_name;
    if (!c.first_item_category) return '';
    const label = this.CATEGORY_LABEL[c.first_item_category] || c.first_item_category;
    const more = c.item_count > 1 ? ` ほか${c.item_count - 1}点` : '';
    return label + more;
  },

  // 各段階の主担当。カード列の副題に出す
  STAGE_OWNER: {
    BRIEF: '山本',
    DESIGN: '鈴木',
    REVIEW: '山本 / お客様',
    PRODUCTION: '外注・三浦（📄は鈴木）',
    BILLING: '山本',
    INSPECTION: '三浦・渡邉',
    DELIVERY: '山本',
    DONE: '',
  },

  async init() {
    document.getElementById('ops-include-done').addEventListener('change', () => this.load());
    document.getElementById('ops-rough-input').addEventListener('change', (e) => this.uploadRough(e));
    // 製造の準備項目マスター。入稿・製造に入った案件のカードから選定するために使う
    try {
      this.prepMaster = await API.getPreparationItemsMaster();
    } catch (err) {
      this.prepMaster = [];
      console.error('準備項目マスター取得エラー:', err);
    }
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
      <button type="button" class="ops-today-card${this.isCarve(c) ? ' is-carve' : ''}" data-case="${c.id}">
        <div class="ops-today-card-head">
          <span>${this.badgeHtml(c)}${this.isSubmitEnd(c) ? ' ' + this.flowBadgeHtml(c) : ''}</span>
          <span class="ops-today-deadline ${this.deadlineClass(c.deadline)}">納期 ${this.esc(c.deadline || '未設定')}</span>
        </div>
        <div class="ops-today-title">${this.esc(c.project_name)}</div>
        <div class="ops-today-customer">${this.esc(c.customer_name)}</div>
        ${this.itemLabel(c) ? `<div class="ops-item-name">🏷 ${this.esc(this.itemLabel(c))}</div>` : ''}
        <div class="ops-today-reason">${this.esc(c.reason.label)}</div>
      </button>
    `).join('');
    container.querySelectorAll('.ops-today-card').forEach(card => {
      card.addEventListener('click', () => this.openCaseModal(Number(card.dataset.case)));
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
        <div class="ops-column" data-stage="${stage.key}">
          <div class="ops-column-head">${this.esc(stage.label)}（${cards.length}）</div>
          <div class="ops-column-owner">${this.esc(this.STAGE_OWNER[stage.key] || '')}</div>
          <div class="ops-column-body">${body}</div>
        </div>
      `;
    }).join('');

    this.bindCardEvents(container);
    this.bindDropTargets(container);
  },

  // カードのクリック・ドラッグ開始・完了チェックを結び付ける
  bindCardEvents(container) {
    container.querySelectorAll('.ops-card').forEach(card => {
      const caseId = Number(card.dataset.case);

      card.addEventListener('click', (e) => {
        // 完了チェック・外すボタンを押したときはカードを開かない
        if (e.target.closest('.ops-card-done') || e.target.closest('.ops-card-remove')) return;
        this.openCaseModal(caseId);
      });

      card.addEventListener('dragstart', (e) => {
        this.draggingCaseId = caseId;
        card.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Firefox はデータをセットしないとドラッグが始まらない
        e.dataTransfer.setData('text/plain', String(caseId));
      });
      card.addEventListener('dragend', () => {
        this.draggingCaseId = null;
        card.classList.remove('is-dragging');
        container.querySelectorAll('.ops-column').forEach(col => col.classList.remove('is-drop-target'));
      });
    });

    // 納品段階のカードにある「完了にする」チェック
    container.querySelectorAll('.ops-card-done input').forEach(input => {
      input.addEventListener('change', () => {
        this.setStageFor(Number(input.dataset.case), 'DONE');
      });
    });

    // カード右上の「✕」= このボードから外す
    container.querySelectorAll('.ops-card-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeFromBoard(Number(btn.dataset.remove));
      });
    });
  },

  // ボードの対象から外す。案件そのものは消さないことを確認文で明示する
  async removeFromBoard(caseId) {
    const c = this.data.cases.find(x => x.id === caseId);
    const name = c ? c.project_name : 'この案件';
    if (!confirm(`「${name}」をこのボードから外します。\n\n案件そのものは消えません（一覧ビューには残ります）。\n戻したいときは案件の「編集」で「デザイン案件全般として管理する」にチェックを入れてください。`)) return;

    try {
      const res = await fetch(`/api/ops/cases/${caseId}/membership`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ include: false }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '更新に失敗しました');
      HiUI.toast(`「${json.project_name}」をボードから外しました`);
      await this.load();
    } catch (err) {
      HiUI.toast(err.message || 'ボードから外せませんでした', 'error');
    }
  },

  // 列へのドロップで段階を変更する。前にも後ろにも動かせる(差し戻しも同じ操作)
  bindDropTargets(container) {
    container.querySelectorAll('.ops-column').forEach(col => {
      col.addEventListener('dragover', (e) => {
        if (this.draggingCaseId === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        col.classList.add('is-drop-target');
      });
      col.addEventListener('dragleave', (e) => {
        // 子要素へ移っただけのときは外さない
        if (!col.contains(e.relatedTarget)) col.classList.remove('is-drop-target');
      });
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('is-drop-target');
        const caseId = this.draggingCaseId ?? Number(e.dataTransfer.getData('text/plain'));
        this.draggingCaseId = null;
        if (!caseId) return;
        const target = col.dataset.stage;
        const current = (this.data.cases.find(c => c.id === caseId) || {}).ops_stage;
        if (!target || target === current) return;
        this.setStageFor(caseId, target);
      });
    });
  },

  // 紙媒体(入稿で完了)タイプかどうか
  isSubmitEnd(c) {
    return c.ops_flow === 'SUBMIT_END';
  },

  // 鈴木さんがCARVEで受けている紙媒体か(イレギュラー案件としてカードを目立たせる)
  isCarve(c) {
    return this.isSubmitEnd(c) && c.paper_source === 'CARVE';
  },

  // 紙媒体案件の工程ごとの納期(初校 / 入稿)。どちらも未設定なら出さない
  paperDueHtml(c) {
    if (!this.isSubmitEnd(c)) return '';
    const parts = [];
    if (c.first_draft_due) parts.push(`初校 ${this.esc(c.first_draft_due)}`);
    if (c.submission_due) parts.push(`入稿 ${this.esc(c.submission_due)}`);
    if (!parts.length) return '';
    return `<div class="ops-card-meta ops-card-due">${parts.map(p => `<span>${p}</span>`).join('')}</div>`;
  },

  // CARVE案件の作業段階(ラフアップ→写真入れアップ→修正アップ→入稿)。サーバーから受け取る
  carveStage(key) {
    const stages = (this.data && this.data.carve_stages) || [];
    return stages.find(s => s.key === key) || stages[0] || { key: 'ROUGH', label: 'ラフアップ' };
  },

  // 紙媒体案件のバッジ。CARVE案件は出どころ+いまの作業段階が分かるように別表示にする
  flowBadgeHtml(c) {
    if (!this.isSubmitEnd(c)) return '';
    return this.isCarve(c)
      ? `<span class="ops-badge ops-badge-carve">🔶 CARVE・${this.esc(this.carveStage(c.carve_stage).label)}</span>`
      : '<span class="ops-badge ops-badge-paper">📄 入稿で完了</span>';
  },

  // 製造(三浦さん管轄)の準備項目がまだ選ばれていない「入稿・製造」以降の案件か。
  // デザイン案件全般は登録時に準備項目を選ばない運用のため、ここで選定を促す
  // (紙媒体は鈴木さんが入稿して終わるので対象外)
  needsPrepSelect(c) {
    return c.ops_stage === 'PRODUCTION' && !this.isSubmitEnd(c) && !c.mfg_prep_count;
  },

  // 製造の準備項目を選べる段階か(入稿・製造〜納品の間は追加できる)
  canSelectPrep(c) {
    return !this.isSubmitEnd(c)
      && ['PRODUCTION', 'BILLING', 'INSPECTION', 'DELIVERY'].includes(c.ops_stage);
  },

  cardHtml(c) {
    const stale = this.isStale(c);
    const days = c.days_in_stage;
    // 最終段階まで来た案件は、カード上のチェックだけで完了にできるようにする。
    // 標準タイプは納品で、紙媒体(入稿で完了)タイプは請求で終わる
    let doneCheck = '';
    if (c.ops_stage === 'DELIVERY') {
      doneCheck = `<label class="ops-card-done"><input type="checkbox" data-case="${c.id}"> 納品済み・完了にする</label>`;
    } else if (c.ops_stage === 'BILLING' && this.isSubmitEnd(c)) {
      doneCheck = `<label class="ops-card-done"><input type="checkbox" data-case="${c.id}"> 請求済み・完了にする</label>`;
    }
    return `
      <div class="ops-card${this.isCarve(c) ? ' is-carve' : ''}" draggable="true" data-case="${c.id}" tabindex="0" role="button">
        <button type="button" class="btn-icon-remove ops-card-remove" data-remove="${c.id}"
          title="この案件をボードから外す（案件そのものは消えません）"
          aria-label="${this.esc(c.project_name)} をボードから外す">✕</button>
        <div class="ops-card-name">${this.esc(c.project_name)}</div>
        <div class="ops-card-customer">${this.esc(c.customer_name)}</div>
        ${this.itemLabel(c) ? `<div class="ops-item-name">🏷 ${this.esc(this.itemLabel(c))}</div>` : ''}
        <div class="ops-card-meta">
          <span class="${this.deadlineClass(c.deadline)}">納期 ${this.esc(c.deadline || '未設定')}</span>
          ${days !== null ? `<span class="${stale ? 'is-stale' : ''}">${days}日経過</span>` : ''}
          ${c.rough_count ? `<span>ラフ${c.rough_count}件</span>` : ''}
          ${this.flowBadgeHtml(c)}
          ${c.design_revision_round ? `<span class="ops-badge ops-badge-revision">🔁 修正${c.design_revision_round}回目</span>` : ''}
          ${this.needsPrepSelect(c) ? '<span class="ops-badge ops-badge-alert">⚠️ 準備項目 未選定</span>' : ''}
        </div>
        ${this.paperDueHtml(c)}
        ${c.ops_stage === 'REVIEW' ? `<div class="ops-card-badge-row">${this.badgeHtml(c)}</div>` : ''}
        ${doneCheck}
      </div>
    `;
  },

  // 確認段階のステップ定義(サーバーから受け取る)。順番どおりに進む
  reviewStep(key) {
    const steps = (this.data && this.data.review_steps) || [];
    return steps.find(s => s.key === key) || steps[0] || { key: 'SEND', label: '確認', ball: 'US' };
  },

  // 確認段階はいまどのステップかをバッジに出す。それ以外の段階は段階名を出す
  badgeHtml(c) {
    if (c.ops_stage === 'REVIEW') {
      const step = this.reviewStep(c.ops_wait_on);
      if (step.ball === 'CUSTOMER') {
        const cls = this.isStale(c) ? 'ops-badge-alert' : 'ops-badge-review-customer';
        return `<span class="ops-badge ${cls}">${this.esc(step.label)}</span>`;
      }
      return `<span class="ops-badge ops-badge-review-self">${this.esc(step.label)}</span>`;
    }
    const cls = {
      BRIEF: 'ops-badge-brief', DESIGN: 'ops-badge-design',
      PRODUCTION: 'ops-badge-production', BILLING: 'ops-badge-billing',
      INSPECTION: 'ops-badge-inspection', DELIVERY: 'ops-badge-delivery', DONE: 'ops-badge-done',
    }[c.ops_stage] || 'ops-badge-done';
    const label = (this.data.stages.find(s => s.key === c.ops_stage) || {}).label || c.ops_stage;
    return `<span class="ops-badge ${cls}">${this.esc(label)}</span>`;
  },

  // お客様の返事待ちのまま既定日数を超えたか
  isStale(c) {
    return c.ops_stage === 'REVIEW' && this.reviewStep(c.ops_wait_on).ball === 'CUSTOMER'
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
    const item = this.itemLabel(c);
    const flow = this.isCarve(c)
      ? `🔶 CARVE案件(${this.carveStage(c.carve_stage).label})`
      : (this.isSubmitEnd(c) ? '📄 入稿で完了' : '');
    document.getElementById('ops-modal-summary').textContent =
      `${c.customer_name}${item ? `／${item}` : ''}${flow ? `／${flow}` : ''}／納期 ${c.deadline || '未設定'}`
      + `${c.days_in_stage !== null ? `／この段階に入って${c.days_in_stage}日` : ''}`
      + `${c.design_revision_round ? `／🔁 修正${c.design_revision_round}回目` : ''}`;

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
      const steps = this.data.review_steps || [];
      const currentIndex = steps.findIndex(s => s.key === c.ops_wait_on);
      // 実際のやりとりの順番に並べ、済んだところまで進めていく
      document.getElementById('ops-wait-picker').innerHTML = steps.map((s, i) => `
        <button type="button" class="btn btn-small ${s.key === c.ops_wait_on ? 'btn-primary' : 'btn-secondary'}"
          data-wait="${s.key}">${i + 1}. ${this.esc(s.label)}</button>
      `).join('');
      document.getElementById('ops-wait-picker').querySelectorAll('button[data-wait]').forEach(btn => {
        btn.addEventListener('click', () => this.setStage('REVIEW', btn.dataset.wait));
      });

      // 最後のステップまで来ていたら、次は入稿・製造へ進む案内を出す
      const isLast = currentIndex === steps.length - 1;
      document.getElementById('ops-wait-hint').textContent = isLast
        ? `お客様からOKをもらったら「入稿・製造」へ進めてください。返事がないまま${this.data.remind_days}日を過ぎると、今日やることへ催促として戻ります。`
        : `やりとりが進んだら次のステップへ切り替えてください。お客様の返事待ちのまま${this.data.remind_days}日を過ぎると、今日やることへ催促として戻ります。`;
    }

    // 確認段階のときだけ「修正で鈴木さんへ戻す」を出す(修正指示を受けたときの1クリック操作)
    const revisionGroup = document.getElementById('ops-revision-group');
    revisionGroup.hidden = c.ops_stage !== 'REVIEW';
    document.getElementById('ops-revision-note').value = '';
    const revisionInfo = document.getElementById('ops-revision-info');
    revisionInfo.textContent = c.design_revision_round && c.design_revision_note
      ? `直近の指示(${c.design_revision_round}回目): ${c.design_revision_note}`
      : '';
    revisionInfo.style.display = revisionInfo.textContent ? '' : 'none';

    // CARVE案件のときだけ作業段階の切り替えを出す
    const carveGroup = document.getElementById('ops-carve-group');
    carveGroup.hidden = !this.isCarve(c);
    if (this.isCarve(c)) {
      const stages = this.data.carve_stages || [];
      document.getElementById('ops-carve-picker').innerHTML = stages.map((s, i) => `
        <button type="button" class="btn btn-small ${s.key === c.carve_stage ? 'btn-primary' : 'btn-secondary'}"
          data-carve="${s.key}">${i + 1}. ${this.esc(s.label)}</button>
      `).join('');
      document.getElementById('ops-carve-picker').querySelectorAll('button[data-carve]').forEach(btn => {
        btn.addEventListener('click', () => this.setCarveStage(btn.dataset.carve));
      });
    }

    // 入稿・製造以降の(紙媒体でない)案件には、製造の準備項目の選定欄を出す
    const prepGroup = document.getElementById('ops-prep-group');
    prepGroup.hidden = !this.canSelectPrep(c);
    if (this.canSelectPrep(c)) this.loadPrepSelection(caseId);

    this.loadRough(caseId);
    document.getElementById('ops-case-modal').style.display = 'flex';
  },

  // お客様の修正指示で鈴木さんへ戻す。段階を「制作」へ戻し、初校提出のチェックを外し、
  // 修正回数+1・校正バッジ「修正」までまとめてサーバー側が行う(バトンタッチ通知も自動)
  async returnForRevision() {
    const caseId = this.currentCaseId;
    const c = this.data.cases.find(x => x.id === caseId);
    if (!c) return;
    const note = document.getElementById('ops-revision-note').value.trim();
    const round = (c.design_revision_round || 0) + 1;
    if (!confirm(`「${c.project_name}」を修正${round}回目として鈴木さんへ戻します。\n\n・段階が「制作」に戻ります\n・「初校提出」の完了チェックが外れ、マイスケジュールに再び出ます${note ? '\n・修正指示メモも鈴木さんのカードに表示されます' : ''}`)) return;
    try {
      const res = await fetch(`/api/ops/cases/${caseId}/return-for-revision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '更新に失敗しました');
      HiUI.toast(`修正${json.design_revision_round}回目として鈴木さんへ戻しました`);
      await this.load();
      this.openCaseModal(caseId);
    } catch (err) {
      HiUI.toast(err.message || '修正戻しに失敗しました', 'error');
    }
  },

  // CARVE案件の作業段階を切り替える。変更後もモーダルを開いたままにする
  async setCarveStage(stage) {
    const caseId = this.currentCaseId;
    try {
      const res = await fetch(`/api/ops/cases/${caseId}/carve-stage`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '更新に失敗しました');
      HiUI.toast(`CARVEの作業段階を「${this.carveStage(stage).label}」にしました`);
      await this.load();
      this.openCaseModal(caseId);
    } catch (err) {
      HiUI.toast(err.message || '更新に失敗しました', 'error');
    }
  },

  // ===== 製造の準備項目の選定 =====
  // デザイン案件全般は登録時に準備項目を選ばないため、製造のターンに入ってからここで選ぶ。
  // 既に登録済みの項目は一覧表示し、未登録の製造系項目だけをチェックボックスに出す
  async loadPrepSelection(caseId) {
    const registeredBox = document.getElementById('ops-prep-registered');
    const choicesBox = document.getElementById('ops-prep-choices');
    const addBtn = document.getElementById('ops-prep-add-btn');
    registeredBox.innerHTML = '<p class="folder-loading">読み込み中…</p>';
    choicesBox.innerHTML = '';
    addBtn.style.display = 'none';
    try {
      const items = await API.getPreparationItems({ case_id: caseId });
      const registeredIds = new Set(items.map(i => i.preparation_item_id));
      // 製造系の項目 = デザイナー専用でなく、デザインラフ作成でもないもの
      const mfgMaster = (this.prepMaster || [])
        .filter(m => !m.is_designer_item && m.code !== 'DESIGN_ROUGH');

      const registered = mfgMaster.filter(m => registeredIds.has(m.id));
      registeredBox.innerHTML = registered.length
        ? `<p class="ops-prep-registered-list">登録済み: ${registered.map(m => this.esc(m.name)).join('・')}</p>`
        : '<p class="empty-notice">製造の準備項目はまだ選ばれていません。必要な項目にチェックして登録してください。</p>';

      const choices = mfgMaster.filter(m => !registeredIds.has(m.id));
      choicesBox.innerHTML = choices.map(m => `
        <label class="checkbox-pill"><input type="checkbox" name="ops_prep_item" value="${m.id}"> ${this.esc(m.name)}</label>
      `).join('');
      addBtn.style.display = choices.length ? '' : 'none';
    } catch (err) {
      registeredBox.innerHTML = '<p class="empty-notice">準備項目の読み込みに失敗しました。</p>';
    }
  },

  async registerPrepItems() {
    const caseId = this.currentCaseId;
    const checked = Array.from(
      document.querySelectorAll('#ops-prep-choices input[name="ops_prep_item"]:checked')
    ).map(el => Number(el.value));
    if (!checked.length) {
      HiUI.toast('登録する準備項目にチェックを入れてください', 'error');
      return;
    }
    try {
      await API.registerCasePreparationItems(caseId, checked);
      HiUI.toast(`準備項目を${checked.length}件登録しました`);
      await this.load();
      this.openCaseModal(caseId);
    } catch (err) {
      HiUI.toast('準備項目の登録に失敗しました', 'error');
    }
  },

  closeCaseModal() {
    document.getElementById('ops-case-modal').style.display = 'none';
    this.currentCaseId = null;
  },

  openCaseDetail() {
    if (this.currentCaseId) CaseDetail.open(this.currentCaseId);
  },

  // 案件の編集。フォームを複製すると二重メンテになるので、HiBoardの編集モーダルを
  // 開いて使ってもらい、保存後にこの画面へ戻す(新規案件ボタンと同じ仕組み)
  editCase() {
    if (!this.currentCaseId) return;
    window.location.href = `/?open=edit-project&id=${this.currentCaseId}&return=/ops`;
  },

  // モーダルの段階ボタンから呼ぶ。変更後もモーダルを開いたままにする
  async setStage(stage, waitOn) {
    const caseId = this.currentCaseId;
    if (await this.setStageFor(caseId, stage, waitOn)) this.openCaseModal(caseId);
  },

  // ドラッグ&ドロップ・完了チェック・モーダルの共通処理
  async setStageFor(caseId, stage, waitOn) {
    try {
      const res = await fetch(`/api/ops/cases/${caseId}/stage`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage, wait_on: waitOn || null }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '更新に失敗しました');
      const label = (this.data.stages.find(s => s.key === stage) || {}).label || stage;
      HiUI.toast(stage === 'DONE' ? '完了にしました' : `「${label}」へ移動しました`);
      await this.load();
      return true;
    } catch (err) {
      HiUI.toast(err.message || '更新に失敗しました', 'error');
      await this.load();  // 失敗したらカードを元の列へ戻す
      return false;
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
