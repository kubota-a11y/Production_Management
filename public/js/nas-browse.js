// ========================================
// 案件フォルダ閲覧モーダル(共有モジュール)
// NASの中身をどの端末のブラウザからでも一覧・プレビューする。
// 納品履歴・顧客台帳の両ページから使うため、モーダルDOMの生成込みでここに集約する。
// 利用側: NasBrowse.open(nasPath, '案件名 / 顧客名') を呼ぶだけでよい
// ========================================

const NasBrowse = {
  currentPath: null,

  // モーダルDOMを初回利用時にbodyへ差し込む(各ページのHTMLに二重で持たせない)
  ensureModal() {
    if (document.getElementById('nas-browse-modal')) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div id="nas-browse-modal" class="modal">
        <div class="modal-content">
          <div class="modal-header">
            <h2>📁 案件フォルダ</h2>
            <button class="btn-close" onclick="NasBrowse.close()">✕</button>
          </div>
          <p class="folder-notice" id="nas-browse-project-info"></p>
          <div id="nas-browse-breadcrumb" class="folder-breadcrumb"></div>
          <div id="nas-browse-loading" class="folder-loading" style="display:none;">読み込み中…</div>
          <div id="nas-browse-list" class="folder-list"></div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="NasBrowse.openOnServer()">🖥️ サーバー機のエクスプローラーで開く</button>
            <button type="button" class="btn btn-primary" onclick="NasBrowse.close()">閉じる</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrapper.firstElementChild);
  },

  open(nasPath, label = '') {
    this.ensureModal();
    document.getElementById('nas-browse-project-info').textContent = label;
    document.getElementById('nas-browse-modal').style.display = 'flex';
    this.load(nasPath);
  },

  close() {
    const modal = document.getElementById('nas-browse-modal');
    if (modal) modal.style.display = 'none';
    this.currentPath = null;
  },

  async load(path) {
    const listEl = document.getElementById('nas-browse-list');
    const loadingEl = document.getElementById('nas-browse-loading');
    const breadcrumbEl = document.getElementById('nas-browse-breadcrumb');
    loadingEl.style.display = 'block';
    listEl.innerHTML = '';
    breadcrumbEl.innerHTML = '';

    try {
      const data = await API.getNasList(path);
      loadingEl.style.display = 'none';

      if (!data || !data.exists) {
        listEl.innerHTML = '<div class="folder-notice">フォルダが見つかりません(NASに接続できないか、パスが変わっている可能性があります)</div>';
        return;
      }

      this.currentPath = data.path;
      this.renderBreadcrumb(data.path);

      const entries = [...data.entries].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      if (entries.length === 0) {
        listEl.innerHTML = '<div class="folder-notice">フォルダ内にファイルが見つかりません</div>';
        return;
      }

      entries.forEach(entry => {
        const item = document.createElement('div');
        item.className = 'folder-item';
        const nameEl = document.createElement('span');
        nameEl.textContent = entry.name + (entry.isDirectory ? ' /' : '');
        item.appendChild(nameEl);

        if (entry.isDirectory) {
          item.style.cursor = 'pointer';
          item.onclick = () => this.load(entry.path);
        } else {
          const openBtn = document.createElement('button');
          openBtn.className = 'btn-small';
          openBtn.textContent = '📂 開く/DL';
          openBtn.style.marginLeft = '8px';
          openBtn.onclick = (e) => {
            e.stopPropagation();
            window.open(API.getNasFileUrl(entry.path), '_blank');
          };
          item.appendChild(openBtn);
        }
        listEl.appendChild(item);
      });
    } catch (error) {
      console.error('NAS一覧取得エラー:', error);
      loadingEl.style.display = 'none';
      listEl.innerHTML = '<div class="folder-notice">NAS一覧の取得に失敗しました</div>';
    }
  },

  // パスの区切りごとにクリックできるパンくずを組み立てる(案件モーダルのNAS一覧と同じ挙動)
  renderBreadcrumb(fullPath) {
    const breadcrumbEl = document.getElementById('nas-browse-breadcrumb');
    breadcrumbEl.innerHTML = '';
    const sep = fullPath.includes('\\') ? '\\' : '/';
    const parts = fullPath.split(/[\\/]+/).filter(Boolean);
    parts.forEach((part, idx) => {
      const seg = document.createElement('a');
      seg.href = '#';
      const resolved = (fullPath.startsWith(sep) ? sep : '') + parts.slice(0, idx + 1).join(sep);
      seg.textContent = (idx === 0 && fullPath.startsWith(sep)) ? sep + part : part;
      seg.style.marginRight = '6px';
      seg.onclick = (e) => {
        e.preventDefault();
        this.load(resolved);
      };
      breadcrumbEl.appendChild(seg);
      if (idx < parts.length - 1) breadcrumbEl.appendChild(document.createTextNode(' / '));
    });
  },

  // 表示中のフォルダをサーバー機のエクスプローラーで開く(サーバーを動かしている端末上でのみ有効)
  async openOnServer() {
    if (!this.currentPath) return;
    try {
      const result = await API.openNasFile(this.currentPath);
      if (result.error) HiUI.toast(`フォルダを開けませんでした: ${result.error}`);
    } catch (error) {
      console.error('NASフォルダ表示エラー:', error);
      HiUI.toast('フォルダを開けませんでした');
    }
  },
};
