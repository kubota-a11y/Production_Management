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
  memo TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (assigned_staff_id) REFERENCES staff(id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_projects_deadline ON projects(deadline);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_assigned_staff ON projects(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_is_active ON staff(is_active);
