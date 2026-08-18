const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { notifyStageChange, isConfigured: isNotifyConfigured } = require('./ops-notify');

// オペレーションボード(2026-08-03)。
// デザイン担当(鈴木さん)を制作専任にし、その前後のやりとり(依頼内容の整理・ラフ作成・
// お客様確認・外注入稿・請求)をオペレーション担当(山本さん)が回すための画面のサーバー側。
//
// 既存の projects.status は生産工程の軸(受注前〜納品済み)なのでそのまま残し、
// 「いま誰のボールで止まっているか」を ops_stage / ops_wait_on の別軸で持つ。
//
// 段階の遷移(2026-08-03 社長決定):
//   ①BRIEF(ブリーフ・ラフ / 山本)   → 手動「鈴木さんへ渡す」
//   ②DESIGN(制作 / 鈴木)            → 自動: デザイナーが準備項目「初校提出」を完了した時点
//   ③REVIEW(確認)                   → ops_wait_on で確認の4ステップ(下の REVIEW_STEPS)を持つ
//   ④PRODUCTION(入稿・製造)          → 自動: デザイナーが「外注用デザインデータ作成」を完了した時点
//   ⑤BILLING(請求 / 山本)           → 自動: 納品処理の実行時
//   DONE(完了)                       → 手動「請求済み」

const STAGES = ['BRIEF', 'DESIGN', 'REVIEW', 'PRODUCTION', 'BILLING', 'INSPECTION', 'DELIVERY', 'DONE'];
const STAGE_LABELS = {
  BRIEF: 'ブリーフ・ラフ',
  DESIGN: '制作',
  REVIEW: '確認',
  PRODUCTION: '入稿・製造',
  BILLING: '請求',
  INSPECTION: '検品',
  DELIVERY: '納品',
  DONE: '完了',
};
// ③確認の中の進み方(2026-08-03 社長指示)。実際のやりとりの順番どおりに並べる:
//   ①山本がお客様へ確認連絡 → ②お客様の返事待ち
//   → ③山本がプリント位置・大きさを調整してお客様へ確認 → ④最終確認の返事待ち → OKで④入稿・製造へ
// ball: 'US' = 社内が動く番(今日やることに出す) / 'CUSTOMER' = 返事待ち(滞留したら催促)
const REVIEW_STEPS = [
  { key: 'SEND', label: 'お客様へ確認連絡', ball: 'US' },
  { key: 'REPLY_WAIT', label: 'お客様の返事待ち', ball: 'CUSTOMER' },
  { key: 'ADJUST', label: '位置・大きさの調整', ball: 'US' },
  { key: 'FINAL_WAIT', label: '最終確認の返事待ち', ball: 'CUSTOMER' },
];
const WAIT_ON_VALUES = REVIEW_STEPS.map(s => s.key);
const DEFAULT_REVIEW_STEP = 'SEND';

// CARVE案件(鈴木さんがCARVEで受けている案件)の作業段階(2026-08-05 社長指示)。
// 鈴木で始まり鈴木で終わる案件は、この4段階でどこまで進んだかをカードのバッジで示す。
// 切り替えは鈴木さん(マイスケジュールボード)と社内(デザイン進行ボード)の両方からできる
const CARVE_STAGES = [
  { key: 'ROUGH', label: 'ラフアップ' },
  { key: 'PHOTO', label: '写真入れアップ' },
  { key: 'REVISION', label: '修正アップ' },
  { key: 'SUBMIT', label: '入稿' },
];
const CARVE_STAGE_KEYS = CARVE_STAGES.map(s => s.key);

function reviewStep(key) {
  return REVIEW_STEPS.find(s => s.key === key) || REVIEW_STEPS[0];
}

// ②→③ を起こす準備項目コード。③→④ は入稿データが仕上がったとき
const FIRST_DRAFT_CODE = 'FIRST_DRAFT_SUBMIT';
const OUTSOURCE_DATA_CODE = 'OUTSOURCE_DESIGN_DATA';
// 紙媒体(入稿で完了)タイプ専用。デザイナーが入稿を終えたら「請求」へ進める
const SUBMISSION_COMPLETE_CODE = 'SUBMISSION_COMPLETE';

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

  const nextWaitOn = stage === 'REVIEW' ? (WAIT_ON_VALUES.includes(waitOn) ? waitOn : DEFAULT_REVIEW_STEP) : null;
  const stageChanged = project.ops_stage !== stage;
  const now = new Date().toISOString();

  if (stageChanged) {
    db.prepare(`
      UPDATE projects SET ops_stage = ?, ops_wait_on = ?, ops_stage_since = ?, updated_at = ? WHERE id = ?
    `).run(stage, nextWaitOn, now, now, caseId);
    // 担当が切り替わったことを Google Chat へ自動通知(手動の「よろしくお願いします」連絡の置き換え)。
    // 同じ段階内の操作(確認4ステップの切り替え等)では送らない
    notifyStageChange(db, caseId, project.ops_stage, stage);
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
  const project = db.prepare('SELECT ops_stage, ops_flow FROM projects WHERE id = ?').get(caseId);
  if (!project) return null;
  const current = STAGES.indexOf(project.ops_stage);

  if (itemCode === FIRST_DRAFT_CODE && current < STAGES.indexOf('REVIEW')) {
    setStage(db, caseId, 'REVIEW', DEFAULT_REVIEW_STEP);
    console.log(`[オペ段階] 案件#${caseId}: 初校提出の完了により 制作 → 確認(山本待ち) に進めました`);
    return 'REVIEW';
  }
  if (itemCode === OUTSOURCE_DATA_CODE && current < STAGES.indexOf('PRODUCTION')) {
    setStage(db, caseId, 'PRODUCTION');
    console.log(`[オペ段階] 案件#${caseId}: 外注用デザインデータ完成により 入稿・製造 に進めました`);
    return 'PRODUCTION';
  }
  // 紙媒体(入稿で完了)タイプ: 鈴木さんが入稿を終えたら請求へ。検品・納品は通らない
  if (itemCode === SUBMISSION_COMPLETE_CODE && project.ops_flow === 'SUBMIT_END'
      && current < STAGES.indexOf('BILLING')) {
    setStage(db, caseId, 'BILLING');
    console.log(`[オペ段階] 案件#${caseId}: 入稿完了により 請求 に進めました(入稿で完了タイプ)`);
    return 'BILLING';
  }
  return null;
}

// 一覧の「納品済み」ボタン(納品処理)から呼ばれる。納品段階へ進める。
// 完了(DONE)にはしない — 納品欄のチェックボックスで山本さんが締める運用のため
function markDeliveredStage(db, caseId) {
  const project = db.prepare('SELECT ops_stage FROM projects WHERE id = ?').get(caseId);
  if (!project) return;
  if (STAGES.indexOf(project.ops_stage) < STAGES.indexOf('DELIVERY')) {
    setStage(db, caseId, 'DELIVERY');
    console.log(`[オペ段階] 案件#${caseId}: 納品処理により 納品 に進めました`);
  }
}

// このボードに載せる案件かどうか。
// 準備項目の中身から推測するのではなく、案件登録時に「デザイン進行ボード」を
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
  if (row.ops_stage === 'REVIEW') {
    const step = reviewStep(row.ops_wait_on);
    // 社内が動く番のステップは、そのままやることとして出す
    if (step.ball === 'US') {
      return { key: `REVIEW_${step.key}`, label: step.label };
    }
    // 返事待ちは普段は出さず、放置されたときだけ催促として戻す
    if (days !== null && days >= CUSTOMER_REMIND_DAYS) {
      return { key: 'REVIEW_REMIND', label: `${step.label}のまま${days}日ありません。催促する` };
    }
  }
  if (row.ops_stage === 'PRODUCTION' && row.ops_flow !== 'SUBMIT_END' && !row.mfg_prep_count) {
    // 製造(三浦さん管轄)のターンに入ったのに、製造の準備項目がまだ1つも選ばれていない。
    // 案件登録時には選ばない運用(2026-08-05 社長指示)なので、ここで選定を促す。
    // 誰の番かを頭に書く — 山本さんが自分の仕事だと誤解しないため
    // (この行はスケジュールボードの「選定待ち」にもそのまま出る)
    return { key: 'PREP_SELECT', label: '三浦さん: 製造の準備項目を選ぶ(カードを開いて選択)' };
  }
  if (row.ops_stage === 'BILLING') {
    return row.ops_flow === 'SUBMIT_END'
      ? { key: 'BILLING', label: '請求書を発行して、済んだら完了にする' }
      : { key: 'BILLING', label: '請求書を発行する' };
  }
  if (row.ops_stage === 'INSPECTION') {
    return { key: 'INSPECTION', label: '仕上がりを検品する' };
  }
  if (row.ops_stage === 'DELIVERY') {
    return { key: 'DELIVERY', label: 'お渡し・発送をして、済んだら完了にする' };
  }
  return null;
}

// deps.registerPreparationItems: 準備項目の登録・デザイン担当への割り当て(server.js の実装を注入)。
// 一覧の「🗂 全般へ」でボードに載せたときも、登録画面から載せたときと同じ状態にするために使う
function registerOpsBoardRoutes(app, db, deps = {}) {
  const registerPreparationItems = deps.registerPreparationItems || (() => ({ created: 0 }));
  fs.mkdirSync(ROUGH_UPLOAD_PATH, { recursive: true });

  // バトンタッチ通知の設定状態を起動ログに出す(未設定に気づけるように)
  console.log(isNotifyConfigured()
    ? 'バトンタッチ通知: 有効(Google Chat へ自動投稿します)'
    : 'バトンタッチ通知: 無効(.env の OPS_NOTIFY_GCHAT_WEBHOOK が未設定のため送信しません)');

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
               p.project_kind, p.ops_stage, p.ops_wait_on, p.ops_stage_since, p.item_name, p.ops_flow,
               p.paper_source, p.carve_stage, p.first_draft_due, p.submission_due,
               p.design_revision_round, p.design_revision_note,
               -- 製造(三浦さん管轄)の準備項目がいくつ選ばれているか。
               -- 0のまま「入稿・製造」に入った案件は選定を促す(デザインラフ作成とデザイナー専用項目は数えない)
               (SELECT COUNT(*) FROM case_preparation_items mp
                  JOIN preparation_item_master mpm ON mp.preparation_item_id = mpm.id
                  WHERE mp.case_id = p.id AND mpm.is_designer_item = 0
                    AND mpm.code != 'DESIGN_ROUGH') AS mfg_prep_count,
               -- アイテム名が未入力でも、Web注文フォーム由来の案件は case_items から補える
               (SELECT ci.category FROM case_items ci
                  WHERE ci.case_id = p.id ORDER BY ci.item_no ASC LIMIT 1) AS first_item_category,
               (SELECT ci.sub_category FROM case_items ci
                  WHERE ci.case_id = p.id ORDER BY ci.item_no ASC LIMIT 1) AS first_item_sub_category,
               (SELECT COUNT(*) FROM case_items ci WHERE ci.case_id = p.id) AS item_count,
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
        item_name: r.item_name || '',
        ops_flow: r.ops_flow || 'FULL',
        paper_source: r.paper_source || 'HIYOSHI',
        carve_stage: r.carve_stage || 'ROUGH',
        design_revision_round: r.design_revision_round || 0,
        design_revision_note: r.design_revision_note || '',
        mfg_prep_count: r.mfg_prep_count || 0,
        first_draft_due: r.first_draft_due || '',
        submission_due: r.submission_due || '',
        first_item_category: r.first_item_category || '',
        first_item_sub_category: r.first_item_sub_category || '',
        item_count: r.item_count || 0,
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
        review_steps: REVIEW_STEPS,
        carve_stages: CARVE_STAGES,
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

  // ---- ボードに載せる / 外す ----
  // is_design_ops を切り替えるだけ。案件そのものは消さない(案件の削除は一覧ビューから行う)。
  // 外す: ボードのカード右上の「✕」/ 載せる: HiBoard一覧ビューの「🗂 全般へ」ボタン
  app.patch('/api/ops/cases/:id/membership', (req, res) => {
    try {
      const caseId = parseInt(req.params.id, 10);
      const include = req.body.include === true || req.body.include === 'true' || req.body.include === 1;
      const project = db.prepare('SELECT id, project_name FROM projects WHERE id = ?').get(caseId);
      if (!project) return res.status(404).json({ ok: false, error: '案件が見つかりません' });

      db.prepare('UPDATE projects SET is_design_ops = ?, updated_at = ? WHERE id = ?')
        .run(include ? 1 : 0, new Date().toISOString(), caseId);
      // 載せたときは、登録画面から載せた場合と同じく準備項目をデザイン担当へ用意する
      // (「初校提出」等が無いと鈴木さんのマイスケジュールボードに何も出ないため)
      if (include) registerPreparationItems(caseId, []);
      console.log(`[デザイン進行ボード] 案件#${caseId} を${include ? 'ボードに載せました' : 'ボードから外しました'}(案件は残っています)`);
      res.json({ ok: true, project_name: project.project_name, is_design_ops: include ? 1 : 0 });
    } catch (err) {
      console.error('[デザイン進行ボード] 掲載切り替えでエラー:', err.message);
      res.status(500).json({ ok: false, error: '更新に失敗しました' });
    }
  });

  // ---- 修正で鈴木さんへ戻す(2026-08-07) ----
  // お客様確認後の修正指示を受けて「確認 → 制作」へ戻す往復を1クリックにする。
  // デザインは一度で決まらず修正を数回繰り返すのが普通のため、この操作で
  //   ①段階を「制作」へ戻す(バトンタッチ通知は setStage 経由で自動送信)
  //   ②「初校提出」の完了チェックを外し予定日をクリア(マイスケの未定タスクに再登場させる)
  //   ③修正回数を+1し、修正指示メモ(任意)を保存
  //   ④校正バッジを「修正」にする(値は lib/designer-board.js の PROOF_STAGES と同じ)
  // をまとめて行う。手作業だと②を忘れてカードが出てこない事故が起きるため自動化する
  app.post('/api/ops/cases/:id/return-for-revision', (req, res) => {
    try {
      const caseId = parseInt(req.params.id, 10);
      const project = db.prepare(
        'SELECT id, is_design_ops, design_revision_round FROM projects WHERE id = ?'
      ).get(caseId);
      if (!project) return res.status(404).json({ ok: false, error: '案件が見つかりません' });
      if (!project.is_design_ops) {
        return res.status(400).json({ ok: false, error: 'デザイン進行ボードの案件ではないため、この操作はできません' });
      }

      const note = s((req.body || {}).note, 500);
      const round = (project.design_revision_round || 0) + 1;
      const now = new Date().toISOString();

      db.prepare(`
        UPDATE projects
        SET design_revision_round = ?, design_revision_note = ?, proof_stage = 'REVISION', updated_at = ?
        WHERE id = ?
      `).run(round, note || null, now, caseId);

      // 完了済みの「初校提出」を未着手へ戻す。予定日もクリアして、鈴木さんが
      // 「日付が未定のタスク」から改めて日程を組めるようにする(完了していなければ触らない)。
      // completed_at も必ず一緒に消すこと — status だけ戻すと「未着手なのに完了日時がある」
      // 行になり、completed_at を条件に使う処理(担当の一括解除など)がその行を素通りする
      const reset = db.prepare(`
        UPDATE case_preparation_items SET status = '未着手', scheduled_date = NULL, completed_at = NULL
        WHERE case_id = ? AND status = '完了'
          AND preparation_item_id IN (
            SELECT id FROM preparation_item_master WHERE code = '${FIRST_DRAFT_CODE}'
          )
      `).run(caseId);

      setStage(db, caseId, 'DESIGN');
      console.log(`[オペ段階] 案件#${caseId}: 修正${round}回目で 制作 へ戻しました(初校提出リセット${reset.changes}件)`);
      res.json({ ok: true, design_revision_round: round, design_revision_note: note || null });
    } catch (err) {
      console.error('[オペボード] 修正戻しエラー:', err.message);
      res.status(500).json({ ok: false, error: '更新に失敗しました' });
    }
  });

  // ---- CARVE案件の作業段階 ----
  // 社内(山本さん達)がデザイン進行ボードから切り替える。
  // 鈴木さん本人はマイスケジュールボードから同じ更新を行う(lib/designer-board.js)
  app.patch('/api/ops/cases/:id/carve-stage', (req, res) => {
    try {
      const caseId = parseInt(req.params.id, 10);
      const result = setCarveStage(db, caseId, s(req.body.stage, 20));
      if (result.error) return res.status(result.notFound ? 404 : 400).json({ ok: false, error: result.error });
      res.json({ ok: true, carve_stage: result.carve_stage });
    } catch (err) {
      console.error('[オペボード] CARVE段階更新エラー:', err.message);
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

// CARVE案件の作業段階を更新する本体。社内ボードとデザイナーボードの両方から使う。
// CARVE案件でない案件には設定できない(バッジの意味が無いため)
function setCarveStage(db, caseId, stage) {
  if (!CARVE_STAGE_KEYS.includes(stage)) {
    return { error: '段階の指定が正しくありません' };
  }
  const project = db.prepare('SELECT id, paper_source FROM projects WHERE id = ?').get(caseId);
  if (!project) return { error: '案件が見つかりません', notFound: true };
  if (project.paper_source !== 'CARVE') {
    return { error: 'CARVE案件ではないため、作業段階は設定できません' };
  }
  db.prepare('UPDATE projects SET carve_stage = ?, updated_at = ? WHERE id = ?')
    .run(stage, new Date().toISOString(), caseId);
  console.log(`[CARVE段階] 案件#${caseId}: ${stage} に更新しました`);
  return { carve_stage: stage };
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
  markDeliveredStage,
  listRoughFiles,
  sendRoughFile,
  setStage,
  setCarveStage,
  STAGES,
  STAGE_LABELS,
  CARVE_STAGES,
};
