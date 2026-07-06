// ========================================
// 従業員管理ページ ロジック
// ========================================

const employeesApp = {
  // ===== ステート =====
  employees: [],
  editingEmployeeId: null,

  // ===== 初期化 =====
  async init() {
    console.log('🚀 従業員管理ページ初期化中...');
    await this.loadEmployees();
    this.renderEmployeesTable();
    console.log('✓ 初期化完了');
  },

  async loadEmployees() {
    try {
      this.employees = await API.getAllEmployees();
    } catch (error) {
      console.error('従業員取得エラー:', error);
      alert('従業員の取得に失敗しました');
    }
  },

  // ===== 一覧表示 =====
  renderEmployeesTable() {
    const tbody = document.getElementById('employees-tbody');
    tbody.innerHTML = '';

    this.employees.forEach(employee => {
      const isActive = !!employee.is_active;
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${this.escapeHtml(employee.name)}</td>
        <td>${getRoleLabel(employee.role)}</td>
        <td>
          <span class="active-badge ${isActive ? 'is-active' : 'is-inactive'}">
            ${isActive ? '有効' : '無効'}
          </span>
        </td>
        <td>
          <button class="btn-small" onclick="employeesApp.openEmployeeModal(${employee.id})">
            ✎ 編集
          </button>
          <button class="btn-small ${isActive ? 'btn-danger' : ''}" onclick="employeesApp.toggleActive(${employee.id})">
            ${isActive ? '無効にする' : '有効にする'}
          </button>
        </td>
      `;
      tbody.appendChild(row);
    });
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  },

  // ===== 追加・編集モーダル =====
  async openEmployeeModal(employeeId = null) {
    this.editingEmployeeId = employeeId;
    const modal = document.getElementById('employee-modal');
    const form = document.getElementById('employee-form');
    const title = document.getElementById('employee-modal-title');

    form.reset();

    if (employeeId) {
      title.textContent = '従業員編集';
      try {
        const employee = await API.getEmployee(employeeId);
        form.elements['name'].value = employee.name;
        form.elements['role'].value = employee.role;
        form.elements['is_active'].checked = !!employee.is_active;
      } catch (error) {
        console.error('従業員取得エラー:', error);
        alert('従業員情報の取得に失敗しました');
        return;
      }
    } else {
      title.textContent = '新規従業員';
      form.elements['is_active'].checked = true;
    }

    modal.style.display = 'flex';
  },

  closeEmployeeModal() {
    document.getElementById('employee-modal').style.display = 'none';
    this.editingEmployeeId = null;
  },

  async submitEmployeeForm(e) {
    e.preventDefault();
    const form = document.getElementById('employee-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData);
    data.is_active = form.elements['is_active'].checked;

    try {
      if (this.editingEmployeeId) {
        await API.updateEmployee(this.editingEmployeeId, data);
        console.log(`✓ 従業員 #${this.editingEmployeeId} を更新`);
      } else {
        await API.createEmployee(data);
        console.log('✓ 新規従業員を作成');
      }

      await this.loadEmployees();
      this.renderEmployeesTable();
      this.closeEmployeeModal();
    } catch (error) {
      console.error('従業員保存エラー:', error);
      alert('従業員の保存に失敗しました');
    }
  },

  // ===== 有効/無効切り替え =====
  async toggleActive(employeeId) {
    const employee = this.employees.find(e => e.id === employeeId);
    if (!employee) return;

    const activating = !employee.is_active;
    if (!activating && !confirm(`「${employee.name}」を無効にしてもよろしいですか？`)) {
      return;
    }

    try {
      if (activating) {
        await API.updateEmployee(employeeId, { name: employee.name, role: employee.role, is_active: true });
      } else {
        await API.deactivateEmployee(employeeId);
      }
      await this.loadEmployees();
      this.renderEmployeesTable();
    } catch (error) {
      console.error('従業員ステータス更新エラー:', error);
      alert('従業員ステータスの更新に失敗しました');
    }
  }
};

// ===== イベントリスナー =====
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('employee-form')?.addEventListener('submit', (e) => employeesApp.submitEmployeeForm(e));

  window.addEventListener('click', (e) => {
    if (e.target.id === 'employee-modal') {
      employeesApp.closeEmployeeModal();
    }
  });

  employeesApp.init();
});
