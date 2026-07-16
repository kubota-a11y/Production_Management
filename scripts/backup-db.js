// 手動バックアップ用スクリプト。サーバー停止中でも実行できる。
// 使い方: node scripts/backup-db.js
// db/backups/ に projects_manual_日時.db として保存する(自動ローテーションの対象外)。
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { BACKUP_DIR } = require('../lib/db-backup');

const dbPath = path.join(__dirname, '..', 'db', 'projects.db');

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`DBファイルが見つかりません: ${dbPath}`);
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `projects_manual_${timestamp()}.db`);

  const db = new Database(dbPath, { fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  console.log(`バックアップを保存しました: ${dest}`);
}

main().catch(err => {
  console.error('バックアップに失敗しました:', err);
  process.exit(1);
});
