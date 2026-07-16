// 確定登録(confirmAiIntake)時に、ai_extracted_intake から案件へ引き継ぐ構造化データを
// 取り出して正規化する純関数群。DBに依存しないため単体テスト可能。
'use strict';

// プリント箇所・名簿(案件単位)を取り出す。
// 優先順位: 確定画面(projectData)が明示的に渡した値 > intakeのraw_ai_response(Web注文フォーム由来)。
// LINE経由の候補はこの構造を持たないため空配列となり、従来挙動は変わらない。
function extractCarriedData(projectData, intakeRow) {
  let printLocations = Array.isArray(projectData.print_locations) ? projectData.print_locations : null;
  let roster = Array.isArray(projectData.roster) ? projectData.roster : null;

  if ((printLocations === null || roster === null) && intakeRow && intakeRow.raw_ai_response) {
    try {
      const raw = JSON.parse(intakeRow.raw_ai_response);
      if (raw && raw.source === 'web_order_form') {
        if (printLocations === null) printLocations = (raw.decoration && raw.decoration.print_locations) || [];
        if (roster === null) roster = raw.roster || [];
      }
    } catch (err) {
      console.error('[確定] raw_ai_responseの解析に失敗:', err.message);
    }
  }

  const normLocations = (printLocations || [])
    .map(l => ({ location_name: String(l.location_name || '').trim(), color_count: parseInt(l.color_count, 10) }))
    .filter(l => l.location_name && Number.isInteger(l.color_count) && l.color_count >= 1 && l.color_count <= 4);

  const normRoster = (roster || [])
    .map((r, i) => ({
      row_no: Number.isInteger(r.row_no) ? r.row_no : i + 1,
      player_name: String(r.player_name || '').trim(),
      number: String(r.number || '').trim(),
      size: String(r.size || '').trim(),
    }))
    .filter(r => r.player_name || r.number);

  return { printLocations: normLocations, roster: normRoster };
}

// Web注文フォーム由来の intake から、案件へ引き継ぐアイテム配列を取り出して正規化する。
// - raw_ai_response.items[](schema_version 2 / 複数アイテム)があればそれを使う
// - 無い旧形式(単一)は raw.item_spec/decoration/quantity を「1アイテムの配列」に正規化(後方互換)
// - Web注文フォーム由来でない(LINE/手動)場合は null を返し、呼び出し側はレガシー処理へ
function extractCarriedItems(intakeRow) {
  if (!intakeRow || !intakeRow.raw_ai_response) return null;
  let raw;
  try { raw = JSON.parse(intakeRow.raw_ai_response); } catch (err) { return null; }
  if (!raw || raw.source !== 'web_order_form') return null;

  const rawItems = (Array.isArray(raw.items) && raw.items.length > 0)
    ? raw.items
    : [{ item_spec: raw.item_spec, decoration: raw.decoration, quantity: raw.quantity }];

  return rawItems.map((it, i) => {
    const is = (it && it.item_spec) || {};
    const us = is.unknown_spec || null;
    const deco = (it && it.decoration) || {};
    const qty = (it && it.quantity) || {};
    const printLocations = (Array.isArray(deco.print_locations) ? deco.print_locations : [])
      .map(l => ({ location_name: String(l.location_name || '').trim(), color_count: parseInt(l.color_count, 10) }))
      .filter(l => l.location_name && Number.isInteger(l.color_count) && l.color_count >= 1 && l.color_count <= 4);
    const matrix = (qty && qty.matrix) || null;
    const quantityTotal = matrix && Number.isInteger(matrix.total)
      ? matrix.total
      : (matrix && Array.isArray(matrix.cells)
          ? matrix.cells.reduce((s, c) => s + (parseInt(c.qty, 10) || 0), 0) : 0);
    return {
      item_no: i + 1,
      category: us ? String(us.category || '') : '',
      sub_category: us ? String(us.sub_category || '') : '',
      catalog_items: Array.isArray(is.catalog_items) ? is.catalog_items : [],
      method: String(deco.method || ''),
      print_locations: printLocations,
      quantity_total: quantityTotal,
      matrix,
    };
  });
}

module.exports = { extractCarriedData, extractCarriedItems };
