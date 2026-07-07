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

  // 準備項目マスターの初期データ投入(未投入の場合のみ)。
  // code は案件新規登録画面(旧ハードコード)・既存projects.prep_itemsのCSVコードと一致させる
  const prepItemCount = db.prepare(`SELECT COUNT(*) as c FROM preparation_item_master`).get().c;
  if (prepItemCount === 0) {
    const prepItemStmt = db.prepare(`
      INSERT INTO preparation_item_master (code, name, display_order) VALUES (?, ?, ?)
    `);
    const prepItemData = [
      ['SCREEN_MAKING', 'シルクスクリーン製版'],
      ['POSITIVE_FILM_OUTPUT', 'ポジフィルム出力'],
      ['PRINT_COLOR_SELECTION', 'プリントカラー選定'],
      ['PRINT_POSITION_ADJUSTMENT', 'プリント位置調整'],
      ['PRINT_SIZE_SELECTION', 'プリントサイズ選定'],
      ['SUBLIMATION_SHEET_OUTPUT', '昇華プリント用シート出力'],
      ['DTF_SHEET_OUTPUT', 'DTFシート出力'],
      ['EMBROIDERY_DATA_REQUEST', '刺繍データ作成依頼'],
      ['DTF_DATA_CREATION', 'DTFデータ作成'],
      ['SCREEN_DATA_CREATION', 'スクリーンデータ作成'],
      ['RUBBER_SHEET_OUTPUT', 'ラバーシート出力'],
      ['RUBBER_SHEET_TRIMMING', 'ラバーシートカス取り'],
      ['TEST_PRINT', 'テストプリント']
    ];
    prepItemData.forEach(([code, name], index) => {
      prepItemStmt.run(code, name, index + 1);
    });
    console.log('✓ 準備項目マスターを初期投入しました');
  }

  // 既存案件(projects.prep_items のCSVコード)を case_preparation_items へ移行する。
  // 冪等: 対象案件について1件でも既存レコードがあればスキップ(既に移行済み or 手動登録済みとみなす)
  const projectsWithPrepItems = db.prepare(`
    SELECT id, prep_items FROM projects WHERE prep_items IS NOT NULL AND prep_items != ''
  `).all();
  if (projectsWithPrepItems.length > 0) {
    const masterByCode = new Map(
      db.prepare(`SELECT id, code FROM preparation_item_master`).all().map(row => [row.code, row.id])
    );
    const hasExistingStmt = db.prepare(`SELECT COUNT(*) as c FROM case_preparation_items WHERE case_id = ?`);
    const insertCaseItemStmt = db.prepare(`
      INSERT INTO case_preparation_items (case_id, preparation_item_id, status)
      VALUES (?, ?, '未着手')
    `);
    let migratedCount = 0;
    projectsWithPrepItems.forEach(project => {
      const alreadyMigrated = hasExistingStmt.get(project.id).c > 0;
      if (alreadyMigrated) return;
      const codes = project.prep_items.split(',').map(c => c.trim()).filter(Boolean);
      codes.forEach(code => {
        const masterId = masterByCode.get(code);
        if (masterId) {
          insertCaseItemStmt.run(project.id, masterId);
          migratedCount++;
        }
      });
    });
    if (migratedCount > 0) {
      console.log(`✓ 既存案件の準備項目 ${migratedCount}件を case_preparation_items へ移行しました`);
    }
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
