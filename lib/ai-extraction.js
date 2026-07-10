// LINE Webhookで受信したメッセージを、一定時間の沈黙後にAnthropic APIで構造化抽出する。
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1024;
const DEFAULT_QUIET_MINUTES = 15;

const SYSTEM_PROMPT = `あなたは印刷・刺繍加工業(HIYOSHI)の受注担当アシスタントです。
お客様からLINEで届いたメッセージ(テキストと画像)を読み取り、
以下のJSON形式で構造化してください。JSON以外は一切出力しないでください。

{
  "customer_name": "顧客名・会社名(不明ならnull)",
  "items": "依頼内容の要約(品目・加工内容。可能なら以下から選ぶ:
    シルクスクリーンプリント/DTFプリント/ラバー転写プリント/
    通常刺繍/帽子刺繍/ワッペン刺繍。当てはまらなければ自由記述)",
  "quantity": "数量(不明ならnull)",
  "deadline": "希望納期(不明ならnull)",
  "notes": "位置指定・色指定・その他特記事項を具体的に"
}`;

function getQuietMinutes() {
  const parsed = parseInt(process.env.AI_EXTRACTION_QUIET_MINUTES, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUIET_MINUTES;
}

// better-sqlite3はbindパラメータにオブジェクト/配列を渡せないため、
// AIの出力がフラットな文字列でなかった場合に備えてJSON文字列化しておく
function toBindable(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function buildContentBlock(message) {
  if (message.message_type === 'text') {
    return { type: 'text', text: message.text_content || '' };
  }
  if (message.message_type === 'image') {
    if (message.image_path) {
      try {
        const buffer = fs.readFileSync(message.image_path);
        return {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: buffer.toString('base64') },
        };
      } catch (err) {
        console.error(`[AI抽出] 画像読み込み失敗 image_path=${message.image_path}:`, err.message);
        return { type: 'text', text: '[画像添付あり・読み込み失敗]' };
      }
    }
    return { type: 'text', text: '[画像添付あり・読み込み失敗]' };
  }
  return { type: 'text', text: '[スタンプ等のメッセージ]' };
}

// 指定ユーザーの未処理メッセージ(processed=0)をまとめてAnthropic APIに渡し、
// 構造化結果をai_extracted_intakeに保存してprocessed=1に更新する。
// API呼び出し・JSON解析いずれかが失敗した場合はログのみ出しprocessedは更新しない(次回インターバルで再試行)。
async function extractForUser(db, lineUserId) {
  const messages = db.prepare(`
    SELECT * FROM line_messages WHERE line_user_id = ? AND processed = 0 ORDER BY received_at ASC
  `).all(lineUserId);

  if (messages.length === 0) return;

  const content = messages.map(buildContentBlock);

  let response;
  try {
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    console.error(`[AI抽出] Anthropic API呼び出し失敗 line_user_id=${lineUserId}:`, err.message);
    return;
  }

  const rawText = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    console.error(`[AI抽出] JSON解析失敗 line_user_id=${lineUserId}: ${err.message}\n応答: ${rawText}`);
    return;
  }

  const now = new Date().toISOString();
  const messageIds = messages.map(m => m.id);

  const saveAndMarkProcessed = db.transaction(() => {
    db.prepare(`
      INSERT INTO ai_extracted_intake
        (line_user_id, extracted_at, customer_name, items, quantity, deadline, notes, raw_ai_response, message_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      lineUserId,
      now,
      toBindable(parsed.customer_name),
      toBindable(parsed.items),
      toBindable(parsed.quantity),
      toBindable(parsed.deadline),
      toBindable(parsed.notes),
      JSON.stringify(response),
      JSON.stringify(messageIds)
    );

    const placeholders = messageIds.map(() => '?').join(',');
    db.prepare(`UPDATE line_messages SET processed = 1 WHERE id IN (${placeholders})`).run(...messageIds);
  });
  saveAndMarkProcessed();

  console.log(`[AI抽出] line_user_id=${lineUserId}: ${messageIds.length}件のメッセージを構造化保存しました`);
}

// processed=0のメッセージをline_user_idごとにグルーピングし、最新メッセージの受信から
// quietMinutes以上経過して沈黙しているユーザーだけを対象にextractForUserを実行する。
async function runExtractionCycle(db, quietMinutes = getQuietMinutes()) {
  const groups = db.prepare(`
    SELECT line_user_id, MAX(received_at) as last_received_at
    FROM line_messages
    WHERE processed = 0
    GROUP BY line_user_id
  `).all();

  const now = Date.now();
  const targets = groups.filter(g => {
    const lastReceived = new Date(g.last_received_at).getTime();
    return (now - lastReceived) >= quietMinutes * 60 * 1000;
  });

  for (const target of targets) {
    try {
      await extractForUser(db, target.line_user_id);
    } catch (err) {
      console.error(`[AI抽出] line_user_id=${target.line_user_id} の処理中に予期しないエラー:`, err);
    }
  }
}

module.exports = { runExtractionCycle, extractForUser, getQuietMinutes };
