/**
 * 制作実績の公開モジュール
 *
 * HiBoard の「実績登録」画面から受け取った写真と入力内容を、
 * コーポレートサイト（別リポジトリ）へ反映する。
 *
 *   写真 → 補正(sharp) → webp
 *   入力 → Markdown
 *   まとめて GitHub の hiyoshi-web リポジトリへコミット
 *   → GitHub Actions がビルドして Cloudflare Pages へ公開する
 *
 * 必要な .env 設定:
 *   WORKS_GITHUB_TOKEN=ghp_xxx   hiyoshi-web の Contents:write 権限だけを持つトークン
 *   WORKS_GITHUB_REPO=kubota-a11y/hiyoshi-web   (省略時はこの値)
 *   WORKS_GITHUB_BRANCH=main                    (省略時は main)
 *
 * トークン未設定の環境（開発機など）では isWorksPublishConfigured() が false になり、
 * 画面から設定不足であることが分かるようにしている。
 */
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const REPO = process.env.WORKS_GITHUB_REPO || 'kubota-a11y/hiyoshi-web';
const BRANCH = process.env.WORKS_GITHUB_BRANCH || 'main';
const TOKEN = () => process.env.WORKS_GITHUB_TOKEN || '';

// ---- 写真の補正値（サイト側 scripts/photo.mjs と同一。変更時は両方直すこと）----
const WIDTH = 1400;
const WB_STRENGTH = 0.75;
const CONTRAST = 1.10;
const SATURATION = 1.16;
const TARGET_BRIGHTNESS = 126;

// ---- 入力の選択肢（画面と共用）----
const POSITIONS = ['左胸', '右胸', 'フロント', '背面', '袖', '裾', 'フード', 'その他'];
const METHODS = ['DTFプリント', 'シルクプリント', '刺繍', 'ラバー転写', 'カッティング', '昇華'];
const CATEGORIES = [
  { key: 'team', label: 'チーム・クラブ' },
  { key: 'class-t', label: 'クラスT・部活T' },
  { key: 'corporate', label: '法人・店舗' },
  { key: 'event', label: 'イベント・記念品' },
];

function isWorksPublishConfigured() {
  return Boolean(TOKEN());
}

/**
 * 設定が読めない原因を切り分けるための情報。
 * ★トークンの値は絶対に返さない。有無・文字数・キー名だけを扱う。
 */
function configDiagnostics() {
  const key = 'WORKS_GITHUB_TOKEN';
  const raw = process.env[key];
  const cwd = process.cwd();
  // 似た名前のキーを拾う（打ち間違いを見つけるため）。名前のみで値は含めない
  const similar = Object.keys(process.env)
    .filter((k) => k !== key && /WORKS|GITHUB/i.test(k));
  return {
    keyPresent: Object.prototype.hasOwnProperty.call(process.env, key),
    length: raw ? String(raw).length : 0,
    looksLikeToken: raw ? /^(github_pat_|ghp_)/.test(String(raw).trim()) : false,
    hasSpaces: raw ? /^\s|\s$/.test(String(raw)) : false,
    hasQuotes: raw ? /^['"]|['"]$/.test(String(raw).trim()) : false,
    cwd,
    envFileFound: fs.existsSync(path.join(cwd, '.env')),
    similarKeys: similar,
  };
}

/** グレーワールド仮定でチャンネルごとのゲインを求める */
async function wbGains(sharp, buf, strength) {
  const s = await sharp(buf).rotate().stats();
  const m = s.channels.slice(0, 3).map((c) => c.mean);
  const t = (m[0] + m[1] + m[2]) / 3;
  return m.map((v) => Math.pow(t / v, strength));
}

async function renderOnce(sharp, buf, gains, brightness) {
  const off = 128 * (1 - CONTRAST);
  const out = await sharp(buf)
    .rotate() // スマホ写真のEXIF回転を適用（忘れると横倒しになる）
    .resize({ width: WIDTH, withoutEnlargement: true })
    .linear(gains.map((g) => g * CONTRAST), [off, off, off])
    .modulate({ brightness, saturation: SATURATION })
    .webp({ quality: 82 })
    .toBuffer();
  const st = await sharp(out).stats();
  const c = st.channels.slice(0, 3).map((x) => x.mean);
  return { out, brightness: (c[0] + c[1] + c[2]) / 3 };
}

/**
 * 写真を補正して webp のバッファを返す。
 * 明るさは仕上がりが TARGET_BRIGHTNESS に近づくよう二分探索で自動調整する
 * （写真ごとの暗さの差を吸収し、並べたときにトーンが揃うようにするため）。
 */
async function correctPhoto(buffer) {
  const sharp = require('sharp');
  const gains = await wbGains(sharp, buffer, WB_STRENGTH);
  let lo = 0.9, hi = 2.2, best = null;
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    const r = await renderOnce(sharp, buffer, gains, mid);
    if (!best || Math.abs(r.brightness - TARGET_BRIGHTNESS) < Math.abs(best.brightness - TARGET_BRIGHTNESS)) {
      best = r;
    }
    if (r.brightness < TARGET_BRIGHTNESS) lo = mid; else hi = mid;
  }
  return best;
}

// ---- 入力値の整形 ----

/** ファイル名やURLに使える英数字のスラッグを作る */
function slugify(s, fallback) {
  const base = String(s || '')
    .normalize('NFKC')
    .replace(/様$/, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')   // 日本語や記号は落ちる
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return base || fallback;
}

/** YAMLの文字列として安全な形にする（"と\をエスケープ） */
function yamlStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 取引先名の末尾に「様」を付ける（既に付いていれば何もしない） */
function withHonorific(name) {
  const s = String(name || '').trim();
  if (!s) return s;
  return /(様|御中)$/.test(s) ? s : `${s}様`;
}

// ---- GitHub API ----

async function gh(pathname, options = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'HiBoard-works-publish',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitHub API ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

/**
 * 複数ファイルを1コミットでまとめて追加する。
 * （ファイルごとに commit すると履歴が汚れ、Actionsも複数回動いてしまうため）
 */
async function commitFiles(files, message) {
  const ref = await gh(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const baseSha = ref.object.sha;
  const baseCommit = await gh(`/repos/${REPO}/git/commits/${baseSha}`);

  const tree = [];
  for (const f of files) {
    const blob = await gh(`/repos/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({
        content: f.buffer ? f.buffer.toString('base64') : Buffer.from(f.content, 'utf8').toString('base64'),
        encoding: 'base64',
      }),
    });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await gh(`/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  });
  const commit = await gh(`/repos/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [baseSha] }),
  });
  await gh(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha }),
  });
  return commit.sha;
}

// ---- ルート登録 ----

function registerWorksRoutes(app) {
  // 実績登録画面（社内画面。外部公開ガードの許可リストに入れていないので社外からは404）
  app.get('/works-add', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'works-add.html'));
  });

  // 画面が使う選択肢と設定状況
  app.get('/api/works/meta', (req, res) => {
    res.json({
      positions: POSITIONS,
      methods: METHODS,
      categories: CATEGORIES,
      configured: isWorksPublishConfigured(),
      repo: REPO,
      diag: configDiagnostics(),
    });
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      if (/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.mimetype)) return cb(null, true);
      cb(new Error('画像ファイル（JPEG/PNG/WebP）を選んでください'));
    },
  });

  app.post('/api/works/publish', (req, res) => {
    upload.single('photo')(req, res, async (uploadErr) => {
      try {
        if (uploadErr) return res.status(400).json({ error: uploadErr.message });
        if (!isWorksPublishConfigured()) {
          return res.status(503).json({ error: 'GitHubトークンが未設定です（.env の WORKS_GITHUB_TOKEN）' });
        }
        if (!req.file) return res.status(400).json({ error: '写真を選んでください' });

        const client = withHonorific(req.body.client);
        const title = String(req.body.title || '').trim();
        const method = String(req.body.method || '').trim();
        const category = String(req.body.category || '').trim();
        const permission = String(req.body.permission || '').trim();

        if (!client) return res.status(400).json({ error: '取引先を入力してください' });
        if (!title) return res.status(400).json({ error: '内容を入力してください' });
        if (!method) return res.status(400).json({ error: '加工内容を1つ以上追加してください' });
        if (!CATEGORIES.some((c) => c.key === category)) {
          return res.status(400).json({ error: 'カテゴリを選んでください' });
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(permission)) {
          return res.status(400).json({ error: '掲載許可の確認にチェックを入れてください' });
        }

        // 掲載時期。未指定なら今日の年月
        const now = new Date();
        const date = /^\d{4}-\d{2}$/.test(req.body.date)
          ? req.body.date
          : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        // 写真を補正
        const { out, brightness } = await correctPhoto(req.file.buffer);

        // ファイル名（重複しないよう時刻を混ぜる）
        const stamp = `${date}_${Date.now().toString(36)}`;
        const nameSlug = slugify(client, 'work');
        const imageName = `wk-${nameSlug}-${stamp.slice(-6)}.webp`;
        const mdName = `${date}_${nameSlug}-${stamp.slice(-6)}.md`;

        const alt = String(req.body.alt || '').trim() || `${client}の${title}`;

        const md = [
          '---',
          `client: ${yamlStr(client)}`,
          `title: ${yamlStr(title)}`,
          `method: ${yamlStr(method)}`,
          `category: ${yamlStr(category)}`,
          `date: ${yamlStr(date)}`,
          `image: ${yamlStr(imageName)}`,
          `alt: ${yamlStr(alt)}`,
          `permission: ${yamlStr(permission)}`,
          '---',
          '',
        ].join('\n');

        const sha = await commitFiles(
          [
            { path: `public/images/${imageName}`, buffer: out },
            { path: `src/content/works/${mdName}`, content: md },
          ],
          `実績追加: ${client}／${title}（HiBoardから登録）`
        );

        // 顧客データはログに残さない方針のため、件名は出さずファイル名のみ記録する
        console.log(`[works] 実績を公開キューへ送信しました commit=${sha.slice(0, 7)} image=${imageName}`);

        res.json({
          ok: true,
          commit: sha.slice(0, 7),
          image: imageName,
          brightness: Math.round(brightness),
          message: '登録しました。数分後にサイトへ反映されます。',
        });
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        console.error('[works] 公開に失敗:', msg);
        if (/Cannot find module 'sharp'/.test(msg)) {
          return res.status(500).json({ error: '画像処理ライブラリ(sharp)が入っていません。update.bat を実行してください' });
        }
        res.status(500).json({ error: `公開に失敗しました: ${msg}` });
      }
    });
  });
}

module.exports = {
  registerWorksRoutes,
  isWorksPublishConfigured,
  configDiagnostics,
  correctPhoto,
  POSITIONS,
  METHODS,
  CATEGORIES,
};
