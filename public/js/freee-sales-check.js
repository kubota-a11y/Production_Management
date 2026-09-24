// freee売上科目チェック(/freee-sales-check・2026-09-24)。
// 「freee請求書の取引登録の勘定科目を、案件の売上ごとに自動で振り分けたい」(社長)の人が見る側。
// freeeの見積書・請求書の明細行には勘定科目を持てないので、請求書から立った取引の科目を案件の売上区分で付け替える。
// 判定「高」は lib/freee-sales-sync.js が6時間ごとに自動で反映し、この画面は残り(中・低・混在)を月1回人が見る場所。
// 反映はfreeeの取引の勘定科目を書き換える操作なので、1行ずつ・またはまとめて、必ず人が押す。
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const sc = window.SalesCategory;
  let rows = [];

  /** 既定の対象月: 1〜10日は前月(月初の月次作業)、それ以降は当月 */
  function defaultMonth() {
    const d = new Date();
    if (d.getDate() <= 10) d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const yen = (n) => `${Number(n || 0).toLocaleString()}円`;

  function options(selected) {
    return sc.LIST.map((c) => `<option value="${c.code}"${c.code === selected ? ' selected' : ''}>${esc(c.label)}(${esc(c.account)})</option>`).join('');
  }

  function render() {
    const tbody = el('fsc-tbody');
    el('fsc-empty').hidden = rows.length > 0;
    tbody.innerHTML = rows.map((r, i) => {
      const changed = r.chosen !== r.current_code;
      const matched = r.matched_case
        ? `<div class="fsc-reason">案件: <a href="/?case=${r.matched_case.id}" target="_blank" rel="noopener">${esc(r.matched_case.project_name)}</a></div>`
        : '';
      const settled = r.status === 'settled' ? '<span class="fsc-badge">決済済</span>' : '';
      // 判定の確からしさ。高=自動実行が付け替える対象(売上高のままのとき)、中・低=人が見て押す
      const conf = { high: '判定: 高(自動の対象)', medium: '判定: 中(要確認)', low: '判定: 低(要確認)', current: '科目付与済み' }[r.confidence] || '';
      const last = r.last_sync
        ? `<div class="fsc-reason">${r.last_sync.mode === 'auto' ? '自動' : '手動'}で「${esc(r.last_sync.to_label)}」へ反映済み(${esc(String(r.last_sync.at).slice(0, 10))})。自動実行はもう触りません</div>`
        : '';
      return `
        <tr data-i="${i}" class="${changed ? 'fsc-changed' : ''}${r.done ? ' fsc-done' : ''}">
          <td>${esc(r.issue_date)}</td>
          <td>${esc(r.partner_name)}</td>
          <td>${esc(r.description || '(摘要なし)')}${r.ref_number ? `<div class="fsc-reason">管理番号 ${esc(r.ref_number)}</div>` : ''}</td>
          <td class="fsc-amount">${yen(r.amount)} ${settled}</td>
          <td>${esc(r.current_label)}${r.current_code === 'MIXED' ? '<div class="fsc-reason">売上の行が複数の科目にまたがっています。反映すると売上の行が全部同じ科目になります</div>' : ''}${last}</td>
          <td>
            <select data-select="${i}" class="fsc-select">${options(r.chosen)}</select>
            <div class="fsc-reason"><span class="fsc-badge">${esc(conf)}</span> ${esc(r.suggested_reason)}</div>
            ${matched}
          </td>
          <td>
            ${r.done
              ? `<span class="fsc-ok">✅ 反映済み</span>`
              : changed
                ? `<button type="button" class="btn btn-small btn-primary" data-apply="${i}">反映</button>`
                : '<span class="fsc-reason">変更なし</span>'}
          </td>
        </tr>`;
    }).join('');
    tbody.querySelectorAll('select[data-select]').forEach((s) => {
      s.onchange = () => { rows[+s.dataset.select].chosen = s.value; render(); };
    });
    tbody.querySelectorAll('button[data-apply]').forEach((b) => { b.onclick = () => apply([+b.dataset.apply]); });
    renderSummary();
  }

  function renderSummary() {
    const total = rows.length;
    const pending = rows.filter((r) => !r.done && r.chosen !== r.current_code).length;
    const general = rows.filter((r) => r.current_code === 'GENERAL').length;
    const autoDone = rows.filter((r) => r.last_sync && r.last_sync.mode === 'auto').length;
    el('fsc-summary').textContent = total
      ? `売上取引 ${total}件(うち「売上高」のまま ${general}件・自動で振り替え済み ${autoDone}件)。振り替えの候補 ${pending}件。`
      : '';
    el('fsc-apply-all').disabled = pending === 0;
  }

  async function load() {
    const month = el('fsc-month').value;
    if (!month) { HiUI.toast('対象月を選んでください'); return; }
    const btn = el('fsc-load');
    btn.disabled = true;
    el('fsc-summary').textContent = 'freeeから読み込み中...';
    rows = [];
    render();
    try {
      const resp = await fetch(`/api/freee/sales-deals?month=${encodeURIComponent(month)}`);
      const data = await resp.json();
      if (!data.ok) {
        el('fsc-summary').textContent = data.error || '読み込めませんでした';
        if (data.need_auth) HiUI.toast('freeeと未連携です。見積シミュレーターの「freeeに見積書を作成」から連携してください');
        else HiUI.toast(`読み込めませんでした: ${data.error || ''}`);
        return;
      }
      rows = data.deals.map((d) => ({ ...d, chosen: d.suggested_code || d.current_code || 'GENERAL', done: false }));
      if (!rows.length) el('fsc-summary').textContent = `${month} の売上取引はありません`;
      render();
    } catch (e) {
      console.error(e);
      el('fsc-summary').textContent = '通信エラー';
      HiUI.toast('freeeから読み込めませんでした(通信エラー)');
    } finally {
      btn.disabled = false;
    }
  }

  /** 指定した行の科目をfreeeへ反映する(1行ずつ順に。途中で失敗したらそこで止める) */
  async function apply(indexes) {
    const targets = indexes.map((i) => rows[i]).filter((r) => r && !r.done && r.chosen !== r.current_code);
    if (!targets.length) return;
    const summary = targets.map((r) => `・${r.issue_date} ${r.partner_name} ${yen(r.amount)} → ${sc.labelOf(r.chosen)}`).join('\n');
    if (!window.confirm(`freeeの取引の勘定科目を書き換えます(${targets.length}件)。よろしいですか?\n\n${summary}`)) return;
    let okCount = 0;
    for (const r of targets) {
      try {
        const resp = await fetch(`/api/freee/sales-deals/${r.id}/account-item`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: r.chosen, case_id: r.matched_case ? r.matched_case.id : null,
            from_code: r.current_code, issue_date: r.issue_date, amount: r.amount,
          }),
        });
        const data = await resp.json();
        if (!data.ok) { HiUI.toast(`反映できませんでした(${r.partner_name}): ${data.error || ''}`); break; }
        r.done = true;
        r.current_code = r.chosen;
        r.current_label = sc.labelOf(r.chosen);
        r.last_sync = { to_label: sc.labelOf(r.chosen), mode: 'manual', at: new Date().toISOString() };
        okCount += 1;
      } catch (e) {
        console.error(e);
        HiUI.toast(`反映できませんでした(${r.partner_name}): 通信エラー`);
        break;
      }
    }
    render();
    if (okCount) HiUI.toast(`${okCount}件の勘定科目をfreeeへ反映しました`);
  }

  el('fsc-month').value = defaultMonth();
  el('fsc-load').onclick = load;
  el('fsc-apply-all').onclick = () => apply(rows.map((_, i) => i));
  el('fsc-empty').hidden = false;
}());
