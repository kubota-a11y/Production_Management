// メール・電話など「フォーム以外」で受けた注文を、他チャネルと同じ受注候補
// (ai_extracted_intake) に着地させる受け口。
//
// これを作る前は、メールと電話は「テキストから抽出」「➕新規案件」で案件を直接
// 作っていたため、三浦さん・山本さんの振り分けデスクを通らなかった。
// 全チャネルを1本のキューに集めて、必ず2人で行き先を決めてから進める運用にするための追加。
//
//   POST /api/intake/paste  … 本文を貼り付け → AIが構造化 → 受注候補(M-)
//   POST /api/intake/phone  … 電話メモの入力欄 → そのまま受注候補(D-)
//
// ANTHROPIC_API_KEY が未設定の環境(開発機など)では、貼り付けの構造化を
// 簡易キーワード判定にフォールバックする。取り込み自体は止めない。
const { extractStructuredFromText, isAiConfigured, toBindable } = require('./ai-extraction');
const { notifyIntakeTask } = require('./todo-notify');

const LEN = { short: 200, mid: 500, long: 5000 };

function s(value, max) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!str) return null;
  return str.slice(0, max);
}

function isNonEmptyStr(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// ===== line_users に 'MAIL' / 'PHONE' 疑似ユーザーを用意 =====
// WEB/TEAM/PARTNER と同じ方式。受注候補カードの送信者名と受付番号の判定に使う
function ensureManualUsers(db) {
  const now = new Date().toISOString();
  const ins = db.prepare(`
    INSERT INTO line_users (line_user_id, display_name, first_seen_at, last_message_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(line_user_id) DO NOTHING
  `);
  ins.run('MAIL', 'メール・貼り付け', now, now);
  ins.run('PHONE', '電話メモ', now, now);
}

// ===== AIが使えないときの簡易判定(public/js/utils.js の抽出ロジックと同じ考え方) =====

// 「30枚」「10個」などの数量表現を拾う
function guessQuantity(text) {
  const match = text.match(/(\d+)\s*(?:個|枚|件|セット|本|着)/);
  return match ? match[1] : null;
}

// 2026/9/10・2026年9月10日・9/10 などを YYYY-MM-DD に寄せる。
// 年の無い表記は「今日以降で最も近い年」として解釈する(過去日付になるのを避けるため)
function guessDeadline(text) {
  const withYear = text.match(/(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})/);
  if (withYear) {
    const [, y, m, d] = withYear;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const noYear = text.match(/(\d{1,2})[/\-月](\d{1,2})日?/);
  if (noYear) {
    const [, m, d] = noYear;
    const today = new Date();
    const month = String(m).padStart(2, '0');
    const day = String(d).padStart(2, '0');
    let year = today.getFullYear();
    if (new Date(`${year}-${month}-${day}T00:00:00`) < today) year += 1;
    return `${year}-${month}-${day}`;
  }
  return null;
}

// 先頭行を顧客名の当たりとして使う。外れていても確認モーダルで直せる
function guessCustomerName(text) {
  const firstLine = (text.split('\n').find(line => line.trim()) || '').trim();
  return firstLine ? firstLine.slice(0, 50) : null;
}

function fallbackExtract(text) {
  return {
    customer_name: guessCustomerName(text),
    // 本文全体を内容として残す。AIのような要約はできないので先頭200文字で足切りする
    items: text.trim().slice(0, LEN.short),
    quantity: guessQuantity(text),
    deadline: guessDeadline(text),
    notes: null,
  };
}

// ===== 受注候補への保存 =====

function insertIntake(db, { channel, fields, rawPayload, notes }) {
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO ai_extracted_intake
      (line_user_id, extracted_at, customer_name, items, quantity, deadline, notes, raw_ai_response, message_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]')
  `).run(
    channel,
    now,
    toBindable(fields.customer_name),
    toBindable(fields.items),
    toBindable(fields.quantity),
    toBindable(fields.deadline),
    notes,
    JSON.stringify(rawPayload),
  );
  return info.lastInsertRowid;
}

// 人が読む用のメモ本文。確認モーダルの「メモ」にそのまま表示される
function buildPasteNotes(text, aiNotes, usedAi) {
  const parts = [];
  if (isNonEmptyStr(aiNotes)) parts.push(aiNotes.trim());
  if (!usedAi) parts.push('※AIの読み取りは行っていません(自動判定した項目は必ず確認してください)');
  parts.push('----- 取り込んだ本文 -----');
  parts.push(text.trim().slice(0, LEN.long));
  return parts.join('\n');
}

function buildPhoneNotes(data) {
  const parts = [];
  if (data.contact) parts.push(`折り返し先: ${data.contact}`);
  if (data.received_by) parts.push(`受けた人: ${data.received_by}`);
  if (data.notes) parts.push(data.notes);
  return parts.length ? parts.join('\n') : null;
}

// ===== ルート登録 =====
function registerManualIntakeRoutes(app, db) {
  ensureManualUsers(db);

  // メール等の本文を貼り付けて受注候補にする。
  // 社内画面からのみ呼ばれる(公開ドメインでは外部公開ガードが404にする)
  app.post('/api/intake/paste', async (req, res) => {
    try {
      const text = s(req.body && req.body.text, LEN.long);
      if (!text) return res.status(400).json({ error: '取り込む本文を入力してください' });

      const extracted = await extractStructuredFromText(text);
      const usedAi = Boolean(extracted);
      const fields = usedAi ? extracted.parsed : fallbackExtract(text);

      const intakeId = insertIntake(db, {
        channel: 'MAIL',
        fields,
        rawPayload: usedAi
          ? { source: 'paste', ai: extracted.raw }
          : { source: 'paste', ai: null, reason: isAiConfigured() ? 'ai_failed' : 'ai_not_configured' },
        notes: buildPasteNotes(text, fields.notes, usedAi),
      });

      const customer = toBindable(fields.customer_name);
      if (customer) {
        notifyIntakeTask(`メール・貼り付けの受注候補: ${customer} — ${toBindable(fields.items) || '内容は受注候補を確認'}(受付 M-${intakeId})`);
      }

      console.log(`[手動取り込み] 貼り付けを受注候補 M-${intakeId} として保存しました(AI読み取り: ${usedAi ? 'あり' : 'なし'})`);
      res.status(201).json({ ok: true, id: intakeId, receipt_no: `M-${intakeId}`, used_ai: usedAi });
    } catch (error) {
      console.error('[手動取り込み] 貼り付けの保存に失敗:', error);
      // 想定内の失敗も含め、画面側がJSONとして読めるよう200+ok:falseは使わずここは500でよい
      // (社内画面のみで使うAPIなのでCloudflareのエラーページ差し替えは起きない)
      res.status(500).json({ error: '受注候補への取り込みに失敗しました' });
    }
  });

  // 電話で受けた注文のメモ。通話しながら書ける最小限の項目だけを受ける
  app.post('/api/intake/phone', (req, res) => {
    try {
      const body = req.body || {};
      const customerName = s(body.customer_name, LEN.short);
      const items = s(body.items, LEN.mid);
      if (!customerName) return res.status(400).json({ error: 'お客様名を入力してください' });
      if (!items) return res.status(400).json({ error: 'ご依頼内容を入力してください' });

      const data = {
        customer_name: customerName,
        items,
        quantity: s(body.quantity, 50),
        deadline: s(body.deadline, 50),
        contact: s(body.contact, LEN.short),
        received_by: s(body.received_by, 50),
        notes: s(body.notes, LEN.mid),
      };

      const intakeId = insertIntake(db, {
        channel: 'PHONE',
        fields: data,
        rawPayload: { source: 'phone', ...data },
        notes: buildPhoneNotes(data),
      });

      notifyIntakeTask(`電話で受けた注文の対応: ${customerName} — ${items}(受付 D-${intakeId})`);

      console.log(`[手動取り込み] 電話メモを受注候補 D-${intakeId} として保存しました`);
      res.status(201).json({ ok: true, id: intakeId, receipt_no: `D-${intakeId}` });
    } catch (error) {
      console.error('[手動取り込み] 電話メモの保存に失敗:', error);
      res.status(500).json({ error: '受注候補への取り込みに失敗しました' });
    }
  });
}

module.exports = { registerManualIntakeRoutes };
