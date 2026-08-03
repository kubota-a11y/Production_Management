const crypto = require('crypto');
const path = require('path');
const { completeSheetTask } = require('./todo-notify');
const { advanceOnPrepItemComplete, listRoughFiles, sendRoughFile } = require('./ops-board');

// デザイナー向け マイスケジュールボード。
// リモートワークのデザイン担当(鈴木さん等)が、専用URL(/designer/{token})から
// 自分に割り当てられた作業準備項目(デザインデータ作成など)を週間ボードで確認し、
// ドラッグ&ドロップでの日付移動・見込み時間の入力・完了操作・稼働申告(この日は稼働できない等)を
// 本人側からも行えるようにする。社内側は既存の週間スケジュールボードから同じデータを操作するため、
// どちらから入れ込んでも二重管理にならない。
// トークンはチームリンク・取引先リンクと同じ方式(designer_links)。書き込みは
// 「リンクに紐づく従業員本人の準備項目・稼働予定」だけに限定する。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// 稼働申告で時間数だけ指定された場合の開始時刻(旧クライアント互換用のフォールバック)。
// 現在のマイボードは開始/終了の時間帯を直接指定する
const AVAILABILITY_START = '09:00';
const MAX_HOURS_PER_DAY = 14;

// 'HH:MM' を分に変換する
function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
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
    if (override.is_day_off) return { hours: 0, source: 'override', is_day_off: true, start_time: null, end_time: null };
    return {
      hours: timeToHours(override.start_time, override.end_time, override.break_minutes),
      source: 'override',
      is_day_off: false,
      // 稼働変更モーダルで現在の申告内容を初期表示するために返す
      start_time: override.start_time,
      end_time: override.end_time,
    };
  }
  const [y, m, d] = dateISO.split('-').map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  const def = db.prepare(
    'SELECT * FROM employee_default_schedule WHERE employee_id = ? AND weekday = ?'
  ).get(employeeId, weekday);
  if (!def || !def.is_working) return { hours: 0, source: 'default', is_day_off: true, start_time: null, end_time: null };
  return {
    hours: timeToHours(def.start_time, def.end_time, def.break_minutes),
    source: 'default',
    is_day_off: false,
    start_time: def.start_time,
    end_time: def.end_time,
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
// シートから消えた/完了になったタスクの古い計画行は表示に出てこないだけで残るため、
// ここで拾えなかった計画は害にならない(次に同じ本文が現れれば再利用される)
function attachTodoPlans(db, employeeId, todos) {
  const plans = db.prepare(
    'SELECT task_text, scheduled_date, estimated_hours FROM designer_sheet_todo_plans WHERE employee_id = ?'
  ).all(employeeId);
  const planByText = new Map(plans.map(p => [p.task_text, p]));
  return todos.map(t => {
    const plan = planByText.get(t.task);
    return {
      ...t,
      scheduled_date: plan ? plan.scheduled_date : null,
      estimated_hours: plan ? plan.estimated_hours : null,
    };
  });
}

// 本人の準備項目1件を取得(所有チェック込み)。他人の項目・不明IDはnull
function getOwnPrepItem(db, link, itemId) {
  const item = db.prepare(`
    SELECT cpi.*, pim.name as preparation_item_name, pim.code as preparation_item_code,
           p.project_name, p.deadline, p.project_kind
    FROM case_preparation_items cpi
    JOIN preparation_item_master pim ON cpi.preparation_item_id = pim.id
    JOIN projects p ON cpi.case_id = p.id
    WHERE cpi.id = ?
  `).get(itemId);
  if (!item || item.assigned_staff_id !== link.employee_id) return null;
  return item;
}

function itemToJson(i) {
  return {
    id: i.id,
    case_id: i.case_id,
    project_name: i.project_name,
    deadline: i.deadline,
    preparation_item_name: i.preparation_item_name,
    status: i.status,
    scheduled_date: i.scheduled_date,
    estimated_hours: i.estimated_hours,
  };
}

// ===== ルート登録 =====
// deps.syncCaseStatus: 準備項目の完了状態変更時に案件ステータスを同期する関数(server.js内の実装を注入)
function registerDesignerBoardRoutes(app, db, deps = {}) {
  const syncCaseStatus = deps.syncCaseStatus || (() => {});

  // ---- 社内: トークンを覚えずにデザイナーのボードを開くショートカット ----
  // HiBoardヘッダーの「🎨 ◯◯さんの予定」から使う。有効なリンクが複数あるときは
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

      // 週内に予定された項目(完了含む) + 未予定の未完了項目(いつでも週に入れ込めるように全件)
      const scheduled = db.prepare(`
        SELECT cpi.*, pim.name as preparation_item_name, p.project_name, p.deadline, p.project_kind
        FROM case_preparation_items cpi
        JOIN preparation_item_master pim ON cpi.preparation_item_id = pim.id
        JOIN projects p ON cpi.case_id = p.id
        WHERE cpi.assigned_staff_id = ? AND cpi.scheduled_date BETWEEN ? AND ?
        ORDER BY p.deadline ASC, cpi.id ASC
      `).all(link.employee_id, dateSet[0], dateSet[6]);

      // 納品済み(COMPLETED)案件の項目は納品時に完了扱いにしているので通常はここに来ないが、
      // 万一残っていても「日付が未定のタスク」には出さない(納品したものは本人のやることではない)
      const unscheduled = db.prepare(`
        SELECT cpi.*, pim.name as preparation_item_name, p.project_name, p.deadline, p.project_kind
        FROM case_preparation_items cpi
        JOIN preparation_item_master pim ON cpi.preparation_item_id = pim.id
        JOIN projects p ON cpi.case_id = p.id
        WHERE cpi.assigned_staff_id = ? AND cpi.scheduled_date IS NULL AND cpi.status != '完了'
          AND p.status != 'COMPLETED'
        ORDER BY p.deadline ASC, cpi.id ASC
      `).all(link.employee_id);

      // 社員用TODOリスト(スプレッドシート)の本人分「未着手」「進行中」。
      // 連携未設定・取得失敗(キャッシュもなし)の場合は null = フロントでセクション非表示
      const allSheetTodos = await fetchAllSheetTodos();
      const sheet_todos = allSheetTodos
        ? attachTodoPlans(db, link.employee_id, extractOpenTodosFor(allSheetTodos, link.employee_name))
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
        scheduled: scheduled.map(itemToJson),
        unscheduled: unscheduled.map(itemToJson),
        sheet_todos,
        rough_files,
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

      db.prepare(`
        UPDATE case_preparation_items SET scheduled_date=?, estimated_hours=?, status=?, completed_at=? WHERE id=?
      `).run(scheduled_date, estimated_hours, status, completed_at, item.id);

      if (status !== item.status) {
        syncCaseStatus(item.case_id);
        // 「初稿提出」「外注用デザインデータ作成」の完了はオペレーション段階を前へ進める。
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
      const existing = db.prepare(
        'SELECT id FROM schedule_overrides WHERE employee_id = ? AND work_date = ?'
      ).get(link.employee_id, work_date);

      if (mode === 'clear') {
        if (existing) db.prepare('DELETE FROM schedule_overrides WHERE id = ?').run(existing.id);
      } else if (mode === 'off') {
        if (existing) {
          db.prepare(`UPDATE schedule_overrides SET is_day_off=1, start_time=NULL, end_time=NULL, break_minutes=0 WHERE id=?`).run(existing.id);
        } else {
          db.prepare(`
            INSERT INTO schedule_overrides (employee_id, work_date, start_time, end_time, break_minutes, is_day_off)
            VALUES (?, ?, NULL, NULL, 0, 1)
          `).run(link.employee_id, work_date);
        }
      } else if (mode === 'hours') {
        // 開始/終了の時間帯指定(推奨)。「午後だけ稼働できる」等を正しく伝えられる。
        // 旧クライアント互換のため、hours(時間数)だけの指定も引き続き受け付け、
        // その場合のみ従来どおり AVAILABILITY_START 開始として時刻に変換する
        let start_time = s(body.start_time, 5);
        let end_time = s(body.end_time, 5);

        if (start_time || end_time) {
          if (!TIME_RE.test(start_time) || !TIME_RE.test(end_time)) {
            return res.status(400).json({ ok: false, error: '時刻は HH:MM で指定してください' });
          }
          if (toMinutes(end_time) <= toMinutes(start_time)) {
            return res.status(400).json({ ok: false, error: '終了時刻は開始時刻より後にしてください' });
          }
          if ((toMinutes(end_time) - toMinutes(start_time)) / 60 > MAX_HOURS_PER_DAY) {
            return res.status(400).json({ ok: false, error: `稼働時間は${MAX_HOURS_PER_DAY}時間以内で指定してください` });
          }
        } else {
          const h = Number(body.hours);
          if (Number.isNaN(h) || h <= 0 || h > MAX_HOURS_PER_DAY) {
            return res.status(400).json({ ok: false, error: `稼働時間は0より大きく${MAX_HOURS_PER_DAY}時間以内で指定してください` });
          }
          const [sh, sm] = AVAILABILITY_START.split(':').map(Number);
          const endMinutes = sh * 60 + sm + Math.round(h * 60);
          start_time = AVAILABILITY_START;
          end_time = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
        }

        if (existing) {
          db.prepare(`UPDATE schedule_overrides SET is_day_off=0, start_time=?, end_time=?, break_minutes=0 WHERE id=?`)
            .run(start_time, end_time, existing.id);
        } else {
          db.prepare(`
            INSERT INTO schedule_overrides (employee_id, work_date, start_time, end_time, break_minutes, is_day_off)
            VALUES (?, ?, ?, ?, 0, 0)
          `).run(link.employee_id, work_date, start_time, end_time);
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

      // 完了させた分を予定表からも外す(日カードに残しても操作できないため)
      db.prepare('DELETE FROM designer_sheet_todo_plans WHERE employee_id = ? AND task_text = ?')
        .run(link.employee_id, task_text);
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

      // 予定日も見込み時間も無くなったら行ごと削除(不要な行を溜めない)
      if (scheduled_date === null && (estimated_hours === null || estimated_hours === 0)) {
        if (existing) db.prepare('DELETE FROM designer_sheet_todo_plans WHERE id = ?').run(existing.id);
        return res.json({ ok: true, plan: { task_text, scheduled_date: null, estimated_hours: null } });
      }

      db.prepare(`
        INSERT INTO designer_sheet_todo_plans (employee_id, task_text, scheduled_date, estimated_hours, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(employee_id, task_text) DO UPDATE SET
          scheduled_date = excluded.scheduled_date,
          estimated_hours = excluded.estimated_hours,
          updated_at = excluded.updated_at
      `).run(link.employee_id, task_text, scheduled_date, estimated_hours, new Date().toISOString());

      res.json({ ok: true, plan: { task_text, scheduled_date, estimated_hours } });
    } catch (err) {
      console.error('[デザイナーボード] TODO予定の保存エラー:', err.message);
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
        SELECT employee_id, task_text, scheduled_date, estimated_hours
        FROM designer_sheet_todo_plans
        WHERE scheduled_date BETWEEN ? AND ?
        ORDER BY scheduled_date ASC, id ASC
      `).all(start, end);
      res.json(rows);
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

module.exports = { registerDesignerBoardRoutes };
