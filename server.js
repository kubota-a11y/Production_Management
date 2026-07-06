require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { initDatabase } = require('./db/init');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
// NAS_BASE_PATH は .env で明示的に指定するのが基本。
// 未設定時のデフォルトはOSごとに変える（Windowsではマップ済みドライブ文字 or UNCパスを想定）。
const NAS_BASE_PATH = process.env.NAS_BASE_PATH
  || (process.platform === 'win32' ? 'Z:\\DESIGN' : '/Volumes/disk1/DESIGN');

// パス比較用ヘルパー。Windowsはファイルパスの大文字小文字を区別しないため、
// セキュリティチェック(startsWith)がケース違いで誤ってブロックしないよう吸収する。
function isWithinBase(resolvedPath, basePath) {
  const base = path.resolve(basePath);
  if (process.platform === 'win32') {
    return resolvedPath.toLowerCase().startsWith(base.toLowerCase());
  }
  return resolvedPath.startsWith(base);
}

// OSのファイルマネージャでファイル/フォルダを開く（Finder/エクスプローラー/ファイルマネージャ）
function openInFileManager(targetPath) {
  if (process.platform === 'win32') {
    // explorer.exeは正常に開いた場合でも終了コード1を返すことがあるため、
    // execFileSyncの例外は握りつぶす（起動コマンド自体が失敗した場合のみ気にする）
    try {
      execFileSync('explorer', [targetPath]);
    } catch (err) {
      // ENOENT(explorerが見つからない)等の致命的エラーのみ再スロー
      if (err.code === 'ENOENT') throw err;
    }
  } else if (process.platform === 'darwin') {
    execFileSync('open', [targetPath]);
  } else {
    execFileSync('xdg-open', [targetPath]);
  }
}

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const db = initDatabase();

app.get('/api/nas/list', (req, res) => {
  try {
    const requestedPath = req.query.path || NAS_BASE_PATH;
    const normalized = path.normalize(requestedPath);
    const resolved = path.resolve(normalized);
    if (!isWithinBase(resolved, NAS_BASE_PATH)) {
      return res.status(400).json({ error: '不正なパスです' });
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return res.json({ path: resolved, exists: false, entries: [] });
    }
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      // NAS(SMB)上でmacOSが自動生成する隠しメタデータファイル（リソースフォーク等）を除外
      .filter(item => !item.name.startsWith('._') && item.name !== '.DS_Store')
      .map(item => ({
        name: item.name,
        isDirectory: item.isDirectory(),
        path: path.join(resolved, item.name)
      }));
    // If entries are inside the public directory, expose a publicUrl so the frontend
    // can open previews directly (only for files served by express.static)
    const publicDir = path.resolve(__dirname, 'public');
    const enhanced = entries.map(e => {
      const fullPath = e.path;
      let publicUrl = null;
      try {
        const rel = path.relative(publicDir, fullPath);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          // convert path separators to URL form and encode segments
          publicUrl = '/' + rel.split(path.sep).map(encodeURIComponent).join('/');
        }
      } catch (err) {
        publicUrl = null;
      }
      return { ...e, publicUrl };
    });

    res.json({ path: resolved, exists: true, entries: enhanced });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/nas/open', (req, res) => {
  try {
    const requestedPath = req.body.path;
    if (!requestedPath) return res.status(400).json({ error: 'Path is required' });
    const normalized = path.normalize(requestedPath);
    const resolved = path.resolve(normalized);
    if (!isWithinBase(resolved, NAS_BASE_PATH)) {
      return res.status(400).json({ error: '不正なパスです' });
    }
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'ファイルが見つかりません' });
    }
    openInFileManager(resolved);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// NASファイルをブラウザ経由でプレビュー/ダウンロード（LAN上のどの端末からでも利用可能）
app.get('/api/nas/download', (req, res) => {
  try {
    const requestedPath = req.query.path;
    if (!requestedPath) return res.status(400).json({ error: 'Path is required' });
    const normalized = path.normalize(requestedPath);
    const resolved = path.resolve(normalized);
    if (!isWithinBase(resolved, NAS_BASE_PATH)) {
      return res.status(400).json({ error: '不正なパスです' });
    }
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      return res.status(404).json({ error: 'ファイルが見つかりません' });
    }
    res.sendFile(resolved);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects', (req, res) => {
  try {
    const projects = db.prepare(`
      SELECT p.*, s.name as assigned_staff_name
      FROM projects p
      LEFT JOIN staff s ON p.assigned_staff_id = s.id
      ORDER BY p.deadline ASC
    `).all();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects/:id', (req, res) => {
  try {
    const project = db.prepare(`
      SELECT p.*, s.name as assigned_staff_name
      FROM projects p
      LEFT JOIN staff s ON p.assigned_staff_id = s.id
      WHERE p.id = ?
    `).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects', (req, res) => {
  try {
    const { project_name, received_date, deadline, customer_name, contact_method,
      work_content, process_type, quantity, planned_hours, assigned_staff_id,
      status, priority, reference_link, memo, nas_folder_path, prep_items } = req.body;
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO projects (
        project_name, received_date, deadline, customer_name, contact_method,
        work_content, process_type, quantity, planned_hours, assigned_staff_id,
        status, priority, reference_link, memo, nas_folder_path, prep_items, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(project_name, received_date, deadline, customer_name, contact_method,
      work_content || '', process_type, quantity, planned_hours, assigned_staff_id || null,
      status || 'PRE_ORDER', priority || 'MEDIUM', reference_link || '', memo || '',
      nas_folder_path || '', prep_items || '', now, now);
    res.status(201).json({ id: result.lastInsertRowid, message: 'Project created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/projects/:id', (req, res) => {
  try {
    const { project_name, received_date, deadline, customer_name, contact_method,
      work_content, process_type, quantity, planned_hours, assigned_staff_id,
      status, priority, reference_link, memo, nas_folder_path, prep_items } = req.body;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE projects SET
        project_name=?, received_date=?, deadline=?, customer_name=?, contact_method=?,
        work_content=?, process_type=?, quantity=?, planned_hours=?, assigned_staff_id=?,
        status=?, priority=?, reference_link=?, memo=?, nas_folder_path=?, prep_items=?, updated_at=?
      WHERE id=?
    `).run(project_name, received_date, deadline, customer_name, contact_method,
      work_content || '', process_type, quantity, planned_hours, assigned_staff_id || null,
      status, priority, reference_link || '', memo || '', nas_folder_path || '', prep_items || '', now, req.params.id);
    res.json({ message: 'Project updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/projects/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== 案件ごとの作業計画 =====

app.get('/api/projects/:projectId/time-allocations', (req, res) => {
  try {
    const allocations = db.prepare(`
      SELECT ta.*, e.name as employee_name
      FROM case_time_allocations ta
      JOIN employees e ON ta.employee_id = e.id
      WHERE ta.case_id = ?
      ORDER BY ta.work_date ASC, ta.id ASC
    `).all(req.params.projectId);
    res.json(allocations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects/:projectId/time-allocations', (req, res) => {
  try {
    const { employee_id, work_date, planned_hours, actual_hours, carried_over_from, status } = req.body;
    const result = db.prepare(`
      INSERT INTO case_time_allocations
        (case_id, employee_id, work_date, planned_hours, actual_hours, carried_over_from, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.projectId, employee_id, work_date, planned_hours,
      actual_hours || null, carried_over_from || null, status || '予定');
    res.status(201).json({ id: result.lastInsertRowid, message: 'Time allocation created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/time-allocations/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM case_time_allocations WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Time allocation not found' });

    // 送信されなかった項目は既存値を維持する（実績時間だけの更新等で他の項目を消さないため）
    const case_id = req.body.case_id !== undefined ? req.body.case_id : existing.case_id;
    const employee_id = req.body.employee_id !== undefined ? req.body.employee_id : existing.employee_id;
    const work_date = req.body.work_date !== undefined ? req.body.work_date : existing.work_date;
    const planned_hours = req.body.planned_hours !== undefined ? req.body.planned_hours : existing.planned_hours;
    const actual_hours = req.body.actual_hours !== undefined ? req.body.actual_hours : existing.actual_hours;
    const carried_over_from = req.body.carried_over_from !== undefined ? req.body.carried_over_from : existing.carried_over_from;
    const status = req.body.status !== undefined ? req.body.status : existing.status;

    db.prepare(`
      UPDATE case_time_allocations SET
        case_id=?, employee_id=?, work_date=?, planned_hours=?, actual_hours=?, carried_over_from=?, status=?
      WHERE id=?
    `).run(case_id, employee_id, work_date, planned_hours, actual_hours, carried_over_from, status, req.params.id);
    res.json({ message: 'Time allocation updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/time-allocations/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM case_time_allocations WHERE id = ?').run(req.params.id);
    res.json({ message: 'Time allocation deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== 週間作業スケジュールボード =====

app.get('/schedule-board', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'schedule-board.html'));
});

app.get('/schedule', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'schedule-board.html'));
});

// その日ごとの勤務時間（employee_fixed_scheduleは廃止し、勤務時間の管理はこのテーブルに一本化）を一括取得
app.get('/api/schedule-overrides', (req, res) => {
  try {
    const overrides = db.prepare(`
      SELECT * FROM schedule_overrides ORDER BY employee_id ASC, work_date ASC
    `).all();
    res.json(overrides);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/schedule-overrides', (req, res) => {
  try {
    const { employee_id, work_date, start_time, end_time, break_minutes, is_day_off } = req.body;
    const result = db.prepare(`
      INSERT INTO schedule_overrides (employee_id, work_date, start_time, end_time, break_minutes, is_day_off)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(employee_id, work_date, start_time || null, end_time || null, break_minutes || 0, is_day_off ? 1 : 0);
    res.status(201).json({ id: result.lastInsertRowid, message: 'Schedule override created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/schedule-overrides/:id', (req, res) => {
  try {
    const { start_time, end_time, break_minutes, is_day_off } = req.body;
    db.prepare(`
      UPDATE schedule_overrides SET start_time=?, end_time=?, break_minutes=?, is_day_off=? WHERE id=?
    `).run(start_time || null, end_time || null, break_minutes || 0, is_day_off ? 1 : 0, req.params.id);
    res.json({ message: 'Schedule override updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/schedule-overrides/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM schedule_overrides WHERE id = ?').run(req.params.id);
    res.json({ message: 'Schedule override deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 期間（start〜end, YYYY-MM-DD）指定で全案件横断の作業計画を取得
app.get('/api/time-allocations', (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'start, end は必須です' });
    }
    const allocations = db.prepare(`
      SELECT ta.*, p.project_name
      FROM case_time_allocations ta
      JOIN projects p ON ta.case_id = p.id
      WHERE ta.work_date BETWEEN ? AND ?
      ORDER BY ta.work_date ASC, ta.employee_id ASC
    `).all(start, end);
    res.json(allocations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 作業計画が存在する案件ごとの消化率（実績時間合計 ÷ 案件の作業予定時間）
app.get('/api/stats/project-progress', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.id, p.project_name, p.planned_hours,
        COALESCE(SUM(ta.actual_hours), 0) as actual_hours_total,
        MAX(ta.work_date) as last_work_date
      FROM projects p
      JOIN case_time_allocations ta ON ta.case_id = p.id
      GROUP BY p.id
      ORDER BY last_work_date DESC
    `).all();

    // projects.planned_hours は「分」単位、case_time_allocations の各hoursは「時間」単位のため
    // 消化率を比較可能にするために作業予定時間を時間換算(÷60)してから割合を出す
    const result = rows.map(row => {
      const plannedHoursTotal = row.planned_hours / 60;
      const progressRatio = plannedHoursTotal > 0 ? row.actual_hours_total / plannedHoursTotal : 0;
      return {
        id: row.id,
        project_name: row.project_name,
        planned_hours_total: plannedHoursTotal,
        actual_hours_total: row.actual_hours_total,
        last_work_date: row.last_work_date,
        progress_ratio: progressRatio
      };
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/staff', (req, res) => {
  try {
    const staff = db.prepare('SELECT * FROM staff WHERE is_active = 1 ORDER BY id ASC').all();
    res.json(staff);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/staff', (req, res) => {
  try {
    const { name, role, capacity_minutes } = req.body;
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO staff (name, role, capacity_minutes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, role || 'FULL_TIME', capacity_minutes || 480, now, now);
    res.status(201).json({ id: result.lastInsertRowid, message: 'Staff created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/staff/:id', (req, res) => {
  try {
    const { name, role, capacity_minutes } = req.body;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE staff SET name=?, role=?, capacity_minutes=?, updated_at=? WHERE id=?
    `).run(name, role, capacity_minutes || 480, now, req.params.id);
    res.json({ message: 'Staff updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/staff/:id', (req, res) => {
  try {
    const now = new Date().toISOString();
    db.prepare('UPDATE staff SET is_active = 0, updated_at = ? WHERE id = ?').run(now, req.params.id);
    res.json({ message: 'Staff deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== 従業員関連 =====

app.get('/employees', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'employees.html'));
});

app.get('/api/employees', (req, res) => {
  try {
    const employees = db.prepare('SELECT * FROM employees ORDER BY id ASC').all();
    res.json(employees);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/employees/:id', (req, res) => {
  try {
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    res.json(employee);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/employees', (req, res) => {
  try {
    const { name, role, is_active } = req.body;
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO employees (name, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, role, is_active === false ? 0 : 1, now, now);
    res.status(201).json({ id: result.lastInsertRowid, message: 'Employee created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/employees/:id', (req, res) => {
  try {
    const { name, role, is_active } = req.body;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE employees SET name=?, role=?, is_active=?, updated_at=? WHERE id=?
    `).run(name, role, is_active === false ? 0 : 1, now, req.params.id);
    res.json({ message: 'Employee updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/employees/:id', (req, res) => {
  try {
    const now = new Date().toISOString();
    db.prepare('UPDATE employees SET is_active = 0, updated_at = ? WHERE id = ?').run(now, req.params.id);
    res.json({ message: 'Employee deactivated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats/daily-workload', (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const workload = db.prepare(`
      SELECT s.id, s.name, s.capacity_minutes,
        COALESCE(SUM(p.planned_hours), 0) as total_minutes,
        CASE
          WHEN COALESCE(SUM(p.planned_hours), 0) > s.capacity_minutes THEN 'over'
          WHEN COALESCE(SUM(p.planned_hours), 0) > s.capacity_minutes * 0.8 THEN 'warning'
          ELSE 'ok'
        END as status
      FROM staff s
      LEFT JOIN projects p ON s.id = p.assigned_staff_id
        AND DATE(p.deadline) = ?
        AND p.status IN ('WAITING', 'IN_PROGRESS', 'INSPECTION')
      WHERE s.is_active = 1
      GROUP BY s.id ORDER BY s.id
    `).all(date);
    res.json(workload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  const candidates = getLocalIPs();
  console.log(`サーバー起動:`);
  console.log(`  このMacから: http://localhost:${PORT}`);
  if (candidates.length === 0) {
    console.log(`  社内LANの他端末から: (LAN用のIPアドレスが見つかりませんでした。Wi-Fi/有線LANの接続状況を確認してください)`);
  } else {
    console.log(`  社内LANの他端末から:`);
    candidates.forEach(c => {
      console.log(`    http://${c.address}:${PORT}  (${c.name}${c.likely ? ' ← おそらくこれ' : ''})`);
    });
    if (candidates.length > 1) {
      console.log(`  ※ 複数候補がある場合、まず「← おそらくこれ」のIPを試してください。繋がらなければ他の候補もお試しください。`);
    }
  }
});

// LAN到達性のあるIPv4アドレスの候補を洗い出す。
// VPN/仮想アダプタ（utun, awdl, bridge, vEthernet, VirtualBox, VMware, Docker/WSL等）は除外し、
// macOSのen0/en1やWindowsの物理Wi-Fi/EthernetアダプタらしきものをNS「おそらくこれ」とする。
function getLocalIPs() {
  const interfaces = require('os').networkInterfaces();
  const ignoredKeywords = [
    'utun', 'awdl', 'llw', 'bridge', 'vnic', 'anpi', 'ap1', 'p2p', // macOS仮想系
    'vethernet', 'virtualbox', 'vmware', 'docker', 'wsl', 'hyper-v', 'loopback' // Windows仮想系
  ];
  const preferredNames = ['en0', 'en1', 'wi-fi', 'ethernet'];
  const results = [];

  for (const name of Object.keys(interfaces)) {
    const lowerName = name.toLowerCase();
    if (ignoredKeywords.some(keyword => lowerName.includes(keyword))) continue;
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const likely = preferredNames.some(p => lowerName === p || lowerName.startsWith(p));
        results.push({ name, address: iface.address, likely });
      }
    }
  }

  // 優先インターフェースを先頭に
  results.sort((a, b) => (b.likely ? 1 : 0) - (a.likely ? 1 : 0));
  return results;
}

module.exports = app;