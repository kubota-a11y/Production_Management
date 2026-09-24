'use strict';

// LINE返信キューからお客様へ「ファイル(見積書PDF・仕上がりイメージなど)」を送る仕組み(2026-09-24)。
//
// Messaging API には PDF を「ファイル」として送る種類が無いので、
//   (A) PDF/画像を HiBoard が預かり、推測できないトークン付きの公開URL(/f/{token})で配る
//   (B) PDF の各ページ(最大4ページ)を画像にして LINE の画像メッセージで見せる
// の両方を行う(社長決定 2026-09-24: A+B)。画像化に失敗したPDF(特殊フォント等)はリンクだけ送る。
//
// 置き場: LINE_SENT_PATH(.env・未設定なら LINE_RECEIVED_PATH の隣の LINE_SENT)。
// 公開URLは PUBLIC_ORDER_BASE_URL(https://order.hiyoshi-1954.com)に /f/{token} を付けたもの。
// 期限は AI_REPLY_FILE_TTL_DAYS(既定90日)。期限切れ・存在しないトークンは404。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_PAGES = 4;
const PREVIEW_WIDTH = 1280;
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp']);

let cfg = { db: null, sentPath: '', publicBase: '', ttlDays: 90 };

function init({ db, sentPath, publicBase, ttlDays }) {
  cfg = { db, sentPath, publicBase: String(publicBase || '').replace(/\/$/, ''), ttlDays: ttlDays || 90 };
  try { fs.mkdirSync(sentPath, { recursive: true }); } catch (err) { console.warn(`[LINEファイル送信] 保存先を作れません: ${sentPath} (${err.message})`); }
  console.log(`[LINEファイル送信] 保存先=${sentPath}・公開URL=${cfg.publicBase ? cfg.publicBase + '/f/{token}' : '未設定(PUBLIC_ORDER_BASE_URL が無いのでファイルは送れません)'}・期限${cfg.ttlDays}日`);
}

function kindOf(ext) { return ext === '.pdf' ? 'pdf' : 'image'; }
function mimeOf(ext) { return { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'application/octet-stream'; }

// ---- プレビュー画像(JPEG)を作る。PDFは pdf-to-img(pdfjs)で各ページを描画、画像は sharp で縮小 ----
async function buildPreviews(storedPath, ext, dir) {
  const sharp = require('sharp');
  const out = [];
  if (ext === '.pdf') {
    const { pdf } = await import('pdf-to-img');
    const doc = await pdf(storedPath, { scale: 1.6 });
    let i = 0;
    for await (const png of doc) {
      i++;
      const p = path.join(dir, `${i}.jpg`);
      await sharp(png).resize({ width: PREVIEW_WIDTH, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(p);
      out.push(p);
      if (i >= MAX_PREVIEW_PAGES) break;
    }
  } else {
    const p = path.join(dir, '1.jpg');
    await sharp(storedPath).rotate().resize({ width: PREVIEW_WIDTH, withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(p);
    out.push(p);
  }
  // LINEの画像メッセージは 10MB(オリジナル)/1MB(プレビュー)まで。1MBを超えたページは縮めて作り直す
  for (const p of out) {
    let q = 75;
    while (fs.statSync(p).size > 1000 * 1024 && q >= 40) {
      await sharp(p).resize({ width: 1000 }).jpeg({ quality: q }).toFile(p + '.tmp');
      fs.renameSync(p + '.tmp', p);
      q -= 15;
    }
  }
  return out;
}

// ---- 預かり(アップロード or 案件フォルダのファイル) ----
async function storeFile({ sourcePath, originalName, lineUserId, source, sourceLabel }) {
  const db = cfg.db;
  const ext = path.extname(originalName || sourcePath).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw new Error('PDFまたは画像(JPG/PNG/GIF/WebP)だけ送れます');
  const size = fs.statSync(sourcePath).size;
  if (size > MAX_BYTES) throw new Error('ファイルが大きすぎます(上限20MB)');
  const token = crypto.randomBytes(18).toString('base64url');
  const dir = path.join(cfg.sentPath, token);
  fs.mkdirSync(dir, { recursive: true });
  const storedPath = path.join(dir, `file${ext}`);
  fs.copyFileSync(sourcePath, storedPath);
  let previews = [];
  let previewError = null;
  try {
    previews = await buildPreviews(storedPath, ext, dir);
  } catch (err) {
    previewError = err.message;
    console.warn(`[LINEファイル送信] プレビュー画像を作れませんでした(${originalName}): ${err.message} → リンクだけ送ります`);
  }
  const now = new Date();
  const expires = new Date(now.getTime() + cfg.ttlDays * 86400e3);
  const info = db.prepare(`
    INSERT INTO line_sent_files (token, line_user_id, file_name, mime, size, stored_path, preview_count, preview_error, source, source_path, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(token, lineUserId || null, path.basename(originalName || sourcePath), mimeOf(ext), size, storedPath, previews.length, previewError, source, sourceLabel || null, now.toISOString(), expires.toISOString());
  return shape(db.prepare('SELECT * FROM line_sent_files WHERE id = ?').get(info.lastInsertRowid));
}

function shape(r) {
  if (!r) return null;
  return {
    id: r.id, token: r.token, file_name: r.file_name, mime: r.mime, size: r.size, kind: kindOf(path.extname(r.stored_path).toLowerCase()),
    preview_count: r.preview_count, preview_error: r.preview_error, source: r.source, created_at: r.created_at, expires_at: r.expires_at,
    sent_at: r.sent_at, url: publicUrl(r.token), preview_urls: Array.from({ length: r.preview_count || 0 }, (_, i) => publicUrl(r.token, i + 1)),
    internal_preview: r.preview_count ? `/api/line-reply/files/${r.id}/preview/1` : null,
  };
}
function get(id) { return shape(cfg.db.prepare('SELECT * FROM line_sent_files WHERE id = ?').get(id)); }
function raw(id) { return cfg.db.prepare('SELECT * FROM line_sent_files WHERE id = ?').get(id); }
function publicUrl(token, page) {
  if (!cfg.publicBase) return null;
  return `${cfg.publicBase}/f/${token}${page ? `/${page}.jpg` : ''}`;
}
function isReady() { return Boolean(cfg.publicBase && cfg.db); }

// 送信に使う LINE メッセージ群(画像→リンク)。呼び出し側が5件ずつに分けて push する
function messagesFor(fileId) {
  const r = raw(fileId);
  if (!r) throw new Error('ファイルが見つかりません');
  if (!cfg.publicBase) throw new Error('PUBLIC_ORDER_BASE_URL が未設定のためファイルを送れません');
  const msgs = [];
  for (let i = 1; i <= (r.preview_count || 0); i++) {
    const u = publicUrl(r.token, i);
    msgs.push({ type: 'image', originalContentUrl: u, previewImageUrl: u });
  }
  const label = r.mime === 'application/pdf' ? 'PDF' : '画像';
  msgs.push({ type: 'text', text: `📎 ${r.file_name}(${label})\n${publicUrl(r.token)}\n※このリンクは${cfg.ttlDays}日間有効です` });
  return { messages: msgs, file: shape(r) };
}
function markSent(fileId, { sentBy, messageRowId }) {
  cfg.db.prepare('UPDATE line_sent_files SET sent_at = ?, sent_by = ?, message_row_id = ? WHERE id = ?').run(new Date().toISOString(), sentBy || null, messageRowId || null, fileId);
}

// ---- ルート ----
function registerLineFileRoutes(app, { nasBasePath, isWithinBase }) {
  const tmpDir = path.join(os.tmpdir(), 'hiboard_line_files_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, tmpDir),
      filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname || '').toLowerCase()),
    }),
    limits: { fileSize: MAX_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (ALLOWED_EXT.has(ext)) return cb(null, true);
      cb(new Error('PDFまたは画像(JPG/PNG/GIF/WebP)だけ送れます'));
    },
  });
  const uploadMiddleware = (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const message = err instanceof multer.MulterError
          ? (err.code === 'LIMIT_FILE_SIZE' ? 'ファイルが大きすぎます(上限20MB)' : 'ファイルの受け取りに失敗しました')
          : err.message;
        return res.status(400).json({ ok: false, error: message });
      }
      next();
    });
  };

  // PCからアップロード(multipart: file, line_user_id)
  app.post('/api/line-reply/files/upload', uploadMiddleware, async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'ファイルがありません' });
    try {
      // multer はファイル名を latin1 で受けることがあるので UTF-8 に直す
      let name = req.file.originalname || 'file';
      try { name = Buffer.from(name, 'latin1').toString('utf8'); } catch { /* noop */ }
      const f = await storeFile({ sourcePath: req.file.path, originalName: name, lineUserId: req.body && req.body.line_user_id, source: 'upload' });
      res.json({ ok: true, file: f });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      try { fs.unlinkSync(req.file.path); } catch { /* noop */ }
    }
  });

  // 案件フォルダ(共有ドライブ)のファイルを選ぶ
  app.post('/api/line-reply/files/from-folder', async (req, res) => {
    try {
      const requested = req.body && req.body.path;
      if (!requested) return res.status(400).json({ ok: false, error: 'path が必要です' });
      const resolved = path.resolve(path.normalize(requested));
      if (!isWithinBase(resolved, nasBasePath)) return res.status(400).json({ ok: false, error: '不正なパスです' });
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return res.status(404).json({ ok: false, error: 'ファイルが見つかりません' });
      const f = await storeFile({ sourcePath: resolved, originalName: path.basename(resolved), lineUserId: req.body.line_user_id, source: 'folder', sourceLabel: resolved });
      res.json({ ok: true, file: f });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/line-reply/files/:id', (req, res) => {
    const f = get(parseInt(req.params.id, 10));
    if (!f) return res.status(404).json({ error: 'ファイルが見つかりません' });
    res.json({ file: f });
  });

  // 社内向けプレビュー(画面のサムネイル)
  app.get('/api/line-reply/files/:id/preview/:n', (req, res) => {
    const r = raw(parseInt(req.params.id, 10));
    const n = parseInt(req.params.n, 10);
    if (!r || !(n >= 1 && n <= (r.preview_count || 0))) return res.status(404).send('Not Found');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(path.join(path.dirname(r.stored_path), `${n}.jpg`));
  });

  // 公開URL(お客様が開く)。トークンのみで特定し、期限切れは404
  const findByToken = (token) => {
    const r = cfg.db.prepare('SELECT * FROM line_sent_files WHERE token = ?').get(String(token || ''));
    if (!r) return null;
    if (r.expires_at && Date.parse(r.expires_at) < Date.now()) return null;
    return r;
  };
  app.get('/f/:token', (req, res) => {
    const r = findByToken(req.params.token);
    if (!r || !fs.existsSync(r.stored_path)) return res.status(404).send('Not Found');
    res.setHeader('Content-Type', r.mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(r.file_name)}`);
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('X-Robots-Tag', 'noindex');
    fs.createReadStream(r.stored_path).pipe(res);
  });
  app.get('/f/:token/:n.jpg', (req, res) => {
    const r = findByToken(req.params.token);
    const n = parseInt(req.params.n, 10);
    if (!r || !(n >= 1 && n <= (r.preview_count || 0))) return res.status(404).send('Not Found');
    const p = path.join(path.dirname(r.stored_path), `${n}.jpg`);
    if (!fs.existsSync(p)) return res.status(404).send('Not Found');
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.sendFile(p);
  });
}

module.exports = { init, registerLineFileRoutes, storeFile, get, messagesFor, markSent, isReady, publicUrl, MAX_PREVIEW_PAGES };
