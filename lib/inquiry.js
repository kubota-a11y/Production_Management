// 公式LINEの「入口」別お問い合わせフォーム(2026-09-09 新設)。
//
// 公式LINEのあいさつメッセージ・リッチメニューに「チーム・サッカー / クラスTシャツ / オリジナルアイテム」
// の3つの入口を置き、それぞれ /inquiry/{kind} の短いフォームへ誘導する。既存の /order は業者向けで
// 項目が多く、一般のお客様が離脱しやすかったため、用途ごとに2分で送れるフォームを分けた。
//
//   GET  /inquiry                 … 入口選択ページ(あいさつメッセージと同じ3択)
//   GET  /inquiry/:kind           … 入口別フォーム(項目定義は lib/inquiry-kinds.js)
//   POST /api/inquiry/:kind       … 受け口。ai_extracted_intake に着地(受付番号 Q-{id})
//
// 着地先は他チャネルと同じ受注候補。line_user_id を入口ごとに分ける(INQ_TEAM / INQ_CLASS_T / INQ_ORIGINAL)
// ことで、受注候補カードの送信者名がそのまま「どの入口から来たか」になり、三浦さんが開かずに仕分けできる。
// 受付番号のプレフィックスは3入口とも Q-(お客様向けの進捗確認 /status でも照会できる)。
//
// 個人情報の扱い: サンプル送付先住所(private な項目)は受注候補のメモ(詳細画面)にだけ残し、
// 一覧・TODO通知・会社宛てメール・ログには出さない。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { isMailerConfigured, sendOrderConfirmation, sendOrderNotificationToAdmin } = require('./order-mailer');
const { notifyIntakeTask } = require('./todo-notify');
const {
  saveOrderImages, cleanupTempFiles, getClientIp, hashIp, checkRateLimit, verifyTurnstile,
  TURNSTILE_SITEKEY, MAX_FILE_BYTES, ALLOWED_EXT, ALLOWED_MIME,
} = require('./order-intake');
const { KINDS, KIND_ORDER, getKind, chooserList, optionLabel } = require('./inquiry-kinds');

const RECEIPT_PREFIX = 'Q';
const MAX_FILES = 5;                 // 参考画像。相談フォームなので /order より少なめ
const LEN = { short: 200, text: 2000 };

function s(v, max = LEN.short) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}
function isNonEmptyStr(v) { return typeof v === 'string' && v.trim().length > 0; }

// ===== line_users に入口ごとの疑似ユーザーを用意(WEB/TEAM/PARTNER と同じ方式) =====
function ensureInquiryUsers(db) {
  const now = new Date().toISOString();
  const ins = db.prepare(`
    INSERT INTO line_users (line_user_id, display_name, first_seen_at, last_message_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(line_user_id) DO NOTHING
  `);
  for (const slug of KIND_ORDER) {
    ins.run(KINDS[slug].lineUserId, KINDS[slug].displayName, now, now);
  }
}

// ===== 検証(項目定義から機械的に行う) =====
// 返り値: { errors:[{field,message}], values:{key: 正規化済みの値} }
function validatePayload(kind, payload) {
  const errors = [];
  const values = {};
  const p = (payload && typeof payload === 'object') ? payload : {};
  const push = (field, message) => errors.push({ field, message });

  for (const f of kind.fields) {
    const raw = p[f.key];
    let val;
    switch (f.type) {
      case 'checkbox':
        val = raw === true || raw === 'true' || raw === 'on' || raw === 1 || raw === '1';
        break;
      case 'checkboxes': {
        const allowed = new Set((f.options || []).map(o => o.value));
        val = Array.isArray(raw) ? raw.map(x => s(x, 50)).filter(x => allowed.has(x)) : [];
        break;
      }
      case 'select': {
        val = s(raw, 50);
        if (val && !(f.options || []).some(o => o.value === val)) {
          push(f.key, `${f.label}の選択が不正です`);
          val = '';
        }
        break;
      }
      case 'date':
        val = s(raw, 10);
        if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) { push(f.key, `${f.label}の形式が不正です`); val = ''; }
        break;
      case 'textarea':
        val = s(raw, f.maxlength || LEN.text);
        break;
      default:
        val = s(raw, f.maxlength || LEN.short);
    }
    values[f.key] = val;
  }

  // 必須チェック(requiredIf は条件を満たすときだけ)
  for (const f of kind.fields) {
    const must = f.required || (f.requiredIf && values[f.requiredIf.key] === f.requiredIf.equals);
    if (!must) continue;
    const v = values[f.key];
    const empty = Array.isArray(v) ? v.length === 0 : (typeof v === 'boolean' ? !v : !isNonEmptyStr(v));
    if (empty) push(f.key, `${f.label}を入力してください`);
  }
  // 形式チェック
  for (const f of kind.fields) {
    const v = values[f.key];
    if (!isNonEmptyStr(v)) continue;
    if (f.type === 'tel' && !/^[\d\-+()\s]{7,20}$/.test(v)) push(f.key, `${f.label}の形式が不正です`);
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) push(f.key, `${f.label}の形式が不正です`);
  }

  // 表示条件を満たしていない項目の値は捨てる(チェックを外したのに住所が残る、を防ぐ)
  for (const f of kind.fields) {
    if (f.requiredIf && values[f.requiredIf.key] !== f.requiredIf.equals) {
      values[f.key] = f.type === 'checkboxes' ? [] : (f.type === 'checkbox' ? false : '');
    }
  }
  return { errors, values };
}

// 値を人が読める文字列に(メモ用)。空なら null
function displayValue(field, v) {
  if (field.type === 'checkbox') return v ? 'はい' : null;
  if (field.type === 'checkboxes') return v.length ? v.map(x => optionLabel(field, x)).join('・') : null;
  if (field.type === 'select') return v ? optionLabel(field, v) : null;
  return isNonEmptyStr(v) ? v : null;
}

// ===== 受注候補の各列に落とす(入口ごとの見せ方) =====
function fieldOf(kind, key) { return kind.fields.find(f => f.key === key); }

function buildColumns(kind, v) {
  const shortItems = (key) => {
    const f = fieldOf(kind, key);
    return f ? displayValue(f, v[key]) : null;
  };
  let customer_name, items, quantity, deadline;
  switch (kind.slug) {
    case 'team':
      customer_name = v.team_name || v.contact_name;
      items = `【チーム・サッカー】${[shortItems('items'), shortItems('category')].filter(Boolean).join(' / ') || 'ご相談'}`;
      quantity = v.headcount || null;
      deadline = v.timing || null;
      break;
    case 'class-t':
      customer_name = [v.school_name, v.grade_class].filter(Boolean).join(' ') || v.contact_name;
      items = `【クラスT】${[v.school_name, v.grade_class].filter(Boolean).join(' ')}${v.sample_request ? ' / サンプル希望' : ''}`;
      quantity = v.quantity || null;
      deadline = v.use_date || null;
      break;
    default:
      customer_name = v.org_name || v.contact_name;
      items = `【オリジナル】${[shortItems('item_type'), shortItems('method')].filter(Boolean).join(' / ') || 'ご相談'}`;
      quantity = v.quantity || null;
      deadline = v.timing || null;
  }
  return { customer_name, items, quantity, deadline };
}

// メール用の注文者(order-mailer の形に合わせる)
function buildOrderer(kind, v) {
  const org = kind.slug === 'team' ? v.team_name : kind.slug === 'class-t' ? v.school_name : v.org_name;
  return { org_name: org || '', contact_name: v.contact_name || '', phone: v.phone || '', email: v.email || '' };
}

// 受注候補のメモ(詳細画面に出る人向けの要約)。private な項目もここにだけ残す
function buildNotes(kind, v, images, dir, receiptNo, src) {
  const L = [];
  L.push(`【公式LINE入口フォーム】${kind.label}(受付 ${receiptNo})`);
  L.push(`■担当の目安: ${kind.owner}(入口の振り分けルール 2026-09-09)`);
  if (src) L.push(`■流入元: ${src}`);
  for (const f of kind.fields) {
    const text = displayValue(f, v[f.key]);
    if (text === null) continue;
    L.push(`■${f.label}: ${text}`);
  }
  if (images.length) {
    L.push(`■参考画像: ${images.length}件 → ${dir}`);
    images.forEach(img => L.push(`  - ${img.stored_name}`));
  }
  return L.join('\n');
}

// ===== HTMLへ設定を注入 =====
// JSONを <script> に埋めるので、"</script>" で抜けられないよう "</" をエスケープする
function jsonForHtml(obj) {
  return JSON.stringify(obj).replace(/<\//g, '<\\/');
}

function renderPage(kind) {
  let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'inquiry.html'), 'utf8');
  const config = {
    turnstileSiteKey: TURNSTILE_SITEKEY,
    maxFiles: MAX_FILES,
    kinds: chooserList(),
    // 入口が決まっているときだけ、その定義(画面に必要な分だけ)を渡す
    current: kind ? {
      slug: kind.slug, icon: kind.icon, title: kind.title, lead: kind.lead, label: kind.label,
      fields: kind.fields.map(f => ({
        key: f.key, label: f.label, type: f.type, required: !!f.required, requiredIf: f.requiredIf || null,
        options: f.options || null, section: f.section, half: !!f.half, maxlength: f.maxlength || null,
        placeholder: f.placeholder || '', hint: f.hint || '',
      })),
    } : null,
  };
  const title = kind ? `${kind.title} | HIYOSHI` : 'ご相談の入口 | HIYOSHI';
  return html
    .replace(/{{PAGE_TITLE}}/g, title)
    .replace('{{INQUIRY_CONFIG}}', jsonForHtml(config));
}

// ===== ルート登録 =====
function registerInquiryRoutes(app, db) {
  ensureInquiryUsers(db);

  const tmpDir = path.join(os.tmpdir(), 'inquiry_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, tmpDir),
      filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase()),
    }),
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ALLOWED_EXT.has(ext) && ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
      cb(new Error(`許可されていないファイル形式です: ${file.originalname}`));
    },
  });
  const uploadMiddleware = (req, res, next) => {
    upload.array('images', MAX_FILES)(req, res, (err) => {
      if (err) {
        const message = err instanceof multer.MulterError
          ? (err.code === 'LIMIT_FILE_SIZE' ? 'ファイルサイズが大きすぎます(上限15MB)'
            : err.code === 'LIMIT_FILE_COUNT' ? `添付は最大${MAX_FILES}件までです`
            : 'ファイルのアップロードに失敗しました')
          : err.message;
        return res.status(400).json({ ok: false, errors: [{ field: 'images', message }] });
      }
      next();
    });
  };

  // 入口選択ページ
  app.get('/inquiry', (req, res) => {
    try {
      res.type('html').send(renderPage(null));
    } catch (err) {
      res.status(500).send('ページの読み込みに失敗しました');
    }
  });

  // 入口別フォーム
  app.get('/inquiry/:kind', (req, res) => {
    const kind = getKind(s(req.params.kind, 30));
    if (!kind) return res.status(404).send('Not Found');
    try {
      res.type('html').send(renderPage(kind));
    } catch (err) {
      res.status(500).send('フォームの読み込みに失敗しました');
    }
  });

  // 受け口
  app.post('/api/inquiry/:kind', uploadMiddleware, async (req, res) => {
    const files = req.files || [];
    try {
      const kind = getKind(s(req.params.kind, 30));
      if (!kind) { cleanupTempFiles(files); return res.status(404).json({ ok: false, errors: [{ field: '_', message: 'このフォームは存在しません' }] }); }

      // 1. honeypot(botは静かに破棄)
      if (isNonEmptyStr(req.body.hp_url)) { cleanupTempFiles(files); return res.status(200).json({ ok: true }); }

      // 2. レート制限(/order と同じ窓を共有)
      const ip = getClientIp(req);
      const rl = checkRateLimit(ip);
      if (!rl.ok) {
        cleanupTempFiles(files);
        res.set('Retry-After', String(rl.retryAfter));
        return res.status(429).json({ ok: false, errors: [{ field: '_', message: '送信が多すぎます。しばらくしてから再度お試しください' }] });
      }

      // 3. Turnstile
      const ts = await verifyTurnstile(req.body['cf-turnstile-response'], ip);
      if (!ts.ok) { cleanupTempFiles(files); return res.status(400).json({ ok: false, errors: [{ field: '_', message: '認証に失敗しました。ページを再読み込みして再度お試しください' }] }); }

      // 4. 本文
      let payload = {};
      try { payload = JSON.parse(req.body.payload || '{}'); } catch (_) { payload = {}; }
      const { errors, values } = validatePayload(kind, payload);
      if (errors.length) { cleanupTempFiles(files); return res.status(400).json({ ok: false, errors }); }
      // 流入元(?src=line など)。英数字だけ許す
      const src = (s(payload._src, 20).match(/^[a-z0-9_-]+$/i) || [''])[0];

      // 5. INSERT(画像パス未確定のまま着地させて id を得る → 画像保存 → notes 確定)
      const now = new Date().toISOString();
      const cols = buildColumns(kind, values);
      const preRaw = {
        schema_version: 1,
        source: 'line_inquiry_form',
        kind: kind.slug,
        values,
        submitted_at: now,
        images: [],
        meta: { form_version: '1.0', src, user_agent: s(req.headers['user-agent'], LEN.short), client_ip_hash: hashIp(ip), turnstile_verified: !ts.skipped },
      };
      const info = db.prepare(`
        INSERT INTO ai_extracted_intake
          (line_user_id, extracted_at, customer_name, items, quantity, deadline, notes, raw_ai_response, message_ids)
        VALUES (?, ?, ?, ?, ?, ?, '', ?, '[]')
      `).run(kind.lineUserId, now, cols.customer_name, cols.items, cols.quantity, cols.deadline, JSON.stringify(preRaw));
      const intakeId = info.lastInsertRowid;
      const receiptNo = `${RECEIPT_PREFIX}-${intakeId}`;

      try {
        const { images, dir, warning } = saveOrderImages(intakeId, files, files.map(() => 'reference'));
        const finalRaw = { ...preRaw, images };
        db.prepare('UPDATE ai_extracted_intake SET raw_ai_response = ?, notes = ?, reference_link = ? WHERE id = ?')
          .run(JSON.stringify(finalRaw), buildNotes(kind, values, images, dir, receiptNo, src), images.length ? images[0].unc_path : null, intakeId);

        // 顧客データはログに書かない(件数と受付番号のみ)
        console.log(`[入口フォーム] 新規受付: ${receiptNo} kind=${kind.slug} images=${images.length}${warning ? ' (画像保存に一部失敗)' : ''}`);

        // 社員TODOリストへ(住所などの private 項目は含めない)
        notifyIntakeTask(`公式LINE入口フォーム(${kind.label}): ${cols.customer_name} — ${cols.items}(受付 ${receiptNo}・担当目安 ${kind.owner})`);

        // メール(受付控え=お客様 / 通知=会社)。成否は受付に影響させない
        const orderer = buildOrderer(kind, values);
        const mailPayload = {
          receiptNo,
          requestTypeLabel: kind.requestTypeLabel,
          orderer,
          summary: { items: cols.items, quantity: cols.quantity, deadline: cols.deadline, contact_time: null },
        };
        const willSendMail = isNonEmptyStr(orderer.email) && isMailerConfigured();
        if (willSendMail) {
          sendOrderConfirmation({ to: orderer.email, ...mailPayload })
            .then(() => console.log(`[入口フォーム] 受付控えメールを送信: ${receiptNo}`))
            .catch(err => console.error(`[入口フォーム] 受付控えメールの送信に失敗(${receiptNo}):`, err.message));
        }
        sendOrderNotificationToAdmin(mailPayload)
          .then(sent => { if (sent) console.log(`[入口フォーム] 会社宛て通知メールを送信: ${receiptNo}`); })
          .catch(err => console.error(`[入口フォーム] 会社宛て通知メールの送信に失敗(${receiptNo}):`, err.message));

        return res.status(201).json({
          ok: true,
          receipt_no: receiptNo,
          receipt_mail: willSendMail,
          kind: kind.slug,
          sample_requested: kind.slug === 'class-t' && !!values.sample_request,
          ...(warning ? { image_warning: true } : {}),
        });
      } catch (postInsertErr) {
        // 受付だけ成立して画面がエラー、という二重受付の温床を作らない
        try { db.prepare('DELETE FROM ai_extracted_intake WHERE id = ?').run(intakeId); } catch (_) { /* noop */ }
        throw postInsertErr;
      }
    } catch (err) {
      console.error('[入口フォーム] 受付処理で予期しないエラー:', err);
      cleanupTempFiles(files);
      // 公開ページのAPIで5xxを返すとCloudflareがエラーページに差し替えて画面側がJSONを読めなくなるため 200 で返す
      return res.status(200).json({ ok: false, errors: [{ field: '_', message: 'サーバー側でエラーが発生しました。時間をおいて再度お試しください' }] });
    }
  });
}

module.exports = { registerInquiryRoutes, validatePayload, RECEIPT_PREFIX };
