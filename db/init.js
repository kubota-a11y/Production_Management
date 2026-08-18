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

  // 既存DBに freee_quote_url / freee_invoice_url カラムがない場合は追加。
  // Freee上の見積書・請求書の画面URLを案件に持たせ、納品後もHiBoardから1クリックで辿れるようにする
  if (!columns.includes('freee_quote_url')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN freee_quote_url TEXT`).run();
  }
  if (!columns.includes('freee_invoice_url')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN freee_invoice_url TEXT`).run();
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
  // 紹介コード(紹介キャンペーン)。Web注文フォームの入力値を保持する(2026-07-31 追加)
  if (aiIntakeColumns.length > 0 && !aiIntakeColumns.includes('referral_code')) {
    db.prepare(`ALTER TABLE ai_extracted_intake ADD COLUMN referral_code TEXT`).run();
  }
  // 受注候補の振り分け(2026-08-05 追加)。三浦・山本の2名が全チャネルの注文を一度受け、
  // 「生産案件 / デザイン案件全般 / 要相談」の行き先を決めてから進行させる運用のため。
  // status とは別軸で持つ(status='pending' のまま triage_type だけ入る = 行き先決定済み・案件登録前)。
  if (aiIntakeColumns.length > 0 && !aiIntakeColumns.includes('triage_type')) {
    db.prepare(`ALTER TABLE ai_extracted_intake ADD COLUMN triage_type TEXT`).run();
    db.prepare(`ALTER TABLE ai_extracted_intake ADD COLUMN triage_by TEXT`).run();
    db.prepare(`ALTER TABLE ai_extracted_intake ADD COLUMN triage_at TEXT`).run();
    console.log('✓ ai_extracted_intake に振り分け列(triage_type/triage_by/triage_at)を追加しました');
  }

  // 顧客メモ(顧客台帳ページ用)。顧客マスタは持たず projects.customer_name の
  // TRIM値をキーに、担当窓口・連絡先・注意点などを顧客単位で書き残す
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT NOT NULL UNIQUE,
      contact_person TEXT,
      contact_info TEXT,
      memo TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

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

  // 紹介パートナー(紹介キャンペーン)。会社が発行したコードを持つ人だけが
  // 公開ページ /referral を開ける。コードは「解錠キー」と「配布する紹介コード」を兼ねる。
  // partner_type で特典の出し分けをする: TEAM=チーム単位(例: 〇〇FC) / INDIVIDUAL=個人単位
  // disabled_at が入っているコードは公開ページで弾く(受注フォーム側の記録は残す)
  db.exec(`
    CREATE TABLE IF NOT EXISTS referral_partners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      partner_type TEXT NOT NULL,
      partner_name TEXT NOT NULL,
      memo TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT
    )
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

  // 取引先ごとの受付控えメールの送信先(JSON配列)。加工依頼フォームの送信時に、
  // フォームのメール欄への入力の有無にかかわらずこのアドレス全員へ控えを送る。
  // (例: 八木繊維の窓口2名。誰が入力しても両名に届くようにするための設定)
  const partnerLinkColumns = db.prepare(`PRAGMA table_info('partner_links')`).all().map(col => col.name);
  if (!partnerLinkColumns.includes('notify_emails')) {
    db.prepare(`ALTER TABLE partner_links ADD COLUMN notify_emails TEXT NOT NULL DEFAULT '[]'`).run();
    console.log('✓ partner_links.notify_emails を追加しました');
  }

  // デザイン担当が自分のボードから「自分の担当ではない」として外した記録(2026-08-18)。
  // 単に assigned_staff_id を NULL に戻すだけだと、案件を編集するたびに
  // registerPreparationItems の寄せ直しでまた本人へ戻ってしまうため、外した事実を残して
  // 寄せ直しの対象から除外する。三浦さんが改めて誰かに割り当てるとクリアされる
  const prepItemColumns = db.prepare(`PRAGMA table_info('case_preparation_items')`).all().map(col => col.name);
  if (!prepItemColumns.includes('designer_released_at')) {
    db.prepare(`ALTER TABLE case_preparation_items ADD COLUMN designer_released_at TEXT`).run();
    console.log('✓ case_preparation_items.designer_released_at を追加しました');
  }

  // 既存DBに preparation_item_master.is_designer_item カラムがない場合は追加。
  // 1の項目は「デザイン担当者の専用項目」= どの案件種別でも登録時にデザイン担当へ自動割り当てされる
  const prepMasterColumns = db.prepare(`PRAGMA table_info('preparation_item_master')`).all().map(col => col.name);
  if (!prepMasterColumns.includes('is_designer_item')) {
    db.prepare(`ALTER TABLE preparation_item_master ADD COLUMN is_designer_item INTEGER NOT NULL DEFAULT 0`).run();
  }

  // オペレーション段階(2026-08-03)。オペレーション担当(山本さん)のボード用。
  // 既存の projects.status は生産工程の軸なので触らず、デザイン案件の進行を別軸で持つ。
  //  ops_stage       BRIEF/DESIGN/REVIEW/PRODUCTION/BILLING/DONE
  //  ops_wait_on     REVIEW段階のみ YAMAMOTO(社内が動く番)/CUSTOMER(お客様の返事待ち)
  //  ops_stage_since 現在の段階に入った日時(滞留日数の表示に使う)
  const projectColumns = db.prepare(`PRAGMA table_info('projects')`).all().map(col => col.name);
  if (!projectColumns.includes('ops_stage')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN ops_stage TEXT NOT NULL DEFAULT 'BRIEF'`).run();
    console.log('✓ projects.ops_stage を追加しました');
  }
  if (!projectColumns.includes('ops_wait_on')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN ops_wait_on TEXT`).run();
  }
  if (!projectColumns.includes('ops_stage_since')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN ops_stage_since TEXT`).run();
  }
  // 確認段階の中身を2値(YAMAMOTO/CUSTOMER)から4ステップへ作り替えたための移行(2026-08-03)。
  // 山本→お客様連絡 / お客様の返事待ち / 位置・大きさの調整 / 最終確認待ち の順に進む。
  // 旧値は「社内の番」→SEND、「お客様待ち」→REPLY_WAIT に読み替える。冪等
  if (projectColumns.includes('ops_wait_on')) {
    const moved = db.prepare(`
      UPDATE projects SET ops_wait_on = CASE ops_wait_on
        WHEN 'YAMAMOTO' THEN 'SEND'
        WHEN 'CUSTOMER' THEN 'REPLY_WAIT'
        ELSE ops_wait_on END
      WHERE ops_wait_on IN ('YAMAMOTO', 'CUSTOMER')
    `).run();
    if (moved.changes > 0) {
      console.log(`✓ 確認段階の待ち先 ${moved.changes}件を新しい4ステップへ移行しました`);
    }
  }

  // 進行タイプ(2026-08-03)。デザイン案件全般ボードの流れを案件ごとに分ける。
  //   FULL       = 加工まで(標準の7段階)
  //   SUBMIT_END = 紙媒体など。お客様の最終OK後に鈴木さんが入稿し、請求を経て完了
  //                (検品・納品は通らない。登録時は制作から始まる)
  if (!projectColumns.includes('ops_flow')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN ops_flow TEXT NOT NULL DEFAULT 'FULL'`).run();
    console.log('✓ projects.ops_flow を追加しました');
  }

  // 紙媒体案件の出どころ(2026-08-03)。ops_flow='SUBMIT_END' のときだけ意味を持つ。
  //   HIYOSHI = 弊社から鈴木さんへ依頼している紙媒体
  //   CARVE   = 鈴木さんがCARVEで受けている紙媒体(イレギュラー案件。ボードで目立たせる)
  if (!projectColumns.includes('paper_source')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN paper_source TEXT NOT NULL DEFAULT 'HIYOSHI'`).run();
    console.log('✓ projects.paper_source を追加しました');
  }

  // CARVE案件の作業段階(2026-08-05)。paper_source='CARVE' のときだけ意味を持つ。
  // 鈴木さんがCARVEで受けている案件は ラフアップ→写真入れアップ→修正アップ→入稿 の
  // 4段階で進むため、いまどこかをカード上のバッジで示す(値は lib/ops-board.js の CARVE_STAGES)
  if (!projectColumns.includes('carve_stage')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN carve_stage TEXT NOT NULL DEFAULT 'ROUGH'`).run();
    console.log('✓ projects.carve_stage を追加しました');
  }

  // 校正の状態(2026-08-07 社長指示)。初校 → 修正 → 校了 のどこまで進んだかを
  // 鈴木さんのマイスケジュールボードのタスクカードにバッジで出し、本人が切り替える。
  // 案件単位(同じ案件のカードは全部同じ状態)。未選択の状態があるので NULL 許容
  // (値は lib/designer-board.js の PROOF_STAGES)
  if (!projectColumns.includes('proof_stage')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN proof_stage TEXT`).run();
    console.log('✓ projects.proof_stage を追加しました');
  }

  // デザインの修正往復(2026-08-07 社長指示)。お客様確認後の修正指示で「確認→制作」へ
  // 戻した回数と、直近の修正指示メモ。全般ボードの「✏️ 修正で鈴木さんへ戻す」ボタンで更新される
  if (!projectColumns.includes('design_revision_round')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN design_revision_round INTEGER NOT NULL DEFAULT 0`).run();
    console.log('✓ projects.design_revision_round を追加しました');
  }
  if (!projectColumns.includes('design_revision_note')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN design_revision_note TEXT`).run();
    console.log('✓ projects.design_revision_note を追加しました');
  }

  // 紙媒体案件の工程ごとの納期(2026-08-03)。ops_flow='SUBMIT_END' のときに使う。
  // 案件全体の納期(deadline)だけだと、鈴木さんが「初校はいつまで」「入稿はいつまで」を
  // 判断できないため、工程ごとに分けて持たせる。空なら案件の納期を使う
  // (列名の first_draft は導入時の名残。画面上の表記は「初校」)
  if (!projectColumns.includes('first_draft_due')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN first_draft_due TEXT`).run();
    console.log('✓ projects.first_draft_due を追加しました');
  }
  if (!projectColumns.includes('submission_due')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN submission_due TEXT`).run();
  }

  // アイテム名(2026-08-03)。「ドライTシャツ」「az50018 半袖ポロシャツ」など、
  // 何を作る案件なのかを一目で分かるようにするための自由入力。
  // Web注文フォーム由来の案件は case_items を持つのでそちらから補完できるが、
  // 手入力で登録した案件には拠り所が無かったため追加した
  if (!projectColumns.includes('item_name')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN item_name TEXT`).run();
    console.log('✓ projects.item_name を追加しました');
  }

  // デザイン作業の予定時間(2026-08-18 三浦さん・鈴木さんとのMTGで決定)。
  // 既存の planned_hours は「アイテムを作る作業」の予定時間(分)で、スケジュールボードの
  // 配分に使われる。そこにデザインの時間を混ぜると製造の見積もりが狂うため列を分ける。
  // 画面上の表記は planned_hours=「制作予定時間」/ design_planned_hours=「デザイン予定時間」。
  // どちらも未定のまま登録できる(必須にすると受付が止まるため)
  if (!projectColumns.includes('design_planned_hours')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN design_planned_hours REAL`).run();
    console.log('✓ projects.design_planned_hours を追加しました');
  }

  // 入金・現金の預かり状況(2026-08-18 同MTGで決定)。
  // 「お金持っていきます」「入金しました」の電話連絡を無くし、案件一覧の上で見えるようにする。
  //   UNPAID        = 未入金(既定)
  //   CASH_RECEIVED = 現金を社員が預かっている(payment_holder_employee_id が誰か)
  //   PAID          = 入金済み
  // 将来オンライン決済へ移行したら、この列を見なくする形で外せるようにボタン側だけで完結させている
  if (!projectColumns.includes('payment_status')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'UNPAID'`).run();
    console.log('✓ projects.payment_status を追加しました');
  }
  if (!projectColumns.includes('payment_holder_employee_id')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN payment_holder_employee_id INTEGER REFERENCES employees(id)`).run();
    console.log('✓ projects.payment_holder_employee_id を追加しました');
  }
  if (!projectColumns.includes('payment_updated_at')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN payment_updated_at TEXT`).run();
    console.log('✓ projects.payment_updated_at を追加しました');
  }

  // 支払方法(2026-08-18 社長指示で追加)。入金状態とは別の軸で持つ。
  //   CASH = 現金 / TRANSFER = 振込 / CREDIT = クレジットカード
  // 状態と分けているのは「振込だがまだ入金確認できていない」を表せるようにするため。
  // 未選択(NULL)も許す — 受付時点で支払方法が決まっていない案件があるため
  if (!projectColumns.includes('payment_method')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN payment_method TEXT`).run();
    console.log('✓ projects.payment_method を追加しました');
  }

  // 「デザイン案件全般」ボードに載せるかどうかのフラグ(2026-08-03)。
  // 準備項目からの推測ではなく、案件登録時にチェックした案件だけを載せる(社長判断)
  if (!projectColumns.includes('is_design_ops')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN is_design_ops INTEGER NOT NULL DEFAULT 0`).run();
    // 導入前から表示されていた案件が消えないよう、旧条件(デザイン系準備項目を持つ or 社内デザイン案件)に
    // 当てはまる未完了案件へ1回だけフラグを立てる。以降は登録時のチェックのみで決まる
    const migrated = db.prepare(`
      UPDATE projects SET is_design_ops = 1
      WHERE ops_stage != 'DONE' AND (
        project_kind = 'INTERNAL_DESIGN'
        OR id IN (
          SELECT cpi.case_id FROM case_preparation_items cpi
          JOIN preparation_item_master pim ON cpi.preparation_item_id = pim.id
          WHERE pim.is_designer_item = 1 OR pim.code = 'DESIGN_ROUGH'
        )
      )
    `).run();
    console.log(`✓ projects.is_design_ops を追加しました(既存の${migrated.changes}件にフラグを設定)`);
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
      ['QUOTATION_CREATION', '見積書作成'],
      // 2026-08-03 オペレーションボード導入で追加。
      // デザインラフ作成 = オペレーション担当(山本さん)が描いてデザイナーへ渡す下絵。デザイナー専用項目にはしない
      ['DESIGN_ROUGH', 'デザインラフ作成'],
      // 初校提出 = デザイナーがこれを完了すると、オペ段階が「制作」→「確認」へ自動で進む
      ['FIRST_DRAFT_SUBMIT', '初校提出'],
      // 入稿完了 = 紙媒体(入稿で完了)タイプの案件にだけ自動付与。
      // デザイナーがこれを完了すると、オペ段階が「請求」へ自動で進む(2026-08-03)
      ['SUBMISSION_COMPLETE', '入稿完了']
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
    // ※ DTFデータ作成は 2026-08-18 のMTGでこの一覧から外した(下の解除処理を参照)
    const designerItemCodes = [
      'OUTSOURCE_DESIGN_DATA', 'PROMO_DESIGN_DATA',
      'WORK_INSTRUCTION_CREATION', 'QUOTATION_CREATION',
      // 初校提出・入稿完了はデザイナー本人が完了操作をするのでマイボードに自動で入れる(2026-08-03)
      'FIRST_DRAFT_SUBMIT', 'SUBMISSION_COMPLETE'
    ];
    const flagged = db.prepare(`
      UPDATE preparation_item_master SET is_designer_item = 1
      WHERE code IN (${designerItemCodes.map(() => '?').join(',')}) AND is_designer_item = 0
    `).run(...designerItemCodes);
    if (flagged.changes > 0) {
      console.log(`✓ デザイン担当者の専用項目フラグを ${flagged.changes}件に付与しました`);
    }

    // 「DTFデータ作成」をデザイナー自動割り当ての対象から外す(2026-08-18 社長指示)。
    // 加工だけの追加注文(例: チームの1〜2枚追加)でも DTFデータ作成が選ばれると
    // 鈴木さんのマイスケジュールボードにカードが積まれてしまい、本当にやるべき作業が
    // 埋もれていた。データ作成が必要なときは案件の作業内容に書いて個別に依頼する運用にする。
    // 刺繍データ作成依頼・スクリーンデータ作成は元々このフラグが付いていないため対象外。冪等
    const unflagged = db.prepare(`
      UPDATE preparation_item_master SET is_designer_item = 0
      WHERE code = 'DTF_DATA_CREATION' AND is_designer_item = 1
    `).run();
    if (unflagged.changes > 0) {
      console.log('✓ 準備項目「DTFデータ作成」をデザイナー自動割り当ての対象から外しました');
    }
    // 既に鈴木さんへ割り当て済みのDTFデータ作成カードのうち、完了していないものは
    // 割り当てを解除してボードから下ろす。完了済みの記録には触らない。
    // 判定は status だけで行う(completed_at は見ない) — 一度完了にした項目を未着手へ戻すと
    // status='未着手' なのに completed_at が残ることがあり、そこを条件に入れると
    // 鈴木さんのボードには出ているのに解除されないカードが残ってしまうため。
    // ボードの「日付が未定のタスク」も status != '完了' で拾っているので条件を揃える。
    // 予定日に置き済みのカードも対象にする(下ろす以上、予定からも外す)。毎回起動時に走る冪等処理
    const detached = db.prepare(`
      UPDATE case_preparation_items SET assigned_staff_id = NULL, scheduled_date = NULL
      WHERE assigned_staff_id IS NOT NULL
        AND status != '完了'
        AND preparation_item_id = (SELECT id FROM preparation_item_master WHERE code = 'DTF_DATA_CREATION')
    `).run();
    if (detached.changes > 0) {
      console.log(`✓ 未完了の「DTFデータ作成」${detached.changes}件をデザイナーの担当から外しました`);
    }

    // 未着手なのに完了日時が残っている項目の後始末(冪等)。
    // 上のような「status と completed_at が食い違う行」は、条件に completed_at を使う処理を
    // すべて狂わせるため、状態そのものを揃えておく
    const cleared = db.prepare(`
      UPDATE case_preparation_items SET completed_at = NULL
      WHERE status != '完了' AND completed_at IS NOT NULL
    `).run();
    if (cleared.changes > 0) {
      console.log(`✓ 未完了なのに完了日時が残っていた準備項目 ${cleared.changes}件を整えました`);
    }

    // 正しい校正用語に訂正: 「初稿提出」→「初校提出」(2026-08-05 社長指示)。
    // 既存DBには旧名のままマスターが入っているため、冪等なUPDATEで名前だけ直す
    // (コード FIRST_DRAFT_SUBMIT は変えないので、案件データや自動遷移には影響しない)
    const renamed = db.prepare(`
      UPDATE preparation_item_master SET name = '初校提出'
      WHERE code = 'FIRST_DRAFT_SUBMIT' AND name = '初稿提出'
    `).run();
    if (renamed.changes > 0) {
      console.log('✓ 準備項目「初稿提出」を「初校提出」に改名しました');
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

  // オペレーション段階の初期値を既存案件へ振る(2026-08-03、1回だけ)。
  // ops_stage_since が未設定の案件を対象にするので冪等。生産工程のステータスから当てはめる:
  //   納品済み → DONE / 準備完了以降 → PRODUCTION / それ以前 → BRIEF
  // (デザイン案件かどうかの絞り込みは表示側で行うため、ここでは全案件に入れておく)
  {
    const now = new Date().toISOString();
    const seeded = db.prepare(`
      UPDATE projects
      SET ops_stage = CASE
            WHEN status = 'COMPLETED' THEN 'DONE'
            WHEN status IN ('PREP_COMPLETE', 'IN_PROGRESS', 'INSPECTION', 'DELIVERED') THEN 'PRODUCTION'
            ELSE 'BRIEF'
          END,
          ops_stage_since = ?
      WHERE ops_stage_since IS NULL
    `).run(now);
    if (seeded.changes > 0) {
      console.log(`✓ 既存案件 ${seeded.changes}件にオペレーション段階の初期値を設定しました`);
    }
  }

  // 納品済み(COMPLETED)案件に残っている未完了の準備項目を完了にする(2026-07-30)。
  // 納品時に完了扱いにする処理を入れる前に納品された案件のぶんを1回だけ拾う。
  // 残っていると準備項目リストの繰り越し・デザイナーのマイボード・勤務時間編集の
  // 割り当て候補に永久に出続けるため。completed_at は納品日を使う(無ければ現在時刻)。冪等
  {
    const closed = db.prepare(`
      UPDATE case_preparation_items
      SET status = '完了',
          completed_at = COALESCE(
            (SELECT MAX(dr.delivered_date) FROM delivery_records dr WHERE dr.case_id = case_preparation_items.case_id),
            ?
          )
      WHERE status != '完了'
        AND case_id IN (SELECT id FROM projects WHERE status = 'COMPLETED')
    `).run(new Date().toISOString());
    if (closed.changes > 0) {
      console.log(`✓ 納品済み案件に残っていた準備項目 ${closed.changes}件を完了にしました`);
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
