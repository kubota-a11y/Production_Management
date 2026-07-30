// ========================================
// 顧客台帳ページ ロジック
// 顧客マスタは持たず、案件データ(projects.customer_name)から顧客一覧を自動生成する。
// 顧客詳細では全案件履歴と顧客メモ(customer_notes)を扱う
// ========================================

const customersApp = {
  // ===== ステート =====
  customers: [],
  searchQuery: '',
  sortKey: 'default',      // default(APIの直近やりとり順) / project_count / total_quantity / last_delivered_date
  sortOrder: 'desc',       // desc=多い順(新しい順) / asc=少ない順(古い順)
  processFilter: '',       // 加工種別コード。空文字はすべて
  currentCustomer: null,
  projects: [],
  duplicateSource: null,

  // ===== 初期化 =====
  async init() {
    console.log('🚀 顧客台帳ページ初期化中...');
    await this.loadCustomers();
    this.renderList();
    this.setupEvents();
    console.log('✓ 初期化完了');
  },

  async loadCustomers() {
    try {
      this.customers = await API.getCustomers();
    } catch (error) {
      console.error('顧客一覧取得エラー:', error);
      HiUI.toast('顧客一覧の取得に失敗しました');
    }
  },

  setupEvents() {
    document.getElementById('customer-search').addEventListener('input', (e) => {
      this.searchQuery = e.target.value.trim();
      this.renderList();
    });

    document.getElementById('customer-sort-key').addEventListener('change', (e) => {
      this.sortKey = e.target.value;
      this.renderList();
    });

    document.getElementById('customer-sort-order').addEventListener('change', (e) => {
      this.sortOrder = e.target.value;
      this.renderList();
    });

    document.getElementById('customer-process-filter').addEventListener('change', (e) => {
      this.processFilter = e.target.value;
      this.renderList();
    });

    document.getElementById('customer-note-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveNote();
    });

    document.getElementById('duplicate-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitDuplicate();
    });
  },

  // ===== 顧客一覧(検索・加工種別の絞り込み → 並び替え) =====
  filteredCustomers() {
    let list = this.customers;

    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      list = list.filter(c => (c.customer_name || '').toLowerCase().includes(q));
    }

    if (this.processFilter) {
      // process_types はその顧客の全案件の加工種別CSVをGROUP_CONCATしたもの
      list = list.filter(c => this.processTypeCodes(c.process_types).includes(this.processFilter));
    }

    return this.sortCustomers(list);
  },

  processTypeCodes(processTypesCsv) {
    return (processTypesCsv || '').split(',').map(v => v.trim()).filter(Boolean);
  },

  sortCustomers(list) {
    const sorted = [...list];
    // asc(少ない順/古い順)は小さい値を先頭に、desc(多い順/新しい順)は大きい値を先頭にする
    const dir = this.sortOrder === 'asc' ? 1 : -1;
    const compare = (av, bv) => (av < bv ? -1 : 1) * dir;

    if (this.sortKey === 'default') {
      // APIは「最近やりとりした順」で返すので、少ない順(古い順)を選んだときだけ反転する
      return this.sortOrder === 'asc' ? sorted.reverse() : sorted;
    }

    if (this.sortKey === 'last_delivered_date') {
      // 未納品の顧客は日付を持たないため、昇順・降順どちらでも末尾にまとめる
      return sorted.sort((a, b) => {
        const av = a.last_delivered_date;
        const bv = b.last_delivered_date;
        if (!av && !bv) return a.customer_name.localeCompare(b.customer_name, 'ja');
        if (!av) return 1;
        if (!bv) return -1;
        if (av === bv) return a.customer_name.localeCompare(b.customer_name, 'ja');
        return compare(av, bv);
      });
    }

    return sorted.sort((a, b) => {
      const av = a[this.sortKey] || 0;
      const bv = b[this.sortKey] || 0;
      if (av === bv) return a.customer_name.localeCompare(b.customer_name, 'ja');
      return compare(av, bv);
    });
  },

  resetFilters() {
    this.searchQuery = '';
    this.sortKey = 'default';
    this.sortOrder = 'desc';
    this.processFilter = '';
    document.getElementById('customer-search').value = '';
    document.getElementById('customer-sort-key').value = 'default';
    document.getElementById('customer-sort-order').value = 'desc';
    document.getElementById('customer-process-filter').value = '';
    this.renderList();
  },

  // GROUP_CONCATされた加工種別CSV(重複あり)を、重複を除いた日本語ラベルにする
  processTypeSummary(processTypesCsv) {
    const codes = [...new Set((processTypesCsv || '').split(',').map(v => v.trim()).filter(Boolean))];
    return codes.map(getProcessLabel).join('・');
  },

  renderList() {
    const tbody = document.getElementById('customer-tbody');
    tbody.innerHTML = '';

    const customers = this.filteredCustomers();
    const isNarrowed = Boolean(this.searchQuery || this.processFilter);
    const countEl = document.getElementById('customer-search-count');
    countEl.textContent = isNarrowed
      ? `${customers.length}件ヒット(全${this.customers.length}顧客)`
      : `全${this.customers.length}顧客`;

    if (customers.length === 0) {
      const message = isNarrowed ? '条件に合う顧客はありません' : '顧客データはまだありません(案件を登録すると自動で一覧に載ります)';
      tbody.innerHTML = `<tr><td colspan="8" class="empty-notice">${message}</td></tr>`;
      return;
    }

    customers.forEach(customer => {
      const row = document.createElement('tr');
      row.className = 'customer-row';
      row.title = 'クリックで案件履歴と顧客メモを開く';
      row.innerHTML = `
        <td><strong>${this.escapeHtml(customer.customer_name)}</strong></td>
        <td>${customer.project_count}</td>
        <td>${customer.delivered_count}</td>
        <td>${customer.total_quantity ?? '-'}</td>
        <td>${formatDate(customer.first_received_date)}</td>
        <td>${customer.last_delivered_date ? formatDate(customer.last_delivered_date) : '-'}</td>
        <td>${this.escapeHtml(this.processTypeSummary(customer.process_types))}</td>
        <td>${customer.has_note ? '📝' : ''}</td>
      `;
      row.addEventListener('click', () => this.openCustomer(customer.customer_name));
      tbody.appendChild(row);
    });
  },

  // ===== 顧客詳細 =====
  async openCustomer(customerName) {
    this.currentCustomer = customerName;
    document.getElementById('detail-customer-name').textContent = customerName;
    document.getElementById('note-save-status').textContent = '';

    try {
      const [projects, note] = await Promise.all([
        API.getCustomerProjects(customerName),
        API.getCustomerNote(customerName),
      ]);
      this.projects = Array.isArray(projects) ? projects : [];
      this.renderProjects();
      this.fillNoteForm(note);
    } catch (error) {
      console.error('顧客詳細取得エラー:', error);
      HiUI.toast('顧客詳細の取得に失敗しました');
      return;
    }

    document.getElementById('customer-list-section').style.display = 'none';
    document.getElementById('customer-detail-section').style.display = 'block';
    window.scrollTo(0, 0);
  },

  backToList() {
    this.currentCustomer = null;
    document.getElementById('customer-detail-section').style.display = 'none';
    document.getElementById('customer-list-section').style.display = 'block';
    // メモ有無バッジ(📝)を最新にするため一覧を取り直す
    this.loadCustomers().then(() => this.renderList());
  },

  renderProjects() {
    const tbody = document.getElementById('customer-projects-tbody');
    tbody.innerHTML = '';

    const delivered = this.projects.filter(p => p.status === 'COMPLETED').length;
    document.getElementById('detail-customer-summary').textContent =
      `全${this.projects.length}案件(納品済み${delivered}件)`;

    if (this.projects.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-notice">案件がありません</td></tr>';
      return;
    }

    this.projects.forEach(project => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><a href="#" class="case-detail-link">${this.escapeHtml(project.project_name)}</a></td>
        <td>${formatDate(project.received_date)}</td>
        <td><span class="status-badge ${getStatusClass(project.status)}">${getStatusLabel(project.status)}</span></td>
        <td>${project.delivered_date ? formatDate(project.delivered_date) : '-'}</td>
        <td>${this.escapeHtml(getProcessLabels(project.process_type))}</td>
        <td>${project.quantity ?? '-'}</td>
        <td class="delivery-actions"></td>
      `;

      // 案件名クリックでも詳細を開けるようにする(操作列の「🔍 詳細」と同じ)
      row.querySelector('.case-detail-link').addEventListener('click', (e) => {
        e.preventDefault();
        CaseDetail.open(project.id);
      });

      const actions = row.querySelector('.delivery-actions');
      const detailBtn = document.createElement('button');
      detailBtn.className = 'btn-small';
      detailBtn.textContent = '🔍 詳細';
      detailBtn.title = '加工内容・指示書・見積書/請求書をまとめて見る';
      detailBtn.addEventListener('click', () => CaseDetail.open(project.id));
      actions.appendChild(detailBtn);

      if (project.nas_folder_path) {
        const folderBtn = document.createElement('button');
        folderBtn.className = 'btn-small';
        folderBtn.textContent = '📁 フォルダ';
        folderBtn.title = '案件フォルダの中身(指示書PDF・入稿データ等)をブラウザで見る';
        folderBtn.addEventListener('click', () =>
          NasBrowse.open(project.nas_folder_path, `${project.project_name} / ${project.customer_name}`));
        actions.appendChild(folderBtn);
      }
      if (project.freee_quote_url) {
        const quoteBtn = document.createElement('button');
        quoteBtn.className = 'btn-small';
        quoteBtn.textContent = '📄 見積書';
        quoteBtn.title = 'Freeeの見積書画面を開く';
        quoteBtn.addEventListener('click', () => window.open(project.freee_quote_url, '_blank'));
        actions.appendChild(quoteBtn);
      }
      if (project.freee_invoice_url) {
        const invoiceBtn = document.createElement('button');
        invoiceBtn.className = 'btn-small';
        invoiceBtn.textContent = '📄 請求書';
        invoiceBtn.title = 'Freeeの請求書画面を開く';
        invoiceBtn.addEventListener('click', () => window.open(project.freee_invoice_url, '_blank'));
        actions.appendChild(invoiceBtn);
      }
      if (project.status === 'COMPLETED') {
        const dupBtn = document.createElement('button');
        dupBtn.className = 'btn-small';
        dupBtn.textContent = '↻ 再注文';
        dupBtn.title = 'この案件をもとに新規案件を作成';
        dupBtn.addEventListener('click', () => this.openDuplicateModal(project));
        actions.appendChild(dupBtn);
      }

      tbody.appendChild(row);
    });
  },

  // ===== 顧客メモ =====
  fillNoteForm(note) {
    const form = document.getElementById('customer-note-form');
    form.elements['contact_person'].value = note?.contact_person || '';
    form.elements['contact_info'].value = note?.contact_info || '';
    form.elements['memo'].value = note?.memo || '';
  },

  async saveNote() {
    if (!this.currentCustomer) return;
    const form = document.getElementById('customer-note-form');
    const statusEl = document.getElementById('note-save-status');
    try {
      const result = await API.saveCustomerNote({
        customer_name: this.currentCustomer,
        contact_person: form.elements['contact_person'].value.trim(),
        contact_info: form.elements['contact_info'].value.trim(),
        memo: form.elements['memo'].value.trim(),
      });
      if (result.error) {
        HiUI.toast(`保存に失敗しました: ${result.error}`);
        return;
      }
      statusEl.textContent = '✓ 保存しました';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    } catch (error) {
      console.error('顧客メモ保存エラー:', error);
      HiUI.toast('顧客メモの保存に失敗しました');
    }
  },

  // ===== リピート注文(複製) =====
  openDuplicateModal(project) {
    this.duplicateSource = project;
    const form = document.getElementById('duplicate-form');
    form.reset();
    form.elements['project_name'].value = project.project_name || '';
    form.elements['quantity'].value = project.quantity || 1;
    document.getElementById('duplicate-source-info').textContent =
      `元案件: ${project.project_name} / ${project.customer_name}` +
      (project.delivered_date ? ` (納品日 ${formatDate(project.delivered_date)})` : '');
    document.getElementById('duplicate-modal').style.display = 'flex';
  },

  closeDuplicateModal() {
    this.duplicateSource = null;
    document.getElementById('duplicate-modal').style.display = 'none';
  },

  async submitDuplicate() {
    if (!this.duplicateSource) return;
    const form = document.getElementById('duplicate-form');
    const data = {
      project_name: form.elements['project_name'].value.trim(),
      deadline: form.elements['deadline'].value,
      quantity: parseInt(form.elements['quantity'].value, 10),
    };
    try {
      const result = await API.duplicateProject(this.duplicateSource.id, data);
      if (result.error) {
        HiUI.toast(`登録に失敗しました: ${result.error}`);
        return;
      }
      this.closeDuplicateModal();
      if (confirm('新規案件として登録しました。HiBoardの画面を開きますか?')) {
        window.location.href = '/';
      }
    } catch (error) {
      console.error('複製エラー:', error);
      HiUI.toast('登録に失敗しました');
    }
  },

  // ===== ユーティリティ =====
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  }
};

// ===== イベントリスナー =====
document.addEventListener('DOMContentLoaded', () => {
  customersApp.init();
});
