const path = require('path');

// 紹介キャンペーン(2026-08-02 追加)。
//
// 会社が発行した「紹介コード」を持つ人だけが開ける非公開ページ /referral と、
// 社内でコードを発行・管理する画面(/referral-admin)を提供する。
//
// 設計上の要点:
// - コードは「解錠キー」と「お知り合いに配る紹介コード」を兼ねる(1人1コード。社長決定 2026-08-02)
// - partner_type(TEAM / INDIVIDUAL)を発行時に決めるため、
//   「AMiGOSからの紹介」「本田さんからの紹介」をシステムが判別できる
// - 総当たり対策として、照合APIはIP単位のレート制限をかける(order-status.js と同じ簡易方式)
// - 公開ページのAPIは5xxを返さない(Cloudflare がエラーページに差し替えてしまうため)。
//   想定内の失敗は 200 + {ok:false, error} で返す

const MAX_ATTEMPTS = parseInt(process.env.REFERRAL_LOOKUP_MAX_ATTEMPTS, 10) || 10;
const ATTEMPT_WINDOW_MS = (parseInt(process.env.REFERRAL_LOOKUP_WINDOW_MIN, 10) || 10) * 60 * 1000;

const PARTNER_TYPES = new Set(['TEAM', 'INDIVIDUAL']);
const TYPE_LABEL = { TEAM: 'チーム', INDIVIDUAL: '個人' };

// 特典の内容(出典: ~/Documents/事業拡大HQ/プリント刺繍加工.md「紹介特典制度」)。
// 文言を変えるときはHQの資料と揃えること。
const BENEFITS = {
  TEAM: {
    forYou: [
      { t: 'オリジナル防水チームステッカー40枚', d: 'ご紹介先のチームがご注文を確定されたら、デザイン制作込みの防水ステッカー(7×7cm)40枚をチームへお届けします。' },
      { t: '次回使える3,000円クーポン', d: '個人の方をご紹介いただいた場合は、次回のご注文で使えるクーポンをお渡しします。' },
    ],
    forFriend: [
      { t: 'チームオーダーは特別割引', d: 'ユニフォーム・練習着などチームでのご注文を、ご紹介の方だけの特別割引でご案内します。' },
      { t: 'Tシャツ1枚無料追加', d: 'クラスTシャツなど10枚以上のご注文で、同じデザインのTシャツを1枚無料でお付けします。' },
    ],
  },
  INDIVIDUAL: {
    forYou: [
      { t: '次回使える3,000円クーポン', d: 'ご紹介先がご注文を確定されたら、次回のご注文で使えるクーポンをお渡しします。回数の制限はありません。' },
    ],
    forFriend: [
      { t: 'Tシャツ1枚無料追加', d: '10枚以上のご注文で、同じデザインのTシャツを1枚無料でお付けします。' },
      { t: 'チームオーダーは特別割引', d: 'チームでのご注文の場合は、ご紹介の方だけの特別割引でご案内します。' },
    ],
  },
};

// ===== レート制限(プロセス内メモリ。order-status.js と同じ考え方) =====
const attempts = new Map();

function checkRateLimit(key, now = Date.now()) {
  const list = (attempts.get(key) || []).filter(t => now - t < ATTEMPT_WINDOW_MS);
  if (list.length >= MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((ATTEMPT_WINDOW_MS - (now - list[0])) / 1000);
    attempts.set(key, list);
    return { ok: false, retryAfter };
  }
  list.push(now);
  attempts.set(key, list);
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) {
      if (v.every(t => now - t >= ATTEMPT_WINDOW_MS)) attempts.delete(k);
    }
  }
  return { ok: true };
}

function getClientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip || req.connection?.remoteAddress || 'unknown';
}

function s(v, max = 200) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

// コードの正規化(大文字・前後空白除去)。表記ゆれで開けない事故を防ぐ
function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
}

// 紹介コードの体系: チーム=HY-T01, 個人=HY-P001。既存の最大連番+1で採番する
function nextCode(db, partnerType) {
  const prefix = partnerType === 'TEAM' ? 'HY-T' : 'HY-P';
  const width = partnerType === 'TEAM' ? 2 : 3;
  const rows = db.prepare('SELECT code FROM referral_partners WHERE code LIKE ?').all(`${prefix}%`);
  let max = 0;
  for (const r of rows) {
    const m = String(r.code).match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${String(max + 1).padStart(width, '0')}`;
}

// そのコードでの紹介実績。注文フォームの referral_code(大文字化して比較)を数える
function statsOf(db, code) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN case_id IS NOT NULL THEN 1 ELSE 0 END) AS confirmed
    FROM ai_extracted_intake
    WHERE UPPER(TRIM(COALESCE(referral_code, ''))) = ?
  `).get(code);
  return { total: row ? row.total : 0, confirmed: row ? (row.confirmed || 0) : 0 };
}

function publicOrderBase() {
  const base = process.env.PUBLIC_ORDER_BASE_URL || '';
  return base.replace(/\/+$/, '');
}

function registerReferralRoutes(app, db) {
  // ---- 公開: 紹介ページ(コード入力式) ----
  app.get('/referral', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'referral.html'));
  });

  // ---- 公開: コード照合API ----
  // 成功時のみパートナー情報・特典・共有用リンクを返す。
  // 「存在しない」と「無効化済み」を同じ文言にし、コードの存在有無を探れないようにする
  app.post('/api/referral/verify', (req, res) => {
    try {
      const rate = checkRateLimit(getClientIp(req));
      if (!rate.ok) {
        res.set('Retry-After', String(rate.retryAfter));
        return res.status(429).json({
          ok: false,
          error: '入力の回数が上限に達しました。しばらく時間をおいてお試しいただくか、お電話・公式LINEにてお問い合わせください。',
        });
      }

      const code = normalizeCode(req.body && req.body.code);
      const notFound = {
        ok: false,
        error: '紹介コードが確認できませんでした。お渡ししたカードの記載をご確認ください。ご不明な場合はお電話・公式LINEにてお問い合わせください。',
      };
      if (!code) {
        return res.json({ ok: false, error: '紹介コードを入力してください。' });
      }

      const partner = db.prepare(
        'SELECT id, code, partner_type, partner_name, disabled_at FROM referral_partners WHERE UPPER(code) = ?'
      ).get(code);
      if (!partner || partner.disabled_at) {
        return res.json(notFound);
      }

      const type = PARTNER_TYPES.has(partner.partner_type) ? partner.partner_type : 'INDIVIDUAL';
      const base = publicOrderBase();
      const stats = statsOf(db, partner.code.toUpperCase());

      return res.json({
        ok: true,
        partner: {
          code: partner.code,
          name: partner.partner_name,
          type,
          type_label: TYPE_LABEL[type],
        },
        benefits: BENEFITS[type],
        // お知り合いに送る用のリンク(注文フォームが紹介コードを自動で受け取る)
        share_url: base ? `${base}/order?ref=${encodeURIComponent(partner.code)}` : '',
        stats,
      });
    } catch (err) {
      console.error('[紹介] 照合に失敗:', err.message);
      // 公開ページのAPIで5xxを返さない(Cloudflareがエラーページに差し替えるため)
      return res.json({ ok: false, error: '一時的にご確認いただけませんでした。時間をおいて再度お試しください。' });
    }
  });

  // ---- 社内: 紹介パートナー管理画面 ----
  app.get('/referral-admin', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'referral-admin.html'));
  });

  // ---- 社内API: 一覧(紹介実績つき) ----
  app.get('/api/referral-partners', (req, res) => {
    try {
      const rows = db.prepare('SELECT * FROM referral_partners ORDER BY disabled_at IS NOT NULL, id DESC').all();
      const list = rows.map(r => ({
        ...r,
        type_label: TYPE_LABEL[r.partner_type] || r.partner_type,
        stats: statsOf(db, String(r.code).toUpperCase()),
        share_url: publicOrderBase() ? `${publicOrderBase()}/order?ref=${encodeURIComponent(r.code)}` : '',
      }));
      res.json({ ok: true, partners: list, referral_page_url: publicOrderBase() ? `${publicOrderBase()}/referral` : '' });
    } catch (err) {
      console.error('[紹介] 一覧の取得に失敗:', err.message);
      res.status(500).json({ ok: false, error: '一覧を取得できませんでした' });
    }
  });

  // ---- 社内API: 発行 ----
  app.post('/api/referral-partners', (req, res) => {
    try {
      const partnerType = s(req.body && req.body.partner_type, 20).toUpperCase();
      const partnerName = s(req.body && req.body.partner_name, 100);
      const memo = s(req.body && req.body.memo, 500);
      if (!PARTNER_TYPES.has(partnerType)) {
        return res.status(400).json({ ok: false, error: '種別を選んでください(チーム / 個人)' });
      }
      if (!partnerName) {
        return res.status(400).json({ ok: false, error: '紹介者名(チーム名)を入力してください' });
      }
      const now = new Date().toISOString();
      const code = nextCode(db, partnerType);
      const info = db.prepare(`
        INSERT INTO referral_partners (code, partner_type, partner_name, memo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(code, partnerType, partnerName, memo || null, now, now);
      console.log(`[紹介] コードを発行: ${code} (${TYPE_LABEL[partnerType]})`);
      res.json({ ok: true, id: info.lastInsertRowid, code });
    } catch (err) {
      console.error('[紹介] 発行に失敗:', err.message);
      res.status(500).json({ ok: false, error: '発行できませんでした' });
    }
  });

  // ---- 社内API: 更新(名称・メモ・有効/無効) ----
  app.patch('/api/referral-partners/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      const cur = db.prepare('SELECT * FROM referral_partners WHERE id = ?').get(id);
      if (!cur) return res.status(404).json({ ok: false, error: '見つかりません' });

      const partnerName = req.body.partner_name !== undefined ? s(req.body.partner_name, 100) : cur.partner_name;
      const memo = req.body.memo !== undefined ? s(req.body.memo, 500) : cur.memo;
      let disabledAt = cur.disabled_at;
      if (req.body.disabled !== undefined) {
        disabledAt = req.body.disabled ? (cur.disabled_at || new Date().toISOString()) : null;
      }
      if (!partnerName) return res.status(400).json({ ok: false, error: '紹介者名を空にはできません' });

      db.prepare(`
        UPDATE referral_partners
        SET partner_name = ?, memo = ?, disabled_at = ?, updated_at = ?
        WHERE id = ?
      `).run(partnerName, memo || null, disabledAt, new Date().toISOString(), id);
      res.json({ ok: true });
    } catch (err) {
      console.error('[紹介] 更新に失敗:', err.message);
      res.status(500).json({ ok: false, error: '更新できませんでした' });
    }
  });
}

// 受注候補の表示などで「誰の紹介か」を引くために使う(order-intake.js から呼ぶ)
function findPartnerByCode(db, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  try {
    const row = db.prepare(
      'SELECT code, partner_type, partner_name FROM referral_partners WHERE UPPER(code) = ?'
    ).get(code);
    if (!row) return null;
    return { ...row, type_label: TYPE_LABEL[row.partner_type] || row.partner_type };
  } catch (_) {
    return null;
  }
}

module.exports = { registerReferralRoutes, findPartnerByCode, normalizeCode };
