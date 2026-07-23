require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { initDatabase } = require('./db/init');
const line = require('@line/bot-sdk');
const { runExtractionCycle } = require('./lib/ai-extraction');
const { registerOrderRoutes } = require('./lib/order-intake');
const { registerTeamOrderRoutes } = require('./lib/team-order');
const { scheduleDailyBackup } = require('./lib/db-backup');
const { extractCarriedData, extractCarriedItems } = require('./lib/intake-carry');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
// NAS_BASE_PATH は .env で明示的に指定するのが基本。
// 未設定時のデフォルトはOSごとに変える（Windowsではマップ済みドライブ文字 or UNCパスを想定）。
const NAS_BASE_PATH = process.env.NAS_BASE_PATH
  || (process.platform === 'win32' ? 'Z:\\DESIGN' : '/Volumes/disk1/DESIGN');

// パス比較用ヘルパー。Windowsはファイルパスの大文字小文字を区別しないため、
// セキュリティチェック(startsWith)がケース違いで誤ってブロックしないよう吸収する。
function isWithinBase(resolvedPath, basePath) {
  const base = path.resolve(basePath);
  if (process.platform === 'win32') {
    return resolvedPath.toLowerCase().startsWith(base.toLowerCase());
  }
  return resolvedPath.startsWith(base);
}

// OSのファイルマネージャでファイル/フォルダを開く（Finder/エクスプローラー/ファイルマネージャ）
function openInFileManager(targetPath) {
  if (process.platform === 'win32') {
    // explorer.exeは正常に開いた場合でも終了コード1を返すことがあるため、
    // execFileSyncの例外は握りつぶす（起動コマンド自体が失敗した場合のみ気にする）
    try {
      execFileSync('explorer', [targetPath]);
    } catch (err) {
      // ENOENT(explorerが見つからない)等の致命的エラーのみ再スロー
      if (err.code === 'ENOENT') throw err;
    }
  } else if (process.platform === 'darwin') {
    execFileSync('open', [targetPath]);
  } else {
    execFileSync('xdg-open', [targetPath]);
  }
}

app.use(cors());

// LINE Messaging APIのWebhook。line.middleware()が生のリクエストボディから
// 署名検証を行うため、ボディをパースしてしまうbodyParserより前に登録する。
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});
const lineBlobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const db = initDatabase();

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// line_usersを確認し、未登録なら getProfile で表示名を取得して新規登録、
// 既存ならlast_message_atのみ更新する。getProfile失敗時もdisplay_name=nullで登録を続行する。
async function upsertLineUser(userId) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT line_user_id FROM line_users WHERE line_user_id = ?').get(userId);
  if (existing) {
    db.prepare('UPDATE line_users SET last_message_at = ? WHERE line_user_id = ?').run(now, userId);
    return;
  }
  let displayName = null;
  try {
    const profile = await lineClient.getProfile(userId);
    displayName = profile.displayName || null;
  } catch (err) {
    console.error(`[LINE Webhook] getProfile失敗 userId=${userId}:`, err.message);
  }
  db.prepare(`
    INSERT INTO line_users (line_user_id, display_name, first_seen_at, last_message_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, displayName, now, now);
}

function insertLineMessage({ lineUserId, lineMessageId, messageType, textContent, imagePath }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO line_messages
      (line_user_id, line_message_id, message_type, text_content, image_path, received_at, processed, case_id)
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL)
  `).run(lineUserId, lineMessageId, messageType, textContent, imagePath, now);
}

// 画像を取得しNAS上に保存する。取得・保存いずれかが失敗した場合はエラーをログに出しnullを返す(処理は継続)。
async function saveLineImage(userId, messageId) {
  const dir = path.join(NAS_BASE_PATH, 'LINE_RECEIVED', userId);
  const filePath = path.join(dir, `${messageId}.jpg`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stream = await lineBlobClient.getMessageContent(messageId);
    const buffer = await streamToBuffer(stream);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (err) {
    console.error(`[LINE Webhook] 画像保存失敗 messageId=${messageId}:`, err.message);
    return null;
  }
}

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  const events = req.body.events || [];
  for (const event of events) {
    try {
      const userId = event.source && event.source.userId;
      console.log(`[LINE Webhook] type=${event.type} userId=${userId}`);
      if (!userId) continue;

      await upsertLineUser(userId);

      if (event.type === 'message') {
        const message = event.message;
        if (message.type === 'text') {
          console.log(`[LINE Webhook] text: ${message.text}`);
          insertLineMessage({
            lineUserId: userId,
            lineMessageId: message.id,
            messageType: 'text',
            textContent: message.text,
            imagePath: null,
          });
        } else if (message.type === 'image') {
          console.log('[LINE Webhook] image message received');
          const imagePath = await saveLineImage(userId, message.id);
          insertLineMessage({
            lineUserId: userId,
            lineMessageId: message.id,
            messageType: 'image',
            textContent: null,
            imagePath,
          });
        } else {
          insertLineMessage({
            lineUserId: userId,
            lineMessageId: message.id,
            messageType: message.type,
            textContent: null,
            imagePath: null,
          });
        }
      }
    } catch (err) {
      console.error('[LINE Webhook] イベント処理でエラー:', err);
    }
  }
  res.sendStatus(200);
});

// LINE SDKのmiddleware()は署名不正時にnext(err)するだけなので、
// ここで400を返す（署名エラー以外はサーバー側の問題として500）。
app.use('/webhook', (err, req, res, next) => {
  if (err instanceof line.SignatureValidationFailed) {
    return res.status(400).send(err.message);
  }
  if (err instanceof line.JSONParseError) {
    return res.status(400).send(err.message);
  }
  console.error('[LINE Webhook] error:', err);
  res.status(500).end();
});

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
// お客様向け「ご注文の流れ」ページ(オーダーフォームと同じ公開ページ)
app.get('/guide', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'guide.html'));
});

// 選手応援 特設ページ(2件目以降は /support/{slug} の汎用化を検討)
app.get('/support/hayashi', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'support-hayashi.html'));
});

// 選手専用ドメイン → トップ(/)で直接その特設ページを表示する対応表。
// 新しい選手ドメインを増やすときはこの表に1行足すだけ。
// .env の SUPPORT_DOMAINS で上書き可(例: "genpei-hayashi.com=support-hayashi.html,foo.com=support-foo.html")。
const SUPPORT_DOMAIN_MAP = (() => {
  const map = {
    'genpei-hayashi.com': 'support-hayashi.html',
    'www.genpei-hayashi.com': 'support-hayashi.html',
  };
  if (process.env.SUPPORT_DOMAINS) {
    for (const pair of process.env.SUPPORT_DOMAINS.split(',')) {
      const [host, file] = pair.split('=').map((s) => s && s.trim());
      if (host && file) map[host.toLowerCase()] = file;
    }
  }
  return map;
})();

// 選手専用ドメインのトップ(/)は特設ページを返す。
// express.static が / に index.html を返す前に処理する必要があるため、静的配信より前に置く。
app.get('/', (req, res, next) => {
  const supportPage = SUPPORT_DOMAIN_MAP[(req.hostname || '').toLowerCase()];
  if (supportPage) {
    return res.sendFile(path.join(__dirname, 'public', supportPage));
  }
  next();
});

// no-cache = 「使う前に毎回サーバーへ更新確認」(キャッシュ全否定ではない)。
// 未更新なら304で済むためLAN内では体感差なし。これにより本番反映後の
// ハードリフレッシュ(Ctrl+Shift+R)が不要になり、古いJSを掴んだままの端末が出なくなる。
app.use(express.static('public', {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get('/api/nas/list', (req, res) => {
  try {
    const requestedPath = req.query.path || NAS_BASE_PATH;
    const normalized = path.normalize(requestedPath);
    const resolved = path.resolve(normalized);
    if (!isWithinBase(resolved, NAS_BASE_PATH)) {
      return res.status(400).json({ error: '不正なパスです' });
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return res.json({ path: resolved, exists: false, entries: [] });
    }
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      // NAS(SMB)上でmacOSが自動生成する隠しメタデータファイル（リソースフォーク等）を除外
      .filter(item => !item.name.startsWith('._') && item.name !== '.DS_Store')
      .map(item => ({
        name: item.name,
        isDirectory: item.isDirectory(),
        path: path.join(resolved, item.name)
      }));
    // If entries are inside the public directory, expose a publicUrl so the frontend
    // can open previews directly (only for files served by express.static)
    const publicDir = path.resolve(__dirname, 'public');
    const enhanced = entries.map(e => {
      const fullPath = e.path;
      let publicUrl = null;
      try {
        const rel = path.relative(publicDir, fullPath);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          // convert path separators to URL form and encode segments
          publicUrl = '/' + rel.split(path.sep).map(encodeURIComponent).join('/');
        }
      } catch (err) {
        publicUrl = null;
      }
      return { ...e, publicUrl };
    });

    res.json({ path: resolved, exists: true, entries: enhanced });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/nas/open', (req, res) => {
  try {
    const requestedPath = req.body.path;
    if (!requestedPath) return res.status(400).json({ error: 'Path is required' });
    const normalized = path.normalize(requestedPath);
    const resolved = path.resolve(normalized);
    if (!isWithinBase(resolved, NAS_BASE_PATH)) {
      return res.status(400).json({ error: '不正なパスです' });
    }
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'ファイルが見つかりません' });
    }
    openInFileManager(resolved);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// NASファイルをブラウザ経由でプレビュー/ダウンロード（LAN上のどの端末からでも利用可能）
app.get('/api/nas/download', (req, res) => {
  try {
    const requestedPath = req.query.path;
    if (!requestedPath) return res.status(400).json({ error: 'Path is required' });
    const normalized = path.normalize(requestedPath);
    const resolved = path.resolve(normalized);
    if (!isWithinBase(resolved, NAS_BASE_PATH)) {
      return res.status(400).json({ error: '不正なパスです' });
    }
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      return res.status(404).json({ error: 'ファイルが見つかりません' });
    }
    res.sendFile(resolved);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects', (req, res) => {
  try {
    // allocated_hours_total: 案件ごとにこれまで作業計画（case_time_allocations）へ割り振った予定時間の合計（時間単位・全期間）
    // 週間スケジュールボードで「案件の作業予定時間（分→時間換算）に対してすでに割り振り済みかどうか」を判定するために使用する
    const projects = db.prepare(`
      SELECT p.*, s.name as assigned_staff_name, emp.name as assigned_employee_name,
        COALESCE(alloc.total_planned, 0) as allocated_hours_total
      FROM projects p
      LEFT JOIN staff s ON p.assigned_staff_id = s.id
      LEFT JOIN employees emp ON p.assigned_employee_id = emp.id
      LEFT JOIN (
        SELECT case_id, SUM(planned_hours) as total_planned
        FROM case_time_allocations
        GROUP BY case_id
      ) alloc ON alloc.case_id = p.id
      ORDER BY p.deadline ASC
    `).all();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects/:id', (req, res) => {
  try {
    const project = db.prepare(`
      SELECT p.*, s.name as assigned_staff_name, emp.name as assigned_employee_name
      FROM projects p
      LEFT JOIN staff s ON p.assigned_staff_id = s.id
      LEFT JOIN employees emp ON p.assigned_employee_id = emp.id
      WHERE p.id = ?
    `).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 案件に対する担当者候補を提案する
// Dateをローカルタイムゾーンのまま YYYY-MM-DD 文字列に変換する。
// toISOString()はUTCに変換するため、JST(UTC+9)ではローカル日付の0時が
// 前日のUTC15時になり、日付が1日ずれてしまう(例: 7/13 0:00 JST → "2026-07-12")
function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// スキルタグ・加工種別の突き合わせ用に文字列を正規化する。
// 全角英数字/アンダースコア/スペースを半角に変換し、前後空白除去・大文字化する
// (IME入力で全角になりがちな箇所や大文字小文字の揺れを吸収するため)
function normalizeTag(str) {
  if (!str) return '';
  return str
    .trim()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
    .replace(/＿/g, '_')
    .toUpperCase();
}

// タスクスケジューラ等のバックグラウンド実行ではコンソールが見えないため、
// 自動提案の診断ログはファイルに追記する(db/debug.log)
const debugLogPath = path.join(__dirname, 'db', 'debug.log');
function writeDebugLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(debugLogPath, line);
  } catch (error) {
    console.error('デバッグログの書き込みに失敗しました:', error.message);
  }
}

// 案件の実所要時間を、自動割り振り(calculateSuggestions/allocateHoursForEmployee)と
// 同じ計算式(quantity ÷ 担当者の生産性 employee_process_rates)で算出する。
// projects.planned_hours は手入力の見積もり参考値であり、実際の割り振りには使われないため、
// 「実際にはどれだけ必要か」を表示する箇所(案件別消化率など)ではこちらを基準にする。
// スキル不一致の判定はここでは行わない(表示用の目安値のため)。生産性が未登録の
// 工程が1つでもあれば canHandleAll=false を返し、呼び出し側でフォールバックを判断させる
function calculateRequiredHours(db, project, employeeId) {
  const processTypes = (project.process_type || '').split(',').map(t => t.trim()).filter(Boolean);
  const quantity = project.quantity || 0;
  const printLocations = db.prepare('SELECT * FROM case_print_locations WHERE case_id = ?').all(project.id);
  const rateStmt = db.prepare(
    'SELECT * FROM employee_process_rates WHERE employee_id = ? AND process_type = ? AND color_count = ?'
  );

  let requiredHours = 0;
  let canHandleAll = true;

  if (processTypes.includes('SILK_SCREEN_PRINT')) {
    if (printLocations.length === 0) {
      canHandleAll = false;
    } else {
      for (const loc of printLocations) {
        const rate = rateStmt.get(employeeId, 'SILK_SCREEN_PRINT', loc.color_count);
        if (!rate || rate.units_per_hour <= 0) {
          canHandleAll = false;
          continue;
        }
        requiredHours += quantity / rate.units_per_hour;
      }
    }
  }

  for (const pt of processTypes) {
    if (pt === 'SILK_SCREEN_PRINT') continue;
    const rate = rateStmt.get(employeeId, pt, 1);
    if (!rate || rate.units_per_hour <= 0) {
      canHandleAll = false;
      continue;
    }
    requiredHours += quantity / rate.units_per_hour;
  }

  return { requiredHours, canHandleAll };
}

// 案件の必要合計時間を算出する。実際の自動割り振り(allocateHoursForEmployee)が
// 使うのと同じrequired_hours(quantity ÷ 担当者の生産性)を基準にし、
// 担当者未割り当て・生産性未登録の場合は手入力のplanned_hours(分単位)を
// 時間換算したものにフォールバックする。
// /api/stats/project-progress と /api/projects/:id/actual-hours-check の
// 両方から共通で使う
function calculateProjectRequiredHoursTotal(db, project) {
  let requiredHoursTotal = project.planned_hours / 60;
  let requiredHoursSource = 'planned_hours';

  if (project.assigned_employee_id) {
    const { requiredHours, canHandleAll } = calculateRequiredHours(db, project, project.assigned_employee_id);
    if (canHandleAll && requiredHours > 0) {
      requiredHoursTotal = requiredHours;
      requiredHoursSource = 'required_hours';
    }
  }

  return { requiredHoursTotal, requiredHoursSource };
}

// 案件に対する担当者候補をスコアリングする(空き時間・スキル一致・生産性から算出)。
// 締切日の妥当性チェックは呼び出し側の責務(この関数は project.deadline が有効な前提)
function calculateSuggestions(db, project, options = {}) {
  // quiet: true の場合、診断ログの書き込みを抑制する。提案確認パネルの一覧表示など
  // 高頻度・多案件でこの関数を呼ぶ場面でdebug.logが肥大化するのを防ぐため
  const quiet = options.quiet === true;
  const today = new Date();
  const deadline = new Date(project.deadline);

  // 今日から締切日までの日付リストを作成(最大60日でガード)
  const dateList = [];
  const cursor = new Date(today);
  cursor.setHours(0, 0, 0, 0);
  const endDate = new Date(deadline);
  endDate.setHours(0, 0, 0, 0);
  let guard = 0;
  while (cursor <= endDate && guard < 60) {
    dateList.push(formatLocalDate(cursor)); // YYYY-MM-DD
    cursor.setDate(cursor.getDate() + 1);
    guard++;
  }

  const employees = db.prepare('SELECT * FROM employees WHERE is_active = 1').all();

  const overrideStmt = db.prepare(
    'SELECT * FROM schedule_overrides WHERE employee_id = ? AND work_date = ?'
  );
  const defaultStmt = db.prepare(
    'SELECT * FROM employee_default_schedule WHERE employee_id = ? AND weekday = ?'
  );
  // 前準備・後片付け(setup_minutes/cleanup_minutes、自動割当ボタン専用)もその日の
  // 空き時間を消費済みとして扱う。両方0の行では合計に影響しない
  const allocationStmt = db.prepare(
    `SELECT COALESCE(SUM(planned_hours + (setup_minutes + cleanup_minutes) / 60.0), 0) as total
     FROM case_time_allocations WHERE employee_id = ? AND work_date BETWEEN ? AND ?`
  );

  function timeToHours(start, end, breakMinutes) {
    if (!start || !end) return 0;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const minutes = (eh * 60 + em) - (sh * 60 + sm) - (breakMinutes || 0);
    return Math.max(0, minutes / 60);
  }

  const requiredTags = (project.required_skill_tags || '')
    .split(',').map(t => t.trim()).filter(Boolean);

  const processTypes = (project.process_type || '').split(',').map(t => t.trim()).filter(Boolean);
  const quantity = project.quantity || 0;
  const printLocations = db.prepare('SELECT * FROM case_print_locations WHERE case_id = ?').all(project.id);
  const rateStmt = db.prepare(
    'SELECT * FROM employee_process_rates WHERE employee_id = ? AND process_type = ? AND color_count = ?'
  );

  const results = employees.map(emp => {
    let availableHours = 0;
    let hasUnknownDay = false;

    dateList.forEach(dateStr => {
      const weekday = new Date(dateStr).getDay();
      const override = overrideStmt.get(emp.id, dateStr);

      if (override) {
        if (!override.is_day_off) {
          availableHours += timeToHours(override.start_time, override.end_time, override.break_minutes);
        }
        return;
      }

      const def = defaultStmt.get(emp.id, weekday);
      if (def) {
        if (def.is_working) {
          availableHours += timeToHours(def.start_time, def.end_time, def.break_minutes);
        }
        return;
      }

      // schedule_overrides にも employee_default_schedule にも情報がない日
      hasUnknownDay = true;
    });

    const allocated = allocationStmt.get(emp.id, dateList[0], dateList[dateList.length - 1]).total;
    const remainingHours = Math.max(0, availableHours - allocated);

    // スキル一致
    const empTagsRaw = (emp.skill_tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const empTags = empTagsRaw.map(normalizeTag);
    const matchedTags = requiredTags.filter(t => empTags.includes(normalizeTag(t)));
    const skillScore = requiredTags.length === 0 ? 1 : matchedTags.length / requiredTags.length;

    // 加工種別ごとのスキル一致判定。employees.skill_tags(「得意スキル」欄、
    // SILK_SCREEN_PRINT・DTF_PRINT等の加工種別名で運用)に、案件のprocess_typeが
    // 含まれているかを確認する。skill_tagsが未登録(空)の従業員は判定材料が無いため
    // 除外はせず、従来通り生産性データの有無のみで判定する(誤って全員を弾かないため)。
    // 全角/半角・大文字小文字はnormalizeTagで吸収し、さらに"SILK_SCREEN"のように
    // 末尾を省略した略称でも前方一致でヒットするようにする(完全一致だけだと
    // "SILK_SCREEN_PRINT"との表記ゆれで正しい候補まで弾いてしまうため)
    function tagCoversProcessType(pt) {
      const normPt = normalizeTag(pt);
      return empTags.some(tag => normPt === tag || normPt.startsWith(tag));
    }
    const processTypeSkillMismatches = empTags.length > 0
      ? processTypes.filter(pt => !tagCoversProcessType(pt))
      : [];
    const hasSkillMismatch = processTypeSkillMismatches.length > 0;

    // 加工種別ごとの生産性(units_per_hour)から所要時間を算出する。
    // SILK_SCREEN_PRINT はプリント箇所ごとに色数に応じた生産性で計算し合算、それ以外は color_count=1 で計算する
    let requiredHours = 0;
    let canHandleAll = true;
    const processDetails = [];

    if (processTypes.includes('SILK_SCREEN_PRINT')) {
      if (processTypeSkillMismatches.includes('SILK_SCREEN_PRINT')) {
        canHandleAll = false;
        processDetails.push({ process_type: 'SILK_SCREEN_PRINT', note: 'スキル未登録(対応不可)' });
      } else if (printLocations.length === 0) {
        canHandleAll = false;
        processDetails.push({ process_type: 'SILK_SCREEN_PRINT', note: 'プリント箇所が未登録' });
      } else {
        for (const loc of printLocations) {
          const rate = rateStmt.get(emp.id, 'SILK_SCREEN_PRINT', loc.color_count);
          if (!rate || rate.units_per_hour <= 0) {
            canHandleAll = false;
            processDetails.push({ process_type: 'SILK_SCREEN_PRINT', location_name: loc.location_name, color_count: loc.color_count, units_per_hour: null });
            continue;
          }
          const hours = quantity / rate.units_per_hour;
          requiredHours += hours;
          processDetails.push({ process_type: 'SILK_SCREEN_PRINT', location_name: loc.location_name, color_count: loc.color_count, units_per_hour: rate.units_per_hour, hours: Math.round(hours * 10) / 10 });
        }
      }
    }

    for (const pt of processTypes) {
      if (pt === 'SILK_SCREEN_PRINT') continue;
      if (processTypeSkillMismatches.includes(pt)) {
        canHandleAll = false;
        processDetails.push({ process_type: pt, note: 'スキル未登録(対応不可)' });
        continue;
      }
      const rate = rateStmt.get(emp.id, pt, 1);
      if (!rate || rate.units_per_hour <= 0) {
        canHandleAll = false;
        processDetails.push({ process_type: pt, units_per_hour: null });
        continue;
      }
      const hours = quantity / rate.units_per_hour;
      requiredHours += hours;
      processDetails.push({ process_type: pt, units_per_hour: rate.units_per_hour, hours: Math.round(hours * 10) / 10 });
    }

    // 空き時間スコア(必要工数に対する充足率、上限1.0)。
    // canHandleAll=false(スキル未登録、または一部工程の生産性が未登録で対応不可)の場合、
    // requiredHoursが0のまま「必要工数がそもそも0時間」のケースと区別がつかなくなり、
    // 一般的な空き時間(8時間基準)だけで満点近いスコアが付いてしまう。
    // 実際には対応できないため空き時間スコアは0とする
    const availabilityScore = !canHandleAll
      ? 0
      : requiredHours > 0
        ? Math.min(1, remainingHours / requiredHours)
        : Math.min(1, remainingHours / 8); // 生産性設定済みで所要時間0時間の場合のみ、1日分を基準に

    // スキル不一致(=その加工を担当した実績・登録が無い)は「空き時間はあるが対応できない」
    // 明確な対応不可であり、生産性未登録(単に単価を入れ忘れているだけ)とは区別してscoreを0にする
    const score = hasSkillMismatch ? 0 : availabilityScore * 0.5 + skillScore * 0.5;

    let reason;
    if (hasSkillMismatch) {
      reason = `スキル不一致(対応不可な工程: ${processTypeSkillMismatches.join(',')})`;
    } else if (requiredTags.length > 0 && matchedTags.length === 0) {
      reason = '空き時間はあるがスキルタグ未一致';
    } else if (!canHandleAll) {
      reason = 'スキル一致だが一部作業の生産性が未設定';
    } else if (remainingHours <= 0) {
      reason = 'スキル一致だが空き時間が不足';
    } else {
      reason = 'スキル一致・空き時間十分';
    }
    if (hasUnknownDay) {
      reason += '(勤務未確定の日を含む)';
    }

    if (!quiet) {
      writeDebugLog(
        `[calculateSuggestions] project=${project.id} process_type(raw)="${project.process_type}" processTypes=${JSON.stringify(processTypes)} ` +
        `employee=${emp.id}(${emp.name}) skill_tags(raw)="${emp.skill_tags || ''}" empTags(normalized)=${JSON.stringify(empTags)} ` +
        `availableHours=${Math.round(availableHours * 10) / 10} ` +
        `allocated=${Math.round(allocated * 10) / 10} remainingHours=${Math.round(remainingHours * 10) / 10} ` +
        `requiredHours=${Math.round(requiredHours * 10) / 10} canHandleAll=${canHandleAll} ` +
        `skillMismatch=${hasSkillMismatch}${hasSkillMismatch ? `(${processTypeSkillMismatches.join(',')})` : ''} ` +
        `score=${Math.round(score * 100) / 100} hasUnknownDay=${hasUnknownDay} ` +
        `processDetails=${JSON.stringify(processDetails)}`
      );
    }

    return {
      employee_id: emp.id,
      employee_name: emp.name,
      score: Math.round(score * 100) / 100,
      available_hours: Math.round(remainingHours * 10) / 10,
      required_hours: Math.round(requiredHours * 10) / 10,
      // 同点スコア時のタイブレーク(autoProposeForProject)に使う、現在の割当時間
      allocated_hours: Math.round(allocated * 10) / 10,
      can_handle_all: canHandleAll,
      skill_mismatch: hasSkillMismatch,
      process_details: processDetails,
      skill_match: matchedTags,
      reason,
      has_unknown_day: hasUnknownDay,
    };
  });

  // スコア降順、同点時はemployee_id昇順(常に同じ人が優先される)ではなく、
  // 空き時間(available_hours)が多い人を優先する
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.available_hours - a.available_hours;
  });

  // name/idとscoreの対応がソート前後でズレていないか一目で確認できるよう、
  // 最終的な並び順をまとめて1行出力する
  if (!quiet) {
    writeDebugLog(
      `[calculateSuggestions] project=${project.id} 最終ソート結果(スコア降順、同点はavailable_hours降順): ` +
      results.map(r => `${r.employee_name}(id=${r.employee_id},score=${r.score},available_hours=${r.available_hours})`).join(' > ')
    );
  }

  return results;
}

app.get('/api/projects/:id/suggest-assignees', (req, res) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const today = new Date();
    const deadline = project.deadline ? new Date(project.deadline) : null;
    if (!deadline || deadline < today) {
      return res.status(400).json({ error: '締切日が未設定、または過去の日付です' });
    }

    const results = calculateSuggestions(db, project);
    // score<=0(スキル不一致・対応不可)は明らかに候補になり得ないため除外し、
    // それ以外は全員を候補として返す(以前は上位3件のみだった)
    const viableResults = results.filter(r => r.score > 0);

    writeDebugLog(
      `[suggest-assignees] project=${project.id} 候補者数=${viableResults.length}名(除外=${results.length - viableResults.length}名)`
    );

    res.json({
      project_id: project.id,
      project_name: project.project_name,
      deadline: project.deadline,
      suggestions: viableResults,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 案件1件に対して、最上位候補者を選び、受付日から順に空き時間へ割り振って
// case_time_allocations に status:'提案' で登録する
function timeToHours(start, end, breakMinutes) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const minutes = (eh * 60 + em) - (sh * 60 + sm) - (breakMinutes || 0);
  return Math.max(0, minutes / 60);
}

// 指定した従業員に、必要時間を受付日の翌日から締切日まで、1日の空き時間の範囲内で
// 日ごとに分割してcase_time_allocationsへ'提案'ステータスで登録する。
// autoProposeForProject(自動選定)と、担当者候補モーダルからの手動割り当ての両方で使う
// setupMinutes/cleanupMinutes は自動割当ボタン(日次/週次、autoProposeForProjectInRange)
// 専用のパラメータ。0(デフォルト)であれば従来通りの挙動で、個別の「提案」ボタン
// (autoProposeForProject/assign-employee)やbulk-auto-proposeの計算には一切影響しない。
// 指定した場合、割り振る日ごとに「実作業時間 + 前準備 + 後片付け」を1セットとして
// その日の空き時間を消費する(案件が複数日にまたがれば、日ごとに毎回発生する)
function allocateHoursForEmployee(db, projectId, employeeId, employeeName, requiredHours, receivedDate, deadline, status = '提案', setupMinutes = 0, cleanupMinutes = 0) {
  const insertStmt = db.prepare(`
    INSERT INTO case_time_allocations (case_id, employee_id, work_date, planned_hours, status, setup_minutes, cleanup_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const overrideStmt = db.prepare('SELECT * FROM schedule_overrides WHERE employee_id = ? AND work_date = ?');
  const defaultStmt = db.prepare('SELECT * FROM employee_default_schedule WHERE employee_id = ? AND weekday = ?');
  // 前準備・後片付け時間も他の予定と同様に「その日の空き」を消費するため、
  // 既存の割り当て済み時間の集計にも含めて二重予約を防ぐ(setup/cleanupが0の行は影響なし)
  const allocatedStmt = db.prepare(`
    SELECT COALESCE(SUM(planned_hours + (setup_minutes + cleanup_minutes) / 60.0), 0) as total
    FROM case_time_allocations WHERE employee_id = ? AND work_date = ?
  `);

  const overheadHours = (setupMinutes + cleanupMinutes) / 60;

  let remainingHours = requiredHours;
  const cursor = new Date(receivedDate);
  cursor.setDate(cursor.getDate() + 1);
  cursor.setHours(0, 0, 0, 0);
  const endDate = new Date(deadline);
  endDate.setHours(0, 0, 0, 0);

  const allocatedDates = [];
  let guard = 0;

  while (cursor <= endDate && remainingHours > 0.01 && guard < 60) {
    const dateStr = formatLocalDate(cursor);
    const weekday = cursor.getDay();

    let dayHours = 0;
    let dayReserved = 0;
    const override = overrideStmt.get(employeeId, dateStr);
    if (override) {
      if (!override.is_day_off) {
        dayHours = timeToHours(override.start_time, override.end_time, override.break_minutes);
        dayReserved = override.reserved_hours || 0;
      }
    } else {
      const def = defaultStmt.get(employeeId, weekday);
      if (def && def.is_working) {
        dayHours = timeToHours(def.start_time, def.end_time, def.break_minutes);
        dayReserved = def.reserved_hours || 0;
      }
    }

    const alreadyAllocated = allocatedStmt.get(employeeId, dateStr).total;
    const dayAvailable = Math.max(0, dayHours - dayReserved - alreadyAllocated);
    // 前準備・後片付け分を差し引いた、実作業に使える時間
    const usableForWork = Math.max(0, dayAvailable - overheadHours);

    if (usableForWork > 0) {
      const useHours = Math.min(usableForWork, remainingHours);
      const roundedHours = Math.round(useHours * 10) / 10;
      const insertResult = insertStmt.run(projectId, employeeId, dateStr, roundedHours, status, setupMinutes, cleanupMinutes);
      allocatedDates.push({ id: insertResult.lastInsertRowid, date: dateStr, hours: roundedHours, setup_minutes: setupMinutes, cleanup_minutes: cleanupMinutes });
      remainingHours -= useHours;

      const carriedOver = remainingHours > 0.01;
      const overheadNote = overheadHours > 0
        ? ` 前準備=${setupMinutes}分 後片付け=${cleanupMinutes}分 1日の合計消費時間=${Math.round((useHours + overheadHours) * 10) / 10}h`
        : '';
      writeDebugLog(
        `[allocateHoursForEmployee] project=${projectId} employee=${employeeId}(${employeeName}) ` +
        `${dateStr}: その日の空き=${Math.round(dayAvailable * 10) / 10}h → 実作業時間=${roundedHours}h割当,${overheadNote} ` +
        `残り必要時間=${Math.round(remainingHours * 10) / 10}h` +
        (carriedOver ? ' → 翌稼働日へ繰り越し' : ' → この案件は割り振り完了')
      );
    }

    cursor.setDate(cursor.getDate() + 1);
    guard++;
  }

  return { allocatedDates, remainingHours };
}

// スケジュール(自動割当・提案確認パネル)の対象とする案件ステータス。
// 受注前(まだ受注確定していない)・検品・納品待ち(生産が終わって
// スケジュール調整が不要になった)案件は対象外とする
const SCHEDULABLE_PROJECT_STATUSES = ['CONFIRMED', 'WAITING', 'PREP_COMPLETE', 'IN_PROGRESS'];

// 案件1件に対して、最上位担当者を選び、受付日から順に空き時間へ割り振って
// case_time_allocations に status:'提案' で登録する
function autoProposeForProject(db, projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return { project_id: projectId, error: '案件が見つかりません' };
  if (!SCHEDULABLE_PROJECT_STATUSES.includes(project.status)) {
    return { project_id: projectId, error: `対象外のステータス(${project.status})のため自動割当できません` };
  }

  const receivedDate = project.received_date ? new Date(project.received_date) : new Date();
  const deadline = project.deadline ? new Date(project.deadline) : null;
  if (!deadline) return { project_id: projectId, error: '締切日が未設定です' };

  const suggestions = calculateSuggestions(db, project);
  // スコアは「空き時間・スキル一致」から算出されるが、必要スキルタグ未設定の案件では
  // 空き時間が0でもskillScoreのみでscoreが0より大きくなるため、score単独では
  // 「実際に割り振れる空き時間があるか」を判定できない。そのためscore>0の候補をスコア順に
  // 実際に日程へ割り振れるか順番に試し、1人も割り振れなかった場合のみ対応不可とする
  //
  // scoreが同点の場合、calculateSuggestions側のsort(安定ソート)だとemployee_id昇順の
  // ままになり、常に同じ従業員(id最小)が優先されて負荷が偏る。そのため同点時は
  // 現在の割当時間(allocated_hours)が少ない=手が空いている従業員を優先する
  const candidates = suggestions
    .filter(s => s.score > 0)
    .slice()
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.allocated_hours - b.allocated_hours;
    });
  if (!candidates.length) {
    return { project_id: projectId, error: '対応可能な担当者が見つかりませんでした' };
  }
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    writeDebugLog(
      `[autoProposeForProject] project=${projectId} 同点タイブレーク: score=${candidates[0].score} の候補が${candidates.filter(c => c.score === candidates[0].score).length}名 → ` +
      `allocated_hoursが少ない順に採用試行 [${candidates.filter(c => c.score === candidates[0].score).map(c => `${c.employee_name}(id=${c.employee_id}, allocated=${c.allocated_hours}h)`).join(', ')}]`
    );
  }

  db.prepare(`DELETE FROM case_time_allocations WHERE case_id = ? AND status = '提案'`).run(projectId);

  for (const candidate of candidates) {
    const employeeId = candidate.employee_id;
    const { allocatedDates, remainingHours } = allocateHoursForEmployee(
      db, projectId, employeeId, candidate.employee_name, candidate.required_hours, receivedDate, deadline
    );

    // calculateSuggestions の available_hours は「今日」起点、この割り振りループは
    // 「受付日の翌日」起点で計算しており日数の基準がずれるため、スコア上は空きがあっても
    // 実際には1日も割り振れないことがある。その場合はこの候補を諦めて次点を試す
    if (allocatedDates.length === 0) {
      writeDebugLog(
        `[autoProposeForProject] project=${projectId} candidate=${employeeId}(${candidate.employee_name}) ` +
        `score=${candidate.score} required=${candidate.required_hours} → 1時間も割り振れず次点へフォールバック`
      );
      continue;
    }

    const fitsInDeadline = remainingHours <= 0.01;

    writeDebugLog(
      `[autoProposeForProject] project=${projectId} candidate=${employeeId}(${candidate.employee_name}) ` +
      `score=${candidate.score} required=${candidate.required_hours} → 採用 ` +
      `allocated=${JSON.stringify(allocatedDates)} fitsInDeadline=${fitsInDeadline}`
    );

    if (!fitsInDeadline) {
      writeDebugLog(
        `[autoProposeForProject] project=${projectId} candidate=${employeeId}(${candidate.employee_name}) ` +
        `⚠️ 締切(${project.deadline})までに割り振りきれず、${Math.round(remainingHours * 10) / 10}h分が繰り越せませんでした(fitsInDeadline=false)`
      );
    }

    return {
      project_id: projectId,
      employee_id: employeeId,
      employee_name: candidate.employee_name,
      allocated_dates: allocatedDates,
      fits_in_deadline: fitsInDeadline,
      remaining_hours: Math.round(remainingHours * 10) / 10,
    };
  }

  return { project_id: projectId, error: '対応可能な担当者が見つかりませんでした' };
}

app.post('/api/projects/:id/auto-propose', (req, res) => {
  try {
    const result = autoProposeForProject(db, req.params.id);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects/bulk-auto-propose', (req, res) => {
  try {
    const unassigned = db.prepare('SELECT id FROM projects WHERE assigned_employee_id IS NULL').all();
    const results = unassigned.map(p => autoProposeForProject(db, p.id));
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// autoProposeForProjectとほぼ同じ候補選定ロジックだが、割り振り期間を案件の締切日までではなく
// 指定した日付範囲(rangeStart〜rangeEnd)だけに限定する。スケジュールボードの
// 「この日を自動割り当て」「今週を自動割り当て」ボタン用。範囲内で必要時間を使い切れなくても、
// 範囲内で割り振れた分だけを'提案'として登録する(残りは未割り当てのまま次回に持ち越せる)
// 自動割当ボタン(日次/週次)専用: 1日あたり前準備10分・後片付け10分を毎回消費する。
// 個別の「提案」ボタン(autoProposeForProject)やbulk-auto-proposeでは新規に付与しない。
// ドラッグ&ドロップ確定(confirm-proposal-at)は新規には付与しないが、この値で作られた
// 提案が既にある場合はそのsetup_minutes/cleanup_minutesを引き継いで再割り振りする
// (引き継がないと移動した瞬間に前準備・後片付けブロックが消えてしまうため)
const AUTO_PROPOSE_SETUP_MINUTES = 10;
const AUTO_PROPOSE_CLEANUP_MINUTES = 10;

function autoProposeForProjectInRange(db, projectId, rangeStart, rangeEnd) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return { project_id: projectId, error: '案件が見つかりません' };
  if (!SCHEDULABLE_PROJECT_STATUSES.includes(project.status)) {
    return { project_id: projectId, error: `対象外のステータス(${project.status})のため自動割当できません` };
  }

  // 一覧表示など高頻度に複数案件へ呼ぶ場面でdebug.logが肥大化しないようquiet指定
  const suggestions = calculateSuggestions(db, project, { quiet: true });
  const candidates = suggestions
    .filter(s => s.score > 0)
    .slice()
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.allocated_hours - b.allocated_hours;
    });
  if (!candidates.length) {
    return { project_id: projectId, error: '対応可能な担当者が見つかりませんでした' };
  }

  // allocateHoursForEmployeeは「receivedDateの翌日」から割り振るため、
  // rangeStartを初日にするために1日前の日付を疑似receivedDateとして渡す
  const pseudoReceivedDate = new Date(rangeStart);
  pseudoReceivedDate.setDate(pseudoReceivedDate.getDate() - 1);
  const rangeEndDate = new Date(rangeEnd);

  for (const candidate of candidates) {
    const employeeId = candidate.employee_id;
    const { allocatedDates } = allocateHoursForEmployee(
      db, projectId, employeeId, candidate.employee_name, candidate.required_hours, pseudoReceivedDate, rangeEndDate,
      '提案', AUTO_PROPOSE_SETUP_MINUTES, AUTO_PROPOSE_CLEANUP_MINUTES
    );

    if (allocatedDates.length === 0) continue;

    return {
      project_id: projectId,
      employee_id: employeeId,
      employee_name: candidate.employee_name,
      allocated_dates: allocatedDates,
    };
  }

  return { project_id: projectId, error: '指定期間内に割り振れる空き時間がありませんでした' };
}

// スケジュールボードの日次/週次自動割り当てボタンの共通処理。
// 未割り当て、まだ'提案'が無い、かつステータスがスケジュール対象
// (SCHEDULABLE_PROJECT_STATUSES)の案件だけを対象にして重複提案を避ける。
// 締切日が「今日」または「対象範囲の開始日」より前の案件は対象外とする
app.post('/api/schedule-board/auto-propose-range', (req, res) => {
  try {
    const { start_date, end_date } = req.body;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date, end_date は必須です' });
    }

    const todayStr = formatLocalDate(new Date());
    const cutoffDate = start_date > todayStr ? start_date : todayStr;

    const alreadyProposedCaseIds = new Set(
      db.prepare(`SELECT DISTINCT case_id FROM case_time_allocations WHERE status = '提案'`).all()
        .map(r => r.case_id)
    );

    const candidateProjects = db.prepare('SELECT * FROM projects WHERE assigned_employee_id IS NULL').all()
      .filter(p => !alreadyProposedCaseIds.has(p.id) && SCHEDULABLE_PROJECT_STATUSES.includes(p.status));

    let proposedCount = 0;
    let skippedExpiredCount = 0;
    let failedCount = 0;
    const proposedProjects = [];

    for (const project of candidateProjects) {
      if (!project.deadline || project.deadline < cutoffDate) {
        skippedExpiredCount++;
        continue;
      }

      const result = autoProposeForProjectInRange(db, project.id, start_date, end_date);
      if (result.error) {
        failedCount++;
        continue;
      }
      proposedCount++;
      proposedProjects.push({
        project_id: project.id,
        project_name: project.project_name,
        employee_id: result.employee_id,
        employee_name: result.employee_name,
      });
    }

    writeDebugLog(
      `[auto-propose-range] 対象期間=${start_date}〜${end_date} 対象案件数=${candidateProjects.length}件 ` +
      `提案作成=${proposedCount}件 対象外(締切超過等)=${skippedExpiredCount}件 候補なし等で失敗=${failedCount}件 ` +
      `提案先=${JSON.stringify(proposedProjects)}`
    );

    res.json({
      start_date,
      end_date,
      target_count: candidateProjects.length,
      proposed_count: proposedCount,
      skipped_expired_count: skippedExpiredCount,
      failed_count: failedCount,
      proposed_projects: proposedProjects,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 担当者候補モーダルから特定の担当者を手動で選んで割り当てる。
// 従来は projects.assigned_employee_id を更新するだけで、実際の作業時間を
// case_time_allocations へ書き込んでいなかった(スケジュールボードに反映されない不具合)ため、
// autoProposeForProject と同じ日次割り振りロジック(allocateHoursForEmployee)を使って
// 実際の作業時間も登録する
app.post('/api/projects/:id/assign-employee', (req, res) => {
  try {
    const employeeId = Number(req.body.employee_id);
    if (!employeeId) return res.status(400).json({ error: 'employee_id は必須です' });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: '案件が見つかりません' });

    const receivedDate = project.received_date ? new Date(project.received_date) : new Date();
    const deadline = project.deadline ? new Date(project.deadline) : null;
    if (!deadline) return res.status(400).json({ error: '締切日が未設定です' });

    const suggestions = calculateSuggestions(db, project);
    const chosen = suggestions.find(s => s.employee_id === employeeId);
    if (!chosen) return res.status(404).json({ error: '指定された担当者が見つかりませんでした' });

    db.prepare(`DELETE FROM case_time_allocations WHERE case_id = ? AND status = '提案'`).run(project.id);

    const { allocatedDates, remainingHours } = allocateHoursForEmployee(
      db, project.id, chosen.employee_id, chosen.employee_name, chosen.required_hours, receivedDate, deadline
    );
    const fitsInDeadline = remainingHours <= 0.01;

    writeDebugLog(
      `[assign-employee] project=${project.id} employee=${chosen.employee_id}(${chosen.employee_name}) 手動割り当て ` +
      `required=${chosen.required_hours} allocated=${JSON.stringify(allocatedDates)} fitsInDeadline=${fitsInDeadline}`
    );

    const now = new Date().toISOString();
    db.prepare('UPDATE projects SET assigned_employee_id = ?, updated_at = ? WHERE id = ?')
      .run(chosen.employee_id, now, project.id);

    res.json({
      project_id: project.id,
      employee_id: chosen.employee_id,
      employee_name: chosen.employee_name,
      allocated_dates: allocatedDates,
      fits_in_deadline: fitsInDeadline,
      remaining_hours: Math.round(remainingHours * 10) / 10,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 確認待ちの提案(status='提案'のcase_time_allocations)を案件単位でまとめて返す。
// スケジュールボードの「提案確認」パネル用。スコア・空き時間は担当者候補モーダルと
// 同じcalculateSuggestionsから取得するが、一覧表示のたびに全案件分ログが出ると
// debug.logが肥大化するため quiet:true でログ出力を抑制する
app.get('/api/proposals', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT ta.case_id, ta.employee_id, e.name as employee_name,
        SUM(ta.planned_hours) as proposed_hours_total
      FROM case_time_allocations ta
      JOIN employees e ON e.id = ta.employee_id
      WHERE ta.status = '提案'
      GROUP BY ta.case_id, ta.employee_id
      ORDER BY ta.case_id ASC
    `).all();

    const results = rows.map(row => {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(row.case_id);
      if (!project) return null;
      // 検品・納品待ち・受注前などスケジュール調整が不要なステータスの案件は、
      // 提案確認パネルの対象外にする(SCHEDULABLE_PROJECT_STATUSES参照)
      if (!SCHEDULABLE_PROJECT_STATUSES.includes(project.status)) return null;

      const suggestions = calculateSuggestions(db, project, { quiet: true });
      const matched = suggestions.find(s => s.employee_id === row.employee_id);

      return {
        case_id: row.case_id,
        project_name: project.project_name,
        customer_name: project.customer_name,
        deadline: project.deadline,
        quantity: project.quantity,
        process_type: project.process_type,
        employee_id: row.employee_id,
        employee_name: row.employee_name,
        proposed_hours_total: Math.round(row.proposed_hours_total * 10) / 10,
        score: matched ? matched.score : null,
        available_hours: matched ? matched.available_hours : null,
      };
    }).filter(Boolean);

    // まだ担当者候補も予定も付いていない未着手案件(case_time_allocationsに行が1件も無い)も
    // 「担当者未定」カードとして提案確認パネルに出す。これがないと、担当者を割り当てるまで
    // 案件がボードのどこにも現れず埋もれてしまう。対象はスケジュール調整対象ステータス
    // (SCHEDULABLE_PROJECT_STATUSES)に限る。status='提案'の案件は上のresultsに、
    // status='予定'等の確定済み案件はcase_time_allocationsに行があるため、ここには含まれない
    // (=既存カードと重複しない)
    const schedulablePlaceholders = SCHEDULABLE_PROJECT_STATUSES.map(() => '?').join(', ');
    const unassignedProjects = db.prepare(`
      SELECT * FROM projects
      WHERE status IN (${schedulablePlaceholders})
        AND id NOT IN (SELECT DISTINCT case_id FROM case_time_allocations)
      ORDER BY id ASC
    `).all(...SCHEDULABLE_PROJECT_STATUSES);

    const unassignedCards = unassignedProjects.map(project => ({
      case_id: project.id,
      project_name: project.project_name,
      customer_name: project.customer_name,
      deadline: project.deadline,
      quantity: project.quantity,
      process_type: project.process_type,
      employee_id: null,
      employee_name: null,
      proposed_hours_total: null,
      score: null,
      available_hours: null,
    }));

    res.json([...results, ...unassignedCards]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 案件を「検品」ステータスへ移す共通処理。以下の2箇所から呼ばれる:
//  - 提案確認パネルの「検品へ」ボタン(この時点ではcase_time_allocationsは
//    status='提案'の行のみ存在する)
//  - 実績入力画面で実績時間の合計が計画時間(必要時間)に到達した際の
//    「検品へ変更しますか?」確認ダイアログで「はい」を選んだ場合
//    (この時点ではstatus='予定'や'実績確定'の行が存在する)
// どちらの場合も、その案件に紐づくcase_time_allocations(前準備・後片付けを
// 含む、同一レコードのため一緒に削除される)をステータス問わず全て削除し、
// projects.statusを'INSPECTION'に、assigned_employee_idを未割り当てに変更する。
// ステータスがSCHEDULABLE_PROJECT_STATUSESから外れるため、以後
// 提案確認パネル・自動割当の対象からも自動的に外れる
function moveProjectToInspection(db, projectId, source) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return { error: '案件が見つかりません' };

  const deletedRows = db.prepare(`
    SELECT id, employee_id, work_date, planned_hours, actual_hours, status, setup_minutes, cleanup_minutes
    FROM case_time_allocations WHERE case_id = ?
  `).all(projectId);

  if (deletedRows.length === 0) {
    return { error: 'スケジュール上の割り当てが見つかりません' };
  }

  const result = db.prepare('DELETE FROM case_time_allocations WHERE case_id = ?').run(projectId);

  const statusBefore = project.status;
  const now = new Date().toISOString();
  db.prepare('UPDATE projects SET status = ?, assigned_employee_id = NULL, updated_at = ? WHERE id = ?')
    .run('INSPECTION', now, projectId);

  writeDebugLog(
    `[move-to-inspection] source=${source} project=${projectId} ステータス: ${statusBefore} → INSPECTION(検品) ` +
    `assigned_employee_id: ${project.assigned_employee_id} → null ` +
    `削除したレコード(前準備・後片付け含む)=${JSON.stringify(deletedRows)}`
  );

  return { deleted: result.changes };
}

app.post('/api/projects/:id/move-to-inspection', (req, res) => {
  try {
    const result = moveProjectToInspection(db, req.params.id, 'proposal-panel');
    if (result.error) return res.status(404).json({ error: result.error });
    res.json({ message: 'Project moved to inspection', deleted: result.deleted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 提案確認パネルのカードをボード上の特定の従業員×日付セルへドラッグ&ドロップした際の確定。
// AIが提案していた担当者・開始日とは無関係に、ドロップ先の従業員・日付を優先して
// 割り振り直す(既存の提案は一旦削除し、ドロップ先を初日として再割り振りする)
app.post('/api/projects/:id/confirm-proposal-at', (req, res) => {
  try {
    const employeeId = Number(req.body.employee_id);
    const workDate = req.body.work_date;
    if (!employeeId || !workDate) {
      return res.status(400).json({ error: 'employee_id, work_date は必須です' });
    }

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: '案件が見つかりません' });
    if (!project.deadline) return res.status(400).json({ error: '締切日が未設定です' });

    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
    if (!employee) return res.status(404).json({ error: '従業員が見つかりません' });

    // ドロップ先の従業員が生産性未登録などでrequired_hoursを計算できない場合は、
    // 既存の提案(元の担当者向け)に積まれていた合計時間を代わりに使う
    const existingProposalRows = db.prepare(`
      SELECT id, employee_id, work_date, planned_hours, setup_minutes, cleanup_minutes
      FROM case_time_allocations WHERE case_id = ? AND status = '提案'
      ORDER BY work_date ASC, id ASC
    `).all(project.id);
    const existingProposalHours = existingProposalRows.reduce((sum, r) => sum + r.planned_hours, 0);
    // 前準備・後片付け(setup_minutes/cleanup_minutes)の扱い:
    //  - 自動割当ボタン(日次/週次)由来の提案は既にsetup_minutes/cleanup_minutes>0で
    //    積まれているため、その値をそのまま引き継ぐ(渡し忘れると移動した瞬間に消えるため)
    //  - 個別の「提案」ボタン/bulk-auto-propose由来(setup_minutes/cleanup_minutes=0)の
    //    提案をドラッグ&ドロップで確定する場合は、二重付与にはならないので確定のタイミングで
    //    前準備・後片付けを新たに付与する
    const hasExistingOverhead = existingProposalRows.some(r => (r.setup_minutes || 0) > 0 || (r.cleanup_minutes || 0) > 0);
    const setupMinutes = hasExistingOverhead ? (existingProposalRows[0].setup_minutes || 0) : AUTO_PROPOSE_SETUP_MINUTES;
    const cleanupMinutes = hasExistingOverhead ? (existingProposalRows[0].cleanup_minutes || 0) : AUTO_PROPOSE_CLEANUP_MINUTES;

    const { requiredHours, canHandleAll } = calculateRequiredHours(db, project, employeeId);
    const finalRequiredHours = (canHandleAll && requiredHours > 0) ? requiredHours : existingProposalHours;

    if (finalRequiredHours <= 0) {
      return res.status(400).json({ error: 'この案件の必要時間を計算できませんでした(担当者の生産性が未登録で、既存の提案もありません)' });
    }

    db.prepare(`DELETE FROM case_time_allocations WHERE case_id = ? AND status = '提案'`).run(project.id);

    // allocateHoursForEmployeeは「receivedDateの翌日」から割り振るため、
    // ドロップした日を初日にするために1日前の日付を疑似receivedDateとして渡す
    const pseudoReceivedDate = new Date(workDate);
    pseudoReceivedDate.setDate(pseudoReceivedDate.getDate() - 1);
    const deadline = new Date(project.deadline);

    const { allocatedDates, remainingHours } = allocateHoursForEmployee(
      db, project.id, employeeId, employee.name, finalRequiredHours, pseudoReceivedDate, deadline, '予定',
      setupMinutes, cleanupMinutes
    );

    if (allocatedDates.length === 0) {
      return res.status(400).json({ error: 'ドロップした日以降に割り振れる空き時間がありませんでした' });
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE projects SET assigned_employee_id = ?, updated_at = ? WHERE id = ?')
      .run(employeeId, now, project.id);

    writeDebugLog(
      `[confirm-proposal-at/手動確定] project=${project.id} employee=${employeeId}(${employee.name}) ` +
      `ドラッグ&ドロップでwork_date=${workDate}を初日として確定 required=${Math.round(finalRequiredHours * 10) / 10} ` +
      `前準備=${setupMinutes}分 後片付け=${cleanupMinutes}分(${hasExistingOverhead ? '自動割当由来を引き継ぎ' : '手動確定時に新規付与'}) ` +
      `移動前レコード=${JSON.stringify(existingProposalRows.map(r => ({ id: r.id, employee_id: r.employee_id, work_date: r.work_date })))} ` +
      `移動後レコード=${JSON.stringify(allocatedDates)} remainingHours=${Math.round(remainingHours * 10) / 10}`
    );

    res.json({
      project_id: project.id,
      employee_id: employeeId,
      employee_name: employee.name,
      allocated_dates: allocatedDates,
      remaining_hours: Math.round(remainingHours * 10) / 10,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 案件のプリント箇所を取得
app.get('/api/projects/:id/print-locations', (req, res) => {
  try {
    const locations = db.prepare(`
      SELECT * FROM case_print_locations WHERE case_id = ? ORDER BY id ASC
    `).all(req.params.id);
    res.json(locations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 案件の名簿(選手名・背番号)を取得する。Web注文フォーム由来の確定時に case_roster へ引き継がれる。
app.get('/api/projects/:id/roster', (req, res) => {
  try {
    const roster = db.prepare(`
      SELECT * FROM case_roster WHERE case_id = ? ORDER BY row_no ASC, id ASC
    `).all(req.params.id);
    res.json(roster);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// プリント箇所を一括で置き換える（既存分をDELETEしてから渡された分をINSERT）
const replaceCasePrintLocations = db.transaction((caseId, locations) => {
  db.prepare('DELETE FROM case_print_locations WHERE case_id = ?').run(caseId);
  const insert = db.prepare(`
    INSERT INTO case_print_locations (case_id, location_name, color_count)
    VALUES (?, ?, ?)
  `);
  for (const l of locations) {
    insert.run(caseId, l.location_name || '', l.color_count || 1);
  }
});

app.post('/api/projects/:id/print-locations', (req, res) => {
  try {
    const locations = req.body.locations || [];
    replaceCasePrintLocations(req.params.id, locations);
    res.json({ message: 'Print locations updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 案件新規作成の共通処理。/api/projects と AI受注候補の確認登録(/api/ai-intake/:id/confirm)の
// 両方から使うため、案件テーブルへのINSERT本体をここに集約する
function createProjectRecord(data) {
  const { project_name, received_date, deadline, customer_name, contact_method,
    work_content, process_type, quantity, planned_hours, assigned_staff_id,
    status, priority, reference_link, memo, nas_folder_path, prep_items,
    required_skill_tags, estimated_hours, assigned_employee_id } = data;
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO projects (
      project_name, received_date, deadline, customer_name, contact_method,
      work_content, process_type, quantity, planned_hours, assigned_staff_id,
      status, priority, reference_link, memo, nas_folder_path, prep_items,
      required_skill_tags, estimated_hours, assigned_employee_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project_name, received_date, deadline, customer_name, contact_method,
    work_content || '', process_type, quantity, planned_hours, assigned_staff_id || null,
    status || 'PRE_ORDER', priority || 'MEDIUM', reference_link || '', memo || '',
    nas_folder_path || '', prep_items || '', required_skill_tags || '', estimated_hours || null,
    assigned_employee_id || null, now, now);
  return result.lastInsertRowid;
}

app.post('/api/projects', (req, res) => {
  try {
    const id = createProjectRecord(req.body);
    try {
      const autoProposeResult = autoProposeForProject(db, id);
      if (autoProposeResult.error) {
        console.error(`自動提案に失敗しました(project_id=${id}): ${autoProposeResult.error}`);
      }
    } catch (autoProposeError) {
      console.error(`自動提案に失敗しました(project_id=${id}):`, autoProposeError.message);
    }
    res.status(201).json({ id, message: 'Project created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/projects/:id', (req, res) => {
  try {
    const { project_name, received_date, deadline, customer_name, contact_method,
      work_content, process_type, quantity, planned_hours, assigned_staff_id,
      status, priority, reference_link, memo, nas_folder_path, prep_items,
      required_skill_tags, estimated_hours, assigned_employee_id } = req.body;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE projects SET
        project_name=?, received_date=?, deadline=?, customer_name=?, contact_method=?,
        work_content=?, process_type=?, quantity=?, planned_hours=?, assigned_staff_id=?,
        status=?, priority=?, reference_link=?, memo=?, nas_folder_path=?, prep_items=?,
        required_skill_tags=?, estimated_hours=?, assigned_employee_id=?, updated_at=?
      WHERE id=?
    `).run(project_name, received_date, deadline, customer_name, contact_method,
      work_content || '', process_type, quantity, planned_hours, assigned_staff_id || null,
      status, priority, reference_link || '', memo || '', nas_folder_path || '', prep_items || '',
      required_skill_tags || '', estimated_hours || null, assigned_employee_id || null, now, req.params.id);
    res.json({ message: 'Project updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 案件ステータスのみを変更する軽量エンドポイント。週間スケジュールボードの準備項目リストの
// 「準備完了」「検品」ボタン専用で、case_preparation_itemsの完了状態には一切触れない
// (未完了の準備項目が残っていても、ボタンを押した時点で強制的にステータスを変更する)。
// 'COMPLETED'(納品済み)はPOST /api/projects/:id/deliverで納品記録とあわせて設定する
// 専用の流れがあるため、ここでは受け付けない
const PROJECT_STATUS_SET_ALLOWED_VALUES = ['PREP_COMPLETE', 'INSPECTION'];
app.put('/api/projects/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    if (!PROJECT_STATUS_SET_ALLOWED_VALUES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${PROJECT_STATUS_SET_ALLOWED_VALUES.join(', ')}` });
    }
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const now = new Date().toISOString();
    db.prepare(`UPDATE projects SET status=?, updated_at=? WHERE id=?`).run(status, now, req.params.id);
    res.json({ message: 'Project status updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 案件を「納品済み」にする。納品日・発送方法・納品者をdelivery_recordsに記録した上で、
// 物理削除ではなくprojects.statusを'COMPLETED'に変更するだけにする
// (準備項目の「未着手に戻す」等と同じ、ステータス書き換えによるソフト削除の考え方)
app.post('/api/projects/:id/deliver', (req, res) => {
  try {
    const { delivered_date, delivery_method, delivered_by_staff_id, delivered_by_employee_id } = req.body;
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!delivered_date || !delivery_method) {
      return res.status(400).json({ error: 'delivered_date and delivery_method are required' });
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO delivery_records
        (case_id, delivered_date, delivery_method, delivered_by_staff_id, delivered_by_employee_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.params.id, delivered_date, delivery_method, delivered_by_staff_id || null, delivered_by_employee_id || null, now);

    db.prepare(`UPDATE projects SET status='COMPLETED', updated_at=? WHERE id=?`).run(now, req.params.id);
    res.json({ message: 'Project marked as delivered' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 納品履歴一覧(新しい納品日順)。過去案件検索・リピート注文複製のため案件情報も返す
app.get('/api/delivery-records', (req, res) => {
  try {
    const records = db.prepare(`
      SELECT dr.*, p.project_name, p.customer_name, p.process_type, p.quantity, p.nas_folder_path,
        s.name as delivered_by_staff_name, emp.name as delivered_by_employee_name
      FROM delivery_records dr
      JOIN projects p ON dr.case_id = p.id
      LEFT JOIN staff s ON dr.delivered_by_staff_id = s.id
      LEFT JOIN employees emp ON dr.delivered_by_employee_id = emp.id
      ORDER BY dr.delivered_date DESC, dr.id DESC
    `).all();
    res.json(records);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 過去案件をもとに新規案件を複製作成する(リピート注文用)。
// 加工内容・NASフォルダパス・アイテム明細・プリント箇所を引き継ぎ、
// 担当者割り当て・作業計画・名簿(選手名は年度で変わるため)は引き継がない。
const duplicateProjectCascade = db.transaction((srcId, overrides) => {
  const src = db.prepare('SELECT * FROM projects WHERE id = ?').get(srcId);
  if (!src) return null;

  const newId = createProjectRecord({
    project_name: overrides.project_name || src.project_name,
    received_date: new Date().toISOString().slice(0, 10),
    deadline: overrides.deadline,
    customer_name: src.customer_name,
    contact_method: src.contact_method,
    work_content: src.work_content,
    process_type: src.process_type,
    quantity: overrides.quantity ?? src.quantity,
    planned_hours: src.planned_hours,
    status: 'PRE_ORDER',
    priority: 'MEDIUM',
    reference_link: src.reference_link,
    memo: `【リピート】過去案件#${srcId}「${src.project_name}」を複製して作成\n${src.memo || ''}`.trim(),
    nas_folder_path: src.nas_folder_path,
    prep_items: src.prep_items,
    required_skill_tags: src.required_skill_tags,
    estimated_hours: src.estimated_hours,
  });

  // アイテム明細をコピーし、旧アイテムID→新アイテムIDの対応を控える
  const itemIdMap = new Map();
  const items = db.prepare('SELECT * FROM case_items WHERE case_id = ? ORDER BY item_no').all(srcId);
  const insertItem = db.prepare(`
    INSERT INTO case_items (case_id, item_no, category, sub_category, catalog_json, method, quantity_total, matrix_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const it of items) {
    const r = insertItem.run(newId, it.item_no, it.category, it.sub_category, it.catalog_json, it.method, it.quantity_total, it.matrix_json);
    itemIdMap.set(it.id, r.lastInsertRowid);
  }

  // プリント箇所をコピー(アイテム紐づけがあれば新IDに付け替える)
  const locations = db.prepare('SELECT * FROM case_print_locations WHERE case_id = ?').all(srcId);
  const insertLocation = db.prepare(
    'INSERT INTO case_print_locations (case_id, location_name, color_count, case_item_id) VALUES (?, ?, ?, ?)'
  );
  for (const loc of locations) {
    insertLocation.run(newId, loc.location_name, loc.color_count,
      loc.case_item_id ? (itemIdMap.get(loc.case_item_id) || null) : null);
  }

  return newId;
});

app.post('/api/projects/:id/duplicate', (req, res) => {
  try {
    const { deadline, quantity, project_name } = req.body || {};
    if (!deadline || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
      return res.status(400).json({ error: '納期(deadline)をYYYY-MM-DD形式で指定してください' });
    }
    const parsedQuantity = quantity !== undefined && quantity !== null && quantity !== ''
      ? parseInt(quantity, 10) : undefined;
    if (parsedQuantity !== undefined && (!Number.isInteger(parsedQuantity) || parsedQuantity < 1)) {
      return res.status(400).json({ error: '数量は1以上の整数で指定してください' });
    }

    const newId = duplicateProjectCascade(req.params.id, {
      deadline,
      quantity: parsedQuantity,
      project_name: typeof project_name === 'string' && project_name.trim() ? project_name.trim() : undefined,
    });
    if (!newId) return res.status(404).json({ error: 'Project not found' });

    console.log(`[複製] 案件#${req.params.id}を複製 → 新規案件#${newId}`);
    res.status(201).json({ id: newId, message: 'Project duplicated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// case_time_allocations・case_preparation_items・case_print_locationsはprojects.idをFOREIGN KEYで参照しており、
// (better-sqlite3はSQLite側でforeign_keys=ONがデフォルトのため)子レコードが残ったまま
// projectsを削除するとFOREIGN KEY constraint failedになる。トランザクションで子→親の順に削除する
const deleteProjectCascade = db.transaction((projectId) => {
  db.prepare('DELETE FROM case_preparation_items WHERE case_id = ?').run(projectId);
  db.prepare('DELETE FROM case_time_allocations WHERE case_id = ?').run(projectId);
  db.prepare('DELETE FROM case_print_locations WHERE case_id = ?').run(projectId);
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
});

app.delete('/api/projects/:id', (req, res) => {
  try {
    deleteProjectCascade(req.params.id);
    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== AI受注候補(LINEから自動収集) =====

app.get('/api/ai-intake', (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const rows = db.prepare(`
      SELECT ai.*, lu.display_name
      FROM ai_extracted_intake ai
      LEFT JOIN line_users lu ON ai.line_user_id = lu.line_user_id
      WHERE ai.status = ?
      ORDER BY ai.extracted_at DESC
    `).all(status);

    // 一覧カード用に、各候補の先頭画像(message_idsに含まれる中で最も古い画像メッセージ)のパスも付与する
    const withThumbnail = rows.map(row => {
      let messageIds = [];
      try {
        messageIds = JSON.parse(row.message_ids);
      } catch (err) {
        messageIds = [];
      }
      let thumbnail_path = null;
      if (Array.isArray(messageIds) && messageIds.length > 0) {
        const placeholders = messageIds.map(() => '?').join(',');
        const firstImage = db.prepare(`
          SELECT image_path FROM line_messages
          WHERE id IN (${placeholders}) AND message_type = 'image' AND image_path IS NOT NULL
          ORDER BY received_at ASC LIMIT 1
        `).get(...messageIds);
        thumbnail_path = firstImage ? firstImage.image_path : null;
      }
      return { ...row, thumbnail_path };
    });

    res.json(withThumbnail);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ai-intake/:id', (req, res) => {
  try {
    const intake = db.prepare(`
      SELECT ai.*, lu.display_name
      FROM ai_extracted_intake ai
      LEFT JOIN line_users lu ON ai.line_user_id = lu.line_user_id
      WHERE ai.id = ?
    `).get(req.params.id);
    if (!intake) return res.status(404).json({ error: 'Intake not found' });

    let messageIds = [];
    try {
      messageIds = JSON.parse(intake.message_ids);
    } catch (err) {
      messageIds = [];
    }

    let messages = [];
    if (Array.isArray(messageIds) && messageIds.length > 0) {
      const placeholders = messageIds.map(() => '?').join(',');
      messages = db.prepare(`
        SELECT * FROM line_messages WHERE id IN (${placeholders}) ORDER BY received_at ASC
      `).all(...messageIds);
    }

    res.json({ ...intake, messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 確認登録: ai_extracted_intakeの内容(編集後)から正式な案件を1件作成し、
// 候補側のstatusをconfirmedにしてcase_idを紐付ける。1トランザクションで実行する。
// Web注文フォーム由来の場合は、アイテム(case_items)・プリント箇所(case_print_locations)・名簿(case_roster)を引き継ぐ。
const confirmAiIntake = db.transaction((intakeId, projectData) => {
  const projectId = createProjectRecord(projectData);

  const intakeRow = db.prepare(`SELECT raw_ai_response FROM ai_extracted_intake WHERE id = ?`).get(intakeId);
  const carried = extractCarriedData(projectData, intakeRow);
  const carriedItems = extractCarriedItems(intakeRow);

  if (carriedItems) {
    // Web注文フォーム由来: アイテムごとに case_items を作り、プリント箇所を各アイテムに紐づける。
    const insItem = db.prepare(`
      INSERT INTO case_items (case_id, item_no, category, sub_category, catalog_json, method, quantity_total, matrix_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insLocItem = db.prepare(`INSERT INTO case_print_locations (case_id, case_item_id, location_name, color_count) VALUES (?, ?, ?, ?)`);
    for (const it of carriedItems) {
      const r = insItem.run(
        projectId, it.item_no, it.category || null, it.sub_category || null,
        JSON.stringify(it.catalog_items || []), it.method || null,
        it.quantity_total || 0, it.matrix ? JSON.stringify(it.matrix) : null,
      );
      const caseItemId = r.lastInsertRowid;
      for (const l of it.print_locations) insLocItem.run(projectId, caseItemId, l.location_name, l.color_count);
    }
  } else if (carried.printLocations.length > 0) {
    // レガシー(LINE/手動): プリント箇所を案件直下(case_item_id=NULL)に保存(従来どおり)
    const insLoc = db.prepare(`INSERT INTO case_print_locations (case_id, location_name, color_count) VALUES (?, ?, ?)`);
    for (const l of carried.printLocations) insLoc.run(projectId, l.location_name, l.color_count);
  }

  if (carried.roster.length > 0) {
    const insRoster = db.prepare(`INSERT INTO case_roster (case_id, row_no, player_name, number, size) VALUES (?, ?, ?, ?, ?)`);
    for (const r of carried.roster) insRoster.run(projectId, r.row_no, r.player_name, r.number, r.size);
  }

  db.prepare(`UPDATE ai_extracted_intake SET status = 'confirmed', case_id = ? WHERE id = ?`).run(projectId, intakeId);
  return projectId;
});

app.post('/api/ai-intake/:id/confirm', (req, res) => {
  try {
    const intake = db.prepare(`SELECT id FROM ai_extracted_intake WHERE id = ?`).get(req.params.id);
    if (!intake) return res.status(404).json({ error: 'Intake not found' });

    const projectId = confirmAiIntake(req.params.id, req.body);
    res.status(201).json({ id: projectId, message: 'Project created from intake successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ai-intake/:id/reject', (req, res) => {
  try {
    const intake = db.prepare(`SELECT id FROM ai_extracted_intake WHERE id = ?`).get(req.params.id);
    if (!intake) return res.status(404).json({ error: 'Intake not found' });

    db.prepare(`UPDATE ai_extracted_intake SET status = 'rejected' WHERE id = ?`).run(req.params.id);
    res.json({ message: 'Intake rejected' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== 案件ごとの作業計画 =====

app.get('/api/projects/:projectId/time-allocations', (req, res) => {
  try {
    const allocations = db.prepare(`
      SELECT ta.*, e.name as employee_name
      FROM case_time_allocations ta
      JOIN employees e ON ta.employee_id = e.id
      WHERE ta.case_id = ?
      ORDER BY ta.work_date ASC, ta.id ASC
    `).all(req.params.projectId);
    res.json(allocations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// apply_default_overhead: スケジュールボードの空きマスから手動登録する場合のみtrueで
// 送られてくるフラグ。案件詳細ページの「作業計画」からの登録(app.js)はこのフラグを
// 送らないため従来通りsetup_minutes/cleanup_minutes=0のままになる
app.post('/api/projects/:projectId/time-allocations', (req, res) => {
  try {
    const { employee_id, work_date, planned_hours, actual_hours, carried_over_from, status, apply_default_overhead } = req.body;
    const setupMinutes = apply_default_overhead ? AUTO_PROPOSE_SETUP_MINUTES : 0;
    const cleanupMinutes = apply_default_overhead ? AUTO_PROPOSE_CLEANUP_MINUTES : 0;
    const result = db.prepare(`
      INSERT INTO case_time_allocations
        (case_id, employee_id, work_date, planned_hours, actual_hours, carried_over_from, status, setup_minutes, cleanup_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.projectId, employee_id, work_date, planned_hours,
      actual_hours || null, carried_over_from || null, status || '予定', setupMinutes, cleanupMinutes);

    if (apply_default_overhead) {
      writeDebugLog(
        `[time-allocations CREATE/新規登録] id=${result.lastInsertRowid} case_id=${req.params.projectId} ` +
        `employee_id=${employee_id} work_date=${work_date} ` +
        `前準備=${setupMinutes}分 後片付け=${cleanupMinutes}分 をスケジュールボードの手動新規登録時に付与`
      );
    }

    res.status(201).json({ id: result.lastInsertRowid, message: 'Time allocation created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/time-allocations/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM case_time_allocations WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Time allocation not found' });

    // 送信されなかった項目は既存値を維持する（実績時間だけの更新等で他の項目を消さないため）
    const case_id = req.body.case_id !== undefined ? req.body.case_id : existing.case_id;
    const employee_id = req.body.employee_id !== undefined ? req.body.employee_id : existing.employee_id;
    const work_date = req.body.work_date !== undefined ? req.body.work_date : existing.work_date;
    const planned_hours = req.body.planned_hours !== undefined ? req.body.planned_hours : existing.planned_hours;
    const actual_hours = req.body.actual_hours !== undefined ? req.body.actual_hours : existing.actual_hours;
    const carried_over_from = req.body.carried_over_from !== undefined ? req.body.carried_over_from : existing.carried_over_from;
    const status = req.body.status !== undefined ? req.body.status : existing.status;

    db.prepare(`
      UPDATE case_time_allocations SET
        case_id=?, employee_id=?, work_date=?, planned_hours=?, actual_hours=?, carried_over_from=?, status=?
      WHERE id=?
    `).run(case_id, employee_id, work_date, planned_hours, actual_hours, carried_over_from, status, req.params.id);

    // setup_minutes/cleanup_minutesはSET句に含めていないため更新されず、
    // 前準備・後片付け分は同じ行に紐づいたまま移動先へ引き継がれる(値はexisting基準でログに残す)
    if (employee_id !== existing.employee_id || work_date !== existing.work_date) {
      writeDebugLog(
        `[time-allocations MOVE] id=${req.params.id} case_id=${existing.case_id} ` +
        `移動元: employee_id=${existing.employee_id} work_date=${existing.work_date} → ` +
        `移動先: employee_id=${employee_id} work_date=${work_date} ` +
        `前準備=${existing.setup_minutes || 0}分 後片付け=${existing.cleanup_minutes || 0}分(同一レコードのため一緒に移動)`
      );
    }

    // 実績入力画面で「検品ステータスに変更しますか?」に「はい」と答えた場合のみ
    // move_to_inspection=trueが送られてくる。実績を保存した直後にこの案件の
    // スケジュール割り当てを全て削除し、ステータスを検品へ変更する
    let movedToInspection = false;
    if (req.body.move_to_inspection === true) {
      const inspectionResult = moveProjectToInspection(db, case_id, 'actual-hours-input');
      movedToInspection = !inspectionResult.error;
    }

    res.json({ message: 'Time allocation updated successfully', moved_to_inspection: movedToInspection });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 実績入力画面で、入力しようとしている実績時間を保存した場合に、その案件の
// 実績合計が必要時間(required_hours、生産性未登録の案件はplanned_hours基準。
// calculateProjectRequiredHoursTotal/api-stats-project-progressと同じ基準)に
// 到達するかどうかを事前に判定する(実際の保存はまだ行わない)。
// candidate_actual_hours: これから保存しようとしている実績時間(このallocationの分)
// exclude_allocation_id: 実績合計を計算する際、このallocation自身の既存値は
//   二重にカウントしないよう除外する
app.get('/api/projects/:id/actual-hours-check', (req, res) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: '案件が見つかりません' });

    const candidateActualHours = parseFloat(req.query.candidate_actual_hours);
    if (Number.isNaN(candidateActualHours)) {
      return res.status(400).json({ error: 'candidate_actual_hours は数値で指定してください' });
    }
    const excludeAllocationId = req.query.exclude_allocation_id ? Number(req.query.exclude_allocation_id) : -1;

    const otherRows = db.prepare(
      `SELECT actual_hours FROM case_time_allocations WHERE case_id = ? AND id != ?`
    ).all(project.id, excludeAllocationId);
    const otherActualTotal = otherRows.reduce((sum, r) => sum + (r.actual_hours || 0), 0);
    const projectedActualTotal = otherActualTotal + candidateActualHours;

    const { requiredHoursTotal, requiredHoursSource } = calculateProjectRequiredHoursTotal(db, project);
    const reached = requiredHoursTotal > 0 && projectedActualTotal >= requiredHoursTotal;

    writeDebugLog(
      `[actual-hours-check] project=${project.id} 入力された実績時間=${candidateActualHours}h ` +
      `他の割り当ての実績合計=${Math.round(otherActualTotal * 100) / 100}h ` +
      `保存後の実績合計(見込み)=${Math.round(projectedActualTotal * 100) / 100}h ` +
      `必要時間(${requiredHoursSource})=${Math.round(requiredHoursTotal * 100) / 100}h ` +
      `判定=${reached ? '到達(検品への変更を確認)' : '未到達(通常保存)'}`
    );

    res.json({
      case_id: project.id,
      candidate_actual_hours: candidateActualHours,
      projected_actual_hours_total: Math.round(projectedActualTotal * 100) / 100,
      required_hours_total: Math.round(requiredHoursTotal * 100) / 100,
      required_hours_source: requiredHoursSource,
      reached,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 削除した行だけを消す(他の日の割り当てが残っていればそちらはそのまま)。
// 削除した結果その案件のcase_time_allocationsが0件になった場合は、
// projects.assigned_employee_idを未割り当てに戻した上で自動再提案
// (autoProposeForProject)を行い、提案確認パネルに再表示されるようにする。
//
// 【経緯】一時期、この自動再提案を「auto-propose-rangeボタンを繰り返し実行すると
// 新規提案が0件に近づいていく」問題の原因と考えて撤去したことがあったが、これは
// 誤診断だった。再提案された案件は提案確認パネルに正しく表示され続けており、
// ボタン実行時に「新規提案0件」になるのは、それらが既に提案済み(重複提案を
// 避けるため対象外)なだけの正常な挙動だった。一方、自動再提案を撤去した結果、
// 「ゴミ箱で削除→未割り当てに戻り、提案確認パネルに再表示される」という
// 元々の期待動作(以前のコミットで一度実装・確認済み)が失われてしまっていた
// ため、自動再提案を復活させる。この案件は依然としてassigned_employee_id IS
// NULLかつ既存の'提案'ありの状態なので、auto-propose-rangeボタンの重複除外
// ロジックにより二重提案はされない
app.delete('/api/time-allocations/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM case_time_allocations WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Time allocation not found' });

    const projectBefore = db.prepare('SELECT assigned_employee_id FROM projects WHERE id = ?').get(existing.case_id);

    db.prepare('DELETE FROM case_time_allocations WHERE id = ?').run(req.params.id);

    // 前準備・後片付けは実作業と同一レコード(setup_minutes/cleanup_minutes列)のため、
    // このDELETE一回で三者とも一緒に削除される
    writeDebugLog(
      `[time-allocations DELETE] 削除対象レコード: id=${req.params.id} case_id=${existing.case_id} ` +
      `employee_id=${existing.employee_id} work_date=${existing.work_date} planned_hours=${existing.planned_hours}h ` +
      `前準備=${existing.setup_minutes || 0}分 後片付け=${existing.cleanup_minutes || 0}分 status=${existing.status} ` +
      `を実作業と一緒に削除しました`
    );

    const remaining = db.prepare(
      'SELECT COUNT(*) as cnt FROM case_time_allocations WHERE case_id = ?'
    ).get(existing.case_id).cnt;

    let unassigned = false;
    let requeued = false;
    if (remaining === 0) {
      unassigned = true;
      const now = new Date().toISOString();
      db.prepare('UPDATE projects SET assigned_employee_id = NULL, updated_at = ? WHERE id = ?')
        .run(now, existing.case_id);

      let autoProposeResult = null;
      try {
        autoProposeResult = autoProposeForProject(db, existing.case_id);
        requeued = !autoProposeResult.error;
      } catch (autoProposeError) {
        console.error(`削除後の自動再提案に失敗しました(project_id=${existing.case_id}):`, autoProposeError.message);
      }

      // 再提案後の実際のレコードをそのまま確認する(提案確認パネルの
      // /api/proposalsと同じstatus='提案'条件で再表示されるはずのもの)
      const rowsAfterRequeue = db.prepare(
        `SELECT id, employee_id, work_date, status, setup_minutes, cleanup_minutes FROM case_time_allocations WHERE case_id = ?`
      ).all(existing.case_id);

      writeDebugLog(
        `[time-allocations DELETE] case_id=${existing.case_id} の割り当てが0件になったため未割り当てに戻しました ` +
        `assigned_employee_id: ${projectBefore ? projectBefore.assigned_employee_id : '不明'} → null(status変更前後) ` +
        `自動再提案=${requeued ? '成功' : '失敗/対象外'}` +
        (requeued
          ? ` → employee_id=${autoProposeResult.employee_id}(${autoProposeResult.employee_name})で提案確認パネルに再表示 allocated=${JSON.stringify(autoProposeResult.allocated_dates)}`
          : (autoProposeResult && autoProposeResult.error ? ` (理由: ${autoProposeResult.error})` : '')) +
        ` 再提案後のcase_time_allocations=${JSON.stringify(rowsAfterRequeue)}`
      );
    }

    res.json({ message: 'Time allocation deleted successfully', unassigned, requeued });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== 準備項目 =====

// 案件が全準備項目完了→未完了、未完了→全完了に切り替わったタイミングでcases.statusを同期する。
// WAITING(生産待ち)⇔PREP_COMPLETE(準備完了)以外の手動ステータス(受注前/受注確定/生産中/検品/納品待ち)は変更しない
function syncCaseStatusForPreparationItems(caseId) {
  const items = db.prepare('SELECT status FROM case_preparation_items WHERE case_id = ?').all(caseId);
  if (items.length === 0) {
    console.log(`[準備項目同期] 案件#${caseId}: case_preparation_itemsが0件のため対象外`);
    return;
  }

  const project = db.prepare('SELECT status FROM projects WHERE id = ?').get(caseId);
  if (!project) {
    console.log(`[準備項目同期] 案件#${caseId}: projectsに該当行なし`);
    return;
  }

  const allCompleted = items.every(i => i.status === '完了');
  const completedCount = items.filter(i => i.status === '完了').length;
  const now = new Date().toISOString();

  console.log(`[準備項目同期] 案件#${caseId}: 完了${completedCount}/${items.length}件, 現在のstatus=${project.status}`);

  if (allCompleted && project.status === 'WAITING') {
    db.prepare(`UPDATE projects SET status = 'PREP_COMPLETE', updated_at = ? WHERE id = ?`).run(now, caseId);
    console.log(`[準備項目同期] 案件#${caseId}: WAITING → PREP_COMPLETE に自動更新しました`);
  } else if (!allCompleted && project.status === 'PREP_COMPLETE') {
    db.prepare(`UPDATE projects SET status = 'WAITING', updated_at = ? WHERE id = ?`).run(now, caseId);
    console.log(`[準備項目同期] 案件#${caseId}: PREP_COMPLETE → WAITING に自動更新しました`);
  }
}

// 準備項目マスター一覧(案件新規登録画面の選択肢用)
app.get('/api/preparation-items/master', (req, res) => {
  try {
    const items = db.prepare(`
      SELECT * FROM preparation_item_master WHERE is_active = 1 ORDER BY display_order ASC
    `).all();
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 案件作成・編集時に選択した準備項目をまとめて登録(既に登録済みの項目はスキップ = 冪等)
app.post('/api/projects/:projectId/preparation-items', (req, res) => {
  try {
    const { preparation_item_ids } = req.body;
    if (!Array.isArray(preparation_item_ids)) {
      return res.status(400).json({ error: 'preparation_item_ids は配列で指定してください' });
    }
    const caseId = req.params.projectId;
    const existingIds = new Set(
      db.prepare('SELECT preparation_item_id FROM case_preparation_items WHERE case_id = ?')
        .all(caseId).map(row => row.preparation_item_id)
    );
    const insertStmt = db.prepare(`
      INSERT INTO case_preparation_items (case_id, preparation_item_id, status)
      VALUES (?, ?, '未着手')
    `);
    let createdCount = 0;
    preparation_item_ids.forEach(itemId => {
      if (!existingIds.has(itemId)) {
        insertStmt.run(caseId, itemId);
        createdCount++;
      }
    });
    res.status(201).json({ created: createdCount, message: 'Preparation items registered successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// スケジュールボード表示用・案件詳細表示用の準備項目タスク取得
// クエリ: case_id / start+end / date / staff_id / unassigned=true をそれぞれ任意で組み合わせ可能
app.get('/api/preparation-items', (req, res) => {
  try {
    const { case_id, start, end, date, staff_id, unassigned } = req.query;
    const conditions = [];
    const params = [];

    if (case_id) {
      conditions.push('cpi.case_id = ?');
      params.push(case_id);
    }
    if (start && end) {
      conditions.push('cpi.scheduled_date BETWEEN ? AND ?');
      params.push(start, end);
    } else if (date) {
      conditions.push('cpi.scheduled_date = ?');
      params.push(date);
    }
    if (staff_id) {
      conditions.push('cpi.assigned_staff_id = ?');
      params.push(staff_id);
    }
    if (unassigned === 'true') {
      conditions.push('cpi.scheduled_date IS NULL');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const items = db.prepare(`
      SELECT cpi.*, pim.name as preparation_item_name, p.project_name, p.status as project_status, e.name as assigned_staff_name
      FROM case_preparation_items cpi
      JOIN preparation_item_master pim ON cpi.preparation_item_id = pim.id
      JOIN projects p ON cpi.case_id = p.id
      LEFT JOIN employees e ON cpi.assigned_staff_id = e.id
      ${whereClause}
      ORDER BY cpi.scheduled_date ASC, cpi.id ASC
    `).all(...params);
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 担当者・予定日・工数の割り当て更新、およびstatus更新
app.put('/api/preparation-items/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM case_preparation_items WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Preparation item not found' });

    const assigned_staff_id = req.body.assigned_staff_id !== undefined ? req.body.assigned_staff_id : existing.assigned_staff_id;
    const scheduled_date = req.body.scheduled_date !== undefined ? req.body.scheduled_date : existing.scheduled_date;
    const estimated_hours = req.body.estimated_hours !== undefined ? req.body.estimated_hours : existing.estimated_hours;
    const status = req.body.status !== undefined ? req.body.status : existing.status;
    const completed_at = status === '完了'
      ? (existing.status === '完了' ? existing.completed_at : new Date().toISOString())
      : null;

    db.prepare(`
      UPDATE case_preparation_items SET
        assigned_staff_id=?, scheduled_date=?, estimated_hours=?, status=?, completed_at=?
      WHERE id=?
    `).run(assigned_staff_id || null, scheduled_date || null, estimated_hours, status, completed_at, req.params.id);

    if (status !== existing.status) {
      syncCaseStatusForPreparationItems(existing.case_id);
    }
    res.json({ message: 'Preparation item updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 完了操作。全準備項目が完了していれば案件ステータスを自動で「準備完了」に進める
app.put('/api/preparation-items/:id/complete', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM case_preparation_items WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Preparation item not found' });

    const now = new Date().toISOString();
    db.prepare(`UPDATE case_preparation_items SET status='完了', completed_at=? WHERE id=?`).run(now, req.params.id);
    syncCaseStatusForPreparationItems(existing.case_id);
    res.json({ message: 'Preparation item marked as completed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 完了の取り消し(未着手に戻す)。「準備完了」まで自動で進んでいた案件は「生産待ち」に自動で巻き戻す
app.put('/api/preparation-items/:id/incomplete', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM case_preparation_items WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Preparation item not found' });

    db.prepare(`UPDATE case_preparation_items SET status='未着手', completed_at=NULL WHERE id=?`).run(req.params.id);
    syncCaseStatusForPreparationItems(existing.case_id);
    res.json({ message: 'Preparation item marked as incomplete' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== 週間作業スケジュールボード =====

app.get('/schedule-board', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'schedule-board.html'));
});

app.get('/schedule', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'schedule-board.html'));
});

// その日ごとの勤務時間（employee_fixed_scheduleは廃止し、勤務時間の管理はこのテーブルに一本化）を一括取得
app.get('/api/schedule-overrides', (req, res) => {
  try {
    const overrides = db.prepare(`
      SELECT * FROM schedule_overrides ORDER BY employee_id ASC, work_date ASC
    `).all();
    res.json(overrides);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/schedule-overrides', (req, res) => {
  try {
    const { employee_id, work_date, start_time, end_time, break_minutes, is_day_off, reserved_hours } = req.body;
    const result = db.prepare(`
      INSERT INTO schedule_overrides (employee_id, work_date, start_time, end_time, break_minutes, is_day_off, reserved_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(employee_id, work_date, start_time || null, end_time || null, break_minutes || 0, is_day_off ? 1 : 0, reserved_hours || 0);
    res.status(201).json({ id: result.lastInsertRowid, message: 'Schedule override created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/schedule-overrides/:id', (req, res) => {
  try {
    const { start_time, end_time, break_minutes, is_day_off, reserved_hours } = req.body;
    db.prepare(`
      UPDATE schedule_overrides SET start_time=?, end_time=?, break_minutes=?, is_day_off=?, reserved_hours=? WHERE id=?
    `).run(start_time || null, end_time || null, break_minutes || 0, is_day_off ? 1 : 0, reserved_hours || 0, req.params.id);
    res.json({ message: 'Schedule override updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/schedule-overrides/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM schedule_overrides WHERE id = ?').run(req.params.id);
    res.json({ message: 'Schedule override deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 期間（start〜end, YYYY-MM-DD）指定で全案件横断の作業計画を取得
app.get('/api/time-allocations', (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'start, end は必須です' });
    }
    const allocations = db.prepare(`
      SELECT ta.*, p.project_name
      FROM case_time_allocations ta
      JOIN projects p ON ta.case_id = p.id
      WHERE ta.work_date BETWEEN ? AND ?
      ORDER BY ta.work_date ASC, ta.employee_id ASC
    `).all(start, end);
    res.json(allocations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 作業計画が存在する案件ごとの消化率（実績時間合計 ÷ 案件の作業予定時間）
app.get('/api/stats/project-progress', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.id, p.project_name, p.planned_hours, p.process_type, p.quantity, p.assigned_employee_id,
        COALESCE(SUM(ta.actual_hours), 0) as actual_hours_total,
        MAX(ta.work_date) as last_work_date
      FROM projects p
      JOIN case_time_allocations ta ON ta.case_id = p.id
      WHERE p.status != 'COMPLETED'
      GROUP BY p.id
      ORDER BY last_work_date DESC
    `).all();

    // 必要合計時間は、実際の自動割り振り(allocateHoursForEmployee)が使うのと同じ
    // required_hours(quantity ÷ 担当者の生産性)を基準にする。手入力のplanned_hours(分単位)を
    // 使うと、生産性の登録値によっては実際の割り振り量と大きくズレて見えるため。
    // 担当者未割り当て、または生産性が未登録で計算できない案件のみ、従来通り
    // planned_hoursを時間換算(÷60)したものをフォールバックとして使う
    const result = rows.map(row => {
      const { requiredHoursTotal, requiredHoursSource } = calculateProjectRequiredHoursTotal(db, row);
      const progressRatio = requiredHoursTotal > 0 ? row.actual_hours_total / requiredHoursTotal : 0;
      return {
        id: row.id,
        project_name: row.project_name,
        planned_hours_total: requiredHoursTotal,
        required_hours_source: requiredHoursSource,
        actual_hours_total: row.actual_hours_total,
        last_work_date: row.last_work_date,
        progress_ratio: progressRatio
      };
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/staff', (req, res) => {
  try {
    const staff = db.prepare('SELECT * FROM staff WHERE is_active = 1 ORDER BY id ASC').all();
    res.json(staff);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/staff', (req, res) => {
  try {
    const { name, role, capacity_minutes } = req.body;
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO staff (name, role, capacity_minutes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, role || 'FULL_TIME', capacity_minutes || 480, now, now);
    res.status(201).json({ id: result.lastInsertRowid, message: 'Staff created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/staff/:id', (req, res) => {
  try {
    const { name, role, capacity_minutes } = req.body;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE staff SET name=?, role=?, capacity_minutes=?, updated_at=? WHERE id=?
    `).run(name, role, capacity_minutes || 480, now, req.params.id);
    res.json({ message: 'Staff updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/staff/:id', (req, res) => {
  try {
    const now = new Date().toISOString();
    db.prepare('UPDATE staff SET is_active = 0, updated_at = ? WHERE id = ?').run(now, req.params.id);
    res.json({ message: 'Staff deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== 従業員関連 =====

app.get('/employees', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'employees.html'));
});

app.get('/delivery-history', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'delivery-history.html'));
});

app.get('/api/employees', (req, res) => {
  try {
    const employees = db.prepare('SELECT * FROM employees ORDER BY id ASC').all();
    res.json(employees);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/employees/:id', (req, res) => {
  try {
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    res.json(employee);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/employees', (req, res) => {
  try {
    const { name, role, is_active, skill_tags } = req.body;
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO employees (name, role, is_active, skill_tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, role, is_active === false ? 0 : 1, skill_tags || null, now, now);
    res.status(201).json({ id: result.lastInsertRowid, message: 'Employee created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/employees/:id', (req, res) => {
  try {
    const { name, role, is_active, skill_tags } = req.body;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE employees SET name=?, role=?, is_active=?, skill_tags=?, updated_at=? WHERE id=?
    `).run(name, role, is_active === false ? 0 : 1, skill_tags || null, now, req.params.id);
    res.json({ message: 'Employee updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/employees/:id', (req, res) => {
  try {
    const now = new Date().toISOString();
    db.prepare('UPDATE employees SET is_active = 0, updated_at = ? WHERE id = ?').run(now, req.params.id);
    res.json({ message: 'Employee deactivated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 従業員の曜日ごとの標準勤務パターンを一括取得
app.get('/api/employees/:id/default-schedule', (req, res) => {
  try {
    const schedules = db.prepare(`
      SELECT * FROM employee_default_schedule WHERE employee_id = ? ORDER BY weekday ASC
    `).all(req.params.id);
    res.json(schedules);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7曜日分を一括で置き換える（既存分をDELETEしてから渡された分をINSERT）
const replaceEmployeeDefaultSchedule = db.transaction((employeeId, schedules) => {
  db.prepare('DELETE FROM employee_default_schedule WHERE employee_id = ?').run(employeeId);
  const insert = db.prepare(`
    INSERT INTO employee_default_schedule (employee_id, weekday, is_working, start_time, end_time, break_minutes, reserved_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of schedules) {
    insert.run(employeeId, s.weekday, s.is_working ? 1 : 0, s.start_time || null, s.end_time || null, s.break_minutes || 0, s.reserved_hours || 0);
  }
});

app.post('/api/employees/:id/default-schedule', (req, res) => {
  try {
    const schedules = req.body.schedules || [];
    replaceEmployeeDefaultSchedule(req.params.id, schedules);
    res.json({ message: 'Default schedule updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 従業員の作業別生産性(1時間あたり処理数)を一括取得
app.get('/api/employees/:id/process-rates', (req, res) => {
  try {
    const rates = db.prepare(`
      SELECT * FROM employee_process_rates WHERE employee_id = ? ORDER BY process_type ASC
    `).all(req.params.id);
    res.json(rates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 作業別生産性を一括で置き換える（既存分をDELETEしてから渡された分をINSERT。units_per_hourが0以下の行は保存しない）
const replaceEmployeeProcessRates = db.transaction((employeeId, rates) => {
  db.prepare('DELETE FROM employee_process_rates WHERE employee_id = ?').run(employeeId);
  const insert = db.prepare(`
    INSERT INTO employee_process_rates (employee_id, process_type, color_count, units_per_hour)
    VALUES (?, ?, ?, ?)
  `);
  for (const r of rates) {
    if (r.units_per_hour > 0) {
      insert.run(employeeId, r.process_type, r.color_count || 1, r.units_per_hour);
    }
  }
});

app.post('/api/employees/:id/process-rates', (req, res) => {
  try {
    const rates = req.body.rates || [];
    replaceEmployeeProcessRates(req.params.id, rates);
    res.json({ message: 'Process rates updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats/daily-workload', (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const workload = db.prepare(`
      SELECT s.id, s.name, s.capacity_minutes,
        COALESCE(SUM(p.planned_hours), 0) as total_minutes,
        CASE
          WHEN COALESCE(SUM(p.planned_hours), 0) > s.capacity_minutes THEN 'over'
          WHEN COALESCE(SUM(p.planned_hours), 0) > s.capacity_minutes * 0.8 THEN 'warning'
          ELSE 'ok'
        END as status
      FROM staff s
      LEFT JOIN projects p ON s.id = p.assigned_staff_id
        AND DATE(p.deadline) = ?
        AND p.status IN ('WAITING', 'IN_PROGRESS', 'INSPECTION')
      WHERE s.is_active = 1
      GROUP BY s.id ORDER BY s.id
    `).all(date);
    res.json(workload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 公開注文フォーム(GET /order 表示 / POST /order 受付)。
// 社内管理APIとは別系統。着地は ai_extracted_intake(status=pending)。
registerOrderRoutes(app, db);

// チーム追加注文(専用URL /team/{token} + 管理画面 /team-links)。
// 着地は同じく ai_extracted_intake(line_user_id='TEAM'、受付番号 T-{id})。
registerTeamOrderRoutes(app, db);

// 5分ごとにLINEメッセージのAI構造化抽出を実行する。前回の実行が終わっていなければスキップする。
let aiExtractionRunning = false;
setInterval(async () => {
  if (aiExtractionRunning) return;
  aiExtractionRunning = true;
  try {
    await runExtractionCycle(db);
  } catch (err) {
    console.error('[AI抽出] 定期実行でエラー:', err);
  } finally {
    aiExtractionRunning = false;
  }
}, 5 * 60 * 1000);

app.listen(PORT, HOST, () => {
  scheduleDailyBackup(db);
  const candidates = getLocalIPs();
  console.log(`サーバー起動:`);
  console.log(`  このMacから: http://localhost:${PORT}`);
  if (candidates.length === 0) {
    console.log(`  社内LANの他端末から: (LAN用のIPアドレスが見つかりませんでした。Wi-Fi/有線LANの接続状況を確認してください)`);
  } else {
    console.log(`  社内LANの他端末から:`);
    candidates.forEach(c => {
      console.log(`    http://${c.address}:${PORT}  (${c.name}${c.likely ? ' ← おそらくこれ' : ''})`);
    });
    if (candidates.length > 1) {
      console.log(`  ※ 複数候補がある場合、まず「← おそらくこれ」のIPを試してください。繋がらなければ他の候補もお試しください。`);
    }
  }
});

// LAN到達性のあるIPv4アドレスの候補を洗い出す。
// VPN/仮想アダプタ（utun, awdl, bridge, vEthernet, VirtualBox, VMware, Docker/WSL等）は除外し、
// macOSのen0/en1やWindowsの物理Wi-Fi/EthernetアダプタらしきものをNS「おそらくこれ」とする。
function getLocalIPs() {
  const interfaces = require('os').networkInterfaces();
  const ignoredKeywords = [
    'utun', 'awdl', 'llw', 'bridge', 'vnic', 'anpi', 'ap1', 'p2p', // macOS仮想系
    'vethernet', 'virtualbox', 'vmware', 'docker', 'wsl', 'hyper-v', 'loopback' // Windows仮想系
  ];
  const preferredNames = ['en0', 'en1', 'wi-fi', 'ethernet'];
  const results = [];

  for (const name of Object.keys(interfaces)) {
    const lowerName = name.toLowerCase();
    if (ignoredKeywords.some(keyword => lowerName.includes(keyword))) continue;
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const likely = preferredNames.some(p => lowerName === p || lowerName.startsWith(p));
        results.push({ name, address: iface.address, likely });
      }
    }
  }

  // 優先インターフェースを先頭に
  results.sort((a, b) => (b.likely ? 1 : 0) - (a.likely ? 1 : 0));
  return results;
}

module.exports = app;