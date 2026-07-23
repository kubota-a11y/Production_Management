// 取引先リンク管理画面(/partner-links)。
// 取引先向け納期確認ページの専用URLの発行・編集・無効化と、配布用URLのコピーを行う。
// 構成はチームリンク管理(team-links.js)を踏襲。

const partnerLinksApp = {
  links: [],
  publicBase: '',
  editingId: null,

  async load() {
    try {
      const res = await fetch('/api/partner-links');
      const data = await res.json();
      this.links = data.links || [];
      this.publicBase = data.public_base || window.location.origin;
      this.render();
    } catch (e) {
      console.error('取引先リンク一覧の取得に失敗:', e);
      alert('取引先リンク一覧の取得に失敗しました');
    }
  },

  urlFor(link) {
    return `${this.publicBase.replace(/\/$/, '')}/partner/${link.token}`;
  },

  render() {
    const tbody = document.getElementById('links-tbody');
    tbody.innerHTML = '';
    if (this.links.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="7" style="text-align:center;color:#6b7280">まだリンクがありません。「新規リンク発行」から作成してください。</td>';
      tbody.appendChild(tr);
      return;
    }
    this.links.forEach(link => {
      const tr = document.createElement('tr');
      if (link.disabled_at) tr.className = 'link-disabled-row';

      const tdName = document.createElement('td');
      tdName.textContent = link.partner_name;
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

      const tdPatterns = document.createElement('td');
      (link.customer_patterns || []).forEach(p => {
        const pill = document.createElement('span');
        pill.className = 'pattern-pill';
        pill.textContent = p;
        tdPatterns.appendChild(pill);
      });

      const tdCount = document.createElement('td');
      const count = document.createElement('span');
      count.className = 'count-badge';
      count.textContent = `${link.active_count}件`;
      tdCount.appendChild(count);

      const tdStatus = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = `status-pill ${link.disabled_at ? 'disabled' : 'active'}`;
      pill.textContent = link.disabled_at ? '無効' : '有効';
      tdStatus.appendChild(pill);

      const tdDate = document.createElement('td');
      tdDate.textContent = (link.created_at || '').slice(0, 10);

      const tdOps = document.createElement('td');
      const previewBtn = document.createElement('a');
      previewBtn.className = 'btn btn-secondary btn-sm';
      previewBtn.textContent = '👀 確認';
      previewBtn.href = `/partner/${link.token}`;
      previewBtn.target = '_blank';
      const formBtn = document.createElement('a');
      formBtn.className = 'btn btn-secondary btn-sm';
      formBtn.style.marginLeft = '4px';
      formBtn.textContent = '📝 依頼フォーム';
      formBtn.href = `/partner/${link.token}/order`;
      formBtn.target = '_blank';
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary btn-sm';
      editBtn.style.marginLeft = '4px';
      editBtn.textContent = '✏️ 編集';
      editBtn.onclick = () => this.openModal(link.id);
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn btn-secondary btn-sm';
      toggleBtn.style.marginLeft = '4px';
      toggleBtn.textContent = link.disabled_at ? '♻️ 再有効化' : '🚫 無効化';
      toggleBtn.onclick = () => this.toggle(link);
      tdOps.append(previewBtn, formBtn, editBtn, toggleBtn);

      tr.append(tdName, tdUrl, tdPatterns, tdCount, tdStatus, tdDate, tdOps);
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
    if (!confirm(`「${link.partner_name}」の専用URLを${action}しますか?`)) return;
    const res = await fetch(`/api/partner-links/${link.id}/toggle`, { method: 'POST' });
    if (!res.ok) { alert(`${action}に失敗しました`); return; }
    await this.load();
  },

  // ===== モーダル =====
  openModal(id = null) {
    this.editingId = id;
    const link = id ? this.links.find(l => l.id === id) : null;
    document.getElementById('link-modal-title').textContent = link ? 'リンクを編集' : '新規リンク発行';
    document.getElementById('link-partner-name').value = link ? link.partner_name : '';
    document.getElementById('link-patterns').value = link ? (link.customer_patterns || []).join('、') : '';
    document.getElementById('link-memo').value = link ? (link.memo || '') : '';
    document.getElementById('link-form-errors').hidden = true;
    document.getElementById('link-modal').style.display = 'flex';
  },

  closeModal() {
    document.getElementById('link-modal').style.display = 'none';
  },

  async save(ev) {
    ev.preventDefault();
    const payload = {
      partner_name: document.getElementById('link-partner-name').value,
      // 読点・カンマのどちらでも区切れるようにする
      customer_patterns: document.getElementById('link-patterns').value
        .split(/[、,]/).map(v => v.trim()).filter(Boolean),
      memo: document.getElementById('link-memo').value,
    };
    const url = this.editingId ? `/api/partner-links/${this.editingId}` : '/api/partner-links';
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

document.getElementById('link-form').addEventListener('submit', ev => partnerLinksApp.save(ev));
partnerLinksApp.load();
