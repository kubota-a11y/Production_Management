// 紹介ページ(/referral)。紹介コードを照合し、通ったらその方専用の内容を表示する。
// 公開ページなので、APIは 200 + {ok:false} でも失敗を返してくる想定で扱う。
(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);

  const gate = $('#gate');
  const panel = $('#panel');
  const errBox = $('#err');
  const codeInput = $('#code');
  const submitBtn = $('#submitBtn');

  function showError(msg) {
    errBox.textContent = msg;
    errBox.hidden = !msg;
  }

  function benefitHtml(list) {
    return (list || []).map(b => {
      const div = document.createElement('div');
      div.className = 'ben';
      const t = document.createElement('b');
      t.textContent = b.t;
      const d = document.createElement('p');
      d.textContent = b.d;
      div.append(t, d);
      return div;
    });
  }

  function render(data) {
    $('#pType').textContent = `${data.partner.type_label}のご紹介`;
    $('#pName').textContent = `${data.partner.name} 様`;
    $('#pCode').textContent = data.partner.code;

    const share = $('#shareUrl');
    if (data.share_url) {
      share.value = data.share_url;
    } else {
      // PUBLIC_ORDER_BASE_URL 未設定時はリンクを出さない(誤ったURLを配らせない)
      share.closest('.share').previousElementSibling.hidden = true;
      share.closest('.share').hidden = true;
    }

    $('#benYou').replaceChildren(...benefitHtml(data.benefits.forYou));
    $('#benFriend').replaceChildren(...benefitHtml(data.benefits.forFriend));
    $('#stTotal').textContent = data.stats.total || 0;
    $('#stConfirmed').textContent = data.stats.confirmed || 0;

    gate.hidden = true;
    panel.hidden = false;
    window.scrollTo(0, 0);
  }

  async function verify() {
    const code = (codeInput.value || '').trim();
    if (!code) { showError('紹介コードを入力してください。'); codeInput.focus(); return; }
    showError('');
    submitBtn.disabled = true;
    submitBtn.textContent = '確認中...';
    try {
      const res = await fetch('/api/referral/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.ok) {
        render(data);
        return;
      }
      showError((data && data.error) || '確認できませんでした。時間をおいて再度お試しください。');
    } catch (_) {
      showError('通信に失敗しました。電波の良い場所で再度お試しください。');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '確認する';
    }
  }

  submitBtn.addEventListener('click', verify);
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); verify(); }
  });

  // URLに ?code= が付いていれば自動で確認する(カードのQRから直接開いた場合)
  const preset = new URLSearchParams(location.search).get('code');
  if (preset) {
    codeInput.value = preset.trim().toUpperCase();
    verify();
  }

  // ---- 共有 ----
  $('#copyBtn').addEventListener('click', async () => {
    const btn = $('#copyBtn');
    const url = $('#shareUrl').value;
    try {
      await navigator.clipboard.writeText(url);
    } catch (_) {
      // クリップボードが使えない環境では選択状態にして手動コピーしてもらう
      $('#shareUrl').select();
      document.execCommand && document.execCommand('copy');
    }
    const before = btn.textContent;
    btn.textContent = 'コピーしました';
    setTimeout(() => { btn.textContent = before; }, 1600);
  });

  $('#shareBtn').addEventListener('click', async () => {
    const url = $('#shareUrl').value;
    const text = `HiYOSHiでオリジナルウェアをつくるとき、この紹介リンクから相談すると特典があります。\n${url}`;
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (_) { /* キャンセルは何もしない */ }
    }
    // 共有APIが無い環境(PCのブラウザ等)はメール下書きに逃がす
    location.href = `mailto:?subject=${encodeURIComponent('HiYOSHi のご紹介')}&body=${encodeURIComponent(text)}`;
  });
})();
