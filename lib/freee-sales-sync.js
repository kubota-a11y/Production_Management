/**
 * freeeの売上取引の勘定科目を、HiBoardの案件の「売上区分」に合わせて振り替える(2026-09-24 社長指示)。
 *
 * 背景: 「freee請求書の取引登録の勘定科目を、売上高/企業ユニフォーム/カスタムオーダー/昇華ユニフォーム…と
 * 案件ごとに自動で振り分けたい」。freee請求書の見積書・請求書の明細行は勘定科目を持てない
 * (2026-09-24 に見積書APIで確認)ため、請求書から立った取引(会計API)の側で科目を付け替える。
 *
 * 仕組み:
 *   1. その月の収入取引のうち売上系の科目で立っているものを読む(freee-quote.listSalesDeals)
 *   2. 取引先ID → HiBoardの顧客名(freee_partner_links) → 案件(projects.sales_category)で振り替え先を決める
 *      - 高: 同じ取引先の案件に、税込合計が取引の金額と一致する概算(case_quotes)がある / 取引先が八木繊維様
 *      - 中: 同じ取引先の直近の案件の区分
 *      - 低: 取引先名・摘要の文字からの判定(lib/sales-category.js の suggest)
 *   3. 自動実行(6時間ごと)は「今が売上高」かつ「高」の取引だけを付け替える。人が直した取引は二度と触らない
 *      (freee_sales_sync_log に載っている取引は自動の対象外)。中・低は /freee-sales-check で人が押す
 *
 * ★freeeアプリ「HiBoard」に [会計] 取引 の参照・更新 の権限が要る。無い間は画面に案内を出し、自動実行は何もしない
 */
'use strict';

const freeeQuote = require('./freee-quote');
const salesCategory = require('./sales-category');

const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_FIRST_DELAY_MS = 3 * 60 * 1000;

function monthOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** 取引の一覧に、案件から引いた振り替え先の提案と、これまでの反映履歴を付ける */
async function buildRows(db, month) {
  const deals = await freeeQuote.listSalesDeals(month);

  const linksByPartner = new Map();
  db.prepare('SELECT customer_name, partner_id FROM freee_partner_links').all().forEach((l) => {
    if (!linksByPartner.has(l.partner_id)) linksByPartner.set(l.partner_id, []);
    linksByPartner.get(l.partner_id).push(l.customer_name);
  });
  const findCases = db.prepare(`
    SELECT p.id, p.project_name, p.sales_category, p.received_date,
      (SELECT 1 FROM case_quotes q WHERE q.case_id = p.id AND q.total = ? LIMIT 1) AS total_match
    FROM projects p
    WHERE p.customer_name = ? AND COALESCE(p.sales_category, '') != ''
      AND p.received_date BETWEEN date(?, '-180 days') AND date(?, '+31 days')
    ORDER BY total_match DESC, p.received_date DESC
    LIMIT 5
  `);
  const lastLog = db.prepare('SELECT to_code, mode, created_at FROM freee_sales_sync_log WHERE deal_id = ? ORDER BY id DESC LIMIT 1');

  return deals.map((d) => {
    let matched = null;
    for (const name of linksByPartner.get(d.partner_id) || []) {
      const cases = findCases.all(Number(d.amount) || 0, name, d.issue_date, d.issue_date);
      if (cases.length) { matched = cases[0]; break; }
    }
    let suggested;
    let confidence;
    if (matched && matched.total_match) {
      suggested = { code: matched.sales_category, reason: '同じ取引先の案件に、税込合計が一致する見積があるため' };
      confidence = 'high';
    } else if (/八木繊維/.test(d.partner_name)) {
      suggested = { code: 'CORP_UNIFORM', reason: '八木繊維様(卸)は企業ユニフォームの区分' };
      confidence = 'high';
    } else if (matched) {
      suggested = { code: matched.sales_category, reason: '同じ取引先の直近の案件の区分(金額は一致していません)' };
      confidence = 'medium';
    } else if (d.current_code && d.current_code !== 'GENERAL' && d.current_code !== 'MIXED') {
      // 既に売上高以外の科目が付いている取引は、人がfreeeで選んだ値を正とする(文字判定で「通常」へ戻す提案はしない)
      suggested = { code: d.current_code, reason: 'freeeで既に科目が付いています(案件との突き合わせなし)' };
      confidence = 'current';
    } else {
      suggested = salesCategory.suggest({ customer: d.partner_name, title: d.description, texts: [d.ref_number] });
      suggested.reason = `取引先名・摘要から: ${suggested.reason}`;
      confidence = 'low';
    }
    const log = lastLog.get(d.id) || null;
    return {
      ...d,
      current_label: d.current_code === 'MIXED' ? '混在' : (salesCategory.labelOf(d.current_code) || '—'),
      suggested_code: suggested.code,
      suggested_reason: suggested.reason,
      confidence,
      matched_case: matched ? { id: matched.id, project_name: matched.project_name } : null,
      last_sync: log ? { to_label: salesCategory.labelOf(log.to_code), mode: log.mode, at: log.created_at } : null,
    };
  });
}

/** 取引1件を振り替えて履歴に残す。案件が紐づいていて区分が未設定なら案件側にも書く */
async function applyRow(db, { dealId, code, caseId, mode, fromCode, issueDate, amount }) {
  const normalized = salesCategory.normalize(code);
  if (!normalized) throw new Error('売上区分が不正です');
  const result = await freeeQuote.updateDealSalesAccount(dealId, normalized);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO freee_sales_sync_log (deal_id, issue_date, from_code, to_code, mode, case_id, amount, changed_lines, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(result.deal_id, issueDate || null, fromCode || null, normalized, mode === 'auto' ? 'auto' : 'manual',
    caseId > 0 ? caseId : null, Number(amount) || Number(result.amount) || null, result.changed, now);
  if (caseId > 0) {
    db.prepare(`UPDATE projects SET sales_category = ?, updated_at = ? WHERE id = ? AND COALESCE(sales_category, '') = ''`)
      .run(normalized, now, caseId);
  }
  console.log(`[freee科目] 取引 ${result.deal_id}(${issueDate || '-'}) を「${salesCategory.accountNameOf(normalized)}」へ(${mode === 'auto' ? '自動' : '手動'}・明細 ${result.changed}行)`);
  return { ...result, label: salesCategory.labelOf(normalized), account: salesCategory.accountNameOf(normalized) };
}

// 権限不足の案内は6時間ごとに出ると鬱陶しいので1日1回にする
let permissionWarnedAt = 0;

/**
 * 自動実行の本体。当月と前月の取引のうち「今が売上高」かつ「高」の提案だけを付け替える。
 * 一度でも履歴のある取引(自動・手動とも)は触らない=人が戻した値を再び上書きしない
 */
async function runAuto(db) {
  if (freeeQuote.status().state !== 'ready') return { skipped: 'freee未連携' };
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const months = [monthOf(prev), monthOf(now)];
  let applied = 0;
  let candidates = 0;
  for (const month of months) {
    let rows;
    try {
      rows = await buildRows(db, month);
    } catch (error) {
      if (error.need_permission) {
        if (Date.now() - permissionWarnedAt > 24 * 60 * 60 * 1000) {
          permissionWarnedAt = Date.now();
          console.warn(`[freee科目] 自動振り替えは待機中: ${error.message}`);
        }
        return { skipped: 'need_permission' };
      }
      console.error(`[freee科目] ${month} の取引を読めませんでした: ${error.message}`);
      return { skipped: error.message };
    }
    const targets = rows.filter((r) => r.current_code === 'GENERAL' && r.confidence === 'high'
      && r.suggested_code && r.suggested_code !== 'GENERAL' && !r.last_sync);
    candidates += targets.length;
    for (const r of targets) {
      try {
        await applyRow(db, {
          dealId: r.id, code: r.suggested_code, caseId: r.matched_case ? r.matched_case.id : null,
          mode: 'auto', fromCode: r.current_code, issueDate: r.issue_date, amount: r.amount,
        });
        applied += 1;
      } catch (error) {
        console.error(`[freee科目] 取引 ${r.id} の自動振り替えに失敗: ${error.message}`);
      }
    }
  }
  if (candidates) console.log(`[freee科目] 自動振り替え: ${applied}/${candidates}件`);
  return { applied, candidates };
}

/** サーバー起動時に呼ぶ。.env の FREEE_SALES_AUTO=off で止められる */
function start(db) {
  if (process.env.FREEE_SALES_AUTO === 'off') {
    console.log('[freee科目] 自動振り替え: 無効(.env の FREEE_SALES_AUTO=off)');
    return;
  }
  console.log('[freee科目] 自動振り替え: 有効(6時間ごと・当月と前月・「売上高」のままで判定「高」の取引だけ)');
  const tick = () => runAuto(db).catch((e) => console.error('[freee科目] 自動振り替えでエラー:', e.message));
  setTimeout(tick, AUTO_FIRST_DELAY_MS);
  setInterval(tick, AUTO_INTERVAL_MS);
}

module.exports = { buildRows, applyRow, runAuto, start };
