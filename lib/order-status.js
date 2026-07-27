const path = require('path');

// お客様向け 進捗確認ページ(/status)。
// 受付番号(W-/T-/P-)+ お申し込み時の電話番号下4桁 の2要素で照合する。
// 目的は「今どうなってる?」の電話問い合わせを減らすこと。取引先ポータル(/partner/{token})が
// 取引先向けなのに対し、こちらは受付番号を持つ一般のお客様が使う。
//
// 設計上の要点:
// - 受付番号だけでは他人の注文を推測閲覧できてしまうため、電話番号下4桁との一致を必須にする
// - 下4桁は1万通りしかないため、IP単位の厳しめのレート制限(既定10回/10分)で総当たりを抑える
// - 「受付番号が存在しない」と「電話番号が違う」を同じメッセージにし、
//   受付番号の存在有無を外部から探れないようにする
// - 表示は社内ステータスをそのまま出さず4段階に丸める(partner-portalと同じ考え方)

const MAX_ATTEMPTS = parseInt(process.env.STATUS_LOOKUP_MAX_ATTEMPTS, 10) || 10;
const ATTEMPT_WINDOW_MS = (parseInt(process.env.STATUS_LOOKUP_WINDOW_MIN, 10) || 10) * 60 * 1000;

// 社内ステータス → お客様向け4段階。partner-portal.js と同じ丸め方
const STAGE_OF_STATUS = {
  PRE_ORDER: 1, CONFIRMED: 1,
  WAITING: 2, PREP_COMPLETE: 2, IN_PROGRESS: 2,
  INSPECTION: 3, DELIVERED: 3,
  COMPLETED: 4,
};
const STAGE_LABELS = { 1: '受付済み', 2: '製作中', 3: '検品・出荷準備中', 4: '納品済み' };
const STAGE_NOTES = {
  1: '内容を確認しています。担当者よりご連絡いたします。',
  2: '製作を進めています。',
  3: '仕上がり後の検品・出荷準備を進めています。',
  4: '納品が完了しています。ありがとうございました。',
};

// 受付番号のプレフィックス → ai_extracted_intake.line_user_id
const PREFIX_TO_SOURCE = { W: 'WEB', T: 'TEAM', P: 'PARTNER' };

// 総当たり対策のレート制限(プロセス内メモリ。再起動でリセットされるが、
// このページの用途では十分。lib/order-intake.js と同じ簡易方式)
const attempts = new Map();

function checkRateLimit(key, now = Date.now()) {
  const list = (attempts.get(key) || []).filter(t => now - t < ATTEMPT_WINDOW_MS);
  if (list.length >= MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((ATTEMPT_WINDOW_MS - (now - list[0])) / 1000);
    attempts.set(key, list);
    return { ok: false, retryAfter };
  }
  list.push(now);
  attempts.set(key, list);
  // 古いキーが溜まり続けないよう、空になったエントリは削除する
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) {
      if (v.every(t => now - t >= ATTEMPT_WINDOW_MS)) attempts.delete(k);
    }
  }
  return { ok: true };
}

function getClientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip || req.connection?.remoteAddress || 'unknown';
}

// 受付番号を { prefix, id } に分解する。形式不正なら null
function parseReceiptNo(raw) {
  const m = String(raw || '').trim().toUpperCase().match(/^([WTP])-?(\d{1,9})$/);
  if (!m) return null;
  return { prefix: m[1], id: Number(m[2]) };
}

function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

// raw_ai_response から申込時の電話番号を取り出す。
// Web注文/チーム注文は orderer.phone、取引先 加工依頼は dropoff.phone に入っている
function extractPhone(rawJson) {
  let raw;
  try { raw = JSON.parse(rawJson || '{}'); } catch { return ''; }
  const candidates = [raw?.orderer?.phone, raw?.dropoff?.phone];
  for (const c of candidates) {
    const d = digitsOnly(c);
    if (d) return d;
  }
  return '';
}

// 進捗の中身を組み立てる。案件化前(受注候補のまま)は「受付済み」として返す
function buildStatus(db, intake) {
  if (!intake.case_id) {
    return {
      stage: 1,
      stage_label: STAGE_LABELS[1],
      stage_note: STAGE_NOTES[1],
      project_name: null,
      deadline: null,
      delivered_date: null,
    };
  }
  const project = db.prepare(
    'SELECT project_name, deadline, status FROM projects WHERE id = ?'
  ).get(intake.case_id);
  if (!project) {
    // 案件が削除済み(取り下げ等)。詳細は出さず受付済み扱いにして担当者へ誘導する
    return { stage: 1, stage_label: STAGE_LABELS[1], stage_note: STAGE_NOTES[1], project_name: null, deadline: null, delivered_date: null };
  }
  const stage = STAGE_OF_STATUS[project.status] || 1;
  const delivery = stage === 4
    ? db.prepare('SELECT delivered_date FROM delivery_records WHERE case_id = ? ORDER BY delivered_date DESC, id DESC LIMIT 1').get(intake.case_id)
    : null;
  return {
    stage,
    stage_label: STAGE_LABELS[stage],
    stage_note: STAGE_NOTES[stage],
    project_name: project.project_name || null,
    deadline: project.deadline || null,
    delivered_date: delivery ? delivery.delivered_date : null,
  };
}

function registerOrderStatusRoutes(app, db) {
  // ---- 公開: 進捗確認ページHTML ----
  app.get('/status', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'order-status.html'));
  });

  // ---- 公開: 照合API ----
  // 受付番号と電話番号下4桁が両方一致した場合のみ進捗を返す。
  // 不一致・存在しない受付番号のいずれも同じ404メッセージにする(存在有無を漏らさない)
  app.post('/api/order-status', (req, res) => {
    try {
      const rate = checkRateLimit(getClientIp(req));
      if (!rate.ok) {
        res.set('Retry-After', String(rate.retryAfter));
        return res.status(429).json({
          ok: false,
          error: '確認の回数が上限に達しました。しばらく時間をおいてお試しいただくか、お電話・公式LINEにてお問い合わせください。',
        });
      }

      const parsed = parseReceiptNo(req.body && req.body.receipt_no);
      const last4 = digitsOnly(req.body && req.body.phone_last4);
      const notFound = {
        ok: false,
        error: '受付番号または電話番号が一致しませんでした。お手元の受付完了メール・完了画面の番号をご確認ください。',
      };
      if (!parsed || last4.length !== 4) {
        return res.status(400).json({
          ok: false,
          error: '受付番号(例: W-123)と、お申し込み時の電話番号の下4桁を入力してください。',
        });
      }

      const intake = db.prepare(
        'SELECT id, line_user_id, case_id, raw_ai_response FROM ai_extracted_intake WHERE id = ?'
      ).get(parsed.id);
      if (!intake || intake.line_user_id !== PREFIX_TO_SOURCE[parsed.prefix]) {
        return res.status(404).json(notFound);
      }

      const phone = extractPhone(intake.raw_ai_response);
      // 申込時に電話番号が未記入だった場合は照合できないため、担当者への問い合わせに誘導する
      if (phone.length < 4) {
        return res.status(404).json({
          ok: false,
          error: 'この受付番号はページでの進捗確認に対応していません。お手数ですが、お電話・公式LINEにて担当者へお問い合わせください。',
        });
      }
      if (phone.slice(-4) !== last4) {
        return res.status(404).json(notFound);
      }

      const status = buildStatus(db, intake);
      return res.json({ ok: true, receipt_no: `${parsed.prefix}-${parsed.id}`, ...status });
    } catch (err) {
      console.error('[進捗確認] 照合処理でエラー:', err.message);
      return res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。しばらくしてから再度お試しください。' });
    }
  });
}

module.exports = { registerOrderStatusRoutes, parseReceiptNo, extractPhone, STAGE_LABELS };
