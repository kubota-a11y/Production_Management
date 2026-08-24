require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { initDatabase } = require('./db/init');
const line = require('@line/bot-sdk');
const { DESIGN_WORK_ITEM_CODES, NON_DESIGNER_ITEM_CODES, WORK_STATE_LABELS } = require('./lib/prep-items');
const { runExtractionCycle } = require('./lib/ai-extraction');
const { registerOrderRoutes } = require('./lib/order-intake');
const { registerTeamOrderRoutes } = require('./lib/team-order');
const { registerPartnerPortalRoutes } = require('./lib/partner-portal');
const { registerPartnerOrderRoutes } = require('./lib/partner-order');
const { registerDesignerBoardRoutes } = require('./lib/designer-board');
const { registerOpsBoardRoutes, markDeliveredStage } = require('./lib/ops-board');
const { registerWorkloadReportRoutes } = require('./lib/workload-report');
const { TASK_KINDS, recordTaskMove } = require('./lib/task-moves');
const { registerOrderStatusRoutes } = require('./lib/order-status');
const { registerManualIntakeRoutes } = require('./lib/manual-intake');
const { registerReferralRoutes } = require('./lib/referral');
const { registerWorksRoutes } = require('./lib/works-publish');
const { scheduleDailyBackup, getBackupStatus } = require('./lib/db-backup');
const { extractCarriedData, extractCarriedItems } = require('./lib/intake-carry');
const { completeIntakeTask } = require('./lib/todo-notify');
const { HOLIDAYS, isJpHoliday } = require('./lib/jp-holidays');
const freeeQuote = require('./lib/freee-quote');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// ===== プロセスレベルの安全網(2026-07-27) =====
// 想定外の例外でサーバーが黙って落ちると、社内の誰かが「画面が開かない」と気づくまで放置される。
// 原因調査できるよう db/crash.log に詳細を残す(*.logはgitignore済み)。
// - uncaughtException: プロセスの状態が保証できないため、記録して終了する
//   (Windowsサービス化(NSSM)後は自動再起動される。docs/Windowsサービス化手順.md 参照)
// - unhandledRejection: 即死はさせず記録のみ(取りこぼしたPromiseで全業務を止めないため)
const crashLogPath = path.join(__dirname, 'db', 'crash.log');
function logFatal(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${err && err.stack ? err.stack : err}\n`;
  try { fs.appendFileSync(crashLogPath, line); } catch (_) { /* ログ失敗でさらに落とさない */ }
  console.error(line);
}
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason));
process.on('uncaughtException', (err) => {
  logFatal('uncaughtException', err);
  process.exit(1);
});
// NAS_BASE_PATH は .env で明示的に指定するのが基本。
// 未設定時のデフォルトはOSごとに変える（Windowsではマップ済みドライブ文字 or UNCパスを想定）。
const NAS_BASE_PATH = process.env.NAS_BASE_PATH
  || (process.platform === 'win32' ? 'Z:\\DESIGN' : '/Volumes/disk1/DESIGN');

// パス比較用ヘルパー。Windowsはファイルパスの大文字小文字を区別しないため、
// セキュリティチェック(startsWith)がケース違いで誤ってブロックしないよう吸収する。
function isWithinBase(resolvedPath, basePath) {
  const base = path.resolve(basePath);
  // 前方一致だけだと「/Volumes/disk1/DESIGN_SECRET」のような兄弟ディレクトリも
  // 通ってしまうため、完全一致 or「base + 区切り文字」で始まることを要求する
  const target = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
  const baseCmp = process.platform === 'win32' ? base.toLowerCase() : base;
  return target === baseCmp || target.startsWith(baseCmp + path.sep);
}

// 500応答は定型メッセージのみ返し、SQLite等の内部エラー文はサーバーログにだけ残す
// (テーブル名・制約名などの内部構造を外部に漏らさないため)
function sendServerError(res, req, error) {
  console.error(`[API Error] ${req.method} ${req.path}:`, error);
  res.status(500).json({ error: 'サーバーエラーが発生しました' });
}

// ---- 入力値の最小バリデーション(2026-07-27) ----
// クライアントのバグや不正なリクエストがそのままDBを汚さないための共通ヘルパー
const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_STR_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
function isValidDateStr(v) {
  return typeof v === 'string' && DATE_STR_RE.test(v) && !Number.isNaN(new Date(`${v}T00:00:00`).getTime());
}
function isValidTimeStr(v) {
  return typeof v === 'string' && TIME_STR_RE.test(v);
}
function asFiniteNumber(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return (typeof n === 'number' && Number.isFinite(n)) ? n : null;
}
// ローカル時刻基準の今日(YYYY-MM-DD)。toISOString()はUTC基準のため深夜0〜9時に日付がずれる
function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

// CORSミドルウェアは廃止(2026-07-27)。公開フォーム・社内画面ともこのサーバー自身が
// 配信する同一オリジンのページからしかAPIを呼ばないため、クロスオリジン許可は不要。
// 全オリジン許可(cors())のままだと、公開ドメイン配下の無認証APIを任意サイトのJSから読めてしまう。

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
          // 本文はお客様の送信内容そのもの(顧客データ)のため、ログにはIDと文字数のみ残す
          console.log(`[LINE Webhook] text message received: id=${message.id} length=${(message.text || '').length}`);
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

// JSONボディの上限は2MBに制限(2026-07-27。以前は50mb)。
// 画像等の大きいデータはmulter(multipart)経路のみで受けるため、JSONが2MBを超える正当な用途はない。
// 大きすぎる上限は、無認証エンドポイントへの巨大JSON連投によるメモリ・CPU消費攻撃の余地になる。
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ limit: '2mb', extended: true }));
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

// ===== 外部公開ガード(2026-07-27、2026-07-28にホスト名判定へ修正) =====
// 目的: お客様に配っている公開URL(注文フォーム等)から、社内画面や社内APIへ
// 到達できないようにする。
//
// 判定は「どのホスト名で来たか」で行う。
//   - 公開ホスト名(お客様に配っているドメイン)  → 公開ページ・公開APIのみ許可、他は404
//   - それ以外のホスト名(社内用URL・LAN内のIP直打ち) → 従来どおり全機能を許可
//
// ※当初は「Cloudflare経由かどうか」で判定していたが、社内でもトンネル経由のURLで
//   HiBoardを開いているため、社内ページまで巻き込んで遮断してしまった(2026-07-28修正)。
//
// 公開ホスト名は .env の PUBLIC_HOSTNAMES で設定する(カンマ区切り)。
// 例: PUBLIC_HOSTNAMES=order.kubota-tunnel.com
// 未設定時は PUBLIC_ORDER_BASE_URL のホスト名と選手専用ドメインを公開ホストとみなす。
//
// 【重要】社内用URLをインターネットに出している場合、このガードだけでは守れない。
//   社内用ホスト名にはCloudflare Access(メール認証等)をかけること。
// 緊急時は .env に EXTERNAL_GUARD=off を設定すると無効化できる。
const EXTERNAL_GUARD_DISABLED = process.env.EXTERNAL_GUARD === 'off';
const PUBLIC_HOSTNAMES = (() => {
  const set = new Set(Object.keys(SUPPORT_DOMAIN_MAP));
  if (process.env.PUBLIC_HOSTNAMES) {
    for (const h of process.env.PUBLIC_HOSTNAMES.split(',')) {
      const host = (h || '').trim().toLowerCase();
      if (host) set.add(host);
    }
  } else if (process.env.PUBLIC_ORDER_BASE_URL) {
    // 明示設定が無ければ、お客様に配っている注文フォームのドメインを公開ホストとみなす
    try {
      set.add(new URL(process.env.PUBLIC_ORDER_BASE_URL).hostname.toLowerCase());
    } catch (_) { /* URLとして不正なら何も追加しない */ }
  }
  return set;
})();
const EXTERNAL_ALLOWED_PATTERNS = [
  /^\/order$/,                       // Web注文フォーム(GET/POST)
  /^\/guide$/,                       // ご注文の流れ
  /^\/status$/,                      // お客様向け 進捗確認ページ
  /^\/api\/order-status$/,           // 進捗確認の照合API(受付番号+電話下4桁)
  /^\/referral$/,                    // 紹介ページ(紹介コードを入力した人だけが中身を見られる)
  /^\/api\/referral\/verify$/,       // 紹介コードの照合API
  /^\/support\/[\w-]+$/,             // 選手応援 特設ページ
  /^\/team\/[\w-]+$/,                // チーム追加注文フォーム
  /^\/partner\/[\w-]+(\/order)?$/,   // 取引先ポータル・加工依頼フォーム
  /^\/designer\/[\w-]+$/,            // デザイナー マイスケジュールボード
  /^\/webhook$/,                     // LINE Webhook(署名検証あり)
  /^\/api\/(team-order|partner-order|partner-status|designer)\//, // 公開フォーム用API
  /^\/(styles|js|img)\//,            // 公開ページが参照する静的資産
  /^\/favicon\.ico$/,
];
// ★許可リストより先に判定する拒否リスト(2026-08-20 追加)。
// 上の /(styles|js|img)/ は「公開ページが参照する静的資産」をまとめて許可しているため、
// 社内画面だけが使うJSも公開ドメインから読めてしまう。社外に出せない情報
// (加工料金の全表・ボディ253品番の価格・割引内規・原価係数)を含むファイルは
// **ここに必ず足す**。画面のルートを404にするだけでは資産ファイルが素通りする。
const EXTERNAL_BLOCKED_PATTERNS = [
  /^\/js\/quote-sim/,                // 見積シミュレーター(quote-sim.js / quote-sim-data.js)
];
app.use((req, res, next) => {
  if (EXTERNAL_GUARD_DISABLED) return next();
  const hostname = (req.hostname || '').toLowerCase();
  // 社内用URL・LAN内のIP直打ちは対象外(従来どおり全機能を利用できる)
  if (!PUBLIC_HOSTNAMES.has(hostname)) return next();
  if (req.path === '/') {
    // トップ(/)は選手専用ドメインのみ許可。注文フォームのドメインで社内画面は出さない
    if (SUPPORT_DOMAIN_MAP[hostname]) return next();
    return res.status(404).send('Not Found');
  }
  // 拒否リストが先。許可リストの静的資産パターンより優先する
  if (EXTERNAL_BLOCKED_PATTERNS.some((re) => re.test(req.path))) {
    return res.status(404).send('Not Found');
  }
  if (EXTERNAL_ALLOWED_PATTERNS.some((re) => re.test(req.path))) return next();
  return res.status(404).send('Not Found');
});

// 公開フォームの静的HTMLファイル名への直アクセスは正規ルートへ逃がす(2026-07-27)。
// /order.html はテンプレート未置換({{MIN_LEAD_DAYS}}等が残ったまま)の生HTMLが配信されて
// しまい、Turnstile有効時はそのページから送信すると必ず403になる。
// トークンが必要なページ(チーム注文等)は素のHTMLでは動作しないためトップへ逃がす。
app.get('/order.html', (req, res) => res.redirect(301, '/order'));
app.get(['/team-order.html', '/partner-order.html', '/partner-status.html', '/designer-board.html'], (req, res) => res.redirect(302, '/'));

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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
  }
});

app.get('/api/projects', (req, res) => {
  try {
    // allocated_hours_total: 案件ごとにこれまで作業計画（case_time_allocations）へ割り振った予定時間の合計（時間単位・全期間）
    // 週間スケジュールボードで「案件の作業予定時間（分→時間換算）に対してすでに割り振り済みかどうか」を判定するために使用する
    const projects = db.prepare(`
      SELECT p.*, s.name as assigned_staff_name, emp.name as assigned_employee_name,
        holder.name as payment_holder_name,
        COALESCE(alloc.total_planned, 0) as allocated_hours_total
      FROM projects p
      LEFT JOIN staff s ON p.assigned_staff_id = s.id
      LEFT JOIN employees emp ON p.assigned_employee_id = emp.id
      LEFT JOIN employees holder ON p.payment_holder_employee_id = holder.id
      LEFT JOIN (
        SELECT case_id, SUM(planned_hours) as total_planned
        FROM case_time_allocations
        GROUP BY case_id
      ) alloc ON alloc.case_id = p.id
      ORDER BY (p.deadline IS NULL OR p.deadline = '') ASC, p.deadline ASC
    `).all();
    res.json(projects);
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// 見積シミュレーターの「案件を検索して紐づける」用。顧客名・案件名・品名の部分一致で
// 直近の案件を返す(最大20件)。★/:id より先に定義すること(後ろだと "quote-search" が :id に食われる)
app.get('/api/projects/quote-search', (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const like = `%${q}%`;
    const rows = db.prepare(`
      SELECT id, customer_name, project_name, item_name, status, deadline, quantity
      FROM projects
      WHERE customer_name LIKE ? OR project_name LIKE ? OR item_name LIKE ?
      ORDER BY id DESC LIMIT 20
    `).all(like, like, like);
    res.json(rows);
  } catch (error) {
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
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
    // 5MBを超えたら1世代だけ退避して新規に書き始める(無限に肥大しないように)
    try {
      const stat = fs.statSync(debugLogPath);
      if (stat.size > 5 * 1024 * 1024) {
        // 退避先も *.log にして.gitignoreの対象に収める
        fs.renameSync(debugLogPath, debugLogPath.replace(/\.log$/, '-old.log'));
      }
    } catch (_) { /* ファイル未作成なら何もしない */ }
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
        // 祝日は標準勤務パターンより優先して休み扱い(出勤する祝日はoverrideを登録する)
        if (def.is_working && !isJpHoliday(dateStr)) {
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
    sendServerError(res, req, error);
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
      // 祝日は標準勤務パターンより優先して休み扱い(出勤する祝日はoverrideを登録する)
      if (def && def.is_working && !isJpHoliday(dateStr)) {
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

// 提案確認パネルに載せる案件ステータス。
// 新規登録時のステータス既定値は「受注前」のため、上のSCHEDULABLE_PROJECT_STATUSESだけで
// 絞ると、登録したばかりの案件がパネルにもボードにも出てこず埋もれてしまう。
// そこでパネルへの掲載(=人が見てドラッグで置ける)は受注前も対象にする。
// ただし自動割当(autoPropose)は従来どおり受注前を除外し、未確定の案件へ機械的に
// 工数が積まれないようにしている
const PROPOSAL_PANEL_PROJECT_STATUSES = ['PRE_ORDER', ...SCHEDULABLE_PROJECT_STATUSES];

// カーヴ案件(鈴木さんがCARVEで受けている紙媒体。paper_source='CARVE')は鈴木さん専用で、
// 生産の担当者に割り振る作業が無いため、スケジュールボードの提案・自動割当の対象外にする
// (2026-08-24 社長指示)。鈴木さんの作業は準備項目としてマイスケジュールボードに載る。
// 社内デザイン案件(INTERNAL_DESIGN)と同じ扱いだが、案件種別ではなく紙媒体の出どころで判定する
function isCarveProject(project) {
  return project && project.paper_source === 'CARVE';
}

// 案件1件に対して、最上位担当者を選び、受付日から順に空き時間へ割り振って
// case_time_allocations に status:'提案' で登録する
function autoProposeForProject(db, projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return { project_id: projectId, error: '案件が見つかりません' };
  if (!SCHEDULABLE_PROJECT_STATUSES.includes(project.status)) {
    return { project_id: projectId, error: `対象外のステータス(${project.status})のため自動割当できません` };
  }
  if (isCarveProject(project)) {
    return { project_id: projectId, error: 'カーヴ案件は鈴木さん専用のためスケジュールボードの対象外です' };
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
    sendServerError(res, req, error);
  }
});

app.post('/api/projects/bulk-auto-propose', (req, res) => {
  try {
    const unassigned = db.prepare('SELECT id FROM projects WHERE assigned_employee_id IS NULL').all();
    const results = unassigned.map(p => autoProposeForProject(db, p.id));
    res.json({ results });
  } catch (error) {
    sendServerError(res, req, error);
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
  if (isCarveProject(project)) {
    return { project_id: projectId, error: 'カーヴ案件は鈴木さん専用のためスケジュールボードの対象外です' };
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

    // 社内デザイン案件・カーヴ案件は生産の自動割り当て対象外
    // (デザイン作業は準備項目でデザイナーに割り当てる)
    const candidateProjects = db.prepare('SELECT * FROM projects WHERE assigned_employee_id IS NULL').all()
      .filter(p => !alreadyProposedCaseIds.has(p.id) && SCHEDULABLE_PROJECT_STATUSES.includes(p.status)
        && p.project_kind !== 'INTERNAL_DESIGN' && !isCarveProject(p));

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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
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
      // 検品・納品待ちなどスケジュール調整が不要なステータスの案件は
      // 提案確認パネルの対象外にする(PROPOSAL_PANEL_PROJECT_STATUSES参照)
      if (!PROPOSAL_PANEL_PROJECT_STATUSES.includes(project.status)) return null;
      // カーヴ案件は鈴木さん専用のためパネルに出さない(過去に作られた'提案'行が残っていても隠す)
      if (isCarveProject(project)) return null;

      const suggestions = calculateSuggestions(db, project, { quiet: true });
      const matched = suggestions.find(s => s.employee_id === row.employee_id);

      return {
        case_id: row.case_id,
        project_name: project.project_name,
        customer_name: project.customer_name,
        deadline: project.deadline,
        quantity: project.quantity,
        process_type: project.process_type,
        status: project.status,
        employee_id: row.employee_id,
        employee_name: row.employee_name,
        proposed_hours_total: Math.round(row.proposed_hours_total * 10) / 10,
        score: matched ? matched.score : null,
        available_hours: matched ? matched.available_hours : null,
      };
    }).filter(Boolean);

    // まだ担当者候補も予定も付いていない未着手案件(case_time_allocationsに行が1件も無い)も
    // 「担当者未定」カードとして提案確認パネルに出す。これがないと、担当者を割り当てるまで
    // 案件がボードのどこにも現れず埋もれてしまう。対象はパネル掲載ステータス
    // (PROPOSAL_PANEL_PROJECT_STATUSES = 受注前を含む)。status='提案'の案件は上のresultsに、
    // status='予定'等の確定済み案件はcase_time_allocationsに行があるため、ここには含まれない
    // (=既存カードと重複しない)
    // 社内デザイン案件(INTERNAL_DESIGN)とカーヴ案件(paper_source='CARVE')は
    // 生産の担当割り当て対象外のため除外する
    // (デザイン作業は準備項目としてデザイナーに割り当てる)
    const schedulablePlaceholders = PROPOSAL_PANEL_PROJECT_STATUSES.map(() => '?').join(', ');
    const unassignedProjects = db.prepare(`
      SELECT * FROM projects
      WHERE status IN (${schedulablePlaceholders})
        AND COALESCE(project_kind, 'NORMAL') != 'INTERNAL_DESIGN'
        AND COALESCE(paper_source, 'HIYOSHI') != 'CARVE'
        AND id NOT IN (SELECT DISTINCT case_id FROM case_time_allocations)
      ORDER BY id ASC
    `).all(...PROPOSAL_PANEL_PROJECT_STATUSES);

    const unassignedCards = unassignedProjects.map(project => ({
      case_id: project.id,
      project_name: project.project_name,
      customer_name: project.customer_name,
      deadline: project.deadline,
      quantity: project.quantity,
      process_type: project.process_type,
      status: project.status,
      employee_id: null,
      employee_name: null,
      proposed_hours_total: null,
      score: null,
      available_hours: null,
    }));

    res.json([...results, ...unassignedCards]);
  } catch (error) {
    sendServerError(res, req, error);
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
function moveProjectToInspection(db, projectId, source, { requireAllocations = true } = {}) {
  // 割り当て削除とステータス変更が中途半端に片方だけ残らないよう、全体を1トランザクションで行う
  return db.transaction(() => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return { error: '案件が見つかりません' };

    const deletedRows = db.prepare(`
      SELECT id, employee_id, work_date, planned_hours, actual_hours, status, setup_minutes, cleanup_minutes
      FROM case_time_allocations WHERE case_id = ?
    `).all(projectId);

    // requireAllocations=false は「割り当てが無くても検品に進めてよい」経路
    // (準備項目リスト等のステータス変更ボタン)用。割り当てがあれば同様に削除する
    if (deletedRows.length === 0 && requireAllocations) {
      return { error: 'スケジュール上の割り当てが見つかりません' };
    }

    const result = deletedRows.length > 0
      ? db.prepare('DELETE FROM case_time_allocations WHERE case_id = ?').run(projectId)
      : { changes: 0 };

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
  })();
}

app.post('/api/projects/:id/move-to-inspection', (req, res) => {
  try {
    const result = moveProjectToInspection(db, req.params.id, 'proposal-panel');
    if (result.error) return res.status(404).json({ error: result.error });
    res.json({ message: 'Project moved to inspection', deleted: result.deleted });
  } catch (error) {
    sendServerError(res, req, error);
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

    // 必要時間の決め方(2026-07-28に方針変更)。
    // 担当者の生産性(employee_process_rates)が未登録でもボードに置けるようにするため、
    // 次の優先順で決める。以前は生産性が無いと「必要時間を計算できませんでした」で
    // ドロップ自体が失敗し、担当者を割り当てないと案件をボードに載せられなかった。
    //   1. 担当者の生産性から計算できるならそれ(従来どおり精度が高い)
    //   2. 既存の提案に積まれていた合計時間(別の担当者向けに算出済みの値)
    //   3. 案件の「作業予定時間」(手入力の見積もり・分) ← これで誰の列にも置ける
    const { requiredHours, canHandleAll } = calculateRequiredHours(db, project, employeeId);
    const plannedHours = (project.planned_hours || 0) / 60;
    const finalRequiredHours = (canHandleAll && requiredHours > 0) ? requiredHours
      : (existingProposalHours > 0 ? existingProposalHours : plannedHours);

    if (finalRequiredHours <= 0) {
      return res.status(400).json({ error: 'この案件の必要時間が分かりません。案件の「作業予定時間」を入力してください' });
    }

    // 既存提案の削除→再割り振り→担当者更新を1トランザクションにまとめる。
    // 以前は削除後に「割り振れる空きがない」で中断すると既存提案が消えたままになっていた
    // (失敗時はロールバックされ、ドラッグ前の提案がそのまま残る)
    let allocatedDates, remainingHours;
    try {
      ({ allocatedDates, remainingHours } = db.transaction(() => {
        db.prepare(`DELETE FROM case_time_allocations WHERE case_id = ? AND status = '提案'`).run(project.id);

        // allocateHoursForEmployeeは「receivedDateの翌日」から割り振るため、
        // ドロップした日を初日にするために1日前の日付を疑似receivedDateとして渡す
        const pseudoReceivedDate = new Date(workDate);
        pseudoReceivedDate.setDate(pseudoReceivedDate.getDate() - 1);
        const deadline = new Date(project.deadline);

        const allocResult = allocateHoursForEmployee(
          db, project.id, employeeId, employee.name, finalRequiredHours, pseudoReceivedDate, deadline, '予定',
          setupMinutes, cleanupMinutes
        );

        if (allocResult.allocatedDates.length === 0) {
          const err = new Error('ドロップした日以降に割り振れる空き時間がありませんでした');
          err.userMessage = err.message;
          throw err;
        }

        const now = new Date().toISOString();
        db.prepare('UPDATE projects SET assigned_employee_id = ?, updated_at = ? WHERE id = ?')
          .run(employeeId, now, project.id);
        return allocResult;
      })());
    } catch (txError) {
      if (txError.userMessage) return res.status(400).json({ error: txError.userMessage });
      throw txError;
    }

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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
  }
});

// ===== 見積シミュレーター連携(2026-08-20) =====
// 案件 → /quote-sim?case=ID で開いたときの引き継ぎデータ。
// ボディ品番・加工サイズは案件が持っていないため、画面側で人が選ぶ
app.get('/api/projects/:id/quote-context', (req, res) => {
  try {
    const p = db.prepare(`
      SELECT id, project_name, customer_name, item_name, quantity, freee_quote_url
      FROM projects WHERE id = ?
    `).get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const printLocations = db.prepare(`
      SELECT location_name, color_count FROM case_print_locations
      WHERE case_id = ? ORDER BY id ASC
    `).all(p.id);
    res.json({ project: p, print_locations: printLocations });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// 概算履歴。金額変更の経緯(50%で試算→40%で確定 等)を追えるよう全件残す
app.get('/api/projects/:id/quotes', (req, res) => {
  try {
    const quotes = db.prepare(`
      SELECT id, total, discount_name, approved_by, created_at, sheet_text
      FROM case_quotes WHERE case_id = ? ORDER BY id DESC
    `).all(req.params.id);
    res.json(quotes);
  } catch (error) {
    sendServerError(res, req, error);
  }
});

app.post('/api/projects/:id/quotes', (req, res) => {
  try {
    const p = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const { sheet_text, total, discount_name, approved_by } = req.body || {};
    if (!sheet_text || !Number.isFinite(Number(total))) {
      return res.status(400).json({ error: '転記シートと合計金額は必須です' });
    }
    const info = db.prepare(`
      INSERT INTO case_quotes (case_id, sheet_text, total, discount_name, approved_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(p.id, String(sheet_text), Math.round(Number(total)),
      discount_name ? String(discount_name) : null,
      approved_by ? String(approved_by) : null,
      new Date().toISOString());
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// freeeで発行した見積書URLを案件に紐づける(顧客台帳・納品履歴の「📄 見積書」リンクが生きる)。
// 誤入力でリンクが壊れないよう、freeeのURLかどうかだけ検査する。空文字はクリア扱い
app.patch('/api/projects/:id/freee-quote-url', (req, res) => {
  try {
    const p = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const url = String(req.body?.url ?? '').trim();
    if (url) {
      let host = null;
      try { host = new URL(url).hostname; } catch (_) { /* 下で弾く */ }
      if (!host || !(host === 'secure.freee.co.jp' || host.endsWith('.secure.freee.co.jp'))) {
        return res.status(400).json({ error: 'freeeのURL(secure.freee.co.jp)を貼り付けてください' });
      }
    }
    db.prepare('UPDATE projects SET freee_quote_url = ?, updated_at = ? WHERE id = ?')
      .run(url, new Date().toISOString(), p.id);
    res.json({ ok: true });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

/* ==========================================================================
   freee連携(見積書の自動作成)
   見積シミュレーターの内容をそのままfreeeの見積書として発行する。
   ★freeeには「下書き」が無く、作成した時点で番号が採番される。人の確認は
     画面側(確認ダイアログ)で発行前に済ませる前提。ここでは検算だけ守る
   ========================================================================== */

// 連携状態。画面が「未設定/未認可/連携済み」を出し分けるために使う
app.get('/api/freee/status', (req, res) => {
  try {
    res.json(freeeQuote.status());
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// 認可の開始。freeeのログイン画面へ飛ばす(パスワードはfreee側でしか入力されない)
app.get('/api/freee/authorize', (req, res) => {
  if (!freeeQuote.isConfigured()) {
    return res.status(400).send('freeeのClient ID/Secret/事業所IDが未設定です。.env を確認してください');
  }
  res.redirect(freeeQuote.buildAuthorizeUrl());
});

// 認可後にfreeeから戻ってくる先。ここで認可コードをトークンに交換する
app.get('/api/freee/callback', async (req, res) => {
  const { code, state, error: authError } = req.query;
  if (authError) return res.status(400).send(`freeeの認可が中断されました: ${String(authError)}`);
  if (!freeeQuote.consumeState(String(state || ''))) {
    return res.status(400).send('認可の照合に失敗しました。お手数ですが「freeeと連携する」からやり直してください');
  }
  try {
    await freeeQuote.exchangeCode(String(code || ''));
    res.send('<meta charset="utf-8"><p>freeeとの連携が完了しました。このタブを閉じて、見積シミュレーターに戻ってください。</p>');
  } catch (error) {
    console.error('freee認可エラー:', error.message);
    res.status(500).send('<meta charset="utf-8"><p>連携に失敗しました。サーバーのログを確認してください。</p>');
  }
});

// 連携を解除する(トークンを消すだけ。freee側のアプリ連携は画面から解除する)
app.post('/api/freee/disconnect', (req, res) => {
  try {
    freeeQuote.clearToken();
    res.json({ ok: true });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// 顧客名からfreeeの取引先候補を出す。すでに対応を覚えていればそれを最優先で返す
app.get('/api/freee/partners', async (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  try {
    const linked = keyword
      ? db.prepare('SELECT partner_id, partner_name, display_name FROM freee_partner_links WHERE customer_name = ?').get(keyword)
      : null;
    const partners = await freeeQuote.searchPartners(keyword);
    res.json({ ok: true, linked: linked || null, partners });
  } catch (error) {
    // 未認可・期限切れは想定内。画面が案内を出せるよう200で返す
    if (error.code === 'NOT_AUTHORIZED') return res.json({ ok: false, need_auth: true, error: error.message });
    console.error('freee取引先検索エラー:', error.message);
    res.json({ ok: false, error: error.message });
  }
});

// 見積書を作成する。成功したら report_url を案件に紐づけ、概算履歴にも残す
app.post('/api/freee/quotations', async (req, res) => {
  try {
    const { sheet, partner, case_id: caseId, sheet_text: sheetText, discount_name: discountName, approved_by: approvedBy } = req.body || {};
    if (!sheet || !Array.isArray(sheet.lines) || !sheet.lines.length) {
      return res.status(400).json({ ok: false, error: '見積の明細がありません' });
    }
    if (!partner || !partner.id) {
      return res.status(400).json({ ok: false, error: 'freeeの取引先を選んでください' });
    }
    // 画面が作った金額をそのまま信じない。ズレたまま発行すると取り消ししか手が無い
    const check = freeeQuote.verifyTotal(sheet);
    if (!check.ok) {
      return res.status(400).json({
        ok: false,
        error: `金額が合わないため発行を止めました(明細の積み上げ ${check.sum.toLocaleString()}円 / 画面の合計 ${check.total.toLocaleString()}円)。`
          + 'お急ぎのときは「転記シートをコピー」してfreeeに手入力してください。この画面のことは社長へ連絡をお願いします',
      });
    }

    const created = await freeeQuote.createQuotation(sheet, partner);

    // 社内メモだけ入らなかった場合は、発行は成功しているので警告で伝える
    let memoWarning = created.memo_skipped
      ? '見積書は発行できましたが、社内メモは入りませんでした(freee側の項目が変わった可能性)。必要ならfreeeで直接ご記入ください'
      : null;

    // ★ここから先の失敗を「発行失敗」として返してはいけない。
    //   freeeにはもう見積書が出来ていて番号も採番されているので、画面が
    //   「発行できませんでした」と出すと利用者が押し直し、二重発行になる。
    //   後片付け(記録)が転んでも発行そのものは成功として返し、警告だけ添える
    let warning = memoWarning;
    try {
      // 次回から名前で引けるよう、選ばれた取引先を覚える
      const customerName = String(sheet.customer || '').trim();
      if (customerName) {
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO freee_partner_links (customer_name, partner_id, partner_name, display_name, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(customer_name) DO UPDATE SET
            partner_id = excluded.partner_id,
            partner_name = excluded.partner_name,
            display_name = excluded.display_name,
            updated_at = excluded.updated_at
        `).run(customerName, partner.id, String(partner.name || ''),
          partner.display_name ? String(partner.display_name) : null, now, now);
      }

      // 案件と紐づいていれば、見積書URLと概算履歴を書き戻す(手作業のコピペが不要になる)
      const projectId = parseInt(caseId, 10);
      if (projectId > 0 && db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) {
        const now = new Date().toISOString();
        if (created.report_url) {
          db.prepare('UPDATE projects SET freee_quote_url = ?, updated_at = ? WHERE id = ?')
            .run(created.report_url, now, projectId);
        }
        if (sheetText) {
          db.prepare(`
            INSERT INTO case_quotes (case_id, sheet_text, total, discount_name, approved_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(projectId, String(sheetText), Math.round(Number(sheet.total) || 0),
            discountName ? String(discountName) : null,
            approvedBy ? String(approvedBy) : null, now);
        }
      }
    } catch (recordError) {
      console.error('freee見積書の記録エラー(発行そのものは成功):', recordError.message);
      warning = '見積書はfreeeに発行できましたが、案件への記録に失敗しました。'
        + '案件詳細で見積書URLの貼り付けをお願いします(発行はやり直さないでください)';
    }

    res.json({ ok: true, quotation: created, warning });
  } catch (error) {
    if (error.code === 'NOT_AUTHORIZED') return res.json({ ok: false, need_auth: true, error: error.message });
    console.error('freee見積書作成エラー:', error.message);
    res.json({ ok: false, error: error.message });
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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
  }
});

// 案件新規作成の共通処理。/api/projects と AI受注候補の確認登録(/api/ai-intake/:id/confirm)の
// 両方から使うため、案件テーブルへのINSERT本体をここに集約する
function createProjectRecord(data) {
  const { project_name, received_date, deadline, customer_name, contact_method,
    work_content, process_type, quantity, planned_hours, assigned_staff_id,
    status, priority, reference_link, memo, nas_folder_path, prep_items,
    required_skill_tags, estimated_hours, assigned_employee_id, project_kind,
    freee_quote_url, freee_invoice_url, is_design_ops, item_name, ops_flow, paper_source,
    first_draft_due, submission_due, design_planned_hours } = data;
  // 社内デザイン案件は数量・作業予定時間なしで登録できるため、NOT NULL列は0で埋める
  const kind = project_kind === 'INTERNAL_DESIGN' ? 'INTERNAL_DESIGN' : 'NORMAL';
  // 進行タイプ: FULL=加工まで(標準) / SUBMIT_END=紙媒体・入稿で完了
  const flow = ops_flow === 'SUBMIT_END' ? 'SUBMIT_END' : 'FULL';
  // 紙媒体の出どころ: HIYOSHI=弊社依頼 / CARVE=鈴木さんがCARVEで受けている案件
  const paperSrc = paper_source === 'CARVE' ? 'CARVE' : 'HIYOSHI';
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO projects (
      project_name, received_date, deadline, customer_name, contact_method,
      work_content, process_type, quantity, planned_hours, assigned_staff_id,
      status, priority, reference_link, memo, nas_folder_path, prep_items,
      required_skill_tags, estimated_hours, assigned_employee_id, project_kind,
      freee_quote_url, freee_invoice_url, is_design_ops, item_name, ops_flow, paper_source,
      first_draft_due, submission_due, design_planned_hours, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project_name, received_date, deadline || '', customer_name, contact_method,
    work_content || '', process_type || '', quantity || 0, planned_hours || 0, assigned_staff_id || null,
    status || 'PRE_ORDER', priority || 'MEDIUM', reference_link || '', memo || '',
    nas_folder_path || '', prep_items || '', required_skill_tags || '', estimated_hours || null,
    assigned_employee_id || null, kind, freee_quote_url || '', freee_invoice_url || '',
    is_design_ops ? 1 : 0, item_name || '', flow, paperSrc,
    first_draft_due || null, submission_due || null, design_planned_hours || null, now, now);

  // 紙媒体(入稿で完了)タイプは鈴木さんの制作から始まる(2026-08-03 社長決定)。
  // 山本さんのブリーフ・ラフ工程を飛ばして「制作」段階でボードに載せる
  if (is_design_ops && flow === 'SUBMIT_END') {
    db.prepare(`UPDATE projects SET ops_stage = 'DESIGN', ops_stage_since = ? WHERE id = ?`)
      .run(now, result.lastInsertRowid);
  }
  return result.lastInsertRowid;
}

app.post('/api/projects', (req, res) => {
  try {
    const id = createProjectRecord(req.body);
    // 社内デザイン案件とカーヴ案件は生産作業ではないため、従業員への自動割り当て提案の対象外にする
    if (req.body.project_kind !== 'INTERNAL_DESIGN' && req.body.paper_source !== 'CARVE') {
      try {
        const autoProposeResult = autoProposeForProject(db, id);
        if (autoProposeResult.error) {
          console.error(`自動提案に失敗しました(project_id=${id}): ${autoProposeResult.error}`);
        }
      } catch (autoProposeError) {
        console.error(`自動提案に失敗しました(project_id=${id}):`, autoProposeError.message);
      }
    }
    res.status(201).json({ id, message: 'Project created successfully' });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

app.put('/api/projects/:id', (req, res) => {
  try {
    const { project_name, received_date, deadline, customer_name, contact_method,
      work_content, process_type, quantity, planned_hours, assigned_staff_id,
      status, priority, reference_link, memo, nas_folder_path, prep_items,
      required_skill_tags, estimated_hours, assigned_employee_id, project_kind,
      freee_quote_url, freee_invoice_url, is_design_ops, item_name, ops_flow, paper_source,
      first_draft_due, submission_due, design_planned_hours } = req.body;
    const kind = project_kind === 'INTERNAL_DESIGN' ? 'INTERNAL_DESIGN' : 'NORMAL';
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE projects SET
        project_name=?, received_date=?, deadline=?, customer_name=?, contact_method=?,
        work_content=?, process_type=?, quantity=?, planned_hours=?, assigned_staff_id=?,
        status=?, priority=?, reference_link=?, memo=?, nas_folder_path=?, prep_items=?,
        required_skill_tags=?, estimated_hours=?, assigned_employee_id=?, project_kind=?,
        freee_quote_url=?, freee_invoice_url=?, is_design_ops=?, item_name=?, ops_flow=?, paper_source=?,
        first_draft_due=?, submission_due=?, design_planned_hours=?, updated_at=?
      WHERE id=?
    `).run(project_name, received_date, deadline || '', customer_name, contact_method,
      work_content || '', process_type || '', quantity || 0, planned_hours || 0, assigned_staff_id || null,
      status, priority, reference_link || '', memo || '', nas_folder_path || '', prep_items || '',
      required_skill_tags || '', estimated_hours || null, assigned_employee_id || null, kind,
      freee_quote_url || '', freee_invoice_url || '', is_design_ops ? 1 : 0, item_name || '',
      ops_flow === 'SUBMIT_END' ? 'SUBMIT_END' : 'FULL',
      paper_source === 'CARVE' ? 'CARVE' : 'HIYOSHI',
      first_draft_due || null, submission_due || null, design_planned_hours || null, now, req.params.id);
    res.json({ message: 'Project updated successfully' });
  } catch (error) {
    sendServerError(res, req, error);
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

    // 検品への変更は、提案パネルの「検品へ」ボタン(move-to-inspection)と同じ削除処理を通す。
    // 以前はこの経路(準備項目リストの「検品へ」等)がステータスだけ変えていたため、
    // 検品済み案件の作業ブロックがスケジュールボードに残り、空き時間を食い続けていた
    if (status === 'INSPECTION') {
      const result = moveProjectToInspection(db, req.params.id, 'status-api', { requireAllocations: false });
      if (result.error) return res.status(404).json({ error: result.error });
      return res.json({ message: 'Project status updated successfully', deleted_allocations: result.deleted });
    }

    const now = new Date().toISOString();
    db.prepare(`UPDATE projects SET status=?, updated_at=? WHERE id=?`).run(status, now, req.params.id);
    res.json({ message: 'Project status updated successfully' });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// 制作予定時間だけを更新する(2026-08-18)。案件登録時に未定でも登録できるようにしたため、
// スケジュールボードで実際に予定を置いたときに、そこで入力された時間を案件へ書き戻す。
// 案件の全項目を送り直す PUT /api/projects/:id とは用途が違うので別のエンドポイントにしている
app.patch('/api/projects/:id/planned-hours', (req, res) => {
  try {
    const planned = Number(req.body.planned_hours);
    if (!Number.isFinite(planned) || planned < 0) {
      return res.status(400).json({ error: '制作予定時間は0以上の数値で指定してください' });
    }
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    db.prepare('UPDATE projects SET planned_hours = ?, updated_at = ? WHERE id = ?')
      .run(planned, new Date().toISOString(), req.params.id);
    res.json({ message: 'Planned hours updated successfully' });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// 入金・現金預かりの状態を切り替える(2026-08-18 三浦さん・鈴木さんとのMTGで追加)。
// 「今日お金持っていきます」「入金しておきました」という電話連絡を無くし、
// 案件一覧の上で誰が現金を預かっているかまで見えるようにするためのもの。
// 案件の進行(status)とは別の軸なので、専用のエンドポイントに分けている
const PAYMENT_STATUSES = ['UNPAID', 'CASH_RECEIVED', 'PAID'];
// 支払方法。状態とは別の軸で持つので「振込だがまだ入金確認できていない」を表せる
const PAYMENT_METHODS = ['CASH', 'TRANSFER', 'CREDIT'];
app.patch('/api/projects/:id/payment', (req, res) => {
  try {
    const { payment_status, payment_holder_employee_id, payment_method } = req.body;
    if (!PAYMENT_STATUSES.includes(payment_status)) {
      return res.status(400).json({ error: '入金状態の指定が不正です' });
    }
    if (payment_method && !PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({ error: '支払方法の指定が不正です' });
    }
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // 現金を預かれるのは支払方法が現金のときだけ。振込・クレカで預かりは起こりえない
    if (payment_status === 'CASH_RECEIVED' && payment_method && payment_method !== 'CASH') {
      return res.status(400).json({ error: '「現金預かり」を選べるのは支払方法が現金のときだけです' });
    }
    // 預かった人が意味を持つのは「現金預かり」のときだけ。
    // 入金済み・未入金へ戻したときに前の預かり者が残っていると誤解を生むので消す
    const holderId = payment_status === 'CASH_RECEIVED'
      ? (payment_holder_employee_id ? parseInt(payment_holder_employee_id, 10) : null)
      : null;
    if (payment_status === 'CASH_RECEIVED' && !holderId) {
      return res.status(400).json({ error: '現金を預かった人を選択してください' });
    }

    db.prepare(`
      UPDATE projects
      SET payment_status = ?, payment_holder_employee_id = ?, payment_method = ?, payment_updated_at = ?
      WHERE id = ?
    `).run(payment_status, holderId, payment_method || null, new Date().toISOString(), req.params.id);

    res.json({ message: 'Payment status updated successfully' });
  } catch (error) {
    sendServerError(res, req, error);
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
    // 納品記録の作成・ステータス変更・残っている作業ブロックの削除を1トランザクションで行う。
    // 検品を経由せず直接納品した案件の割り当てがボードに残り続けないよう、ここでも削除する
    db.transaction(() => {
      db.prepare('DELETE FROM case_time_allocations WHERE case_id = ?').run(req.params.id);
      // 納品した案件の準備項目は、チェックが付いていなくても完了として扱う。
      // 未完了のまま残すと「まだやることがある」扱いのまま、
      //   ・週間ボードの準備項目リストの繰り越し
      //   ・デザイナーのマイスケジュールボード「日付が未定のタスク」
      //   ・勤務時間編集モーダルの割り当て候補プルダウン
      // の3か所に永久に出続けてしまう(実際に本番で残り続けていた)
      db.prepare(`
        UPDATE case_preparation_items SET status='完了', completed_at=?
        WHERE case_id = ? AND status != '完了'
      `).run(now, req.params.id);
      db.prepare(`
        INSERT INTO delivery_records
          (case_id, delivered_date, delivery_method, delivered_by_staff_id, delivered_by_employee_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(req.params.id, delivered_date, delivery_method, delivered_by_staff_id || null, delivered_by_employee_id || null, now);
      db.prepare(`UPDATE projects SET status='COMPLETED', updated_at=? WHERE id=?`).run(now, req.params.id);
    })();
    // 納品処理をしたらデザイン進行ボードの段階を「納品」へ進める。
    // 完了(DONE)にはしない — 納品欄のチェックボックスで山本さんが締める運用のため
    markDeliveredStage(db, parseInt(req.params.id, 10));
    res.json({ message: 'Project marked as delivered' });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// 納品履歴一覧(新しい納品日順)。過去案件検索・リピート注文複製のため案件情報も返す
app.get('/api/delivery-records', (req, res) => {
  try {
    const records = db.prepare(`
      SELECT dr.*, p.project_name, p.customer_name, p.process_type, p.quantity, p.nas_folder_path,
        p.freee_quote_url, p.freee_invoice_url,
        s.name as delivered_by_staff_name, emp.name as delivered_by_employee_name
      FROM delivery_records dr
      JOIN projects p ON dr.case_id = p.id
      LEFT JOIN staff s ON dr.delivered_by_staff_id = s.id
      LEFT JOIN employees emp ON dr.delivered_by_employee_id = emp.id
      ORDER BY dr.delivered_date DESC, dr.id DESC
    `).all();
    res.json(records);
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// 案件のNASフォルダから書類(PDF・画像)を拾い、ファイル名から種類を推測して返す。
// 「指示書を見たい」ときにフォルダを掘らずに済むようにするのが目的。
// 案件フォルダの想定を超えて重くならないよう、深さ2・走査上限つきで打ち切る。
const DOCUMENT_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.webp'];
const DOCUMENT_SCAN_LIMIT = 600;   // 走査するエントリ数の上限
const DOCUMENT_RESULT_LIMIT = 40;  // 返す書類数の上限

function classifyDocument(fileName) {
  const name = fileName.toLowerCase();
  if (name.includes('指示書') || name.includes('instruction')) return 'instruction';
  if (name.includes('見積')) return 'quote';
  if (name.includes('請求')) return 'invoice';
  return 'other';
}

function collectCaseDocuments(folderPath) {
  const result = { documents: [], truncated: false };
  if (!folderPath) return result;

  const resolvedRoot = path.resolve(path.normalize(folderPath));
  if (!isWithinBase(resolvedRoot, NAS_BASE_PATH)) return result;
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) return result;

  let scanned = 0;
  const walk = (dir, depth) => {
    if (depth > 2 || scanned >= DOCUMENT_SCAN_LIMIT) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return; // 権限エラー等はその階層を諦めるだけにする
    }
    for (const entry of entries) {
      if (scanned >= DOCUMENT_SCAN_LIMIT) {
        result.truncated = true;
        return;
      }
      scanned++;
      if (entry.name.startsWith('._') || entry.name === '.DS_Store') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (DOCUMENT_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
        if (result.documents.length >= DOCUMENT_RESULT_LIMIT) {
          result.truncated = true;
          continue;
        }
        result.documents.push({
          name: entry.name,
          path: fullPath,
          kind: classifyDocument(entry.name),
        });
      }
    }
  };
  walk(resolvedRoot, 0);

  // 指示書 → 見積書 → 請求書 → その他 の順に並べ、同種内は名前順
  const kindOrder = { instruction: 0, quote: 1, invoice: 2, other: 3 };
  result.documents.sort((a, b) =>
    (kindOrder[a.kind] - kindOrder[b.kind]) || a.name.localeCompare(b.name, 'ja'));
  return result;
}

// 案件1件の詳細(加工内容・アイテム明細・プリント箇所・書類)をまとめて返す。
// 顧客台帳/納品履歴の「🔍 詳細」から、過去案件が何をどれだけ加工したのかを1画面で確認するために使う
app.get('/api/projects/:id/detail', (req, res) => {
  try {
    const project = db.prepare(`
      SELECT p.*, s.name AS assigned_staff_name, e.name AS assigned_employee_name
      FROM projects p
      LEFT JOIN staff s ON p.assigned_staff_id = s.id
      LEFT JOIN employees e ON p.assigned_employee_id = e.id
      WHERE p.id = ?
    `).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const printLocations = db.prepare(`
      SELECT id, case_item_id, location_name, color_count
      FROM case_print_locations WHERE case_id = ? ORDER BY id ASC
    `).all(project.id);

    // catalog_json / matrix_json は保存時にJSON文字列化されているので、ここで戻して返す
    const parseJson = (value, fallback) => {
      if (!value) return fallback;
      try { return JSON.parse(value); } catch (err) { return fallback; }
    };
    const items = db.prepare(`
      SELECT * FROM case_items WHERE case_id = ? ORDER BY item_no ASC, id ASC
    `).all(project.id).map(item => ({
      id: item.id,
      item_no: item.item_no,
      category: item.category,
      sub_category: item.sub_category,
      method: item.method,
      quantity_total: item.quantity_total,
      catalog_items: parseJson(item.catalog_json, []),
      matrix: parseJson(item.matrix_json, null),
      print_locations: printLocations.filter(l => l.case_item_id === item.id),
    }));

    const delivery = db.prepare(`
      SELECT dr.delivered_date, dr.delivery_method,
        s.name AS delivered_by_staff_name, emp.name AS delivered_by_employee_name
      FROM delivery_records dr
      LEFT JOIN staff s ON dr.delivered_by_staff_id = s.id
      LEFT JOIN employees emp ON dr.delivered_by_employee_id = emp.id
      WHERE dr.case_id = ?
      ORDER BY dr.delivered_date DESC, dr.id DESC LIMIT 1
    `).get(project.id) || null;

    const rosterCount = db.prepare('SELECT COUNT(*) AS c FROM case_roster WHERE case_id = ?')
      .get(project.id).c;

    const { documents, truncated } = collectCaseDocuments(project.nas_folder_path);

    // 見積シミュレーターで記録した概算の履歴(新しい順)。sheet_textは重いので一覧には返さない
    const quotes = db.prepare(`
      SELECT id, total, discount_name, approved_by, created_at
      FROM case_quotes WHERE case_id = ? ORDER BY id DESC
    `).all(project.id);

    res.json({
      project,
      items,
      // アイテムに紐づかない(レガシー/手動登録の)案件直下のプリント箇所
      print_locations: printLocations.filter(l => !l.case_item_id),
      roster_count: rosterCount,
      delivery,
      documents,
      documents_truncated: truncated,
      quotes,
    });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// ===== 顧客台帳 =====
// 顧客マスタは持たず、projects.customer_name(TRIM)でグルーピングした集計を返す。
// 社内デザイン案件と顧客名が空の案件は対象外。並びは直近の動き(納品日 or 受付日)が新しい順
app.get('/api/customers', (req, res) => {
  try {
    const customers = db.prepare(`
      SELECT TRIM(p.customer_name) AS customer_name,
        COUNT(*) AS project_count,
        SUM(CASE WHEN p.status = 'COMPLETED' THEN 1 ELSE 0 END) AS delivered_count,
        SUM(p.quantity) AS total_quantity,
        MIN(p.received_date) AS first_received_date,
        MAX(p.received_date) AS last_received_date,
        MAX(d.delivered_date) AS last_delivered_date,
        GROUP_CONCAT(p.process_type, ',') AS process_types,
        MAX(CASE WHEN n.id IS NOT NULL THEN 1 ELSE 0 END) AS has_note
      FROM projects p
      LEFT JOIN (
        SELECT case_id, MAX(delivered_date) AS delivered_date
        FROM delivery_records GROUP BY case_id
      ) d ON d.case_id = p.id
      LEFT JOIN customer_notes n ON n.customer_name = TRIM(p.customer_name)
      WHERE p.project_kind != 'INTERNAL_DESIGN' AND TRIM(p.customer_name) != ''
      GROUP BY TRIM(p.customer_name)
      ORDER BY COALESCE(MAX(d.delivered_date), MAX(p.received_date)) DESC
    `).all();
    res.json(customers);
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// 指定顧客の全案件(進行中含む)を新しい順で返す。納品日・Freeeリンク・NASパス込みで、
// 顧客詳細から納品履歴ページと同じ操作(フォルダ閲覧・Freee・再注文)ができるようにする
app.get('/api/customers/projects', (req, res) => {
  try {
    const name = (req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const projects = db.prepare(`
      SELECT p.id, p.project_name, p.received_date, p.deadline, p.customer_name,
        p.process_type, p.quantity, p.status, p.nas_folder_path,
        p.freee_quote_url, p.freee_invoice_url,
        d.delivered_date, d.delivery_method
      FROM projects p
      LEFT JOIN (
        SELECT case_id, MAX(delivered_date) AS delivered_date, delivery_method
        FROM delivery_records GROUP BY case_id
      ) d ON d.case_id = p.id
      WHERE p.project_kind != 'INTERNAL_DESIGN' AND TRIM(p.customer_name) = ?
      ORDER BY p.received_date DESC, p.id DESC
    `).all(name);
    res.json(projects);
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// 顧客メモの取得。未登録の顧客は null を返す(エラーにしない)
app.get('/api/customer-notes', (req, res) => {
  try {
    const name = (req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const note = db.prepare('SELECT * FROM customer_notes WHERE customer_name = ?').get(name);
    res.json(note || null);
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// 顧客メモの保存(顧客名キーのUPSERT)
app.put('/api/customer-notes', (req, res) => {
  try {
    const customer_name = (req.body.customer_name || '').trim();
    if (!customer_name) return res.status(400).json({ error: 'customer_name is required' });
    const { contact_person, contact_info, memo } = req.body;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO customer_notes (customer_name, contact_person, contact_info, memo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(customer_name) DO UPDATE SET
        contact_person = excluded.contact_person,
        contact_info = excluded.contact_info,
        memo = excluded.memo,
        updated_at = excluded.updated_at
    `).run(customer_name, contact_person || '', contact_info || '', memo || '', now, now);
    res.json({ message: 'Customer note saved successfully' });
  } catch (error) {
    sendServerError(res, req, error);
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
    item_name: src.item_name,
    design_planned_hours: src.design_planned_hours,
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
    sendServerError(res, req, error);
  }
});

// projects.id をFOREIGN KEYで参照している子テーブルは、親より先に消す必要がある
// (better-sqlite3はSQLite側でforeign_keys=ONがデフォルトのため、残っていると
//  FOREIGN KEY constraint failed になる)。トランザクションで子→親の順に削除する。
//
// 2026-07-28: case_items / case_roster / delivery_records の削除が漏れており、
// Web注文フォーム由来の案件(アイテム明細を持つ)や納品済みの案件を削除しようとすると
// 「サーバーエラーが発生しました」で失敗していた。参照している全テーブルを対象にする。
// ※ ai_extracted_intake.case_id はFOREIGN KEY宣言が無いため削除は妨げないが、
//    案件が消えた後も受注候補に紐づけが残らないようNULLに戻す
//    (お客様向け進捗確認ページが「受付済み」と表示できる状態にする)。
const deleteProjectCascade = db.transaction((projectId) => {
  db.prepare('DELETE FROM case_preparation_items WHERE case_id = ?').run(projectId);
  db.prepare('DELETE FROM case_time_allocations WHERE case_id = ?').run(projectId);
  // case_print_locations は case_item_id で case_items も参照するため、case_items より先に消す
  db.prepare('DELETE FROM case_print_locations WHERE case_id = ?').run(projectId);
  db.prepare('DELETE FROM case_items WHERE case_id = ?').run(projectId);
  db.prepare('DELETE FROM case_roster WHERE case_id = ?').run(projectId);
  db.prepare('DELETE FROM delivery_records WHERE case_id = ?').run(projectId);
  db.prepare('DELETE FROM case_quotes WHERE case_id = ?').run(projectId);
  db.prepare('UPDATE ai_extracted_intake SET case_id = NULL WHERE case_id = ?').run(projectId);
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
});

app.delete('/api/projects/:id', (req, res) => {
  try {
    deleteProjectCascade(req.params.id);
    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    sendServerError(res, req, error);
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
      ORDER BY CASE WHEN ai.triage_type IS NULL OR ai.triage_type = '' THEN 0 ELSE 1 END,
               ai.extracted_at DESC
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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
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
    // 対応するTODO行を完了にする(失敗しても登録処理には影響させない)
    completeIntakeTask(req.params.id, '登録');
    res.status(201).json({ id: projectId, message: 'Project created from intake successfully' });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// 振り分けを行う人の候補。案件担当者(staff)と従業員(employees)は別テーブルで、
// 三浦さんは staff 側・山本さんは employees 側にしかいないため、両方から名前を集めて重複を除く。
app.get('/api/triage-members', (req, res) => {
  try {
    const names = db.prepare(`
      SELECT name FROM staff WHERE is_active = 1
      UNION
      SELECT name FROM employees WHERE is_active = 1
      ORDER BY name ASC
    `).all().map(row => row.name).filter(Boolean);
    res.json(names);
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// 振り分け: 受注候補の行き先(生産 / デザイン進行ボード / 要相談)を記録する。
// 案件登録の前段で三浦・山本が「握った」ことを表す操作なので、status は pending のまま変えない。
// design で振り分けた候補は、確認モーダルで is_design_ops が既定ONになる(→ デザイン進行ボードへ載る)。
const TRIAGE_TYPES = new Set(['production', 'design', 'consult']);

app.post('/api/ai-intake/:id/triage', (req, res) => {
  try {
    const intake = db.prepare(`SELECT id FROM ai_extracted_intake WHERE id = ?`).get(req.params.id);
    if (!intake) return res.status(404).json({ error: 'Intake not found' });

    const { triage_type, triage_by } = req.body || {};
    // 空文字/null は「振り分けを取り消す(未振り分けに戻す)」
    const type = triage_type ? String(triage_type) : null;
    if (type && !TRIAGE_TYPES.has(type)) {
      return res.status(400).json({ error: '振り分け区分の値が不正です' });
    }

    db.prepare(`
      UPDATE ai_extracted_intake SET triage_type = ?, triage_by = ?, triage_at = ? WHERE id = ?
    `).run(
      type,
      type ? String(triage_by || '').slice(0, 50) || null : null,
      type ? new Date().toISOString() : null,
      req.params.id,
    );

    res.json({ ok: true, triage_type: type });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

app.post('/api/ai-intake/:id/reject', (req, res) => {
  try {
    const intake = db.prepare(`SELECT id FROM ai_extracted_intake WHERE id = ?`).get(req.params.id);
    if (!intake) return res.status(404).json({ error: 'Intake not found' });

    db.prepare(`UPDATE ai_extracted_intake SET status = 'rejected' WHERE id = ?`).run(req.params.id);
    // 対応するTODO行を完了にする(失敗しても却下処理には影響させない)
    completeIntakeTask(req.params.id, '却下');
    res.json({ message: 'Intake rejected' });
  } catch (error) {
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
  }
});

// apply_default_overhead: スケジュールボードの空きマスから手動登録する場合のみtrueで
// 送られてくるフラグ。案件詳細ページの「作業計画」からの登録(app.js)はこのフラグを
// 送らないため従来通りsetup_minutes/cleanup_minutes=0のままになる
app.post('/api/projects/:projectId/time-allocations', (req, res) => {
  try {
    const { employee_id, work_date, planned_hours, actual_hours, carried_over_from, status, apply_default_overhead } = req.body;

    // 最小バリデーション(2026-07-27): クライアントのバグで負の時間・不正日付・
    // 無効化済み従業員への割り当てがそのままDBに入るのを防ぐ
    const employeeId = asFiniteNumber(employee_id);
    if (!employeeId || !Number.isInteger(employeeId)) {
      return res.status(400).json({ error: 'employee_id が不正です' });
    }
    const employee = db.prepare('SELECT id, is_active FROM employees WHERE id = ?').get(employeeId);
    if (!employee) return res.status(404).json({ error: '従業員が見つかりません' });
    if (!employee.is_active) return res.status(400).json({ error: '無効化された従業員には割り当てできません' });
    if (!isValidDateStr(work_date)) {
      return res.status(400).json({ error: 'work_date はYYYY-MM-DD形式で指定してください' });
    }
    const plannedNum = asFiniteNumber(planned_hours);
    if (plannedNum === null || plannedNum <= 0 || plannedNum > 24) {
      return res.status(400).json({ error: 'planned_hours には0より大きく24以下の数値を指定してください' });
    }

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
    sendServerError(res, req, error);
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

    // 最小バリデーション(2026-07-27): 送られてきた項目のみチェック(未送信は既存値維持のため対象外)
    if (req.body.work_date !== undefined && !isValidDateStr(work_date)) {
      return res.status(400).json({ error: 'work_date はYYYY-MM-DD形式で指定してください' });
    }
    if (req.body.planned_hours !== undefined) {
      const plannedNum = asFiniteNumber(planned_hours);
      if (plannedNum === null || plannedNum <= 0 || plannedNum > 24) {
        return res.status(400).json({ error: 'planned_hours には0より大きく24以下の数値を指定してください' });
      }
    }
    if (req.body.employee_id !== undefined && employee_id !== existing.employee_id) {
      const targetEmployee = db.prepare('SELECT id, is_active FROM employees WHERE id = ?').get(employee_id);
      if (!targetEmployee) return res.status(404).json({ error: '従業員が見つかりません' });
      if (!targetEmployee.is_active) return res.status(400).json({ error: '無効化された従業員には割り当てできません' });
    }
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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
  }
});

// 案件をボードから外して提案確認パネルへ戻す(ブロックをパネルへドラッグしたとき)。
// その案件の割り当てを status を問わず全件削除し、担当者を未割り当てに戻す。
// case_time_allocations が0件になることで /api/proposals の「担当者未定」カードとして
// 再びパネルに出る。DELETE /api/time-allocations/:id と違い自動再提案はしない
// (利用者が意図してボードから外したのに、すぐ別の日へ再配置されると戻したことにならないため)
app.post('/api/projects/:id/unschedule', (req, res) => {
  try {
    const project = db.prepare('SELECT id, project_name FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: '案件が見つかりません' });

    const removed = db.prepare('DELETE FROM case_time_allocations WHERE case_id = ?').run(project.id).changes;
    db.prepare('UPDATE projects SET assigned_employee_id = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), project.id);

    console.log(`[予定から外す] 案件#${project.id}「${project.project_name}」の割り当て${removed}件を削除し提案確認へ戻しました`);
    res.json({ id: project.id, removed_count: removed });
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
    // is_design_work: 「デザインが絡む案件」の判定に使う項目かどうか。
    // 画面側(入稿納期の必須チェック)がサーバーと同じ条件で判定できるように付けて返す
    res.json(items.map(item => ({
      ...item,
      is_design_work: DESIGN_WORK_ITEM_CODES.includes(item.code) ? 1 : 0,
    })));
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// デザイン作業の自動割り当て先。有効なデザイナーリンクに紐づく従業員を返す(いなければnull)。
// 複数リンクがある場合は最初に発行されたリンクを既定のデザイン担当とみなす
function getDefaultDesignerEmployeeId() {
  const link = db.prepare(`
    SELECT dl.employee_id FROM designer_links dl
    JOIN employees e ON dl.employee_id = e.id
    WHERE dl.disabled_at IS NULL AND e.is_active = 1
    ORDER BY dl.created_at ASC LIMIT 1
  `).get();
  return link ? link.employee_id : null;
}

// 案件作成・編集時に選択した準備項目をまとめて登録(既に登録済みの項目はスキップ = 冪等)。
// デザイン担当者への自動割り当て(2026-07-27 社長指示の設計):
//  - 社内デザイン案件(INTERNAL_DESIGN) → 全項目
//  - 通常案件 → デザイン担当者の専用項目(is_designer_item=1)のみ
//  - どちらの場合も NON_DESIGNER_ITEM_CODES(DTFデータ作成・作業指示書作成・見積書作成)は渡さない
// いずれも予定日は空のまま = 本人のマイスケジュールボード「日付が未定のタスク」に入り、
// 日付の入れ込みは本人がD&Dで行う
// 準備項目を登録し、デザイン案件ならデザイン担当へ割り当てる本体。
// 「デザイン進行ボードで管理する」案件と社内デザイン案件は、
// 準備項目を1つも選ばなくても・担当者を決めていなくても、
// 鈴木さんのマイスケジュールボードに必ずタスクが出るようにする(2026-08-03 社長指示)。
function registerPreparationItems(caseId, preparationItemIds = []) {
  const project = db.prepare(
    'SELECT project_kind, is_design_ops, ops_flow FROM projects WHERE id = ?'
  ).get(caseId);
  if (!project) return { created: 0, assignedToDesigner: 0 };

  const isInternalDesign = project.project_kind === 'INTERNAL_DESIGN';
  const isDesignOps = project.is_design_ops === 1;
  const designerEmployeeId = getDefaultDesignerEmployeeId();
  const existingIds = new Set(
    db.prepare('SELECT preparation_item_id FROM case_preparation_items WHERE case_id = ?')
      .all(caseId).map(row => row.preparation_item_id)
  );
  const insertStmt = db.prepare(`
    INSERT INTO case_preparation_items (case_id, preparation_item_id, status, assigned_staff_id)
    VALUES (?, ?, '未着手', ?)
  `);
  const itemIdByCode = code => {
    const row = db.prepare('SELECT id FROM preparation_item_master WHERE code = ?').get(code);
    return row ? row.id : null;
  };

  const targetItemIds = [...preparationItemIds];
  const pushIfMissing = (id, why) => {
    if (id && !targetItemIds.includes(id)) {
      targetItemIds.push(id);
      console.log(`[準備項目] 案件#${caseId}: ${why}`);
    }
  };

  // デザインが絡む案件には「初校提出」を必ず持たせる。
  // これが無いと ②制作 → ③確認 の自動遷移が起きず、案件が制作段階に居座り続ける。
  //
  // 「デザインが絡む」の判定に使うのは DESIGN_WORK_ITEM_CODES(実際にデザインを起こす作業)だけ。
  // デザイン担当へ自動で割り当てる項目(is_designer_item)より狭くしているのは、
  // 加工だけの追加注文で選ばれがちな事務作業まで初校提出の引き金にしないため(2026-08-19)
  const designerItemIds = new Set(
    db.prepare('SELECT id FROM preparation_item_master WHERE is_designer_item = 1').all().map(r => r.id)
  );
  const designWorkItemIds = new Set(
    db.prepare(
      `SELECT id FROM preparation_item_master WHERE code IN (${DESIGN_WORK_ITEM_CODES.map(() => '?').join(',')})`
    ).all(...DESIGN_WORK_ITEM_CODES).map(r => r.id)
  );
  // デザイン担当の担当から外した項目。社内デザイン案件・デザイン進行ボード案件の
  // 「全項目まとめて割り当て」からも除外する(2026-08-19)
  const nonDesignerItemIds = new Set(
    db.prepare(
      `SELECT id FROM preparation_item_master WHERE code IN (${NON_DESIGNER_ITEM_CODES.map(() => '?').join(',')})`
    ).all(...NON_DESIGNER_ITEM_CODES).map(r => r.id)
  );
  const hasDesignWork = isInternalDesign || isDesignOps
    || preparationItemIds.some(id => designWorkItemIds.has(id));
  if (hasDesignWork) {
    pushIfMissing(itemIdByCode('FIRST_DRAFT_SUBMIT'), 'デザイン案件のため「初校提出」を自動追加しました');
  }
  // 紙媒体(入稿で完了)タイプには「入稿完了」も足す。完了で案件が「請求」へ進む
  if (isDesignOps && project.ops_flow === 'SUBMIT_END') {
    pushIfMissing(itemIdByCode('SUBMISSION_COMPLETE'), '入稿で完了タイプのため「入稿完了」を自動追加しました');
  }

  let created = 0;
  let assignedToDesigner = 0;
  targetItemIds.forEach(itemId => {
    if (existingIds.has(itemId)) return;
    // デザイン進行ボード・社内デザイン案件は全項目をデザイン担当へ。
    // 通常案件はデザイン担当専用項目だけを渡す(従来どおり)
    const toDesigner = designerEmployeeId
      && !nonDesignerItemIds.has(itemId)
      && (isDesignOps || isInternalDesign || designerItemIds.has(itemId));
    insertStmt.run(caseId, itemId, toDesigner ? designerEmployeeId : null);
    created++;
    if (toDesigner) assignedToDesigner++;
  });

  // 既に登録済みの項目も、デザイン案件なら担当が空のものをデザイン担当へ寄せる
  // (あとから「デザイン進行ボード」に切り替えた案件を拾うため)。
  // ただしデザイン担当本人が「自分の担当ではない」として外した項目は寄せ直さない —
  // 案件を編集するたびに本人のボードへ戻ってしまい、外す操作が意味を成さなくなるため
  if (designerEmployeeId && (isDesignOps || isInternalDesign)) {
    const moved = db.prepare(`
      UPDATE case_preparation_items SET assigned_staff_id = ?
      WHERE case_id = ? AND assigned_staff_id IS NULL AND status != '完了'
        AND designer_released_at IS NULL
        AND preparation_item_id NOT IN (
          SELECT id FROM preparation_item_master
          WHERE code IN (${NON_DESIGNER_ITEM_CODES.map(() => '?').join(',')})
        )
    `).run(designerEmployeeId, caseId, ...NON_DESIGNER_ITEM_CODES);
    assignedToDesigner += moved.changes;
  }

  if (assignedToDesigner > 0) {
    console.log(`[準備項目] 案件#${caseId}: ${assignedToDesigner}件をデザイン担当(従業員#${designerEmployeeId})へ割り当て`);
  }
  return { created, assignedToDesigner };
}

app.post('/api/projects/:projectId/preparation-items', (req, res) => {
  try {
    const { preparation_item_ids } = req.body;
    if (!Array.isArray(preparation_item_ids)) {
      return res.status(400).json({ error: 'preparation_item_ids は配列で指定してください' });
    }
    const result = registerPreparationItems(req.params.projectId, preparation_item_ids);
    res.status(201).json({ created: result.created, message: 'Preparation items registered successfully' });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// デザイナーの日別モード申告(デザイン/デザイン関連業務)の週分取得。
// 週間スケジュールボードが従業員セルにバッジ表示するために使う(閲覧のみ・設定は本人の専用ボードから)
app.get('/api/designer-day-modes', (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start と end を指定してください' });
    const rows = db.prepare(`
      SELECT employee_id, work_date, mode FROM designer_day_modes WHERE work_date BETWEEN ? AND ?
    `).all(start, end);
    res.json(rows);
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// スケジュールボード表示用・案件詳細表示用の準備項目タスク取得
// クエリ: case_id / start+end / date / staff_id / unassigned=true をそれぞれ任意で組み合わせ可能
app.get('/api/preparation-items', (req, res) => {
  try {
    const { case_id, start, end, date, staff_id, unassigned, overdue_before } = req.query;
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
    // 繰り越し: 指定日より前に予定されていて、まだ完了していない準備項目。
    // 週間スケジュールボードは表示中の週のぶんしか取得しないため、前週までに終わらなかった
    // 項目が準備項目リストから消えてしまっていた。その取りこぼしを拾うための条件
    // 納品済み案件の項目は納品時に完了扱いにしているので通常はここに来ないが、
    // 万一残っていても繰り越しには混ぜない(納品したものは持ち越さない)
    if (overdue_before) {
      conditions.push(`cpi.scheduled_date IS NOT NULL AND cpi.scheduled_date < ? AND cpi.status != '完了' AND p.status != 'COMPLETED'`);
      params.push(overdue_before);
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
    // work_state はコード(WORKING等)で持っているので、画面がそのまま出せる日本語も付ける。
    // 表示名の対応表を画面側に書くと lib/prep-items.js と二重管理になるため
    res.json(items.map(i => ({ ...i, work_state_label: WORK_STATE_LABELS[i.work_state] || '' })));
  } catch (error) {
    sendServerError(res, req, error);
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

    // 誰かに割り当て直したら「デザイン担当が外した」記録は消す。
    // 三浦さんが改めて担当を決めた時点で、その項目は通常の割り当てとして扱ってよい
    const designerReleasedAt = assigned_staff_id ? null : existing.designer_released_at;

    db.prepare(`
      UPDATE case_preparation_items SET
        assigned_staff_id=?, scheduled_date=?, estimated_hours=?, status=?, completed_at=?,
        designer_released_at=?
      WHERE id=?
    `).run(assigned_staff_id || null, scheduled_date || null, estimated_hours, status, completed_at,
      designerReleasedAt, req.params.id);

    // 予定日の変更を履歴に残す(業務量レポート /workload の元データ)。
    // 社内の週間スケジュールボードから動かした分もここで拾わないと、
    // 「マイスケジュールボードで動かしたときだけ記録される」偏った集計になる。
    // 担当者が変わった場合は業務量の持ち越しではなく担当替えなので記録しない
    const sameStaff = (assigned_staff_id || null) === existing.assigned_staff_id;
    if (sameStaff && existing.assigned_staff_id
        && (scheduled_date || null) !== existing.scheduled_date && status !== '完了') {
      const prepItem = db.prepare(`
        SELECT pim.name FROM case_preparation_items cpi
        JOIN preparation_item_master pim ON cpi.preparation_item_id = pim.id
        WHERE cpi.id = ?
      `).get(req.params.id);
      recordTaskMove(db, {
        employeeId: existing.assigned_staff_id,
        taskKind: TASK_KINDS.PREP_ITEM,
        prepItemId: Number(req.params.id),
        taskLabel: prepItem ? prepItem.name : '準備項目',
        fromDate: existing.scheduled_date,
        toDate: scheduled_date || null,
        estimatedHours: estimated_hours,
      });
    }

    if (status !== existing.status) {
      syncCaseStatusForPreparationItems(existing.case_id);
    }
    res.json({ message: 'Preparation item updated successfully' });
  } catch (error) {
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
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
// 日本の祝日一覧(スケジュールボードの表示用)。データはlib/jp-holidays.jsの静的テーブル
app.get('/api/holidays', (req, res) => {
  res.json(HOLIDAYS);
});

app.get('/api/schedule-overrides', (req, res) => {
  try {
    // start/end(YYYY-MM-DD)を渡すと期間で絞り込める。未指定時は従来どおり全件(後方互換)
    const { start, end } = req.query;
    if (isValidDateStr(start) && isValidDateStr(end)) {
      const overrides = db.prepare(`
        SELECT * FROM schedule_overrides WHERE work_date BETWEEN ? AND ?
        ORDER BY employee_id ASC, work_date ASC
      `).all(start, end);
      return res.json(overrides);
    }
    const overrides = db.prepare(`
      SELECT * FROM schedule_overrides ORDER BY employee_id ASC, work_date ASC
    `).all();
    res.json(overrides);
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// 勤務時間(override)の入力チェック。POST/PUT共通。エラー文字列 or null を返す
function validateOverridePayload({ work_date, start_time, end_time, break_minutes, is_day_off, reserved_hours }, { requireDate }) {
  if (requireDate && !isValidDateStr(work_date)) return 'work_date はYYYY-MM-DD形式で指定してください';
  if (start_time != null && !isValidTimeStr(start_time)) return 'start_time はHH:MM形式で指定してください';
  if (end_time != null && !isValidTimeStr(end_time)) return 'end_time はHH:MM形式で指定してください';
  if (!is_day_off && start_time && end_time && start_time >= end_time) return '終了時刻は開始時刻より後にしてください';
  const bm = asFiniteNumber(break_minutes ?? 0);
  if (bm === null || bm < 0 || bm > 24 * 60) return 'break_minutes が不正です';
  const rh = asFiniteNumber(reserved_hours ?? 0);
  if (rh === null || rh < 0 || rh > 24) return 'reserved_hours が不正です';
  return null;
}

app.post('/api/schedule-overrides', (req, res) => {
  try {
    const { employee_id, work_date, start_time, end_time, break_minutes, is_day_off, reserved_hours } = req.body;
    const employeeId = asFiniteNumber(employee_id);
    if (!employeeId || !Number.isInteger(employeeId)) {
      return res.status(400).json({ error: 'employee_id が不正です' });
    }
    if (!db.prepare('SELECT id FROM employees WHERE id = ?').get(employeeId)) {
      return res.status(404).json({ error: '従業員が見つかりません' });
    }
    const validationError = validateOverridePayload(req.body, { requireDate: true });
    if (validationError) return res.status(400).json({ error: validationError });

    // 同一従業員×同一日はUPSERT(2026-07-27)。以前は2人が同時に同じ日を開くと重複行が
    // 生まれ、空き時間計算がどちらの勤務時間を使うか不定になっていた。
    // work_segments(マイスケジュールボードで申告された中抜けの内訳)はこの画面が
    // 開始〜終了の1本しか扱わないため、社内側で保存し直したらクリアする —
    // 残すと画面の入力値と内訳表示が食い違う。本人のメモ(note)は申し送りなので消さない
    db.prepare(`
      INSERT INTO schedule_overrides (employee_id, work_date, start_time, end_time, break_minutes, is_day_off, reserved_hours, work_segments)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(employee_id, work_date) DO UPDATE SET
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        break_minutes = excluded.break_minutes,
        is_day_off = excluded.is_day_off,
        reserved_hours = excluded.reserved_hours,
        work_segments = NULL
    `).run(employeeId, work_date, start_time || null, end_time || null, break_minutes || 0, is_day_off ? 1 : 0, reserved_hours || 0);
    const row = db.prepare('SELECT id FROM schedule_overrides WHERE employee_id = ? AND work_date = ?').get(employeeId, work_date);
    res.status(201).json({ id: row.id, message: 'Schedule override created successfully' });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

app.put('/api/schedule-overrides/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM schedule_overrides WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: '勤務時間の記録が見つかりません(別の端末で削除された可能性があります)' });
    const { start_time, end_time, break_minutes, is_day_off, reserved_hours } = req.body;
    const validationError = validateOverridePayload(req.body, { requireDate: false });
    if (validationError) return res.status(400).json({ error: validationError });
    // POSTと同じ理由で、社内側から保存し直したら中抜けの内訳はクリアする(メモは残す)
    db.prepare(`
      UPDATE schedule_overrides SET start_time=?, end_time=?, break_minutes=?, is_day_off=?, reserved_hours=?, work_segments=NULL WHERE id=?
    `).run(start_time || null, end_time || null, break_minutes || 0, is_day_off ? 1 : 0, reserved_hours || 0, req.params.id);
    res.json({ message: 'Schedule override updated successfully' });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

app.delete('/api/schedule-overrides/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM schedule_overrides WHERE id = ?').run(req.params.id);
    res.json({ message: 'Schedule override deleted successfully' });
  } catch (error) {
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
  }
});

app.get('/api/staff', (req, res) => {
  try {
    const staff = db.prepare('SELECT * FROM staff WHERE is_active = 1 ORDER BY id ASC').all();
    res.json(staff);
  } catch (error) {
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
  }
});

app.delete('/api/staff/:id', (req, res) => {
  try {
    const now = new Date().toISOString();
    db.prepare('UPDATE staff SET is_active = 0, updated_at = ? WHERE id = ?').run(now, req.params.id);
    res.json({ message: 'Staff deleted successfully' });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

// ===== 従業員関連 =====

app.get('/employees', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'employees.html'));
});

app.get('/customers', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'customers.html'));
});

app.get('/delivery-history', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'delivery-history.html'));
});

// 見積シミュレーター(社内用。料金表全表+割引プリセット+freee連携コピー)。
// 社内画面なので外部公開ガードの許可リストには載せない(公開ドメインでは404になる)
app.get('/quote-sim', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quote-sim.html'));
});

// 社員向けの使い方ガイド(業務フロー順のマニュアル。印刷でA4配布資料にもなる)
app.get('/manual', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manual.html'));
});

// バックアップ状態の確認画面。社内画面なので外部公開ガードで自動的に404になる
app.get('/backup-status', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'backup-status.html'));
});

// 保存先ごとの実状態を返す。保存先がNAS・共有ドライブの場合、
// 切断されていると fs の呼び出しに数秒かかることがあるが、
// 画面を開いたときだけ実行されるので業務処理には影響しない。
app.get('/api/backup-status', (req, res) => {
  try {
    res.json(getBackupStatus());
  } catch (error) {
    sendServerError(res, req, error);
  }
});

app.get('/api/employees', (req, res) => {
  try {
    const employees = db.prepare('SELECT * FROM employees ORDER BY id ASC').all();
    res.json(employees);
  } catch (error) {
    sendServerError(res, req, error);
  }
});

app.get('/api/employees/:id', (req, res) => {
  try {
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    res.json(employee);
  } catch (error) {
    sendServerError(res, req, error);
  }
});

app.post('/api/employees', (req, res) => {
  try {
    const { name, role, is_active, skill_tags } = req.body;
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: '氏名を入力してください' });
    }
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO employees (name, role, is_active, skill_tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name.trim(), role, is_active === false ? 0 : 1, skill_tags || null, now, now);
    res.status(201).json({ id: result.lastInsertRowid, message: 'Employee created successfully' });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

app.put('/api/employees/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Employee not found' });

    // 送信されなかった項目は既存値を維持する(time-allocationsのPUTと同じ方式)。
    // 以前は「有効にする」ボタンがname/role/is_activeしか送らないため、
    // skill_tags(得意加工)がNULLで上書きされ、自動割当の候補から実質外れてしまっていた
    const name = req.body.name !== undefined ? req.body.name : existing.name;
    const role = req.body.role !== undefined ? req.body.role : existing.role;
    const isActive = req.body.is_active !== undefined ? (req.body.is_active === false ? 0 : 1) : existing.is_active;
    const skillTags = req.body.skill_tags !== undefined ? (req.body.skill_tags || null) : existing.skill_tags;
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: '氏名を入力してください' });
    }
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE employees SET name=?, role=?, is_active=?, skill_tags=?, updated_at=? WHERE id=?
    `).run(name.trim(), role, isActive, skillTags, now, req.params.id);
    res.json({ message: 'Employee updated successfully' });
  } catch (error) {
    sendServerError(res, req, error);
  }
});

app.delete('/api/employees/:id', (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    // 無効化前に、この従業員に紐づく「今後の予定」を確認する(2026-07-27)。
    // 以前は無効化すると表示行ごとボードから消え、載っていた作業計画が誰の目にも
    // 入らなくなっていた(DBには残る=事実上の孤児レコード)。
    const today = localTodayStr();
    const futureAllocations = db.prepare(`
      SELECT COUNT(*) AS c FROM case_time_allocations
      WHERE employee_id = ? AND work_date >= ? AND status != '実績確定'
    `).get(employeeId, today).c;
    const assignedPrepItems = db.prepare(`
      SELECT COUNT(*) AS c FROM case_preparation_items
      WHERE assigned_staff_id = ? AND status != '完了'
    `).get(employeeId).c;
    const assignedProjects = db.prepare(`
      SELECT COUNT(*) AS c FROM projects
      WHERE assigned_employee_id = ? AND status != 'COMPLETED'
    `).get(employeeId).c;

    const hasFutureWork = futureAllocations > 0 || assignedPrepItems > 0 || assignedProjects > 0;
    if (hasFutureWork && req.query.force !== '1') {
      // クライアントはこの409を受けて確認ダイアログを出し、了承されたら force=1 で再送する
      return res.status(409).json({
        error: 'この従業員には今後の予定が残っています',
        details: {
          future_allocations: futureAllocations,
          assigned_prep_items: assignedPrepItems,
          assigned_projects: assignedProjects,
        },
      });
    }

    const now = new Date().toISOString();
    db.transaction(() => {
      if (hasFutureWork) {
        // 今後の作業計画は削除して案件を未割り当てに戻す(提案パネルに再表示され、
        // 自動割当や手動で別の担当者に割り当て直せる)。過去の実績は履歴として残す
        db.prepare(`
          DELETE FROM case_time_allocations
          WHERE employee_id = ? AND work_date >= ? AND status != '実績確定'
        `).run(employeeId, today);
        db.prepare(`
          UPDATE projects SET assigned_employee_id = NULL, updated_at = ?
          WHERE assigned_employee_id = ? AND status != 'COMPLETED'
        `).run(now, employeeId);
        db.prepare(`
          UPDATE case_preparation_items SET assigned_staff_id = NULL, scheduled_date = NULL
          WHERE assigned_staff_id = ? AND status != '完了'
        `).run(employeeId);
      }
      db.prepare('UPDATE employees SET is_active = 0, updated_at = ? WHERE id = ?').run(now, employeeId);
    })();

    if (hasFutureWork) {
      writeDebugLog(
        `[employees DEACTIVATE] employee=${employeeId}(${employee.name}) を無効化。` +
        `今後の作業計画${futureAllocations}件を削除、未完了準備項目${assignedPrepItems}件と` +
        `担当中案件${assignedProjects}件を未割り当てに戻した`
      );
    }
    res.json({ message: 'Employee deactivated successfully', released: hasFutureWork });
  } catch (error) {
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
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
    sendServerError(res, req, error);
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

// 取引先向け 納期確認ページ(専用URL /partner/{token} + 管理画面 /partner-links)。
// 閲覧専用。案件との紐付けは顧客名の部分一致パターンで自動判定。
registerPartnerPortalRoutes(app, db);

// 取引先向け 加工依頼フォーム(公開フォーム /partner/{token}/order)。
// 着地は ai_extracted_intake(line_user_id='PARTNER'、受付番号 P-{id})。
registerPartnerOrderRoutes(app, db);

// デザイナー向け マイスケジュールボード(専用URL /designer/{token} + 管理画面 /designer-links)。
// リモートのデザイン担当が自分の準備項目をD&Dで日付調整・完了操作・稼働申告できる。
registerDesignerBoardRoutes(app, db, { syncCaseStatus: syncCaseStatusForPreparationItems });
registerOrderStatusRoutes(app, db);

// 業務量レポート /workload(社内専用)。マイスケジュールボードの予定日変更の履歴から、
// 日別に 計画 / 完了 / 持ち越し を出して「その日の業務量が適正だったか」を確かめる
registerWorkloadReportRoutes(app, db);

// オペレーション担当(山本さん)向けボード /ops。デザイン案件が「いま誰待ちで止まっているか」を
// 5段階で管理し、デザインラフの受け渡しもここで行う。社内専用(外部公開ガードの許可対象外)
registerOpsBoardRoutes(app, db, { registerPreparationItems });

// 紹介キャンペーン(非公開ページ /referral + 社内の発行画面 /referral-admin)。
// 会社が発行した紹介コードを入力した人だけが、自分の特典・共有用リンクを見られる。
registerReferralRoutes(app, db);
registerWorksRoutes(app);

// メール・電話で受けた注文の受け口(社内画面から使う)。
// 着地は ai_extracted_intake(line_user_id='MAIL' 受付 M-{id} / 'PHONE' 受付 D-{id})。
// フォーム以外の注文も同じ振り分けデスクを通すために追加した。
registerManualIntakeRoutes(app, db);

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
  // 外部公開ガードの設定内容。設定漏れ・想定違いに起動時点で気づけるようにする
  if (EXTERNAL_GUARD_DISABLED) {
    console.log('外部公開ガード: 無効(.env の EXTERNAL_GUARD=off)。全ホスト名で全機能が見えます');
  } else if (PUBLIC_HOSTNAMES.size === 0) {
    console.log('外部公開ガード: 公開ホスト名が未設定です。お客様に配っているドメインを .env の PUBLIC_HOSTNAMES に設定してください');
  } else {
    console.log(`外部公開ガード: 次のホスト名では公開ページのみ許可 → ${[...PUBLIC_HOSTNAMES].join(', ')}`);
    console.log('  (これ以外のホスト名・LAN内のIP直打ちは全機能を利用できます)');
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