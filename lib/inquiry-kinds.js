// 公式LINEの「入口」ごとのお問い合わせフォーム定義(2026-09-09 社長決定)。
//
// 公式LINEのあいさつメッセージ・リッチメニューから、用途別の短いフォーム(/inquiry/{kind})へ
// 誘導するための項目定義。ここが **サーバー側の検証と画面の描画の両方の単一情報源** になる
// (lib/inquiry.js が検証に、public/js/inquiry.js がこの定義をそのまま受け取って描画に使う)。
// 入口を足す・項目を変えるときは、このファイルだけを直せばよい。
//
// 決定事項(2026-09-09):
//   - 入口は3本: チーム・サッカー / クラスTシャツ / オリジナルアイテム(お店・会社のウェア制作など)
//   - 担当の目安: オリジナルアイテム=三浦さん、チーム・サッカーとクラスT=山本さん
//   - サンプル送付はクラスTのみ。「サンプル希望」にチェックした方だけ送付先住所を入力する
//   - 「1枚から」という表記は使わない(オリジナルアイテムは「お店・会社のウェア制作」で案内)
//
// field の属性:
//   key       … 値のキー(英数字のみ)
//   label     … 画面の見出し
//   type      … text / tel / email / date / select / checkboxes(複数選択) / checkbox(はい/いいえ) / textarea
//   required  … 必須
//   requiredIf… { key, equals } の条件を満たすときだけ必須(表示もこの条件で切り替える)
//   options   … select / checkboxes の選択肢 [{ value, label }]
//   section   … 画面上のまとまり(同じ section が連続して1枚のカードになる)
//   half      … 2列レイアウトで半分幅にする
//   private   … 個人情報(住所など)。受注候補の詳細(メモ)にだけ残し、一覧・通知・メールには出さない
//   maxlength / placeholder / hint … 画面用

const SECTION_WHO = 'お客様情報';
const SECTION_WHAT = 'ご相談内容';
const SECTION_SAMPLE = 'サンプルの送付(ご希望の方のみ)';

const KINDS = {
  'team': {
    slug: 'team',
    lineUserId: 'INQ_TEAM',
    displayName: 'お問い合わせ(チーム・サッカー)',
    icon: '⚽',
    label: 'チーム・サッカーウェア',
    chooserNote: 'ユニフォーム・練習着・ジャージなど',
    title: 'チーム・サッカーウェアのご相談',
    lead: 'ユニフォーム・練習着・ジャージなど、チームウェアのご相談を承ります。枚数もデザインも未定のままで大丈夫です。',
    requestTypeLabel: 'チーム・サッカーウェアのご相談',
    owner: '山本さん',
    fields: [
      { key: 'team_name', label: 'チーム名', type: 'text', required: true, section: SECTION_WHO, half: true, maxlength: 100 },
      { key: 'contact_name', label: '代表者・ご担当者名', type: 'text', required: true, section: SECTION_WHO, half: true, maxlength: 100 },
      { key: 'category', label: 'カテゴリ', type: 'select', section: SECTION_WHO, half: true, options: [
        { value: 'junior', label: '少年(小学生以下)' },
        { value: 'jhs', label: '中学生' },
        { value: 'hs', label: '高校生' },
        { value: 'adult', label: '大学・社会人' },
        { value: 'other', label: 'その他' },
      ] },
      { key: 'phone', label: '電話番号', type: 'tel', required: true, section: SECTION_WHO, half: true },
      { key: 'email', label: 'メールアドレス', type: 'email', section: SECTION_WHO, half: true, hint: 'ご記入いただくと受付控えをお送りします' },
      { key: 'items', label: '作りたいもの', type: 'checkboxes', section: SECTION_WHAT, options: [
        { value: 'uniform', label: 'ユニフォーム' },
        { value: 'practice', label: '練習着・Tシャツ' },
        { value: 'jersey', label: 'ジャージ・ピステ' },
        { value: 'bibs', label: 'ビブス・小物' },
        { value: 'other', label: 'その他' },
      ] },
      { key: 'headcount', label: '人数・枚数の目安', type: 'text', section: SECTION_WHAT, half: true, maxlength: 50, placeholder: '例: 20名分' },
      { key: 'timing', label: 'ご希望の時期', type: 'text', section: SECTION_WHAT, half: true, maxlength: 100, placeholder: '例: 10月中に / 未定' },
      { key: 'message', label: 'ご相談内容・ご要望', type: 'textarea', section: SECTION_WHAT, maxlength: 2000, placeholder: '例: 来季のユニフォームを新調したい。デザインはこれから相談したい。' },
    ],
  },

  'class-t': {
    slug: 'class-t',
    lineUserId: 'INQ_CLASS_T',
    displayName: 'お問い合わせ(クラスTシャツ)',
    icon: '👕',
    label: 'クラスTシャツ',
    chooserNote: '文化祭・体育祭・部活T',
    title: 'クラスTシャツのご相談',
    lead: '文化祭・体育祭などのクラスTシャツのご相談を承ります。枚数やデザインが決まっていなくても大丈夫です。',
    requestTypeLabel: 'クラスTシャツのご相談',
    owner: '山本さん',
    fields: [
      { key: 'contact_name', label: 'お名前', type: 'text', required: true, section: SECTION_WHO, half: true, maxlength: 100 },
      { key: 'school_name', label: '学校名', type: 'text', required: true, section: SECTION_WHO, half: true, maxlength: 100 },
      { key: 'grade_class', label: '学年・クラス', type: 'text', required: true, section: SECTION_WHO, half: true, maxlength: 50, placeholder: '例: 2年3組' },
      { key: 'phone', label: '電話番号', type: 'tel', required: true, section: SECTION_WHO, half: true },
      { key: 'email', label: 'メールアドレス', type: 'email', section: SECTION_WHO, half: true, hint: 'ご記入いただくと受付控えをお送りします' },
      { key: 'quantity', label: '枚数の目安', type: 'text', section: SECTION_WHAT, half: true, maxlength: 50, placeholder: '例: 35枚' },
      { key: 'use_date', label: '使う日(文化祭・体育祭など)', type: 'date', section: SECTION_WHAT, half: true },
      { key: 'message', label: 'ご相談内容・ご要望', type: 'textarea', section: SECTION_WHAT, maxlength: 2000, placeholder: '例: クラス全員の名前を背中に入れたい。予算は1人2,000円くらい。' },
      { key: 'sample_request', label: 'サンプルの送付を希望する', type: 'checkbox', section: SECTION_SAMPLE, hint: '実物の生地や色味をご確認いただけます。ご希望の方だけ送付先をご記入ください。' },
      { key: 'sample_address', label: 'サンプル送付先(郵便番号・住所・宛名)', type: 'textarea', section: SECTION_SAMPLE, private: true, maxlength: 500,
        requiredIf: { key: 'sample_request', equals: true },
        placeholder: '例: 〒411-0000 静岡県駿東郡長泉町〇〇1-2-3 〇〇高校 2年3組 山田 太郎 宛' },
    ],
  },

  'original': {
    slug: 'original',
    lineUserId: 'INQ_ORIGINAL',
    displayName: 'お問い合わせ(オリジナルアイテム)',
    icon: '✨',
    label: 'オリジナルアイテム',
    chooserNote: 'お店・会社のウェア制作など',
    title: 'お店・会社のウェア制作のご相談',
    lead: 'お店や会社のユニフォーム、スタッフTシャツ、作業着へのプリント・刺繍などのご相談を承ります。',
    requestTypeLabel: 'オリジナルアイテムのご相談',
    owner: '三浦さん',
    fields: [
      { key: 'contact_name', label: 'お名前', type: 'text', required: true, section: SECTION_WHO, half: true, maxlength: 100 },
      { key: 'org_name', label: 'お店・会社・団体名', type: 'text', section: SECTION_WHO, half: true, maxlength: 100 },
      { key: 'phone', label: '電話番号', type: 'tel', required: true, section: SECTION_WHO, half: true },
      { key: 'email', label: 'メールアドレス', type: 'email', section: SECTION_WHO, half: true, hint: 'ご記入いただくと受付控えをお送りします' },
      { key: 'item_type', label: '作りたいもの', type: 'select', section: SECTION_WHAT, half: true, options: [
        { value: 'tshirt', label: 'Tシャツ' },
        { value: 'polo', label: 'ポロシャツ' },
        { value: 'sweat', label: 'パーカー・トレーナー' },
        { value: 'workwear', label: '作業着・お店のユニフォーム' },
        { value: 'cap', label: '帽子' },
        { value: 'other', label: 'その他' },
      ] },
      { key: 'method', label: '加工方法', type: 'select', section: SECTION_WHAT, half: true, options: [
        { value: 'print', label: 'プリント' },
        { value: 'embroidery', label: '刺繍' },
        { value: 'unknown', label: 'おまかせ・わからない' },
      ] },
      { key: 'quantity', label: '枚数の目安', type: 'text', section: SECTION_WHAT, half: true, maxlength: 50, placeholder: '例: 10枚' },
      { key: 'timing', label: 'ご希望の時期', type: 'text', section: SECTION_WHAT, half: true, maxlength: 100, placeholder: '例: 11月上旬まで / 未定' },
      { key: 'message', label: 'ご相談内容・ご要望', type: 'textarea', section: SECTION_WHAT, maxlength: 2000, placeholder: '例: スタッフ用のポロシャツに店名の刺繍を入れたい。ロゴデータはあります。' },
    ],
  },
};

// 入口選択ページ(/inquiry)と公式LINEの案内に使う並び順
const KIND_ORDER = ['team', 'class-t', 'original'];

function getKind(slug) {
  return Object.prototype.hasOwnProperty.call(KINDS, slug) ? KINDS[slug] : null;
}

// 画面へ渡す入口一覧(chooser用)。
function chooserList() {
  return KIND_ORDER.map(slug => {
    const k = KINDS[slug];
    return { slug: k.slug, icon: k.icon, label: k.label, note: k.chooserNote };
  });
}

// 選択肢の value → 表示名
function optionLabel(field, value) {
  const opt = (field.options || []).find(o => o.value === value);
  return opt ? opt.label : value;
}

module.exports = { KINDS, KIND_ORDER, getKind, chooserList, optionLabel };
