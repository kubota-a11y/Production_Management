// LINE Webhook経由でDBに保存されたデータの確認用スクリプト。
// 使い方:
//   node scripts/check-line-webhook-data.js              # 全件(line_messagesは新しい順に最大50件)
//   node scripts/check-line-webhook-data.js <line_user_id> # 指定ユーザーのみ

const Database = require('better-sqlite3');
const { dbPath } = require('../db/init');

const db = new Database(dbPath, { readonly: true });
const userIdFilter = process.argv[2];

const users = userIdFilter
  ? db.prepare('SELECT * FROM line_users WHERE line_user_id = ?').all(userIdFilter)
  : db.prepare('SELECT * FROM line_users ORDER BY last_message_at DESC').all();

const messages = userIdFilter
  ? db.prepare('SELECT * FROM line_messages WHERE line_user_id = ? ORDER BY received_at DESC').all(userIdFilter)
  : db.prepare('SELECT * FROM line_messages ORDER BY received_at DESC LIMIT 50').all();

console.log('=== line_users ===');
console.table(users);
console.log('=== line_messages ===');
console.table(messages);

db.close();
