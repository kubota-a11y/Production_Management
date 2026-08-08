// デザイン進行ボードのバトンタッチ自動通知(2026-08-03)。
//
// 山本さん(社内)⇔鈴木さん(リモート)の間で「ステータス変更したのでよろしく」
// 「完了したのでよろしく」という手動の報告をなくすため、担当が切り替わる瞬間に
// Google Chat のスペースへ自動投稿する。担当変更はすべて ops_stage の遷移として
// システムが検知済みなので、人が二度伝える必要をなくすのが狙い。
//
// 設定: .env の OPS_NOTIFY_GCHAT_WEBHOOK に Google Chat スペースの Webhook URL を入れる。
//       未設定なら何もしない(開発機ではそのまま動く。SMTPと同じ方針)。
// 方針: 通知の失敗で業務処理(段階変更)を止めない。fire-and-forget でログだけ残す。
//       同じ段階内の細かい操作(確認4ステップの切り替え等)では送らない(通知疲れ対策)。
//       投稿先は共有スペース1つ。バトンタッチ通知と同時に、三浦さん・久保田さんが
//       流れをチェックするための活動ログも兼ねる。

const WEBHOOK_URL = process.env.OPS_NOTIFY_GCHAT_WEBHOOK || '';

function isConfigured() {
  return !!WEBHOOK_URL;
}

// 案件情報から表示名を作る。顧客名は入れない(案件名だけで十分伝わり、露出も最小になる)
function caseLabel(project) {
  const item = project.item_name ? `/${project.item_name}` : '';
  return `${project.project_name}${item}`;
}

// 段階遷移(from → to)に対する通知文。null なら通知しない
function handoffMessage(project, fromStage, toStage) {
  const label = caseLabel(project);
  const isPaper = project.ops_flow === 'SUBMIT_END';
  const isCarve = isPaper && project.paper_source === 'CARVE';
  const carveMark = isCarve ? '🔶CARVE ' : '';

  switch (toStage) {
    case 'DESIGN':
      // ブリーフから来たら新規の制作依頼、確認以降から戻ってきたら修正依頼
      return fromStage === 'BRIEF'
        ? `🎨 ${carveMark}【${label}】制作のバトンが渡りました → 鈴木さん(ラフはマイスケジュールボードから開けます)`
        : `↩️ ${carveMark}【${label}】修正依頼で制作に戻りました → 鈴木さん`;
    case 'REVIEW':
      // 主要経路は初校提出の自動遷移。手動で確認へ動かした場合も同じ意味になる
      return fromStage === 'DESIGN'
        ? `✅ ${carveMark}【${label}】初校が提出されました → 山本さん: お客様へ確認連絡`
        : null;
    case 'PRODUCTION':
      // 紙媒体は入稿作業そのものが鈴木さんの仕事。衣類は外注・三浦さんの工程。
      // 衣類側は「製造の準備項目の選定」がここで初めて必要になる(登録時には選ばない運用)。
      // 抜けやすい工程なので、バトンタッチと同時に何をするかまで書く
      return isPaper
        ? `🖨 ${carveMark}【${label}】お客様OK。入稿をお願いします → 鈴木さん`
        : `📦【${label}】入稿・製造に進みました → 三浦さん: 製造の準備項目(製版・シート出力など)の選定をお願いします`;
    case 'BILLING':
      return isPaper
        ? `💰 ${carveMark}【${label}】入稿が完了しました → 山本さん: 請求書を発行して完了に`
        : `💰【${label}】請求の段階です → 山本さん: 請求書の発行`;
    case 'INSPECTION':
      return `🔍【${label}】検品をお願いします → 三浦さん・渡邉さん`;
    case 'DELIVERY':
      return `🚚【${label}】納品の段階です → 山本さん: お渡し・発送`;
    case 'DONE':
      // 完了の記録もスペースに残す(チェック役の三浦さん・久保田さんが流れを追えるように)
      return `🎉 ${carveMark}【${label}】完了しました`;
    default:
      // BRIEF への移動(登録直後・巻き戻し)は担当が変わらないので通知しない
      return null;
  }
}

// Google Chat へ投稿(fire-and-forget)。失敗しても呼び出し元へは投げない
function postToChat(text) {
  if (!isConfigured() || !text) return;
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ text }),
  }).then(res => {
    if (!res.ok) console.error(`[バトンタッチ通知] Google Chat への投稿に失敗しました (HTTP ${res.status})`);
  }).catch(err => {
    console.error('[バトンタッチ通知] Google Chat への投稿に失敗しました:', err.message);
  });
}

// setStage から呼ばれる。段階が実際に変わったときだけ届く
function notifyStageChange(db, caseId, fromStage, toStage) {
  if (!isConfigured() || fromStage === toStage) return;
  try {
    const project = db.prepare(
      'SELECT project_name, item_name, ops_flow, paper_source FROM projects WHERE id = ?'
    ).get(caseId);
    if (!project) return;
    postToChat(handoffMessage(project, fromStage, toStage));
  } catch (err) {
    // 通知は業務処理を止めない
    console.error('[バトンタッチ通知] 通知の組み立てに失敗しました:', err.message);
  }
}

module.exports = { notifyStageChange, isConfigured };
