-- 担当者テーブル
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  capacity_minutes REAL NOT NULL DEFAULT 480,
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 案件テーブル
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_name TEXT NOT NULL,
  received_date TEXT NOT NULL,
  deadline TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  contact_method TEXT NOT NULL,
  work_content TEXT,
  process_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  planned_hours REAL NOT NULL,
  assigned_staff_id INTEGER,
  status TEXT NOT NULL DEFAULT 'PRE_ORDER',
  priority TEXT NOT NULL DEFAULT 'MEDIUM',
  reference_link TEXT,
  nas_folder_path TEXT,
  prep_items TEXT,
  memo TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (assigned_staff_id) REFERENCES staff(id)
);

-- 従業員テーブル
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 曜日ごとの固定勤務パターンという仕組みは廃止。勤務時間の管理はすべて schedule_overrides に一本化した
DROP TABLE IF EXISTS employee_fixed_schedule;

-- 従業員の日ごとの勤務時間（この行がある日だけ勤務。is_day_off=1ならその日は休みとして記録）
CREATE TABLE IF NOT EXISTS schedule_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  work_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  break_minutes INTEGER DEFAULT 0,
  is_day_off INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);

-- 案件ごとの作業計画（日付・担当従業員ごとの予定/実績工数）
-- case_id は本アプリの案件テーブル（projects）のIDを指す
CREATE TABLE IF NOT EXISTS case_time_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  work_date TEXT NOT NULL,
  planned_hours REAL NOT NULL,
  actual_hours REAL,
  carried_over_from TEXT,
  status TEXT DEFAULT '予定',
  FOREIGN KEY (case_id) REFERENCES projects(id),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);

-- 準備項目マスター(案件新規登録画面の選択肢。codeは既存のprep_items CSVコードと一致させる)
CREATE TABLE IF NOT EXISTS preparation_item_master (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  display_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1
);

-- 案件ごとの準備項目タスク(担当者・工数・完了状態を持つ)
CREATE TABLE IF NOT EXISTS case_preparation_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  preparation_item_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT '未着手',
  assigned_staff_id INTEGER,
  scheduled_date TEXT,
  estimated_hours REAL,
  completed_at TEXT,
  FOREIGN KEY (case_id) REFERENCES projects(id),
  FOREIGN KEY (preparation_item_id) REFERENCES preparation_item_master(id),
  FOREIGN KEY (assigned_staff_id) REFERENCES employees(id)
);

-- LINEユーザー(Webhookで受信したuserIdごとのプロフィール)
CREATE TABLE IF NOT EXISTS line_users (
  line_user_id TEXT PRIMARY KEY,
  display_name TEXT,
  first_seen_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL
);

-- LINE Webhookで受信したメッセージ
CREATE TABLE IF NOT EXISTS line_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL,
  line_message_id TEXT,
  message_type TEXT NOT NULL,
  text_content TEXT,
  image_path TEXT,
  received_at TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  case_id INTEGER,
  FOREIGN KEY (line_user_id) REFERENCES line_users(line_user_id)
);

-- LINEメッセージをAnthropic APIで構造化抽出した受注情報の下書き
CREATE TABLE IF NOT EXISTS ai_extracted_intake (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  customer_name TEXT,
  items TEXT,
  quantity TEXT,
  deadline TEXT,
  notes TEXT,
  raw_ai_response TEXT,
  message_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  case_id INTEGER,
  FOREIGN KEY (line_user_id) REFERENCES line_users(line_user_id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_projects_deadline ON projects(deadline);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_assigned_staff ON projects(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_is_active ON staff(is_active);
CREATE INDEX IF NOT EXISTS idx_employees_is_active ON employees(is_active);
CREATE INDEX IF NOT EXISTS idx_case_time_allocations_case_id ON case_time_allocations(case_id);
CREATE INDEX IF NOT EXISTS idx_case_time_allocations_work_date ON case_time_allocations(work_date);
CREATE INDEX IF NOT EXISTS idx_schedule_overrides_employee_date ON schedule_overrides(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_case_preparation_items_case_id ON case_preparation_items(case_id);
CREATE INDEX IF NOT EXISTS idx_case_preparation_items_scheduled_date ON case_preparation_items(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_line_messages_line_user_id ON line_messages(line_user_id);
CREATE INDEX IF NOT EXISTS idx_line_messages_received_at ON line_messages(received_at);
CREATE INDEX IF NOT EXISTS idx_ai_extracted_intake_line_user_id ON ai_extracted_intake(line_user_id);
CREATE INDEX IF NOT EXISTS idx_ai_extracted_intake_status ON ai_extracted_intake(status);
