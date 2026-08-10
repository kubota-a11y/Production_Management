const fs = require('fs');
const path = require('path');

// 自動バックアップの保存先と世代管理の設定。
// 自動分(projects_auto_*)のみローテーション対象とし、手動バックアップは削除しない。
const BACKUP_DIR = path.join(__dirname, '..', 'db', 'backups');
const AUTO_PREFIX = 'projects_auto_';
const KEEP_COUNT = 30;

// 直近の実行結果の記録先。「なぜコピーできなかったのか」を後から確認するために残す。
// 状態画面(/api/backup-status)はこれと実ファイルの両方を見る。
const STATUS_FILE = path.join(BACKUP_DIR, 'backup-status.json');

// 追加保存先。.env の DB_BACKUP_EXTRA_DIR に**カンマ区切りで複数**指定できる。
// 本番の想定は「NAS(社内の別マシン) + Google共有ドライブ(社外)」の2か所。
// 社内だけに置くとランサムウェアや火災で本体もろとも失うため、社外にも1本持たせる。
// 従来どおり1か所だけを書いた設定もそのまま動く。
function getExtraDirs() {
  return (process.env.DB_BACKUP_EXTRA_DIR || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function localDateStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 途中で落ちた場合に壊れたファイルが正規名で残らないよう、一時名で作ってからrenameする。
// Googleドライブ等の同期フォルダが「書きかけのファイル」を先に吸い上げてしまうのも防げる。
function copyAtomic(src, dest) {
  const tmp = `${dest}.tmp`;
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
  } catch (err) {
    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch (_) { /* 後片付けの失敗で本体のエラーを覆い隠さない */ }
    }
    throw err;
  }
}

function writeStatus(status) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (err) {
    console.error('[バックアップ] 状態ファイルの書き込みに失敗:', err.message);
  }
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch (_) {
    return null; // 未実行・読めない場合は「記録なし」として扱う
  }
}

// 当日分の自動バックアップがまだ無ければ作成する。
// better-sqlite3のbackup APIはサーバー稼働中(書き込み中)でも一貫性のあるコピーを作れる。
// 作成した場合はバックアップファイルのパスを、スキップした場合はnullを返す。
async function backupIfNeeded(db) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const fileName = `${AUTO_PREFIX}${localDateStamp()}.db`;
  const dest = path.join(BACKUP_DIR, fileName);
  if (fs.existsSync(dest)) return null;

  const tmp = `${dest}.tmp`;
  try {
    await db.backup(tmp);
    fs.renameSync(tmp, dest);
  } catch (err) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    // 本体が作れなかったこと自体を記録に残す(黙って失敗させない)
    writeStatus({
      ranAt: new Date().toISOString(),
      date: localDateStamp(),
      fileName,
      primary: { dir: BACKUP_DIR, ok: false, error: err.message },
      extras: getExtraDirs().map((dir) => ({ dir, ok: false, error: '本体の作成に失敗したためコピーしていません' })),
    });
    throw err;
  }

  // 追加保存先へ横展開する。1か所が失敗しても他は続行する
  // (NASが一時的に見えなくてもGoogle共有ドライブ側は残す、が狙い)。
  const extras = getExtraDirs().map((dir) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      copyAtomic(dest, path.join(dir, fileName));
      cleanupOldAutoBackups(dir);
      return { dir, ok: true, error: null };
    } catch (err) {
      console.error(`[バックアップ] 追加保存先(${dir})へのコピーに失敗:`, err.message);
      return { dir, ok: false, error: err.message };
    }
  });

  cleanupOldAutoBackups(BACKUP_DIR);

  writeStatus({
    ranAt: new Date().toISOString(),
    date: localDateStamp(),
    fileName,
    primary: { dir: BACKUP_DIR, ok: true, error: null },
    extras,
  });

  const failed = extras.filter((e) => !e.ok);
  if (failed.length > 0) {
    console.error(`[バックアップ] ⚠ ${failed.length}/${extras.length} 件の追加保存先に保存できませんでした。`
      + ' 画面の「バックアップ状態」で確認してください');
  }
  return dest;
}

// dir内の自動バックアップ(projects_auto_*)をKEEP_COUNT世代までに間引く。
// 追加保存先にも同じ世代管理を適用する(以前はNAS側が無限に増え続けた)
function cleanupOldAutoBackups(dir) {
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith(AUTO_PREFIX) && f.endsWith('.db'))
    .sort();
  while (files.length > KEEP_COUNT) {
    const oldest = files.shift();
    try {
      fs.unlinkSync(path.join(dir, oldest));
    } catch (err) {
      console.error(`[バックアップ] 古いバックアップの削除に失敗(${oldest}):`, err.message);
    }
  }
}

// 保存先1か所を実際に見に行き、最新の自動バックアップの日付・サイズ・世代数を返す。
// 記録(backup-status.json)ではなく実ファイルを見るので、
// 「フォルダごと消えた」「0バイトだった」といった記録に残らない異常も拾える。
// NAS・共有ドライブが切断されているとここで例外になる ＝ それ自体が異常として表示される。
function inspectDir(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(AUTO_PREFIX) && f.endsWith('.db'))
      .sort();
    const latest = files[files.length - 1] || null;
    const stat = latest ? fs.statSync(path.join(dir, latest)) : null;
    return {
      dir,
      reachable: true,
      generations: files.length,
      latestFile: latest,
      // ファイル名の日付部分。projects_auto_2026-08-10.db → 2026-08-10
      latestDate: latest ? latest.slice(AUTO_PREFIX.length, -3) : null,
      sizeBytes: stat ? stat.size : null,
      error: null,
    };
  } catch (err) {
    return { dir, reachable: false, generations: 0, latestFile: null, latestDate: null, sizeBytes: null, error: err.message };
  }
}

// 画面・確認スクリプト用のまとめ。保存先ごとの実状態と、直近実行の記録を返す。
function getBackupStatus() {
  const today = localDateStamp();
  const destinations = [
    { role: 'primary', label: 'サーバー本体', ...inspectDir(BACKUP_DIR) },
    ...getExtraDirs().map((dir) => ({ role: 'extra', label: '追加保存先', ...inspectDir(dir) })),
  ].map((d) => ({ ...d, upToDate: d.latestDate === today }));

  return {
    today,
    keepCount: KEEP_COUNT,
    destinations,
    // 社外(オフサイト)保存先が1つも無い状態は、社内が丸ごとやられたときに復旧できない
    offsiteConfigured: getExtraDirs().length > 0,
    allUpToDate: destinations.every((d) => d.upToDate),
    lastRun: readStatus(),
  };
}

// サーバー起動時に呼ぶ。起動直後に1回実行し、以降は1時間ごとに
// 「当日分があるか」を確認して無ければ作成する(日付が変わったら自動で新規作成される)。
function scheduleDailyBackup(db) {
  const extras = getExtraDirs();
  if (extras.length === 0) {
    console.log('[バックアップ] 追加保存先なし(サーバー本体のみ)。'
      + ' .env の DB_BACKUP_EXTRA_DIR にカンマ区切りで保存先を指定できます');
  } else {
    console.log(`[バックアップ] 保存先 ${extras.length + 1} か所: ${[BACKUP_DIR, ...extras].join(' / ')}`);
  }

  const run = () => {
    backupIfNeeded(db)
      .then((dest) => {
        if (dest) console.log(`[バックアップ] DBを保存しました: ${dest}`);
      })
      .catch((err) => console.error('[バックアップ] 失敗:', err));
  };
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = {
  backupIfNeeded,
  scheduleDailyBackup,
  getBackupStatus,
  getExtraDirs,
  BACKUP_DIR,
  AUTO_PREFIX,
};
