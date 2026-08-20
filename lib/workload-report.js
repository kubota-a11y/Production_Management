const path = require('path');
const { buildWorkloadReport, todayISO } = require('./task-moves');
const { getDayInfo } = require('./designer-board');

// 業務量レポート(社内画面 /workload)。
// 「その日1日の業務量が適正だったか」を後から確かめるための画面。
// マイスケジュールボードでタスクを翌日以降へ動かした履歴(designer_task_moves)を使い、
// 過去の日についても当日の計画を再現して 計画 / 完了 / 持ち越し を日別に出す。
//
// 社内専用。従業員名とタスク名(顧客名を含みうる)を返すため、公開ホスト名からは
// 外部公開ガード(server.js)によって404になる。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 一度に集計できる期間の上限。長すぎる期間を投げられて重くならないようにする
const MAX_RANGE_DAYS = 186;

function registerWorkloadReportRoutes(app, db) {
  // ---- 画面 ----
  app.get('/workload', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'workload-report.html'));
  });

  // ---- 対象にできる従業員 ----
  // マイスケジュールボードを持っている従業員(デザイナーリンク発行済み)を既定にしつつ、
  // 準備項目の割り当てがある従業員は誰でも見られるようにする
  app.get('/api/workload/employees', (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT e.id, e.name,
               EXISTS(SELECT 1 FROM designer_links dl WHERE dl.employee_id = e.id AND dl.disabled_at IS NULL) AS has_board
        FROM employees e
        WHERE e.is_active = 1
        ORDER BY has_board DESC, e.id ASC
      `).all();
      res.json({ ok: true, employees: rows.map(r => ({ ...r, has_board: !!r.has_board })) });
    } catch (error) {
      console.error('[業務量レポート] 従業員取得エラー:', error.message);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。' });
    }
  });

  // ---- 日別集計 ----
  app.get('/api/workload/report', (req, res) => {
    try {
      const employeeId = Number(req.query.employee_id);
      const start = String(req.query.start || '').slice(0, 10);
      const end = String(req.query.end || '').slice(0, 10);

      if (!employeeId) return res.status(400).json({ ok: false, error: '従業員を指定してください' });
      if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
        return res.status(400).json({ ok: false, error: '期間は YYYY-MM-DD で指定してください' });
      }
      if (start > end) return res.status(400).json({ ok: false, error: '開始日は終了日より前にしてください' });

      const days = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
      if (days > MAX_RANGE_DAYS) {
        return res.status(400).json({ ok: false, error: `期間は${MAX_RANGE_DAYS}日以内で指定してください` });
      }

      const employee = db.prepare('SELECT id, name FROM employees WHERE id = ?').get(employeeId);
      if (!employee) return res.status(404).json({ ok: false, error: '従業員が見つかりません' });

      const report = buildWorkloadReport(db, { employeeId, start, end }, { getDayInfo });
      res.json({ ok: true, employee_name: employee.name, today: todayISO(), ...report });
    } catch (error) {
      console.error('[業務量レポート] 集計エラー:', error.message);
      res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。' });
    }
  });
}

module.exports = { registerWorkloadReportRoutes };
