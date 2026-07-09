// LINE Webhook (/webhook) のローカル動作確認用スクリプト。
// .env の LINE_CHANNEL_SECRET を使って正しい署名付きリクエストを生成し、
// ローカルサーバーへPOSTする。
//
// 使い方:
//   node server.js を別ターミナルで起動しておく
//   node scripts/test-line-webhook.js            # テキストメッセージイベント
//   node scripts/test-line-webhook.js image       # 画像メッセージイベント
//   node scripts/test-line-webhook.js follow      # フォローイベント
//   node scripts/test-line-webhook.js badSignature # 署名不正パターン（400になることを確認）

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const URL = `http://localhost:${PORT}/webhook`;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

if (!CHANNEL_SECRET) {
  console.error('LINE_CHANNEL_SECRET が .env に設定されていません');
  process.exit(1);
}

const scenario = process.argv[2] || 'text';

const baseEvent = {
  replyToken: '00000000000000000000000000000000',
  source: { type: 'user', userId: 'U_test_user_id_1234567890abcdef' },
  timestamp: Date.now(),
  mode: 'active',
};

function buildEvents(scenario) {
  switch (scenario) {
    case 'image':
      return [{
        ...baseEvent,
        type: 'message',
        message: { id: '111111', type: 'image' },
      }];
    case 'follow':
      return [{
        ...baseEvent,
        type: 'follow',
      }];
    case 'text':
    case 'badSignature':
    default:
      return [{
        ...baseEvent,
        type: 'message',
        message: { id: '222222', type: 'text', text: 'テストメッセージです' },
      }];
  }
}

async function main() {
  const body = JSON.stringify({ destination: 'Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', events: buildEvents(scenario) });

  let signature = crypto.createHmac('sha256', CHANNEL_SECRET).update(body).digest('base64');
  if (scenario === 'badSignature') {
    signature = 'invalid-signature-for-testing';
  }

  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Line-Signature': signature,
    },
    body,
  });

  console.log(`Status: ${res.status}`);
  console.log(await res.text());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
