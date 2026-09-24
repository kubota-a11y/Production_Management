// 見積 → 案件登録の引き継ぎ(2026-09-24)。
// 返信キューから freee に発行した見積(line_reply_drafts)を、受注候補の確定・新規案件の登録・
// あとから登録された案件へ運ぶ。運ぶもの:
//   - 見積書URL(projects.freee_quote_url。空のときだけ入れる=人が貼った値を上書きしない)
//   - 概算の履歴(case_quotes: 転記シート・合計・割引名・承認者)
//   - 登録画面の初期値(品名・枚数・プリント箇所・加工種別)= quote_snapshot の hint
// 二重に運ばないよう、運んだ下書きには quote_case_id を入れる。
'use strict';

const PROCESS_CODES = new Set([
  'SILK_SCREEN_PRINT', 'DTF_PRINT', 'RUBBER_TRANSFER_PRINT', 'SUBLIMATION_PRINT',
  'STANDARD_EMBROIDERY', 'HAT_EMBROIDERY', 'PATCH_EMBROIDERY',
]);
// 受注候補と同じお客様の見積を探す期間(下書きに受注候補が紐づいていない見積の拾い上げ用)
const LOOKBACK_DAYS = 30;

const str = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

/** 画面(見積シミュレーター)から来た「案件の初期値」を、保存してよい形に絞る */
function sanitizeHint(hint) {
  if (!hint || typeof hint !== 'object') return null;
  const qty = parseInt(hint.qty, 10);
  const locations = (Array.isArray(hint.locations) ? hint.locations : []).slice(0, 20).map((l) => {
    const c = parseInt(l && l.color_count, 10);
    return { location_name: str(l && l.location_name, 60), color_count: c >= 1 && c <= 4 ? c : 1 };
  }).filter((l) => l.location_name);
  const processTypes = (Array.isArray(hint.process_types) ? hint.process_types : []).filter((p) => PROCESS_CODES.has(p));
  return {
    title: str(hint.title, 100) || null,
    customer: str(hint.customer, 100) || null,
    qty: qty > 0 ? qty : null,
    locations,
    process_types: [...new Set(processTypes)],
  };
}

/** freee発行時に下書きへ残すスナップショット。案件を登録するときにここから運ぶ */
function buildSnapshot({ sheetText, total, discountName, approvedBy, hint }) {
  return {
    sheet_text: sheetText ? String(sheetText) : null,
    total: Math.round(Number(total) || 0),
    discount_name: discountName ? String(discountName) : null,
    approved_by: approvedBy ? String(approvedBy) : null,
    hint: sanitizeHint(hint),
    saved_at: new Date().toISOString(),
  };
}

function parseJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// AIの見積条件(quote_conditions)の加工方法 → 案件の加工種別。auto(シルク/DTFの安い方)は決めない
const METHOD_TO_PROCESS = {
  silk: 'SILK_SCREEN_PRINT', dtf: 'DTF_PRINT', dtfName: 'DTF_PRINT', rubber: 'RUBBER_TRANSFER_PRINT',
  marking: 'RUBBER_TRANSFER_PRINT', emb: 'STANDARD_EMBROIDERY', nameEmb: 'STANDARD_EMBROIDERY', cap: 'HAT_EMBROIDERY',
};

/** スナップショットが無い(画面から発行前に来た等)ときは、AIの見積条件から初期値を作る */
function hintFromConditions(cond) {
  if (!cond) return null;
  const qty = (cond.bodies || []).reduce((s, b) => s + (parseInt(b.qty, 10) || 0), 0)
    || (cond.kratvs && cond.kratvs.qty) || null;
  return sanitizeHint({
    title: cond.title,
    customer: cond.customer_name,
    qty,
    locations: (cond.rows || []).map((r) => ({ location_name: r.location_name, color_count: r.colors === 'full' ? 1 : r.colors })),
    process_types: (cond.rows || []).map((r) => METHOD_TO_PROCESS[r.method]).filter(Boolean),
  });
}

/** 下書き1行 → 画面・引き継ぎ用の見積情報 */
function describe(draft) {
  if (!draft) return null;
  const snap = parseJson(draft.quote_snapshot);
  const hint = (snap && snap.hint) || hintFromConditions(parseJson(draft.quote_conditions));
  return {
    draft_id: draft.id,
    quotation_number: draft.freee_quotation_number || null,
    report_url: draft.freee_report_url || null,
    total: snap ? snap.total : null,
    sheet_text: snap ? snap.sheet_text : null,
    discount_name: snap ? snap.discount_name : null,
    approved_by: snap ? snap.approved_by : null,
    hint,
    case_id: draft.quote_case_id || null,
  };
}

/**
 * 受注候補に対応する「まだ案件へ運んでいない」freee見積を探す。
 * 1) その候補に紐づいた下書き 2) 同じLINEのお客様の直近の下書き(候補が見積の後にできた場合)
 */
function findQuoteForIntake(db, intake) {
  if (!intake) return null;
  let d = db.prepare(`
    SELECT * FROM line_reply_drafts
    WHERE intake_id = ? AND freee_report_url IS NOT NULL AND quote_case_id IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(intake.id);
  // 入口フォーム(Q-)の候補は line_user_id が 'INQ_*' で、お客様のLINEは linked_line_user_id 側にある
  const userIds = [intake.line_user_id, intake.linked_line_user_id].filter((u) => u && !String(u).startsWith('INQ_'));
  if (!d && userIds.length) {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400e3).toISOString();
    d = db.prepare(`
      SELECT * FROM line_reply_drafts
      WHERE line_user_id IN (${userIds.map(() => '?').join(',')}) AND freee_report_url IS NOT NULL AND quote_case_id IS NULL AND created_at >= ?
      ORDER BY id DESC LIMIT 1
    `).get(...userIds, since);
  }
  return describe(d);
}

/** 下書き → すでに登録済みの案件ID(運び済み、または紐づく受注候補が確定済み) */
function resolveCaseForDraft(db, draftId) {
  const d = db.prepare('SELECT quote_case_id, intake_id FROM line_reply_drafts WHERE id = ?').get(draftId);
  if (!d) return null;
  const exists = (id) => id && db.prepare('SELECT id FROM projects WHERE id = ?').get(id) ? id : null;
  if (d.quote_case_id) return exists(d.quote_case_id);
  if (!d.intake_id) return null;
  const it = db.prepare(`SELECT case_id FROM ai_extracted_intake WHERE id = ? AND status = 'confirmed'`).get(d.intake_id);
  return exists(it && it.case_id);
}

/**
 * 見積を案件へ運ぶ。quote は describe() の形か、画面から来た { report_url, sheet_text, total, discount_name, approved_by }。
 * draftId があれば、その下書きを「運び済み」にする。呼び出し元のトランザクション内で使える(同期処理のみ)
 */
function carryToCase(db, projectId, quote, draftId) {
  if (!projectId || !quote) return;
  const now = new Date().toISOString();
  if (quote.report_url) {
    db.prepare(`UPDATE projects SET freee_quote_url = ?, updated_at = ? WHERE id = ? AND (freee_quote_url IS NULL OR freee_quote_url = '')`)
      .run(String(quote.report_url), now, projectId);
  }
  if (quote.sheet_text) {
    // 同じ転記シートが既に記録されていれば重ねない(発行時に案件が見つかって記録済みのケース)
    const dup = db.prepare('SELECT id FROM case_quotes WHERE case_id = ? AND sheet_text = ?').get(projectId, String(quote.sheet_text));
    if (!dup) {
      db.prepare(`
        INSERT INTO case_quotes (case_id, sheet_text, total, discount_name, approved_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(projectId, String(quote.sheet_text), Math.round(Number(quote.total) || 0),
        quote.discount_name ? String(quote.discount_name) : null,
        quote.approved_by ? String(quote.approved_by) : null, now);
    }
  }
  const did = parseInt(draftId, 10);
  // 別の案件へ運び済みの下書きは付け替えない
  if (did > 0) db.prepare('UPDATE line_reply_drafts SET quote_case_id = ? WHERE id = ? AND quote_case_id IS NULL').run(projectId, did);
}

/** 下書きIDから見積を読み、案件へ運ぶ(受注候補の確定・新規案件登録から) */
function carryDraftToCase(db, projectId, draftId) {
  const did = parseInt(draftId, 10);
  if (!(did > 0)) return false;
  const d = db.prepare('SELECT * FROM line_reply_drafts WHERE id = ?').get(did);
  if (!d || (d.quote_case_id && d.quote_case_id !== projectId)) return false;
  const q = describe(d);
  if (!q.report_url && !q.sheet_text) return false;
  carryToCase(db, projectId, q, did);
  return true;
}

module.exports = {
  sanitizeHint, buildSnapshot, describe, findQuoteForIntake, resolveCaseForDraft, carryToCase, carryDraftToCase,
  _internal: { hintFromConditions },
};
