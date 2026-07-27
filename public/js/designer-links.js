// デザイナーリンク管理画面(/designer-links)。
// デザイナー向けマイスケジュールボードの専用URLの発行・無効化と、配布用URLのコピーを行う。
// 構成は取引先リンク管理(partner-links.js)を踏襲。

const designerLinksApp = {
  links: [],
  employees: [],
  publicBase: '',
  baseIsFallback: false,

  async load() {
    try {
      const [linksRes, employeesRes] = await Promise.all([
        fetch('/api/designer-links'),
        fetch('/api/employees'),
      ]);
      const data = await linksRes.json();
      this.links = data.links || [];
      this.employees = (await employeesRes.json()) || [];
      // .env の PUBLIC_ORDER_BASE_URL が正。未設定だと管理画面のホスト名でURLを組んでしまい、
      // 社外の相手がCloudflare認証で弾かれるため警告を出す。
      this.baseIsFallback = !data.public_base;
      this.publicBase = data.public_base || window.location.origin;
      this.render();
    } catch (e) {
      console.error('デザイナーリンク一覧の取得に失敗:', e);
      alert('デザイナーリンク一覧の取得に失敗しました');
    }
  },

  urlFor(link) {
    return `${this.publicBase.replace(/\/$/, '')}/designer/${link.token}`;
  },

  renderBaseWarning() {
    const box = document.getElementById('base-warning');
    if (!box) return;
    if (!this.baseIsFallback) { box.style.display = 'none'; return; }
    box.style.display = '';
    box.textContent = `⚠️ 配布URLの基準アドレスが未設定です(.env の PUBLIC_ORDER_BASE_URL)。`
      + `現在は表示中のアドレス(${window.location.origin})でURLを組み立てているため、`
      + `そのまま渡すと社外から開けない可能性があります。`;
  },

  render() {
    this.renderBaseWarning();
    const tbody = document.getElementById('links-tbody');
    tbody.innerHTML = '';
    if (this.links.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="5" style="text-align:center;color:#6b7280">まだリンクがありません。「新規リンク発行」から作成してください。</td>';
      tbody.appendChild(tr);
      return;
    }
    this.links.forEach(link => {
      const tr = document.createElement('tr');
      if (link.disabled_at) tr.className = 'link-disabled-row';

      const tdName = document.createElement('td');
      tdName.textContent = link.employee_name;
      if (link.memo) {
        const memo = document.createElement('div');
        memo.style.cssText = 'font-size:.75rem;color:#6b7280';
        memo.textContent = link.memo;
        tdName.appendChild(memo);
      }

      const tdUrl = document.createElement('td');
      const row = document.createElement('div');
      row.className = 'url-row';
      const urlSpan = document.createElement('span');
      urlSpan.className = 'link-url';
      urlSpan.textContent = this.urlFor(link);
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn-secondary btn-sm';
      copyBtn.textContent = '📋 コピー';
      copyBtn.onclick = () => this.copyUrl(this.urlFor(link), copyBtn);
      row.append(urlSpan, copyBtn);
      tdUrl.appendChild(row);

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
      previewBtn.href = this.urlFor(link);
      previewBtn.target = '_blank';
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn btn-secondary btn-sm';
      toggleBtn.style.marginLeft = '4px';
      toggleBtn.textContent = link.disabled_at ? '♻️ 再有効化' : '🚫 無効化';
      toggleBtn.onclick = () => this.toggle(link);
      tdOps.append(previewBtn, toggleBtn);

      tr.append(tdName, tdUrl, tdStatus, tdDate, tdOps);
      tbody.appendChild(tr);
    });
  },

  async copyUrl(url, btn) {
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
    if (!confirm(`「${link.employee_name}」さんの専用URLを${action}しますか?`)) return;
    const res = await fetch(`/api/designer-links/${link.id}/toggle`, { method: 'POST' });
    if (!res.ok) { alert(`${action}に失敗しました`); return; }
    await this.load();
  },

  // ===== モーダル =====
  openModal() {
    const select = document.getElementById('link-employee-id');
    select.innerHTML = '<option value="">選択してください</option>' + this.employees
      .filter(e => e.is_active)
      .map(e => `<option value="${e.id}">${this.esc(e.name)}</option>`)
      .join('');
    document.getElementById('link-memo').value = '';
    document.getElementById('link-form-errors').hidden = true;
    document.getElementById('link-modal').style.display = 'flex';
  },

  closeModal() {
    document.getElementById('link-modal').style.display = 'none';
  },

  async save(ev) {
    ev.preventDefault();
    const payload = {
      employee_id: Number(document.getElementById('link-employee-id').value),
      memo: document.getElementById('link-memo').value,
    };
    try {
      const res = await fetch('/api/designer-links', {
        method: 'POST',
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
      console.error('リンク発行に失敗:', e);
      alert('発行に失敗しました');
    }
  },

  esc(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  },
};

document.getElementById('link-form').addEventListener('submit', ev => designerLinksApp.save(ev));
designerLinksApp.load();
