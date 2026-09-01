/* =========================================================
   見積シミュレーター(社内用) /quote-sim

   サイトの料金シミュレーター(GITHUB_HiYOSHi_WEB/functions/api/simulate.js)
   と同じ計算方針:
   - **金額はすべて税抜(外税)**。単価表も税抜なので換算せずそのまま使い、
     消費税は小計に対して最後に1回だけ足す(2026-08-25 社長指示)
     ★公開サイトの料金ページ・料金シミュレーターは**税込のまま**にすること。
       消費者向けの価格表示には総額表示義務があるため、あちらを税抜にはできない。
       見積書(商習慣として税抜単価+消費税)とは表記が違って正しい
   - モノクロ(1〜4色)はシルクとDTFの両方を計算して安い方を採用
   - 製版代は「箇所×色数」の版の数だけ。小版=A4以内4,000/大版=A3 8,000
   - ミニマム手数料: 同一型番10枚未満は加工代5割増
   価格データはすべて quote-sim-data.js(出典コメントあり)。
   割引はこの画面だけの機能(サイトには無い):
   - 距離基準プリセット(10〜50%)…1枚単価(ボディ+加工)に適用。
     製版代・パンチング代などの初期費用は割引対象外(実費)
   - 社員特価…ボディ=推定仕入値(表示価格×0.55)+加工賃50%OFF
   ========================================================= */
(function () {
  'use strict';

  const TAX = window.QS_COMMON.taxPercent;
  // 浮動小数点誤差を避けるため整数のまま計算(simulate.jsと同じ)
  /** 税込 → 税抜。KRATVSのカタログだけ税込表記なので、そこだけこれで税抜へ戻す */
  const taxOut = (n) => Math.round((n * 100) / (100 + TAX));
  /** 小計(税抜) → 消費税。**行ごとではなく小計に1回だけ**掛ける(freeeの外税と同じ計算) */
  const taxOf = (n) => Math.round((n * TAX) / 100);
  /** 単価の10円単位への切り上げ。見積書の単価に1円単位の端数を出さない(2026-09-01 社長指示)
      ★掛け算の浮動小数点誤差(650.00000000000002等)で1つ上に繰り上がらないよう、
        先に銭単位で丸めてから切り上げる */
  const up10 = (n) => Math.ceil(Math.round(n * 100) / 1000) * 10;
  /** KRATVSアイテムの種類に対応するプリント表を返す(shirt/shorts/bib) */
  function kratvsPrintList(item) {
    const k = window.QS_KRATVS;
    if (item.kind === 'shorts') return k.printsShorts;
    if (item.kind === 'bib') return k.printsBib;
    if (item.kind === 'cap') return k.printsCap;
    return k.printsShirt;
  }

  const yen = (n) => n.toLocaleString('ja-JP') + '円';

  const SIZES_ALL = ['B8', 'B7', 'A5', 'A4', 'A3'];
  const SMALL_PLATE = new Set(['B8', 'B7', 'A5', 'A4']);

  function tierOf(table, qty) {
    let hit = null;
    for (const t of Object.keys(table).map(Number).sort((a, b) => a - b)) {
      if (qty >= t) hit = t;
    }
    return hit;
  }

  /* ---------- 価格表の切り替え ----------
     八木繊維様モードは画面構成そのままに、参照する料金表と条件だけ差し替える。
     - 卸表に無い加工(マーキング・刺繍)は選択肢から外す=個別見積り
     - ミニマム手数料なし・持込料サービス・版下データ作成料0円
     - 割引プリセットは出さない(卸価格自体が特別価格のため。二重割引の防止) */
  function currentMode() {
    return document.querySelector('input[name="mode"]:checked').value;
  }
  function isYagi() { return currentMode() === 'yagi'; }
  function activeTables() {
    if (isYagi()) {
      return {
        silk: window.QS_YAGI.silk, dtf: window.QS_YAGI.dtf, rubber: window.QS_YAGI.rubber,
        minFeeApplies: false, bringFree: true,
      };
    }
    return {
      silk: window.QS_SILK, dtf: window.QS_DTF, rubber: window.QS_RUBBER,
      minFeeApplies: true, bringFree: false,
    };
  }

  // 割増率。ナイロン・撥水シート系は一般表と八木繊維様専用表で率が違う(yagiRate)
  function surRate(key) {
    const s = window.QS_SURCHARGE[key];
    return (isYagi() && s.yagiRate) ? s.yagiRate : s.rate;
  }

  /* ---------- 加工行の定義 ---------- */
  // method: auto(シルク/DTF安い方) / silk / dtf / rubber / marking / emb / cap
  let rowSeq = 0;
  const rows = []; // {id, method, size, colors, markKey, embPlaces, embTime, embSize, patch, surcharges:Set}

  function newRow() {
    rows.push({
      id: ++rowSeq, method: 'auto', size: 'A4', colors: 1, markKey: 'num_l',
      embPlaces: '1〜2箇所', embTime: '〜15分', embSize: 0, patch: false, surcharges: new Set(),
      targets: null, // null = すべてのボディに載せる
      // 見積書の摘要の頭に出す箇所名(例: 左胸・背面・両襟)。案件から開くと自動で入る。
      // 金額には一切影響しない表示専用の項目
      locationName: '',
      // 追加注文などで版・刺繍データが既にあるとき、初期費用(製版代・パンチング代)を外す
      noInitial: false,
    });
  }

  /* ---------- 1行ぶんの単価計算(税抜) ----------
     返り値 {label, cust, unit, initial, initialLabel, note, minFee}
     - label … 社内の内訳表示用(大きさ・条件まで入った詳しい名前)
     - cust  … お客様向けの見積書に出す加工名(料金表の用語ではなく通じる言葉で書く) */
  /* qty     … 枚数帯(10枚〜/30枚〜/50枚〜)の判定に使う枚数。その加工を刷る総枚数
     minQty  … ミニマム手数料の判定に使う枚数。料金表の文言どおり「同一型番」= ボディ品番ごと */
  function calcRow(row, qty, minQty, opt) {
    const tbl = activeTables();
    // 見積書の摘要に「※ミニマム手数料込み」と書くために、乗ったかどうかを返す
    const minFeeOn = tbl.minFeeApplies && minQty < 10;
    return { ...calcRowBase(row, qty, minQty, opt), minFee: minFeeOn };
  }

  function calcRowBase(row, qty, minQty, opt) {
    const tbl = activeTables();
    // 持込料は八木繊維様は「サービス」なのでチェックが残っていても掛けない
    const sur = [...row.surcharges]
      .filter((k) => !(tbl.bringFree && k === 'bring'))
      .reduce((m, k) => m * surRate(k), 1);
    const minFee = (tbl.minFeeApplies && minQty < 10) ? window.QS_COMMON.minFeeRate : 1;
    const expr = opt.express ? 1.5 : 1;
    // 割増・ミニマム・特急で出る1円単位の端数は10円単位へ切り上げる
    const mul = (u) => up10(u * sur * minFee * expr);

    if (row.method === 'marking') {
      const m = window.QS_MARKING.find((x) => x.key === row.markKey);
      return { label: `マーキング ${m.name}(${m.size})`, short: 'マーキング', cust: `マーキング ${m.name}`, unit: mul(m.p), initial: 0, note: window.QS_MARKING_NOTE };
    }
    if (row.method === 'nameEmb') {
      return { label: 'ネーム刺繍(1.5×8cm以内)', short: 'ネーム刺繍', cust: 'ネーム刺繍', unit: mul(window.QS_EMB.nameOnly), initial: 0, note: '' };
    }
    if (row.method === 'dtfName') {
      return { label: 'DTFネームプリント', short: 'DTFネーム', cust: 'DTFネームプリント', unit: mul(window.QS_COMMON.dtfName), initial: 0, note: '登録業者様向けの単価です' };
    }
    if (row.method === 'emb' || row.method === 'cap') {
      const isCap = row.method === 'cap';
      const t = isCap ? window.QS_EMB.cap : window.QS_EMB.normal;
      const base = isCap
        ? t.rows[row.embPlaces][row.embTime]
        : t.rows[row.embPlaces][row.embTime][row.embSize];
      // 刺繍データが作成済み(追加注文など)ならパンチング代を落とす
      const punch = row.noInitial ? 0 : (isCap ? t.punching : t.punching[row.embSize]);
      const sizeName = isCap ? '100cm²以内' : window.QS_EMB.normal.sizes[row.embSize];
      // ワッペン用資材一式は割増ではなく1枚あたりの実費(円加算)
      const patchFee = row.patch ? window.QS_EMB.patch : 0;
      return {
        label: `${isCap ? '帽子刺繍' : '刺繍'} ${row.embPlaces}・${row.embTime}・${sizeName}${row.patch ? '・ワッペン用資材一式' : ''}`,
        short: isCap ? '帽子刺繍' : '刺繍',
        cust: `${isCap ? '帽子刺繍' : '刺繍'}(${sizeName})${row.patch ? '・ワッペン用資材一式' : ''}`,
        unit: mul(base) + patchFee, initial: punch, initialLabel: 'パンチング代(初回のみ)',
        initialWaived: Boolean(row.noInitial),
        waivedNote: '※作成済みの刺繍データを使用(パンチング代なし)',
        note: '加工時間は刺繍データ完成後に確定(この金額は概算)',
      };
    }
    if (row.method === 'rubber') {
      const table = tbl.rubber[row.size];
      if (!table) return { label: 'ラバー転写', short: 'ラバー転写', cust: 'ラバー転写プリント', unit: 0, initial: 0, note: 'B8はラバー転写の設定なし' };
      const u = table[tierOf(table, qty)];
      return { label: `ラバー転写 ${row.size}`, short: 'ラバー転写', cust: `ラバー転写プリント(${row.size}以内)`, unit: mul(u), initial: 0, note: '' };
    }

    // シルク/DTF/自動
    const dtfUnit = tbl.dtf[row.size][tierOf(tbl.dtf[row.size], qty)];
    const silkTable = (row.colors !== 'full' && row.colors <= tbl.silk.maxColors)
      ? tbl.silk.print[row.colors] : null;
    let silkTier = silkTable ? tierOf(silkTable, qty) : null;
    /* 一般価格表のシルクは10枚〜からしか帯が無い。**10枚未満は原則お受けしない**が、
       強くご希望のお客様には特別対応しており、そのときの単価は
       「10枚(ミニマム枚数)時の単価 × ミニマム手数料5割増」で出す運用(2026-08-25 社長確認)。
       ★例外対応なので「自動(安い方)」では選ばない。シルクを明示的に選んだときだけ出す
       (八木繊維様の卸表は1枚〜の帯があるので、ここには入らない) */
    const silkBelowMin = Boolean(silkTable) && silkTier === null && row.method === 'silk';
    if (silkBelowMin) silkTier = Math.min(...Object.keys(silkTable).map(Number));
    const silkUnit = silkTier !== null ? silkTable[silkTier] : null;
    const plateOne = tbl.silk.plate[SMALL_PLATE.has(row.size) ? 'small' : 'large'];
    // 版が既にある(追加注文など)なら製版代を落とす。
    // ★ここで0にしておくと、自動(シルク/DTFの安い方)の総額比較にも正しく効く
    const silkPlate = row.noInitial ? 0 : plateOne * row.colors;

    const dtf = {
      label: `DTFプリント ${row.size}(フルカラー可)`, short: 'DTF',
      cust: `DTFプリント フルカラー(${row.size}以内)`, unit: mul(dtfUnit), initial: 0, note: '',
    };
    const silk = silkUnit === null ? null : {
      label: `シルク ${row.size}・${row.colors}色`, short: `シルク${row.colors}色`,
      // 見積書は料金表の言葉(シルク)ではなくお客様に通じる言葉で書く。1色は「単色」
      cust: `シルクプリント ${row.colors === 1 ? '単色' : `${row.colors}色`}(${row.size}以内)`,
      unit: mul(silkUnit),
      initial: silkPlate, initialLabel: `製版代 ${row.colors}版(初回のみ)`,
      initialWaived: Boolean(row.noInitial),
      waivedNote: '※前回の版を使用(製版代なし)',
      note: `${silkBelowMin ? `10枚未満の特別対応: ${silkTier}枚時の単価にミニマム手数料(5割増)を適用しています。` : ''}版の保管期間1年`,
    };

    if (row.method === 'dtf' || row.colors === 'full') return dtf;
    if (row.method === 'silk') {
      return silk || { ...dtf, note: 'この枚数・色数はシルク設定なし→DTFで計算' };
    }
    // auto: 総額比較(simulate.jsと同じ)
    if (silk && silk.unit * qty + silk.initial < dtf.unit * qty) return silk;
    return { ...dtf, note: silk ? 'この枚数・大きさではDTFのほうがお得' : 'シルク設定が無いためDTFで計算' };
  }

  /* ---------- ボディ(複数)とサイズ・色別の内訳 ----------
     1案件でボディが複数になることが多い(Tシャツ＋パーカー等)ため、ボディは配列で持つ。
     ボディごとに品番・枚数・サイズ色の内訳を持ち、加工行は「どのボディに載せるか」を選ぶ。

     ★枚数帯(10枚〜/30枚〜/50枚〜)は **その加工を刷る総枚数** で判定する
       (同じ版で刷るので、ボディが分かれても刷り数は合算されるという考え方)
     ★ミニマム手数料は料金表の文言どおり **「同一型番10枚未満」= ボディ品番ごと** に判定する
     どちらもボディが1つのときは従来と同じ結果になる(回帰なし) */
  let bodySeq = 0, bdSeq = 0;
  const bodies = []; // {id, input, manual, qty, breakdown:[{id, variant, band, sizeText, color, qty}]}

  function newBody(preset) {
    bodies.push({ id: ++bodySeq, input: '', manual: '', qty: 15, breakdown: [], ...(preset || {}) });
    return bodies[bodies.length - 1];
  }

  /** 入力値 → ボディの情報 {name, unit(税抜), quoteOnly} */
  function bodyInfo(b) {
    const v = String(b.input || '').trim();
    const hit = window.QS_BODIES.find((x) => v.startsWith(x.sku) || v === `${x.sku} ${x.name}`);
    // 概算の可否は QS_isQuoteOnly() で判定する(hit.quote を直接見ない)。
    // SLOTHの品番は価格表の発効日 2026-10-05 まで個別見積りに倒している(2026-08-31 社長判断)
    if (hit) {
      return {
        name: `${hit.name}(${hit.sku})`, short: hit.sku, cat: hit.cat, unit: hit.body,
        quoteOnly: window.QS_isQuoteOnly(hit), quoteReason: window.QS_quoteOnlyReason(hit),
      };
    }
    const manual = parseInt(b.manual, 10);
    // 手入力の単価も税抜で受け取る(画面の入力欄も「税抜単価」に統一・2026-08-25)
    if (v && manual > 0) return { name: v, short: v, unit: manual, manual: true };
    return { name: '(ボディなし・加工のみ)', short: '加工のみ', unit: 0, none: true };
  }

  function bodySku(b) {
    const v = String(b.input || '').trim();
    const hit = window.QS_BODIES.find((x) => v.startsWith(x.sku) || v === `${x.sku} ${x.name}`);
    return hit ? hit.sku : null;
  }
  function bodySizeData(b) {
    const sku = bodySku(b);
    return sku ? (window.QS_BODY_SIZES[sku] || null) : null;
  }

  /* ---------- サイズ帯 → 個別サイズへの展開 ----------
     価格表は「S〜XL」「2XL・3XL」のような**単価が同じサイズのまとまり(帯)**で持っている。
     見積書には「S:2・M:3・L:5」のようにサイズごとの枚数を出したいので、帯を個別サイズへ開く。
     ★単価は帯のものをそのまま使う(展開しても金額は1円も変わらない)。
     ★同じサイズが1つの色区分の中で2つの帯に出ないことは全369品番で機械確認済み
       (253品番=2026-08-25・SLOTH追加116品番=2026-08-28)。
       つまりサイズを決めれば単価が一意に決まる(検証スクリプトは2026-08-25の作業ログ) */
  const SIZE_FAMILIES = [
    ['70', '80', '90', '100', '110', '120', '130', '140', '150', '160'], // 子供(cm)
    ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'],      // アルファ
    ['SS', 'S', 'M', 'L', 'LL', '3L', '4L', '5L', '6L', '7L'],           // 日本式
    ['WS', 'WM', 'WL'],                                                   // レディース
  ];

  /** 表記ゆれを1つに寄せる(XXL→2XL・XXXL→3XL など)。末尾のcmは落とす */
  function normSize(s) {
    let t = String(s).trim().replace(/cm$/i, '');
    const x = t.match(/^(X{2,})L$/i);
    if (x) t = `${x[1].length}XL`;
    return t;
  }

  /** "S"〜"XL" → ['S','M','L','XL']。体系をまたぐ範囲(150〜XLなど)は null */
  function expandRange(a, b) {
    const from = normSize(a), to = normSize(b);
    for (const fam of SIZE_FAMILIES) {
      const i = fam.indexOf(from), j = fam.indexOf(to);
      if (i >= 0 && j >= 0 && i <= j) return fam.slice(i, j + 1);
    }
    return null;
  }

  /** サイズ帯ラベル → 個別サイズの配列。開けない範囲はラベルのまま1件で返す
      (150〜XL・WM〜LL・WS〜LL の3帯だけが該当。従来どおり1つの選択肢になる) */
  function expandBand(label) {
    const out = [];
    String(label).split('・').forEach((part) => {
      const p = part.trim();
      if (!p) return;
      if (p.includes('〜')) {
        const [a, b] = p.split('〜');
        const r = expandRange(a, b);
        if (r) { out.push(...r); return; }
        out.push(p);
        return;
      }
      out.push(normSize(p));
    });
    return [...new Set(out)];
  }

  /** 色区分 → 選べる個別サイズ [{size, price, bandIdx}](価格表の帯の順に並ぶ) */
  function variantSizes(variant) {
    const out = [];
    const seen = new Set();
    variant.b.forEach((band, bandIdx) => {
      expandBand(band[0]).forEach((size) => {
        if (seen.has(size)) return; // 起こらないはずだが、起きたら先の帯を優先する
        seen.add(size);
        out.push({ size, price: band[1], bandIdx });
      });
    });
    return out;
  }

  /** 内訳1行の枚数。サイズ別に入れた枚数の合計(サイズ表の無いボディは手入力のまま) */
  function syncRowQty(b, r) {
    if (!bodySizeData(b)) return r.qty;
    r.qty = Object.values(r.sizes).reduce((s, n) => s + (parseInt(n, 10) || 0), 0);
    return r.qty;
  }

  /** 1つのボディ → 計算グループ [{label, qty, bodyUnit(税抜)}]。内訳が無ければ枚数の1グループ
      ★内訳1行でも**単価の違うサイズが混ざれば複数グループに分かれる**
        (例: S〜XLは748円・2XLは935円 → 2行の明細になる) */
  function bodyGroups(b) {
    const data = bodySizeData(b);
    const info = bodyInfo(b);
    const list = b.breakdown.filter((r) => r.qty > 0);
    // ボディ単価もカタログ由来の1円単位の端数(853円等)を10円単位へ切り上げて使う
    if (!list.length) {
      return [{ label: '', qty: Math.max(1, parseInt(b.qty, 10) || 1), bodyUnit: up10(info.unit) }];
    }
    const groups = [];
    list.forEach((r) => {
      if (!data) {
        // サイズ表の無いボディ(持込・リスト外)は、これまでどおりサイズを手打ちする
        let label = r.sizeText || '';
        if (r.color) label += `${label ? '・' : ''}${r.color}`;
        groups.push({ label, qty: r.qty, bodyUnit: up10(info.unit) });
        return;
      }
      const variant = data.v[Math.min(r.variant, data.v.length - 1)];
      // 色区分(ホワイト/カラー)と入力された色名が同じときは1つにまとめる(「ホワイト・ホワイト」を防ぐ)
      const head = [...new Set([variant.l, r.color].filter(Boolean))].join('・');
      // 入力されたサイズを単価(帯)ごとにまとめる
      const byBand = new Map();
      variantSizes(variant).forEach((s) => {
        const n = Math.max(0, parseInt(r.sizes[s.size], 10) || 0);
        if (!n) return;
        if (!byBand.has(s.bandIdx)) byBand.set(s.bandIdx, { unit: s.price, parts: [], qty: 0 });
        const g = byBand.get(s.bandIdx);
        g.parts.push(`${s.size}:${n}`);
        g.qty += n;
      });
      byBand.forEach((g) => {
        groups.push({
          label: [head, g.parts.join('・')].filter(Boolean).join('　'),
          qty: g.qty, bodyUnit: up10(g.unit),
        });
      });
    });
    // ★1つも作れなかったときも必ず1グループ返す。calcNormal が groups[0] を見るため
    //   (品番を変えた直後など、行の枚数と入力済みサイズが噛み合わない瞬間の保険)
    if (!groups.length) {
      return [{ label: '', qty: Math.max(1, parseInt(b.qty, 10) || 1), bodyUnit: up10(info.unit) }];
    }
    return groups;
  }

  /** 加工行がそのボディに載るか。targets が無い行は全ボディ共通(既定) */
  function rowAppliesTo(row, bodyId) {
    return !row.targets || row.targets.has(bodyId);
  }

  /* ---------- 通常加工モードの合計 ---------- */
  function calcNormal() {
    const opt = { express: el('opt-express').checked };

    // ボディごとに枚数とグループを出す
    const bodyCalcs = bodies.map((b) => {
      const info = bodyInfo(b);
      const groups = bodyGroups(b);
      return { b, info, groups, qty: groups.reduce((s, g) => s + g.qty, 0) };
    });
    const qty = bodyCalcs.reduce((s, bc) => s + bc.qty, 0);

    // 加工行ごと: 枚数帯は対象ボディの合計枚数、ミニマムはボディごとに判定するので
    // 同じ行でもボディによって単価が変わりうる(byBody に持つ)。
    // 製版代・パンチング代(initial)は版の数ぶんなので、行につき1回だけ数える
    const lines = rows.map((r) => {
      const targets = bodyCalcs.filter((bc) => rowAppliesTo(r, bc.b.id));
      const tierQty = targets.reduce((s, bc) => s + bc.qty, 0) || qty || 1;
      const byBody = new Map();
      targets.forEach((bc) => byBody.set(bc.b.id, calcRow(r, tierQty, bc.qty, opt)));
      // 表(内訳表示)に出す代表値は、ミニマムのかからない側=単価が安いほう
      const rep = byBody.size
        ? [...byBody.values()].reduce((a, x) => (x.unit < a.unit ? x : a))
        : calcRow(r, tierQty, tierQty, opt);
      const varies = byBody.size > 1 && new Set([...byBody.values()].map((x) => x.unit)).size > 1;
      return {
        ...rep, byBody, varies,
        locationName: String(r.locationName || '').trim(),
        targetIds: targets.map((t) => t.b.id),
        targetNames: targets.map((t) => t.info.short),
      };
    });
    const initial = lines.reduce((s, l) => s + l.initial, 0);  // 税抜・初回

    // 割引。八木繊維様は卸価格自体が特別価格のため割引は適用しない
    const d = isYagi() ? { key: 'none', rate: 0, name: '割引なし' } : currentDiscount();
    let discountNote = '';
    if (d.key === 'staff') {
      discountNote = '社員特価: ボディ推定仕入値(表示価格×0.55・要実額確認)+加工賃50%OFF';
    } else if (d.rate > 0) {
      discountNote = `${d.name} ${d.rate}%OFF(1枚単価に適用・初期費用は対象外)`;
    }

    /* 割引は「ボディ」と「加工1箇所」のそれぞれに掛ける。
       ★明細を1行ずつに割る都合上、**行の単価を先に確定させて積み上げる**。
         1枚あたりも小計もこの積み上げから出すので、画面の金額とfreeeの見積書が
         構造的にズレない(合計に1回だけ割引を掛ける作りだと1円ズレが出る) */
    const discountUnit = (u, kind) => {
      // 社員特価: ボディは推定仕入値(表示価格×0.55)、加工賃は半額
      // 割引後の単価も1円単位の端数が出ないよう10円単位へ切り上げる
      if (d.key === 'staff') return up10(u * (kind === 'body' ? 0.55 : 0.5));
      if (d.rate > 0) return up10((u * (100 - d.rate)) / 100);
      return u;
    };

    // 見積書の明細(すべて税抜)。ボディ行 → 加工行 の順に並べる
    const items = [];
    const groups = [];
    bodyCalcs.forEach((bc) => {
      const mine = lines.filter((l) => l.targetIds.includes(bc.b.id));
      const parts = mine.map((l) => l.byBody.get(bc.b.id).label);
      /* 加工は「1箇所につき1行」。サイズ・色の内訳で分けても加工賃は変わらないので、
         行はボディごとに1本にまとめ、数量はそのボディの総枚数にする */
      const printItems = mine.map((l) => {
        const c = l.byBody.get(bc.b.id);
        return {
          kind: 'print', label: c.cust || c.label, location: l.locationName,
          minFee: c.minFee, initialWaived: c.initialWaived, waivedNote: c.waivedNote,
          bodyShort: bc.info.short, qty: bc.qty, unitName: '式',
          unitBefore: c.unit, unit: discountUnit(c.unit, 'print'),
        };
      });
      const printBefore = printItems.reduce((s, x) => s + x.unitBefore, 0);
      const printAfter = printItems.reduce((s, x) => s + x.unit, 0);

      bc.groups.forEach((g) => {
        const bodyAfter = bc.info.none ? 0 : discountUnit(g.bodyUnit, 'body');
        // ボディなし(加工のみ)のときは行を作らない
        if (!bc.info.none) {
          items.push({
            kind: 'body', label: bc.info.name, location: g.label,
            bodyShort: bc.info.short, qty: g.qty, unitName: '枚',
            unitBefore: g.bodyUnit, unit: bodyAfter,
          });
        }
        g.unitBefore = g.bodyUnit + printBefore;
        g.unitAfter = bodyAfter + printAfter;
        if (d.key === 'staff') g.cost = Math.round(g.bodyUnit * 0.55); // 推定仕入値(税抜)
        groups.push({ ...g, parts, bodyId: bc.b.id, bodyName: bc.info.name, bodyShort: bc.info.short });
      });
      items.push(...printItems);
    });

    // 製版代・パンチング代は版の数ぶんの実費。割引対象外なので unitBefore と同額
    lines.filter((l) => l.initial).forEach((l) => {
      items.push({
        // 製版代は箇所ごとに1行ずつ並ぶので、どの箇所のぶんか分かるように箇所名も添える
        kind: 'initial', label: l.initialLabel,
        location: [l.locationName, l.cust || l.label].filter(Boolean).join('　'),
        qty: 1, unitName: '式', unitBefore: l.initial, unit: l.initial,
      });
    });

    const bag = baggingUnit(); // 袋入れは割引対象外の実費(1枚あたり・税抜)
    const shipping = shippingCost();
    if (bag) items.push({ kind: 'bag', label: bag.name, qty, unitName: '枚', unitBefore: bag.unit, unit: bag.unit });
    if (shipping) items.push({ kind: 'shipping', label: '送料', qty: 1, unitName: '式', unitBefore: shipping, unit: shipping });

    // 外税: 明細(税抜)を積み上げて小計 → 小計に1回だけ消費税を掛ける
    const subtotal = items.reduce((s, x) => s + x.unit * x.qty, 0);
    const tax = taxOf(subtotal);
    const total = subtotal + tax;

    return {
      mode: isYagi() ? 'yagi' : 'normal', qty, lines, opt, groups, bodyCalcs,
      multiBody: bodyCalcs.length > 1,
      quoteOnlyNames: bodyCalcs.filter((bc) => bc.info.quoteOnly).map((bc) => bc.info.name),
      quoteOnlyReasons: bodyCalcs.filter((bc) => bc.info.quoteOnly).map((bc) => bc.info.quoteReason),
      unitBefore: groups[0].unitBefore, unitAfter: groups[0].unitAfter,
      discount: d, discountNote, bag, items,
      initial, shipping, subtotal, tax, total,
      perPieceAll: Math.round(subtotal / qty),
      // 卸表の「100枚以上は要相談」。概算は出すが目立つ警告を添える(2026-08-20社長判断)
      yagiOver100: isYagi() && qty >= 100,
    };
  }

  /* ---------- KRATVSモードの合計 ----------
     サイズ帯ごとに単価が違うため、帯ごとの枚数入力(kBandQty)から
     グループを作って合算する。プリント代は全帯共通の1枚あたり加算 */
  const kSelected = new Set(); // 選択中プリントの t
  let kBandQty = {};           // サイズ帯idx → 枚数
  function calcKratvs() {
    const item = window.QS_KRATVS.items[+el('k-item').value];
    const printList = kratvsPrintList(item);
    const picked = printList.filter((p) => kSelected.has(p.t));

    // セット自動判定(3点→2点の順で1回だけ適用)
    let setApplied = null;
    let rest = [...picked];
    for (const s of window.QS_KRATVS.sets.sort((a, b) => b.count - a.count)) {
      if (s.scope !== item.kind) continue;
      const names = rest.map((p) => p.t);
      if (!s.need.every((n) => names.includes(n))) continue;
      let anyPick = null;
      if (s.any) {
        anyPick = s.any.from.find((n) => names.includes(n));
        if (!anyPick) continue;
      }
      const used = [...s.need, ...(anyPick ? [anyPick] : [])];
      setApplied = { ...s, used };
      rest = rest.filter((p) => !used.includes(p.t));
      break;
    }
    const d = currentDiscount('k');
    let discountNote = '';
    if (d.key === 'staff') discountNote = '社員特価(KRATVSは完成品価格のため一律50%OFFで計算)';
    else if (d.rate > 0) discountNote = `${d.name} ${d.rate}%OFF`;
    const discountUnit = (u) => {
      // 割引後の単価も1円単位の端数が出ないよう10円単位へ切り上げる
      if (d.key === 'staff') return up10(u * 0.5);
      if (d.rate > 0) return up10((u * (100 - d.rate)) / 100);
      return u;
    };

    /* ★KRATVSのカタログだけ税込表記なので、ここで税抜へ戻す。
       他モードは料金表がもともと税抜なので換算しない(換算はこの1か所だけ)。
       換算で出る1円単位の端数は10円単位へ切り上げる */
    const prints = [
      ...(setApplied ? [{ t: setApplied.t, detail: setApplied.used.join('＋'), p: up10(taxOut(setApplied.p)) }] : []),
      ...rest.map((p) => ({ t: p.t, detail: p.size, p: up10(taxOut(p.p)) })),
    ];
    const printBefore = prints.reduce((s, p) => s + p.p, 0);
    const printAfter = prints.reduce((s, p) => s + discountUnit(p.p), 0);

    // サイズ帯ごとのグループ(枚数が入っている帯だけ)。すべて税抜
    const groups = item.price
      .map((band, i) => ({ band, qty: kBandQty[i] || 0 }))
      .filter((b) => b.qty > 0)
      .map(({ band, qty }) => {
        const bodyBefore = up10(taxOut(band.p));
        const bodyAfter = discountUnit(bodyBefore);
        return {
          label: band.size, band, qty, bodyBefore, bodyAfter,
          unitBefore: bodyBefore + printBefore, unitAfter: bodyAfter + printAfter,
        };
      });
    if (!groups.length) return null; // どの帯にも枚数が無い

    const qty = groups.reduce((s, g) => s + g.qty, 0);
    // 見積書の明細: サイズ帯ごとの本体行 → プリント行(1箇所1行・数量は総数)
    const items = groups.map((g) => ({
      kind: 'body', label: `KRATVS ${item.name}`, location: g.label,
      qty: g.qty, unitName: '枚', unitBefore: g.bodyBefore, unit: g.bodyAfter,
    }));
    prints.forEach((p) => {
      items.push({
        // KRATVSのプリントは箇所名ではなく大きさが添え字なので、名前のうしろに括弧で付ける
        kind: 'print', label: `${p.t}(${p.detail})`, location: '',
        qty, unitName: '式', unitBefore: p.p, unit: discountUnit(p.p),
      });
    });

    const bag = baggingUnit();
    const shipping = shippingCost();
    if (bag) items.push({ kind: 'bag', label: bag.name, qty, unitName: '枚', unitBefore: bag.unit, unit: bag.unit });
    if (shipping) items.push({ kind: 'shipping', label: '送料', qty: 1, unitName: '式', unitBefore: shipping, unit: shipping });

    const subtotal = items.reduce((s, x) => s + x.unit * x.qty, 0);
    const tax = taxOf(subtotal);
    const total = subtotal + tax;
    return {
      mode: 'kratvs', qty, item, groups, picked, setApplied, rest, prints, items,
      unitBefore: groups[0].unitBefore, unitAfter: groups[0].unitAfter,
      discount: d, discountNote, bag, shipping,
      initial: 0, subtotal, tax, total,
      perPieceAll: Math.round(subtotal / qty),
    };
  }

  /* ---------- 画面部品 ---------- */
  const el = (id) => document.getElementById(id);

  function currentDiscount(prefix) {
    const key = document.querySelector(`input[name="${prefix === 'k' ? 'k-discount' : 'discount'}"]:checked`).value;
    const d = window.QS_DISCOUNTS.find((x) => x.key === key);
    if (d.key === 'custom') {
      const r = Math.min(90, Math.max(0, parseInt(el(prefix === 'k' ? 'k-custom-rate' : 'custom-rate').value, 10) || 0));
      return { ...d, rate: r, name: `任意${r}%` };
    }
    return d;
  }

  /** 送料(税抜) */
  function shippingCost() {
    const v = el('shipping').value;
    if (v === 's80') return window.QS_COMMON.shipping.s80;
    if (v === 's100') return window.QS_COMMON.shipping.s100;
    return 0;
  }

  /** 袋入れ(共通オプション・税抜)。1枚あたりの実費なので割引対象外 */
  function baggingUnit() {
    const v = el('bagging').value;
    if (v === 'tee') return { name: '袋入れ(Tシャツ)', unit: window.QS_COMMON.bagging.tee };
    if (v === 'sweat') return { name: '袋入れ(スウェット)', unit: window.QS_COMMON.bagging.sweat };
    return null;
  }

  /* ---------- ボディと内訳のUI ----------
     ★入力のたびに全体を作り直すとフォーカスが飛ぶので、文字入力は再描画せずに
       recalc だけ行い、選択肢が変わる操作(品番の変更・色区分の変更)のときだけ
       そのボディの内訳を描き直す */
  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  function addBreakdownRow(b) {
    const data = bodySizeData(b);
    b.breakdown.push({
      id: ++bdSeq,
      variant: data ? data.base[0] : 0,
      sizes: {},        // サイズ名 → 枚数(サイズ表のあるボディ)
      sizeText: '', color: '', qty: 0,
    });
  }

  function renderBodies() {
    const wrap = el('bodies');
    wrap.innerHTML = '';
    bodies.forEach((b, i) => {
      const div = document.createElement('div');
      div.className = 'qs-body-block';
      div.innerHTML = `
        <div class="qs-row-head">
          <span class="qs-row-no">ボディ ${i + 1}</span>
          ${bodies.length > 1 ? `<button type="button" class="btn-icon-remove" data-body-del="${b.id}" aria-label="このボディを削除">✕</button>` : ''}
        </div>
        <label>品番か名前で検索
          <input type="text" data-bo="input" list="body-list" value="${escAttr(b.input)}" placeholder="例: 5982-01">
        </label>
        <label>リストに無い場合の税抜単価
          <input type="number" data-bo="manual" min="0" value="${escAttr(b.manual)}" placeholder="持込・その他のとき">
        </label>
        <label>枚数 <input type="number" data-bo="qty" min="1" value="${escAttr(b.qty)}"></label>
        <p class="qs-note" data-qty-note hidden>内訳を入力中は枚数を自動集計しています(内訳行をすべて消すと手入力に戻ります)。</p>
        <div class="form-label">サイズ・色別の内訳(任意)</div>
        <p class="qs-note">色ごとに1行を足し、その行の中で<b>サイズごとの枚数</b>を入れてください(例: S:2・M:3・L:5)。枚数は自動で合計され、単価はサイズから自動で決まります。</p>
        <div class="qs-bd-wrap" data-bd-wrap></div>
        <button type="button" class="btn btn-secondary btn-small" data-bd-add="${b.id}">＋ 色の行を追加</button>`;
      wrap.appendChild(div);

      div.querySelectorAll('[data-bo]').forEach((input) => {
        const f = input.dataset.bo;
        input.oninput = () => {
          const before = bodySku(b);
          b[f] = input.value;
          if (f === 'input' && bodySku(b) !== before) {
            /* 品番が変わるとサイズの体系も色区分も単価も変わる。入れてあった枚数を
               持ち越すと、新しい品番に無いサイズの枚数が宙に浮いて総数だけ残るので必ず消す */
            const nd = bodySizeData(b);
            b.breakdown.forEach((r) => {
              r.sizes = {};
              r.qty = 0;
              r.variant = nd ? nd.base[0] : 0;
            });
            // 品番が変わるとサイズ帯・色区分の選択肢が変わるので、そのボディの内訳を描き直す
            renderBreakdown(b, div);
            // 加工行の「対象ボディ」に出る品番の表示も古くなるので直す
            // (描き直すのは #rows だけなので、入力中のこの欄からフォーカスは外れない)
            if (bodies.length > 1) renderRows();
          }
          recalc();
        };
      });
      div.querySelector('[data-bd-add]').onclick = () => {
        addBreakdownRow(b); renderBreakdown(b, div); recalc();
      };
      const del = div.querySelector('[data-body-del]');
      if (del) del.onclick = () => {
        const idx = bodies.findIndex((x) => x.id === b.id);
        if (idx >= 0) bodies.splice(idx, 1);
        // 消したボディを対象にしていた加工行の指定を掃除する(空になったら全ボディ扱いへ戻す)
        rows.forEach((r) => {
          if (!r.targets) return;
          r.targets.delete(b.id);
          if (!r.targets.size || r.targets.size === bodies.length) r.targets = null;
        });
        renderBodies(); renderRows(); recalc();
      };
      renderBreakdown(b, div);
    });
  }

  /** 1つのボディの内訳行を描く(block はそのボディのブロック要素) */
  function renderBreakdown(b, block) {
    const wrap = block.querySelector('[data-bd-wrap]');
    const data = bodySizeData(b);
    wrap.innerHTML = '';
    b.breakdown.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'qs-bd-row';
      let head = '';
      let grid = '';
      if (data) {
        const vi = Math.min(r.variant, data.v.length - 1);
        const variant = data.v[vi];
        if (data.v.length > 1) {
          head += `<select data-bf="variant" aria-label="色区分">${data.v.map((v, i) =>
            `<option value="${i}"${i === vi ? ' selected' : ''}>${v.l}</option>`).join('')}</select>`;
        }
        /* サイズごとに枚数を入れる。単価はサイズから自動で決まるので帯を選ぶ必要はない。
           単価が違うサイズが混ざったら、見積書の明細のほうが自動で分かれる */
        grid = `<div class="qs-size-grid">${variantSizes(variant).map((s) => `
          <label class="qs-size-cell"><span class="qs-size-name">${s.size}</span>
          <span class="qs-size-price">${up10(s.price).toLocaleString()}円</span>
          <input type="number" min="0" data-size="${escAttr(s.size)}" value="${r.sizes[s.size] || ''}"
            placeholder="0" aria-label="${escAttr(s.size)}の枚数"></label>`).join('')}</div>`;
      } else {
        head += `<input type="text" data-bf="sizeText" value="${escAttr(r.sizeText)}" placeholder="サイズ(例: L)" aria-label="サイズ">`;
      }
      div.innerHTML = `
        <div class="qs-bd-head">
          ${head}
          <input type="text" data-bf="color" value="${escAttr(r.color)}" placeholder="色(例: 白)" aria-label="色">
          <input type="number" data-bf="qty" min="0" value="${r.qty || ''}" placeholder="枚数" aria-label="枚数"${data ? ' readonly' : ''}>
          <button type="button" class="btn-icon-remove" data-bd-del="${r.id}" aria-label="この内訳行を削除">✕</button>
        </div>
        ${grid}`;
      wrap.appendChild(div);
      div.querySelectorAll('[data-bf]').forEach((input) => {
        const f = input.dataset.bf;
        input.onchange = () => {
          if (f === 'qty') { r.qty = Math.max(0, parseInt(input.value, 10) || 0); syncQtyInput(b, block); }
          else if (f === 'variant') {
            // 色区分でサイズの並びも単価も変わるので、入力済みの枚数は引き継がず開き直す
            r.variant = +input.value;
            r.sizes = {};
            syncRowQty(b, r);
            renderBreakdown(b, block);
          } else r[f] = input.value.trim();
          recalc();
        };
      });
      // サイズ別の枚数。打つそばから行の枚数とボディの総数へ反映する
      div.querySelectorAll('[data-size]').forEach((input) => {
        input.oninput = () => {
          const n = Math.max(0, parseInt(input.value, 10) || 0);
          if (n) r.sizes[input.dataset.size] = n; else delete r.sizes[input.dataset.size];
          syncRowQty(b, r);
          const qtyInput = div.querySelector('[data-bf="qty"]');
          if (qtyInput) qtyInput.value = r.qty || '';
          syncQtyInput(b, block);
          recalc();
        };
      });
      div.querySelector('[data-bd-del]').onclick = () => {
        const idx = b.breakdown.findIndex((x) => x.id === r.id);
        if (idx >= 0) b.breakdown.splice(idx, 1);
        renderBreakdown(b, block); recalc();
      };
    });
    syncQtyInput(b, block);
  }

  /** 内訳が入っている間は、そのボディの枚数入力を自動集計(読み取り専用)にする */
  function syncQtyInput(b, block) {
    const active = b.breakdown.length > 0;
    const input = block.querySelector('[data-bo="qty"]');
    input.readOnly = active;
    if (active) {
      b.qty = b.breakdown.reduce((s, r) => s + r.qty, 0);
      input.value = b.qty;
    }
    block.querySelector('[data-qty-note]').hidden = !active;
  }

  /* ---------- 加工行のUI ---------- */
  function renderRows() {
    const wrap = el('rows');
    wrap.innerHTML = '';
    rows.forEach((row, i) => {
      const div = document.createElement('div');
      div.className = 'qs-row';
      div.innerHTML = `
        <div class="qs-row-head">
          <span class="qs-row-no">加工 ${i + 1}</span>
          <button type="button" class="btn-icon-remove" data-del="${row.id}" aria-label="この加工を削除">✕</button>
        </div>
        <div class="qs-row-body" data-id="${row.id}"></div>`;
      wrap.appendChild(div);
      renderRowBody(row);
    });
    document.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = () => {
        const idx = rows.findIndex((r) => r.id === +b.dataset.del);
        if (idx >= 0) rows.splice(idx, 1);
        renderRows(); recalc();
      };
    });
  }

  function renderRowBody(row) {
    const box = document.querySelector(`.qs-row-body[data-id="${row.id}"]`);
    const sel = (v, t) => `<option value="${v}"${String(row.method) === v ? ' selected' : ''}>${t}</option>`;
    // 八木繊維様の卸表に無い加工(マーキング・刺繍系)は選択肢から外す=個別見積り
    const extraMethods = isYagi() ? ''
      : `${sel('marking', 'マーキング')}${sel('emb', '刺繍')}${sel('cap', '帽子刺繍')}${sel('nameEmb', 'ネーム刺繍(1.5×8cm)')}`;
    let html = `
      <label>箇所(見積書の摘要に出ます)
        <input type="text" data-f="locationName" value="${escAttr(row.locationName)}" placeholder="例: 左胸・背面・両襟">
      </label>
      <label>加工方法
        <select data-f="method">
          ${sel('auto', '自動(シルク/DTFの安い方)')}${sel('silk', 'シルクスクリーン')}${sel('dtf', 'DTF(フルカラー)')}
          ${sel('rubber', 'ラバー転写')}${sel('dtfName', 'DTFネームプリント(登録業者)')}${extraMethods}
        </select>
      </label>`;
    if (['auto', 'silk', 'dtf', 'rubber'].includes(row.method)) {
      const sizes = row.method === 'rubber' ? SIZES_ALL.slice(1) : SIZES_ALL;
      html += `<label>大きさ
        <select data-f="size">${sizes.map((s) => `<option${s === row.size ? ' selected' : ''}>${s}</option>`).join('')}</select>
      </label>`;
      if (row.method !== 'dtf' && row.method !== 'rubber') {
        const maxColors = activeTables().silk.maxColors;
        const colorOpts = [];
        for (let c = 1; c <= maxColors; c++) colorOpts.push(c);
        html += `<label>色数
          <select data-f="colors">${colorOpts.map((c) => `<option value="${c}"${c === row.colors ? ' selected' : ''}>${c}色</option>`).join('')}
          <option value="full"${row.colors === 'full' ? ' selected' : ''}>フルカラー(DTF)</option></select>
        </label>`;
      }
    }
    if (row.method === 'marking') {
      html += `<label>種類
        <select data-f="markKey">${window.QS_MARKING.map((m) => `<option value="${m.key}"${m.key === row.markKey ? ' selected' : ''}>${m.name} ${m.size}</option>`).join('')}</select>
      </label>
      <div class="qs-note">${window.QS_MARKING_NOTE}</div>`;
    }
    if (row.method === 'emb' || row.method === 'cap') {
      const t = window.QS_EMB.normal;
      html += `<label>箇所数
        <select data-f="embPlaces">${Object.keys(t.rows).map((k) => `<option${k === row.embPlaces ? ' selected' : ''}>${k}</option>`).join('')}</select>
      </label>
      <label>加工時間
        <select data-f="embTime"><option${row.embTime === '〜15分' ? ' selected' : ''}>〜15分</option><option${row.embTime === '16〜30分' ? ' selected' : ''}>16〜30分</option></select>
      </label>`;
      if (row.method === 'emb') {
        html += `<label>大きさ
          <select data-f="embSize">${t.sizes.map((s, i) => `<option value="${i}"${i === row.embSize ? ' selected' : ''}>${s}</option>`).join('')}</select>
        </label>`;
      }
      html += `<label class="qs-check"><input type="checkbox" data-patch${row.patch ? ' checked' : ''}>
        ワッペン用資材一式(+税抜${window.QS_EMB.patch.toLocaleString()}円/枚)</label>`;
    }
    /* 追加注文で版・刺繍データが既にあるときは初期費用を外せる。
       初期費用があり得る加工(シルク・刺繍・帽子刺繍と、シルクになりうる自動)だけに出す */
    if (['auto', 'silk', 'emb', 'cap'].includes(row.method)) {
      const initialName = (row.method === 'emb' || row.method === 'cap') ? 'パンチング代' : '製版代';
      html += `<label class="qs-check"><input type="checkbox" data-noinit${row.noInitial ? ' checked' : ''}>
        ${initialName}を含めない(追加注文・データ作成済み)</label>`;
    }

    // 割増オプション(方法に関係するものだけ表示)
    const nylonSheets = ['sheetNylon', 'sheetNylonGold', 'sheetNylonRef'];
    const colorSheets = ['sheetMetallic', 'sheetPearl', 'sheetPearlNeon', 'sheetReflex', 'sheetSilver', 'sheet3M', 'sheetGlow'];
    let surKeys = {
      auto: ['special', 'colorChange', 'bring'], silk: ['special', 'specialInk', 'overlay', 'colorChange', 'bring'],
      dtf: ['special', 'blousonS', 'blousonL', 'bring'],
      rubber: ['special', 'blousonS', 'blousonL', 'bring', ...nylonSheets, ...colorSheets],
      marking: ['special', 'blousonS', 'blousonL', 'bring', ...nylonSheets, ...colorSheets],
      emb: ['embThread', 'embFabric', 'emb3D', 'bring'], cap: ['embThread', 'emb3D', 'bring'],
      nameEmb: ['bring'], dtfName: ['bring'],
    }[row.method] || [];
    // 八木繊維様は持込料サービスなので選択肢ごと出さない
    if (activeTables().bringFree) surKeys = surKeys.filter((k) => k !== 'bring');
    if (surKeys.length) {
      html += `<div class="qs-surcharges">${surKeys.map((k) => `
        <label class="qs-check"><input type="checkbox" data-sur="${k}"${row.surcharges.has(k) ? ' checked' : ''}>
        ${window.QS_SURCHARGE[k].name}(${Math.round((surRate(k) - 1) * 100)}%増)</label>`).join('')}</div>`;
    }
    // 対象ボディ(ボディが2つ以上のときだけ出す)。既定はすべてのボディに載せる
    if (bodies.length > 1) {
      html += `<div class="qs-targets"><span class="form-label">この加工を載せるボディ</span>${bodies.map((b, i) => `
        <label class="qs-check"><input type="checkbox" data-target="${b.id}"${rowAppliesTo(row, b.id) ? ' checked' : ''}>
        ${i + 1}. ${bodyInfo(b).short}</label>`).join('')}</div>`;
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-target]').forEach((cb) => {
      cb.onchange = () => {
        const ids = [...box.querySelectorAll('[data-target]')].filter((x) => x.checked).map((x) => +x.dataset.target);
        if (!ids.length) {
          cb.checked = true;
          HiUI.toast('この加工を載せるボディを1つ以上選んでください');
          return;
        }
        row.targets = ids.length === bodies.length ? null : new Set(ids);
        recalc();
      };
    });
    box.querySelectorAll('[data-f]').forEach((input) => {
      input.onchange = () => {
        const f = input.dataset.f;
        row[f] = (f === 'colors') ? (input.value === 'full' ? 'full' : +input.value)
          : (f === 'embSize') ? +input.value : input.value;
        if (f === 'method') {
          if (row.method === 'rubber' && row.size === 'B8') row.size = 'B7';
          renderRowBody(row);
        }
        recalc();
      };
    });
    // 箇所名は打つそばから転記シートへ反映したい(金額に影響しないので描き直しは起きない)
    const locInput = box.querySelector('[data-f="locationName"]');
    if (locInput) locInput.oninput = () => { row.locationName = locInput.value; recalc(); };
    const noInit = box.querySelector('[data-noinit]');
    if (noInit) noInit.onchange = () => { row.noInitial = noInit.checked; recalc(); };
    box.querySelectorAll('[data-sur]').forEach((cb) => {
      cb.onchange = () => {
        cb.checked ? row.surcharges.add(cb.dataset.sur) : row.surcharges.delete(cb.dataset.sur);
        recalc();
      };
    });
    const patchCb = box.querySelector('[data-patch]');
    if (patchCb) patchCb.onchange = () => { row.patch = patchCb.checked; recalc(); };
  }

  /* ---------- 結果表示 ---------- */
  let lastResult = null;

  function recalc() {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const r = mode === 'kratvs' ? calcKratvs() : calcNormal();
    lastResult = r;
    renderResult(r);
    syncSubject(r);
    // 割引の有無で承認欄の出し入れが変わる。転記シートもここで作り直す
    syncApproval();
  }

  function renderResult(r) {
    const box = el('result');
    if (!r) {
      box.innerHTML = `<p class="empty-notice">サイズ帯ごとの枚数を入力してください。</p>`;
      return;
    }
    if (r.mode !== 'kratvs' && r.quoteOnlyNames.length) {
      // 理由が「価格表の発効前」のものが混ざっていたら、いつから概算が出るかまで出す
      const pending = r.quoteOnlyReasons && r.quoteOnlyReasons.includes('not-effective-yet');
      const why = pending
        ? `価格表の改定中(SLOTHは${window.QS_SLOTH_EFFECTIVE_FROM.replace(/-/g, '/')}から概算が出せます)`
        : '中綿・ナイロン等';
      box.innerHTML = `<p class="empty-notice">${r.quoteOnlyNames.join('・')}は概算対象外(${why})です。個別見積りにしてください。</p>`;
      return;
    }
    const multi = r.groups.length > 1;
    let rowsHtml = '';
    if (r.mode !== 'kratvs') {
      r.groups.forEach((g) => {
        rowsHtml += `<tr><td>ボディ ${g.bodyName}${g.label ? `【${g.label}】` : ''}${multi ? ` × ${g.qty}枚` : ''}</td><td class="qs-num">${yen(g.bodyUnit)}</td></tr>`;
      });
      r.lines.forEach((l) => {
        // 複数ボディのときは、その加工がどのボディに載るかを添える
        const target = r.multiBody ? `<div class="qs-note">対象: ${l.targetNames.join('・') || 'なし'}${l.varies ? '(10枚未満のボディはミニマム手数料で単価が上がります)' : ''}</div>` : '';
        rowsHtml += `<tr><td>${l.label}${l.note ? `<div class="qs-note">${l.note}</div>` : ''}${target}</td><td class="qs-num">${yen(l.unit)}</td></tr>`;
        if (l.initial) rowsHtml += `<tr class="qs-initial"><td>└ ${l.initialLabel}</td><td class="qs-num">${yen(l.initial)}</td></tr>`;
      });
    } else {
      r.groups.forEach((g) => {
        rowsHtml += `<tr><td>${r.item.name}(${g.label})${multi ? ` × ${g.qty}枚` : ''}</td><td class="qs-num">${yen(g.bodyBefore)}</td></tr>`;
      });
      // r.prints は税抜へ戻したあとの値(カタログは税込表記)
      r.prints.forEach((p) => {
        rowsHtml += `<tr><td>${p.t}(${p.detail})</td><td class="qs-num">${yen(p.p)}</td></tr>`;
      });
    }
    if (r.bag) rowsHtml += `<tr><td>${r.bag.name}(割引対象外)</td><td class="qs-num">${yen(r.bag.unit)}</td></tr>`;
    const discountRow = r.discountNote
      ? `<tr class="qs-discount"><td>${r.discountNote}</td><td class="qs-num">${multi ? '下記参照' : `${yen(r.unitAfter)}/枚`}</td></tr>` : '';

    // 1枚あたり。内訳があるときはグループごとに並べる
    const unitHtml = multi
      ? `<div><span>1枚あたり(割引後・税抜)</span><span class="qs-unit-lines">${r.groups.map((g) =>
          `<span class="qs-unit-line">${r.multiBody ? `${g.bodyShort}${g.label ? `・${g.label}` : ''}` : (g.label || '標準')} × ${g.qty}枚: <b>${yen(g.unitAfter)}</b>${g.unitAfter !== g.unitBefore ? `<s>${yen(g.unitBefore)}</s>` : ''}</span>`).join('')}</span></div>`
      : `<div>1枚あたり(割引後・税抜)<b>${yen(r.unitAfter)}</b>${r.discount.rate > 0 || r.discount.key === 'staff' ? `<s>${yen(r.unitBefore)}</s>` : ''}</div>`;

    // 原価・粗利(トグル)。内訳があるときはグループごとの推定仕入で合算する(すべて税抜)
    let costHtml = '';
    if (el('toggle-cost').checked && r.mode !== 'kratvs' && r.groups.some((g) => g.bodyUnit > 0)) {
      const cost = r.groups.reduce((s, g) => s + Math.round(g.bodyUnit * 0.55) * g.qty, 0);
      const profit = r.subtotal - cost - r.shipping - (r.bag ? r.bag.unit * r.qty : 0);
      costHtml = `<div class="qs-cost">
        <b>原価めやす(社外秘)</b> ボディ推定仕入 合計${yen(cost)}(表示価格×0.55・要実額確認)
        → 粗利 ${yen(profit)}(${Math.round(profit / r.subtotal * 100)}%)※加工材料費・人件費は含まず</div>`;
    }

    box.innerHTML = `
      <table class="qs-table"><tbody>${rowsHtml}${discountRow}</tbody></table>
      <div class="qs-summary">
        ${unitHtml}
        ${r.initial ? `<div>初期費用(割引対象外)<b>${yen(r.initial)}</b></div>` : ''}
        ${r.bag ? `<div>${r.bag.name}<b>${yen(r.bag.unit)}/枚</b></div>` : ''}
        ${r.shipping ? `<div>送料<b>${yen(r.shipping)}</b></div>` : ''}
        <div>小計(${r.qty}枚・税抜)<b>${yen(r.subtotal)}</b><span>実質 ${yen(r.perPieceAll)}/枚</span></div>
        <div>消費税(${TAX}%)<b>${yen(r.tax)}</b></div>
        <div class="qs-total">合計(税込)<b>${yen(r.total)}</b></div>
      </div>
      ${costHtml}
      ${r.yagiOver100 ? '<div class="qs-over100">⚠️ 100枚以上は「要相談」です(八木繊維様専用価格表)。この概算は目安として使い、正式には個別にお見積りしてください。</div>' : ''}
      ${r.mode === 'yagi'
        ? '<p class="qs-note">八木繊維様専用価格表(2026-05-01改定)に基づく税抜の概算です。ミニマム手数料なし・持込料サービス・版下データ作成料0円を適用しています。</p>'
        : r.mode === 'kratvs'
          ? '<p class="qs-note">単価はすべて税抜の概算です(消費税は小計に対して加算)。KRATVSは完成品価格のためミニマム手数料はかかりません。</p>'
          : '<p class="qs-note">単価はすべて税抜の概算です(消費税は小計に対して加算)。10枚未満はミニマム手数料(加工代5割増)を自動適用しています。</p>'}`;
  }

  /* ---------- 件名(案件名)の自動生成 ----------
     freeeの一覧で見て分かるように「品名 加工名 数量」で組み立てる
     (2026-08-21 社長指示の「顧客名 品名 加工名 数量」から、顧客名は取引先欄で
      分かるため外した・2026-09-01 社長指示)。
     同じ文面をfreeeの社内メモにも入れる。人が件名欄を直したらそちらを優先する */
  let subjectDirty = false;

  /** 加工名の要約。同じ加工が複数箇所あるときはまとめる */
  function processSummary(r) {
    if (!r) return '';
    if (r.mode === 'kratvs') {
      const prints = [...(r.setApplied ? [r.setApplied.t] : []), ...r.rest.map((p) => p.t)];
      return prints.join('・');
    }
    return [...new Set(r.lines.map((l) => l.short).filter(Boolean))].join('・');
  }

  /** 品名が空のときに使う既定の品名。
      freeeの一覧で長くなりすぎないよう、品番名ではなく種類(Tシャツ/パーカー等)でまとめる */
  function defaultItemName(r) {
    if (!r) return 'オリジナルウェア';
    if (r.mode === 'kratvs') return `KRATVS ${r.item.name}`;
    const cats = [...new Set(r.bodyCalcs.map((bc) => bc.info.cat).filter(Boolean))];
    if (cats.length) return cats.join('＋');
    // 品番リストに無いボディ(持込等)は入力された名前をそのまま使う
    const names = [...new Set(r.bodyCalcs.filter((bc) => !bc.info.none).map((bc) => bc.info.name))];
    return names.length ? names.join('＋') : 'オリジナルウェア';
  }

  function autoSubject(r) {
    const parts = [
      el('item-title').value.trim() || defaultItemName(r),
      processSummary(r),
      r ? `${r.qty}枚` : '',
    ];
    return parts.filter(Boolean).join(' ');
  }

  /** 件名欄を自動生成の内容に合わせる(人が直していれば触らない) */
  function syncSubject(r) {
    if (subjectDirty) return;
    el('subject').value = autoSubject(r);
  }

  /* ---------- freee転記シート ----------
     三浦さん・山本さんは画面を見ながらfreeeへ手入力する。
     久保田さんは同じテキストをClaudeに貼れば /mitsumori で自動入力できる。
     ★人が読める形と機械が読める形を1つの出力で兼ねる(2026-08-20 社長方針) */
  function buildSheet() {
    const r = lastResult;
    if (!r) return null;
    const title = el('item-title').value.trim() || defaultItemName(r);
    const customer = el('customer').value.trim();
    const subject = el('subject').value.trim() || autoSubject(r);
    /* 明細は calcNormal / calcKratvs が作った items(税抜)をそのまま1行=1明細にする。
       ★添付の見積書と同じ並べ方: ボディ行(◯枚) → 加工1箇所ごとの行(◯式) → 初期費用 → 送料
       ★品名(name)は使わず、すべて摘要(desc)に書く。ボディ行も品名(行の見出し)には
         出さず、本体の品番と名称を摘要の頭に入れる(2026-09-01 社長指示) */
    const lines = r.items.map((x) => {
      const bits = [];
      if (x.location) bits.push(x.location);
      if (x.kind === 'print') {
        bits.push(x.label);
        // どのボディへの加工かは、ボディが複数のときだけ添える
        if (r.multiBody && x.bodyShort) bits.push(`対象: ${x.bodyShort}`);
        if (x.minFee) bits.push('※ミニマム手数料込み');
        // 製版代・パンチング代を外した行は、なぜ初期費用が無いのかをお客様に伝える
        if (x.initialWaived && x.waivedNote) bits.push(x.waivedNote);
      } else {
        // ボディ(品番と名称)・初期費用・袋入れ・送料は摘要の頭に書く
        bits.unshift(x.label);
      }
      // 割引が乗った行にだけ「通常価格→割引後」を書く(初期費用・実費は対象外なので出ない)
      if (x.unit !== x.unitBefore) {
        bits.push(r.discount.key === 'staff'
          ? `社員特価(通常価格 ${x.unitBefore.toLocaleString()}円)`
          : `通常価格 ${x.unitBefore.toLocaleString()}円 → 特別割引 ${r.discount.rate}%OFF`);
      }
      return {
        name: '',
        desc: bits.join('　'),
        qty: x.qty, unit: x.unitName, price: x.unit,
      };
    });

    const today = new Date();
    const iso = (d) => d.toLocaleDateString('sv-SE');
    const due = new Date(today.getTime() + 30 * 86400000);

    const notes = ['※表示金額はすべて税抜です。別途消費税を申し受けます。'];
    if (r.mode === 'yagi') {
      notes.push('※八木繊維様専用価格表(2026年5月1日改定)に基づく金額です。');
      if (r.yagiOver100) notes.push('※100枚以上のため要相談です。本見積は目安としてご利用ください。');
    } else {
      notes.push('※納期はデザイン最終確認・ご入金の確認から約2週間です。');
      notes.push('※当社工場でのお受け取りは無料です。ご配送をご希望の場合は別途承ります。');
    }

    return {
      customer, title, subject, qty: r.qty, lines,
      date: iso(today), due: iso(due),
      // 外税なので単価も小計も税抜。total(税込)は画面表示と案件への記録に使う
      subtotal: r.subtotal, tax: r.tax, total: r.total,
      notes,
      discount: r.discount,
    };
  }

  /** 転記シートの文字列。この形のままClaudeが読めるので書式を崩さないこと */
  function sheetText(sh) {
    const L = [];
    L.push('【freee見積書 転記シート】');
    L.push(`取引先  : ${sh.customer || '(未入力)'}`);
    L.push(`件名    : ${sh.subject}`);
    L.push(`見積日  : ${sh.date}　有効期限: ${sh.due}`);
    L.push('税区分  : 外税(単価は税抜)　★freeeの初期値のままでよい');
    L.push('─ 明細 ─');
    sh.lines.forEach((l, i) => {
      L.push(`${i + 1}) 品名 ${l.name || '(なし)'}`);
      L.push(`   摘要 ${l.desc || '(なし)'}`);
      L.push(`   数量 ${l.qty} ${l.unit} ／ 単価 ${l.price.toLocaleString()}円(税抜) → ${(l.price * l.qty).toLocaleString()}円`);
    });
    L.push('─ 合計 ─');
    L.push(`小計 ${sh.subtotal.toLocaleString()}円 ＋ 消費税 ${sh.tax.toLocaleString()}円 ＝ ${sh.total.toLocaleString()}円(税込)`);
    L.push('─ 備考 ─');
    sh.notes.forEach((n) => L.push(n));
    return L.join('\n');
  }

  /** 画面に出す転記シート(見ながらfreeeへ入力してもらう) */
  function renderSheet() {
    const sh = buildSheet();
    const box = el('sheet');
    if (!sh) { box.textContent = ''; return; }
    box.textContent = sheetText(sh);
  }

  el('btn-copy-freee').onclick = () => {
    const sh = buildSheet();
    if (!sh) { HiUI.toast('先に見積内容を入力してください'); return; }
    if (!approvalOk(sh)) return;
    copyText(sheetText(sh));
  };

  /* クリップボードへコピー。本番はLAN内のhttp(非secure context)なので
     navigator.clipboard が使えない。execCommandへフォールバックする */
  function copyText(text) {
    const done = () => HiUI.toast('転記シートをコピーしました。freeeに入力してください');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done));
      return;
    }
    legacyCopy(text, done);
  }
  function legacyCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* 下のフォールバックへ */ }
    ta.remove();
    if (ok) { done(); return; }
    // 最終手段: 選択済みのテキストを見せて手動コピーしてもらう
    window.prompt('自動コピーできませんでした。全選択してコピーしてください', text);
  }

  /* ---------- 割引の社長承認ゲート ----------
     値付けは社長の判断領域。割引を適用した見積は、承認チェックと
     承認者名(誰に確認したか)が入るまでコピー・転記シート出力をさせない。
     ★歯止めは運用ルールではなく画面で担保する(2026-08-20 社長指示) */
  function isDiscounted() {
    const d = currentDiscountForMode();
    return d.key === 'staff' || d.rate > 0;
  }
  function currentDiscountForMode() {
    const mode = currentMode();
    if (mode === 'yagi') return { key: 'none', rate: 0, name: '割引なし' };
    return currentDiscount(mode === 'kratvs' ? 'k' : '');
  }
  function syncApproval() {
    const on = isDiscounted();
    el('approval-box').hidden = !on;
    if (!on) { el('approval-check').checked = false; el('approval-by').value = ''; }
    renderSheet();
  }
  function approvalOk() {
    if (!isDiscounted()) return true;
    if (!el('approval-check').checked) {
      HiUI.toast('割引を適用した見積です。社長の承認チェックを入れてください');
      el('approval-box').scrollIntoView({ block: 'center' });
      return false;
    }
    if (!el('approval-by').value.trim()) {
      HiUI.toast('承認を受けた方のお名前を入力してください');
      el('approval-by').focus();
      return false;
    }
    return true;
  }

  /* ---------- 案件(HiBoard)との連携 ----------
     /quote-sim?case=123 で開くと、案件の取引先名・品名・枚数・プリント箇所
     (箇所数と色数)を自動でセットする。ボディ品番と加工サイズは案件が
     持っていないので人が選ぶ。概算は「案件に記録」で case_quotes へ残し、
     freeeで発行した見積書URLは projects.freee_quote_url へ紐づける */
  let linkedCase = null;

  // 箇所名から加工サイズの初期値を推定する(あくまで初期値。画面で直せる)
  function guessSize(name) {
    const n = String(name || '');
    if (/左胸|胸ポケ|袖|腰/.test(n)) return 'B8';
    if (/背|バック/.test(n)) return 'A3';
    return 'A4';
  }

  async function loadCase(caseId) {
    let data;
    try {
      const resp = await fetch(`/api/projects/${caseId}/quote-context`);
      if (!resp.ok) throw new Error(String(resp.status));
      data = await resp.json();
    } catch (_) {
      HiUI.toast('案件の読み込みに失敗しました。案件と紐づけずに開きます');
      return;
    }
    linkedCase = data.project;
    el('customer').value = linkedCase.customer_name || '';
    el('item-title').value = linkedCase.item_name || linkedCase.project_name || '';
    const q = parseInt(linkedCase.quantity, 10);
    if (q > 0 && bodies.length) {
      bodies[0].qty = q;
      bodies[0].breakdown.length = 0; // 案件の枚数を入れ直すので内訳はリセットする
      renderBodies();
    }

    // プリント箇所 → 加工行。既定の1行を置き換える
    if (data.print_locations.length) {
      rows.length = 0;
      data.print_locations.forEach((loc) => {
        newRow();
        const row = rows[rows.length - 1];
        row.size = guessSize(loc.location_name);
        // 箇所名(左胸・背面など)はそのまま見積書の摘要に出す
        row.locationName = String(loc.location_name || '').trim();
        const c = parseInt(loc.color_count, 10);
        row.colors = (c >= 1 && c <= window.QS_SILK.maxColors) ? c : 'full';
      });
      renderRows();
    }

    // バッジと連携ブロックを表示
    showLinkedCase();
    recalc();
  }

  /** 紐づけ済み案件のバッジ・連携ブロックの出し入れ(loadCase/紐づけのみ の両方から使う) */
  function showLinkedCase() {
    el('case-badge').hidden = false;
    el('case-badge-name').textContent =
      `${linkedCase.customer_name || ''}様「${linkedCase.item_name || linkedCase.project_name}」(案件ID: ${linkedCase.id})`;
    el('case-actions').hidden = false;
    el('case-link').hidden = true;
    if (linkedCase.freee_quote_url) el('freee-url').value = linkedCase.freee_quote_url;
  }

  /* ---------- 案件を検索して紐づける ----------
     案件から開かなくても、あとから案件を選べばfreee発行時のURL・概算の
     自動保存(case_id連携)が効くようにする。「読み込む」を選ぶと従来の
     loadCase と同じく画面へ内容を反映し、「紐づけのみ」は入力を変えない */
  async function searchCases() {
    const q = el('case-search').value.trim();
    const note = el('case-search-note');
    const sel = el('case-search-select');
    if (!q) { note.textContent = '顧客名・案件名・品名の一部を入力して検索してください。'; return; }
    note.textContent = '検索中...';
    sel.hidden = true; el('btn-link-case').hidden = true;
    try {
      const resp = await fetch(`/api/projects/quote-search?q=${encodeURIComponent(q)}`);
      if (!resp.ok) throw new Error(String(resp.status));
      const list = await resp.json();
      if (!list.length) { note.textContent = '該当する案件がありません。'; return; }
      sel.innerHTML = list.map((p) => `<option value="${p.id}">#${p.id} ${p.customer_name || ''}様 ${p.item_name || p.project_name || ''}(${p.quantity || '?'}枚・${p.status || ''})</option>`).join('');
      sel.hidden = false;
      el('btn-link-case').hidden = false;
      note.textContent = `${list.length}件見つかりました。案件を選んで「この案件と紐づける」を押してください。`;
    } catch (_) {
      note.textContent = '検索に失敗しました。時間をおいて試してください。';
    }
  }

  el('case-search-btn').onclick = searchCases;
  el('case-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); searchCases(); }
  });
  el('btn-link-case').onclick = async () => {
    const id = parseInt(el('case-search-select').value, 10);
    if (!id) { HiUI.toast('案件を選んでください'); return; }
    // confirmは「入力済みの内容を上書きするか」の確認。キャンセル=紐づけのみ
    if (window.confirm('案件の内容(顧客名・品名・枚数・プリント箇所)を画面に読み込みますか?\n「キャンセル」でも紐づけは行われ、入力中の内容はそのまま残ります。')) {
      await loadCase(id);
      return;
    }
    try {
      const resp = await fetch(`/api/projects/${id}/quote-context`);
      if (!resp.ok) throw new Error(String(resp.status));
      const data = await resp.json();
      linkedCase = data.project;
      showLinkedCase();
      HiUI.toast('案件と紐づけました。freeeで発行すると見積書URLが自動で保存されます');
    } catch (_) {
      HiUI.toast('案件の読み込みに失敗しました');
    }
  };

  el('btn-save-quote').onclick = async () => {
    if (!linkedCase) return;
    const sh = buildSheet();
    if (!sh) { HiUI.toast('先に見積内容を入力してください'); return; }
    if (!approvalOk(sh)) return;
    const d = currentDiscountForMode();
    try {
      const resp = await fetch(`/api/projects/${linkedCase.id}/quotes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sheet_text: sheetText(sh),
          total: sh.total,
          discount_name: (d.key === 'none') ? null : d.name,
          approved_by: el('approval-by').value.trim() || null,
        }),
      });
      const result = await resp.json();
      if (!resp.ok || !result.ok) throw new Error(result.error || '保存に失敗しました');
      HiUI.toast('概算を案件に記録しました(案件詳細の「概算の履歴」から見返せます)');
    } catch (err) {
      HiUI.toast(`記録できませんでした: ${err.message}`);
    }
  };

  el('btn-save-freee-url').onclick = async () => {
    if (!linkedCase) return;
    try {
      const resp = await fetch(`/api/projects/${linkedCase.id}/freee-quote-url`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: el('freee-url').value }),
      });
      const result = await resp.json();
      if (!resp.ok || !result.ok) throw new Error(result.error || '保存に失敗しました');
      HiUI.toast(el('freee-url').value.trim()
        ? '見積書URLを案件に紐づけました(顧客台帳・納品履歴から開けます)'
        : '見積書URLをクリアしました');
    } catch (err) {
      HiUI.toast(`保存できませんでした: ${err.message}`);
    }
  };

  /* ---------- freeeへの見積書発行 ----------
     ★freeeのAPIには「下書き」が無く、発行した時点で見積書番号が採番される。
     取り消しはできても番号は戻らないので、内容の確認は必ず発行前(モーダル)で行う。
     freeeが未連携・障害中でも、転記シートの手入力に切り替えられるようにしておく */
  let freeePartners = [];
  let freeeState = 'unknown';

  async function loadFreeeStatus() {
    const note = el('freee-status-note');
    try {
      const resp = await fetch('/api/freee/status');
      const st = await resp.json();
      freeeState = st.state;
      if (st.state === 'ready') { note.hidden = true; return; }
      note.hidden = false;
      note.textContent = st.state === 'unconfigured'
        ? '⚠️ freee連携が未設定です。転記シートをコピーして手入力してください(設定は社長へ)。'
        : '⚠️ freeeと未連携です。「freeeに見積書を作成」を押すと連携をご案内します。';
    } catch (_) {
      note.hidden = true; // 状態が取れないだけなら黙って通す(発行時に改めて出る)
    }
  }

  /** 未連携のときの案内。認可はfreeeの画面で行う(パスワードはHiBoardに入力しない) */
  function askFreeeAuth(message) {
    HiUI.toast(message || 'freeeとの連携が必要です');
    if (window.confirm('freeeとの連携が必要です。freeeの認可画面を開きますか?')) {
      window.open('/api/freee/authorize', '_blank');
    }
  }

  el('btn-create-freee').onclick = async () => {
    const sh = buildSheet();
    if (!sh) { HiUI.toast('先に見積内容を入力してください'); return; }
    if (!approvalOk(sh)) return;
    if (!sh.customer) { HiUI.toast('取引先名を入力してください'); return; }

    // 連携できない状態でモーダルを開いても何もできない。手入力へ案内して止める
    await loadFreeeStatus();
    if (freeeState === 'unconfigured') {
      HiUI.toast('freee連携が未設定です。転記シートをコピーして手入力してください');
      return;
    }
    if (freeeState === 'unauthorized') { askFreeeAuth(); return; }

    el('freee-preview').textContent = sheetText(sh);
    el('freee-partner-search').value = sh.customer;
    el('freee-display-name').value = sh.customer;
    el('freee-partner-select').innerHTML = '';
    el('freee-partner-note').textContent = '';
    el('freee-modal').style.display = 'flex';
    await searchFreeePartners(sh.customer);
  };

  async function searchFreeePartners(keyword) {
    const note = el('freee-partner-note');
    const sel = el('freee-partner-select');
    note.textContent = '検索中...';
    sel.innerHTML = '';
    try {
      const resp = await fetch(`/api/freee/partners?keyword=${encodeURIComponent(keyword)}`);
      const data = await resp.json();
      if (!data.ok) {
        // ここでは確認ダイアログを出さない(発行ボタン側で案内済み。二重に出すとうるさい)
        note.textContent = data.error || '取引先を取得できませんでした';
        return;
      }
      freeePartners = data.partners || [];
      if (!freeePartners.length) {
        note.textContent = '該当する取引先がありません。別の名前で検索するか、freeeで取引先を登録してください。';
        return;
      }
      freeePartners.forEach((p) => {
        const o = document.createElement('option');
        o.value = String(p.id);
        o.textContent = p.name;
        sel.appendChild(o);
      });
      // 前に選んだ取引先を覚えていればそれを初期選択にする
      const linkedId = data.linked && data.linked.partner_id;
      const preselect = linkedId && freeePartners.some((p) => p.id === linkedId) ? linkedId : freeePartners[0].id;
      sel.value = String(preselect);
      note.textContent = linkedId
        ? '前回この顧客で選んだ取引先を選択しています。'
        : `${freeePartners.length}件見つかりました。発行先を選んでください。`;
      if (data.linked && data.linked.display_name) el('freee-display-name').value = data.linked.display_name;
    } catch (err) {
      note.textContent = `取引先を取得できませんでした: ${err.message}`;
    }
  }

  el('freee-partner-search-btn').onclick = () => {
    searchFreeePartners(el('freee-partner-search').value.trim());
  };

  function closeFreeeModal() { el('freee-modal').style.display = 'none'; }

  /** 発行した見積書へのリンクを画面に残す(案件と紐づいていなくても辿れるように) */
  function showIssuedLink(q, blocked) {
    const box = el('freee-issued');
    box.hidden = false;
    box.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = blocked
      ? `✅ 見積書 No. ${q.quotation_number} を発行しました(タブが開けませんでした): `
      : `✅ 見積書 No. ${q.quotation_number} を発行しました: `;
    const a = document.createElement('a');
    a.href = q.report_url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'freeeで開く';
    box.append(label, a);
  }
  el('freee-modal-close').onclick = closeFreeeModal;
  el('freee-cancel').onclick = closeFreeeModal;

  el('freee-submit').onclick = async () => {
    const sh = buildSheet();
    if (!sh) { HiUI.toast('見積内容を読み直せませんでした'); return; }
    const partnerId = parseInt(el('freee-partner-select').value, 10);
    const partner = freeePartners.find((p) => p.id === partnerId);
    if (!partner) { HiUI.toast('freeeの取引先を選んでください'); return; }

    const btn = el('freee-submit');
    btn.disabled = true;
    btn.textContent = '発行中...';
    try {
      const d = currentDiscountForMode();
      const resp = await fetch('/api/freee/quotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sheet: sh,
          partner: { id: partner.id, name: partner.name, display_name: el('freee-display-name').value.trim() || null },
          case_id: linkedCase ? linkedCase.id : null,
          sheet_text: sheetText(sh),
          discount_name: (d.key === 'none') ? null : d.name,
          approved_by: el('approval-by').value.trim() || null,
        }),
      });
      const data = await resp.json();
      if (!data.ok) {
        if (data.need_auth) askFreeeAuth(data.error);
        else HiUI.toast(`発行できませんでした: ${data.error}`);
        return;
      }
      closeFreeeModal();
      const q = data.quotation;
      HiUI.toast(data.warning || `見積書を発行しました(No. ${q.quotation_number})`);
      if (q.report_url) {
        el('freee-url').value = q.report_url;
        // ★window.open は await のあとなのでポップアップブロックされることがある。
        //   開けなかったときのために、画面にもリンクを残す(案件未紐づけだと
        //   #freee-url は hidden の中にあり、URLがどこにも見えなくなるため)
        const opened = window.open(q.report_url, '_blank');
        showIssuedLink(q, !opened);
      }
    } catch (err) {
      // ★ここに来ても発行済みの可能性がある(送信後に通信が切れた等)。
      //   「もう一度押す」と二重発行になるので、必ずfreeeの確認を促す
      HiUI.toast(`発行の結果を確認できませんでした: ${err.message}。`
        + 'freeeの見積書一覧を確認してください(出来ていたら押し直さないでください)');
    } finally {
      btn.disabled = false;
      btn.textContent = 'この内容で発行する';
    }
  };

  /* ---------- 初期化 ---------- */
  function setupBodyList() {
    const dl = el('body-list');
    window.QS_BODIES.forEach((b) => {
      const o = document.createElement('option');
      o.value = `${b.sku} ${b.name}`;
      // 見積書の単価(10円単位へ切り上げ)と表示を揃える
      o.label = `${b.cat} / 税抜${up10(b.body).toLocaleString()}円${window.QS_isQuoteOnly(b) ? '(個別見積り)' : ''}`;
      dl.appendChild(o);
    });
  }

  function setupKratvs() {
    const k = window.QS_KRATVS;
    el('k-item').innerHTML = k.items.map((it, i) => `<option value="${i}">${it.code} ${it.name}</option>`).join('');
    const syncSizes = () => {
      const it = k.items[+el('k-item').value];
      // サイズ帯ごとの枚数入力。単価が帯で違うため、総数ではなく帯別に入れてもらう
      el('k-bands').innerHTML = it.price.map((p, i) => `
        <label class="qs-kband">${p.size}(税抜${up10(taxOut(p.p)).toLocaleString()}円)
        <input type="number" min="0" data-kb="${i}" value="${kBandQty[i] || ''}" placeholder="0"></label>`).join('');
      el('k-bands').querySelectorAll('[data-kb]').forEach((inp) => {
        inp.oninput = () => { kBandQty[+inp.dataset.kb] = Math.max(0, parseInt(inp.value, 10) || 0); recalc(); };
      });
      const list = kratvsPrintList(it);
      el('k-prints').innerHTML = list.map((p) => `
        <label class="qs-check"><input type="checkbox" data-kp="${p.t}"${kSelected.has(p.t) ? ' checked' : ''}>
        ${p.t}(${p.size})+税抜${up10(taxOut(p.p)).toLocaleString()}円</label>`).join('');
      el('k-prints').querySelectorAll('[data-kp]').forEach((cb) => {
        cb.onchange = () => { cb.checked ? kSelected.add(cb.dataset.kp) : kSelected.delete(cb.dataset.kp); recalc(); };
      });
    };
    // 帯を選ぶ前でも概算が出るよう、最初の帯に既定の15枚を入れておく(従来の初期値と同じ)
    kBandQty = { 0: 15 };
    el('k-item').onchange = () => { kSelected.clear(); kBandQty = { 0: 15 }; syncSizes(); recalc(); };
    syncSizes();
  }

  function setupDiscounts(name, boxId, customId) {
    el(boxId).innerHTML = window.QS_DISCOUNTS.map((d, i) => `
      <label class="qs-check qs-discount-opt"><input type="radio" name="${name}" value="${d.key}"${i === 0 ? ' checked' : ''}>
      ${d.name}${d.rate > 0 ? `(${d.rate}%)` : ''}</label>`).join('') +
      `<input type="number" id="${customId}" min="0" max="90" value="15" aria-label="任意の割引率(%)" class="qs-custom-rate">%`;
    document.querySelectorAll(`input[name="${name}"]`).forEach((r) => { r.onchange = recalc; });
    el(customId).oninput = recalc;
  }

  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.onchange = () => {
      if (!r.checked) return;
      const mode = r.value;
      // 通常加工と八木繊維様は同じフォーム(panel-normal)を共有する
      el('panel-normal').hidden = mode === 'kratvs';
      el('panel-kratvs').hidden = mode !== 'kratvs';
      // 割引ブロックは八木繊維様では出さない(卸価格自体が特別価格)
      el('discount-block').hidden = mode === 'yagi';
      if (mode === 'yagi') {
        // 卸表に無い加工・色数の行はDTF系へ寄せる(選択肢からも消えるため)
        rows.forEach((row) => {
          if (['marking', 'emb', 'cap', 'nameEmb'].includes(row.method)) row.method = 'auto';
          if (row.colors !== 'full' && row.colors > window.QS_YAGI.silk.maxColors) row.colors = 'full';
        });
        if (!el('customer').value.trim()) el('customer').value = '八木繊維';
      }
      renderRows();
      recalc();
    };
  });

  ['shipping', 'customer', 'item-title'].forEach((id) => {
    el(id).addEventListener('input', recalc);
  });
  el('bagging').onchange = recalc;
  el('opt-express').onchange = recalc;
  el('toggle-cost').onchange = recalc;
  el('btn-add-row').onclick = () => { newRow(); renderRows(); recalc(); };
  // ボディを足すと、加工行に「どのボディに載せるか」の選択が出る
  el('btn-add-body').onclick = () => { newBody(); renderBodies(); renderRows(); recalc(); };

  // 件名は自動生成。人が書き換えたらそれを優先し、ボタンで自動生成に戻せる
  el('subject').addEventListener('input', () => { subjectDirty = true; });
  el('btn-subject-auto').onclick = () => { subjectDirty = false; syncSubject(lastResult); renderSheet(); };

  setupBodyList();
  setupKratvs();
  setupDiscounts('discount', 'discounts', 'custom-rate');
  setupDiscounts('k-discount', 'k-discounts', 'k-custom-rate');
  newBody();
  renderBodies();
  newRow();
  renderRows();
  recalc();

  loadFreeeStatus();

  const caseId = new URLSearchParams(location.search).get('case');
  if (caseId && /^\d+$/.test(caseId)) loadCase(caseId);
})();
