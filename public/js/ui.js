// ========================================
// HiBoard 社内画面の共通UI(共有モジュール)
//
// 1. ヘッダーナビゲーション: 各ページのHTMLにコピペで持たせず、ここから生成する
// 2. モーダル共通挙動: Escキー・背景クリックで閉じる / フォーカス管理 / role=dialog
// 3. トースト通知: alert() の代わりに使う(画面をブロックしない)
//
// 読み込み順の制約はない。<head> でも </body> 直前でもよい。
// ========================================

const HiUI = {
  // ========================================
  // ヘッダーナビゲーション
  // ========================================

  // 日常業務で毎日使うリンク。ここは常に表に出す。
  // designer-board は担当者名が分かり次第ラベルを差し替える(下の applyDesignerNavLabel)
  navDaily: [
    { key: 'schedule', href: '/schedule', label: '🗓️ スケジュール' },
    { key: 'designer-board', href: '/designer', label: '🎨 デザインの作業予定' },
    { key: 'ops', href: '/ops', label: '🗂 デザイン進行ボード' },
    { key: 'delivery-history', href: '/delivery-history', label: '📦 納品履歴' },
    { key: 'customers', href: '/customers', label: '📇 顧客台帳' },
    { key: 'manual', href: '/manual', label: '📖 使い方' },
  ],

  // 設定・発行系。毎日は使わないので「⚙ 管理」の中に畳む
  navAdmin: [
    // 毎日見る画面ではなく、社長が週次・月次で振り返るための画面なのでここに畳む
    // (navDaily に足すと横並びのリンクが増えて、全画面でタイトルが2行に折り返す)
    { key: 'workload', href: '/workload', label: '📊 業務量レポート' },
    { divider: true },
    { key: 'staff', href: '/?open=staff', label: '👥 担当者マスタ（案件の窓口）' },
    { key: 'employees', href: '/employees', label: '🧑‍🏭 従業員マスタ（作業する人）' },
    { divider: true },
    { key: 'team-links', href: '/team-links', label: '🔗 チームリンク発行' },
    { key: 'partner-links', href: '/partner-links', label: '🤝 取引先リンク発行' },
    { key: 'designer-links', href: '/designer-links', label: '🎨 デザイナーリンク発行' },
    { key: 'referral-admin', href: '/referral-admin', label: '🎁 紹介コード発行' },
    { divider: true },
    { key: 'works-add', href: '/works-add', label: '📸 制作実績の登録' },
    { key: 'backup-status', href: '/backup-status', label: '🛡 バックアップ状態' },
  ],

  /**
   * data-nav 属性を持つ .header-buttons の中身を生成する。
   * data-nav の値が現在のページのキー(例 "customers")。トップは "home"。
   */
  mountHeaderNav() {
    document.querySelectorAll('[data-nav]').forEach((container) => {
      const current = container.dataset.nav;
      const parts = [];

      // トップ以外には必ずHiBoardへの戻り導線を置く
      if (current !== 'home') {
        parts.push('<a class="nav-link nav-link-home" href="/">📋 HiBoard</a>');
      }

      this.navDaily.forEach((item) => {
        parts.push(this.navLinkHtml(item, current));
      });

      const adminItems = this.navAdmin
        .map((item) => (item.divider ? '<hr class="nav-menu-divider">' : this.navLinkHtml(item, current, true)))
        .join('');
      const adminActive = this.navAdmin.some((item) => item.key && item.key === current);
      parts.push(`
        <div class="nav-menu" data-open="false">
          <button type="button" class="nav-menu-toggle" aria-expanded="false" aria-haspopup="true"
            ${adminActive ? 'aria-current="page"' : ''}>⚙ 管理 ▾</button>
          <div class="nav-menu-list" role="menu">${adminItems}</div>
        </div>
      `);

      container.innerHTML = parts.join('');
      container.setAttribute('data-collapsed', 'true');
      this.setupNavMenus(container);
      this.mountNavCollapseToggle(container);
    });
  },

  navLinkHtml(item, current, insideMenu = false) {
    const isCurrent = item.key === current;
    const attrs = isCurrent ? ' aria-current="page"' : '';
    const cls = insideMenu ? '' : ' class="nav-link"';
    // 表示中のページはリンクにせず、押しても何も起きないことを明示する
    if (isCurrent) {
      return `<a${cls} href="${item.href}"${attrs} onclick="return false">${item.label}</a>`;
    }
    return `<a${cls} href="${item.href}"${attrs}>${item.label}</a>`;
  },

  // デザイナーのボードへのリンクに担当者名を入れる(「🎨 鈴木さんの作業予定」)。
  // 誰が担当かは designer_links 次第なので固定文字にはしない。
  // 取得できるまで/失敗時は既定ラベル(🎨 デザインの作業予定)のままにして、ボタン自体は必ず出す。
  // 同じセッション中は sessionStorage のキャッシュを使い、ページ移動ごとの取得と
  // ラベルの後追い変化を避ける
  DESIGNER_NAME_KEY: 'hiboard.designerName',
  DESIGNER_DEFAULT_LABEL: '🎨 デザインの作業予定',

  applyDesignerNavLabel(name) {
    document.querySelectorAll('.nav-link[href="/designer"]').forEach((el) => {
      el.textContent = name ? `🎨 ${name}さんの作業予定` : this.DESIGNER_DEFAULT_LABEL;
    });
  },

  forgetDesignerName() {
    try {
      sessionStorage.removeItem(this.DESIGNER_NAME_KEY);
    } catch (_) { /* noop */ }
    this.applyDesignerNavLabel(null);
  },

  async loadDesignerNavLabel() {
    if (!document.querySelector('.nav-link[href="/designer"]')) return;

    // 前回の名前があれば先に当てて、ページ移動ごとにラベルが後から変わるのを防ぐ。
    // そのうえで必ず取得し直す(担当者が変わったときに古い名前を出したままにしない)
    try {
      this.applyDesignerNavLabel(sessionStorage.getItem(this.DESIGNER_NAME_KEY));
    } catch (_) { /* sessionStorageが使えない環境では既定ラベルから始まるだけ */ }

    try {
      const res = await fetch('/api/designer-shortcut');
      if (!res.ok) return;
      const data = await res.json();
      // リンクが無効化・削除された場合は覚えていた名前を捨てて既定ラベルに戻す
      // (別人の名前のままボードを開かせないため)
      if (!data.ok || !data.name) {
        this.forgetDesignerName();
        return;
      }
      this.applyDesignerNavLabel(data.name);
      try {
        sessionStorage.setItem(this.DESIGNER_NAME_KEY, data.name);
      } catch (_) { /* noop */ }
    } catch (_) {
      /* 通信できなかったときは覚えていた名前のまま。リンク自体は機能する */
    }
  },

  setupNavMenus(container) {
    container.querySelectorAll('.nav-menu').forEach((menu) => {
      const toggle = menu.querySelector('.nav-menu-toggle');
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = menu.dataset.open === 'true';
        menu.dataset.open = open ? 'false' : 'true';
        toggle.setAttribute('aria-expanded', String(!open));
      });
      // 外側クリック・Escで閉じる
      document.addEventListener('click', (e) => {
        if (!menu.contains(e.target)) {
          menu.dataset.open = 'false';
          toggle.setAttribute('aria-expanded', 'false');
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && menu.dataset.open === 'true') {
          menu.dataset.open = 'false';
          toggle.setAttribute('aria-expanded', 'false');
          toggle.focus();
        }
      });
    });
  },

  // スマホ幅ではナビを畳み、「☰ メニュー」で開閉する
  mountNavCollapseToggle(container) {
    const headerContent = container.parentElement?.querySelector('.header-content');
    if (!headerContent || headerContent.querySelector('.nav-collapse-toggle')) return;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'nav-collapse-toggle nav-menu-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', container.id || 'header-buttons');
    toggle.textContent = '☰ メニュー';
    if (!container.id) container.id = 'header-buttons';
    toggle.addEventListener('click', () => {
      const collapsed = container.getAttribute('data-collapsed') !== 'false';
      container.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
      toggle.setAttribute('aria-expanded', String(collapsed));
    });
    headerContent.appendChild(toggle);
  },

  // ========================================
  // モーダル共通挙動
  //
  // 各ページが持つ閉じる処理(フォームのリセット等)を活かすため、
  // 閉じるときはモーダル内の .btn-close を実際にクリックする。
  // ========================================

  /** 表示中のモーダルを手前にあるものから順に返す */
  openModals() {
    return Array.from(document.querySelectorAll('.modal, .image-lightbox')).filter((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
  },

  closeModal(modal) {
    if (!modal) return;
    // 必ずヘッダーの閉じるボタンを優先する。
    // カンマ区切りの querySelector は「文書順で最初の一致」を返すため、
    // 行削除ボタンにも .btn-close を使っている画面(リンク管理)で
    // 誤って行を消してしまう。だから優先順位ごとに探す
    const closeBtn = modal.querySelector('.modal-header .btn-close')
      || modal.querySelector('[data-modal-close]');
    if (closeBtn) {
      closeBtn.click();
    } else {
      modal.style.display = 'none';
      modal.classList.remove('active');
    }
  },

  setupModalBehavior() {
    // --- 背景(オーバーレイ)クリックで閉じる ---
    document.addEventListener('click', (e) => {
      const target = e.target;
      if (target instanceof Element && (target.classList.contains('modal') || target.classList.contains('image-lightbox'))) {
        this.closeModal(target);
      }
    });

    // --- Escキーで手前のモーダルを閉じる ---
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = this.openModals();
      if (!open.length) return;
      e.preventDefault();
      this.closeModal(open[open.length - 1]);
    });

    // --- Tabキーをモーダル内に閉じ込める ---
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const open = this.openModals();
      if (!open.length) return;
      const modal = open[open.length - 1];
      const focusables = modal.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
      );
      const visible = Array.from(focusables).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!visible.length) return;
      const first = visible[0];
      const last = visible[visible.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    // --- 属性の付与とフォーカスの移動/復帰 ---
    this.prepareModalAria();
    this.watchModalVisibility();
  },

  prepareModalAria() {
    document.querySelectorAll('.modal').forEach((modal) => this.decorateModal(modal));
  },

  decorateModal(modal) {
    const content = modal.querySelector('.modal-content');
    if (!content || content.dataset.hiDialog === '1') return;
    content.dataset.hiDialog = '1';
    content.setAttribute('role', 'dialog');
    content.setAttribute('aria-modal', 'true');
    content.setAttribute('tabindex', '-1');

    const heading = modal.querySelector('.modal-header h2');
    if (heading) {
      if (!heading.id) {
        heading.id = `hi-dialog-title-${Math.random().toString(36).slice(2, 9)}`;
      }
      content.setAttribute('aria-labelledby', heading.id);
    }

    const closeBtn = modal.querySelector('.modal-header .btn-close');
    if (closeBtn && !closeBtn.getAttribute('aria-label')) {
      closeBtn.setAttribute('aria-label', '閉じる');
      // ✕(U+2715)と×(U+00D7)の混在を解消し、記号を1つに揃える
      closeBtn.textContent = '✕';
    }
  },

  // style="display:..." の書き換えでモーダルを開閉している実装に合わせ、
  // 属性の変化を監視してフォーカスの移動と復帰を行う
  watchModalVisibility() {
    const lastFocus = new WeakMap();

    const onVisible = (modal) => {
      this.decorateModal(modal);
      lastFocus.set(modal, document.activeElement);
      const content = modal.querySelector('.modal-content') || modal;
      const target = modal.querySelector(
        '.modal-content input:not([type="hidden"]):not([disabled]), .modal-content select, .modal-content textarea'
      );
      // 送信ボタンに自動フォーカスは当てない(Enter連打での誤送信を避けるため)
      (target || content).focus({ preventScroll: true });
    };

    const onHidden = (modal) => {
      const previous = lastFocus.get(modal);
      if (previous && document.body.contains(previous) && previous.offsetParent !== null) {
        previous.focus({ preventScroll: true });
      }
      lastFocus.delete(modal);
    };

    const state = new WeakMap();
    const check = (modal) => {
      const visible = window.getComputedStyle(modal).display !== 'none';
      if (state.get(modal) === visible) return;
      state.set(modal, visible);
      if (visible) onVisible(modal);
      else onHidden(modal);
    };

    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type === 'attributes' && record.target.classList?.contains('modal')) {
          check(record.target);
        }
        // JSで後から差し込まれるモーダル(案件フォルダ閲覧・案件詳細)にも効かせる
        record.addedNodes?.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.classList?.contains('modal')) {
            this.decorateModal(node);
            observer.observe(node, { attributes: true, attributeFilter: ['style', 'class'] });
            check(node);
          }
          node.querySelectorAll?.('.modal').forEach((m) => {
            this.decorateModal(m);
            observer.observe(m, { attributes: true, attributeFilter: ['style', 'class'] });
            check(m);
          });
        });
      });
    });

    document.querySelectorAll('.modal').forEach((modal) => {
      state.set(modal, window.getComputedStyle(modal).display !== 'none');
      observer.observe(modal, { attributes: true, attributeFilter: ['style', 'class'] });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  },

  // ========================================
  // トースト通知
  //
  // alert() の置き換え。画面をブロックしないため、
  // 「通知のあと画面を再読み込みする」処理でも消えないよう、
  // 表示予定時刻を sessionStorage に持たせて読み込み後に続きを出す。
  // ========================================

  TOAST_STORE_KEY: 'hiboard.toasts',
  TOAST_DURATION: 4200,

  /** メッセージの内容から種類を推測する(呼び出し側で明示してもよい) */
  guessToastType(message) {
    const text = String(message);
    if (/失敗|エラー|できません|できませんでした|見つかりません|不正/.test(text)) return 'error';
    if (/^✓|しました|完了|登録しました|保存しました/.test(text)) return 'success';
    if (/してください|ください$|未入力|必要です/.test(text)) return 'warning';
    return 'info';
  },

  toast(message, type) {
    if (message === undefined || message === null || message === '') return;
    const kind = type || this.guessToastType(message);
    const until = Date.now() + this.TOAST_DURATION;
    this.storeToast({ message: String(message), type: kind, until });
    this.renderToast(String(message), kind, this.TOAST_DURATION);
  },

  storeToast(entry) {
    try {
      const list = JSON.parse(sessionStorage.getItem(this.TOAST_STORE_KEY) || '[]');
      list.push(entry);
      sessionStorage.setItem(this.TOAST_STORE_KEY, JSON.stringify(list.slice(-5)));
    } catch (_) {
      /* sessionStorage が使えない環境では持ち越しを諦める */
    }
  },

  /** 再読み込み直後に、表示途中だったトーストを続けて出す */
  restoreToasts() {
    let list = [];
    try {
      list = JSON.parse(sessionStorage.getItem(this.TOAST_STORE_KEY) || '[]');
    } catch (_) {
      return;
    }
    const now = Date.now();
    const alive = list.filter((entry) => entry.until > now);
    try {
      sessionStorage.setItem(this.TOAST_STORE_KEY, JSON.stringify(alive));
    } catch (_) { /* noop */ }
    alive.forEach((entry) => this.renderToast(entry.message, entry.type, entry.until - now));
  },

  toastContainer() {
    let container = document.getElementById('hi-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'hi-toast-container';
      container.className = 'hi-toast-container';
      container.setAttribute('role', 'status');
      container.setAttribute('aria-live', 'polite');
      document.body.appendChild(container);
    }
    return container;
  },

  renderToast(message, type, duration) {
    const container = this.toastContainer();
    const el = document.createElement('div');
    el.className = `hi-toast is-${type}`;
    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'hi-toast-close';
    close.setAttribute('aria-label', '通知を閉じる');
    close.textContent = '✕';
    close.addEventListener('click', () => this.dismissToast(el));
    el.appendChild(close);

    container.appendChild(el);
    setTimeout(() => this.dismissToast(el), Math.max(1200, duration));
  },

  dismissToast(el) {
    if (!el || el.dataset.leaving === '1') return;
    el.dataset.leaving = '1';
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  },

  // ========================================
  // スマホ幅で畳むブロック(絞り込みなど)
  //
  // details に open を付けたままCSSで開閉を制御すると環境差が出るため、
  // 画面幅を見て open 属性そのものを付け外しする
  // ========================================
  syncCollapsibles() {
    const isDesktop = window.matchMedia('(min-width: 768px)').matches;
    document.querySelectorAll('details.mobile-collapsible').forEach((el) => {
      // 利用者が自分で開閉したものは尊重する
      if (el.dataset.userToggled === '1') return;
      el.open = isDesktop;
    });
  },

  setupCollapsibles() {
    document.querySelectorAll('details.mobile-collapsible').forEach((el) => {
      el.addEventListener('toggle', () => {
        if (window.matchMedia('(max-width: 767px)').matches) el.dataset.userToggled = '1';
      });
    });
    this.syncCollapsibles();
    window.addEventListener('resize', () => this.syncCollapsibles());
  },

  // ========================================
  // 初期化
  // ========================================
  init() {
    this.mountHeaderNav();
    this.setupModalBehavior();
    this.setupCollapsibles();
    this.restoreToasts();
    this.loadDesignerNavLabel();
  },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => HiUI.init());
} else {
  HiUI.init();
}
