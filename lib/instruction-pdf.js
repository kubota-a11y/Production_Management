// 指示書PDF(GoodNotes書き出し)の受け取りと案件・顧客への紐づけ(2026-09-11 / 顧客ノート対応 2026-09-25)。
//
// 背景: 納品時に「GoodNotesでPDF書き出し → 共有ドライブで案件フォルダを探す → 保存 →
// HiBoardで納品済みにする」を1件ずつ手作業でやっていたため、納品登録が後回しになり
// 「納品待ち」のカードが溜まっていた(三浦さん)。この処理を3方向から軽くする。
//
//   1. 受信箱方式: iPadのGoodNotesから共有ドライブの「_指示書受信箱」1か所にPDFを送るだけにし、
//      HiBoardが定期的に受信箱を見て、ファイル名から置き場を決めて移動する
//   2. 納品モーダル/納品履歴から直接: 受信箱のファイルを選ぶ or PCのファイルを送る →
//      HiBoardが案件フォルダ(無ければ DESIGN/客先名/YYYY-MM_案件名 を自動作成)へ保存する
//   3. 「後で保存する」で納品済みにした案件は、納品履歴に「指示書PDF未保存」として残し、
//      後から案件フォルダ/顧客ノートにPDFが入ったのを見つけたら自動で解消する
//
// 2026-09-25 顧客ノート方式(社長決定):
//   三浦さんのGoodNotesは「ノート=顧客」で、案件ごとのページが1冊に積み上がっていく。
//   受付番号や案件名をノート名に入れる運用は現場と合わないので、ノート全体のPDF(ファイル名=顧客名)を
//   顧客フォルダ直下の DESIGN/客先名/指示書/<ノート名>.pdf に置き、最新の全ページ版で置き換えていく。
//   前回分は <ノート名>_前回.pdf として1世代だけ残す。案件は「納品後に書き出されたノートがある」ことで
//   保存済みとみなす(案件の指示書ボタンは顧客ノートPDFを開く)。
//
// ファイル名から置き場を決める順番(matchInboxFile):
//   顧客名と完全一致(空白・記号・末尾の「指示書」「前回」「西暦」は無視) → 顧客ノート
//   受付番号(W-12 / T-5 / P-3 / M-8 / D-2 / Q-4) → 案件番号(#123) → 案件名の部分一致 → 案件フォルダ
//   案件名が複数の案件に当てはまるときは、進行中の案件を優先し、それでも決まらなければ「未紐づけ」のまま残す
//   (人が納品モーダルで選ぶ)。推測で間違った案件に入れるより、残す方が安全。
//
// 0バイトのPDF(2026-09-25 棚卸しで86件発覚):
//   iPad→Googleドライブの書き出しが途中で切れると、名前だけで中身が空のPDFがクラウドに確定する。
//   受信箱の処理はサイズ0のファイルを絶対に動かさず、受信箱に残して「書き出し失敗」と表示する。
//   フォルダ内の探索(findInstructionPdfs 等)も0バイトを指示書として数えない。
//   すでに0バイトのPDFを「保存済み」として記録している案件は、1時間ごとの点検で未保存に戻す。
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
// 顧客ノートPDFを置く顧客フォルダ直下のサブフォルダ名(旧手動フローと同じ場所)
const CUSTOMER_NOTE_DIR = '指示書';
const PREVIOUS_SUFFIX = '_前回';
// 0バイトの記録を点検する間隔(5分の振り分けサイクルの中で1時間に1回)
const EMPTY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const EMPTY_PDF_MESSAGE = '0バイトのPDFです(iPadからの書き出しが途中で切れています)。GoodNotesから書き出し直してください';

// 受付番号の頭文字 → ai_extracted_intake.line_user_id(public/js/app.js の RECEIPT_PREFIX と対)
const PREFIX_TO_SOURCE = {
  W: ['WEB'], T: ['TEAM'], P: ['PARTNER'], M: ['MAIL'], D: ['PHONE'],
  Q: ['INQ_TEAM', 'INQ_CLASS_T', 'INQ_ORIGINAL'],
};
const SOURCE_TO_PREFIX = {};
for (const [prefix, sources] of Object.entries(PREFIX_TO_SOURCE)) {
  sources.forEach(s => { SOURCE_TO_PREFIX[s] = prefix; });
}

// 利用者に見せてよい失敗(400で返す)。それ以外はサーバーエラー扱い
class UserFacingError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
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

function normalizePathForCompare(p) {
  const resolved = path.resolve(path.normalize(p));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithinBase(resolvedPath, basePath) {
  const base = path.resolve(basePath);
  const target = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
  const baseCmp = process.platform === 'win32' ? base.toLowerCase() : base;
  return target === baseCmp || target.startsWith(baseCmp + path.sep);
}

function isSamePath(a, b) {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
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

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

// 日本時間の YYYY-MM-DD(delivered_date / received_date と比べるため。UTC基準だと0〜9時に前日になる)
function localDateString(date) {
  const d = new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function safeStat(p) {
  try { return fs.statSync(p); } catch (_) { return null; }
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
      throw new UserFacingError('案件フォルダが共有ドライブの外を指しています。案件の編集でフォルダを直してください');
    }
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }
  const customer = sanitizeName(project.customer_name, '_顧客名未設定');
  const ym = /^\d{4}-\d{2}/.test(project.received_date || '')
    ? project.received_date.slice(0, 7)
    : localDateString(new Date()).slice(0, 7);
  const caseName = sanitizeName(project.project_name, `案件${project.id}`);
  const folder = path.join(getCaseFolderRoot(), customer, `${ym}_${caseName}`);
  fs.mkdirSync(folder, { recursive: true });
  db.prepare('UPDATE projects SET nas_folder_path = ?, updated_at = ? WHERE id = ?')
    .run(folder, new Date().toISOString(), project.id);
  console.log(`[指示書PDF] 案件#${project.id} のフォルダを作成しました: ${folder}`);
  return folder;
}

// 案件フォルダ(深さ2まで)にある指示書PDFを探す。名前に「指示書」または「instruction」を含む、中身のあるPDFが対象。
// 0バイトのPDF(書き出し失敗)は指示書として数えない
function findInstructionPdfs(folderPath) {
  const found = [];
  if (!folderPath) return found;
  const root = path.resolve(path.normalize(folderPath));
  if (!isWithinBase(root, getBasePath())) return found;
  const rootStat = safeStat(root);
  if (!rootStat || !rootStat.isDirectory()) return found;
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
        const stat = safeStat(full);
        if (!stat || stat.size === 0) continue;
        found.push({ name: entry.name, path: full, size: stat.size, kind: 'case' });
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

// 同じドライブ内なら rename、別ドライブ(一時フォルダ→G:)なら copy+unlink で移す。
// copy のときは移した先のサイズが元と一致することを確かめてから元を消す(途中切れを残さない)
function moveFile(src, dest) {
  const srcStat = fs.statSync(src);
  if (srcStat.size === 0) throw new UserFacingError(EMPTY_PDF_MESSAGE);
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    const destStat = safeStat(dest);
    if (!destStat || destStat.size !== srcStat.size) {
      try { fs.unlinkSync(dest); } catch (_) { /* 消せなければそのまま */ }
      throw new Error(`コピー後のサイズが一致しません(元 ${srcStat.size} / 先 ${destStat ? destStat.size : '不明'})`);
    }
    fs.unlinkSync(src);
  }
  return srcStat.size;
}

// 指示書PDFを案件に紐づける本体。sourcePath のファイルを案件フォルダへ移動し、案件と納品記録に記録する
function attachInstructionPdf(db, projectId, sourcePath, originalName) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new UserFacingError('案件が見つかりません');
  const folder = ensureCaseFolder(db, project);
  const dest = buildTargetPath(folder, originalName);
  const size = moveFile(sourcePath, dest);
  recordInstructionPdf(db, projectId, dest);
  return { mode: 'case', folder, path: dest, name: path.basename(dest), size };
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

// ===== 顧客ノート(ノート=顧客のGoodNotes全体をPDFにしたもの) =====
function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/[\s\u3000_\-‐－―ー・.,、。()（）\[\]【】]/g, '');
}

// ノート名の末尾に付きがちな「指示書」「前回」「西暦」を落として顧客名だけにする
function normalizeNoteName(base) {
  return normalizeForMatch(base)
    .replace(/(指示書|instruction)$/i, '')
    .replace(new RegExp(`${normalizeForMatch(PREVIOUS_SUFFIX)}$`), '')
    .replace(/(20\d{2})$/, '');
}

// HiBoardは顧客マスタを持たないので projects.customer_name の表記ゆれをまとめて「同じ顧客」と扱う
function listCustomerNames(db) {
  return db.prepare(`
    SELECT DISTINCT customer_name FROM projects
    WHERE customer_name IS NOT NULL AND TRIM(customer_name) != ''
  `).all().map(r => r.customer_name);
}

// ファイル名が顧客名と一致すれば { customer_names: [表記ゆれ含む全て], by } を返す。一致しなければ null
function matchCustomerNote(db, fileName) {
  const target = normalizeNoteName(path.basename(fileName, path.extname(fileName)));
  if (target.length < 2) return null;
  const hits = listCustomerNames(db).filter(c => normalizeForMatch(c) === target);
  if (hits.length === 0) return null;
  return { customer_names: hits, by: `顧客名「${hits[0]}」` };
}

// 顧客フォルダ(DESIGN/客先名)を決める。その顧客の案件フォルダが DESIGN/客先/案件 の形で登録されていれば
// その親を使い(フォルダ名と customer_name の表記が違っていても正しい場所に置ける)、無ければ customer_name で作る
function resolveCustomerFolder(db, customerNames) {
  const root = getCaseFolderRoot();
  const placeholders = customerNames.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT nas_folder_path FROM projects
    WHERE customer_name IN (${placeholders}) AND nas_folder_path IS NOT NULL AND TRIM(nas_folder_path) != ''
    ORDER BY id DESC LIMIT 50
  `).all(...customerNames);
  for (const row of rows) {
    const resolved = path.resolve(path.normalize(row.nas_folder_path.trim()));
    if (!isWithinBase(resolved, getBasePath())) continue;
    const parent = path.dirname(resolved);
    if (isSamePath(path.dirname(parent), root)) return parent;   // DESIGN/客先/案件 → 客先
    if (isSamePath(parent, root)) return resolved;               // DESIGN/客先 がそのまま登録されている
  }
  return path.join(root, sanitizeName(customerNames[0], '_顧客名未設定'));
}

function getCustomerNoteFolder(db, customerNames) {
  return path.join(resolveCustomerFolder(db, customerNames), CUSTOMER_NOTE_DIR);
}

// 顧客フォルダの「指示書」にある中身のあるPDF(前回分 _前回 は除く)。新しい順
function findCustomerNotes(db, customerNames) {
  if (!customerNames || customerNames.length === 0) return [];
  const folder = getCustomerNoteFolder(db, customerNames);
  const stat = safeStat(folder);
  if (!stat || !stat.isDirectory()) return [];
  let entries;
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch (_) { return []; }
  const notes = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || path.extname(entry.name).toLowerCase() !== '.pdf') continue;
    if (path.basename(entry.name, '.pdf').endsWith(PREVIOUS_SUFFIX)) continue;
    const full = path.join(folder, entry.name);
    const s = safeStat(full);
    if (!s || s.size === 0) continue;
    notes.push({ name: entry.name, path: full, size: s.size, modified_at: s.mtime.toISOString(), kind: 'customer_note' });
  }
  notes.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return notes;
}

// 顧客ノートPDFを、その顧客の「納品済みで指示書PDFが未保存」の案件へ紐づける。
// ノートは書き出した時点までのページを含むので、納品日がノートの書き出し日以前の案件だけを解消する
// (納品後に書き出されたノートなら、その案件のページは入っているはず)。
// forceCaseId は納品モーダルで人が選んだ案件。納品日に関係なく紐づける
function linkCustomerNote(db, customerNames, notePath, forceCaseId) {
  const stat = safeStat(notePath);
  if (!stat) return [];
  const noteDate = localDateString(stat.mtime);
  const prevPath = previousNotePath(notePath);
  const placeholders = customerNames.map(() => '?').join(',');
  const ids = db.prepare(`
    SELECT DISTINCT p.id FROM projects p
    JOIN delivery_records dr ON dr.case_id = p.id
    WHERE p.customer_name IN (${placeholders})
      AND dr.delivered_date <= ?
      AND (p.instruction_pdf_path IS NULL OR p.instruction_pdf_path = '' OR p.instruction_pdf_path = ? OR p.instruction_pdf_path = ?)
  `).all(...customerNames, noteDate, notePath, prevPath).map(r => r.id);
  if (forceCaseId && !ids.includes(forceCaseId)) ids.push(forceCaseId);
  db.transaction(() => {
    for (const id of ids) recordInstructionPdf(db, id, notePath);
  })();
  return ids;
}

function previousNotePath(notePath) {
  const dir = path.dirname(notePath);
  const base = path.basename(notePath, path.extname(notePath));
  return path.join(dir, `${base}${PREVIOUS_SUFFIX}.pdf`);
}

// 顧客ノートPDFを DESIGN/客先名/指示書/<ノート名>.pdf へ置く。既にあれば _前回 として1世代残して置き換える。
// 前回の半分未満のサイズなら「途中で切れた書き出し」の疑いがあるので置き換えず、受信箱に残す
function attachCustomerNote(db, customerNames, sourcePath, originalName, options = {}) {
  const srcStat = fs.statSync(sourcePath);
  if (srcStat.size === 0) throw new UserFacingError(EMPTY_PDF_MESSAGE);
  const folder = getCustomerNoteFolder(db, customerNames);
  fs.mkdirSync(folder, { recursive: true });
  const base = sanitizeName(path.basename(originalName, path.extname(originalName)), customerNames[0]);
  const dest = path.join(folder, `${base}.pdf`);
  const prev = previousNotePath(dest);
  const existing = safeStat(dest);
  if (existing && existing.size > 0) {
    if (srcStat.size < existing.size / 2) {
      throw new UserFacingError(
        `前回のノート(${formatBytes(existing.size)})より大幅に小さいPDF(${formatBytes(srcStat.size)})です。書き出しが途中で切れていないか確認してください`
      );
    }
    if (fs.existsSync(prev)) fs.unlinkSync(prev);
    fs.renameSync(dest, prev);
  } else if (existing) {
    // 0バイトの旧ファイルは残す価値がないので置き換える
    fs.unlinkSync(dest);
  }
  const size = moveFile(sourcePath, dest);
  const linked = linkCustomerNote(db, customerNames, dest, options.forceCaseId);
  return { mode: 'customer_note', folder, path: dest, name: path.basename(dest), size, linked_cases: linked };
}

// ===== 受信箱 =====
// ファイル名から置き場を決める。戻り値: { customer } / { project, by } / { ambiguous: [...] } / null
function matchInboxFile(db, fileName) {
  const base = path.basename(fileName, path.extname(fileName));

  // 0. 顧客名と一致 → 顧客ノート(完全一致なので最優先)
  const customer = matchCustomerNote(db, fileName);
  if (customer) return { customer };

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

// 受信箱のファイルを前回見たときの状態。サイズ・更新時刻が変わっている間は「まだ書き込み中」とみなして動かさない
const inboxSeen = new Map();   // path → { size, mtimeMs }
// 振り分けを見送った理由(前回より大幅に小さい等)。同じ状態のままなら毎サイクル同じエラーを出さない
const inboxHeld = new Map();   // path → { size, mtimeMs, reason }

// 受信箱にあるPDFの一覧(紐づけ候補付き)。移動はしない
function listInbox(db) {
  const inbox = getInboxPath();
  const files = [];
  if (!fs.existsSync(inbox)) return { path: inbox, exists: false, files };
  let entries;
  try { entries = fs.readdirSync(inbox, { withFileTypes: true }); } catch (_) { return { path: inbox, exists: false, files }; }
  const now = Date.now();
  const present = new Set();
  for (const entry of entries) {
    if (files.length >= INBOX_LIST_LIMIT) break;
    if (!entry.isFile() || entry.name.startsWith('._') || entry.name.startsWith('.')) continue;
    if (path.extname(entry.name).toLowerCase() !== '.pdf') continue;
    const full = path.join(inbox, entry.name);
    const stat = safeStat(full);
    if (!stat) continue;
    present.add(full);

    const prev = inboxSeen.get(full);
    const changed = !!prev && (prev.size !== stat.size || prev.mtimeMs !== stat.mtimeMs);
    inboxSeen.set(full, { size: stat.size, mtimeMs: stat.mtimeMs });
    const held = inboxHeld.get(full);
    const heldReason = held && held.size === stat.size && held.mtimeMs === stat.mtimeMs ? held.reason : null;
    if (held && !heldReason) inboxHeld.delete(full);

    const empty = stat.size === 0;
    const aged = now - stat.mtimeMs >= INBOX_SETTLE_MS;
    let warning = null;
    if (empty) warning = '0バイト(書き出し失敗)。iPadから書き出し直してください';
    else if (heldReason) warning = heldReason;
    else if (changed) warning = '書き込み中(サイズが変わっています)';
    else if (!aged) warning = '同期待ち(書き出し直後)';

    const match = matchInboxFile(db, entry.name);
    files.push({
      name: entry.name,
      path: full,
      size: stat.size,
      modified_at: stat.mtime.toISOString(),
      settled: !empty && aged && !changed && !heldReason,
      empty,
      warning,
      customer_match: match && match.customer
        ? { customer_name: match.customer.customer_names[0], by: match.customer.by }
        : null,
      match: match && match.project
        ? { case_id: match.project.id, project_name: match.project.project_name, customer_name: match.project.customer_name, by: match.by }
        : null,
      ambiguous: match && match.ambiguous
        ? match.ambiguous.map(p => ({ case_id: p.id, project_name: p.project_name, customer_name: p.customer_name }))
        : null,
    });
  }
  for (const key of inboxSeen.keys()) if (!present.has(key)) inboxSeen.delete(key);
  for (const key of inboxHeld.keys()) if (!present.has(key)) inboxHeld.delete(key);
  files.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return { path: inbox, exists: true, files };
}

// 「保存済み」と記録されているPDFが0バイト(書き出し失敗)なら未保存に戻す。
// 2026-09-16に34件が0バイトのまま案件フォルダへ移り「保存済み」になっていた事故の後始末と再発防止
function resetEmptyRecordedPdfs(db) {
  const rows = db.prepare(`
    SELECT id, instruction_pdf_path FROM projects
    WHERE instruction_pdf_path IS NOT NULL AND instruction_pdf_path != ''
    ORDER BY id DESC LIMIT 1000
  `).all();
  const reset = [];
  for (const row of rows) {
    const stat = safeStat(row.instruction_pdf_path);
    // ファイルが見つからない(ドライブ未接続等)ときは触らない。存在していて0バイトのときだけ戻す
    if (!stat || !stat.isFile() || stat.size > 0) continue;
    db.transaction(() => {
      db.prepare('UPDATE projects SET instruction_pdf_path = NULL, instruction_pdf_saved_at = NULL, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), row.id);
      db.prepare('UPDATE delivery_records SET instruction_pdf_saved = 0 WHERE case_id = ? AND instruction_pdf_saved = 1')
        .run(row.id);
    })();
    reset.push(row.id);
  }
  if (reset.length > 0) {
    console.warn(`[指示書PDF] 0バイトの指示書PDFが記録されていた案件を未保存に戻しました: ${reset.length}件(案件#${reset.join(', #')})`);
  }
  return reset;
}

let cycleRunning = false;
let lastEmptyCheckAt = 0;
// 定期処理: (1) 受信箱で置き場が決まったPDFを顧客ノート/案件フォルダへ移す
//          (2) 「後で保存する」で納品した案件のフォルダか顧客ノートに指示書PDFがあれば未保存を解消する
//          (3) 1時間に1回、0バイトのPDFを「保存済み」にしている案件を未保存に戻す
function runInboxCycle(db, options = {}) {
  if (cycleRunning) return { skipped: true };
  cycleRunning = true;
  const summary = { moved: [], resolved: [], reset: [], unmatched: 0, empty: 0, waiting: 0, errors: [] };
  try {
    const { files } = listInbox(db);
    for (const file of files) {
      if (file.empty) { summary.empty++; continue; }
      if (!file.settled) { summary.waiting++; continue; }
      try {
        if (file.customer_match) {
          const match = matchCustomerNote(db, file.name);
          const result = attachCustomerNote(db, match.customer_names, file.path, file.name);
          summary.moved.push({ mode: 'customer_note', from: file.name, to: result.name, by: match.by, linked_cases: result.linked_cases });
          console.log(`[指示書PDF] 受信箱 → 顧客ノート(${match.by}): ${file.name} → ${result.path}(紐づけ ${result.linked_cases.length}件)`);
        } else if (file.match) {
          const result = attachInstructionPdf(db, file.match.case_id, file.path, file.name);
          summary.moved.push({ mode: 'case', case_id: file.match.case_id, from: file.name, to: result.name, by: file.match.by });
          console.log(`[指示書PDF] 受信箱 → 案件#${file.match.case_id}(${file.match.by}): ${file.name} → ${result.path}`);
        } else {
          summary.unmatched++;
        }
      } catch (err) {
        const stat = safeStat(file.path);
        if (err instanceof UserFacingError && stat) {
          // 同じ状態のままなら次のサイクルで黙って見送る(画面には理由が出る)
          inboxHeld.set(file.path, { size: stat.size, mtimeMs: stat.mtimeMs, reason: err.message });
        }
        summary.errors.push({ file: file.name, error: err.message });
        console.error(`[指示書PDF] 受信箱の振り分けに失敗 ${file.name}: ${err.message}`);
      }
    }

    const pending = db.prepare(`
      SELECT p.id, p.nas_folder_path, p.customer_name, MAX(dr.delivered_date) AS delivered_date
      FROM delivery_records dr
      JOIN projects p ON p.id = dr.case_id
      WHERE dr.instruction_pdf_saved = 0
        AND (p.instruction_pdf_path IS NULL OR p.instruction_pdf_path = '')
      GROUP BY p.id
    `).all();
    for (const p of pending) {
      const pdfs = findInstructionPdfs(p.nas_folder_path);
      if (pdfs.length > 0) {
        recordInstructionPdf(db, p.id, pdfs[0].path);
        summary.resolved.push({ case_id: p.id, name: pdfs[0].name, mode: 'case' });
        console.log(`[指示書PDF] 案件#${p.id} のフォルダに指示書PDFを確認: ${pdfs[0].name}(未保存を解消)`);
        continue;
      }
      const note = findCustomerNoteFor(db, p.customer_name, p.delivered_date);
      if (note) {
        recordInstructionPdf(db, p.id, note.path);
        summary.resolved.push({ case_id: p.id, name: note.name, mode: 'customer_note' });
        console.log(`[指示書PDF] 案件#${p.id} は納品後に書き出された顧客ノートを確認: ${note.name}(未保存を解消)`);
      }
    }

    if (options.checkEmpty || Date.now() - lastEmptyCheckAt >= EMPTY_CHECK_INTERVAL_MS) {
      lastEmptyCheckAt = Date.now();
      summary.reset = resetEmptyRecordedPdfs(db);
    }
  } finally {
    cycleRunning = false;
  }
  return summary;
}

// 顧客名の表記ゆれを含めて、指定日以降(YYYY-MM-DD)に書き出された顧客ノートを返す。sinceDate が空なら最新のノート
function findCustomerNoteFor(db, customerName, sinceDate) {
  if (!customerName) return null;
  const target = normalizeForMatch(customerName);
  const names = listCustomerNames(db).filter(c => normalizeForMatch(c) === target);
  if (names.length === 0) names.push(customerName);
  const notes = findCustomerNotes(db, names);
  if (notes.length === 0) return null;
  if (!sinceDate) return notes[0];
  return notes.find(n => localDateString(n.modified_at) >= sinceDate.slice(0, 10)) || null;
}

// ===== 納品時の判定 =====
// 納品モーダルで「保存済み」と申告されなくても、案件にPDFの記録があるか、案件フォルダに実物があるか、
// 受注後に書き出された顧客ノートがあれば保存済みとみなす
function resolveSavedAtDelivery(db, projectId, declaredSaved) {
  const project = db.prepare('SELECT id, customer_name, received_date, nas_folder_path, instruction_pdf_path FROM projects WHERE id = ?').get(projectId);
  if (!project) return 0;
  if (project.instruction_pdf_path) {
    const stat = safeStat(project.instruction_pdf_path);
    if (!stat || stat.size > 0) return 1;
    // 0バイトを指していたら記録を信用せず、下の実物確認へ
  }
  const pdfs = findInstructionPdfs(project.nas_folder_path);
  if (pdfs.length > 0) {
    recordInstructionPdf(db, projectId, pdfs[0].path);
    return 1;
  }
  const note = findCustomerNoteFor(db, project.customer_name, project.received_date);
  if (note) {
    recordInstructionPdf(db, projectId, note.path);
    return 1;
  }
  return declaredSaved ? 1 : 0;
}

// 受信箱から消えたファイルが、振り分け済みで移動先にあるかを探す(顧客ノート → 案件フォルダの順)
function findAlreadyMoved(db, projectId, originalName, customer) {
  if (customer) {
    const note = findCustomerNotes(db, customer.customer_names).find(n => n.name === originalName);
    if (note) {
      const linked = linkCustomerNote(db, customer.customer_names, note.path, projectId);
      return { mode: 'customer_note', folder: path.dirname(note.path), path: note.path, name: note.name, size: note.size, linked_cases: linked };
    }
    return null;
  }
  const project = db.prepare('SELECT nas_folder_path FROM projects WHERE id = ?').get(projectId);
  const base = sanitizeName(path.basename(originalName, path.extname(originalName)), '');
  const hit = project && base
    ? findInstructionPdfs(project.nas_folder_path).find(f => f.name.startsWith(base))
    : null;
  if (!hit) return null;
  recordInstructionPdf(db, projectId, hit.path);
  return { mode: 'case', folder: path.dirname(hit.path), path: hit.path, name: hit.name, size: hit.size };
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

  // 案件の指示書PDFの状況: 案件フォルダ内の指示書PDF・顧客ノート・受信箱の候補・受付番号
  app.get('/api/projects/:id/instruction-pdf', (req, res) => {
    try {
      const project = db.prepare('SELECT id, project_name, customer_name, received_date, nas_folder_path, instruction_pdf_path FROM projects WHERE id = ?').get(req.params.id);
      if (!project) return res.status(404).json({ error: '案件が見つかりません' });
      const existing = findInstructionPdfs(project.nas_folder_path);
      let recordedEmpty = false;
      if (project.instruction_pdf_path && !existing.some(f => f.path === project.instruction_pdf_path)) {
        const stat = safeStat(project.instruction_pdf_path);
        if (stat && stat.size > 0) {
          // 顧客フォルダの「指示書」に置いたノートPDFなら顧客ノートとして見せる
          const isNote = path.basename(path.dirname(project.instruction_pdf_path)) === CUSTOMER_NOTE_DIR;
          existing.unshift({ name: path.basename(project.instruction_pdf_path), path: project.instruction_pdf_path, size: stat.size, kind: isNote ? 'customer_note' : 'case' });
        } else if (stat) {
          recordedEmpty = true;
        }
      }
      // 顧客ノート: 受注後に書き出されたものだけ「この案件のページが入っている」とみなして existing に出す
      const note = findCustomerNoteFor(db, project.customer_name, project.received_date);
      if (note && !existing.some(f => f.path === note.path)) existing.push(note);
      const inbox = listInbox(db);
      res.json({
        case_id: project.id,
        customer_name: project.customer_name,
        receipt_no: getReceiptNo(db, project.id),
        folder_path: project.nas_folder_path || null,
        existing,
        recorded_empty: recordedEmpty,
        inbox: {
          path: inbox.path,
          files: inbox.files.map(f => ({
            ...f,
            matched_here: !!(f.match && f.match.case_id === project.id)
              || !!(f.customer_match && normalizeForMatch(f.customer_match.customer_name) === normalizeForMatch(project.customer_name)),
          })),
        },
      });
    } catch (error) {
      console.error('[指示書PDF] 状況取得でエラー:', error);
      res.status(500).json({ error: 'サーバーエラーが発生しました' });
    }
  });

  // 指示書PDFを保存する。
  //   multipart(file) … PCから選んだPDF → 案件フォルダ
  //   JSON { inbox_path } … 受信箱にあるPDF → 顧客名と一致すれば顧客ノート(この案件も紐づける)、それ以外は案件フォルダ
  app.post('/api/projects/:id/instruction-pdf', uploadMiddleware, (req, res) => {
    const tmpFile = req.file ? req.file.path : null;
    try {
      const projectId = Number(req.params.id);
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
      if (!project) return res.status(404).json({ ok: false, error: '案件が見つかりません' });

      let result;
      if (req.file) {
        if (!req.file.size) throw new UserFacingError(EMPTY_PDF_MESSAGE);
        // multerは originalname を latin1 として読むため、日本語のファイル名が化ける。UTF-8に読み直す
        const originalName = decodeOriginalName(req.file.originalname) || '指示書.pdf';
        result = attachInstructionPdf(db, projectId, req.file.path, originalName);
      } else if (req.body && req.body.inbox_path) {
        const resolved = path.resolve(path.normalize(String(req.body.inbox_path)));
        if (!isWithinBase(resolved, getInboxPath()) || path.extname(resolved).toLowerCase() !== '.pdf') {
          return res.status(400).json({ ok: false, error: '受信箱の外のファイルは選べません' });
        }
        const originalName = path.basename(resolved);
        const customer = matchCustomerNote(db, originalName);
        if (!fs.existsSync(resolved)) {
          // 納品モーダルを開いている間に5分ごとの振り分けが先に動いた場合。移動先に同じファイルがあれば、それをこの案件に紐づけて成功にする
          const already = findAlreadyMoved(db, projectId, originalName, customer);
          if (already) return res.json({ ok: true, ...already, already_moved: true });
          return res.status(400).json({ ok: false, error: 'そのファイルは受信箱にもうありません(振り分け済みの可能性があります)' });
        }
        result = customer
          ? attachCustomerNote(db, customer.customer_names, resolved, originalName, { forceCaseId: projectId })
          : attachInstructionPdf(db, projectId, resolved, originalName);
      } else {
        return res.status(400).json({ ok: false, error: 'PDFファイルか受信箱のファイルを指定してください' });
      }
      res.json({ ok: true, ...result });
    } catch (error) {
      if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_) { /* 既に移動済み */ } }
      if (error instanceof UserFacingError) {
        return res.status(400).json({ ok: false, error: error.message });
      }
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

  // 「今すぐ振り分け」ボタン用(0バイトの記録の点検も一緒に走らせる)
  app.post('/api/instruction-inbox/scan', (req, res) => {
    try {
      res.json({ ok: true, ...runInboxCycle(db, { checkEmpty: true }) });
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
    try { runInboxCycle(db, { checkEmpty: true }); } catch (err) { console.error('[指示書PDF] 初回振り分けでエラー:', err); }
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
  matchCustomerNote,
  runInboxCycle,
  findInstructionPdfs,
  findCustomerNotes,
  findCustomerNoteFor,
  resetEmptyRecordedPdfs,
  ensureCaseFolder,
};
