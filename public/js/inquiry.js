// 公式LINE 入口別お問い合わせフォーム(/inquiry, /inquiry/{kind})の画面側。
// 項目はサーバー(lib/inquiry-kinds.js)から window.__INQUIRY_CONFIG__ で受け取り、ここでは描画と送信だけを行う。
// 入口を足す・項目を変えるときはこのファイルを触らなくてよい。
(() => {
  'use strict';

  const CFG = window.__INQUIRY_CONFIG__ || { kinds: [], current: null, turnstileSiteKey: '', maxFiles: 5 };
  const $ = (sel) => document.querySelector(sel);

  // 流入元(?src=line など)。入口選択→各フォームへも引き継ぐ
  const SRC = ((new URLSearchParams(location.search).get('src') || '').match(/^[a-z0-9_-]{1,20}$/i) || [''])[0];
  const withSrc = (path) => SRC ? `${path}?src=${encodeURIComponent(SRC)}` : path;

  // ===== 入口選択ページ =====
  function renderChooser() {
    const wrap = $('#chooser');
    const list = $('#chooserList');
    wrap.hidden = false;
    CFG.kinds.forEach(k => {
      const a = document.createElement('a');
      a.className = 'entry-card';
      a.href = withSrc(`/inquiry/${k.slug}`);
      const icon = document.createElement('span');
      icon.className = 'entry-icon';
      icon.textContent = k.icon;
      const body = document.createElement('span');
      body.className = 'entry-body';
      const strong = document.createElement('strong');
      strong.textContent = `${k.label}のご相談はこちら`;
      const small = document.createElement('small');
      small.textContent = k.note;
      body.append(strong, small);
      const arrow = document.createElement('span');
      arrow.className = 'entry-arrow';
      arrow.textContent = '›';
      a.append(icon, body, arrow);
      list.appendChild(a);
    });
  }

  // ===== 入口別フォーム =====
  const K = CFG.current;
  const controls = {}; // key -> { field, get(), el(表示切替用のラッパー) }

  function fieldWrapper(field) {
    const isCheck = field.type === 'checkbox' || field.type === 'checkboxes';
    const wrap = document.createElement(isCheck ? 'div' : 'label');
    wrap.className = 'field' + (field.half ? ' half' : ' full');
    wrap.dataset.key = field.key;
    const title = document.createElement('span');
    title.className = 'field-title';
    title.textContent = field.label + ' ';
    const mark = document.createElement('span');
    mark.className = field.required ? 'req' : 'opt';
    mark.textContent = field.required ? '必須' : '任意';
    if (field.requiredIf) mark.hidden = true; // 条件付き必須は表示時に付け替える
    title.appendChild(mark);
    wrap.appendChild(title);
    return { wrap, mark };
  }

  function buildControl(field) {
    const { wrap, mark } = fieldWrapper(field);
    let get;
    switch (field.type) {
      case 'select': {
        const sel = document.createElement('select');
        sel.name = field.key;
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = '選択してください';
        sel.appendChild(empty);
        field.options.forEach(o => {
          const op = document.createElement('option');
          op.value = o.value;
          op.textContent = o.label;
          sel.appendChild(op);
        });
        wrap.appendChild(sel);
        get = () => sel.value;
        break;
      }
      case 'checkboxes': {
        const row = document.createElement('div');
        row.className = 'check-row';
        const boxes = field.options.map(o => {
          const lab = document.createElement('label');
          lab.className = 'check-card';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.name = field.key;
          cb.value = o.value;
          const txt = document.createElement('span');
          txt.textContent = o.label;
          lab.append(cb, txt);
          row.appendChild(lab);
          return cb;
        });
        wrap.appendChild(row);
        get = () => boxes.filter(b => b.checked).map(b => b.value);
        break;
      }
      case 'checkbox': {
        const lab = document.createElement('label');
        lab.className = 'check-card single';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.name = field.key;
        const txt = document.createElement('span');
        txt.textContent = field.label;
        lab.append(cb, txt);
        // 見出しは重複するので消し、チェック行だけにする
        wrap.querySelector('.field-title').remove();
        wrap.appendChild(lab);
        cb.addEventListener('change', applyConditions);
        get = () => cb.checked;
        break;
      }
      case 'textarea': {
        const ta = document.createElement('textarea');
        ta.name = field.key;
        ta.rows = 4;
        if (field.maxlength) ta.maxLength = field.maxlength;
        if (field.placeholder) ta.placeholder = field.placeholder;
        wrap.appendChild(ta);
        get = () => ta.value.trim();
        break;
      }
      default: {
        const inp = document.createElement('input');
        inp.type = field.type === 'tel' ? 'tel' : field.type === 'email' ? 'email' : field.type === 'date' ? 'date' : 'text';
        inp.name = field.key;
        if (field.maxlength) inp.maxLength = field.maxlength;
        if (field.placeholder) inp.placeholder = field.placeholder;
        if (field.type === 'tel') inp.autocomplete = 'tel';
        if (field.type === 'email') inp.autocomplete = 'email';
        if (field.key === 'contact_name') inp.autocomplete = 'name';
        wrap.appendChild(inp);
        get = () => inp.value.trim();
      }
    }
    if (field.hint) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = field.hint;
      wrap.appendChild(hint);
    }
    controls[field.key] = { field, get, el: wrap, mark };
    return wrap;
  }

  // requiredIf の条件で表示と必須マークを切り替える
  function applyConditions() {
    Object.values(controls).forEach(c => {
      const cond = c.field.requiredIf;
      if (!cond) return;
      const src = controls[cond.key];
      const on = src ? src.get() === cond.equals : false;
      c.el.hidden = !on;
      c.mark.hidden = !on;
      c.mark.className = 'req';
      c.mark.textContent = '必須';
    });
  }

  function renderForm() {
    $('#formWrap').hidden = false;
    $('#formTitle').textContent = `${K.icon} ${K.title}`;
    $('#formLead').textContent = K.lead;
    $('#backToChooser').href = withSrc('/inquiry');
    document.title = `${K.title} | HIYOSHI`;

    // section が連続する項目を1枚のカードにまとめる
    const root = $('#sections');
    let secNo = 0;
    let currentSection = null;
    let grid = null;
    K.fields.forEach(f => {
      if (f.section !== currentSection) {
        currentSection = f.section;
        secNo += 1;
        const card = document.createElement('section');
        card.className = 'card';
        const h2 = document.createElement('h2');
        h2.textContent = `${secNo}. ${f.section}`;
        card.appendChild(h2);
        grid = document.createElement('div');
        grid.className = 'grid2';
        card.appendChild(grid);
        root.appendChild(card);
      }
      grid.appendChild(buildControl(f));
    });
    $('.sec-no').textContent = `${secNo + 1}. `;
    applyConditions();
  }

  // ===== Turnstile =====
  let turnstileWidgetId = null;
  function loadTurnstile() {
    if (!CFG.turnstileSiteKey) return;
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => {
      turnstileWidgetId = window.turnstile.render('#turnstileContainer', { sitekey: CFG.turnstileSiteKey });
    };
    document.head.appendChild(script);
  }
  function getTurnstileToken() {
    if (!CFG.turnstileSiteKey || !window.turnstile) return '';
    return window.turnstile.getResponse(turnstileWidgetId) || '';
  }

  // ===== 検証(サーバーと同じ考え方の最小版。最終判定はサーバー) =====
  function validate() {
    const errs = [];
    Object.values(controls).forEach(c => {
      const f = c.field;
      if (c.el.hidden) return;
      const v = c.get();
      const must = f.required || (f.requiredIf && !c.el.hidden);
      const empty = Array.isArray(v) ? v.length === 0 : (typeof v === 'boolean' ? !v : !v);
      if (must && empty && f.type !== 'checkbox') errs.push({ field: f.key, message: `${f.label}を入力してください` });
      if (!empty && f.type === 'tel' && !/^[\d\-+()\s]{7,20}$/.test(v)) errs.push({ field: f.key, message: '電話番号の形式が不正です' });
      if (!empty && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) errs.push({ field: f.key, message: 'メールアドレスの形式が不正です' });
    });
    return errs;
  }

  function showErrors(errors) {
    const box = $('#formErrors');
    box.innerHTML = '';
    const ul = document.createElement('ul');
    errors.forEach(e => {
      const li = document.createElement('li');
      li.textContent = e.message;
      ul.appendChild(li);
    });
    box.appendChild(ul);
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // 最初のエラー項目にフォーカス
    const first = errors.find(e => controls[e.field]);
    if (first) {
      const input = controls[first.field].el.querySelector('input, select, textarea');
      if (input) input.focus();
    }
  }

  function summaryRows() {
    return Object.values(controls)
      .filter(c => !c.el.hidden && (c.field.required || c.field.type === 'checkbox'))
      .map(c => {
        const v = c.get();
        const text = typeof v === 'boolean' ? (v ? 'はい' : 'いいえ') : (v || '(未入力)');
        return [c.field.label, text];
      });
  }

  function collectPayload() {
    const payload = { _src: SRC };
    Object.values(controls).forEach(c => { payload[c.field.key] = c.el.hidden ? '' : c.get(); });
    return payload;
  }

  async function send() {
    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = '送信中...';
    try {
      const files = Array.from($('#referenceImages').files || []);
      if (files.length > CFG.maxFiles) {
        showErrors([{ message: `添付は最大${CFG.maxFiles}件までです` }]);
        return;
      }
      const oversize = files.find(f => f.size > 15 * 1024 * 1024);
      if (oversize) {
        showErrors([{ message: `ファイル「${oversize.name}」が大きすぎます(上限15MB)。サイズを小さくして再度お試しください。` }]);
        return;
      }
      const fd = new FormData();
      fd.append('payload', JSON.stringify(collectPayload()));
      fd.append('hp_url', $('#inquiryForm').hp_url.value || '');
      fd.append('cf-turnstile-response', getTurnstileToken());
      files.forEach(f => fd.append('images', f));

      const resp = await fetch(`/api/inquiry/${encodeURIComponent(K.slug)}`, { method: 'POST', body: fd });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.ok) {
        $('#inquiryForm').hidden = true;
        const done = $('#donePanel');
        done.hidden = false;
        $('#doneMessage').textContent = `${K.label}のご相談を受け付けました。`;
        if (data.receipt_no) {
          $('#doneReceiptNo').textContent = data.receipt_no;
          $('#doneReceipt').hidden = false;
        }
        if (data.receipt_mail) $('#doneMailNote').hidden = false;
        if (data.sample_requested) $('#doneSampleNote').hidden = false;
        if (data.image_warning) $('#doneImageWarning').hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        showErrors(data.errors && data.errors.length ? data.errors
          : [{ message: '送信に失敗しました。時間をおいて再度お試しください。' }]);
        if (CFG.turnstileSiteKey && window.turnstile) window.turnstile.reset(turnstileWidgetId);
      }
    } catch (err) {
      showErrors([{ message: '通信エラーが発生しました。接続をご確認のうえ再度お試しください。' }]);
    } finally {
      btn.disabled = false;
      btn.textContent = '送信する';
    }
  }

  // ===== 起動 =====
  if (!K) {
    renderChooser();
    return;
  }
  renderForm();
  loadTurnstile();
  FormGuard.blockEnterSubmit();
  $('#inquiryForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    $('#formErrors').hidden = true;
    const errs = validate();
    if (errs.length) { showErrors(errs); return; }
    FormGuard.confirm(summaryRows(), send);
  });
})();
