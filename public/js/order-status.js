// お客様向け進捗確認ページ(/status)のクライアントロジック。
// 受付番号+電話番号下4桁をPOSTし、一致した場合のみ進捗を表示する。
(function () {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const form = $('#lookupForm');
  const errBox = $('#errBox');
  const resultCard = $('#resultCard');
  const STAGE_LABELS = ['受付済み', '製作中', '検品・出荷準備中', '納品済み'];

  function showError(message) {
    errBox.textContent = message;
    errBox.hidden = false;
    resultCard.hidden = true;
  }

  // 'YYYY-MM-DD' → '2026年8月3日(月)'。不正な値はそのまま返す
  function formatDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const week = ['日', '月', '火', '水', '木', '金', '土'][date.getDay()];
    return `${y}年${m}月${d}日(${week})`;
  }

  function renderSteps(stage) {
    const box = $('#resSteps');
    box.textContent = '';
    STAGE_LABELS.forEach((label, i) => {
      const step = document.createElement('div');
      step.className = 'step' + (i < stage ? ' done' : '');
      const bar = document.createElement('div');
      bar.className = 'step-bar';
      const text = document.createElement('span');
      text.textContent = label;
      step.append(bar, text);
      box.appendChild(step);
    });
  }

  function renderResult(data) {
    errBox.hidden = true;
    $('#resReceipt').textContent = `受付番号 ${data.receipt_no}`;
    $('#resName').textContent = data.project_name || 'ご注文内容を確認中です';
    const pill = $('#resStage');
    pill.textContent = data.stage_label;
    pill.className = `stage-pill stage-${data.stage}`;
    $('#resNote').textContent = data.stage_note || '';
    renderSteps(data.stage);

    // 納品予定日は納品前のみ、納品日は納品済みのみ表示する
    const deadlineRow = $('#resDeadlineRow');
    if (data.deadline && data.stage < 4) {
      $('#resDeadline').textContent = formatDate(data.deadline);
      deadlineRow.hidden = false;
    } else {
      deadlineRow.hidden = true;
    }
    const deliveredRow = $('#resDeliveredRow');
    if (data.delivered_date) {
      $('#resDelivered').textContent = formatDate(data.delivered_date);
      deliveredRow.hidden = false;
    } else {
      deliveredRow.hidden = true;
    }

    resultCard.hidden = false;
    resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('#submitBtn');
    const receiptNo = $('#receiptNo').value.trim();
    const phoneLast4 = $('#phoneLast4').value.trim();

    if (!receiptNo || !/^\d{4}$/.test(phoneLast4)) {
      showError('受付番号(例: W-123)と、電話番号の下4桁(数字4桁)をご入力ください。');
      return;
    }

    btn.disabled = true;
    btn.textContent = '確認中…';
    try {
      const res = await fetch('/api/order-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt_no: receiptNo, phone_last4: phoneLast4 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showError(data.error || '確認に失敗しました。時間をおいて再度お試しください。');
        return;
      }
      renderResult(data);
    } catch (err) {
      showError('通信エラーが発生しました。接続をご確認のうえ再度お試しください。');
    } finally {
      btn.disabled = false;
      btn.textContent = '進捗を確認する';
    }
  });

  $('#againBtn').addEventListener('click', () => {
    resultCard.hidden = true;
    errBox.hidden = true;
    $('#receiptNo').value = '';
    $('#phoneLast4').value = '';
    $('#receiptNo').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
