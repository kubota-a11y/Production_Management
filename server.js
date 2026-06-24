const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const { initDatabase } = require('./db/init');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// ミドルウェア
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// DB初期化
const db = initDatabase();

// =====================
// API: 案件関連
// =====================

// 全案件取得
app.get('/api/projects', (req, res) => {
  try {
    const projects = db.prepare(`
      SELECT 
        p.*,
        s.name as assigned_staff_name
      FROM projects p
      LEFT JOIN staff s ON p.assigned_staff_id = s.id
      ORDER BY p.deadline ASC
    `).all();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 単一案件取得
app.get('/api/projects/:id', (req, res) => {
  try {
    const project = db.prepare(`
      SELECT 
        p.*,
        s.name as assigned_staff_name
      FROM projects p
      LEFT JOIN staff s ON p.assigned_staff_id = s.id
      WHERE p.id = ?
    `).get(req.params.id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 案件作成
app.post('/api/projects', (req, res) => {
  try {
    const {
      project_name,
      received_date,
      deadline,
      customer_name,
      contact_method,
      work_content,
      process_type,
      quantity,
      planned_hours,
      assigned_staff_id,
      status,
      priority,
      reference_link,
      memo
    } = req.body;

    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO projects (
        project_name, received_date, deadline, customer_name,
        contact_method, work_content, process_type, quantity,
        planned_hours, assigned_staff_id, status, priority,
        reference_link, memo, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      project_name,
      received_date,
      deadline,
      customer_name,
      contact_method,
      work_content || '',
      process_type,
      quantity,
      planned_hours,
      assigned_staff_id || null,
      status || 'PRE_ORDER',
      priority || 'MEDIUM',
      reference_link || '',
      memo || '',
      now,
      now
    );

    res.status(201).json({
      id: result.lastInsertRowid,
      message: 'Project created successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 案件更新
app.put('/api/projects/:id', (req, res) => {
  try {
    const {
      project_name,
      received_date,
      deadline,
      customer_name,
      contact_method,
      work_content,
      process_type,
      quantity,
      planned_hours,
      assigned_staff_id,
      status,
      priority,
      reference_link,
      memo
    } = req.body;

    const now = new Date().toISOString();

    const stmt = db.prepare(`
      UPDATE projects SET
        project_name = ?,
        received_date = ?,
        deadline = ?,
        customer_name = ?,
        contact_method = ?,
        work_content = ?,
        process_type = ?,
        quantity = ?,
        planned_hours = ?,
        assigned_staff_id = ?,
        status = ?,
        priority = ?,
        reference_link = ?,
        memo = ?,
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      project_name,
      received_date,
      deadline,
      customer_name,
      contact_method,
      work_content || '',
      process_type,
      quantity,
      planned_hours,
      assigned_staff_id || null,
      status,
      priority,
      reference_link || '',
      memo || '',
      now,
      req.params.id
    );

    res.json({ message: 'Project updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 案件削除
app.delete('/api/projects/:id', (req, res) => {
  try {
    const stmt = db.prepare('DELETE FROM projects WHERE id = ?');
    stmt.run(req.params.id);
    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================
// API: 担当者関連
// =====================

// 全担当者取得
app.get('/api/staff', (req, res) => {
  try {
    const staff = db.prepare(`
      SELECT * FROM staff WHERE is_active = 1 ORDER BY id ASC
    `).all();
    res.json(staff);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 担当者作成
app.post('/api/staff', (req, res) => {
  try {
    const { name, role, capacity_minutes } = req.body;
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO staff (name, role, capacity_minutes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      name,
      role || 'FULL_TIME',
      capacity_minutes || 480,
      now,
      now
    );

    res.status(201).json({
      id: result.lastInsertRowid,
      message: 'Staff created successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 担当者更新
app.put('/api/staff/:id', (req, res) => {
  try {
    const { name, role, capacity_minutes } = req.body;
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      UPDATE staff SET
        name = ?,
        role = ?,
        capacity_minutes = ?,
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(name, role, capacity_minutes || 480, now, req.params.id);
    res.json({ message: 'Staff updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 担当者削除（ソフトデリート）
app.delete('/api/staff/:id', (req, res) => {
  try {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      UPDATE staff SET is_active = 0, updated_at = ? WHERE id = ?
    `);
    stmt.run(now, req.params.id);
    res.json({ message: 'Staff deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================
// API: 統計関連
// =====================

// 担当者別の当日作業時間合計
app.get('/api/stats/daily-workload', (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];

    const workload = db.prepare(`
      SELECT
        s.id,
        s.name,
        s.capacity_minutes,
        COALESCE(SUM(p.planned_hours), 0) as total_minutes,
        CASE
          WHEN COALESCE(SUM(p.planned_hours), 0) > s.capacity_minutes THEN 'over'
          WHEN COALESCE(SUM(p.planned_hours), 0) > s.capacity_minutes * 0.8 THEN 'warning'
          ELSE 'ok'
        END as status
      FROM staff s
      LEFT JOIN projects p ON
        s.id = p.assigned_staff_id AND
        DATE(p.deadline) = ? AND
        p.status IN ('WAITING', 'IN_PROGRESS', 'INSPECTION')
      WHERE s.is_active = 1
      GROUP BY s.id
      ORDER BY s.id
    `).all(date);

    res.json(workload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================
// ルートレスポンス
// =====================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  プリント刺繍加工業向け案件管理システム                    ║
║  Production Management System                              ║
╚════════════════════════════════════════════════════════════╝

✓ サーバーが起動しました
✓ Server is running

📌 ローカルアクセス:  http://localhost:${PORT}
📌 LANアクセス:       http://${getLocalIP()}:${PORT}

💡 複数デバイスからは上記のLAN IPアドレスでアクセスしてください
💡 Access from other devices using the LAN IP address above

按 Ctrl+C で停止 / Press Ctrl+C to stop
  `);
});

function getLocalIP() {
  const interfaces = require('os').networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

module.exports = app;
