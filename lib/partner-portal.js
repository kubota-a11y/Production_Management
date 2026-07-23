const crypto = require('crypto');
const path = require('path');

// 取引先向け 納期確認ページ(パートナーポータル)。
// 管理画面(取引先リンク管理 /partner-links)で発行した専用URL(/partner/{token})から、
// 取引先(例: 八木繊維)が自社案件の進行状況と納品予定日をいつでも閲覧できる(閲覧専用)。
// 「上がりはいつ?」の電話問い合わせを、双方の手間なく自己解決してもらうのが目的。
// 案件との紐付けは projects.customer_name への部分一致パターン(customer_patterns)で自動判定し、
// 社内でステータス・納期を更新するだけで取引先側の表示に反映される(追加入力ゼロ)。

const LEN = { short: 200, note: 500 };
const MAX_PATTERNS = 20;
const DELIVERED_LIMIT = 30;

// 社内ステータス → 取引先向け4段階表示。
// 社内の細かい工程(生産待ち/準備完了など)はそのまま見せず、取引先が知りたい粒度に丸める
const STAGE_OF_STATUS = {
  PRE_ORDER: 1, CONFIRMED: 1,
  WAITING: 2, PREP_COMPLETE: 2, IN_PROGRESS: 2,
  INSPECTION: 3, DELIVERED: 3,
  COMPLETED: 4,
};
const STAGE_LABELS = { 1: '受付済み', 2: '製作中', 3: '検品・出荷準備中', 4: '納品済み' };

function s(v, max = LEN.short) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}
function isNonEmptyStr(v) { return typeof v === 'string' && v.trim().length > 0; }

// DBにはJSON配列文字列で保存。壊れていたら空配列扱い
function parsePatterns(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter(isNonEmptyStr).map(v => s(v, 100)) : [];
  } catch { return []; }
}

function getLink(db, where, param) {
  const link = db.prepare(`SELECT * FROM partner_links WHERE ${where}`).get(param);
  if (!link) return null;
  return { ...link, customer_patterns: parsePatterns(link.customer_patterns) };
}

// 一致パターンをSQLの条件式に変換する。
// LIKEだと % _ のエスケープが必要になるため、instr(部分一致)で判定する
function matchClause(patterns) {
  if (patterns.length === 0) return { sql: '0', params: [] };
  return {
    sql: `(${patterns.map(() => 'instr(p.customer_name, ?) > 0').join(' OR ')})`,
    params: patterns,
  };
}

// 進行中(納品済み以外)の対象案件。納品予定日が近い順
function findActiveProjects(db, patterns) {
  const m = matchClause(patterns);
  return db.prepare(`
    SELECT p.id, p.project_name, p.quantity, p.received_date, p.deadline, p.status
    FROM projects p
    WHERE p.status != 'COMPLETED' AND ${m.sql}
    ORDER BY p.deadline ASC, p.id ASC
  `).all(...m.params);
}

// 納品済みの対象案件(直近)。納品日の新しい順
function findDeliveredProjects(db, patterns) {
  const m = matchClause(patterns);
  return db.prepare(`
    SELECT p.project_name, p.quantity, dr.delivered_date
    FROM delivery_records dr
    JOIN projects p ON dr.case_id = p.id
    WHERE ${m.sql}
    ORDER BY dr.delivered_date DESC, dr.id DESC
    LIMIT ${DELIVERED_LIMIT}
  `).all(...m.params);
}

// 管理画面から受け取ったリンク情報を検証・正規化する。エラー時は {errors} を返す
function normalizeLinkPayload(body) {
  const errors = [];
  const partner_name = s(body.partner_name);
  const memo = s(body.memo, LEN.note);
  if (!isNonEmptyStr(partner_name)) errors.push('取引先名を入力してください');

  let patterns = Array.isArray(body.customer_patterns)
    ? body.customer_patterns.filter(isNonEmptyStr).map(v => s(v, 100))
    : [];
  patterns = [...new Set(patterns)].slice(0, MAX_PATTERNS);
  // パターン未指定なら取引先名そのもので一致させる
  if (patterns.length === 0 && isNonEmptyStr(partner_name)) patterns = [partner_name];

  return errors.length ? { errors } : { partner_name, memo, patterns };
}

// ===== ルート登録 =====
function registerPartnerPortalRoutes(app, db) {
  // ---- 公開: 納期確認ページHTML(データはページ内JSがAPIから取得) ----
  app.get('/partner/:token', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'partner-status.html'));
  });

  // ---- 公開: 進行状況データ。無効化済み・不明トークンは404 ----
  app.get('/api/partner-status/:token', (req, res) => {
    try {
      const link = getLink(db, 'token = ?', s(req.params.token, 64));
      if (!link || link.disabled_at) {
        return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。お手数ですが担当者にお問い合わせください。' });
      }
      const active = findActiveProjects(db, link.customer_patterns).map(p => ({
        project_name: p.project_name,
        quantity: p.quantity,
        received_date: p.received_date,
        deadline: p.deadline,
        stage: STAGE_OF_STATUS[p.status] || 1,
        stage_label: STAGE_LABELS[STAGE_OF_STATUS[p.status] || 1],
      }));
      const delivered = findDeliveredProjects(db, link.customer_patterns).map(r => ({
        project_name: r.project_name,
        quantity: r.quantity,
        delivered_date: r.delivered_date,
      }));
      res.json({ ok: true, partner_name: link.partner_name, active, delivered });
    } catch (err) {
      console.error('[取引先ポータル] 進行状況の取得でエラー:', err.message);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。しばらくしてから再度お試しください。' });
    }
  });

  // ---- 管理: 一覧(進行中の対象案件数つき) ----
  // public_base はチームリンクと同じく .env の PUBLIC_ORDER_BASE_URL(未設定なら画面側で自オリジン)
  app.get('/api/partner-links', (req, res) => {
    const links = db.prepare('SELECT * FROM partner_links ORDER BY created_at DESC').all()
      .map(l => {
        const link = { ...l, customer_patterns: parsePatterns(l.customer_patterns) };
        return { ...link, active_count: findActiveProjects(db, link.customer_patterns).length };
      });
    res.json({ public_base: process.env.PUBLIC_ORDER_BASE_URL || '', links });
  });

  // ---- 管理: 発行 ----
  app.post('/api/partner-links', (req, res) => {
    const p = normalizeLinkPayload(req.body || {});
    if (p.errors) return res.status(400).json({ errors: p.errors });
    const now = new Date().toISOString();
    const token = crypto.randomBytes(16).toString('hex');
    const info = db.prepare(`
      INSERT INTO partner_links (token, partner_name, customer_patterns, memo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(token, p.partner_name, JSON.stringify(p.patterns), p.memo, now, now);
    console.log(`[取引先リンク] 発行: #${info.lastInsertRowid}`);
    res.status(201).json(getLink(db, 'id = ?', info.lastInsertRowid));
  });

  // ---- 管理: 更新(取引先名・一致パターン・メモ) ----
  app.put('/api/partner-links/:id', (req, res) => {
    const link = db.prepare('SELECT id FROM partner_links WHERE id = ?').get(req.params.id);
    if (!link) return res.status(404).json({ error: 'リンクが見つかりません' });
    const p = normalizeLinkPayload(req.body || {});
    if (p.errors) return res.status(400).json({ errors: p.errors });
    db.prepare('UPDATE partner_links SET partner_name = ?, customer_patterns = ?, memo = ?, updated_at = ? WHERE id = ?')
      .run(p.partner_name, JSON.stringify(p.patterns), p.memo, new Date().toISOString(), link.id);
    res.json(getLink(db, 'id = ?', link.id));
  });

  // ---- 管理: 無効化/再有効化のトグル ----
  app.post('/api/partner-links/:id/toggle', (req, res) => {
    const link = db.prepare('SELECT id, disabled_at FROM partner_links WHERE id = ?').get(req.params.id);
    if (!link) return res.status(404).json({ error: 'リンクが見つかりません' });
    const now = new Date().toISOString();
    db.prepare('UPDATE partner_links SET disabled_at = ?, updated_at = ? WHERE id = ?')
      .run(link.disabled_at ? null : now, now, link.id);
    console.log(`[取引先リンク] #${link.id} を${link.disabled_at ? '再有効化' : '無効化'}`);
    res.json(getLink(db, 'id = ?', link.id));
  });

  // ---- 管理: 画面 ----
  app.get('/partner-links', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'partner-links.html'));
  });
}

module.exports = { registerPartnerPortalRoutes };
