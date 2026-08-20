// タスクの予定日変更の記録と、そこから組み立てる業務量レポート。
//
// 背景(2026-08-20 社長依頼):
// マイスケジュールボードでは当日に終わらなかったタスクを翌日以降へドラッグして再計画できる。
// これ自体は必要な操作だが、case_preparation_items.scheduled_date は「最新の予定」しか持たないため、
// 動かした時点で元の日は最初から空だったように見える。結果、
//   ・1日で終わらない作業がそのまま翌日へ流れ続けても記録に残らない
//   ・その日の業務量が適正だったか(計画に対してどれだけ終わったか)を後から検証できない
// という状態だった。
//
// そこで予定日を動かすたびに1行残し、「予定日が来ているのに後ろへ動かした」ものを
// 持ち越し(is_carryover)として区別する。これがあれば過去の任意の日について
//   計画時間 = いまその日に残っているタスク + その日から持ち越されたタスク
// として当日の姿を再現できる。
//
// 記録は本人の操作を増やさない(ドラッグ&ドロップのついでに自動で残る)。

// 見込み時間が未入力のタスクをどれだけの重さとして数えるか。
// 0にすると「見込みを入れずに持ち越せば業務量に響かない」抜け道になるため、
// 件数としては必ず1件と数え、時間の集計からだけ外す(レポートに未入力件数を出す)
const UNKNOWN_HOURS = 0;

const TASK_KINDS = { PREP_ITEM: 'PREP_ITEM', SHEET_TODO: 'SHEET_TODO' };

// 持ち越しの理由(本人がワンタップで選ぶ)。null(無回答)も許容する
const CARRYOVER_REASONS = [
  { key: 'VOLUME', label: '作業量が多かった' },
  { key: 'INTERRUPT', label: '割り込みが入った' },
  { key: 'WAITING', label: '先方・社内待ち' },
  { key: 'OTHER', label: 'その他' },
];
const CARRYOVER_REASON_KEYS = CARRYOVER_REASONS.map(r => r.key);

// 持ち越しの自由記述メモの最大長。選択肢では表せない具体名
// (「KRATVSカタログ制作に時間がかかった」等)を残すための欄
const CARRYOVER_NOTE_MAX = 200;

// 日本時間の今日。new Date().toISOString() はUTC基準で0〜9時に前日になるため使わない
// (public/js/utils.js の formatDateISO と同じ考え方)
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysISO(dateISO, delta) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// start〜end(両端含む)の日付を並べる。範囲が逆・広すぎる場合は呼び出し側で弾く
function eachDate(start, end) {
  const dates = [];
  for (let d = start; d <= end; d = addDaysISO(d, 1)) dates.push(d);
  return dates;
}

/**
 * 予定日の変更が「持ち越し」かどうか。
 *
 * 持ち越し = 予定していた日が既に来ている(今日を含む)のに、その日から外した操作。
 *   ・未定 → 日付            … 新しく計画しただけ。持ち越しではない
 *   ・まだ来ていない日 → 別の日 … 先回りの組み替え。持ち越しではない
 *   ・今日/過去の日 → より後の日 … 持ち越し
 *   ・今日/過去の日 → 未定      … 予定日が来たのに未定へ戻した。持ち越しとして扱う
 *   ・今日/過去の日 → より前の日 … 過去日への詰め直し。持ち越しではない
 */
function isCarryover(fromDate, toDate, today = todayISO()) {
  if (!fromDate) return false;
  if (fromDate > today) return false;
  if (!toDate) return true;
  return toDate > fromDate;
}

/**
 * 予定日の変更を1行記録する。fromDate と toDate が同じなら何もしない。
 * 完了済みタスクの移動は業務量の話ではないので呼び出し側で除外すること。
 *
 * taskLabel には顧客名を含みうる値を入れない(準備項目は作業名だけを入れ、
 * 案件名はレポート時に projects へJOINして解決する)。
 */
function recordTaskMove(db, {
  employeeId, taskKind, prepItemId = null, taskText = null, taskLabel,
  fromDate = null, toDate = null, estimatedHours = null,
  carryoverReason = null, carryoverNote = null,
}) {
  if (!employeeId || !TASK_KINDS[taskKind]) return null;
  const from = fromDate || null;
  const to = toDate || null;
  if (from === to) return null;

  const carry = isCarryover(from, to);
  // 理由・メモは持ち越しのときだけ意味を持つ(先回りの組み替えには聞いていない)
  const reason = carry && CARRYOVER_REASON_KEYS.includes(carryoverReason) ? carryoverReason : null;
  const note = carry ? (String(carryoverNote || '').trim().slice(0, CARRYOVER_NOTE_MAX) || null) : null;

  db.prepare(`
    INSERT INTO designer_task_moves
      (employee_id, task_kind, prep_item_id, task_text, task_label,
       from_date, to_date, estimated_hours, is_carryover, carryover_reason, carryover_note, moved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(employeeId, taskKind, prepItemId, taskText, String(taskLabel || '').slice(0, 300),
    from, to, estimatedHours, carry ? 1 : 0, reason, note, new Date().toISOString());

  return { is_carryover: carry };
}

/**
 * 本人のタスクごとの累計持ち越し回数。ボードのチップに「⏩ 2回持ち越し」を出すために使う。
 * 準備項目は prep_item_id、シートTODOは本文で数える。
 */
function getCarryoverCounts(db, employeeId) {
  const rows = db.prepare(`
    SELECT task_kind, prep_item_id, task_text, COUNT(*) AS cnt
    FROM designer_task_moves
    WHERE employee_id = ? AND is_carryover = 1
    GROUP BY task_kind, prep_item_id, task_text
  `).all(employeeId);

  const prepItems = new Map();
  const sheetTodos = new Map();
  rows.forEach(r => {
    if (r.task_kind === TASK_KINDS.PREP_ITEM && r.prep_item_id) prepItems.set(r.prep_item_id, r.cnt);
    else if (r.task_kind === TASK_KINDS.SHEET_TODO && r.task_text) sheetTodos.set(r.task_text, r.cnt);
  });
  return { prepItems, sheetTodos };
}

// 移動記録の中でタスクを同一視するためのキー
function moveKey(row) {
  return row.task_kind === TASK_KINDS.PREP_ITEM
    ? `P:${row.prep_item_id}`
    : `S:${row.task_text}`;
}

/**
 * 指定期間の日別 業務量レポートを組み立てる。
 *
 * 各日について
 *   稼働h   … その日の勤務可能時間(稼働申告・基本スケジュール由来)
 *   計画h   … その日に計画されていた合計(いま残っているタスク + その日から持ち越されたタスク)
 *   完了h   … そのうち完了した分
 *   持ち越しh … その日から後ろへ動かされた分
 *   残りh   … まだその日に置かれたままで未完了の分(過去日なら手つかずのまま放置されている)
 *
 * deps.getDayInfo(db, employeeId, dateISO) -> { hours, is_day_off, ... } を注入する
 * (稼働時間の算出は lib/designer-board.js の実装を使い回し、二重実装にしない)
 */
function buildWorkloadReport(db, { employeeId, start, end }, deps) {
  const getDayInfo = deps.getDayInfo;
  const dates = eachDate(start, end);
  const dateSet = new Set(dates);
  const today = todayISO();

  // --- いま各日に置かれているタスク ---
  const prepRows = db.prepare(`
    SELECT cpi.id, cpi.scheduled_date, cpi.estimated_hours, cpi.status,
           pim.name AS preparation_item_name, p.project_name
    FROM case_preparation_items cpi
    JOIN preparation_item_master pim ON cpi.preparation_item_id = pim.id
    JOIN projects p ON cpi.case_id = p.id
    WHERE cpi.assigned_staff_id = ? AND cpi.scheduled_date BETWEEN ? AND ?
  `).all(employeeId, start, end);

  const todoRows = db.prepare(`
    SELECT id, task_text, scheduled_date, estimated_hours, completed_at
    FROM designer_sheet_todo_plans
    WHERE employee_id = ? AND scheduled_date BETWEEN ? AND ?
  `).all(employeeId, start, end);

  // --- 各日から持ち越されたタスク ---
  // 同じタスクが同じ日から複数回動いている場合(戻して再度動かした等)は最後の1回だけ数える。
  // 動かした後にその日へ戻ってきたタスクは、いま置かれている側で数えるのでここから外す
  const carryRows = db.prepare(`
    SELECT id, task_kind, prep_item_id, task_text, task_label, from_date, to_date,
           estimated_hours, carryover_reason, carryover_note, moved_at
    FROM designer_task_moves
    WHERE employee_id = ? AND is_carryover = 1 AND from_date BETWEEN ? AND ?
    ORDER BY id ASC
  `).all(employeeId, start, end);

  const presentKeysByDate = new Map(dates.map(d => [d, new Set()]));
  prepRows.forEach(r => presentKeysByDate.get(r.scheduled_date)?.add(`P:${r.id}`));
  todoRows.forEach(r => presentKeysByDate.get(r.scheduled_date)?.add(`S:${r.task_text}`));

  const carryByDate = new Map(dates.map(d => [d, new Map()]));
  carryRows.forEach(r => {
    if (!dateSet.has(r.from_date)) return;
    const key = moveKey(r);
    if (presentKeysByDate.get(r.from_date).has(key)) return; // その日へ戻ってきている
    carryByDate.get(r.from_date).set(key, r); // ORDER BY id ASC なので最後の1回が残る
  });

  // --- 日別に集計 ---
  const hoursOf = v => (v === null || v === undefined ? UNKNOWN_HOURS : Number(v) || 0);
  const isUnknown = v => v === null || v === undefined || Number(v) === 0;

  const days = dates.map(date => {
    const info = getDayInfo(db, employeeId, date);
    const isFuture = date > today;
    const dayPrep = prepRows.filter(r => r.scheduled_date === date);
    const dayTodo = todoRows.filter(r => r.scheduled_date === date);
    const dayCarry = [...carryByDate.get(date).values()];

    const doneHours =
      dayPrep.filter(r => r.status === '完了').reduce((s, r) => s + hoursOf(r.estimated_hours), 0) +
      dayTodo.filter(r => r.completed_at).reduce((s, r) => s + hoursOf(r.estimated_hours), 0);
    const leftHours =
      dayPrep.filter(r => r.status !== '完了').reduce((s, r) => s + hoursOf(r.estimated_hours), 0) +
      dayTodo.filter(r => !r.completed_at).reduce((s, r) => s + hoursOf(r.estimated_hours), 0);
    const carriedHours = dayCarry.reduce((s, r) => s + hoursOf(r.estimated_hours), 0);

    const doneCount = dayPrep.filter(r => r.status === '完了').length + dayTodo.filter(r => r.completed_at).length;
    const leftCount = dayPrep.filter(r => r.status !== '完了').length + dayTodo.filter(r => !r.completed_at).length;

    const plannedHours = doneHours + leftHours + carriedHours;
    const plannedCount = doneCount + leftCount + dayCarry.length;
    const unknownCount =
      dayPrep.filter(r => isUnknown(r.estimated_hours)).length +
      dayTodo.filter(r => isUnknown(r.estimated_hours)).length +
      dayCarry.filter(r => isUnknown(r.estimated_hours)).length;

    return {
      date,
      is_day_off: !!info.is_day_off,
      is_future: isFuture,
      capacity_hours: round(info.hours),
      planned_hours: round(plannedHours),
      done_hours: round(doneHours),
      carried_hours: round(carriedHours),
      left_hours: round(leftHours),
      planned_count: plannedCount,
      done_count: doneCount,
      carried_count: dayCarry.length,
      left_count: leftCount,
      // 見込み時間が未入力のタスク数。多いと時間の集計自体が当てにならないので画面に出す
      unknown_hours_count: unknownCount,
      // 消化率は「計画のうち完了した割合」。計画0の日と、まだ来ていない日は率を出さない(null)
      // (未来の日に0%と出すと、予定を入れただけで未達のように見えてしまう)
      done_rate: !isFuture && plannedHours > 0 ? Math.round((doneHours / plannedHours) * 100) : null,
      // 稼働時間に対する計画の詰まり具合。100%超なら初めから入りきらない量を入れている
      load_rate: info.hours > 0 ? Math.round((plannedHours / info.hours) * 100) : null,
    };
  });

  // --- 期間の持ち越しランキング(何度も後ろへ流れているタスク) ---
  const byTask = new Map();
  carryRows.forEach(r => {
    const key = moveKey(r);
    const cur = byTask.get(key) || {
      task_kind: r.task_kind, prep_item_id: r.prep_item_id, task_text: r.task_text,
      label: r.task_label, count: 0, first_date: r.from_date, reasons: [], notes: [],
    };
    cur.count += 1;
    cur.first_date = cur.first_date < r.from_date ? cur.first_date : r.from_date;
    if (r.carryover_reason) cur.reasons.push(r.carryover_reason);
    // 同じ内容を何度も書いていることがあるので、同じ文言は1つにまとめる
    if (r.carryover_note && !cur.notes.some(n => n.text === r.carryover_note)) {
      cur.notes.push({ date: r.from_date, text: r.carryover_note });
    }
    byTask.set(key, cur);
  });

  // 案件名・いまの予定日・完了状態は移動記録ではなく実データから引く。
  // 移動記録の to_date は「最後に持ち越した先」なので、そのあと普通に組み替えられていると
  // 現在地とずれる(顧客名を含みうる案件名を移動記録に持たせていない理由もここ)
  const prepIds = [...byTask.values()]
    .filter(t => t.task_kind === TASK_KINDS.PREP_ITEM && t.prep_item_id)
    .map(t => t.prep_item_id);
  const prepStateById = new Map();
  if (prepIds.length) {
    const placeholders = prepIds.map(() => '?').join(',');
    db.prepare(`
      SELECT cpi.id, cpi.status, cpi.scheduled_date, p.project_name
      FROM case_preparation_items cpi
      JOIN projects p ON cpi.case_id = p.id
      WHERE cpi.id IN (${placeholders})
    `).all(...prepIds).forEach(r => prepStateById.set(r.id, r));
  }

  const todoTexts = [...byTask.values()]
    .filter(t => t.task_kind === TASK_KINDS.SHEET_TODO && t.task_text)
    .map(t => t.task_text);
  const todoStateByText = new Map();
  if (todoTexts.length) {
    const placeholders = todoTexts.map(() => '?').join(',');
    db.prepare(`
      SELECT task_text, scheduled_date, completed_at
      FROM designer_sheet_todo_plans
      WHERE employee_id = ? AND task_text IN (${placeholders})
    `).all(employeeId, ...todoTexts).forEach(r => todoStateByText.set(r.task_text, r));
  }

  const carryover_tasks = [...byTask.values()]
    .map(t => {
      const prep = t.prep_item_id ? prepStateById.get(t.prep_item_id) : null;
      const todo = t.task_text ? todoStateByText.get(t.task_text) : null;
      return {
        kind: t.task_kind,
        name: prep ? `${prep.project_name} / ${t.label}` : t.label,
        count: t.count,
        first_date: t.first_date,
        // いまどこに置かれているか。null なら日付未定に戻したまま
        current_date: prep ? prep.scheduled_date : (todo ? todo.scheduled_date : null),
        // いま完了しているなら「時間はかかったが片付いた」。未完了なら流れ続けている
        done: prep ? prep.status === '完了' : !!(todo && todo.completed_at),
        reasons: t.reasons,
        // 本人が書いた具体的な事情(「KRATVSカタログ制作に時間がかかった」等)。新しいものから並べる
        notes: t.notes.slice().reverse(),
      };
    })
    .sort((a, b) => b.count - a.count || (a.first_date < b.first_date ? -1 : 1));

  // --- 期間サマリー ---
  // 稼働のある日だけで平均を取る(休みの日を混ぜると率が薄まる)
  const workingDays = days.filter(d => !d.is_day_off && !d.is_future && d.planned_hours > 0);
  const totalPlanned = workingDays.reduce((s, d) => s + d.planned_hours, 0);
  const totalDone = workingDays.reduce((s, d) => s + d.done_hours, 0);
  const totalCarried = workingDays.reduce((s, d) => s + d.carried_hours, 0);
  const totalCapacity = workingDays.reduce((s, d) => s + d.capacity_hours, 0);

  const reasonCounts = {};
  CARRYOVER_REASONS.forEach(r => { reasonCounts[r.key] = 0; });
  let reasonUnanswered = 0;
  carryRows.forEach(r => {
    if (r.carryover_reason && reasonCounts[r.carryover_reason] !== undefined) reasonCounts[r.carryover_reason] += 1;
    else reasonUnanswered += 1;
  });

  return {
    start, end, today,
    days,
    carryover_tasks,
    summary: {
      working_days: workingDays.length,
      total_capacity_hours: round(totalCapacity),
      total_planned_hours: round(totalPlanned),
      total_done_hours: round(totalDone),
      total_carried_hours: round(totalCarried),
      done_rate: totalPlanned > 0 ? Math.round((totalDone / totalPlanned) * 100) : null,
      load_rate: totalCapacity > 0 ? Math.round((totalPlanned / totalCapacity) * 100) : null,
      carryover_moves: carryRows.length,
      carryover_task_count: carryover_tasks.length,
      // 3回以上流れているタスク。1日の業務量ではなくタスク自体に問題がある可能性が高い
      repeat_carryover_tasks: carryover_tasks.filter(t => t.count >= 3).length,
      reason_counts: reasonCounts,
      reason_unanswered: reasonUnanswered,
    },
    carryover_reasons: CARRYOVER_REASONS,
  };
}

function round(h) {
  return Math.round((Number(h) || 0) * 10) / 10;
}

module.exports = {
  TASK_KINDS,
  CARRYOVER_REASONS,
  CARRYOVER_REASON_KEYS,
  CARRYOVER_NOTE_MAX,
  todayISO,
  isCarryover,
  recordTaskMove,
  getCarryoverCounts,
  buildWorkloadReport,
};
