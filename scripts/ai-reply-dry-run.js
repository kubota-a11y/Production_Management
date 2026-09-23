#!/usr/bin/env node
'use strict';
// AI受付(LINE返信キュー)の下書き生成を、本番DBに触らずに試す(2026-09-24)。
// 使い方: node scripts/ai-reply-dry-run.js [シナリオ番号 1〜6 | all]
//   - .env の ANTHROPIC_API_KEY が必要(無ければ即終了)
//   - 一時DB(scratch)にサンプル会話を入れて generateDraft を呼び、下書き・分類・ツール呼び出し・トークン数を表示する
//   - LINEへは送らない(送信は呼ばない)。Googleチャット通知も飛ばさない(AI_REPLY_GCHAT_WEBHOOK を空にして実行)
require('dotenv').config();
process.env.AI_REPLY_GCHAT_WEBHOOK = '';
process.env.AI_REPLY_SEND_MODE = 'dry';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDatabase } = require('../db/init');
const lineReply = require('../lib/line-reply');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY が .env にありません。開発機で試すときは本番と同じキーを .env に入れてください');
  process.exit(1);
}

const SCENARIOS = [
  { name: '1枚からパックの問い合わせ', msgs: ['こんにちは。オリジナルのTシャツを3枚作りたいのですが、いくらくらいになりますか？デザインはあります。'] },
  { name: 'クラスT 30枚・背番号と名前', msgs: ['高校のクラスTシャツで30枚ほど作りたいです。前に学校名、背中に一人ずつ番号と名前を入れたいです。納期は10月20日希望です。'] },
  { name: 'KRATVSカスタムオーダー', msgs: ['KRATVSのカスタムオーダーでドライTシャツ(T-01)をS〜XLで10枚、背番号とチーム名を入れたい場合の金額を教えてください。'] },
  { name: 'ユニフォーム(昇華)', msgs: ['サッカーチームのユニフォームをオリジナルデザインで作りたいです。FPシャツと パンツ 15セットくらい。だいたいの価格を教えてもらえますか。'] },
  { name: '納期の催促(修正)', msgs: ['先週お願いしたパーカーの件、その後どうなっていますか？今週末までに欲しいのですが間に合いますか？'] },
  { name: 'お礼だけ', msgs: ['ありがとうございます！よろしくお願いします！'] },
];

async function main() {
  const which = process.argv[2] || '1';
  const picks = which === 'all' ? SCENARIOS.map((_, i) => i) : [Math.max(1, parseInt(which, 10) || 1) - 1];
  const tmp = path.join(os.tmpdir(), `ai-reply-dry-${Date.now()}.db`);
  const db = initDatabase(tmp);
  lineReply.init({ db, lineClient: { pushMessage: async () => ({ sentMessages: [] }) } });
  try {
    for (const i of picks) {
      const sc = SCENARIOS[i];
      const uid = `U${String(i + 1).padStart(32, '0')}`;
      const now = Date.now();
      db.prepare('INSERT OR IGNORE INTO line_users(line_user_id, display_name, first_seen_at, last_message_at) VALUES (?, ?, ?, ?)').run(uid, `テスト${i + 1}`, new Date(now - 3600e3).toISOString(), new Date(now).toISOString());
      sc.msgs.forEach((t, k) => db.prepare('INSERT INTO line_messages(line_user_id, message_type, text_content, received_at, processed) VALUES (?, ?, ?, ?, 0)').run(uid, 'text', t, new Date(now - (sc.msgs.length - k) * 60000).toISOString()));
      console.log(`\n===== シナリオ${i + 1}: ${sc.name} =====`);
      const t0 = Date.now();
      const r = await lineReply.generateDraft(uid, { reason: 'dry-run', force: true });
      const d = lineReply.getDraft(r.draftId);
      console.log(`分類: ${d.category} / 注文タイプ: ${d.order_type} / 注文可能性: ${d.order_likelihood} / 確信度: ${d.confidence}`);
      console.log(`要約: ${d.summary}`);
      console.log(`フラグ: ${d.flags.join('・') || 'なし'} / 不足: ${d.missing_info.join('・') || 'なし'}`);
      console.log(`ツール: ${d.tool_calls.map((t) => `${t.name}(${JSON.stringify(t.input)})`).join(' / ') || 'なし'}`);
      console.log(`メモ: ${d.intake_patch.reasoning_note || ''}`);
      console.log(`--- 下書き ---\n${d.reply_text || '(返信不要)'}\n--- ${Math.round((Date.now() - t0) / 1000)}秒 / in ${d.input_tokens} (cache ${d.cache_read_tokens}) / out ${d.output_tokens}`);
    }
  } finally {
    db.close();
    fs.unlinkSync(tmp);
  }
}

main().catch((err) => { console.error('失敗:', err.message); process.exit(1); });
