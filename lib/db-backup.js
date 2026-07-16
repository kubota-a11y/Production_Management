const fs = require('fs');
const path = require('path');

// 自動バックアップの保存先と世代管理の設定。
// 自動分(projects_auto_*)のみローテーション対象とし、手動バックアップは削除しない。
const BACKUP_DIR = path.join(__dirname, '..', 'db', 'backups');
const AUTO_PREFIX = 'projects_auto_';
const KEEP_COUNT = 30;

function localDateStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 当日分の自動バックアップがまだ無ければ作成する。
// better-sqlite3のbackup APIはサーバー稼働中(書き込み中)でも一貫性のあるコピーを作れる。
// 作成した場合はバックアップファイルのパスを、スキップした場合はnullを返す。
async function backupIfNeeded(db) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `${AUTO_PREFIX}${localDateStamp()}.db`);
  if (fs.existsSync(dest)) return null;

  // 途中で落ちた場合に壊れたファイルが正規名で残らないよう、一時名で作ってからrenameする
  const tmp = `${dest}.tmp`;
  try {
    await db.backup(tmp);
    fs.renameSync(tmp, dest);
  } catch (err) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    throw err;
  }

  // .envでDB_BACKUP_EXTRA_DIRを指定するとNAS等へ二重保存する(ディスク故障対策)
  const extraDir = process.env.DB_BACKUP_EXTRA_DIR;
  if (extraDir) {
    try {
      fs.mkdirSync(extraDir, { recursive: true });
      fs.copyFileSync(dest, path.join(extraDir, path.basename(dest)));
    } catch (err) {
      console.error(`[バックアップ] 追加保存先(${extraDir})へのコピーに失敗:`, err.message);
    }
  }

  cleanupOldAutoBackups();
  return dest;
}

function cleanupOldAutoBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith(AUTO_PREFIX) && f.endsWith('.db'))
    .sort();
  while (files.length > KEEP_COUNT) {
    const oldest = files.shift();
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, oldest));
    } catch (err) {
      console.error(`[バックアップ] 古いバックアップの削除に失敗(${oldest}):`, err.message);
    }
  }
}

// サーバー起動時に呼ぶ。起動直後に1回実行し、以降は1時間ごとに
// 「当日分があるか」を確認して無ければ作成する(日付が変わったら自動で新規作成される)。
function scheduleDailyBackup(db) {
  const run = () => {
    backupIfNeeded(db)
      .then(dest => {
        if (dest) console.log(`[バックアップ] DBを保存しました: ${dest}`);
      })
      .catch(err => console.error('[バックアップ] 失敗:', err));
  };
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { backupIfNeeded, scheduleDailyBackup, BACKUP_DIR, AUTO_PREFIX };
