// 公開フォーム共通の誤送信対策(取引先の加工依頼 / チーム追加注文 / Webご注文フォーム)。
//
// 実際に起きた事故: 入力途中でEnterキーを押してしまい、そのまま送信されてしまう。
// ブラウザは標準で「1行入力欄でEnter = フォーム送信」という動作をするため、
// 下記の2段構えで防ぐ。
//   1) blockEnterSubmit() … 1行入力欄でのEnterによる送信を無効化する(根本対策)
//   2) confirm()          … 送信前に内容の要約つき確認ウィンドウを出す
//
// 2)だけだと「Enter2回」で送信できてしまうため、1)と併用することに意味がある。
// 確認ウィンドウは「送信する」ボタンに自動でフォーカスを当てないので、
// ウィンドウが開いた状態でEnterを連打しても送信されない。
window.FormGuard = (() => {
  'use strict';

  let overlay = null;
  let onConfirm = null;

  // 確認ウィンドウのスタイル。各フォームのHTMLに書かずここで一度だけ注入する
  const CSS = `
    .fg-overlay { position: fixed; inset: 0; background: rgba(15,23,42,.55); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 1000; }
    .fg-overlay[hidden] { display: none; }
    .fg-box { background: #fff; border-radius: 14px; padding: 22px 24px; max-width: 460px; width: 100%; max-height: 88vh; overflow-y: auto; box-shadow: 0 20px 40px rgba(0,0,0,.25); }
    .fg-box h2 { font-size: 1.15rem; margin: 0 0 6px; color: #1e293b; }
    .fg-lead { font-size: .87rem; color: #b91c1c; margin: 0 0 14px; }
    .fg-summary { margin: 0 0 18px; font-size: .9rem; border-top: 1px solid #e2e8f0; }
    .fg-summary div { display: flex; gap: 10px; padding: 7px 2px; border-bottom: 1px solid #f1f5f9; }
    .fg-summary dt { flex: none; width: 7.5em; color: #64748b; font-weight: 600; }
    .fg-summary dd { margin: 0; color: #1e293b; word-break: break-word; }
    .fg-actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
    .fg-actions button { border-radius: 8px; padding: 11px 20px; font-size: .95rem; font-weight: 700; cursor: pointer; border: none; }
    .fg-cancel { border: 1px solid #cbd5e1 !important; background: #fff; color: #475569; }
    .fg-cancel:hover { background: #f1f5f9; }
    .fg-send { background: #2563eb; color: #fff; }
    .fg-send:hover { background: #1d4ed8; }
    @media (max-width: 480px) {
      .fg-actions { flex-direction: column-reverse; }
      .fg-actions button { width: 100%; }
    }
  `;

  function build() {
    if (overlay) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    overlay = document.createElement('div');
    overlay.className = 'fg-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="fg-box" role="dialog" aria-modal="true" aria-labelledby="fgTitle">
        <h2 id="fgTitle">この内容で送信しますか?</h2>
        <p class="fg-lead">送信後の取り消しはできません。内容をご確認ください。</p>
        <dl class="fg-summary"></dl>
        <div class="fg-actions">
          <button type="button" class="fg-cancel">キャンセル(修正する)</button>
          <button type="button" class="fg-send">送信する</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('.fg-send').addEventListener('click', () => {
      const cb = onConfirm;
      close();
      if (cb) cb();
    });
    overlay.querySelector('.fg-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && overlay && !overlay.hidden) close();
    });
  }

  function close() {
    onConfirm = null;
    if (overlay) overlay.hidden = true;
  }

  return {
    // 1行入力欄でのEnterによる送信を無効化する。
    // textarea は改行として必要なので対象外。日本語入力の変換確定(isComposing)も素通しし、
    // ボタン・リンク上のEnterは通常の操作として通す(キーボードだけで操作する人のため)。
    blockEnterSubmit() {
      document.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || ev.isComposing) return;
        const el = ev.target;
        if (!(el instanceof HTMLElement)) return;
        if (el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON' || el.tagName === 'A') return;
        if (el.tagName === 'INPUT' || el.tagName === 'SELECT') ev.preventDefault();
      });
    },

    // 送信前の確認ウィンドウを出す。
    // rows: [['ラベル', '値'], ...] / callback: 「送信する」が押されたときに実行する処理
    confirm(rows, callback) {
      build();
      onConfirm = callback;
      const dl = overlay.querySelector('.fg-summary');
      dl.innerHTML = '';
      (rows || []).forEach(([label, value]) => {
        const wrap = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        wrap.append(dt, dd);
        dl.appendChild(wrap);
      });
      overlay.hidden = false;
      // あえて「送信する」にフォーカスを当てない(Enter連打での確定を防ぐため)
      if (document.activeElement) document.activeElement.blur();
    },
  };
})();
