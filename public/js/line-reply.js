// ========================================
// 公式LINE AI受付「返信キュー」(2026-09-24)
// AIが作った返信の下書きを一覧→確認→[送信]/[直して送信]/[送らない]。
// 送信は Messaging API の push(取り消せない)なので、送る前に必ず確認ダイアログを出す。
// 2026-09-24 追加: ファイル添付(見積書PDF・仕上がりイメージ)・フォームの問い合わせ内容と画像の表示
// ========================================
(function () {
  'use strict';

  const SENDER_KEY = 'hiboard.lineReply.sender';
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const nl2br = (s) => esc(s).replace(/\n/g, '<br>');

  const state = { status: 'pending', drafts: [], selectedId: null, detail: null, senders: [], attachments: [] };

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async function postJson(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return res.json();
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function elapsed(iso) {
    if (!iso) return '';
    const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (min < 60) return `${min}分前`;
    if (min < 60 * 24) return `${Math.floor(min / 60)}時間前`;
    return `${Math.floor(min / 1440)}日前`;
  }
  const STATUS_LABEL = { pending: '待ち', sent: 'そのまま送信', edited: '直して送信', discarded: '送らない', superseded: '作り直し', auto_sent: '自動送信', error: 'エラー' };
  const INTAKE_STATUS = { pending: '未処理', confirmed: '案件登録済み', rejected: '却下' };

  function chip(text, cls) { return `<span class="lr-chip ${cls || ''}">${esc(text)}</span>`; }
  function flagChips(flags) {
    return (flags || []).map((f) => chip(f, f === '社長確認' || f === 'クレーム' ? 'lr-chip-danger' : f === '価格に触れた' || f === '納期に触れた' ? 'lr-chip-warn' : '')).join('');
  }

  // ---- 一覧 ----
  async function loadList() {
    const data = await getJson(`/api/line-reply?status=${encodeURIComponent(state.status)}`);
    state.drafts = data.drafts;
    el('lr-count-pending').textContent = data.pendingCount;
    const c = data.config;
    el('lr-status').textContent = `${c.enabled ? `AI下書き: 有効(${c.model})` : 'AI下書き: 停止中(ANTHROPIC_API_KEY 未設定または AI_REPLY_ENABLED=off)'}｜${c.now}｜時間外の自動送信: ${c.autoAfterHours ? 'オン' : 'オフ'}${c.dryRun ? '｜送信はdry-run(実際には送られません)' : ''}`;
    renderList();
  }

  function renderList() {
    const list = el('lr-list');
    if (!state.drafts.length) {
      list.innerHTML = `<div class="empty-notice">${state.status === 'pending' ? '待っている下書きはありません。' : '該当する下書きはありません。'}</div>`;
      return;
    }
    list.innerHTML = state.drafts.map((d) => {
      const sel = d.id === state.selectedId ? ' is-selected' : '';
      const noReply = d.category === '挨拶のみ';
      return `
        <article class="lr-card${sel}${noReply ? ' lr-card-muted' : ''}" data-id="${d.id}" id="draft-${d.id}" tabindex="0" role="button" aria-label="下書き #${d.id}">
          <div class="lr-card-head">
            <span class="lr-card-name">${esc(d.display_name || '(表示名なし)')}</span>
            <span class="lr-card-time" title="${esc(fmtTime(d.last_inbound_at))}">${elapsed(d.last_inbound_at || d.created_at)}</span>
          </div>
          <div class="lr-card-chips">
            ${chip(d.category || '(未分類)', 'lr-chip-cat')}
            ${d.order_likelihood === 'high' ? chip('注文の可能性: 高', 'lr-chip-ok') : ''}
            ${d.status !== 'pending' ? chip(STATUS_LABEL[d.status] || d.status, 'lr-chip-status') : ''}
            ${flagChips(d.flags)}
          </div>
          <div class="lr-card-summary">${esc(d.summary || d.error || '')}</div>
        </article>`;
    }).join('');
    list.querySelectorAll('.lr-card').forEach((card) => {
      const open = () => selectDraft(parseInt(card.dataset.id, 10));
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  // ---- 詳細 ----
  async function selectDraft(id) {
    state.selectedId = id;
    state.attachments = [];
    renderList();
    el('lr-detail').innerHTML = '<div class="folder-loading">読み込み中…</div>';
    try {
      state.detail = await getJson(`/api/line-reply/${id}`);
      // freeeで発行した見積書PDFが下書きに紐づいていて、まだ送っていなければ最初から添付しておく
      const qf = state.detail.quote_file;
      if (qf && !qf.sent_at && state.detail.draft.status === 'pending') state.attachments = [qf];
      renderDetail();
    } catch (err) {
      el('lr-detail').innerHTML = `<div class="empty-notice">読み込みに失敗しました(${esc(err.message)})</div>`;
    }
  }

  function bubble(m) {
    const mine = m.direction === 'out';
    let body;
    if (m.message_type === 'text') body = nl2br(m.text_content);
    else if (m.message_type === 'image' && m.image_path) body = `<a href="${API.getNasFileUrl(m.image_path)}" target="_blank" rel="noopener"><img class="lr-bubble-img" src="${API.getNasFileUrl(m.image_path)}" alt="お客様からの画像" loading="lazy"></a>`;
    else if (m.message_type === 'file' && m.sent_file) {
      const f = m.sent_file;
      body = `<div class="lr-file-sent">${f.internal_preview ? `<a href="${esc(f.url || '#')}" target="_blank" rel="noopener"><img class="lr-bubble-img" src="${esc(f.internal_preview)}" alt="${esc(f.file_name)}" loading="lazy"></a>` : ''}
        <div>📎 <a href="${esc(f.url || '#')}" target="_blank" rel="noopener">${esc(f.file_name)}</a><span class="text-muted">(${f.kind === 'pdf' ? 'PDF' : '画像'}${f.preview_count ? `・画像${f.preview_count}枚+リンク` : '・リンク'})</span></div></div>`;
    } else if (m.message_type === 'file') body = nl2br(m.text_content || '[ファイル]');
    else body = `<span class="lr-bubble-other">[${esc(m.message_type)}]</span>`;
    return `<div class="lr-bubble ${mine ? 'lr-bubble-out' : 'lr-bubble-in'}">
      <div class="lr-bubble-meta">${mine ? `当社(${esc(m.sent_by || '担当')})` : (m.sender_name ? `お客様(${esc(m.sender_name)})` : 'お客様')}・${esc(fmtTime(m.received_at))}</div>
      <div class="lr-bubble-body">${body}</div>
    </div>`;
  }

  // フォーム(Q-/W-/T-/P-)の問い合わせ内容と参考画像
  function formPanel(intakes) {
    if (!intakes || !intakes.length) return '';
    return intakes.map((it, idx) => `
      <details class="lr-form" ${idx === 0 ? 'open' : ''}>
        <summary>📋 ${esc(it.kind)}のお問い合わせ(受付 ${esc(it.receipt)}・${esc(fmtTime(it.extracted_at))}・${esc(INTAKE_STATUS[it.status] || it.status)}${it.case_id ? `・案件#${it.case_id}` : ''})</summary>
        <div class="lr-form-body">
          ${it.images.length ? `<div class="lr-form-images">${it.images.map((im) => `<a href="${API.getNasFileUrl(im.path)}" target="_blank" rel="noopener" title="${esc(im.name)}"><img src="${API.getNasFileUrl(im.path)}" alt="${esc(im.name)}" loading="lazy"></a>`).join('')}</div>` : ''}
          <pre class="lr-form-notes">${esc(it.notes || [it.customer_name, it.items, it.quantity, it.deadline].filter(Boolean).join(' / '))}</pre>
          <div class="lr-form-actions"><a class="btn btn-small btn-ghost" href="/?intake=${it.id}" target="_blank" rel="noopener">${it.status === 'pending' ? '受注候補を開く(案件として登録)' : '受注候補を開く'}</a></div>
        </div>
      </details>`).join('');
  }

  // LINE由来の受注候補(返信キューのAIが作ったもの)。案件登録は受注候補の確認モーダル(トップ)で行う
  function intakePanel(d, lineIntakes) {
    const list = (lineIntakes || []).filter((it) => it.status === 'pending');
    const done = (lineIntakes || []).filter((it) => it.status !== 'pending');
    const row = (it) => `<div class="lr-intake-row">
        <span class="receipt-badge">${esc(it.receipt)}</span>
        <span>${esc([it.items, it.quantity ? `${it.quantity}枚` : '', it.deadline ? `納期 ${it.deadline}` : ''].filter(Boolean).join('・') || '(内容未記入)')}</span>
        ${it.status === 'pending' ? `<a class="btn btn-small btn-primary" href="/?intake=${it.id}" target="_blank" rel="noopener">案件として登録</a><button type="button" class="btn btn-small btn-danger-soft" data-reject-intake="${it.id}">却下</button>` : chip(it.status === 'confirmed' ? `案件登録済み${it.case_id ? ` #${it.case_id}` : ''}` : '却下済み', 'lr-chip-status')}
      </div>`;
    return `<div class="lr-intake">
      <div class="lr-attach-head"><span class="form-label">📥 受注候補 <span class="text-muted">(AIが「注文の可能性: 高」と判断した会話は自動で1件にまとめます)</span></span>
        ${d.status === 'pending' && !list.length ? `<button type="button" class="btn btn-small btn-secondary" id="lr-make-intake">この会話を受注候補にする</button>` : ''}</div>
      ${list.map(row).join('') || '<div class="text-muted">未処理の受注候補はありません</div>'}
      ${done.length ? `<details class="lr-more"><summary>処理済み ${done.length}件</summary>${done.map(row).join('')}</details>` : ''}
    </div>`;
  }

  function attachmentsPanel() {
    const { filesReady, folders } = state.detail;
    const chips = state.attachments.map((f, i) => `<span class="lr-attach-chip">${f.kind === 'pdf' ? '📄' : '🖼'} ${esc(f.file_name)}${f.preview_count ? `<span class="text-muted">(画像${f.preview_count}枚+リンク)</span>` : `<span class="text-muted">(リンクのみ${f.preview_error ? '・画像化できず' : ''})</span>`} <button type="button" class="btn-icon-remove" data-remove="${i}" aria-label="外す">✕</button></span>`).join('');
    return `
      <div class="lr-attach">
        <div class="lr-attach-head">
          <span class="form-label">📎 ファイルを付ける <span class="text-muted">(見積書PDF・仕上がりイメージ。次に送るメッセージに添付されます)</span></span>
          <div class="lr-attach-buttons">
            ${folders && folders.length ? `<button type="button" class="btn btn-small btn-secondary" id="lr-pick-folder">案件フォルダから選ぶ</button>` : ''}
            <label class="btn btn-small btn-secondary" for="lr-photo-input">📷 写真を撮る/選ぶ</label>
            <input type="file" id="lr-photo-input" accept="image/*" capture="environment" class="sr-only">
            <label class="btn btn-small btn-secondary" for="lr-upload-input">📄 PDF・ファイル</label>
            <input type="file" id="lr-upload-input" accept=".pdf,.jpg,.jpeg,.png,.gif,.webp" class="sr-only">
          </div>
        </div>
        ${filesReady ? '' : '<div class="lr-error">公開URL(PUBLIC_ORDER_BASE_URL)が未設定のため、ファイルは送れません。</div>'}
        <div class="lr-attach-list" id="lr-attach-list">${chips || '<span class="text-muted">添付なし</span>'}</div>
      </div>`;
  }

  function renderDetail() {
    const { draft: d, user, messages, intakes } = state.detail;
    const pending = d.status === 'pending';
    const patch = d.intake_patch || {};
    const missing = (d.missing_info || []).length ? `<ul class="lr-missing">${d.missing_info.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '<span class="text-muted">なし</span>';
    const tools = (d.tool_calls || []).length ? d.tool_calls.map((t) => `${t.name}${t.ok ? '' : '(失敗)'}`).join('・') : 'なし';
    document.querySelector('.lr-layout').classList.add('lr-detail-open');
    el('lr-detail').innerHTML = `
      <button type="button" class="btn btn-small btn-ghost lr-back" id="lr-back">← 一覧へ戻る</button>
      <div class="lr-detail-head">
        <div>
          <h2 class="lr-detail-name">${esc(d.display_name || '(表示名なし)')} <span class="text-muted">#${d.id}</span></h2>
          <div class="lr-card-chips">
            ${chip(d.category || '(未分類)', 'lr-chip-cat')}
            ${chip(`注文タイプ: ${d.order_type || '不明'}`, '')}
            ${d.order_likelihood === 'high' ? chip('注文の可能性: 高', 'lr-chip-ok') : chip('注文の可能性: 低', '')}
            ${chip(STATUS_LABEL[d.status] || d.status, 'lr-chip-status')}
            ${flagChips(d.flags)}
            ${user && user.ai_reply_muted ? chip('AI下書き停止中', 'lr-chip-danger') : ''}
            ${user && user.price_profile ? chip(`価格: ${user.price_profile}`, '') : ''}
          </div>
        </div>
        <div class="lr-detail-actions">
          <button type="button" class="btn btn-small btn-secondary" id="lr-regen">🔁 作り直す</button>
          <button type="button" class="btn btn-small btn-ghost" id="lr-mute">${user && user.ai_reply_muted ? 'AI下書きを再開' : 'この相手のAI下書きを止める'}</button>
        </div>
      </div>

      ${formPanel(intakes)}

      <div class="lr-detail-grid">
        <section class="lr-conv" aria-label="やり取り">
          <h3 class="lr-h3">やり取り(直近30日)</h3>
          <div class="lr-conv-scroll" id="lr-conv">${messages.length ? messages.map(bubble).join('') : '<div class="empty-notice">履歴がありません</div>'}</div>
          <form class="lr-manual" id="lr-manual-form">
            <label for="lr-manual-text" class="form-label">自由に書いて送る(AIの下書きを使わない返信)</label>
            <textarea id="lr-manual-text" rows="3" placeholder="ここに書いて送ると、この会話にそのまま送信されます(ファイルだけ送るときは空のまま)"></textarea>
            <div class="lr-manual-actions"><button type="submit" class="btn btn-small btn-secondary">この文で送信</button></div>
          </form>
        </section>

        <section class="lr-draft" aria-label="AIの下書き">
          <h3 class="lr-h3">AIの下書き <span class="text-muted">${esc(d.summary || '')}</span></h3>
          ${d.error ? `<div class="lr-error">生成エラー: ${esc(d.error)}</div>` : ''}
          <textarea id="lr-draft-text" rows="12" ${pending ? '' : 'readonly'}>${esc(pending ? d.reply_text : (d.final_text || d.reply_text || ''))}</textarea>
          ${d.freee_quotation_number ? `<div class="lr-quote-note">🧾 freee見積書 No. ${esc(d.freee_quotation_number)} を発行済み${d.freee_report_url ? ` <a href="${esc(d.freee_report_url)}" target="_blank" rel="noopener">freeeで開く</a>` : ''}${state.detail.quote_file ? '(PDFを添付)' : '(PDFは手動で添付してください)'}</div>` : ''}
          ${pending ? `
          <div class="lr-draft-actions">
            <button type="button" class="btn btn-primary" id="lr-send">📤 このまま送信</button>
            <button type="button" class="btn btn-secondary" id="lr-quote" title="AIが会話から見積条件を組み立てて見積シミュレーターを開きます。金額の確認とfreeeへの発行は人が行います">🧾 見積を作る</button>
            <label class="lr-discard">
              <select id="lr-discard-reason">
                <option value="">送らない(理由を選ぶ)</option>
                <option value="返信不要">返信不要だった</option>
                <option value="自分で返した">別の方法で返した(LINEアプリ等)</option>
                <option value="内容が違う">内容が違う・使えない</option>
                <option value="人が判断">人が判断する案件</option>
                <option value="その他">その他</option>
              </select>
            </label>
          </div>` : `<p class="text-muted">${esc(STATUS_LABEL[d.status] || d.status)}${d.decided_by ? `・${esc(d.decided_by)}` : ''}${d.decided_at ? `・${esc(fmtTime(d.decided_at))}` : ''}${d.discard_reason ? `・理由: ${esc(d.discard_reason)}` : ''}${typeof d.edit_ratio === 'number' && d.status === 'edited' ? `・修正率 ${Math.round(d.edit_ratio * 100)}%` : ''}${typeof d.response_minutes === 'number' ? `・受信から${d.response_minutes}分` : ''}</p>`}

          <div id="lr-attach-panel">${attachmentsPanel()}</div>
          <div id="lr-intake-panel">${intakePanel(d, state.detail.lineIntakes)}</div>

          <details class="lr-more" open>
            <summary>AIのメモ・足りない情報・受注候補に足せる情報</summary>
            <dl class="lr-dl">
              <dt>承認者向けメモ</dt><dd>${esc(patch.reasoning_note || 'なし')}</dd>
              <dt>見積・受注に足りない情報</dt><dd>${missing}</dd>
              <dt>受注候補に足せる情報</dt><dd>${['customer_name', 'items', 'quantity', 'deadline', 'notes'].filter((k) => patch[k]).map((k) => `${{ customer_name: '顧客名', items: '内容', quantity: '数量', deadline: '希望納期', notes: 'メモ' }[k]}: ${esc(patch[k])}`).join('<br>') || 'なし'}</dd>
              <dt>使った価格ツール</dt><dd>${esc(tools)}</dd>
              <dt>生成</dt><dd>${esc(d.model || '')}・${esc(fmtTime(d.created_at))}・確信度 ${typeof d.confidence === 'number' ? Math.round(d.confidence * 100) + '%' : '-'}・トークン in ${d.input_tokens || 0}(cache ${d.cache_read_tokens || 0})/out ${d.output_tokens || 0}</dd>
            </dl>
          </details>
        </section>
      </div>`;

    const conv = el('lr-conv');
    if (conv) conv.scrollTop = conv.scrollHeight;

    if (pending) {
      const ta = el('lr-draft-text');
      const sendBtn = el('lr-send');
      const syncLabel = () => { sendBtn.textContent = ta.value.trim() !== String(d.reply_text || '').trim() ? '📤 直して送信' : '📤 このまま送信'; };
      ta.addEventListener('input', syncLabel);
      syncLabel();
      sendBtn.addEventListener('click', () => sendCurrent(d, ta.value));
      el('lr-discard-reason').addEventListener('change', (e) => { if (e.target.value) discardCurrent(d, e.target.value); });
      el('lr-quote').addEventListener('click', () => prepareQuote(d));
    }
    el('lr-back').addEventListener('click', () => {
      // スマホ幅では一覧と詳細を切り替えて見せる(PCでは両方見えているのでボタン自体を出さない)
      document.querySelector('.lr-layout').classList.remove('lr-detail-open');
      state.selectedId = null;
      renderList();
      window.scrollTo(0, 0);
    });
    el('lr-regen').addEventListener('click', () => regenerate(d.line_user_id));
    el('lr-mute').addEventListener('click', () => toggleMute(user));
    el('lr-manual-form').addEventListener('submit', (e) => { e.preventDefault(); sendManual(d.line_user_id, el('lr-manual-text').value); });
    bindAttachmentPanel();
    bindIntakePanel(d);
  }

  function bindIntakePanel(d) {
    const mk = el('lr-make-intake');
    if (mk) mk.addEventListener('click', async () => {
      const r = await postJson(`/api/line-reply/${d.id}/intake`, {});
      if (!r.ok) { HiUI.toast(r.error || '受注候補を作れませんでした', 'error'); return; }
      HiUI.toast(`受注候補 L-${r.intake_id} を作りました`, 'success');
      await selectDraft(d.id);
    });
    document.querySelectorAll('#lr-intake-panel [data-reject-intake]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('この受注候補を却下します。よろしいですか?')) return;
      const res = await fetch(`/api/ai-intake/${b.dataset.rejectIntake}/reject`, { method: 'POST' });
      if (!res.ok) { HiUI.toast('却下できませんでした', 'error'); return; }
      HiUI.toast('受注候補を却下しました', 'success');
      await selectDraft(d.id);
    }));
  }

  // ---- 添付 ----
  function refreshAttachmentPanel() {
    el('lr-attach-panel').innerHTML = attachmentsPanel();
    bindAttachmentPanel();
  }
  function bindAttachmentPanel() {
    const { draft: d, folders } = state.detail;
    const pickBtn = el('lr-pick-folder');
    if (pickBtn) pickBtn.addEventListener('click', () => pickFromFolder(folders, d.line_user_id));
    ['lr-upload-input', 'lr-photo-input'].forEach((id) => {
      const input = el(id);
      if (!input) return;
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        await uploadAttachment(file, d.line_user_id);
        input.value = '';
      });
    });
    document.querySelectorAll('#lr-attach-list [data-remove]').forEach((b) => b.addEventListener('click', () => {
      state.attachments.splice(parseInt(b.dataset.remove, 10), 1);
      refreshAttachmentPanel();
    }));
  }
  async function uploadAttachment(file, lineUserId) {
    if (file.size > 20 * 1024 * 1024) { HiUI.toast('ファイルが大きすぎます(上限20MB)', 'warning'); return; }
    HiUI.toast('ファイルを預かっています(PDFは画像化に数秒かかります)…', 'info');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('line_user_id', lineUserId);
    try {
      const res = await fetch('/api/line-reply/files/upload', { method: 'POST', body: fd });
      const r = await res.json();
      if (!r.ok) { HiUI.toast(r.error || 'アップロードに失敗しました', 'error'); return; }
      state.attachments.push(r.file);
      refreshAttachmentPanel();
      HiUI.toast(`${r.file.file_name} を付けました`, 'success');
    } catch (err) {
      HiUI.toast('アップロードに失敗しました', 'error');
    }
  }
  function pickFromFolder(folders, lineUserId) {
    if (!window.NasBrowse) { HiUI.toast('フォルダ閲覧の部品が読み込めていません', 'error'); return; }
    const onPick = async (entry) => {
      HiUI.toast('ファイルを預かっています(PDFは画像化に数秒かかります)…', 'info');
      const r = await postJson('/api/line-reply/files/from-folder', { path: entry.path, line_user_id: lineUserId });
      if (!r.ok) { HiUI.toast(r.error || '取り込みに失敗しました', 'error'); return; }
      state.attachments.push(r.file);
      refreshAttachmentPanel();
      HiUI.toast(`${r.file.file_name} を付けました`, 'success');
    };
    if (folders.length === 1) {
      NasBrowse.pick(folders[0].nas_folder_path, `${folders[0].project_name} / ${folders[0].customer_name}`, onPick);
      return;
    }
    // 案件が複数あるときは先に選ぶ(プロンプトで番号)
    const choice = prompt(`どの案件のフォルダを開きますか? 番号を入力\n${folders.map((f, i) => `${i + 1}: ${f.project_name}(${f.customer_name})`).join('\n')}`, '1');
    const idx = parseInt(choice, 10) - 1;
    if (!(idx >= 0 && idx < folders.length)) return;
    NasBrowse.pick(folders[idx].nas_folder_path, `${folders[idx].project_name} / ${folders[idx].customer_name}`, onPick);
  }
  // 見積を作る: AIが会話から見積条件を組み立て(10〜20秒)、見積シミュレーターを別タブで開く
  async function prepareQuote(d) {
    const btn = el('lr-quote');
    btn.disabled = true;
    btn.textContent = '🧾 条件を組み立て中…';
    HiUI.toast('AIが会話から見積条件を組み立てています(10〜20秒)…', 'info');
    try {
      const r = await postJson(`/api/line-reply/${d.id}/quote-prep`, {});
      if (!r.ok) { HiUI.toast(r.error || '見積条件を作れませんでした', 'error'); return; }
      const miss = (r.conditions.missing || []).length ? `確認が必要: ${r.conditions.missing.join('・')}` : '';
      HiUI.toast(`見積シミュレーターを開きます。${miss}`, 'success');
      const w = window.open(`/quote-sim?lr=${d.id}`, '_blank');
      if (!w) HiUI.toast('タブを開けませんでした。見積計算の画面を /quote-sim?lr=' + d.id + ' で開いてください', 'warning');
    } catch (err) {
      HiUI.toast('見積条件を作れませんでした', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🧾 見積を作る';
    }
  }
  function attachmentIds() { return state.attachments.map((f) => f.id); }
  function attachmentSummary() { return state.attachments.length ? `\n\n添付: ${state.attachments.map((f) => f.file_name).join('、')}` : ''; }

  function currentSender() {
    const v = el('lr-sender').value;
    if (!v) { HiUI.toast('送信者を選んでください', 'warning'); return null; }
    return v;
  }

  async function sendCurrent(d, text) {
    const sender = currentSender();
    if (!sender) return;
    const t = String(text || '').trim();
    if (!t && !state.attachments.length) { HiUI.toast('本文が空です', 'warning'); return; }
    if (!confirm(`「${d.display_name || 'このお客様'}」へ公式LINEで送信します。送ると取り消せません。よろしいですか?\n\n${t.slice(0, 200)}${t.length > 200 ? '…' : ''}${attachmentSummary()}`)) return;
    const r = await postJson(`/api/line-reply/${d.id}/send`, { text: t, sent_by: sender, attachment_ids: attachmentIds() });
    if (!r.ok) { HiUI.toast(r.error || '送信に失敗しました', 'error'); return; }
    HiUI.toast(`${r.status === 'edited' ? '直した文で送信しました' : 'そのまま送信しました'}${r.files ? `(ファイル${r.files}件つき)` : ''}`, 'success');
    state.attachments = [];
    await loadList();
    await selectDraft(d.id);
  }

  async function discardCurrent(d, reason) {
    const r = await postJson(`/api/line-reply/${d.id}/discard`, { reason, by: el('lr-sender').value || null });
    if (!r.ok) { HiUI.toast(r.error || '更新に失敗しました', 'error'); return; }
    HiUI.toast('送らない、として記録しました', 'success');
    await loadList();
    await selectDraft(d.id);
  }

  async function regenerate(lineUserId) {
    HiUI.toast('作り直しています(30秒ほどかかります)…', 'info');
    const r = await postJson(`/api/line-reply/users/${encodeURIComponent(lineUserId)}/regenerate`, {});
    if (!r.ok) { HiUI.toast(r.error || `作り直せませんでした(${r.skipped || ''})`, 'error'); return; }
    HiUI.toast('下書きを作り直しました', 'success');
    await loadList();
    if (r.draftId) await selectDraft(r.draftId);
  }

  async function toggleMute(user) {
    if (!user) return;
    const next = !user.ai_reply_muted;
    if (next && !confirm('この相手にはAIの下書きを作らなくなります。よろしいですか?')) return;
    const r = await postJson(`/api/line-reply/users/${encodeURIComponent(user.line_user_id)}/mute`, { muted: next });
    if (!r.ok) { HiUI.toast('更新に失敗しました', 'error'); return; }
    HiUI.toast(next ? 'この相手のAI下書きを止めました' : 'この相手のAI下書きを再開しました', 'success');
    if (state.selectedId) await selectDraft(state.selectedId);
  }

  async function sendManual(lineUserId, text) {
    const sender = currentSender();
    if (!sender) return;
    const t = String(text || '').trim();
    if (!t && !state.attachments.length) { HiUI.toast('本文が空です', 'warning'); return; }
    if (!confirm(`この文を公式LINEで送信します。送ると取り消せません。よろしいですか?\n\n${t.slice(0, 200)}${t.length > 200 ? '…' : ''}${attachmentSummary()}`)) return;
    const r = await postJson(`/api/line-reply/users/${encodeURIComponent(lineUserId)}/send`, { text: t, sent_by: sender, attachment_ids: attachmentIds() });
    if (!r.ok) { HiUI.toast(r.error || '送信に失敗しました', 'error'); return; }
    HiUI.toast(`送信しました${r.files ? `(ファイル${r.files}件つき)` : ''}`, 'success');
    state.attachments = [];
    await loadList();
    if (state.selectedId) await selectDraft(state.selectedId);
  }

  // ---- 初期化 ----
  async function setupSenders() {
    try {
      const data = await getJson('/api/line-reply/senders');
      state.senders = data.senders || [];
    } catch (_) { state.senders = ['三浦', '山本', '久保田']; }
    const sel = el('lr-sender');
    let saved = '';
    try { saved = localStorage.getItem(SENDER_KEY) || ''; } catch (_) { /* noop */ }
    sel.innerHTML = '<option value="">選んでください</option>' + state.senders.map((n) => `<option value="${esc(n)}"${n === saved ? ' selected' : ''}>${esc(n)}</option>`).join('');
    sel.addEventListener('change', () => { try { localStorage.setItem(SENDER_KEY, sel.value); } catch (_) { /* noop */ } });
  }

  function setupTabs() {
    document.querySelectorAll('.lr-tabs [data-status]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        state.status = btn.dataset.status;
        document.querySelectorAll('.lr-tabs [data-status]').forEach((b) => {
          const on = b === btn;
          b.classList.toggle('btn-primary', on); b.classList.toggle('btn-secondary', !on); b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        await loadList();
      });
    });
  }

  async function openFromHash() {
    const m = (location.hash || '').match(/^#draft-(\d+)$/);
    if (m) await selectDraft(parseInt(m[1], 10));
  }

  document.addEventListener('DOMContentLoaded', async () => {
    setupTabs();
    await setupSenders();
    try { await loadList(); } catch (err) { el('lr-list').innerHTML = `<div class="empty-notice">読み込みに失敗しました(${esc(err.message)})</div>`; }
    await openFromHash();
    window.addEventListener('hashchange', openFromHash);
    setInterval(() => { if (state.status === 'pending') loadList().catch(() => {}); }, 60 * 1000);
  });
})();
