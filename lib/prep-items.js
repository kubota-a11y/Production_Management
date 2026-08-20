// 準備項目のうち「誰の仕事か」を決めるコード一覧。
// server.js(案件登録時の自動割り当て)と db/init.js(既存データの整備)の両方から使うため、
// 二重管理にならないようここ1か所に置く。項目そのものの定義は preparation_item_master。

// 「この案件はデザインが絡む」と判断する準備項目。
// デザインを実際に起こす作業だけを挙げる。この一覧に当たると案件へ「初校提出」が自動追加され、
// 案件フォームで「デザインの入稿納期」が必須になる。
// 作業指示書作成・見積書作成を入れないのは、加工だけの追加注文でも普通に選ばれる事務作業で、
// これを引き金にすると鈴木さんのボードに本人の仕事でないカードが積まれるため(2026-08-19 社長指示)
const DESIGN_WORK_ITEM_CODES = ['OUTSOURCE_DESIGN_DATA', 'PROMO_DESIGN_DATA'];

// デザイン担当へは自動で割り当てない準備項目(社長指示で鈴木さんの担当から外したもの)。
// 社内デザイン案件・デザイン進行ボードで管理する案件は本来「全項目をデザイン担当へ」だが、
// この一覧のものはその対象からも外す。
//   DTFデータ作成                     … 2026-08-18。必要なときは案件の作業内容に書いて個別依頼する
//   作業指示書作成 / 見積書作成        … 2026-08-19。三浦さん・山本さんの事務作業
const NON_DESIGNER_ITEM_CODES = ['DTF_DATA_CREATION', 'WORK_INSTRUCTION_CREATION', 'QUOTATION_CREATION'];

// タスク単位の作業状態(2026-08-20 社長要望)。マイスケジュールボードのカードにバッジで出す。
// 「初校/修正/校了」やCARVEの作業段階は案件単位で、同じ案件のカードは全部同じ表示になるため、
// 「このタスクはいま作業中/このタスクはお客様待ち」を表せる軸がなかった。
//
// 完了かどうかは従来どおり case_preparation_items.status(未着手/完了)で持ち、こちらは別の列にする。
// 同じ列に混ぜると、完了を外したときに「お客様確認中だった」という情報まで消えてしまうため。
// 未設定(null)= 未着手扱いでバッジを出さない。
// マイスケジュールボード(lib/designer-board.js)と社内の週間スケジュールボード(server.js)の
// 両方から使うのでここに置く
const WORK_STATES = [
  { key: 'WORKING', label: '作業中' },
  { key: 'CUSTOMER_REVIEW', label: 'お客様確認中' },
  { key: 'INTERNAL_REVIEW', label: '社内確認待ち' },
];
const WORK_STATE_KEYS = WORK_STATES.map(w => w.key);
const WORK_STATE_LABELS = Object.fromEntries(WORK_STATES.map(w => [w.key, w.label]));

// タスクのひとことメモの最大長。「8/18 勝又様に連絡済み」のような申し送りを1行だけ持つ
// (上書き式。履歴は残さない)
const WORK_NOTE_MAX = 200;

module.exports = {
  DESIGN_WORK_ITEM_CODES,
  NON_DESIGNER_ITEM_CODES,
  WORK_STATES,
  WORK_STATE_KEYS,
  WORK_STATE_LABELS,
  WORK_NOTE_MAX,
};
