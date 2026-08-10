// バックアップ状態の確認画面(/backup-status)。
// 「今日のDBバックアップが、全部の保存先にちゃんと出来ているか」だけを見る画面。
// 記録ではなく実ファイルを見た結果を表示するので、保存先のフォルダが消えた場合も分かる。

const backupStatusApp = {
  async load() {
    const summary = document.getElementById('summary');
    summary.className = 'backup-summary';
    summary.textContent = '確認中...(保存先がネットワーク上にある場合、数秒かかることがあります)';
    try {
      const res = await fetch('/api/backup-status');
      const data = await res.json();
      this.render(data);
    } catch (e) {
      console.error('バックアップ状態の取得に失敗:', e);
      summary.className = 'backup-summary is-error';
      summary.textContent = '状態を取得できませんでした。サーバーが動いているか確認してください。';
      HiUI.toast('バックアップ状態の取得に失敗しました');
    }
  },

  formatSize(bytes) {
    if (bytes === null || bytes === undefined) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  },

  render(data) {
    this.renderSummary(data);
    this.renderTable(data);

    const lastRun = document.getElementById('last-run');
    if (!data.lastRun) {
      lastRun.textContent = `自動バックアップは1日1回・${data.keepCount}世代まで保存します。`;
      return;
    }
    const ranAt = new Date(data.lastRun.ranAt).toLocaleString('ja-JP');
    const failed = (data.lastRun.extras || []).filter((e) => !e.ok);
    const detail = failed.length === 0
      ? 'エラーはありませんでした。'
      : `失敗した保存先: ${failed.map((e) => `${e.dir}(${e.error})`).join(' / ')}`;
    lastRun.textContent = `最後にバックアップを作成した日時: ${ranAt} — ${detail}`
      + ` 自動バックアップは1日1回・${data.keepCount}世代まで保存します。`;
  },

  renderSummary(data) {
    const summary = document.getElementById('summary');
    const total = data.destinations.length;
    const ng = data.destinations.filter((d) => !d.reachable || !d.upToDate);

    if (!data.offsiteConfigured) {
      summary.className = 'backup-summary is-error';
      summary.textContent = '⚠ 追加の保存先が設定されていません。サーバー本体が壊れると復旧できません。'
        + ' .env の DB_BACKUP_EXTRA_DIR に保存先を指定してください。';
      return;
    }
    if (ng.length > 0) {
      summary.className = 'backup-summary is-error';
      summary.textContent = `⚠ ${total} か所のうち ${ng.length} か所で本日(${data.today})分のバックアップを確認できません。`
        + ' 下の表で場所を確認してください。';
      return;
    }
    summary.className = 'backup-summary is-ok';
    summary.textContent = `✓ 本日(${data.today})分のバックアップが ${total} か所すべてに保存されています。`;
  },

  renderTable(data) {
    const tbody = document.getElementById('dest-tbody');
    tbody.innerHTML = '';

    data.destinations.forEach((d, index) => {
      const tr = document.createElement('tr');

      const name = d.role === 'primary' ? 'サーバー本体' : `追加保存先 ${index}`;
      tr.appendChild(this.cell(name));

      const pathCell = document.createElement('td');
      const pathSpan = document.createElement('span');
      pathSpan.className = 'backup-path';
      pathSpan.textContent = d.dir;
      pathCell.appendChild(pathSpan);
      if (!d.reachable) {
        const err = document.createElement('div');
        err.className = 'empty-notice';
        err.textContent = `この場所を開けませんでした: ${d.error}`;
        pathCell.appendChild(err);
      }
      tr.appendChild(pathCell);

      const latestCell = document.createElement('td');
      const pill = document.createElement('span');
      if (!d.reachable) {
        pill.className = 'status-pill error';
        pill.textContent = '確認不可';
      } else if (d.upToDate) {
        pill.className = 'status-pill active';
        pill.textContent = `本日 ${d.latestDate}`;
      } else {
        pill.className = 'status-pill error';
        pill.textContent = d.latestDate ? `古い ${d.latestDate}` : 'なし';
      }
      latestCell.appendChild(pill);
      tr.appendChild(latestCell);

      tr.appendChild(this.cell(this.formatSize(d.sizeBytes)));
      tr.appendChild(this.cell(d.reachable ? `${d.generations} 世代` : '—'));

      tbody.appendChild(tr);
    });
  },

  cell(text) {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
  },
};

document.addEventListener('DOMContentLoaded', () => backupStatusApp.load());
