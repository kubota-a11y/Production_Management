// LINEメッセージのAI構造化抽出(lib/ai-extraction.js)を、15分の沈黙待ちを無視して
// 指定ユーザーについて即座に1回実行するための動作確認用スクリプト。
//
// 使い方:
//   node scripts/test-ai-extraction.js <line_user_id>

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { initDatabase } = require('../db/init');
const { extractForUser } = require('../lib/ai-extraction');

const lineUserId = process.argv[2];
if (!lineUserId) {
  console.error('使い方: node scripts/test-ai-extraction.js <line_user_id>');
  process.exit(1);
}

async function main() {
  const db = initDatabase();
  await extractForUser(db, lineUserId);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
