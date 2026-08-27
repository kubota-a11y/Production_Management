/**
 * 制作実績の公開モジュール
 *
 * HiBoard の「実績登録」画面から受け取った写真と入力内容を、
 * コーポレートサイト（別リポジトリ）へ反映する。
 *
 *   写真 → EXIF回転・リサイズ(sharp) → webp
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
const express = require('express');
const multer = require('multer');

const REPO = process.env.WORKS_GITHUB_REPO || 'kubota-a11y/hiyoshi-web';
const BRANCH = process.env.WORKS_GITHUB_BRANCH || 'main';
const TOKEN = () => process.env.WORKS_GITHUB_TOKEN || '';
// GitHub APIの接続先。開発機でモックサーバーに向けて動作確認するための逃げ道で、本番では設定しない
const API_BASE = () => process.env.WORKS_GITHUB_API_BASE || 'https://api.github.com';

// ---- 写真の書き出し値（サイト側 scripts/lib/correct-photo.mjs と同一。変更時は両方直すこと）----
// 2026-08-24、色の自動補正（ホワイトバランス・コントラスト・明るさ・彩度）を廃止した。
// 新しいカメラ（Fujifilm X-T5）で撮り直しており、カメラ側の色味をそのまま出したいため
// （社長指示）。ここでやるのは EXIF回転・リサイズ・webp化だけ。
const WIDTH = 1400;

/** 写真1枚あたりの受け入れ上限。X-T5（4000万画素）のJPEGが25〜27MBあるため余裕を持たせている */
const MAX_PHOTO_MB = 60;

// ---- 入力の選択肢（画面と共用）----
const POSITIONS = ['左胸', '右胸', 'フロント', '背面', '袖', '裾', 'フード', 'その他'];
/**
 * 写真をどの向きから撮ったか。上の POSITIONS（加工の位置）とは別物なので混ぜないこと。
 * サイトのスライドで写真の下に出るラベルになる。
 */
const PHOTO_POSITIONS = ['正面', '背面', '横', 'アップ', '着用', 'その他'];
/** 1実績あたりの写真の上限 */
const MAX_PHOTOS = 3;
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

/**
 * 写真を webp のバッファにして返す（色の補正はしない）。
 * brightness は登録後の画面に出す確認用の数値で、写真そのものには手を加えていない。
 */
async function correctPhoto(buffer) {
  const sharp = require('sharp');
  const out = await sharp(buffer)
    .rotate() // カメラ・スマホ写真のEXIF回転を適用（忘れると横倒しになる）
    .resize({ width: WIDTH, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const st = await sharp(out).stats();
  const c = st.channels.slice(0, 3).map((x) => x.mean);
  return { out, brightness: (c[0] + c[1] + c[2]) / 3 };
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
  const res = await fetch(`${API_BASE()}${pathname}`, {
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
 * 複数ファイルを1コミットでまとめて追加・削除する。
 * （ファイルごとに commit すると履歴が汚れ、Actionsも複数回動いてしまうため）
 * `{ path, remove: true }` の項目はそのファイルの削除になる（tree の sha を null にする）。
 */
async function commitFiles(files, message) {
  const ref = await gh(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const baseSha = ref.object.sha;
  const baseCommit = await gh(`/repos/${REPO}/git/commits/${baseSha}`);

  const tree = [];
  for (const f of files) {
    if (f.remove) {
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
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

// ---- 公開済み実績の読み取り（一覧・取り下げ用）----

/** 実績mdの置き場所（サイト側リポジトリ内） */
const WORKS_DIR = 'src/content/works';

/** yamlStr() で書いた値を読み戻す（引用符なしの手書きファイルも受け入れる） */
function unYamlStr(s) {
  const t = String(s || '').trim();
  const m = t.match(/^"(.*)"$/);
  return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : t;
}

/**
 * 実績md 1件ぶんの本文から、一覧表示と取り下げ判断に必要な項目だけを取り出す。
 * 完全なYAMLパーサーではない（このモジュールが書く形式＋初期の手書き形式だけ読めればよい）。
 */
function parseWorkMd(text) {
  const out = { client: '', title: '', date: '', images: [] };
  for (const line of String(text).split('\n')) {
    let m;
    if ((m = line.match(/^client:\s*(.+)$/))) out.client = unYamlStr(m[1]);
    else if ((m = line.match(/^title:\s*(.+)$/))) out.title = unYamlStr(m[1]);
    else if ((m = line.match(/^date:\s*(.+)$/))) out.date = unYamlStr(m[1]);
    else if ((m = line.match(/^\s+-\s+file:\s*(.+)$/))) out.images.push(unYamlStr(m[1]));
    else if ((m = line.match(/^image:\s*(.+)$/))) out.images.push(unYamlStr(m[1])); // 2026-07-29より前の1枚形式
  }
  return out;
}

/** サイト側リポジトリから公開済みの実績を全件読む（新しい順） */
async function fetchWorksEntries() {
  const dir = await gh(`/repos/${REPO}/contents/${WORKS_DIR}?ref=${BRANCH}`);
  const mdFiles = (Array.isArray(dir) ? dir : []).filter((f) => f.type === 'file' && /\.md$/.test(f.name));
  const entries = await Promise.all(mdFiles.map(async (f) => {
    const file = await gh(`/repos/${REPO}/contents/${WORKS_DIR}/${encodeURIComponent(f.name)}?ref=${BRANCH}`);
    const text = Buffer.from(file.content || '', 'base64').toString('utf8');
    return { file: f.name, ...parseWorkMd(text) };
  }));
  // 画面の並びは登録の新しい順に近づける（date降順→ファイル名降順。ファイル名先頭が年月なのでほぼ登録順になる）
  entries.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.file.localeCompare(a.file));
  return entries;
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
      photoPositions: PHOTO_POSITIONS,
      maxPhotos: MAX_PHOTOS,
      methods: METHODS,
      categories: CATEGORIES,
      configured: isWorksPublishConfigured(),
      repo: REPO,
      diag: configDiagnostics(),
    });
  });

  // 公開済みの実績一覧（取り下げ画面用）。写真の中身は返さずファイル名だけ返す
  app.get('/api/works/list', async (req, res) => {
    try {
      if (!isWorksPublishConfigured()) {
        return res.status(503).json({ error: 'GitHubトークンが未設定です（.env の WORKS_GITHUB_TOKEN）' });
      }
      const entries = await fetchWorksEntries();
      res.json({ ok: true, entries });
    } catch (e) {
      console.error('[works] 一覧の取得に失敗:', String(e && e.message ? e.message : e));
      res.status(500).json({ error: '公開済みの実績一覧を取得できませんでした。時間をおいてもう一度お試しください。' });
    }
  });

  // 実績の取り下げ。mdと、その実績だけが使っている写真（wk-〜）を1コミットで削除する
  app.post('/api/works/unpublish', express.json(), async (req, res) => {
    try {
      if (!isWorksPublishConfigured()) {
        return res.status(503).json({ error: 'GitHubトークンが未設定です（.env の WORKS_GITHUB_TOKEN）' });
      }
      const fileName = String((req.body && req.body.file) || '').trim();
      // パス区切りを含む値は受け付けない（works フォルダの外のファイルを消させないため）
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(fileName)) {
        return res.status(400).json({ error: '取り下げ対象の指定が正しくありません' });
      }

      const entries = await fetchWorksEntries();
      const target = entries.find((e) => e.file === fileName);
      if (!target) {
        return res.status(404).json({ error: 'その実績は見つかりませんでした（すでに取り下げ済みかもしれません）。一覧を読み込み直してください。' });
      }

      // 消してよい写真＝HiBoardの登録が作った wk-〜 で、他の実績が使っていないものだけ。
      // 初期の手書き実績はページのヒーロー等と写真を共用していることがあるため、wk-以外は残す
      const usedByOthers = new Set(
        entries.filter((e) => e.file !== fileName).flatMap((e) => e.images)
      );
      const removable = target.images.filter((img) => /^wk-/.test(img) && !usedByOthers.has(img));
      const kept = target.images.filter((img) => !removable.includes(img));

      const sha = await commitFiles(
        [
          { path: `${WORKS_DIR}/${fileName}`, remove: true },
          ...removable.map((img) => ({ path: `public/images/${img}`, remove: true })),
        ],
        `実績取り下げ: ${fileName}（HiBoardから・写真${removable.length}枚）`
      );

      // 顧客データはログに残さない方針のため、件名は出さずファイル名のみ記録する
      console.log(`[works] 実績を取り下げました commit=${sha.slice(0, 7)} ${fileName} 写真${removable.length}枚削除`);

      res.json({
        ok: true,
        commit: sha.slice(0, 7),
        removedImages: removable,
        keptImages: kept,
        message: '取り下げました。数分後にサイトから消えます。',
      });
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      console.error('[works] 取り下げに失敗:', msg);
      if (e.status === 401) {
        return res.status(401).json({ error: 'GitHubがトークンを受け付けませんでした。登録と同じトークン設定をご確認ください。' });
      }
      if (e.status === 403 || e.status === 404) {
        return res.status(e.status).json({
          error: `リポジトリ ${REPO} を操作できませんでした（${e.status}）。トークンの権限設定をご確認ください。`,
        });
      }
      res.status(500).json({ error: `取り下げに失敗しました: ${msg}` });
    }
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PHOTO_MB * 1024 * 1024, files: MAX_PHOTOS },
    fileFilter: (req, file, cb) => {
      if (/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.mimetype)) return cb(null, true);
      cb(new Error('画像ファイル（JPEG/PNG/WebP）を選んでください'));
    },
  });

  app.post('/api/works/publish', (req, res) => {
    upload.array('photo', MAX_PHOTOS)(req, res, async (uploadErr) => {
      try {
        if (uploadErr) {
          // 枚数オーバーは multer が LIMIT_FILE_COUNT で弾く。数字だけの英語メッセージだと伝わらない
          if (uploadErr.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({ error: `写真は${MAX_PHOTOS}枚までです` });
          }
          // multer の既定メッセージは英語の "File too large" で、社員が見ても原因が分からない
          if (uploadErr.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
              error: `写真1枚あたり${MAX_PHOTO_MB}MBまでです。これより大きい写真は久保田さんへご連絡ください`,
            });
          }
          return res.status(400).json({ error: uploadErr.message });
        }
        if (!isWorksPublishConfigured()) {
          return res.status(503).json({ error: 'GitHubトークンが未設定です（.env の WORKS_GITHUB_TOKEN）' });
        }
        if (!req.files || req.files.length === 0) {
          return res.status(400).json({ error: '写真を選んでください' });
        }

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

        // ファイル名（重複しないよう時刻を混ぜる）
        const stamp = `${date}_${Date.now().toString(36)}`;
        const nameSlug = slugify(client, 'work');
        const mdName = `${date}_${nameSlug}-${stamp.slice(-6)}.md`;

        // 写真は最大3枚。positions[i] が写した場所（正面／背面／横など）
        const rawPositions = [].concat(req.body.positions || []);
        const shots = [];
        for (let i = 0; i < req.files.length; i++) {
          const { out, brightness } = await correctPhoto(req.files[i].buffer);
          const position = String(rawPositions[i] || '').trim();
          const suffix = req.files.length > 1 ? `-${i + 1}` : '';
          shots.push({
            file: `wk-${nameSlug}-${stamp.slice(-6)}${suffix}.webp`,
            buffer: out,
            brightness: Math.round(brightness),
            position,
            // altは「取引先の内容（正面）」の形にして、読み上げでも区別できるようにする
            alt: `${client}の${title}${position ? `（${position}）` : ''}`,
          });
        }

        const md = [
          '---',
          `client: ${yamlStr(client)}`,
          `title: ${yamlStr(title)}`,
          `method: ${yamlStr(method)}`,
          `category: ${yamlStr(category)}`,
          `date: ${yamlStr(date)}`,
          'images:',
          ...shots.flatMap((s) => [
            `  - file: ${yamlStr(s.file)}`,
            ...(s.position ? [`    position: ${yamlStr(s.position)}`] : []),
            `    alt: ${yamlStr(s.alt)}`,
          ]),
          `permission: ${yamlStr(permission)}`,
          '---',
          '',
        ].join('\n');

        const sha = await commitFiles(
          [
            ...shots.map((s) => ({ path: `public/images/${s.file}`, buffer: s.buffer })),
            { path: `src/content/works/${mdName}`, content: md },
          ],
          `実績追加: ${client}／${title}（HiBoardから登録・写真${shots.length}枚）`
        );

        // 顧客データはログに残さない方針のため、件名は出さずファイル名のみ記録する
        console.log(
          `[works] 実績を公開キューへ送信しました commit=${sha.slice(0, 7)} 写真${shots.length}枚 ${shots.map((s) => s.file).join(' ')}`
        );

        res.json({
          ok: true,
          commit: sha.slice(0, 7),
          images: shots.map((s) => ({ file: s.file, position: s.position, brightness: s.brightness })),
          message: `登録しました（写真${shots.length}枚）。数分後にサイトへ反映されます。`,
        });
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        console.error('[works] 公開に失敗:', msg);
        if (/Cannot find module 'sharp'/.test(msg)) {
          return res.status(500).json({ error: '画像処理ライブラリ(sharp)が入っていません。update.bat を実行してください' });
        }
        // トークンが受け付けられなかった場合は、値を出さずに原因の手がかりを返す
        if (e.status === 401) {
          const d = configDiagnostics();
          return res.status(401).json({
            error: 'GitHubがトークンを受け付けませんでした。下の手がかりをご確認ください。',
            tokenHint: {
              length: d.length,
              looksLikeToken: d.looksLikeToken,
              hasSpaces: d.hasSpaces,
              hasQuotes: d.hasQuotes,
            },
          });
        }
        if (e.status === 403 || e.status === 404) {
          return res.status(e.status).json({
            error: `リポジトリ ${REPO} へ書き込めませんでした（${e.status}）。`
              + 'トークンの対象リポジトリと Contents:Read and write の設定をご確認ください。',
          });
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
