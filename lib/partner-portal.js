const crypto = require('crypto');
const path = require('path');
const { notifyPartnerComment, isConfigured: isCommentNotifyConfigured } = require('./partner-notify');

// 取引先向け 納期確認ページ(パートナーポータル)。
// 管理画面(取引先リンク管理 /partner-links)で発行した専用URL(/partner/{token})から、
// 取引先(例: 八木繊維)が自社案件の進行状況と納品予定日をいつでも閲覧できる(閲覧専用)。
// 「上がりはいつ?」の電話問い合わせを、双方の手間なく自己解決してもらうのが目的。
// 案件との紐付けは projects.customer_name への部分一致パターン(customer_patterns)で自動判定し、
// 社内でステータス・納期を更新するだけで取引先側の表示に反映される(追加入力ゼロ)。
//
// 2026-09-16(八木繊維 木之下さん要望)に取引先側からの操作を2つ足した:
//   - 「受け取り済みにする」= その取引先の一覧から非表示にする(partner_hidden_projects)。
//     社内の案件状態は一切変えない(取引先に完了を押されると社内が困るため)
//   - 案件カードごとのコメント(partner_comments)。案件のメモ欄末尾に自動追記し、
//     Google Chat の専用スペースへ通知する(社内は納期確認ページを見ないため)

const LEN = { short: 200, note: 500 };
const MAX_PATTERNS = 20;
const MAX_NOTIFY_EMAILS = 5;
const DELIVERED_LIMIT = 30;
const COMMENT_MAX = 500;
const COMMENT_AUTHOR_MAX = 50;
const COMMENTS_PER_PROJECT = 10;   // 取引先画面に出す履歴の上限(案件ごと)
// コメント送信のレート制限(トークンが門番なので緩め。連打・暴走対策)
const COMMENT_WINDOW_MS = 10 * 60 * 1000;
const COMMENT_MAX_PER_WINDOW = 30;

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

// 受付控えメールの送信先。customer_patterns と同じくJSON配列文字列で保存する
function parseEmails(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter(isNonEmptyStr).map(v => s(v, 200)) : [];
  } catch { return []; }
}

function getLink(db, where, param) {
  const link = db.prepare(`SELECT * FROM partner_links WHERE ${where}`).get(param);
  if (!link) return null;
  return {
    ...link,
    customer_patterns: parsePatterns(link.customer_patterns),
    notify_emails: parseEmails(link.notify_emails),
  };
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

// 進行中(納品済み以外)の対象案件。納品予定日が近い順。
// linkId を渡すと、その取引先が「受け取り済み」にした案件を除く(管理画面の件数は除かない)
function findActiveProjects(db, patterns, linkId = null) {
  const m = matchClause(patterns);
  const hiddenFilter = linkId
    ? 'AND p.id NOT IN (SELECT project_id FROM partner_hidden_projects WHERE link_id = ?)'
    : '';
  return db.prepare(`
    SELECT p.id, p.project_name, p.quantity, p.received_date, p.deadline, p.status
    FROM projects p
    WHERE p.status != 'COMPLETED' AND ${m.sql} ${hiddenFilter}
    ORDER BY p.deadline ASC, p.id ASC
  `).all(...m.params, ...(linkId ? [linkId] : []));
}

// 取引先が「受け取り済み」にしたが社内ではまだ納品処理されていない案件。
// 誤操作の取り消し用に、折りたたみで見せる
function findHiddenProjects(db, patterns, linkId) {
  const m = matchClause(patterns);
  return db.prepare(`
    SELECT p.id, p.project_name, p.quantity, p.received_date, p.deadline, p.status, h.hidden_at
    FROM partner_hidden_projects h
    JOIN projects p ON p.id = h.project_id
    WHERE h.link_id = ? AND p.status != 'COMPLETED' AND ${m.sql}
    ORDER BY h.hidden_at DESC, p.id DESC
  `).all(linkId, ...m.params);
}

// 取引先側の操作対象にしてよい案件か(そのリンクの一致パターンに乗る・納品済みでない)。
// トークンだけで案件IDを自由に指定できるため、必ずここで絞る
function findOperableProject(db, patterns, projectId) {
  const id = Number(projectId);
  if (!Number.isInteger(id) || id < 1) return null;
  const m = matchClause(patterns);
  return db.prepare(`
    SELECT p.id, p.project_name, p.deadline, p.status, p.memo
    FROM projects p
    WHERE p.id = ? AND p.status != 'COMPLETED' AND ${m.sql}
  `).get(id, ...m.params);
}

// 案件ごとのコメント履歴(取引先画面用)。新しい順に上限件数
function findComments(db, linkId, projectIds) {
  if (projectIds.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT project_id, author_name, body, created_at
    FROM partner_comments
    WHERE link_id = ? AND project_id IN (${projectIds.map(() => '?').join(',')})
    ORDER BY created_at DESC, id DESC
  `).all(linkId, ...projectIds);
  const map = new Map();
  for (const r of rows) {
    const list = map.get(r.project_id) || [];
    if (list.length < COMMENTS_PER_PROJECT) list.push({ author_name: r.author_name, body: r.body, created_at: r.created_at });
    map.set(r.project_id, list);
  }
  return map;
}

// メモ欄への追記行の日時 'M/D HH:MM'(日本時間)
function memoStamp(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
}

// コメント送信の簡易レート制限(トークン単位)
const commentRate = new Map();
function checkCommentRate(token) {
  const now = Date.now();
  const arr = (commentRate.get(token) || []).filter(t => now - t < COMMENT_WINDOW_MS);
  if (arr.length >= COMMENT_MAX_PER_WINDOW) return false;
  arr.push(now);
  commentRate.set(token, arr);
  return true;
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

  // 受付控えメールの送信先。大文字小文字の違いで重複登録されないよう小文字に揃える
  let notify_emails = Array.isArray(body.notify_emails)
    ? body.notify_emails.filter(isNonEmptyStr).map(v => s(v, 200).toLowerCase())
    : [];
  notify_emails = [...new Set(notify_emails)].slice(0, MAX_NOTIFY_EMAILS);
  const badEmail = notify_emails.find(v => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
  if (badEmail) errors.push(`メールアドレスの形式が不正です: ${badEmail}`);

  return errors.length ? { errors } : { partner_name, memo, patterns, notify_emails };
}

// ===== ルート登録 =====
function registerPartnerPortalRoutes(app, db) {
  // コメント通知の設定状態を起動ログに出す(未設定に気づけるように)
  console.log(isCommentNotifyConfigured()
    ? '取引先コメント通知: 有効(Google Chat「八木繊維　案件コメント」へ自動投稿します)'
    : '取引先コメント通知: 無効(.env の PARTNER_NOTIFY_GCHAT_WEBHOOK が未設定のため送信しません)');

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
      const activeRows = findActiveProjects(db, link.customer_patterns, link.id);
      const hiddenRows = findHiddenProjects(db, link.customer_patterns, link.id);
      const comments = findComments(db, link.id, [...activeRows, ...hiddenRows].map(p => p.id));
      const toView = p => ({
        id: p.id,
        project_name: p.project_name,
        quantity: p.quantity,
        received_date: p.received_date,
        deadline: p.deadline,
        stage: STAGE_OF_STATUS[p.status] || 1,
        stage_label: STAGE_LABELS[STAGE_OF_STATUS[p.status] || 1],
        comments: comments.get(p.id) || [],
      });
      const active = activeRows.map(toView);
      const hidden = hiddenRows.map(p => ({ ...toView(p), hidden_at: p.hidden_at }));
      const delivered = findDeliveredProjects(db, link.customer_patterns).map(r => ({
        project_name: r.project_name,
        quantity: r.quantity,
        delivered_date: r.delivered_date,
      }));
      res.json({ ok: true, partner_name: link.partner_name, active, hidden, delivered });
    } catch (err) {
      console.error('[取引先ポータル] 進行状況の取得でエラー:', err.message);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。しばらくしてから再度お試しください。' });
    }
  });

  // ---- 公開: 「受け取り済み」= 取引先側の一覧から非表示にする / 取り消し ----
  // 社内の案件状態には触れない。想定内の失敗は 200 + {ok:false}(Cloudflare が 5xx を差し替えるため)
  app.post('/api/partner-status/:token/projects/:id/hide', (req, res) => {
    try {
      const link = getLink(db, 'token = ?', s(req.params.token, 64));
      if (!link || link.disabled_at) {
        return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。' });
      }
      const project = findOperableProject(db, link.customer_patterns, req.params.id);
      if (!project) return res.json({ ok: false, error: '対象の案件が見つかりません。画面を更新してください。' });
      const hide = !(req.body && req.body.hide === false);
      if (hide) {
        db.prepare(`
          INSERT INTO partner_hidden_projects (link_id, project_id, hidden_at) VALUES (?, ?, ?)
          ON CONFLICT(link_id, project_id) DO NOTHING
        `).run(link.id, project.id, new Date().toISOString());
      } else {
        db.prepare('DELETE FROM partner_hidden_projects WHERE link_id = ? AND project_id = ?').run(link.id, project.id);
      }
      console.log(`[取引先ポータル] リンク#${link.id} が案件#${project.id} を${hide ? '受け取り済み(非表示)' : '再表示'}にしました`);
      res.json({ ok: true, hidden: hide });
    } catch (err) {
      console.error('[取引先ポータル] 非表示の更新でエラー:', err.message);
      res.json({ ok: false, error: '更新に失敗しました。時間をおいて再度お試しください。' });
    }
  });

  // ---- 公開: 案件へのコメント ----
  // 1) partner_comments に保存 2) projects.memo の末尾へ追記 3) Google Chat の専用スペースへ通知
  app.post('/api/partner-status/:token/projects/:id/comments', (req, res) => {
    try {
      const token = s(req.params.token, 64);
      const link = getLink(db, 'token = ?', token);
      if (!link || link.disabled_at) {
        return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。' });
      }
      const body = req.body || {};
      const authorName = s(body.author_name, COMMENT_AUTHOR_MAX);
      const text = s(body.body, COMMENT_MAX);
      if (!isNonEmptyStr(authorName)) return res.status(400).json({ ok: false, error: 'お名前を入力してください。' });
      if (!isNonEmptyStr(text)) return res.status(400).json({ ok: false, error: 'コメントを入力してください。' });
      if (!checkCommentRate(token)) {
        return res.status(429).json({ ok: false, error: '送信回数が上限に達しました。しばらく時間をおいてお試しください。' });
      }
      const project = findOperableProject(db, link.customer_patterns, req.params.id);
      if (!project) return res.json({ ok: false, error: '対象の案件が見つかりません。画面を更新してください。' });

      const now = new Date();
      const nowIso = now.toISOString();
      // メモ欄には1行の見出し+本文。改行を含む本文はそのまま残す(案件詳細は pre 表示)
      const memoLine = `[${memoStamp(now)} ${link.partner_name} ${authorName}様より] ${text}`;
      const memo = (project.memo || '').trim();
      db.transaction(() => {
        db.prepare(`
          INSERT INTO partner_comments (link_id, project_id, author_name, body, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(link.id, project.id, authorName, text, nowIso);
        db.prepare('UPDATE projects SET memo = ?, updated_at = ? WHERE id = ?')
          .run(memo ? `${memo}\n${memoLine}` : memoLine, nowIso, project.id);
      })();
      console.log(`[取引先ポータル] リンク#${link.id} から案件#${project.id} へコメント(${text.length}文字)`);

      notifyPartnerComment({
        partnerName: link.partner_name,
        authorName,
        project: { id: project.id, project_name: project.project_name, deadline: project.deadline },
        body: text,
      });

      res.status(201).json({ ok: true, comment: { author_name: authorName, body: text, created_at: nowIso } });
    } catch (err) {
      console.error('[取引先ポータル] コメントの保存でエラー:', err.message);
      res.json({ ok: false, error: '送信に失敗しました。時間をおいて再度お試しください。' });
    }
  });

  // ---- 管理: 一覧(進行中の対象案件数つき) ----
  // public_base はチームリンクと同じく .env の PUBLIC_ORDER_BASE_URL(未設定なら画面側で自オリジン)
  app.get('/api/partner-links', (req, res) => {
    const links = db.prepare('SELECT * FROM partner_links ORDER BY created_at DESC').all()
      .map(l => {
        const link = {
          ...l,
          customer_patterns: parsePatterns(l.customer_patterns),
          notify_emails: parseEmails(l.notify_emails),
        };
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
      INSERT INTO partner_links (token, partner_name, customer_patterns, notify_emails, memo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(token, p.partner_name, JSON.stringify(p.patterns), JSON.stringify(p.notify_emails), p.memo, now, now);
    console.log(`[取引先リンク] 発行: #${info.lastInsertRowid}`);
    res.status(201).json(getLink(db, 'id = ?', info.lastInsertRowid));
  });

  // ---- 管理: 更新(取引先名・一致パターン・メモ) ----
  app.put('/api/partner-links/:id', (req, res) => {
    const link = db.prepare('SELECT id FROM partner_links WHERE id = ?').get(req.params.id);
    if (!link) return res.status(404).json({ error: 'リンクが見つかりません' });
    const p = normalizeLinkPayload(req.body || {});
    if (p.errors) return res.status(400).json({ errors: p.errors });
    db.prepare('UPDATE partner_links SET partner_name = ?, customer_patterns = ?, notify_emails = ?, memo = ?, updated_at = ? WHERE id = ?')
      .run(p.partner_name, JSON.stringify(p.patterns), JSON.stringify(p.notify_emails), p.memo, new Date().toISOString(), link.id);
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
