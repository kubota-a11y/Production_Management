// NAS → Googleドライブ共有ドライブ 移行用。DBに保存された絶対パスの先頭部分を一括で置き換える。
//
// 使い方(本番Windows機で、サーバーを止めてから実行する):
//   1) node scripts/migrate-storage-path.js --scan
//        → 今DBに入っているパスの「ルート部分」と件数を表示する。--from に何を渡すかはこれで決める
//   2) node scripts/migrate-storage-path.js --from "Z:\DESIGN" --to "G:\共有ドライブ\○○\DESIGN"
//        → 既定はドライラン。何件書き換わるかを表示するだけでDBは変更しない
//   3) 同じコマンドに --apply を付けて実行 → バックアップを取ってから実際に書き換える
//
// 保存先が複数ある場合(Z:ドライブ形式とUNC形式が混在している等)は、--from を変えて複数回実行する。
//
// 顧客名がフォルダ名に含まれるため、このスクリプトは個々のパスを画面に出さない。
// 表示するのは「ルート部分」と件数のみ(CLAUDE.md の顧客データを出力しないルールに従う)。
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { BACKUP_DIR } = require('../lib/db-backup');

const dbPath = path.join(__dirname, '..', 'db', 'projects.db');

// 置き換え対象。mode の意味:
//   prefix   … 値そのものが絶対パス。先頭一致したときだけ置き換える
//   embedded … 人が読む文章の中にパスが埋まっている。文字列中のどこにあっても置き換える
//   json     … JSONの中の文字列値としてパスが入っている。パースして文字列値だけを置き換える
const TARGETS = [
  { table: 'projects',            column: 'nas_folder_path', mode: 'prefix',   label: '案件のフォルダ' },
  { table: 'line_messages',       column: 'image_path',      mode: 'prefix',   label: 'LINE受信画像' },
  { table: 'ai_extracted_intake', column: 'reference_link',  mode: 'prefix',   label: '受注候補の代表画像' },
  { table: 'ai_extracted_intake', column: 'notes',           mode: 'embedded', label: '受注候補の要約文(保存先の記載)' },
  { table: 'ai_extracted_intake', column: 'raw_ai_response', mode: 'json',     label: '受注候補の明細JSON(画像パス)' },
];

// ---- 引数 ----
function parseArgs(argv) {
  const out = { scan: false, apply: false, from: '', to: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scan') out.scan = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--from') out.from = argv[++i] || '';
    else if (a === '--to') out.to = argv[++i] || '';
    else if (a === '--dry-run') { /* 既定の動作。明示されても何もしない */ }
    else {
      console.error(`不明なオプション: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

// 末尾の区切り文字を落とす。"Z:\DESIGN\" と "Z:\DESIGN" を同じものとして扱うため
function trimTrailingSep(p) {
  return p.replace(/[\\/]+$/, '');
}

// Windowsはパスの大文字小文字を区別しないため、比較は小文字化して行う
function norm(s) {
  return s.toLowerCase();
}

// パスの「ルート部分」だけを取り出す。フォルダ名に顧客名が入るため、
// これより深い階層は表示にも集計にも使わない。
//   Z:\DESIGN\2026\○○高校        → Z:\DESIGN
//   \\192.168.1.25\disk1\DESIGN\… → \\192.168.1.25\disk1\DESIGN
function rootOf(p) {
  const s = String(p).replace(/\//g, '\\');
  const unc = s.match(/^(\\\\[^\\]+\\[^\\]+\\[^\\]+)/);
  if (unc) return unc[1];
  const drive = s.match(/^([A-Za-z]:\\[^\\]+)/);
  if (drive) return drive[1];
  const posix = String(p).match(/^(\/[^/]+\/[^/]+)/); // 開発機(mac)のフォールバック用
  if (posix) return posix[1];
  return s.split('\\')[0] || '(空)';
}

// ---- 置き換えロジック ----
function replacePrefix(value, from, to) {
  if (typeof value !== 'string' || !value) return null;
  if (!norm(value).startsWith(norm(from))) return null;
  return to + value.slice(from.length);
}

function replaceEmbedded(value, from, to) {
  if (typeof value !== 'string' || !value) return null;
  const lower = norm(value);
  const needle = norm(from);
  if (!lower.includes(needle)) return null;
  let out = '';
  let i = 0;
  while (i < value.length) {
    const hit = lower.indexOf(needle, i);
    if (hit === -1) { out += value.slice(i); break; }
    out += value.slice(i, hit) + to;
    i = hit + from.length;
  }
  return out;
}

// JSONを再帰的に walk して、文字列値の中のパスだけ差し替える。
// 文字列としてそのまま置換すると、JSON内でエスケープされたバックスラッシュ(\\)と
// 噛み合わず取りこぼすため、必ずパースしてから扱う。
function replaceInJson(value, from, to) {
  if (typeof value !== 'string' || !value) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    // JSONとして読めない場合は安全側に倒して手を付けない(件数だけ後で報告する)
    return undefined;
  }
  let changed = false;
  const walk = (node) => {
    if (typeof node === 'string') {
      const replaced = replaceEmbedded(node, from, to);
      if (replaced !== null) { changed = true; return replaced; }
      return node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const next = {};
      for (const [k, v] of Object.entries(node)) next[k] = walk(v);
      return next;
    }
    return node;
  };
  const result = walk(parsed);
  if (!changed) return null;
  return JSON.stringify(result);
}

function computeNewValue(mode, value, from, to) {
  if (mode === 'prefix') return replacePrefix(value, from, to);
  if (mode === 'embedded') return replaceEmbedded(value, from, to);
  if (mode === 'json') return replaceInJson(value, from, to);
  throw new Error(`未知のmode: ${mode}`);
}

// ---- テーブル/カラムの存在確認 ----
function columnExists(db, table, column) {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).all(table);
  if (tables.length === 0) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

// ---- --scan ----
function runScan(db) {
  console.log('DBに保存されているパスのルート部分と件数:\n');
  let total = 0;
  for (const t of TARGETS) {
    if (!columnExists(db, t.table, t.column)) {
      console.log(`  [${t.label}] ${t.table}.${t.column} — カラムなし(スキップ)`);
      continue;
    }
    // notes / raw_ai_response は文章やJSONなので、ルート集計の対象は実パスのカラムだけにする
    if (t.mode !== 'prefix') continue;
    const rows = db.prepare(
      `SELECT ${t.column} AS v FROM ${t.table} WHERE ${t.column} IS NOT NULL AND ${t.column} <> ''`
    ).all();
    const counts = new Map();
    for (const r of rows) {
      const root = rootOf(r.v);
      counts.set(root, (counts.get(root) || 0) + 1);
    }
    console.log(`  [${t.label}] ${t.table}.${t.column} — ${rows.length}件`);
    if (rows.length === 0) console.log('      (なし)');
    for (const [root, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${root}  … ${n}件`);
    }
    total += rows.length;
    console.log('');
  }
  console.log(`合計 ${total}件のパスが保存されています。`);
  console.log('上の「ルート部分」をそのまま --from に渡してください。');
  console.log('大文字小文字の違い(Z:\\DESIGN と z:\\design 等)は置き換え時に吸収されるため、');
  console.log('どちらか一方を渡せば両方が対象になります。ルートが複数ある場合は --from を変えて複数回実行してください。');
}

// ---- 置き換え本体 ----
function runReplace(db, { from, to, apply }) {
  const summary = [];
  let grandTotal = 0;
  let unparsable = 0;

  const work = () => {
    for (const t of TARGETS) {
      if (!columnExists(db, t.table, t.column)) {
        summary.push({ label: t.label, target: `${t.table}.${t.column}`, count: 0, note: 'カラムなし' });
        continue;
      }
      const rows = db.prepare(
        `SELECT rowid AS _rowid, ${t.column} AS v FROM ${t.table} WHERE ${t.column} IS NOT NULL AND ${t.column} <> ''`
      ).all();
      const update = db.prepare(`UPDATE ${t.table} SET ${t.column} = ? WHERE rowid = ?`);
      let count = 0;
      for (const r of rows) {
        const next = computeNewValue(t.mode, r.v, from, to);
        if (next === undefined) { unparsable++; continue; } // JSONとして読めなかった行
        if (next === null) continue;                        // 一致しなかった行
        count++;
        if (apply) update.run(next, r._rowid);
      }
      summary.push({ label: t.label, target: `${t.table}.${t.column}`, count });
      grandTotal += count;
    }
  };

  if (apply) db.transaction(work)();
  else work();

  console.log(`置き換え元: ${from}`);
  console.log(`置き換え先: ${to}\n`);
  for (const s of summary) {
    const note = s.note ? ` (${s.note})` : '';
    console.log(`  [${s.label}] ${s.target} — ${s.count}件${note}`);
  }
  if (unparsable > 0) {
    console.log(`\n  ※ JSONとして読めず手を付けなかった行が ${unparsable}件あります(想定内。元のまま残ります)`);
  }
  console.log(`\n対象合計: ${grandTotal}件`);
  if (grandTotal === 0) {
    console.log('\n⚠ 一致する行が1件もありませんでした。--from の指定が --scan の出力と一致しているか確認してください。');
    console.log('  (Windowsのコマンドプロンプトではパスを "" で囲み、バックスラッシュはそのまま書きます)');
  }
  return grandTotal;
}

async function backupDb() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const dest = path.join(BACKUP_DIR, `projects_manual_before-path-migration_${stamp}.db`);
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  return dest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(dbPath)) {
    console.error(`DBファイルが見つかりません: ${dbPath}`);
    process.exit(1);
  }

  if (args.scan) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { runScan(db); } finally { db.close(); }
    return;
  }

  const from = trimTrailingSep(args.from);
  const to = trimTrailingSep(args.to);
  if (!from || !to) {
    console.error('--from と --to の両方を指定してください(まず --scan で現在の状態を確認)。');
    console.error('例: node scripts/migrate-storage-path.js --from "Z:\\DESIGN" --to "G:\\共有ドライブ\\○○\\DESIGN"');
    process.exit(1);
  }
  if (norm(from) === norm(to)) {
    console.error('--from と --to が同じです。');
    process.exit(1);
  }

  if (!args.apply) {
    console.log('=== ドライラン(DBは変更しません) ===\n');
    const n = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { runReplace(n, { from, to, apply: false }); } finally { n.close(); }
    console.log('\n内容に問題がなければ、同じコマンドに --apply を付けて実行してください。');
    return;
  }

  const backupPath = await backupDb();
  console.log(`実行前のバックアップを保存しました: ${backupPath}\n`);
  console.log('=== 書き換えを実行します ===\n');
  const db = new Database(dbPath, { fileMustExist: true });
  let changed = 0;
  try {
    changed = runReplace(db, { from, to, apply: true });
  } finally {
    db.close();
  }
  console.log(`\n完了しました(${changed}件を書き換え)。`);
  console.log('元に戻す場合は、上のバックアップファイルを db/projects.db に戻してください。');
}

main().catch(err => {
  console.error('処理に失敗しました:', err);
  process.exit(1);
});
