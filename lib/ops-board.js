const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// オペレーションボード(2026-08-03)。
// デザイン担当(鈴木さん)を制作専任にし、その前後のやりとり(依頼内容の整理・ラフ作成・
// お客様確認・外注入稿・請求)をオペレーション担当(山本さん)が回すための画面のサーバー側。
//
// 既存の projects.status は生産工程の軸(受注前〜納品済み)なのでそのまま残し、
// 「いま誰のボールで止まっているか」を ops_stage / ops_wait_on の別軸で持つ。
//
// 段階の遷移(2026-08-03 社長決定):
//   ①BRIEF(ブリーフ・ラフ / 山本)   → 手動「鈴木さんへ渡す」
//   ②DESIGN(制作 / 鈴木)            → 自動: デザイナーが準備項目「初稿提出」を完了した時点
//   ③REVIEW(確認)                   → ops_wait_on で YAMAMOTO(社内が動く番)/CUSTOMER(返事待ち)を区別
//   ④PRODUCTION(入稿・製造)          → 自動: デザイナーが「外注用デザインデータ作成」を完了した時点
//   ⑤BILLING(請求 / 山本)           → 自動: 納品処理の実行時
//   DONE(完了)                       → 手動「請求済み」

const STAGES = ['BRIEF', 'DESIGN', 'REVIEW', 'PRODUCTION', 'BILLING', 'DONE'];
const STAGE_LABELS = {
  BRIEF: 'ブリーフ・ラフ',
  DESIGN: '制作',
  REVIEW: '確認',
  PRODUCTION: '入稿・製造',
  BILLING: '請求',
  DONE: '完了',
};
const WAIT_ON_VALUES = ['YAMAMOTO', 'CUSTOMER'];

// ②→③ を起こす準備項目コード。③→④ は入稿データが仕上がったとき
const FIRST_DRAFT_CODE = 'FIRST_DRAFT_SUBMIT';
const OUTSOURCE_DATA_CODE = 'OUTSOURCE_DESIGN_DATA';

// お客様の返事待ちが何日を超えたら「今日やること」に催促として戻すか
const CUSTOMER_REMIND_DAYS = (() => {
  const n = parseInt(process.env.OPS_CUSTOMER_REMIND_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
})();

// デザインラフの保存先。デザイナーは社外からトークンURLで見るためNASには置かず、
// サーバー内に保存してHTTPで配信する(鈴木さんは会社のNASにアクセスできないため)
const ROUGH_UPLOAD_PATH = process.env.ROUGH_UPLOAD_PATH
  || path.join(__dirname, '..', 'data', 'rough_uploads');

const MAX_ROUGH_FILES = 5;
const MAX_ROUGH_BYTES = 15 * 1024 * 1024;
const ALLOWED_ROUGH_EXT = new Set(['.jpg', '.jpeg', '.png', '.pdf', '.heic', '.webp', '.gif']);
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.pdf': 'application/pdf', '.heic': 'image/heic', '.webp': 'image/webp', '.gif': 'image/gif',
};

function s(v, max = 200) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}

// 日数差(切り捨て)。null安全
function daysSince(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}

// 段階を書き換える。段階が実際に変わったときだけ滞留日数の起点を打ち直す
function setStage(db, caseId, stage, waitOn = null) {
  if (!STAGES.includes(stage)) return false;
  const project = db.prepare('SELECT ops_stage, ops_wait_on FROM projects WHERE id = ?').get(caseId);
  if (!project) return false;

  const nextWaitOn = stage === 'REVIEW' ? (WAIT_ON_VALUES.includes(waitOn) ? waitOn : 'YAMAMOTO') : null;
  const stageChanged = project.ops_stage !== stage;
  const now = new Date().toISOString();

  if (stageChanged) {
    db.prepare(`
      UPDATE projects SET ops_stage = ?, ops_wait_on = ?, ops_stage_since = ?, updated_at = ? WHERE id = ?
    `).run(stage, nextWaitOn, now, now, caseId);
  } else {
    // 同じ段階の中で待ち先だけ変える場合(山本→お客様)は滞留起点も打ち直す。
    // 「お客様に投げてから何日経ったか」を見たいのが目的なので、ここは意図的にリセットする
    const waitChanged = project.ops_wait_on !== nextWaitOn;
    db.prepare(`
      UPDATE projects SET ops_wait_on = ?, ops_stage_since = COALESCE(?, ops_stage_since), updated_at = ? WHERE id = ?
    `).run(nextWaitOn, waitChanged ? now : null, now, caseId);
  }
  return true;
}

// デザイナーが準備項目を完了したときに呼ばれる。段階を前へ進める(戻すことはしない)。
// 完了を取り消した場合(未着手へ戻した場合)は段階を巻き戻さない ——
// 既にお客様へ提出済みのものを機械的に戻すと実態と合わなくなるため、戻す操作は山本さんが手で行う
function advanceOnPrepItemComplete(db, caseId, itemCode) {
  const project = db.prepare('SELECT ops_stage FROM projects WHERE id = ?').get(caseId);
  if (!project) return null;
  const current = STAGES.indexOf(project.ops_stage);

  if (itemCode === FIRST_DRAFT_CODE && current < STAGES.indexOf('REVIEW')) {
    setStage(db, caseId, 'REVIEW', 'YAMAMOTO');
    console.log(`[オペ段階] 案件#${caseId}: 初稿提出の完了により 制作 → 確認(山本待ち) に進めました`);
    return 'REVIEW';
  }
  if (itemCode === OUTSOURCE_DATA_CODE && current < STAGES.indexOf('PRODUCTION')) {
    setStage(db, caseId, 'PRODUCTION');
    console.log(`[オペ段階] 案件#${caseId}: 外注用デザインデータ完成により 入稿・製造 に進めました`);
    return 'PRODUCTION';
  }
  return null;
}

// 納品処理から呼ばれる。請求待ちへ進める
function markBillingOnDeliver(db, caseId) {
  const project = db.prepare('SELECT ops_stage FROM projects WHERE id = ?').get(caseId);
  if (!project) return;
  if (STAGES.indexOf(project.ops_stage) < STAGES.indexOf('BILLING')) {
    setStage(db, caseId, 'BILLING');
    console.log(`[オペ段階] 案件#${caseId}: 納品により 請求 に進めました`);
  }
}

// このボードに載せる案件かどうか。
// 準備項目の中身から推測するのではなく、案件登録時に「デザイン案件全般」を
// チェックした案件だけを対象にする(2026-08-03 社長判断)。
// 推測方式だと、デザインデータを作るだけの通常のプリント案件まで載ってしまい、
// 山本さんが見るべき案件が埋もれるため
const IN_SCOPE_SQL = `p.is_design_ops = 1`;

function listRoughFiles(db, caseId) {
  return db.prepare(`
    SELECT id, original_name, mime_type, byte_size, note, uploaded_at
    FROM case_rough_files WHERE case_id = ? ORDER BY id ASC
  `).all(caseId);
}

// 「今日やること」に載せる理由を決める。載せないものは null
function todoReason(row) {
  const days = daysSince(row.ops_stage_since);
  if (row.ops_stage === 'BRIEF') {
    return { key: 'BRIEF', label: 'ブリーフとラフを作って鈴木さんへ渡す' };
  }
  if (row.ops_stage === 'REVIEW' && row.ops_wait_on === 'YAMAMOTO') {
    return { key: 'REVIEW_SELF', label: 'お客様へ初稿を送る・確認する' };
  }
  if (row.ops_stage === 'REVIEW' && row.ops_wait_on === 'CUSTOMER' && days !== null && days >= CUSTOMER_REMIND_DAYS) {
    return { key: 'REVIEW_REMIND', label: `お客様の返事が${days}日ありません。催促する` };
  }
  if (row.ops_stage === 'BILLING') {
    return { key: 'BILLING', label: '請求書を発行する' };
  }
  return null;
}

function registerOpsBoardRoutes(app, db) {
  fs.mkdirSync(ROUGH_UPLOAD_PATH, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, ROUGH_UPLOAD_PATH),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: MAX_ROUGH_BYTES, files: MAX_ROUGH_FILES },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ALLOWED_ROUGH_EXT.has(ext)) return cb(null, true);
      cb(new Error(`この形式は添付できません: ${file.originalname}`));
    },
  });

  const uploadMiddleware = (req, res, next) => {
    upload.array('files', MAX_ROUGH_FILES)(req, res, (err) => {
      if (err) {
        const message = err instanceof multer.MulterError
          ? (err.code === 'LIMIT_FILE_SIZE' ? 'ファイルサイズが大きすぎます(上限15MB)'
            : err.code === 'LIMIT_FILE_COUNT' ? `添付は一度に最大${MAX_ROUGH_FILES}件までです`
            : 'アップロードに失敗しました')
          : err.message;
        return res.status(400).json({ ok: false, error: message });
      }
      next();
    });
  };

  // ---- 画面 ----
  app.get('/ops', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'ops-board.html'));
  });

  // ---- ボードのデータ ----
  app.get('/api/ops/board', (req, res) => {
    try {
      const includeDone = req.query.include_done === '1';
      const rows = db.prepare(`
        SELECT p.id, p.project_name, p.customer_name, p.deadline, p.status, p.priority,
               p.project_kind, p.ops_stage, p.ops_wait_on, p.ops_stage_since,
               (SELECT COUNT(*) FROM case_rough_files rf WHERE rf.case_id = p.id) AS rough_count,
               (SELECT cpi.status FROM case_preparation_items cpi
                  JOIN preparation_item_master pim ON cpi.preparation_item_id = pim.id
                  WHERE cpi.case_id = p.id AND pim.code = '${FIRST_DRAFT_CODE}' LIMIT 1) AS first_draft_status,
               (SELECT cpi.scheduled_date FROM case_preparation_items cpi
                  JOIN preparation_item_master pim ON cpi.preparation_item_id = pim.id
                  WHERE cpi.case_id = p.id AND pim.code = '${FIRST_DRAFT_CODE}' LIMIT 1) AS first_draft_date
        FROM projects p
        WHERE ${IN_SCOPE_SQL} ${includeDone ? '' : "AND p.ops_stage != 'DONE'"}
        ORDER BY p.deadline ASC, p.id ASC
      `).all();

      const cases = rows.map(r => ({
        id: r.id,
        project_name: r.project_name,
        customer_name: r.customer_name,
        deadline: r.deadline,
        status: r.status,
        priority: r.priority,
        project_kind: r.project_kind,
        ops_stage: r.ops_stage,
        ops_wait_on: r.ops_wait_on,
        ops_stage_since: r.ops_stage_since,
        days_in_stage: daysSince(r.ops_stage_since),
        rough_count: r.rough_count,
        first_draft_status: r.first_draft_status,
        first_draft_date: r.first_draft_date,
      }));

      const today = cases
        .map(c => ({ ...c, reason: todoReason(c) }))
        .filter(c => c.reason)
        .sort((a, b) => (a.deadline || '').localeCompare(b.deadline || '')
          || (b.days_in_stage || 0) - (a.days_in_stage || 0));

      res.json({
        ok: true,
        stages: STAGES.map(key => ({ key, label: STAGE_LABELS[key] })),
        remind_days: CUSTOMER_REMIND_DAYS,
        cases,
        today,
      });
    } catch (err) {
      console.error('[オペボード] データ取得エラー:', err.message);
      res.status(500).json({ ok: false, error: 'データの取得に失敗しました' });
    }
  });

  // ---- 段階の手動変更 ----
  app.patch('/api/ops/cases/:id/stage', (req, res) => {
    try {
      const caseId = parseInt(req.params.id, 10);
      const stage = s(req.body.stage, 20);
      const waitOn = s(req.body.wait_on, 20) || null;

      if (!STAGES.includes(stage)) {
        return res.status(400).json({ ok: false, error: '段階の指定が正しくありません' });
      }
      if (stage === 'REVIEW' && waitOn && !WAIT_ON_VALUES.includes(waitOn)) {
        return res.status(400).json({ ok: false, error: '待ち先の指定が正しくありません' });
      }
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(caseId);
      if (!project) return res.status(404).json({ ok: false, error: '案件が見つかりません' });

      setStage(db, caseId, stage, waitOn);
      const updated = db.prepare(
        'SELECT ops_stage, ops_wait_on, ops_stage_since FROM projects WHERE id = ?'
      ).get(caseId);
      res.json({ ok: true, ...updated, days_in_stage: daysSince(updated.ops_stage_since) });
    } catch (err) {
      console.error('[オペボード] 段階更新エラー:', err.message);
      res.status(500).json({ ok: false, error: '更新に失敗しました' });
    }
  });

  // ---- デザインラフ ----
  app.get('/api/ops/cases/:id/rough', (req, res) => {
    try {
      const caseId = parseInt(req.params.id, 10);
      res.json({ ok: true, files: listRoughFiles(db, caseId) });
    } catch (err) {
      console.error('[オペボード] ラフ一覧エラー:', err.message);
      res.status(500).json({ ok: false, error: '取得に失敗しました' });
    }
  });

  app.post('/api/ops/cases/:id/rough', uploadMiddleware, (req, res) => {
    const files = req.files || [];
    try {
      const caseId = parseInt(req.params.id, 10);
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(caseId);
      if (!project) {
        files.forEach(f => { try { fs.unlinkSync(f.path); } catch (e) { /* 破棄失敗は無視 */ } });
        return res.status(404).json({ ok: false, error: '案件が見つかりません' });
      }
      if (!files.length) return res.status(400).json({ ok: false, error: 'ファイルが選ばれていません' });

      const note = s(req.body.note, 500);
      const now = new Date().toISOString();
      const insert = db.prepare(`
        INSERT INTO case_rough_files (case_id, original_name, stored_name, mime_type, byte_size, note, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      files.forEach(f => {
        const ext = path.extname(f.originalname).toLowerCase();
        insert.run(caseId, s(f.originalname, 255), f.filename,
          MIME_BY_EXT[ext] || f.mimetype || 'application/octet-stream', f.size, note, now);
      });
      res.json({ ok: true, files: listRoughFiles(db, caseId) });
    } catch (err) {
      console.error('[オペボード] ラフ保存エラー:', err.message);
      files.forEach(f => { try { fs.unlinkSync(f.path); } catch (e) { /* 破棄失敗は無視 */ } });
      res.status(500).json({ ok: false, error: '保存に失敗しました' });
    }
  });

  app.delete('/api/ops/rough/:fileId', (req, res) => {
    try {
      const file = db.prepare('SELECT * FROM case_rough_files WHERE id = ?').get(parseInt(req.params.fileId, 10));
      if (!file) return res.status(404).json({ ok: false, error: 'ファイルが見つかりません' });
      try { fs.unlinkSync(path.join(ROUGH_UPLOAD_PATH, file.stored_name)); } catch (e) { /* 実体が無くても行は消す */ }
      db.prepare('DELETE FROM case_rough_files WHERE id = ?').run(file.id);
      res.json({ ok: true });
    } catch (err) {
      console.error('[オペボード] ラフ削除エラー:', err.message);
      res.status(500).json({ ok: false, error: '削除に失敗しました' });
    }
  });

  // 社内向けの実体配信。デザイナー(社外)向けは lib/designer-board.js のトークン付きURLから配信する
  app.get('/api/ops/rough/:fileId/file', (req, res) => {
    const file = db.prepare('SELECT * FROM case_rough_files WHERE id = ?').get(parseInt(req.params.fileId, 10));
    if (!file) return res.status(404).send('見つかりません');
    sendRoughFile(res, file);
  });
}

// ラフの実体を返す。ファイル名は日本語が混ざるためRFC5987でエンコードして渡す
function sendRoughFile(res, file) {
  const full = path.join(ROUGH_UPLOAD_PATH, file.stored_name);
  if (!fs.existsSync(full)) return res.status(404).send('ファイルの実体が見つかりません');
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
  res.sendFile(full);
}

module.exports = {
  registerOpsBoardRoutes,
  advanceOnPrepItemComplete,
  markBillingOnDeliver,
  listRoughFiles,
  sendRoughFile,
  setStage,
  STAGES,
  STAGE_LABELS,
};
