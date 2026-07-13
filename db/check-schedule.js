// 西山工業 持込ポロ92枚の繰り越し不具合調査用の一時スクリプト。
// sqlite3 CLIが無い環境でも `node db/check-schedule.js` で同じ内容を確認できるように、
// アプリ本体と同じ better-sqlite3 でDBを開いてクエリを実行する。
// 調査が終わったら削除してよい。
const path = require('path');
const Database = require('better-sqlite3');

const EMPLOYEE_ID = 3; // 渋川さん
const dbPath = path.join(__dirname, 'projects.db');
const db = new Database(dbPath, { readonly: true });

function printTable(title, rows) {
  console.log(`\n=== ${title} ===`);
  if (!rows.length) {
    console.log('(該当なし)');
    return;
  }
  console.table(rows);
}

// ① 案件を特定
const projects = db.prepare(`
  SELECT id, project_name, customer_name, received_date, deadline,
         quantity, planned_hours, estimated_hours, assigned_employee_id, status
  FROM projects
  WHERE project_name LIKE '%持込ポロ%' OR customer_name LIKE '%西山%'
`).all();
printTable('① 該当案件', projects);

// ループの繰り越し対象期間(受付日翌日〜締切日)。案件が見つからない場合は
// ユーザー報告の週(2026-07-13〜07-17)を仮の確認範囲として使う
let rangeStart = '2026-07-13';
let rangeEnd = '2026-07-17';
if (projects.length === 1) {
  const p = projects[0];
  const received = new Date(p.received_date);
  received.setDate(received.getDate() + 1);
  rangeStart = received.toISOString().slice(0, 10);
  rangeEnd = p.deadline;
  console.log(`\n(確認範囲: 受付日翌日〜締切日 = ${rangeStart} 〜 ${rangeEnd})`);
} else if (projects.length > 1) {
  console.log('\n⚠️ 案件が複数件ヒットしました。手動でIDを絞って再確認してください。');
} else {
  console.log(`\n⚠️ 案件が見つかりませんでした。仮の確認範囲(${rangeStart}〜${rangeEnd})で従業員側のデータのみ確認します。`);
}

// 従業員名の確認
const employee = db.prepare('SELECT id, name, is_active FROM employees WHERE id = ?').get(EMPLOYEE_ID);
console.log(`\n(確認対象employee_id=${EMPLOYEE_ID}: ${employee ? employee.name : '該当従業員なし'})`);

// ② schedule_overrides
const overrides = db.prepare(`
  SELECT * FROM schedule_overrides
  WHERE employee_id = ? AND work_date BETWEEN ? AND ?
  ORDER BY work_date
`).all(EMPLOYEE_ID, rangeStart, rangeEnd);
printTable('② schedule_overrides', overrides);

// ③ employee_default_schedule の重複チェック
const dupes = db.prepare(`
  SELECT weekday, COUNT(*) AS cnt
  FROM employee_default_schedule
  WHERE employee_id = ?
  GROUP BY weekday
  HAVING COUNT(*) > 1
`).all(EMPLOYEE_ID);
printTable('③-a employee_default_schedule 重複チェック(weekdayごとに2件以上あれば要注意)', dupes);

const defaults = db.prepare(`
  SELECT * FROM employee_default_schedule
  WHERE employee_id = ?
  ORDER BY weekday, id
`).all(EMPLOYEE_ID);
printTable('③-b employee_default_schedule 全件(weekday: 0=日,1=月,2=火,3=水,4=木,5=金,6=土)', defaults);

// ④ case_time_allocations (同期間の渋川さんの割り当て状況)
const allocations = db.prepare(`
  SELECT * FROM case_time_allocations
  WHERE employee_id = ? AND work_date BETWEEN ? AND ?
  ORDER BY work_date
`).all(EMPLOYEE_ID, rangeStart, rangeEnd);
printTable('④ case_time_allocations', allocations);

db.close();
console.log('\n完了。上記の出力をそのまま共有してください。');
