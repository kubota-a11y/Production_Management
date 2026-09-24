/**
 * 売上区分(5本柱)と freee の勘定科目の対応(2026-09-24・社長指示)。
 *
 * 「freee請求書の取引登録の勘定科目を、案件の売上ごとに自動で振り分けたい」に応えるための
 * 単一の情報源。案件(projects.sales_category)・見積シミュレーターの自動判定・freee見積書の
 * 明細行の勘定科目・月次の「freee売上科目チェック」画面がすべてこのファイルを見る。
 *
 * サーバー(Node)と画面(ブラウザ)の両方から使うため UMD 形式。画面には /js/sales-category.js で配る。
 *
 * 勘定科目IDは有限会社HiYOSHiのfreee事業所(3789502)の値(2026-09-24 に会計APIで確認)。
 * 事業所を作り直したときだけ .env の FREEE_ACCOUNT_ITEM_IDS(JSON: {"GENERAL":123,...})で上書きできる。
 *
 * ★卸(シラトリ)と店頭小売も「EC売上(BASE)」に入れる(2026-09-24 社長決定)。KRATVS小売はEC・卸・店頭をまとめて1科目。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SalesCategory = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIST = [
    { code: 'GENERAL', label: '通常', short: '通常', account: '売上高', account_item_id: 607046610,
      hint: 'クラスT・チームT・イベントT・記念品・マーキング・持込加工など(上の4つ以外は全部これ)' },
    { code: 'SUBLIMATION', label: '昇華ユニフォーム', short: '昇華', account: '昇華アイテム売上', account_item_id: 1047712890,
      hint: '昇華プリントのユニフォーム・ピステ・タオル・マグカップなど(TRES・システムグラフィー製)' },
    { code: 'CORP_UNIFORM', label: '企業ユニフォーム', short: '企業ユニ', account: '企業ユニフォーム売上', account_item_id: 1048146805,
      hint: '会社・お店の作業着・制服・スタッフウェア。八木繊維様(卸)もここ' },
    { code: 'CUSTOM_ORDER', label: 'カスタムオーダー', short: 'カスタム', account: 'カスタムオーダー売上', account_item_id: 1048146812,
      hint: 'KRATVSカスタムオーダー(チームウェア・練習着・ビブス・キャップ)' },
    { code: 'KRATVS_RETAIL', label: 'KRATVS小売', short: 'KRATVS小売', account: 'EC売上(BASE)', account_item_id: 1000593111,
      hint: 'KRATVSの完成品販売(EC・卸・店頭)。卸・店頭もEC売上(BASE)に入れる(2026-09-24 社長決定)。ECの月次は自動登録なので、ここを選ぶのは卸・店頭の請求だけ' },
  ];
  const BY_CODE = Object.fromEntries(LIST.map((c) => [c.code, c]));

  // 事業所を作り直したとき用の上書き(サーバー側だけ。値が数値でないものは無視)
  let overrides = {};
  try {
    if (typeof process !== 'undefined' && process.env && process.env.FREEE_ACCOUNT_ITEM_IDS) {
      const parsed = JSON.parse(process.env.FREEE_ACCOUNT_ITEM_IDS);
      Object.keys(parsed || {}).forEach((k) => { if (BY_CODE[k] && Number.isInteger(parsed[k])) overrides[k] = parsed[k]; });
    }
  } catch (_) { overrides = {}; }

  /** 保存してよい区分コードに正規化する。不明・空は ''(未設定) */
  function normalize(code) {
    const c = String(code || '').trim();
    return BY_CODE[c] ? c : '';
  }
  function get(code) { return BY_CODE[normalize(code)] || null; }
  function labelOf(code) { const c = get(code); return c ? c.label : ''; }
  function accountNameOf(code) { const c = get(code); return c ? c.account : ''; }
  /** freeeの勘定科目ID。未設定なら null(freeeの初期値=売上高に任せる) */
  function accountItemId(code) {
    const c = get(code);
    if (!c) return null;
    return overrides[c.code] || c.account_item_id;
  }
  /** 勘定科目ID → 区分コード(freee側の取引を読むとき用)。売上系でない科目は null */
  function codeOfAccountItemId(id) {
    const n = parseInt(id, 10);
    const hit = LIST.find((c) => accountItemId(c.code) === n);
    return hit ? hit.code : null;
  }
  /** 売上系の勘定科目IDの一覧(取引の絞り込み用) */
  function salesAccountItemIds() { return LIST.map((c) => accountItemId(c.code)); }

  // 台帳分類のルール(売上予算_5本柱 §6)を、見積・案件の文字情報から引けるようにしたもの
  const RE = {
    sublimation: /昇華|SUBLIMATION|サブリメーション/i,
    custom: /KRATVS|クラヴズ|クラブズ|clubz|カスタムオーダー|練習着|ビブス/i,
    corpWords: /作業着|作業服|制服|企業ユニ|スタッフウェア|スタッフT|社名|会社名|店名|ロゴ入り|ユニフォーム|エプロン|つなぎ|ブルゾン|ジャンパー|ポロ/,
    corpCustomer: /株式会社|有限会社|合同会社|合資会社|\(株\)|（株）|\(有\)|（有）|㈱|㈲|工業|建設|工務店|製作所|製作|商店|商事|興業|産業|運輸|運送|電気|設備|不動産|病院|クリニック|医院|歯科|薬局|事務所|法人|組合|工場|保育園|幼稚園|こども園|学園|銀行|信用金庫|ホテル|旅館|整骨院|接骨院|美容室|サロン|カフェ|食堂|ラーメン|居酒屋|レストラン|自動車|モータース|園芸|農園|水産|漁協|JA/,
    yagi: /八木繊維/,
  };

  /**
   * 見積・案件の内容から売上区分を提案する。戻り値 { code, reason }。
   * ctx: { mode: 'normal'|'yagi'|'kratvs', customer, title, texts: [摘要など], process_types: [加工種別コード] }
   * 判定順は価格ルール§0(KRATVS → 八木繊維 → その他)と同じ。迷ったら「通常」
   */
  function suggest(ctx) {
    const c = ctx || {};
    const customer = String(c.customer || '');
    const title = String(c.title || '');
    const texts = [title, ...(Array.isArray(c.texts) ? c.texts : [])].map((t) => String(t || '')).join('\n');
    const processes = Array.isArray(c.process_types) ? c.process_types.join(',') : String(c.process_types || '');

    if (c.mode === 'kratvs') return { code: 'CUSTOM_ORDER', reason: 'KRATVSカスタムオーダーのモードのため' };
    if (c.mode === 'yagi' || RE.yagi.test(customer)) return { code: 'CORP_UNIFORM', reason: '八木繊維様(卸)のため' };
    if (RE.sublimation.test(texts) || /SUBLIMATION/.test(processes)) return { code: 'SUBLIMATION', reason: '昇華プリントの見積のため' };
    if (RE.custom.test(texts) || RE.custom.test(customer)) return { code: 'CUSTOM_ORDER', reason: 'KRATVS・練習着・ビブスの語があるため' };
    if (/作業着|作業服|制服|企業ユニ|スタッフウェア|社名|会社名|店名/.test(texts)) return { code: 'CORP_UNIFORM', reason: '作業着・制服・社名入りの語があるため' };
    if (RE.corpCustomer.test(customer) && RE.corpWords.test(texts)) return { code: 'CORP_UNIFORM', reason: '法人・お店のお客様のユニフォーム類のため' };
    return { code: 'GENERAL', reason: '上の4つに当てはまらないため(通常の加工売上)' };
  }

  return { LIST, normalize, get, labelOf, accountNameOf, accountItemId, codeOfAccountItemId, salesAccountItemIds, suggest };
}));
