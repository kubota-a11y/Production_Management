'use strict';

// 受付〜納品の業務量を棚卸しするための集計(2026-09-23)。
// 目的: 三浦さんの業務領域(一次受付・受注候補の仕分け・案件登録・スケジュール・納品)の
// 「量」と「誰がやっているか」を、社内LANの外からでも数字で見られるようにする。
// 返すのは件数・週別・社員名別・所要時間の統計だけ。顧客名・本文・受付番号は一切含めない。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJstDate(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    // 'YYYY-MM-DD' や 'YYYY-MM-DD HH:MM' のような日時はそのまま日付部分を使う
    const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }
  // ISO(UTC, 末尾Z)は日本時間へ寄せる。タイムゾーン無しの文字列は Date.parse がローカル扱いなので
  // そのままでは本番(Windows・JST)と開発(Mac・JST)で同じ結果になる
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(String(iso));
  const d = new Date(hasZone ? t + JST_OFFSET_MS : t - new Date(t).getTimezoneOffset() * 60000 + 0);
  return d.toISOString().slice(0, 10);
}

function jstHour(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(String(iso));
  const d = new Date(hasZone ? t + JST_OFFSET_MS : t - new Date(t).getTimezoneOffset() * 60000);
  return { hour: d.getUTCHours(), dow: d.getUTCDay() };
}

function weekKey(ymd) {
  // 月曜始まりの週。キーはその週の月曜日(YYYY-MM-DD)
  if (!ymd) return null;
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function inRange(ymd, from, to) {
  return Boolean(ymd) && ymd >= from && ymd <= to;
}

function inc(obj, key, n = 1) {
  const k = key === null || key === undefined || key === '' ? '(未設定)' : String(key);
  obj[k] = (obj[k] || 0) + n;
  return obj;
}

function stats(values) {
  const a = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return { n: 0 };
  const pick = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  return {
    n: a.length,
    median: Math.round(pick(0.5) * 10) / 10,
    p75: Math.round(pick(0.75) * 10) / 10,
    p90: Math.round(pick(0.9) * 10) / 10,
    max: Math.round(a[a.length - 1] * 10) / 10,
  };
}

function hoursBetween(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return (tb - ta) / 3600000;
}

// 受注候補の経路。line_user_id の値で判定する(LINE本体は 'U'+32桁、それ以外はフォーム・手入力の固定値)
function intakeSource(lineUserId) {
  const v = String(lineUserId || '');
  if (/^U[0-9a-f]{32}$/.test(v)) return 'LINE';
  if (v.startsWith('INQ_')) return v; // INQ_TEAM / INQ_CLASS_T / INQ_ORIGINAL
  if (['WEB', 'TEAM', 'PARTNER', 'MAIL', 'PHONE'].includes(v)) return v;
  return v ? 'OTHER' : '(未設定)';
}

// 営業時間は平日10:00〜17:00(2026-09-23 社長決定。AI受付の判定と同じ基準)
function isBusinessHour(hour, dow) {
  return dow >= 1 && dow <= 5 && hour >= 10 && hour < 17;
}

function buildInventory(db, { from, to }) {
  const employees = new Map(db.prepare('SELECT id, name FROM employees').all().map((e) => [e.id, e.name]));
  const empName = (id) => (id === null || id === undefined ? '(未割当)' : employees.get(id) || `社員#${id}`);

  // ---- 受注候補(ai_extracted_intake) ----
  const intakeRows = db.prepare(`
    SELECT i.id, i.line_user_id, i.extracted_at, i.status, i.case_id, i.triage_type, i.triage_by, i.triage_at,
           i.dropoff_status, i.linked_line_user_id, p.created_at AS case_created_at
    FROM ai_extracted_intake i
    LEFT JOIN projects p ON p.id = i.case_id
  `).all();
  const intake = {
    total: 0, bySource: {}, byStatus: {}, byTriageType: {}, byTriageBy: {}, byWeek: {}, byWeekSource: {},
    linkedToLine: 0, dropoffSet: 0,
    pendingNow: 0, pendingOver7d: 0,
    triageLeadHours: [], confirmLeadHours: [],
  };
  const todayJst = toJstDate(new Date().toISOString());
  for (const r of intakeRows) {
    const day = toJstDate(r.extracted_at);
    if (r.status === 'pending') {
      intake.pendingNow++;
      if (day && hoursBetween(r.extracted_at, new Date().toISOString()) > 24 * 7) intake.pendingOver7d++;
    }
    if (!inRange(day, from, to)) continue;
    intake.total++;
    const src = intakeSource(r.line_user_id);
    inc(intake.bySource, src);
    inc(intake.byStatus, r.status);
    inc(intake.byTriageType, r.triage_type);
    inc(intake.byTriageBy, r.triage_by);
    const wk = weekKey(day);
    inc(intake.byWeek, wk);
    intake.byWeekSource[wk] = inc(intake.byWeekSource[wk] || {}, src);
    if (r.linked_line_user_id) intake.linkedToLine++;
    if (r.dropoff_status) intake.dropoffSet++;
    if (r.triage_at) {
      const h = hoursBetween(r.extracted_at, r.triage_at);
      if (h !== null && h >= 0) intake.triageLeadHours.push(h);
    }
    if (r.case_id && r.case_created_at) {
      const h = hoursBetween(r.extracted_at, r.case_created_at);
      if (h !== null && h >= 0) intake.confirmLeadHours.push(h);
    }
  }
  intake.triageLeadHours = stats(intake.triageLeadHours);
  intake.confirmLeadHours = stats(intake.confirmLeadHours);
  intake.confirmedRate = intake.total ? Math.round(((intake.byStatus.confirmed || 0) / intake.total) * 100) : null;

  // ---- 公式LINE受信(line_messages) ----
  const lineRows = db.prepare('SELECT line_user_id, message_type, received_at, processed, case_id FROM line_messages').all();
  const line = {
    total: 0, byType: {}, byWeek: {}, byHour: {}, uniqueUsers: 0, afterHours: 0, weekend: 0, processed: 0, linkedToCase: 0,
  };
  const users = new Set();
  for (const r of lineRows) {
    const day = toJstDate(r.received_at);
    if (!inRange(day, from, to)) continue;
    line.total++;
    users.add(r.line_user_id);
    inc(line.byType, r.message_type);
    inc(line.byWeek, weekKey(day));
    const hd = jstHour(r.received_at);
    if (hd) {
      inc(line.byHour, String(hd.hour).padStart(2, '0'));
      if (!isBusinessHour(hd.hour, hd.dow)) line.afterHours++;
      if (hd.dow === 0 || hd.dow === 6) line.weekend++;
    }
    if (r.processed) line.processed++;
    if (r.case_id) line.linkedToCase++;
  }
  line.uniqueUsers = users.size;
  line.newUsers = db.prepare('SELECT first_seen_at FROM line_users').all()
    .filter((u) => inRange(toJstDate(u.first_seen_at), from, to)).length;
  line.afterHoursShare = line.total ? Math.round((line.afterHours / line.total) * 100) : null;

  // ---- 案件(projects) ----
  const projRows = db.prepare(`
    SELECT id, received_date, deadline, contact_method, process_type, quantity, planned_hours, assigned_employee_id,
           status, priority, project_kind, ops_stage, payment_status, created_at, is_design_ops
    FROM projects
  `).all();
  const projects = {
    createdTotal: 0, byContactMethod: {}, byProcessType: {}, byKind: {}, byWeek: {}, byAssignedEmployee: {},
    deadlineEmpty: 0, plannedHoursUndecided: 0, quantityBuckets: {}, designOps: 0,
    activeNow: 0, activeByStatus: {}, activeByOpsStage: {}, activeByPayment: {},
  };
  const createdInRange = new Set();
  for (const r of projRows) {
    const isActive = !['COMPLETED', 'DELIVERED', 'CANCELLED'].includes(String(r.status || ''));
    if (isActive) {
      projects.activeNow++;
      inc(projects.activeByStatus, r.status);
      inc(projects.activeByOpsStage, r.ops_stage);
      inc(projects.activeByPayment, r.payment_status);
    }
    const day = toJstDate(r.created_at) || r.received_date;
    if (!inRange(day, from, to)) continue;
    createdInRange.add(r.id);
    projects.createdTotal++;
    inc(projects.byContactMethod, r.contact_method);
    inc(projects.byProcessType, r.process_type);
    inc(projects.byKind, r.project_kind);
    inc(projects.byWeek, weekKey(day));
    inc(projects.byAssignedEmployee, empName(r.assigned_employee_id));
    if (!r.deadline) projects.deadlineEmpty++;
    if (!r.planned_hours) projects.plannedHoursUndecided++;
    if (r.is_design_ops) projects.designOps++;
    const q = Number(r.quantity) || 0;
    inc(projects.quantityBuckets, q <= 5 ? '1-5' : q <= 9 ? '6-9' : q <= 29 ? '10-29' : q <= 49 ? '30-49' : q <= 99 ? '50-99' : '100+');
  }

  // ---- 納品(delivery_records) ----
  const delRows = db.prepare(`
    SELECT d.delivered_date, d.delivery_method, d.delivered_by_employee_id, d.created_at, d.instruction_pdf_saved,
           p.created_at AS case_created_at, p.received_date
    FROM delivery_records d LEFT JOIN projects p ON p.id = d.case_id
  `).all();
  const deliveries = {
    total: 0, byMethod: {}, byEmployee: {}, byWeek: {}, instructionPdf: { saved: 0, notSaved: 0, beforeFeature: 0 },
    registerLagDays: [], leadDaysFromReceipt: [],
  };
  for (const r of delRows) {
    const day = toJstDate(r.delivered_date);
    if (!inRange(day, from, to)) continue;
    deliveries.total++;
    inc(deliveries.byMethod, r.delivery_method);
    inc(deliveries.byEmployee, empName(r.delivered_by_employee_id));
    inc(deliveries.byWeek, weekKey(day));
    if (r.instruction_pdf_saved === 1) deliveries.instructionPdf.saved++;
    else if (r.instruction_pdf_saved === 0) deliveries.instructionPdf.notSaved++;
    else deliveries.instructionPdf.beforeFeature++;
    // 納品日から登録日までの遅れ(納品登録の滞留を見る)
    const regDay = toJstDate(r.created_at);
    if (regDay && day) deliveries.registerLagDays.push((Date.parse(regDay) - Date.parse(day)) / 86400000);
    const recv = r.received_date || toJstDate(r.case_created_at);
    if (recv && day) deliveries.leadDaysFromReceipt.push((Date.parse(day) - Date.parse(recv)) / 86400000);
  }
  deliveries.registerLagDays = stats(deliveries.registerLagDays);
  deliveries.leadDaysFromReceipt = stats(deliveries.leadDaysFromReceipt);

  // ---- スケジュール(case_time_allocations / schedule_overrides) ----
  const allocRows = db.prepare('SELECT case_id, employee_id, work_date, planned_hours, actual_hours, status FROM case_time_allocations').all();
  const schedule = { allocations: 0, distinctCases: 0, byEmployeeHours: {}, byStatus: {}, byWeek: {}, plannedHours: 0, actualHours: 0, overrides: 0 };
  const cases = new Set();
  for (const r of allocRows) {
    if (!inRange(r.work_date, from, to)) continue;
    schedule.allocations++;
    cases.add(r.case_id);
    inc(schedule.byEmployeeHours, empName(r.employee_id), Number(r.planned_hours) || 0);
    inc(schedule.byStatus, r.status);
    inc(schedule.byWeek, weekKey(r.work_date));
    schedule.plannedHours += Number(r.planned_hours) || 0;
    schedule.actualHours += Number(r.actual_hours) || 0;
  }
  schedule.distinctCases = cases.size;
  for (const k of Object.keys(schedule.byEmployeeHours)) schedule.byEmployeeHours[k] = Math.round(schedule.byEmployeeHours[k] * 10) / 10;
  schedule.plannedHours = Math.round(schedule.plannedHours * 10) / 10;
  schedule.actualHours = Math.round(schedule.actualHours * 10) / 10;
  schedule.overrides = db.prepare('SELECT work_date FROM schedule_overrides').all().filter((r) => inRange(r.work_date, from, to)).length;

  // ---- 準備項目(case_preparation_items): 期間内に作られた案件のもの ----
  const prepRows = db.prepare('SELECT case_id, status, assigned_staff_id, completed_at FROM case_preparation_items').all();
  const prep = { total: 0, byStatus: {}, byAssignedEmployee: {} };
  for (const r of prepRows) {
    if (!createdInRange.has(r.case_id)) continue;
    prep.total++;
    inc(prep.byStatus, r.status);
    inc(prep.byAssignedEmployee, empName(r.assigned_staff_id));
  }

  return {
    period: { from, to },
    generatedAt: new Date().toISOString(),
    intake, line, projects, deliveries, schedule, prep,
  };
}

function parseRange(query) {
  const today = toJstDate(new Date().toISOString());
  const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const to = isYmd(query.to) ? query.to : today;
  let from = isYmd(query.from) ? query.from : null;
  if (!from) {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 30);
    from = d.toISOString().slice(0, 10);
  }
  if (from > to) return { error: 'from が to より後になっています' };
  return { from, to };
}

module.exports = { buildInventory, parseRange, intakeSource, toJstDate, weekKey };
