const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'projects.db');

function initDatabase() {
  // DBファイルが存在しない場合は新規作成
  const dbExists = fs.existsSync(dbPath);
  const db = new Database(dbPath);

  // スキーマを読み込んで実行
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // 既存DBに nas_folder_path カラムがない場合は追加
  const columns = db.prepare(`PRAGMA table_info('projects')`).all().map(col => col.name);
  if (!columns.includes('nas_folder_path')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN nas_folder_path TEXT`).run();
  }

  // 既存DBに prep_items カラムがない場合は追加
  if (!columns.includes('prep_items')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN prep_items TEXT`).run();
  }

  // 既存DBの schedule_overrides に is_day_off カラムがない場合は追加
  const scheduleOverrideColumns = db.prepare(`PRAGMA table_info('schedule_overrides')`).all().map(col => col.name);
  if (scheduleOverrideColumns.length > 0 && !scheduleOverrideColumns.includes('is_day_off')) {
    db.prepare(`ALTER TABLE schedule_overrides ADD COLUMN is_day_off INTEGER NOT NULL DEFAULT 0`).run();
  }

  // 初回のみサンプル担当者を挿入
  if (!dbExists) {
    const now = new Date().toISOString();
    const staffStmt = db.prepare(`
      INSERT INTO staff (name, role, capacity_minutes, created_at, updated_at)
      VALUES (?, ?, 480, ?, ?)
    `);

    const staffData = [
      { name: '社長', role: 'FULL_TIME' },
      { name: '三浦', role: 'FULL_TIME' },
      { name: '鈴木', role: 'FULL_TIME' }
    ];

    staffData.forEach(staff => {
      staffStmt.run(staff.name, staff.role, now, now);
    });

    console.log('✓ Database initialized with sample staff');
  }

  return db;
}

module.exports = { initDatabase, dbPath };
