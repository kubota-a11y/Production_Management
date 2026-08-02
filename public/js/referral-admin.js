// 紹介コード発行画面(/referral-admin)。
// 紹介パートナー(チーム/個人)を登録してコードを発行し、実績の確認・無効化を行う。
// コードは「紹介ページ(/referral)の解錠キー」と「お知り合いに配る紹介コード」を兼ねる。

const referralApp = {
  partners: [],
  editingId: null,

  async load() {
    try {
      const res = await fetch('/api/referral-partners');
      const data = await res.json();
      this.partners = data.partners || [];
      const el = document.getElementById('referral-page-url');
      if (el) el.textContent = data.referral_page_url || '(PUBLIC_ORDER_BASE_URL 未設定)';
      this.render();
    } catch (e) {
      console.error('紹介コード一覧の取得に失敗:', e);
      HiUI.toast('紹介コード一覧の取得に失敗しました');
    }
  },

  render() {
    const tbody = document.getElementById('partners-tbody');
    tbody.innerHTML = '';
    if (this.partners.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="8" style="text-align:center;color:#6b7280">まだ発行していません。「紹介コードを発行」から作成してください。</td>';
      tbody.appendChild(tr);
      return;
    }

    this.partners.forEach(p => {
      const tr = document.createElement('tr');
      if (p.disabled_at) tr.className = 'link-disabled-row';

      // 紹介コード
      const tdCode = document.createElement('td');
      const code = document.createElement('strong');
      code.textContent = p.code;
      tdCode.appendChild(code);

      // 紹介者名
      const tdName = document.createElement('td');
      tdName.textContent = p.partner_name;

      // 種別
      const tdType = document.createElement('td');
      tdType.textContent = p.type_label;

      // 共有用リンク
      const tdUrl = document.createElement('td');
      if (p.share_url) {
        const span = document.createElement('span');
        span.className = 'link-url';
        span.textContent = p.share_url;
        const copy = document.createElement('button');
        copy.className = 'btn btn-secondary btn-small';
        copy.textContent = 'コピー';
        copy.onclick = () => referralApp.copy(p.share_url);
        tdUrl.append(span, copy);
      } else {
        tdUrl.textContent = '—';
      }

      // 実績
      const tdStats = document.createElement('td');
      tdStats.textContent = `${p.stats.total} / ${p.stats.confirmed}`;

      // 状態
      const tdStatus = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = `status-pill ${p.disabled_at ? 'disabled' : 'active'}`;
      pill.textContent = p.disabled_at ? '無効' : '有効';
      tdStatus.appendChild(pill);

      // 発行日
      const tdDate = document.createElement('td');
      tdDate.textContent = (p.created_at || '').slice(0, 10);

      // 操作
      const tdOps = document.createElement('td');
      const edit = document.createElement('button');
      edit.className = 'btn btn-secondary btn-small';
      edit.textContent = '✎ 編集';
      edit.onclick = () => referralApp.openModal(p.id);
      const toggle = document.createElement('button');
      toggle.className = `btn btn-small ${p.disabled_at ? 'btn-secondary' : 'btn-danger-soft'}`;
      toggle.textContent = p.disabled_at ? '有効化' : '無効化';
      toggle.onclick = () => referralApp.toggle(p);
      tdOps.append(edit, toggle);

      tr.append(tdCode, tdName, tdType, tdUrl, tdStats, tdStatus, tdDate, tdOps);
      tbody.appendChild(tr);
    });
  },

  async copy(url) {
    try {
      await navigator.clipboard.writeText(url);
      HiUI.toast('共有用リンクをコピーしました');
    } catch (_) {
      HiUI.toast('コピーできませんでした。URLを選択して手動でコピーしてください');
    }
  },

  openModal(id = null) {
    this.editingId = id;
    const p = id ? this.partners.find(x => x.id === id) : null;
    document.getElementById('partner-modal-title').textContent = p ? `紹介コードの編集(${p.code})` : '紹介コードを発行';
    document.getElementById('partner-save-btn').textContent = p ? '保存' : '発行する';
    document.getElementById('partner-name').value = p ? p.partner_name : '';
    document.getElementById('partner-memo').value = p ? (p.memo || '') : '';
    document.getElementById('partner-type').value = p ? p.partner_type : 'TEAM';
    // 種別は特典の出し分けに使うため、発行後は変えられないようにする
    document.getElementById('type-group').hidden = !!p;
    document.getElementById('partner-form-errors').hidden = true;
    document.getElementById('partner-modal').style.display = 'flex';
    document.getElementById('partner-name').focus();
  },

  closeModal() {
    document.getElementById('partner-modal').style.display = 'none';
    this.editingId = null;
  },

  showError(msg) {
    const box = document.getElementById('partner-form-errors');
    box.textContent = msg;
    box.hidden = !msg;
  },

  async save(e) {
    e.preventDefault();
    const name = document.getElementById('partner-name').value.trim();
    const memo = document.getElementById('partner-memo').value.trim();
    if (!name) { this.showError('紹介者名(チーム名)を入力してください'); return; }

    try {
      let res;
      if (this.editingId) {
        res = await fetch(`/api/referral-partners/${this.editingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ partner_name: name, memo }),
        });
      } else {
        res = await fetch('/api/referral-partners', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            partner_type: document.getElementById('partner-type').value,
            partner_name: name,
            memo,
          }),
        });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        this.showError(data.error || '保存に失敗しました');
        return;
      }
      this.closeModal();
      HiUI.toast(this.editingId ? '保存しました' : `紹介コード ${data.code} を発行しました`);
      this.editingId = null;
      this.load();
    } catch (err) {
      console.error('保存に失敗:', err);
      this.showError('保存に失敗しました');
    }
  },

  async toggle(p) {
    const willDisable = !p.disabled_at;
    const msg = willDisable
      ? `${p.code}(${p.partner_name})を無効化します。\n以後この紹介コードでは紹介ページを開けなくなります。よろしいですか?`
      : `${p.code}(${p.partner_name})を有効化します。よろしいですか?`;
    if (!confirm(msg)) return;
    try {
      const res = await fetch(`/api/referral-partners/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: willDisable }),
      });
      if (!res.ok) { HiUI.toast(`${willDisable ? '無効化' : '有効化'}に失敗しました`); return; }
      HiUI.toast(willDisable ? '無効化しました' : '有効化しました');
      this.load();
    } catch (err) {
      console.error('状態の変更に失敗:', err);
      HiUI.toast('状態を変更できませんでした');
    }
  },
};

document.getElementById('partner-form').addEventListener('submit', (e) => referralApp.save(e));
document.addEventListener('DOMContentLoaded', () => referralApp.load());
