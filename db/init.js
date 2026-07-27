const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'projects.db');

// dbFile を渡すとそのパスで初期化(テスト用)。省略時は本番/開発の projects.db。
function initDatabase(dbFile = dbPath) {
  // DBファイルが存在しない場合は新規作成
  const dbExists = fs.existsSync(dbFile);
  const db = new Database(dbFile);

  // WALモード(2026-07-27): LAN内の複数端末から同時アクセスした際の書き込み待ちを緩和する。
  // バックアップはbetter-sqlite3の.backup APIを使っているためWALとの相性問題はない。
  // 一度設定するとDBファイル自体に永続化される(毎回実行しても害はない)
  db.pragma('journal_mode = WAL');

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

  // 既存DBに required_skill_tags カラムがない場合は追加
  if (!columns.includes('required_skill_tags')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN required_skill_tags TEXT`).run();
  }

  // 既存DBに estimated_hours カラムがない場合は追加
  if (!columns.includes('estimated_hours')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN estimated_hours REAL`).run();
  }

  // 既存DBに project_kind カラムがない場合は追加。
  // NORMAL=通常案件 / INTERNAL_DESIGN=社内デザイン案件(KRATVS・販促物など。生産系の必須入力を簡略化して登録する)
  if (!columns.includes('project_kind')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN project_kind TEXT NOT NULL DEFAULT 'NORMAL'`).run();
  }

  // 既存DBに assigned_employee_id カラムがない場合は追加
  // (assigned_staff_id は staff テーブル(管理担当者)への参照。こちらは employees テーブル(実作業者)への参照で、担当者提案機能の割り当て先として使う)
  if (!columns.includes('assigned_employee_id')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN assigned_employee_id INTEGER REFERENCES employees(id)`).run();
  }

  // 既存DBに staff.skill_tags カラムがない場合は追加
  const staffColumns = db.prepare(`PRAGMA table_info('staff')`).all().map(col => col.name);
  if (!staffColumns.includes('skill_tags')) {
    db.prepare(`ALTER TABLE staff ADD COLUMN skill_tags TEXT`).run();
  }

  // 既存DBに employees.skill_tags カラムがない場合は追加
  const employeeColumns = db.prepare(`PRAGMA table_info('employees')`).all().map(col => col.name);
  if (!employeeColumns.includes('skill_tags')) {
    db.prepare(`ALTER TABLE employees ADD COLUMN skill_tags TEXT`).run();
  }

  // 既存DBに case_time_allocations.setup_minutes / cleanup_minutes カラムがない場合は追加。
  // スケジュールボードの自動割当ボタン(日次/週次)専用の前準備・後片付け時間を保持する
  const caseTimeAllocationColumns = db.prepare(`PRAGMA table_info('case_time_allocations')`).all().map(col => col.name);
  if (!caseTimeAllocationColumns.includes('setup_minutes')) {
    db.prepare(`ALTER TABLE case_time_allocations ADD COLUMN setup_minutes INTEGER NOT NULL DEFAULT 0`).run();
  }
  if (!caseTimeAllocationColumns.includes('cleanup_minutes')) {
    db.prepare(`ALTER TABLE case_time_allocations ADD COLUMN cleanup_minutes INTEGER NOT NULL DEFAULT 0`).run();
  }

  // 既存DBの ai_extracted_intake に reference_link カラムがない場合は追加。
  // Web注文フォーム(POST /order)経由の代表画像(NAS上のUNCパス)を保持する。
  const aiIntakeColumns = db.prepare(`PRAGMA table_info('ai_extracted_intake')`).all().map(col => col.name);
  if (aiIntakeColumns.length > 0 && !aiIntakeColumns.includes('reference_link')) {
    db.prepare(`ALTER TABLE ai_extracted_intake ADD COLUMN reference_link TEXT`).run();
  }

  // 従業員の曜日ごとの標準勤務パターン
  db.exec(`
    CREATE TABLE IF NOT EXISTS employee_default_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      weekday INTEGER NOT NULL,
      is_working INTEGER NOT NULL DEFAULT 1,
      start_time TEXT,
      end_time TEXT,
      break_minutes INTEGER DEFAULT 0,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_employee_default_schedule_employee_weekday
    ON employee_default_schedule(employee_id, weekday)
  `);

  // 従業員ごとの作業別生産性(1時間あたり処理数)
  db.exec(`
    CREATE TABLE IF NOT EXISTS employee_process_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      process_type TEXT NOT NULL,
      units_per_hour REAL,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_employee_process_rates_employee_process
    ON employee_process_rates(employee_id, process_type)
  `);

  // 既存DBの employee_process_rates に color_count カラムがない場合は追加
  const employeeProcessRateColumns = db.prepare(`PRAGMA table_info('employee_process_rates')`).all().map(col => col.name);
  if (employeeProcessRateColumns.length > 0 && !employeeProcessRateColumns.includes('color_count')) {
    db.prepare(`ALTER TABLE employee_process_rates ADD COLUMN color_count INTEGER DEFAULT 1`).run();
  }

  // 案件ごとのプリント箇所
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_print_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL,
      location_name TEXT,
      color_count INTEGER NOT NULL,
      FOREIGN KEY (case_id) REFERENCES projects(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_case_print_locations_case_id
    ON case_print_locations(case_id)
  `);

  // 案件ごとの名簿(選手名・背番号・サイズ)。Web注文フォーム経由の確定時に引き継ぐ。
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_roster (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL,
      row_no INTEGER,
      player_name TEXT,
      number TEXT,
      size TEXT,
      FOREIGN KEY (case_id) REFERENCES projects(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_case_roster_case_id
    ON case_roster(case_id)
  `);

  // 案件ごとのアイテム(Web注文フォームの複数アイテム対応)。1案件に複数アイテムをぶら下げる。
  // print_locations は case_print_locations.case_item_id で各アイテムに紐づく。
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL,
      item_no INTEGER NOT NULL,
      category TEXT,
      sub_category TEXT,
      catalog_json TEXT,
      method TEXT,
      quantity_total INTEGER DEFAULT 0,
      matrix_json TEXT,
      FOREIGN KEY (case_id) REFERENCES projects(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_case_items_case_id
    ON case_items(case_id)
  `);

  // 既存の case_print_locations にアイテム紐づけ用カラムが無ければ追加(NULL=案件直下=レガシー)
  const printLocCols = db.prepare(`PRAGMA table_info('case_print_locations')`).all().map(c => c.name);
  if (printLocCols.length > 0 && !printLocCols.includes('case_item_id')) {
    db.prepare(`ALTER TABLE case_print_locations ADD COLUMN case_item_id INTEGER`).run();
  }

  // 既存DBの schedule_overrides に is_day_off カラムがない場合は追加
  const scheduleOverrideColumns = db.prepare(`PRAGMA table_info('schedule_overrides')`).all().map(col => col.name);
  if (scheduleOverrideColumns.length > 0 && !scheduleOverrideColumns.includes('is_day_off')) {
    db.prepare(`ALTER TABLE schedule_overrides ADD COLUMN is_day_off INTEGER NOT NULL DEFAULT 0`).run();
  }

  // 既存DBの schedule_overrides に reserved_hours カラムがない場合は追加
  if (scheduleOverrideColumns.length > 0 && !scheduleOverrideColumns.includes('reserved_hours')) {
    db.prepare(`ALTER TABLE schedule_overrides ADD COLUMN reserved_hours REAL DEFAULT 0`).run();
  }

  // 既存DBの employee_default_schedule に reserved_hours カラムがない場合は追加
  const employeeDefaultScheduleColumns = db.prepare(`PRAGMA table_info('employee_default_schedule')`).all().map(col => col.name);
  if (employeeDefaultScheduleColumns.length > 0 && !employeeDefaultScheduleColumns.includes('reserved_hours')) {
    db.prepare(`ALTER TABLE employee_default_schedule ADD COLUMN reserved_hours REAL DEFAULT 0`).run();
  }

  // 案件の納品記録(納品日・発送方法・納品者)。納品済みにする操作は物理削除ではなく
  // projects.status を 'COMPLETED' に変更するだけで、記録はここに残す。
  // 納品者は staff(担当者マスタ)・employees(従業員マスタ)のどちらか一方を選べるようにするため、
  // projects.assigned_staff_id / assigned_employee_id と同じく2列並べる構成にしている
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL,
      delivered_date TEXT NOT NULL,
      delivery_method TEXT NOT NULL,
      delivered_by_staff_id INTEGER,
      delivered_by_employee_id INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (case_id) REFERENCES projects(id),
      FOREIGN KEY (delivered_by_staff_id) REFERENCES staff(id),
      FOREIGN KEY (delivered_by_employee_id) REFERENCES employees(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_delivery_records_case_id ON delivery_records(case_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_delivery_records_delivered_date ON delivery_records(delivered_date)
  `);

  // チーム追加注文の専用URL(トークン)。disabled_at が入っているリンクは公開ページで404になる。
  // アイテム(名称・参考単価・サイズ選択肢)はリンクごとに team_order_link_items で持つ
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_order_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      team_name TEXT NOT NULL,
      memo TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_order_link_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL,
      item_no INTEGER NOT NULL,
      item_name TEXT NOT NULL,
      unit_price INTEGER,
      size_options TEXT,
      FOREIGN KEY (link_id) REFERENCES team_order_links(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_team_order_link_items_link_id
    ON team_order_link_items(link_id)
  `);

  // 取引先向け 納期確認ページの専用URL(トークン)。disabled_at が入っているリンクは公開ページで404になる。
  // 案件との紐付けは customer_patterns(JSON配列)のいずれかが projects.customer_name に
  // 部分一致するかで自動判定する(例: ["八木繊維"] → 顧客名に「八木繊維」を含む案件が対象)
  db.exec(`
    CREATE TABLE IF NOT EXISTS partner_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      partner_name TEXT NOT NULL,
      customer_patterns TEXT NOT NULL,
      memo TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT
    )
  `);

  // 既存DBに preparation_item_master.is_designer_item カラムがない場合は追加。
  // 1の項目は「デザイン担当者の専用項目」= どの案件種別でも登録時にデザイン担当へ自動割り当てされる
  const prepMasterColumns = db.prepare(`PRAGMA table_info('preparation_item_master')`).all().map(col => col.name);
  if (!prepMasterColumns.includes('is_designer_item')) {
    db.prepare(`ALTER TABLE preparation_item_master ADD COLUMN is_designer_item INTEGER NOT NULL DEFAULT 0`).run();
  }

  // デザイナーの日別モード申告(この日はデザインに専念したい等)。本人がマイスケジュールボードで
  // 「デザイン」「デザイン関連業務」を選び、社内の週間スケジュールボードにバッジ表示される
  db.exec(`
    CREATE TABLE IF NOT EXISTS designer_day_modes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      work_date TEXT NOT NULL,
      mode TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(employee_id, work_date),
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);

  // 社員用TODOリスト(スプレッドシート)のタスクを、デザイナーが自分のマイスケジュールボードで
  // 「どの日にやるか」計画した情報。シートの行にはIDが無いため、担当者+タスク本文で同一視する。
  // タスクの内容・状態(未着手/進行中/完了)はシートがマスターで、ここでは日付と見込み時間だけ持つ
  db.exec(`
    CREATE TABLE IF NOT EXISTS designer_sheet_todo_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      task_text TEXT NOT NULL,
      scheduled_date TEXT,
      estimated_hours REAL,
      updated_at TEXT NOT NULL,
      UNIQUE(employee_id, task_text),
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_designer_sheet_todo_plans_date
    ON designer_sheet_todo_plans(scheduled_date)
  `);

  // デザイナー(リモートの鈴木さん等)向け マイスケジュールボードの専用URL(トークン)。
  // チームリンク・取引先リンクと同じトークン方式。employee_id で従業員に紐付け、
  // 本人担当の準備項目の閲覧・日付移動・完了操作と稼働申告(schedule_overrides)を許可する。
  // disabled_at が入っているリンクは公開ページで404になる
  db.exec(`
    CREATE TABLE IF NOT EXISTS designer_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      employee_id INTEGER NOT NULL,
      memo TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);

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

  // デザイン系の準備項目を追加投入(既存DBにも入るよう、codeごとの冪等INSERT)。
  // 2026-07-27 鈴木さんスケジュールボード導入に伴い追加。DTFデータ作成は初期データに既存のため対象外
  {
    const designPrepItems = [
      ['OUTSOURCE_DESIGN_DATA', '外注用デザインデータ作成'],
      ['PROMO_DESIGN_DATA', '販促物用データ作成'],
      ['WORK_INSTRUCTION_CREATION', '作業指示書作成'],
      ['QUOTATION_CREATION', '見積書作成']
    ];
    const existsStmt = db.prepare(`SELECT COUNT(*) as c FROM preparation_item_master WHERE code = ?`);
    const maxOrder = db.prepare(`SELECT COALESCE(MAX(display_order), 0) as m FROM preparation_item_master`).get().m;
    const insertStmt = db.prepare(`INSERT INTO preparation_item_master (code, name, display_order) VALUES (?, ?, ?)`);
    let added = 0;
    designPrepItems.forEach(([code, name], index) => {
      if (existsStmt.get(code).c === 0) {
        insertStmt.run(code, name, maxOrder + index + 1);
        added++;
      }
    });
    if (added > 0) console.log(`✓ デザイン系の準備項目 ${added}件を追加しました`);

    // デザイン担当者の専用項目フラグを付与(冪等)。2026-07-27 社長指定の5項目 =
    // 案件種別を問わず、案件登録時にデザイン担当のマイスケジュールボードへ自動で入る
    const designerItemCodes = [
      'OUTSOURCE_DESIGN_DATA', 'PROMO_DESIGN_DATA', 'DTF_DATA_CREATION',
      'WORK_INSTRUCTION_CREATION', 'QUOTATION_CREATION'
    ];
    const flagged = db.prepare(`
      UPDATE preparation_item_master SET is_designer_item = 1
      WHERE code IN (${designerItemCodes.map(() => '?').join(',')}) AND is_designer_item = 0
    `).run(...designerItemCodes);
    if (flagged.changes > 0) {
      console.log(`✓ デザイン担当者の専用項目フラグを ${flagged.changes}件に付与しました`);
    }
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

  // 未割り当てのデザイン系準備項目をデザイン担当者へバックフィルする。
  // 自動割り当て導入(2026-07-27)前に登録された案件の項目が、どのボードにも表示されず
  // 埋もれてしまうのを防ぐ。対象は「担当者なし・予定日なし・未着手」のうち、
  //  ①社内デザイン案件(INTERNAL_DESIGN)の全項目
  //  ②通常案件のデザイン担当者専用項目(is_designer_item=1)。準備段階を終えた案件は除外
  // 割り当て先は有効なデザイナーリンク(最初に発行されたもの)の従業員。冪等
  {
    const designerLink = db.prepare(`
      SELECT dl.employee_id FROM designer_links dl
      JOIN employees e ON dl.employee_id = e.id
      WHERE dl.disabled_at IS NULL AND e.is_active = 1
      ORDER BY dl.created_at ASC LIMIT 1
    `).get();
    if (designerLink) {
      const backfilled = db.prepare(`
        UPDATE case_preparation_items SET assigned_staff_id = ?
        WHERE assigned_staff_id IS NULL AND scheduled_date IS NULL AND status = '未着手'
          AND (
            case_id IN (SELECT id FROM projects WHERE project_kind = 'INTERNAL_DESIGN')
            OR (
              preparation_item_id IN (SELECT id FROM preparation_item_master WHERE is_designer_item = 1)
              AND case_id IN (
                SELECT id FROM projects
                WHERE status NOT IN ('PREP_COMPLETE', 'INSPECTION', 'DELIVERED', 'COMPLETED')
              )
            )
          )
      `).run(designerLink.employee_id);
      if (backfilled.changes > 0) {
        console.log(`✓ デザイン系の準備項目 ${backfilled.changes}件をデザイン担当(従業員#${designerLink.employee_id})へ割り当てました`);
      }
    }
  }

  // schedule_overrides の同一従業員×同一日の重複行を解消し、UNIQUE制約を追加(2026-07-27)。
  // 以前は2人が同時に同じ日の勤務時間モーダルを開くと両方がPOSTして重複行が生まれ、
  // 空き時間計算がどちらを使うか不定だった。重複がある場合は最後に保存された行(id最大)を残す。
  // UNIQUE INDEX追加後はサーバー側がUPSERT(ON CONFLICT DO UPDATE)で受けるため再発しない。
  // 注意: 既存DBには schema.sql 由来の「同名の非UNIQUEインデックス」が存在するため、
  // IF NOT EXISTSでは張り替わらない。PRAGMAでunique属性を確認し、非UNIQUEなら作り直す。
  const overrideIdx = db.prepare(`PRAGMA index_list('schedule_overrides')`).all()
    .find(idx => idx.name === 'idx_schedule_overrides_employee_date');
  if (!overrideIdx || !overrideIdx.unique) {
    const dupOverrides = db.prepare(`
      SELECT COUNT(*) AS c FROM schedule_overrides
      WHERE id NOT IN (SELECT MAX(id) FROM schedule_overrides GROUP BY employee_id, work_date)
    `).get();
    if (dupOverrides.c > 0) {
      db.prepare(`
        DELETE FROM schedule_overrides
        WHERE id NOT IN (SELECT MAX(id) FROM schedule_overrides GROUP BY employee_id, work_date)
      `).run();
      console.log(`✓ schedule_overrides の重複 ${dupOverrides.c}件を解消しました(最後に保存された行を残しています)`);
    }
    db.exec(`
      DROP INDEX IF EXISTS idx_schedule_overrides_employee_date;
      CREATE UNIQUE INDEX idx_schedule_overrides_employee_date
        ON schedule_overrides (employee_id, work_date);
    `);
    console.log('✓ schedule_overrides のインデックスをUNIQUEに張り替えました');
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
