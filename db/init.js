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

  // 初回のみサンプル担当者を挿入
  if (!dbExists) {
    const now = new Date().toISOString();
    const staffStmt = db.prepare(`
      INSERT INTO staff (name, role, capacity_minutes, created_at, updated_at)
      VALUES (?, ?, 480, ?, ?)
    `);

    const staffData = [
      { name: 'スタッフA', role: 'FULL_TIME' },
      { name: 'スタッフB', role: 'FULL_TIME' },
      { name: 'スタッフC', role: 'PART_TIME' },
      { name: 'スタッフD', role: 'PART_TIME' },
      { name: 'スタッフE', role: 'PART_TIME' },
      { name: '生産管理者', role: 'PRODUCTION_MANAGER' },
      { name: 'デザイナー', role: 'DESIGNER' }
    ];

    staffData.forEach(staff => {
      staffStmt.run(staff.name, staff.role, now, now);
    });

    console.log('✓ Database initialized with sample staff');
  }

  return db;
}

module.exports = { initDatabase, dbPath };
