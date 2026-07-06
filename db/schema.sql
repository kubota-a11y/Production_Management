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

-- インデックス
CREATE INDEX IF NOT EXISTS idx_projects_deadline ON projects(deadline);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_assigned_staff ON projects(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_is_active ON staff(is_active);
CREATE INDEX IF NOT EXISTS idx_employees_is_active ON employees(is_active);
CREATE INDEX IF NOT EXISTS idx_case_time_allocations_case_id ON case_time_allocations(case_id);
CREATE INDEX IF NOT EXISTS idx_case_time_allocations_work_date ON case_time_allocations(work_date);
CREATE INDEX IF NOT EXISTS idx_schedule_overrides_employee_date ON schedule_overrides(employee_id, work_date);
