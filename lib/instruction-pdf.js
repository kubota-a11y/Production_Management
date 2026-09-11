// 指示書PDF(GoodNotes書き出し)の受け取りと案件フォルダへの紐づけ(2026-09-11)。
//
// 背景: 納品時に「GoodNotesでPDF書き出し → 共有ドライブで案件フォルダを探す → 保存 →
// HiBoardで納品済みにする」を1件ずつ手作業でやっていたため、納品登録が後回しになり
// 「納品待ち」のカードが溜まっていた(三浦さん)。この処理を3方向から軽くする。
//
//   1. 受信箱方式: iPadのGoodNotesから共有ドライブの「_指示書受信箱」1か所にPDFを送るだけにし、
//      HiBoardが定期的に受信箱を見て、ファイル名から案件を特定 → 案件フォルダへ移動する
//   2. 納品モーダル/納品履歴から直接: 受信箱のファイルを選ぶ or PCのファイルを送る →
//      HiBoardが案件フォルダ(無ければ DESIGN/客先名/YYYY-MM_案件名 を自動作成)へ保存する
//   3. 「後で保存する」で納品済みにした案件は、納品履歴に「指示書PDF未保存」として残し、
//      後から案件フォルダにPDFが入ったのを見つけたら自動で解消する
//
// ファイル名から案件を特定する順番(matchInboxFile):
//   受付番号(W-12 / T-5 / P-3 / M-8 / D-2 / Q-4) → 案件番号(#123) → 案件名の部分一致
//   案件名が複数の案件に当てはまるときは、進行中の案件を優先し、それでも決まらなければ「未紐づけ」のまま残す
//   (人が納品モーダルで選ぶ)。推測で間違った案件に入れるより、残す方が安全。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');

const MAX_PDF_BYTES = 30 * 1024 * 1024;
// 書き出し直後(iPad→Googleドライブ同期中)のファイルを掴まないための待ち時間
const INBOX_SETTLE_MS = 60 * 1000;
const INBOX_LIST_LIMIT = 200;
const INSTRUCTION_NAME_RE = /指示書|instruction/i;

// 受付番号の頭文字 → ai_extracted_intake.line_user_id(public/js/app.js の RECEIPT_PREFIX と対)
const PREFIX_TO_SOURCE = {
  W: ['WEB'], T: ['TEAM'], P: ['PARTNER'], M: ['MAIL'], D: ['PHONE'],
  Q: ['INQ_TEAM', 'INQ_CLASS_T', 'INQ_ORIGINAL'],
};
const SOURCE_TO_PREFIX = {};
for (const [prefix, sources] of Object.entries(PREFIX_TO_SOURCE)) {
  sources.forEach(s => { SOURCE_TO_PREFIX[s] = prefix; });
}

// ===== パス設定 =====
// NAS_BASE_PATH は 2026-09-09 から「HiYOSHi共有」全体を指す(それ以前は DESIGN 自体)。
// どちらの設定でも案件フォルダの置き場が DESIGN になるように吸収する
function getBasePath() {
  return process.env.NAS_BASE_PATH
    || (process.platform === 'win32' ? 'Z:\\DESIGN' : '/Volumes/disk1/DESIGN');
}

function getCaseFolderRoot() {
  if (process.env.CASE_FOLDER_ROOT) return process.env.CASE_FOLDER_ROOT;
  const base = getBasePath();
  if (path.basename(base).toUpperCase() === 'DESIGN') return base;
  return path.join(base, 'DESIGN');
}

function getInboxPath() {
  return process.env.INSTRUCTION_INBOX_PATH || path.join(getCaseFolderRoot(), '_指示書受信箱');
}

function isWithinBase(resolvedPath, basePath) {
  const base = path.resolve(basePath);
  const target = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
  const baseCmp = process.platform === 'win32' ? base.toLowerCase() : base;
  return target === baseCmp || target.startsWith(baseCmp + path.sep);
}

// フォルダ名・ファイル名に使えない文字を落とす(Windows/macOS/Googleドライブ共通で安全な範囲)
function sanitizeName(name, fallback) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

// ===== 受付番号 =====
function getReceiptNo(db, projectId) {
  const intake = db.prepare(
    'SELECT id, line_user_id FROM ai_extracted_intake WHERE case_id = ? ORDER BY id LIMIT 1'
  ).get(projectId);
  if (!intake) return null;
  const prefix = SOURCE_TO_PREFIX[intake.line_user_id];
  return prefix ? `${prefix}-${intake.id}` : null;
}

// ===== 案件フォルダ =====
// 案件に共有ドライブのフォルダが無ければ DESIGN/客先名/YYYY-MM_案件名 を作って案件に書き戻す。
// 命名は 2026-09-09 の共有ドライブ整理で決めたルール(1案件1フォルダ・日付はYYYY-MM)に合わせる
function ensureCaseFolder(db, project) {
  const existing = (project.nas_folder_path || '').trim();
  if (existing) {
    const resolved = path.resolve(path.normalize(existing));
    if (!isWithinBase(resolved, getBasePath())) {
      throw new Error('案件フォルダが共有ドライブの外を指しています。案件の編集でフォルダを直してください');
    }
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }
  const customer = sanitizeName(project.customer_name, '_顧客名未設定');
  const ym = /^\d{4}-\d{2}/.test(project.received_date || '')
    ? project.received_date.slice(0, 7)
    : new Date().toISOString().slice(0, 7);
  const caseName = sanitizeName(project.project_name, `案件${project.id}`);
  const folder = path.join(getCaseFolderRoot(), customer, `${ym}_${caseName}`);
  fs.mkdirSync(folder, { recursive: true });
  db.prepare('UPDATE projects SET nas_folder_path = ?, updated_at = ? WHERE id = ?')
    .run(folder, new Date().toISOString(), project.id);
  console.log(`[指示書PDF] 案件#${project.id} のフォルダを作成しました: ${folder}`);
  return folder;
}

// 案件フォルダ(深さ2まで)にある指示書PDFを探す。名前に「指示書」または「instruction」を含むPDFが対象
function findInstructionPdfs(folderPath) {
  const found = [];
  if (!folderPath) return found;
  const root = path.resolve(path.normalize(folderPath));
  if (!isWithinBase(root, getBasePath())) return found;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return found;
  let scanned = 0;
  const walk = (dir, depth) => {
    if (depth > 2 || scanned > 400) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      scanned++;
      if (entry.name.startsWith('._') || entry.name === '.DS_Store') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (path.extname(entry.name).toLowerCase() === '.pdf' && INSTRUCTION_NAME_RE.test(entry.name)) {
        found.push({ name: entry.name, path: full });
      }
    }
  };
  walk(root, 0);
  found.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return found;
}

// 保存後の名前。「指示書」が入っていなければ足す(案件詳細の書類欄が種類を名前で判定するため)。
// 同名があれば _2, _3 … を付けて上書きしない
function buildTargetPath(folder, originalName) {
  const ext = '.pdf';
  let base = sanitizeName(path.basename(originalName, path.extname(originalName)), '指示書');
  if (!INSTRUCTION_NAME_RE.test(base)) base = `${base}_指示書`;
  let candidate = path.join(folder, base + ext);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(folder, `${base}_${n}${ext}`);
    n++;
  }
  return candidate;
}

// 同じドライブ内なら rename、別ドライブ(一時フォルダ→G:)なら copy+unlink で移す
function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

// 指示書PDFを案件に紐づける本体。sourcePath のファイルを案件フォルダへ移動し、案件と納品記録に記録する
function attachInstructionPdf(db, projectId, sourcePath, originalName) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new Error('案件が見つかりません');
  const folder = ensureCaseFolder(db, project);
  const dest = buildTargetPath(folder, originalName);
  moveFile(sourcePath, dest);
  recordInstructionPdf(db, projectId, dest);
  return { folder, path: dest, name: path.basename(dest) };
}

function recordInstructionPdf(db, projectId, pdfPath) {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE projects SET instruction_pdf_path = ?, instruction_pdf_saved_at = ?, updated_at = ? WHERE id = ?')
      .run(pdfPath, now, now, projectId);
    // 「後で保存する」で納品した記録(0)を解消する。旧データ(NULL)も、PDFが確認できたので1にしてよい
    db.prepare('UPDATE delivery_records SET instruction_pdf_saved = 1 WHERE case_id = ? AND (instruction_pdf_saved IS NULL OR instruction_pdf_saved = 0)')
      .run(projectId);
  })();
}

// ===== 受信箱 =====
function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/[\s\u3000_\-‐－―ー・.,、。()（）\[\]【】]/g, '');
}

// ファイル名から案件を特定する。戻り値: { project, by } / { ambiguous: [...] } / null
function matchInboxFile(db, fileName) {
  const base = path.basename(fileName, path.extname(fileName));

  // 1. 受付番号
  const receipt = base.match(/(?:^|[^A-Za-z])([WTPMDQ])[-‐－ー]?(\d{1,7})(?!\d)/i);
  if (receipt) {
    const sources = PREFIX_TO_SOURCE[receipt[1].toUpperCase()];
    const intake = db.prepare('SELECT case_id, line_user_id FROM ai_extracted_intake WHERE id = ?').get(Number(receipt[2]));
    if (intake && intake.case_id && sources.includes(intake.line_user_id)) {
      const project = db.prepare('SELECT id, project_name, customer_name, status FROM projects WHERE id = ?').get(intake.case_id);
      if (project) return { project, by: `受付番号 ${receipt[1].toUpperCase()}-${receipt[2]}` };
    }
  }

  // 2. 案件番号(#123)
  const idMatch = base.match(/#(\d{1,7})(?!\d)/);
  if (idMatch) {
    const project = db.prepare('SELECT id, project_name, customer_name, status FROM projects WHERE id = ?').get(Number(idMatch[1]));
    if (project) return { project, by: `案件番号 #${idMatch[1]}` };
  }

  // 3. 案件名の部分一致(空白・記号の違いは無視)。2文字以上の案件名だけ対象
  const target = normalizeForMatch(base);
  if (target.length < 2) return null;
  const projects = db.prepare(`
    SELECT id, project_name, customer_name, status FROM projects
    WHERE project_name IS NOT NULL AND TRIM(project_name) != ''
  `).all();
  let hits = projects.filter(p => {
    const name = normalizeForMatch(p.project_name);
    return name.length >= 2 && target.includes(name);
  });
  if (hits.length === 0) return null;
  if (hits.length > 1) {
    const active = hits.filter(p => p.status !== 'COMPLETED');
    if (active.length >= 1) hits = active;
  }
  if (hits.length > 1) {
    // 長い案件名の方が具体的(「Tシャツ」より「静浦FC Tシャツ 2026春」)。それでも同数なら人に任せる
    const maxLen = Math.max(...hits.map(p => normalizeForMatch(p.project_name).length));
    const longest = hits.filter(p => normalizeForMatch(p.project_name).length === maxLen);
    if (longest.length === 1) hits = longest;
  }
  if (hits.length === 1) return { project: hits[0], by: `案件名「${hits[0].project_name}」` };
  return { ambiguous: hits.slice(0, 5) };
}

function ensureInbox() {
  const inbox = getInboxPath();
  try {
    fs.mkdirSync(inbox, { recursive: true });
  } catch (err) {
    console.warn(`[指示書PDF] 受信箱フォルダを作成できませんでした(${inbox}): ${err.message}`);
  }
  return inbox;
}

// 受信箱にあるPDFの一覧(紐づけ候補付き)。移動はしない
function listInbox(db) {
  const inbox = getInboxPath();
  const files = [];
  if (!fs.existsSync(inbox)) return { path: inbox, exists: false, files };
  let entries;
  try { entries = fs.readdirSync(inbox, { withFileTypes: true }); } catch (_) { return { path: inbox, exists: false, files }; }
  for (const entry of entries) {
    if (files.length >= INBOX_LIST_LIMIT) break;
    if (!entry.isFile() || entry.name.startsWith('._') || entry.name.startsWith('.')) continue;
    if (path.extname(entry.name).toLowerCase() !== '.pdf') continue;
    const full = path.join(inbox, entry.name);
    let stat;
    try { stat = fs.statSync(full); } catch (_) { continue; }
    const match = matchInboxFile(db, entry.name);
    files.push({
      name: entry.name,
      path: full,
      size: stat.size,
      modified_at: stat.mtime.toISOString(),
      settled: Date.now() - stat.mtimeMs >= INBOX_SETTLE_MS,
      match: match && match.project
        ? { case_id: match.project.id, project_name: match.project.project_name, customer_name: match.project.customer_name, by: match.by }
        : null,
      ambiguous: match && match.ambiguous
        ? match.ambiguous.map(p => ({ case_id: p.id, project_name: p.project_name, customer_name: p.customer_name }))
        : null,
    });
  }
  files.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return { path: inbox, exists: true, files };
}

let cycleRunning = false;
// 定期処理: (1) 受信箱で案件が一意に決まったPDFを案件フォルダへ移す
//          (2) 「後で保存する」で納品した案件のフォルダに指示書PDFが入っていれば未保存を解消する
function runInboxCycle(db) {
  if (cycleRunning) return { skipped: true };
  cycleRunning = true;
  const summary = { moved: [], resolved: [], unmatched: 0, errors: [] };
  try {
    const { files } = listInbox(db);
    for (const file of files) {
      if (!file.settled) continue;
      if (!file.match) { summary.unmatched++; continue; }
      try {
        const result = attachInstructionPdf(db, file.match.case_id, file.path, file.name);
        summary.moved.push({ case_id: file.match.case_id, from: file.name, to: result.name, by: file.match.by });
        console.log(`[指示書PDF] 受信箱 → 案件#${file.match.case_id}(${file.match.by}): ${file.name} → ${result.path}`);
      } catch (err) {
        summary.errors.push({ file: file.name, error: err.message });
        console.error(`[指示書PDF] 受信箱の振り分けに失敗 ${file.name}: ${err.message}`);
      }
    }

    const pending = db.prepare(`
      SELECT DISTINCT p.id, p.nas_folder_path FROM delivery_records dr
      JOIN projects p ON p.id = dr.case_id
      WHERE dr.instruction_pdf_saved = 0
        AND (p.instruction_pdf_path IS NULL OR p.instruction_pdf_path = '')
        AND p.nas_folder_path IS NOT NULL AND TRIM(p.nas_folder_path) != ''
    `).all();
    for (const p of pending) {
      const pdfs = findInstructionPdfs(p.nas_folder_path);
      if (pdfs.length > 0) {
        recordInstructionPdf(db, p.id, pdfs[0].path);
        summary.resolved.push({ case_id: p.id, name: pdfs[0].name });
        console.log(`[指示書PDF] 案件#${p.id} のフォルダに指示書PDFを確認: ${pdfs[0].name}(未保存を解消)`);
      }
    }
  } finally {
    cycleRunning = false;
  }
  return summary;
}

// ===== 納品時の判定 =====
// 納品モーダルで「保存済み」と申告されなくても、案件にPDFの記録があるかフォルダに実物があれば保存済みとみなす
function resolveSavedAtDelivery(db, projectId, declaredSaved) {
  const project = db.prepare('SELECT id, nas_folder_path, instruction_pdf_path FROM projects WHERE id = ?').get(projectId);
  if (!project) return 0;
  if (project.instruction_pdf_path) return 1;
  const pdfs = findInstructionPdfs(project.nas_folder_path);
  if (pdfs.length > 0) {
    recordInstructionPdf(db, projectId, pdfs[0].path);
    return 1;
  }
  return declaredSaved ? 1 : 0;
}

function decodeOriginalName(name) {
  if (!name) return '';
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    // 変換で壊れた(置換文字が出た)場合は元のまま使う
    return decoded.includes('\uFFFD') ? name : decoded;
  } catch (_) {
    return name;
  }
}

// ===== API =====
function registerInstructionPdfRoutes(app, db) {
  const tmpDir = path.join(os.tmpdir(), 'hiboard_instruction_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, tmpDir),
      filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + '.pdf'),
    }),
    limits: { fileSize: MAX_PDF_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      // iPad/一部ブラウザは application/octet-stream で送ってくることがあるので拡張子を主にみる
      if (ext === '.pdf') return cb(null, true);
      cb(new Error('PDFファイルだけ受け付けます'));
    },
  });
  const uploadMiddleware = (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const message = err instanceof multer.MulterError
          ? (err.code === 'LIMIT_FILE_SIZE' ? 'ファイルサイズが大きすぎます(上限30MB)' : 'ファイルの受け取りに失敗しました')
          : err.message;
        return res.status(400).json({ ok: false, error: message });
      }
      next();
    });
  };

  // 案件の指示書PDFの状況: 案件フォルダ内の指示書PDF・受信箱の候補・受付番号
  app.get('/api/projects/:id/instruction-pdf', (req, res) => {
    try {
      const project = db.prepare('SELECT id, project_name, customer_name, nas_folder_path, instruction_pdf_path FROM projects WHERE id = ?').get(req.params.id);
      if (!project) return res.status(404).json({ error: '案件が見つかりません' });
      const existing = findInstructionPdfs(project.nas_folder_path);
      if (project.instruction_pdf_path && !existing.some(f => f.path === project.instruction_pdf_path)
          && fs.existsSync(project.instruction_pdf_path)) {
        existing.unshift({ name: path.basename(project.instruction_pdf_path), path: project.instruction_pdf_path });
      }
      const inbox = listInbox(db);
      res.json({
        case_id: project.id,
        receipt_no: getReceiptNo(db, project.id),
        folder_path: project.nas_folder_path || null,
        existing,
        inbox: {
          path: inbox.path,
          files: inbox.files.map(f => ({
            ...f,
            matched_here: !!(f.match && f.match.case_id === project.id),
          })),
        },
      });
    } catch (error) {
      console.error('[指示書PDF] 状況取得でエラー:', error);
      res.status(500).json({ error: 'サーバーエラーが発生しました' });
    }
  });

  // 指示書PDFを案件フォルダへ保存する。
  //   multipart(file) … PCから選んだPDF
  //   JSON { inbox_path } … 受信箱にあるPDF
  app.post('/api/projects/:id/instruction-pdf', uploadMiddleware, (req, res) => {
    const tmpFile = req.file ? req.file.path : null;
    try {
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
      if (!project) return res.status(404).json({ ok: false, error: '案件が見つかりません' });

      let sourcePath;
      let originalName;
      if (req.file) {
        sourcePath = req.file.path;
        // multerは originalname を latin1 として読むため、日本語のファイル名が化ける。UTF-8に読み直す
        originalName = decodeOriginalName(req.file.originalname) || '指示書.pdf';
      } else if (req.body && req.body.inbox_path) {
        const resolved = path.resolve(path.normalize(String(req.body.inbox_path)));
        if (!isWithinBase(resolved, getInboxPath()) || path.extname(resolved).toLowerCase() !== '.pdf') {
          return res.status(400).json({ ok: false, error: '受信箱の外のファイルは選べません' });
        }
        if (!fs.existsSync(resolved)) {
          return res.status(400).json({ ok: false, error: 'そのファイルは受信箱にもうありません(振り分け済みの可能性があります)' });
        }
        sourcePath = resolved;
        originalName = path.basename(resolved);
      } else {
        return res.status(400).json({ ok: false, error: 'PDFファイルか受信箱のファイルを指定してください' });
      }

      const result = attachInstructionPdf(db, Number(req.params.id), sourcePath, originalName);
      res.json({ ok: true, ...result });
    } catch (error) {
      if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_) { /* 既に移動済み */ } }
      console.error('[指示書PDF] 保存でエラー:', error);
      res.status(500).json({ ok: false, error: error.message || 'サーバーエラーが発生しました' });
    }
  });

  app.get('/api/instruction-inbox', (req, res) => {
    try {
      res.json(listInbox(db));
    } catch (error) {
      console.error('[指示書PDF] 受信箱一覧でエラー:', error);
      res.status(500).json({ error: 'サーバーエラーが発生しました' });
    }
  });

  // 「今すぐ振り分け」ボタン用
  app.post('/api/instruction-inbox/scan', (req, res) => {
    try {
      res.json({ ok: true, ...runInboxCycle(db) });
    } catch (error) {
      console.error('[指示書PDF] 振り分けでエラー:', error);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました' });
    }
  });
}

// 起動時に受信箱を用意し、5分ごとに振り分けを走らせる
function scheduleInboxCycle(db) {
  const inbox = ensureInbox();
  console.log(`[指示書PDF] 受信箱: ${inbox}`);
  setTimeout(() => {
    try { runInboxCycle(db); } catch (err) { console.error('[指示書PDF] 初回振り分けでエラー:', err); }
  }, 30 * 1000);
  setInterval(() => {
    try { runInboxCycle(db); } catch (err) { console.error('[指示書PDF] 定期振り分けでエラー:', err); }
  }, 5 * 60 * 1000);
}

module.exports = {
  registerInstructionPdfRoutes,
  scheduleInboxCycle,
  resolveSavedAtDelivery,
  getInboxPath,
  getCaseFolderRoot,
  // テスト・他モジュール用
  matchInboxFile,
  runInboxCycle,
  findInstructionPdfs,
  ensureCaseFolder,
};
