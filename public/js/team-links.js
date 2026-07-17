// チームリンク管理画面(/team-links)。
// 専用URLの発行・編集・無効化と、配布用URLのコピーを行う。
const teamLinksApp = {
  links: [],
  publicBase: '',
  editingId: null,

  async load() {
    try {
      const res = await fetch('/api/team-links');
      const data = await res.json();
      this.links = data.links || [];
      this.publicBase = data.public_base || window.location.origin;
      this.render();
    } catch (e) {
      console.error('チームリンク一覧の取得に失敗:', e);
      alert('チームリンク一覧の取得に失敗しました');
    }
  },

  urlFor(link) {
    return `${this.publicBase.replace(/\/$/, '')}/team/${link.token}`;
  },

  render() {
    const tbody = document.getElementById('links-tbody');
    tbody.innerHTML = '';
    if (this.links.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" style="text-align:center;color:#6b7280">まだリンクがありません。「新規リンク発行」から作成してください。</td>';
      tbody.appendChild(tr);
      return;
    }
    this.links.forEach(link => {
      const tr = document.createElement('tr');
      if (link.disabled_at) tr.className = 'link-disabled-row';

      const tdName = document.createElement('td');
      tdName.textContent = link.team_name;
      if (link.memo) {
        const memo = document.createElement('div');
        memo.style.cssText = 'font-size:.75rem;color:#6b7280';
        memo.textContent = link.memo;
        tdName.appendChild(memo);
      }

      const tdUrl = document.createElement('td');
      const urlSpan = document.createElement('span');
      urlSpan.className = 'link-url';
      urlSpan.textContent = this.urlFor(link);
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn-secondary btn-sm';
      copyBtn.textContent = '📋 コピー';
      copyBtn.style.marginLeft = '6px';
      copyBtn.onclick = () => this.copyUrl(link, copyBtn);
      tdUrl.append(urlSpan, copyBtn);

      const tdItems = document.createElement('td');
      tdItems.textContent = link.items.map(it => it.item_name).join(' / ') || '(なし)';

      const tdStatus = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = `status-pill ${link.disabled_at ? 'disabled' : 'active'}`;
      pill.textContent = link.disabled_at ? '無効' : '有効';
      tdStatus.appendChild(pill);

      const tdDate = document.createElement('td');
      tdDate.textContent = (link.created_at || '').slice(0, 10);

      const tdOps = document.createElement('td');
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary btn-sm';
      editBtn.textContent = '✏️ 編集';
      editBtn.onclick = () => this.openModal(link.id);
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn btn-secondary btn-sm';
      toggleBtn.style.marginLeft = '4px';
      toggleBtn.textContent = link.disabled_at ? '♻️ 再有効化' : '🚫 無効化';
      toggleBtn.onclick = () => this.toggle(link);
      tdOps.append(editBtn, toggleBtn);

      tr.append(tdName, tdUrl, tdItems, tdStatus, tdDate, tdOps);
      tbody.appendChild(tr);
    });
  },

  async copyUrl(link, btn) {
    const url = this.urlFor(link);
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      // クリップボードAPIが使えない環境(非https等)では一時テキストエリアで代替
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        ta.remove();
      } catch { copied = false; }
    }
    const done = document.createElement('span');
    done.className = 'copy-done';
    done.textContent = copied ? '✓ コピーしました' : 'コピーできません。URLを直接選択してください';
    if (!copied) done.style.color = '#b91c1c';
    btn.after(done);
    setTimeout(() => done.remove(), 3000);
  },

  async toggle(link) {
    const action = link.disabled_at ? '再有効化' : '無効化';
    if (!confirm(`「${link.team_name}」の専用URLを${action}しますか?`)) return;
    const res = await fetch(`/api/team-links/${link.id}/toggle`, { method: 'POST' });
    if (!res.ok) { alert(`${action}に失敗しました`); return; }
    await this.load();
  },

  // ===== モーダル =====
  openModal(id = null) {
    this.editingId = id;
    const link = id ? this.links.find(l => l.id === id) : null;
    document.getElementById('link-modal-title').textContent = link ? 'リンクを編集' : '新規リンク発行';
    document.getElementById('link-team-name').value = link ? link.team_name : '';
    document.getElementById('link-memo').value = link ? (link.memo || '') : '';
    document.getElementById('link-form-errors').hidden = true;

    const tbody = document.getElementById('link-items-tbody');
    tbody.innerHTML = '';
    if (link && link.items.length) {
      link.items.forEach(it => this.addItemRow(it));
    } else {
      this.addItemRow();
    }
    document.getElementById('link-modal').style.display = 'flex';
  },

  closeModal() {
    document.getElementById('link-modal').style.display = 'none';
  },

  addItemRow(item = null) {
    const tbody = document.getElementById('link-items-tbody');
    const tr = document.createElement('tr');
    tr.className = 'item-edit-row';

    const tdName = document.createElement('td');
    const nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.maxLength = 200; nameIn.className = 'li-name';
    nameIn.placeholder = '例: FPユニフォーム(上)';
    nameIn.value = item ? item.item_name : '';
    tdName.appendChild(nameIn);

    const tdPrice = document.createElement('td');
    const priceIn = document.createElement('input');
    priceIn.type = 'number'; priceIn.min = '0'; priceIn.step = '1'; priceIn.className = 'li-price';
    priceIn.placeholder = '空欄可';
    priceIn.value = item && item.unit_price !== null ? item.unit_price : '';
    tdPrice.appendChild(priceIn);

    const tdSizes = document.createElement('td');
    const sizesIn = document.createElement('input');
    sizesIn.type = 'text'; sizesIn.className = 'li-sizes';
    sizesIn.placeholder = '例: 130,140,150,S,M,L,XL(空欄なら自由入力)';
    sizesIn.value = item ? (item.size_options || []).join(',') : '';
    tdSizes.appendChild(sizesIn);

    const tdDel = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'btn-close'; delBtn.textContent = '✕';
    delBtn.onclick = () => tr.remove();
    tdDel.appendChild(delBtn);

    tr.append(tdName, tdPrice, tdSizes, tdDel);
    tbody.appendChild(tr);
  },

  collectItems() {
    return Array.from(document.querySelectorAll('#link-items-tbody .item-edit-row')).map(tr => ({
      item_name: tr.querySelector('.li-name').value,
      unit_price: tr.querySelector('.li-price').value === '' ? null : Number(tr.querySelector('.li-price').value),
      size_options: tr.querySelector('.li-sizes').value.split(',').map(v => v.trim()).filter(Boolean),
    }));
  },

  async save(ev) {
    ev.preventDefault();
    const payload = {
      team_name: document.getElementById('link-team-name').value,
      memo: document.getElementById('link-memo').value,
      items: this.collectItems(),
    };
    const url = this.editingId ? `/api/team-links/${this.editingId}` : '/api/team-links';
    const method = this.editingId ? 'PUT' : 'POST';
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        const box = document.getElementById('link-form-errors');
        box.textContent = (data.errors || ['保存に失敗しました']).join(' / ');
        box.hidden = false;
        return;
      }
      this.closeModal();
      await this.load();
    } catch (e) {
      console.error('リンク保存に失敗:', e);
      alert('保存に失敗しました');
    }
  },
};

document.getElementById('link-form').addEventListener('submit', ev => teamLinksApp.save(ev));
teamLinksApp.load();
