const crypto = require('crypto');
const path = require('path');
const { completeSheetTask } = require('./todo-notify');
const { advanceOnPrepItemComplete, listRoughFiles, sendRoughFile, setCarveStage, CARVE_STAGES } = require('./ops-board');
const { TASK_KINDS, CARRYOVER_REASONS, CARRYOVER_NOTE_MAX, recordTaskMove, getCarryoverCounts } = require('./task-moves');
const { WORK_STATES, WORK_STATE_KEYS, WORK_NOTE_MAX } = require('./prep-items');

// デザイナー向け マイスケジュールボード。
// リモートワークのデザイン担当(鈴木さん等)が、専用URL(/designer/{token})から
// 自分に割り当てられた作業準備項目(デザインデータ作成など)を週間ボードで確認し、
// ドラッグ&ドロップでの日付移動・見込み時間の入力・完了操作・稼働申告(この日は稼働できない等)を
// 本人側からも行えるようにする。社内側は既存の週間スケジュールボードから同じデータを操作するため、
// どちらから入れ込んでも二重管理にならない。
// トークンはチームリンク・取引先リンクと同じ方式(designer_links)。書き込みは
// 「リンクに紐づく従業員本人の準備項目・稼働予定」だけに限定する。

// 校正の状態(2026-08-07 社長指示)。すべてのタスクカードにバッジで出し、本人が押して切り替える。
// CARVE案件の作業段階(CARVE_STAGES)とは別軸で、両方が並ぶ。案件単位で持つので
// 同じ案件のカードは全部同じ状態になる。もう一度押すと未選択に戻せる
const PROOF_STAGES = [
  { key: 'FIRST_PROOF', label: '初校' },
  { key: 'REVISION', label: '修正' },
  { key: 'APPROVED', label: '校了' },
];
const PROOF_STAGE_KEYS = PROOF_STAGES.map(p => p.key);

// TODOリスト(スプレッドシート)由来のカードの作業段階バッジ「制作/修正/入稿」(2026-09-04 社長指示)。
// 校正バッジ(初校/修正/校了)は案件の準備項目にしか付かず、TODOカードには状態を表すものが
// シートの「未着手/進行中」しか無かった。値は designer_sheet_todo_plans.work_stage に持つ。
// シートは内容と未着手/進行中/完了だけがマスターなので、シート側には書き戻さない
const TODO_STAGES = [
  { key: 'PRODUCTION', label: '制作' },
  { key: 'REVISION', label: '修正' },
  { key: 'SUBMISSION', label: '入稿' },
];
const TODO_STAGE_KEYS = TODO_STAGES.map(p => p.key);
const TODO_STAGE_LABELS = Object.fromEntries(TODO_STAGES.map(p => [p.key, p.label]));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// 稼働申告で時間数だけ指定された場合の開始時刻(旧クライアント互換用のフォールバック)。
// 現在のマイボードは開始/終了の時間帯を直接指定する
const AVAILABILITY_START = '09:00';
const MAX_HOURS_PER_DAY = 14;
// 1日に申告できる時間帯の本数(2026-08-21)。中抜けを挟んで午前・午後・夜と分かれても
// 足りる本数にしつつ、際限なく行を増やして読めない申告になるのを防ぐ
const MAX_WORK_SEGMENTS = 6;
// 稼働申告のひとことメモの文字数上限
const AVAILABILITY_NOTE_MAX = 200;

// 'HH:MM' を分に変換する
function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

// ===== 稼働時間帯(中抜けあり)の扱い =====
// 1日に複数の時間帯を申告できる(例: 9:00〜12:00 と 14:00〜17:00)。
// DBには内訳を work_segments(JSON)に持ちつつ、start_time=最初の開始 / end_time=最後の終了 /
// break_minutes=中抜けの合計 という集約も同時に書く。こうすると案件の自動提案・
// 社内の週間スケジュールボード・業務量レポートが使っている
// 「(end - start) - break」の計算がそのまま正しい稼働時間になり、既存処理を触らずに済む。

// DBのJSON文字列を [{start,end}] に戻す。未設定・壊れた値は null(=従来どおり1本)
function parseSegments(json) {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const segments = parsed
      .map(seg => ({ start: s(seg && seg.start, 5), end: s(seg && seg.end, 5) }))
      .filter(seg => TIME_RE.test(seg.start) && TIME_RE.test(seg.end));
    return segments.length ? segments : null;
  } catch (err) {
    return null;
  }
}

// 時間帯の合計時間。中抜け(時間帯と時間帯の間)は含まない
function segmentsHours(segments) {
  const minutes = segments.reduce((sum, seg) => sum + (toMinutes(seg.end) - toMinutes(seg.start)), 0);
  return Math.max(0, minutes / 60);
}

// 受け取った時間帯の検証と整形。エラー文字列 or 整形済みの配列を返す。
// 開始が早い順に並べ替えたうえで、重なり・逆転・上限をここで弾く
function normalizeSegments(rawSegments) {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return { error: '稼働できる時間帯を1つ以上指定してください' };
  }
  if (rawSegments.length > MAX_WORK_SEGMENTS) {
    return { error: `時間帯は1日${MAX_WORK_SEGMENTS}本までです` };
  }

  const segments = [];
  for (const raw of rawSegments) {
    const start = s(raw && raw.start, 5);
    const end = s(raw && raw.end, 5);
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
      return { error: '時刻は HH:MM で指定してください' };
    }
    if (toMinutes(end) <= toMinutes(start)) {
      return { error: '終了時刻は開始時刻より後にしてください' };
    }
    segments.push({ start, end });
  }

  segments.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  for (let i = 1; i < segments.length; i++) {
    if (toMinutes(segments[i].start) < toMinutes(segments[i - 1].end)) {
      return { error: '時間帯が重なっています。中抜けの時間を空けて指定してください' };
    }
  }
  if (segmentsHours(segments) > MAX_HOURS_PER_DAY) {
    return { error: `稼働時間の合計は${MAX_HOURS_PER_DAY}時間以内で指定してください` };
  }
  return { segments };
}

// 時間帯の配列を schedule_overrides の1行分(集約 + 内訳JSON)に変換する
function segmentsToOverrideRow(segments) {
  const start_time = segments[0].start;
  const end_time = segments[segments.length - 1].end;
  const spanMinutes = toMinutes(end_time) - toMinutes(start_time);
  const workMinutes = segments.reduce((sum, seg) => sum + (toMinutes(seg.end) - toMinutes(seg.start)), 0);
  return {
    start_time,
    end_time,
    break_minutes: Math.max(0, spanMinutes - workMinutes),
    // 1本だけの日は内訳を持たせない(従来と同じ形で保存し、社内側の編集とも素直に噛み合う)
    work_segments: segments.length > 1 ? JSON.stringify(segments) : null,
  };
}

function s(v, max = 200) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}

function getLink(db, where, param) {
  return db.prepare(`
    SELECT dl.*, e.name as employee_name
    FROM designer_links dl JOIN employees e ON dl.employee_id = e.id
    WHERE ${where}
  `).get(param);
}

// 有効なリンクをトークンから引く。無効化済み・不明トークンはnull
function getActiveLink(db, token) {
  const link = getLink(db, 'dl.token = ?', s(token, 64));
  if (!link || link.disabled_at) return null;
  return link;
}

function timeToHours(start, end, breakMinutes) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return Math.max(0, ((eh * 60 + em) - (sh * 60 + sm) - (breakMinutes || 0)) / 60);
}

// その日の稼働可能時間(参考勤務時間)。個別上書き(schedule_overrides)優先、なければ基本スケジュール
function getDayInfo(db, employeeId, dateISO) {
  const override = db.prepare(
    'SELECT * FROM schedule_overrides WHERE employee_id = ? AND work_date = ?'
  ).get(employeeId, dateISO);
  if (override) {
    // メモは「稼働なし」の日にも残せる(例: 終日通院)ので、休みの分岐でも返す
    const note = override.note || '';
    if (override.is_day_off) {
      return { hours: 0, source: 'override', is_day_off: true, start_time: null, end_time: null, segments: [], note };
    }
    // 中抜けのある日は内訳(work_segments)から時間を出す。内訳が無い日は従来どおり
    // 開始〜終了から休憩を引く。どちらも同じ値になるが、内訳がある方を正とする
    const segments = parseSegments(override.work_segments);
    return {
      hours: segments ? segmentsHours(segments)
                      : timeToHours(override.start_time, override.end_time, override.break_minutes),
      source: 'override',
      is_day_off: false,
      // 稼働変更モーダルで現在の申告内容を初期表示するために返す
      start_time: override.start_time,
      end_time: override.end_time,
      segments: segments || (override.start_time && override.end_time
        ? [{ start: override.start_time, end: override.end_time }] : []),
      note,
    };
  }
  const [y, m, d] = dateISO.split('-').map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  const def = db.prepare(
    'SELECT * FROM employee_default_schedule WHERE employee_id = ? AND weekday = ?'
  ).get(employeeId, weekday);
  if (!def || !def.is_working) {
    return { hours: 0, source: 'default', is_day_off: true, start_time: null, end_time: null, segments: [], note: '' };
  }
  return {
    hours: timeToHours(def.start_time, def.end_time, def.break_minutes),
    source: 'default',
    is_day_off: false,
    start_time: def.start_time,
    end_time: def.end_time,
    segments: def.start_time && def.end_time ? [{ start: def.start_time, end: def.end_time }] : [],
    note: '',
  };
}

// ===== 社員用TODOリスト(スプレッドシート)連携 =====
// 秘書ボード連携と同じ Apps Script 読み出しAPI(doGet)から全員分のTODOを取得する。
// .env の TODO_SHEET_WEBAPP_URL / TODO_SHEET_TOKEN(todo-notify.jsと同じ設定)を使い、
// 未設定なら連携なし(null)。ボードを開くたびに叩かないよう60秒キャッシュし、
// 取得失敗時は直近の取得結果があればそれで代用する
const SHEET_TODO_CACHE_TTL_MS = 60 * 1000;
const SHEET_TODO_FETCH_TIMEOUT_MS = 15 * 1000;
let sheetTodoCache = { fetchedAt: 0, tasks: null };

// 完了操作の直後など、次の取得でシートを読み直したいときに呼ぶ
function invalidateSheetTodoCache() {
  sheetTodoCache = { fetchedAt: 0, tasks: null };
}

async function fetchAllSheetTodos() {
  const url = process.env.TODO_SHEET_WEBAPP_URL;
  const token = process.env.TODO_SHEET_TOKEN;
  if (!url || !token) return null;

  const now = Date.now();
  if (sheetTodoCache.tasks && now - sheetTodoCache.fetchedAt < SHEET_TODO_CACHE_TTL_MS) {
    return sheetTodoCache.tasks;
  }
  try {
    const res = await fetch(`${url}?token=${encodeURIComponent(token)}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(SHEET_TODO_FETCH_TIMEOUT_MS),
    });
    const data = await res.json();
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    sheetTodoCache = { fetchedAt: now, tasks };
    return tasks;
  } catch (err) {
    console.error('[デザイナーボード] TODOシート取得失敗:', err.message);
    return sheetTodoCache.tasks;
  }
}

// 従業員に対応するTODOタブの「未着手」「進行中」タスクを抽出する。
// member(タブの担当者名)と従業員名は空白を除いた上での包含で突き合わせる
// (例: 従業員「鈴木　雅」⇔ タブ「鈴木」)。記入例・空行は除外
function extractOpenTodosFor(allTasks, employeeName) {
  const normalize = v => String(v || '').replace(/[\s　]/g, '');
  const empName = normalize(employeeName);
  const matched = allTasks
    .filter(t => {
      const member = normalize(t.member);
      if (!member || !empName) return false;
      if (!empName.includes(member) && !member.includes(empName)) return false;
      const task = String(t.task || '').trim();
      if (!task || task.startsWith('(記入例)')) return false;
      return ['未着手', '進行中'].includes(String(t.status || '').trim());
    })
    .map(t => ({
      task: String(t.task).trim().slice(0, 300),
      status: String(t.status).trim(),
      deadline: String(t.deadline || '').trim(),
      memo: String(t.memo || '').trim().slice(0, 300),
    }));

  // 同じ本文の行が複数あると、予定(task_textで同一視)が全行に効いて日カードに
  // 二重表示されるため、本文で1件にまとめる。状態は「進行中」を優先して残す
  const byText = new Map();
  matched.forEach(t => {
    const existing = byText.get(t.task);
    if (!existing || (existing.status !== '進行中' && t.status === '進行中')) {
      byText.set(t.task, t);
    }
  });
  return [...byText.values()];
}

// シートTODOに、本人が組んだ予定(日付・見込み時間)を突き合わせて付与する。
// シートから消えたタスクの古い計画行は表示に出てこないだけで残るため、
// ここで拾えなかった計画は害にならない(次に同じ本文が現れれば再利用される)。
// 完了済みの計画行(completed_at あり)は業務量レポート用に残しているだけなので突き合わせない —
// 同じ本文のタスクがシートに再登場したときは、予定日なしの新しいタスクとして扱う
function attachTodoPlans(db, employeeId, todos) {
  const plans = db.prepare(
    'SELECT task_text, scheduled_date, estimated_hours, work_stage FROM designer_sheet_todo_plans WHERE employee_id = ? AND completed_at IS NULL'
  ).all(employeeId);
  const planByText = new Map(plans.map(p => [p.task_text, p]));
  return todos.map(t => {
    const plan = planByText.get(t.task);
    return {
      ...t,
      scheduled_date: plan ? plan.scheduled_date : null,
      estimated_hours: plan ? plan.estimated_hours : null,
      work_stage: plan ? (plan.work_stage || null) : null,
    };
  });
}

// 本人の準備項目1件を取得(所有チェック込み)。他人の項目・不明IDはnull
function getOwnPrepItem(db, link, itemId) {
  const item = db.prepare(`
    SELECT cpi.*, pim.name as preparation_item_name, pim.code as preparation_item_code,
           p.project_name, p.deadline, p.project_kind,
           p.ops_flow, p.paper_source, p.carve_stage, p.proof_stage, p.first_draft_due, p.submission_due,
           p.design_revision_round, p.design_revision_note
    FROM case_preparation_items cpi
    JOIN preparation_item_master pim ON cpi.preparation_item_id = pim.id
    JOIN projects p ON cpi.case_id = p.id
    WHERE cpi.id = ?
  `).get(itemId);
  if (!item || item.assigned_staff_id !== link.employee_id) return null;
  return item;
}

// 紙媒体(入稿で完了)案件は、案件全体の納期ではなく工程ごとの納期を出す。
// 「初校はいつまで/入稿はいつまで」が本人の画面で分かるようにするため(2026-08-03)。
// 未設定なら案件の納期にフォールバックする
function itemDue(i) {
  if (i.ops_flow === 'SUBMIT_END') {
    if (i.preparation_item_code === 'FIRST_DRAFT_SUBMIT' && i.first_draft_due) {
      return { date: i.first_draft_due, label: '初校の納期' };
    }
    if (i.preparation_item_code === 'SUBMISSION_COMPLETE' && i.submission_due) {
      return { date: i.submission_due, label: '入稿の納期' };
    }
  }
  return { date: i.deadline, label: '納期' };
}

// 本人が「自分の担当ではない」として手放せない項目。
// この2つは完了操作が案件の段階を前へ進めるトリガーになっているため外させない
const NON_RELEASABLE_CODES = ['FIRST_DRAFT_SUBMIT', 'SUBMISSION_COMPLETE'];

// carryoverCounts: lib/task-moves.js の getCarryoverCounts() の戻り値。
// 何回持ち越したかをチップのバッジに出し、本人にも「流れ続けている」ことが見えるようにする
function itemToJson(i, carryoverCounts = null) {
  const due = itemDue(i);
  return {
    carryover_count: carryoverCounts ? (carryoverCounts.prepItems.get(i.id) || 0) : 0,
    id: i.id,
    case_id: i.case_id,
    project_name: i.project_name,
    deadline: i.deadline,
    due_date: due.date,
    due_label: due.label,
    preparation_item_name: i.preparation_item_name,
    status: i.status,
    scheduled_date: i.scheduled_date,
    estimated_hours: i.estimated_hours,
    // CARVE案件は作業段階(ラフアップ〜入稿)のバッジをチップに出し、本人が切り替えられる
    is_carve: i.ops_flow === 'SUBMIT_END' && i.paper_source === 'CARVE',
    carve_stage: i.carve_stage || 'ROUGH',
    // 校正の状態(初校/修正/校了)。未選択は null
    proof_stage: PROOF_STAGE_KEYS.includes(i.proof_stage) ? i.proof_stage : null,
    // タスク単位の作業状態(作業中/お客様確認中/社内確認待ち)。null=未着手でバッジを出さない
    work_state: WORK_STATE_KEYS.includes(i.work_state) ? i.work_state : null,
    // 「8/18 勝又様に連絡済み」のような申し送り(上書き式・1行)
    work_note: i.work_note || '',
    // 修正往復(2026-08-07)。全般ボードの「✏️ 修正で戻す」で更新され、何往復目かと直近の指示をチップに出す
    revision_round: i.design_revision_round || 0,
    revision_note: i.design_revision_note || '',
    // 「自分の担当ではない」で外せる項目かどうか(ボタンの出し分けに使う)
    releasable: !NON_RELEASABLE_CODES.includes(i.preparation_item_code) && i.status !== '完了',
  };
}

// ===== ルート登録 =====
// deps.syncCaseStatus: 準備項目の完了状態変更時に案件ステータスを同期する関数(server.js内の実装を注入)
function registerDesignerBoardRoutes(app, db, deps = {}) {
  const syncCaseStatus = deps.syncCaseStatus || (() => {});

  // ---- 社内: トークンを覚えずにデザイナーのボードを開くショートカット ----
  // HiBoardヘッダーの「🎨 ◯◯さんの作業予定」から使う。有効なリンクが複数あるときは
  // 最初に発行されたもの(デザイン作業の自動割り当ての既定デザイナーと同じ規則)。
  // 公開ホスト名では外部公開ガードの許可パターン(/designer/{token})に当たらず404になるため、
  // このURLからトークンが外に漏れることはない
  function findDefaultLink() {
    return db.prepare(`
      SELECT dl.token, e.name AS employee_name
      FROM designer_links dl
      JOIN employees e ON dl.employee_id = e.id
      WHERE dl.disabled_at IS NULL AND e.is_active = 1
      ORDER BY dl.created_at ASC LIMIT 1
    `).get();
  }

  app.get('/designer', (req, res) => {
    const link = findDefaultLink();
    // 未発行なら発行画面へ案内する(そこで作ればこのボタンがそのまま使えるようになる)
    if (!link) return res.redirect(302, '/designer-links');
    res.redirect(302, `/designer/${link.token}`);
  });

  // ヘッダーのボタンに担当者名を出すためだけのAPI。トークンは返さない
  app.get('/api/designer-shortcut', (req, res) => {
    const link = findDefaultLink();
    res.json(link ? { ok: true, name: link.employee_name } : { ok: false });
  });

  // ---- 公開: ボードHTML ----
  app.get('/designer/:token', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'designer-board.html'));
  });

  // ---- 公開: 週間ボードデータ ----
  // start(YYYY-MM-DD・月曜想定)から7日分の稼働時間と、本人担当の準備項目を返す
  app.get('/api/designer/:token/board', async (req, res) => {
    try {
      const link = getActiveLink(db, req.params.token);
      if (!link) return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。担当者にお問い合わせください。' });

      const start = s(req.query.start, 10);
      if (!DATE_RE.test(start)) return res.status(400).json({ ok: false, error: 'start は YYYY-MM-DD で指定してください' });

      const [y, m, d] = start.split('-').map(Number);
      const days = [];
      for (let i = 0; i < 7; i++) {
        const dt = new Date(y, m - 1, d + i);
        const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        days.push({ date: iso, ...getDayInfo(db, link.employee_id, iso) });
      }
      const dateSet = days.map(day => day.date);

      // 日別モード申告(デザイン/デザイン関連業務)を各日に付与
      const modeRows = db.prepare(`
        SELECT work_date, mode FROM designer_day_modes
        WHERE employee_id = ? AND work_date BETWEEN ? AND ?
      `).all(link.employee_id, dateSet[0], dateSet[6]);
      const modeByDate = new Map(modeRows.map(r => [r.work_date, r.mode]));
      days.forEach(day => { day.mode = modeByDate.get(day.date) || null; });

      // 週内に予定された項目(完了含む) + 未予定の未完了項目(いつでも週に入れ込めるように全件)。
      //
      // 2026-08-07 社長指示: デザイン進行ボードに載せている案件は、
      // 「制作(DESIGN)」の段階のものだけをこのボードに出す。ブリーフ・ラフ(山本さんの番)と
      // 確認(山本さん↔お客様)の間はデザイン担当の番ではないため、カードごと引っ込める。
      // ⇒ 初校提出を完了すると自動で「確認」へ進むので、その案件のカードはその場で消える。
      //    修正で戻ってきたときは山本さんが段階を「制作」に戻すと再び現れる。
      // ボードに載せていない案件(is_design_ops=0)は段階の概念がないので従来どおり全部出す
      // (通常のプリント案件のデザイン作業・社内デザイン案件が見えなくならないようにするため)。
      // 例外: 紙媒体(入稿で完了 SUBMIT_END)タイプは入稿作業自体がデザイン担当の仕事なので、
      // 「入稿・製造」の間も表示し続ける(入稿完了のチェックで請求へ進み、そこで消える)
      const DESIGNER_TURN_SQL = `
        (p.is_design_ops = 0
          OR p.ops_stage = 'DESIGN'
          OR (p.ops_flow = 'SUBMIT_END' AND p.ops_stage = 'PRODUCTION'))
      `;

      // 紙媒体案件は「初校提出」と「入稿完了」の2枚が最初から並んで見づらいので、
      // 入稿の出番(入稿・製造の段階)が来るまで「入稿完了」のカードは出さない(2026-08-03)。
      // 制作〜確認の間は初校提出だけ、入稿・製造に入ったら入稿完了だけが見える
      const SUBMISSION_ITEM_SQL = `
        (pim.code != 'SUBMISSION_COMPLETE' OR p.ops_stage IN ('PRODUCTION', 'BILLING'))
      `;

      const scheduled = db.prepare(`
        SELECT cpi.*, pim.name as preparation_item_name, pim.code as preparation_item_code,
               p.project_name, p.deadline, p.project_kind,
               p.ops_flow, p.paper_source, p.carve_stage, p.proof_stage, p.first_draft_due, p.submission_due,
               p.design_revision_round, p.design_revision_note
        FROM case_preparation_items cpi
        JOIN preparation_item_master pim ON cpi.preparation_item_id = pim.id
        JOIN projects p ON cpi.case_id = p.id
        WHERE cpi.assigned_staff_id = ? AND cpi.scheduled_date BETWEEN ? AND ?
          AND ${DESIGNER_TURN_SQL}
          AND ${SUBMISSION_ITEM_SQL}
        ORDER BY p.deadline ASC, cpi.id ASC
      `).all(link.employee_id, dateSet[0], dateSet[6]);

      // 納品済み(COMPLETED)案件の項目は納品時に完了扱いにしているので通常はここに来ないが、
      // 万一残っていても「日付が未定のタスク」には出さない(納品したものは本人のやることではない)
      const unscheduled = db.prepare(`
        SELECT cpi.*, pim.name as preparation_item_name, pim.code as preparation_item_code,
               p.project_name, p.deadline, p.project_kind,
               p.ops_flow, p.paper_source, p.carve_stage, p.proof_stage, p.first_draft_due, p.submission_due,
               p.design_revision_round, p.design_revision_note
        FROM case_preparation_items cpi
        JOIN preparation_item_master pim ON cpi.preparation_item_id = pim.id
        JOIN projects p ON cpi.case_id = p.id
        WHERE cpi.assigned_staff_id = ? AND cpi.scheduled_date IS NULL AND cpi.status != '完了'
          AND p.status != 'COMPLETED'
          AND ${DESIGNER_TURN_SQL}
          AND ${SUBMISSION_ITEM_SQL}
        ORDER BY p.deadline ASC, cpi.id ASC
      `).all(link.employee_id);

      // 社員用TODOリスト(スプレッドシート)の本人分「未着手」「進行中」。
      // 連携未設定・取得失敗(キャッシュもなし)の場合は null = フロントでセクション非表示
      const allSheetTodos = await fetchAllSheetTodos();
      const carryoverCounts = getCarryoverCounts(db, link.employee_id);
      const sheet_todos = allSheetTodos
        ? attachTodoPlans(db, link.employee_id, extractOpenTodosFor(allSheetTodos, link.employee_name))
          .map(t => ({ ...t, carryover_count: carryoverCounts.sheetTodos.get(t.task) || 0 }))
        : null;

      // 案件ごとのデザインラフ(オペレーション担当が描いた下絵)。
      // 社外からはNASを見られないので、このボード経由で開けるようトークン付きURLを一緒に返す
      const caseIds = [...new Set([...scheduled, ...unscheduled].map(i => i.case_id))];
      const rough_files = {};
      caseIds.forEach(caseId => {
        const files = listRoughFiles(db, caseId);
        if (files.length) {
          rough_files[caseId] = files.map(f => ({
            id: f.id,
            original_name: f.original_name,
            note: f.note,
            url: `/api/designer/${encodeURIComponent(req.params.token)}/rough/${f.id}`,
          }));
        }
      });

      res.json({
        ok: true,
        designer_name: link.employee_name,
        days,
        scheduled: scheduled.map(i => itemToJson(i, carryoverCounts)),
        unscheduled: unscheduled.map(i => itemToJson(i, carryoverCounts)),
        sheet_todos,
        rough_files,
        carve_stages: CARVE_STAGES,
        proof_stages: PROOF_STAGES,
        todo_stages: TODO_STAGES,
        carryover_reasons: CARRYOVER_REASONS,
        carryover_note_max: CARRYOVER_NOTE_MAX,
        work_states: WORK_STATES,
        work_note_max: WORK_NOTE_MAX,
        max_work_segments: MAX_WORK_SEGMENTS,
        availability_note_max: AVAILABILITY_NOTE_MAX,
      });
    } catch (err) {
      console.error('[デザイナーボード] データ取得エラー:', err.message);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。しばらくしてから再度お試しください。' });
    }
  });

  // ---- 公開: デザインラフの実体を返す ----
  // 自分に割り当てられた準備項目がある案件のラフだけを開ける(他案件のIDを入れても404)
  app.get('/api/designer/:token/rough/:fileId', (req, res) => {
    const link = getActiveLink(db, req.params.token);
    if (!link) return res.status(404).send('このページは現在ご利用いただけません');

    const file = db.prepare(`
      SELECT rf.* FROM case_rough_files rf
      WHERE rf.id = ? AND EXISTS (
        SELECT 1 FROM case_preparation_items cpi
        WHERE cpi.case_id = rf.case_id AND cpi.assigned_staff_id = ?
      )
    `).get(parseInt(req.params.fileId, 10), link.employee_id);
    if (!file) return res.status(404).send('見つかりません');

    sendRoughFile(res, file);
  });

  // ---- 公開: 準備項目の更新(日付移動・見込み時間・完了/未着手) ----
  // 本人に割り当てられた項目のみ。担当者の付け替え(assigned_staff_id)はここでは許可しない
  app.put('/api/designer/:token/items/:id', (req, res) => {
    try {
      const link = getActiveLink(db, req.params.token);
      if (!link) return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。' });

      const item = getOwnPrepItem(db, link, req.params.id);
      if (!item) return res.status(404).json({ ok: false, error: '対象のタスクが見つかりません' });

      const body = req.body || {};

      let scheduled_date = item.scheduled_date;
      if (body.scheduled_date !== undefined) {
        if (body.scheduled_date === null || body.scheduled_date === '') {
          scheduled_date = null;
        } else if (DATE_RE.test(s(body.scheduled_date, 10))) {
          scheduled_date = s(body.scheduled_date, 10);
        } else {
          return res.status(400).json({ ok: false, error: '日付は YYYY-MM-DD で指定してください' });
        }
      }

      let estimated_hours = item.estimated_hours;
      if (body.estimated_hours !== undefined) {
        const h = Number(body.estimated_hours);
        if (Number.isNaN(h) || h < 0 || h > MAX_HOURS_PER_DAY) {
          return res.status(400).json({ ok: false, error: `見込み時間は0〜${MAX_HOURS_PER_DAY}時間で指定してください` });
        }
        estimated_hours = h;
      }

      let status = item.status;
      if (body.status !== undefined) {
        if (!['未着手', '完了'].includes(body.status)) {
          return res.status(400).json({ ok: false, error: 'status は 未着手/完了 のみ指定できます' });
        }
        status = body.status;
      }
      const completed_at = status === '完了'
        ? (item.status === '完了' ? item.completed_at : new Date().toISOString())
        : null;

      // タスク単位の作業状態(作業中/お客様確認中/社内確認待ち)。空文字で未着手(バッジなし)に戻す
      let work_state = item.work_state;
      if (body.work_state !== undefined) {
        const w = s(body.work_state, 20);
        if (w && !WORK_STATE_KEYS.includes(w)) {
          return res.status(400).json({ ok: false, error: '状態の指定が正しくありません' });
        }
        work_state = w || null;
      }

      // ひとことメモ(上書き式)。空文字で消せる
      let work_note = item.work_note;
      if (body.work_note !== undefined) {
        work_note = s(body.work_note, WORK_NOTE_MAX) || null;
      }

      // 完了にしたら作業状態のバッジは外す。「完了なのにお客様確認中」の矛盾した表示を残さない
      // (メモは申し送りとして残す — 誰にいつ連絡したかは完了後も参照したいため)
      if (status === '完了') work_state = null;

      db.prepare(`
        UPDATE case_preparation_items
        SET scheduled_date=?, estimated_hours=?, status=?, completed_at=?, work_state=?, work_note=?
        WHERE id=?
      `).run(scheduled_date, estimated_hours, status, completed_at, work_state, work_note, item.id);

      // 予定日を動かしたら履歴に1行残す(業務量レポートの元データ)。
      // 完了にしながら日付も動かした場合は業務量の持ち越しではないので記録しない。
      // 見込み時間は「動かした時点の値」= 更新後の値を残す(残量を申告して持ち越すため)
      if (scheduled_date !== item.scheduled_date && status !== '完了') {
        recordTaskMove(db, {
          employeeId: link.employee_id,
          taskKind: TASK_KINDS.PREP_ITEM,
          prepItemId: item.id,
          taskLabel: item.preparation_item_name,
          fromDate: item.scheduled_date,
          toDate: scheduled_date,
          estimatedHours: estimated_hours,
          carryoverReason: s(body.carryover_reason, 20) || null,
          carryoverNote: s(body.carryover_note, CARRYOVER_NOTE_MAX) || null,
        });
      }

      if (status !== item.status) {
        syncCaseStatus(item.case_id);
        // 「初校提出」「外注用デザインデータ作成」の完了はオペレーション段階を前へ進める。
        // 未着手へ戻した場合は巻き戻さない(戻す操作はオペレーション担当が画面から行う)
        if (status === '完了') {
          advanceOnPrepItemComplete(db, item.case_id, item.preparation_item_code);
        }
      }

      const updated = getOwnPrepItem(db, link, item.id);
      res.json({ ok: true, item: itemToJson(updated) });
    } catch (err) {
      console.error('[デザイナーボード] タスク更新エラー:', err.message);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。' });
    }
  });

  // ---- 公開: 「自分の担当ではない」としてタスクを手放す ----
  // 加工だけの追加注文で製造側の準備項目が紛れ込むなど、本人がやらない作業がボードに
  // 積まれることがある。毎回こちらで直すのではなく、本人がその場で下ろせるようにする
  // (2026-08-18 社長指示)。担当と予定日を外すだけで、項目自体は消さない —
  // 未割り当ての準備項目として週間スケジュールボードの一覧に出るので、
  // 三浦さんが改めて担当を決められる
  //
  // 「初校提出」「入稿完了」は本人が完了操作をすることで案件の段階が前へ進む仕組みなので
  // 手放せないようにしている(NON_RELEASABLE_CODES)。これを外すと案件が制作段階に居座り続ける
  app.post('/api/designer/:token/items/:id/release', (req, res) => {
    try {
      const link = getActiveLink(db, req.params.token);
      if (!link) return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。' });

      const item = getOwnPrepItem(db, link, req.params.id);
      if (!item) return res.status(404).json({ ok: false, error: '対象のタスクが見つかりません' });

      if (NON_RELEASABLE_CODES.includes(item.preparation_item_code)) {
        return res.status(400).json({
          ok: false,
          error: `「${item.preparation_item_name}」は案件を次の段階へ進めるための作業なので、ここでは外せません。この案件自体が自分の担当でない場合は社長へご連絡ください。`
        });
      }
      if (item.status === '完了') {
        return res.status(400).json({ ok: false, error: '完了したタスクは外せません' });
      }

      db.prepare(`
        UPDATE case_preparation_items
        SET assigned_staff_id = NULL, scheduled_date = NULL, designer_released_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), item.id);

      console.log(`[デザイナーボード] 従業員#${link.employee_id} が準備項目#${item.id}(${item.preparation_item_name})を担当から外しました`);
      res.json({ ok: true, released: true });
    } catch (err) {
      console.error('[デザイナーボード] タスク解除エラー:', err.message);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。' });
    }
  });

  // ---- 公開: CARVE案件の作業段階の切り替え ----
  // 本人に割り当てられた準備項目がある案件だけ更新できる(他案件のIDを入れても404)。
  // 社内はデザイン進行ボードから同じ更新を行う(lib/ops-board.js)
  app.put('/api/designer/:token/cases/:caseId/carve-stage', (req, res) => {
    try {
      const link = getActiveLink(db, req.params.token);
      if (!link) return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。' });

      const caseId = parseInt(req.params.caseId, 10);
      const owns = db.prepare(`
        SELECT 1 FROM case_preparation_items WHERE case_id = ? AND assigned_staff_id = ? LIMIT 1
      `).get(caseId, link.employee_id);
      if (!owns) return res.status(404).json({ ok: false, error: '対象の案件が見つかりません' });

      const result = setCarveStage(db, caseId, s((req.body || {}).stage, 20));
      if (result.error) return res.status(result.notFound ? 404 : 400).json({ ok: false, error: result.error });
      res.json({ ok: true, carve_stage: result.carve_stage });
    } catch (err) {
      console.error('[デザイナーボード] CARVE段階更新エラー:', err.message);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。' });
    }
  });

  // ---- 公開: 校正の状態(初校/修正/校了) ----
  // 案件単位で持つので、同じ案件のカードは全部同じ状態になる。
  // stage を空で送ると未選択に戻す(同じバッジをもう一度押したとき)
  app.put('/api/designer/:token/cases/:caseId/proof-stage', (req, res) => {
    try {
      const link = getActiveLink(db, req.params.token);
      if (!link) return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。' });

      const caseId = parseInt(req.params.caseId, 10);
      const owns = db.prepare(`
        SELECT 1 FROM case_preparation_items WHERE case_id = ? AND assigned_staff_id = ? LIMIT 1
      `).get(caseId, link.employee_id);
      if (!owns) return res.status(404).json({ ok: false, error: '対象の案件が見つかりません' });

      const stage = s((req.body || {}).stage, 20) || null;
      if (stage && !PROOF_STAGE_KEYS.includes(stage)) {
        return res.status(400).json({ ok: false, error: '状態の指定が正しくありません' });
      }
      db.prepare('UPDATE projects SET proof_stage = ?, updated_at = ? WHERE id = ?')
        .run(stage, new Date().toISOString(), caseId);
      res.json({ ok: true, proof_stage: stage });
    } catch (err) {
      console.error('[デザイナーボード] 校正状態の更新エラー:', err.message);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。' });
    }
  });

  // ---- 公開: 稼働申告(この日は稼働できない/時間短縮/既定に戻す) ----
  // schedule_overrides に書き込むため、社内の週間スケジュールボードにもそのまま反映される
  app.post('/api/designer/:token/availability', (req, res) => {
    try {
      const link = getActiveLink(db, req.params.token);
      if (!link) return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。' });

      const body = req.body || {};
      const work_date = s(body.work_date, 10);
      if (!DATE_RE.test(work_date)) return res.status(400).json({ ok: false, error: '日付は YYYY-MM-DD で指定してください' });

      const mode = s(body.mode, 10); // 'off' | 'hours' | 'clear'
      // その日の事情をひとこと残せる(例: 10時から通院のため中抜け)。空文字で消せる
      const note = s(body.note, AVAILABILITY_NOTE_MAX) || null;
      const existing = db.prepare(
        'SELECT id FROM schedule_overrides WHERE employee_id = ? AND work_date = ?'
      ).get(link.employee_id, work_date);

      if (mode === 'clear') {
        if (existing) db.prepare('DELETE FROM schedule_overrides WHERE id = ?').run(existing.id);
      } else if (mode === 'off') {
        if (existing) {
          db.prepare(`UPDATE schedule_overrides SET is_day_off=1, start_time=NULL, end_time=NULL, break_minutes=0, work_segments=NULL, note=? WHERE id=?`)
            .run(note, existing.id);
        } else {
          db.prepare(`
            INSERT INTO schedule_overrides (employee_id, work_date, start_time, end_time, break_minutes, is_day_off, work_segments, note)
            VALUES (?, ?, NULL, NULL, 0, 1, NULL, ?)
          `).run(link.employee_id, work_date, note);
        }
      } else if (mode === 'hours') {
        // 稼働できる時間帯の指定。中抜けする日は複数本(例: 9:00〜12:00 と 14:00〜17:00)送れる。
        // 旧クライアント互換のため、start_time/end_time 1組の指定と hours(時間数)だけの
        // 指定も引き続き受け付ける(後者は従来どおり AVAILABILITY_START 開始として時刻に変換する)
        let rawSegments = body.segments;
        if (!Array.isArray(rawSegments)) {
          const start_time = s(body.start_time, 5);
          const end_time = s(body.end_time, 5);
          if (start_time || end_time) {
            rawSegments = [{ start: start_time, end: end_time }];
          } else {
            const h = Number(body.hours);
            if (Number.isNaN(h) || h <= 0 || h > MAX_HOURS_PER_DAY) {
              return res.status(400).json({ ok: false, error: `稼働時間は0より大きく${MAX_HOURS_PER_DAY}時間以内で指定してください` });
            }
            const [sh, sm] = AVAILABILITY_START.split(':').map(Number);
            const endMinutes = sh * 60 + sm + Math.round(h * 60);
            rawSegments = [{
              start: AVAILABILITY_START,
              end: `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`,
            }];
          }
        }

        const normalized = normalizeSegments(rawSegments);
        if (normalized.error) return res.status(400).json({ ok: false, error: normalized.error });
        const row = segmentsToOverrideRow(normalized.segments);

        if (existing) {
          db.prepare(`UPDATE schedule_overrides SET is_day_off=0, start_time=?, end_time=?, break_minutes=?, work_segments=?, note=? WHERE id=?`)
            .run(row.start_time, row.end_time, row.break_minutes, row.work_segments, note, existing.id);
        } else {
          db.prepare(`
            INSERT INTO schedule_overrides (employee_id, work_date, start_time, end_time, break_minutes, is_day_off, work_segments, note)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?)
          `).run(link.employee_id, work_date, row.start_time, row.end_time, row.break_minutes, row.work_segments, note);
        }
      } else {
        return res.status(400).json({ ok: false, error: 'mode は off / hours / clear のいずれかで指定してください' });
      }

      res.json({ ok: true, day: { date: work_date, ...getDayInfo(db, link.employee_id, work_date) } });
    } catch (err) {
      console.error('[デザイナーボード] 稼働申告エラー:', err.message);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。' });
    }
  });

  // ---- 公開: TODOリスト(スプレッドシート)タスクを完了にする ----
  // タスクの状態はシートがマスターのため、HiBoard側には持たずシートへ書き戻す。
  // 完了したタスクは次回の取得(未着手/進行中のみ抽出)で自然に一覧から消える
  app.post('/api/designer/:token/sheet-todo-complete', async (req, res) => {
    try {
      const link = getActiveLink(db, req.params.token);
      if (!link) return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。' });

      const task_text = s((req.body || {}).task_text, 300);
      if (!task_text) return res.status(400).json({ ok: false, error: 'タスクを指定してください' });

      const result = await completeSheetTask({ member: link.employee_name, task: task_text });
      // ここで 5xx を返すと Cloudflare が独自のエラーページ(text/plain)に差し替えてしまい、
      // 画面側は本文をJSONとして読めず「通信エラー」としか出せない(2026-07-28に実機で確認)。
      // 失敗の理由を利用者に見せたいので、200 + ok:false で返す
      if (!result.ok) return res.json({ ok: false, error: result.error });

      // 完了させた分は計画行を消さず、完了日時だけ入れる。
      // 完了済みの行は attachTodoPlans が拾わないので日カードからは消えるが、
      // 「その日に計画され、その日に終わった分」として業務量レポートに残る
      // (消してしまうと、終わらせた日ほど計画が少なかったように見えてしまう)
      const completedAt = new Date().toISOString();
      db.prepare('UPDATE designer_sheet_todo_plans SET completed_at = ?, updated_at = ? WHERE employee_id = ? AND task_text = ?')
        .run(completedAt, completedAt, link.employee_id, task_text);
      // 60秒キャッシュのままだと完了直後の再読み込みで消えたように見えないため破棄する
      invalidateSheetTodoCache();

      console.log(`[デザイナーボード] TODOを完了: ${link.employee_name} / ${task_text.slice(0, 60)}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('[デザイナーボード] TODO完了エラー:', err.message);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。' });
    }
  });

  // ---- 公開: TODOリスト(スプレッドシート)タスクの予定を組む ----
  // シート行にIDが無いためタスク本文で同一視する。日付(scheduled_date)と見込み時間だけを
  // HiBoard側に持ち、タスクの内容・状態はシートがマスターのまま。
  // scheduled_date に null を渡すと予定を解除してTODOリストへ戻す
  app.put('/api/designer/:token/sheet-todo-plan', (req, res) => {
    try {
      const link = getActiveLink(db, req.params.token);
      if (!link) return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。' });

      const body = req.body || {};
      const task_text = s(body.task_text, 300);
      if (!task_text) return res.status(400).json({ ok: false, error: 'タスクを指定してください' });

      let scheduled_date = null;
      if (body.scheduled_date) {
        if (!DATE_RE.test(s(body.scheduled_date, 10))) {
          return res.status(400).json({ ok: false, error: '日付は YYYY-MM-DD で指定してください' });
        }
        scheduled_date = s(body.scheduled_date, 10);
      }

      const existing = db.prepare(
        'SELECT * FROM designer_sheet_todo_plans WHERE employee_id = ? AND task_text = ?'
      ).get(link.employee_id, task_text);

      let estimated_hours = existing ? existing.estimated_hours : null;
      if (body.estimated_hours !== undefined) {
        if (body.estimated_hours === null || body.estimated_hours === '') {
          estimated_hours = null;
        } else {
          const h = Number(body.estimated_hours);
          if (Number.isNaN(h) || h < 0 || h > MAX_HOURS_PER_DAY) {
            return res.status(400).json({ ok: false, error: `見込み時間は0〜${MAX_HOURS_PER_DAY}時間で指定してください` });
          }
          estimated_hours = h;
        }
      }

      // 予定日を動かしたら履歴に1行残す(業務量レポートの元データ)。
      // 行を消すケース(下)でも「予定日 → 未定」は持ち越しなので、消す前にここで記録する
      const previousDate = existing && !existing.completed_at ? existing.scheduled_date : null;
      if (scheduled_date !== previousDate) {
        recordTaskMove(db, {
          employeeId: link.employee_id,
          taskKind: TASK_KINDS.SHEET_TODO,
          taskText: task_text,
          taskLabel: task_text,
          fromDate: previousDate,
          toDate: scheduled_date,
          estimatedHours: estimated_hours,
          carryoverReason: s(body.carryover_reason, 20) || null,
          carryoverNote: s(body.carryover_note, CARRYOVER_NOTE_MAX) || null,
        });
      }

      // 予定日も見込み時間も無くなったら行ごと削除(不要な行を溜めない)。
      // 完了済みの行は業務量レポートの元データなので消さない。
      // 作業段階バッジ(work_stage)が付いている行は、未定に戻してもバッジを保つため残す
      const hasStage = !!(existing && !existing.completed_at && existing.work_stage);
      if (scheduled_date === null && (estimated_hours === null || estimated_hours === 0) && !hasStage) {
        if (existing && !existing.completed_at) {
          db.prepare('DELETE FROM designer_sheet_todo_plans WHERE id = ?').run(existing.id);
        }
        return res.json({ ok: true, plan: { task_text, scheduled_date: null, estimated_hours: null, work_stage: null } });
      }

      // 完了済みの行に同じ本文で予定を入れ直したときは、新しいタスクとして完了を外す
      // (前回の作業段階バッジも引き継がない)
      db.prepare(`
        INSERT INTO designer_sheet_todo_plans (employee_id, task_text, scheduled_date, estimated_hours, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(employee_id, task_text) DO UPDATE SET
          scheduled_date = excluded.scheduled_date,
          estimated_hours = excluded.estimated_hours,
          work_stage = CASE WHEN designer_sheet_todo_plans.completed_at IS NULL THEN designer_sheet_todo_plans.work_stage ELSE NULL END,
          completed_at = NULL,
          updated_at = excluded.updated_at
      `).run(link.employee_id, task_text, scheduled_date, estimated_hours, new Date().toISOString());

      const saved = db.prepare('SELECT work_stage FROM designer_sheet_todo_plans WHERE employee_id = ? AND task_text = ?')
        .get(link.employee_id, task_text);
      res.json({ ok: true, plan: { task_text, scheduled_date, estimated_hours, work_stage: saved ? (saved.work_stage || null) : null } });
    } catch (err) {
      console.error('[デザイナーボード] TODO予定の保存エラー:', err.message);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。' });
    }
  });

  // ---- 公開: TODOリスト(スプレッドシート)タスクの作業段階バッジ(制作/修正/入稿) ----
  // 校正バッジ(proof-stage)のTODO版。stage に空を渡すと未選択に戻す。
  // 予定日・見込み時間と同じ行(designer_sheet_todo_plans)に持ち、タスク本文で同一視する
  app.put('/api/designer/:token/sheet-todo-stage', (req, res) => {
    try {
      const link = getActiveLink(db, req.params.token);
      if (!link) return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。' });

      const body = req.body || {};
      const task_text = s(body.task_text, 300);
      if (!task_text) return res.status(400).json({ ok: false, error: 'タスクを指定してください' });
      const stage = s(body.stage, 20) || null;
      if (stage && !TODO_STAGE_KEYS.includes(stage)) {
        return res.status(400).json({ ok: false, error: '状態の指定が正しくありません' });
      }

      const existing = db.prepare(
        'SELECT * FROM designer_sheet_todo_plans WHERE employee_id = ? AND task_text = ?'
      ).get(link.employee_id, task_text);
      const now = new Date().toISOString();

      if (!stage) {
        // 未選択に戻す。予定日も見込み時間も無い行は消して、不要な行を溜めない
        if (existing && !existing.completed_at) {
          const bare = existing.scheduled_date === null
            && (existing.estimated_hours === null || existing.estimated_hours === 0);
          if (bare) db.prepare('DELETE FROM designer_sheet_todo_plans WHERE id = ?').run(existing.id);
          else db.prepare('UPDATE designer_sheet_todo_plans SET work_stage = NULL, updated_at = ? WHERE id = ?').run(now, existing.id);
        }
        return res.json({ ok: true, work_stage: null });
      }

      // 完了済みの行に同じ本文で状態を付け直したときは、新しいタスクとして予定を空から始める
      db.prepare(`
        INSERT INTO designer_sheet_todo_plans (employee_id, task_text, scheduled_date, estimated_hours, work_stage, updated_at)
        VALUES (?, ?, NULL, NULL, ?, ?)
        ON CONFLICT(employee_id, task_text) DO UPDATE SET
          work_stage = excluded.work_stage,
          scheduled_date = CASE WHEN designer_sheet_todo_plans.completed_at IS NULL THEN designer_sheet_todo_plans.scheduled_date ELSE NULL END,
          estimated_hours = CASE WHEN designer_sheet_todo_plans.completed_at IS NULL THEN designer_sheet_todo_plans.estimated_hours ELSE NULL END,
          completed_at = NULL,
          updated_at = excluded.updated_at
      `).run(link.employee_id, task_text, stage, now);

      res.json({ ok: true, work_stage: stage });
    } catch (err) {
      console.error('[デザイナーボード] TODO作業段階の更新エラー:', err.message);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。' });
    }
  });

  // ---- 公開: 日別モード申告(デザイン/デザイン関連業務) ----
  // 「この日はデザインに専念したい」等の本人の意向を社内(週間スケジュールボード)へ伝えるバッジ。
  // mode: 'DESIGN' | 'DESIGN_RELATED' | null(解除)
  app.post('/api/designer/:token/day-mode', (req, res) => {
    try {
      const link = getActiveLink(db, req.params.token);
      if (!link) return res.status(404).json({ ok: false, error: 'このページは現在ご利用いただけません。' });

      const body = req.body || {};
      const work_date = s(body.work_date, 10);
      if (!DATE_RE.test(work_date)) return res.status(400).json({ ok: false, error: '日付は YYYY-MM-DD で指定してください' });

      const mode = body.mode === null || body.mode === '' ? null : s(body.mode, 20);
      if (mode !== null && !['DESIGN', 'DESIGN_RELATED'].includes(mode)) {
        return res.status(400).json({ ok: false, error: 'mode は DESIGN / DESIGN_RELATED / null のいずれかで指定してください' });
      }

      if (mode === null) {
        db.prepare('DELETE FROM designer_day_modes WHERE employee_id = ? AND work_date = ?')
          .run(link.employee_id, work_date);
      } else {
        db.prepare(`
          INSERT INTO designer_day_modes (employee_id, work_date, mode, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(employee_id, work_date) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at
        `).run(link.employee_id, work_date, mode, new Date().toISOString());
      }

      res.json({ ok: true, day: { date: work_date, mode } });
    } catch (err) {
      console.error('[デザイナーボード] 日別モード申告エラー:', err.message);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。' });
    }
  });

  // ===== 管理側(社内) =====

  // ---- 管理: 週間スケジュールボード用。デザイナーが日付に置いたTODOリストのタスク ----
  // タスク本文はシート由来(顧客名等を含みうる)だが、社内LANの管理画面にのみ返す
  app.get('/api/designer-sheet-todo-plans', (req, res) => {
    try {
      const { start, end } = req.query;
      if (!start || !end) return res.status(400).json({ error: 'start と end を指定してください' });
      const rows = db.prepare(`
        SELECT employee_id, task_text, scheduled_date, estimated_hours, work_stage
        FROM designer_sheet_todo_plans
        WHERE scheduled_date BETWEEN ? AND ?
        ORDER BY scheduled_date ASC, id ASC
      `).all(start, end);
      // 作業段階バッジ(制作/修正/入稿)は表示用のラベルも一緒に返す
      res.json(rows.map(r => ({ ...r, work_stage_label: TODO_STAGE_LABELS[r.work_stage] || '' })));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ---- 管理: 一覧 ----
  app.get('/api/designer-links', (req, res) => {
    const links = db.prepare(`
      SELECT dl.*, e.name as employee_name, e.is_active as employee_is_active
      FROM designer_links dl JOIN employees e ON dl.employee_id = e.id
      ORDER BY dl.created_at DESC
    `).all();
    res.json({ public_base: process.env.PUBLIC_ORDER_BASE_URL || '', links });
  });

  // ---- 管理: 発行 ----
  app.post('/api/designer-links', (req, res) => {
    const employee_id = Number((req.body || {}).employee_id);
    const memo = s((req.body || {}).memo, 500);
    const employee = db.prepare('SELECT id FROM employees WHERE id = ? AND is_active = 1').get(employee_id);
    if (!employee) return res.status(400).json({ errors: ['有効な従業員を選択してください'] });

    const now = new Date().toISOString();
    const token = crypto.randomBytes(16).toString('hex');
    const info = db.prepare(`
      INSERT INTO designer_links (token, employee_id, memo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(token, employee_id, memo, now, now);
    console.log(`[デザイナーリンク] 発行: #${info.lastInsertRowid}`);
    res.status(201).json(getLink(db, 'dl.id = ?', info.lastInsertRowid));
  });

  // ---- 管理: 無効化/再有効化のトグル ----
  app.post('/api/designer-links/:id/toggle', (req, res) => {
    const link = db.prepare('SELECT id, disabled_at FROM designer_links WHERE id = ?').get(req.params.id);
    if (!link) return res.status(404).json({ error: 'リンクが見つかりません' });
    const now = new Date().toISOString();
    db.prepare('UPDATE designer_links SET disabled_at = ?, updated_at = ? WHERE id = ?')
      .run(link.disabled_at ? null : now, now, link.id);
    console.log(`[デザイナーリンク] #${link.id} を${link.disabled_at ? '再有効化' : '無効化'}`);
    res.json(getLink(db, 'dl.id = ?', link.id));
  });

  // ---- 管理: 画面 ----
  app.get('/designer-links', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'designer-links.html'));
  });
}

// getDayInfo は業務量レポート(lib/workload-report.js)でも使う。
// 稼働時間の出し方を2か所に書くとレポートとボードで数字がずれるため、ここから使い回す
module.exports = { registerDesignerBoardRoutes, getDayInfo };
