/**
 * サイズ帯 → 個別サイズへの展開を全品番で検証する
 *
 *   node scripts/check-size-expansion.js
 *
 * 見積シミュレーターは価格表の「帯」(S〜XL・2XL・3XL など)を個別サイズへ開いて、
 * サイズごとの枚数を入れてもらう(2026-08-25)。この展開が成り立つ前提は2つある。
 *
 *   ① 帯のラベルを個別サイズへ開けること
 *   ② **同じサイズが1つの色区分の中で2つの帯に出ないこと**
 *      (出てしまうと、そのサイズの単価がどちらか決まらない)
 *
 * ボディの価格データ(quote-sim-data.js の QS_BODY_SIZES)を作り直したら、
 * このスクリプトを流して②が0件のままであることを必ず確かめること。
 * ①は開けなくても安全側に倒れる(ラベルのまま1つの選択肢になる)ので、
 * 増えていないかの確認でよい。
 *
 * ★展開のロジックは public/js/quote-sim.js の expandBand と同じもの。
 *   片方だけ直すと画面と検証がずれるので、変えるときは両方直す。
 */

const path = require('path');

const SIZE_FAMILIES = [
  ['70', '80', '90', '100', '110', '120', '130', '140', '150', '160'], // 子供(cm)
  ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'],      // アルファ
  ['SS', 'S', 'M', 'L', 'LL', '3L', '4L', '5L', '6L', '7L'],           // 日本式
  ['WS', 'WM', 'WL'],                                                   // レディース
];

function normSize(s) {
  let t = String(s).trim().replace(/cm$/i, '');
  const x = t.match(/^(X{2,})L$/i);
  if (x) t = `${x[1].length}XL`;
  return t;
}

function expandRange(a, b) {
  const from = normSize(a), to = normSize(b);
  for (const fam of SIZE_FAMILIES) {
    const i = fam.indexOf(from), j = fam.indexOf(to);
    if (i >= 0 && j >= 0 && i <= j) return fam.slice(i, j + 1);
  }
  return null;
}

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

/* ---- 検証 ---- */
global.window = {};
require(path.join(__dirname, '..', 'public', 'js', 'quote-sim-data.js'));
const SIZES = global.window.QS_BODY_SIZES;
const BODIES = global.window.QS_BODIES;

const labels = new Set();
Object.values(SIZES).forEach((d) => d.v.forEach((v) => v.b.forEach((b) => labels.add(b[0]))));

const unexpanded = [];
[...labels].sort().forEach((l) => {
  const r = expandBand(l);
  if (l.includes('〜') && r.length === 1 && r[0] === l) unexpanded.push(l);
});

const dups = [];
Object.entries(SIZES).forEach(([sku, d]) => {
  d.v.forEach((v) => {
    const seen = new Map();
    v.b.forEach((band) => expandBand(band[0]).forEach((s) => {
      if (seen.has(s)) {
        const name = (BODIES.find((x) => x.sku === sku) || {}).name || '?';
        dups.push(`${sku} ${name} / 色区分:${v.l || 'なし'} / ${s} が「${seen.get(s)}」と「${band[0]}」の両方に`);
      } else seen.set(s, band[0]);
    }));
  });
});

console.log(`帯のラベル: ${labels.size}種類`);
console.log(`① 展開できなかった範囲: ${unexpanded.length}件${unexpanded.length ? ` → ${unexpanded.join(' / ')}` : ''}`);
console.log('   (展開できなくても安全。ラベルのまま1つの選択肢になる)');
console.log(`② 同一色区分でのサイズ重複: ${dups.length}件`);
dups.forEach((d) => console.log(`   ★${d}`));

if (dups.length) {
  console.error('\n★②が0件ではありません。サイズから単価が一意に決まらないため、');
  console.error('  quote-sim.js の variantSizes は先に出た帯を採用します(意図しない単価になりえます)。');
  console.error('  価格データか展開ロジックを見直してください。');
  process.exit(1);
}
console.log('\nOK: サイズを決めれば単価が一意に決まる状態です。');
