/**
 * freee請求書API 連携(見積書の作成)
 *
 * 見積シミュレーター(/quote-sim)の転記シートを、そのままfreeeの見積書として発行する。
 * 三浦さん・山本さんがfreeeへ手入力していた作業を置き換えるのが目的。
 *
 * ★freee APIには「下書き」が無い。作成した時点で見積書番号が採番された正式な帳票になる
 *   (送付はされず「送付待ち」)。人の確認は必ず**発行前**にHiBoard側の確認画面で行うこと。
 *
 * 公式仕様(freee請求書 API v1 / freee会計 API v1)より:
 *   - 見積書作成 : POST https://api.freee.co.jp/iv/quotations
 *   - 取引先検索 : GET  https://api.freee.co.jp/api/1/partners?company_id=&keyword=
 *   - 認可       : https://accounts.secure.freee.co.jp/public_api/authorize
 *   - トークン   : https://accounts.secure.freee.co.jp/public_api/token
 *   - アクセストークンの有効期限は6時間、リフレッシュトークンは90日。
 *     リフレッシュトークンは**1回使うと新しい値に変わる**ので、毎回必ず保存し直す。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUTHORIZE_URL = 'https://accounts.secure.freee.co.jp/public_api/authorize';
const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const IV_BASE = 'https://api.freee.co.jp/iv';
const AC_BASE = 'https://api.freee.co.jp/api/1';

// トークンはDBではなくこのファイルに置く。DBに入れるとバックアップ(NAS・Google共有ドライブ)の
// コピー全部に認証情報が乗ってしまうため。data/ は .gitignore 済み
const TOKEN_FILE = path.join(__dirname, '..', 'data', 'freee-token.json');

const DEFAULT_REDIRECT_URI = 'http://localhost:3000/api/freee/callback';

function config() {
  return {
    clientId: process.env.FREEE_CLIENT_ID || '',
    clientSecret: process.env.FREEE_CLIENT_SECRET || '',
    companyId: parseInt(process.env.FREEE_COMPANY_ID, 10) || 0,
    redirectUri: process.env.FREEE_REDIRECT_URI || DEFAULT_REDIRECT_URI,
  };
}

/** .envにClient ID/Secretが揃っているか(事業所IDは認可後にAPIから取れるので必須にしない) */
function isConfigured() {
  const c = config();
  return Boolean(c.clientId && c.clientSecret);
}

/**
 * 事業所ID。`.env` の FREEE_COMPANY_ID があればそれを使い、無ければfreeeから取得する。
 * 事業所IDはfreeeの画面に出てこない値なので、人に探させるとセットアップで必ず詰まる。
 * 事業所が複数ある場合だけは自動で選べないので、.envでの指定を促す。
 */
let cachedCompanyId = 0;
async function getCompanyId() {
  const fromEnv = config().companyId;
  if (fromEnv) return fromEnv;
  if (cachedCompanyId) return cachedCompanyId;

  const body = await callApi(`${AC_BASE}/companies`);
  const companies = (body && body.companies) || [];
  if (!companies.length) {
    throw new Error('freeeから事業所を取得できませんでした。アプリの権限設定で「[会計] 事業所」の参照を有効にしてください');
  }
  if (companies.length > 1) {
    const names = companies.map((c) => `${c.display_name || c.name}(ID: ${c.id})`).join(' / ');
    throw new Error(`事業所が複数あります。.env の FREEE_COMPANY_ID にどれを使うか指定してください → ${names}`);
  }
  cachedCompanyId = companies[0].id;
  console.log(`[freee] 事業所を自動判定しました: ${companies[0].display_name || companies[0].name} (ID: ${cachedCompanyId})`);
  return cachedCompanyId;
}

/* ---------- トークンの保存と読み出し ---------- */

function readToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (_) {
    return null; // 未認可
  }
}

/** 書き込み途中で落ちてもファイルが壊れないように、一時ファイル経由で差し替える */
function writeToken(token) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  const tmp = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
}

function clearToken() {
  try { fs.unlinkSync(TOKEN_FILE); } catch (_) { /* もともと無ければそれでよい */ }
}

/** freeeのトークンレスポンス → 保存する形 */
function toStoredToken(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    // 期限は絶対時刻で持つ(expires_inは取得時点からの秒数なので保存しても意味が薄い)
    expires_at: new Date(Date.now() + (data.expires_in || 21600) * 1000).toISOString(),
    obtained_at: new Date().toISOString(),
  };
}

/* ---------- OAuth2(認可コードフロー) ---------- */

// 認可開始時に発行し、コールバックで照合する(CSRF対策)。サーバー再起動で消えてよい
const pendingStates = new Set();

function buildAuthorizeUrl() {
  const c = config();
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.add(state);
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function consumeState(state) {
  if (!state || !pendingStates.has(state)) return false;
  pendingStates.delete(state);
  return true;
}

async function requestToken(body) {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`freeeの認証に失敗しました (HTTP ${resp.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

/** 認可コードを初回のトークンに交換して保存する */
async function exchangeCode(code) {
  const c = config();
  const data = await requestToken({
    grant_type: 'authorization_code',
    client_id: c.clientId,
    client_secret: c.clientSecret,
    code,
    redirect_uri: c.redirectUri,
  });
  const token = toStoredToken(data);
  writeToken(token);
  return token;
}

// 同時に何本もリフレッシュを走らせない。リフレッシュトークンは1回しか使えないので、
// 並行して2回投げると片方が必ず失敗して連携が切れる
let refreshInFlight = null;

async function refreshToken(current) {
  const c = config();
  const data = await requestToken({
    grant_type: 'refresh_token',
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: current.refresh_token,
  });
  const token = toStoredToken(data);
  writeToken(token); // ★新しいリフレッシュトークンを必ず保存する
  return token;
}

/**
 * 有効なアクセストークンを返す。期限が近ければ自動で更新する。
 * 未認可・リフレッシュ期限切れ(90日)のときは再認可を促すエラーを投げる。
 */
async function getAccessToken() {
  const stored = readToken();
  if (!stored) {
    const err = new Error('freeeと未連携です。管理メニューの「freee連携」から認可してください');
    err.code = 'NOT_AUTHORIZED';
    throw err;
  }
  // 残り10分を切ったら更新する(処理中に切れるのを避ける)
  const remainMs = new Date(stored.expires_at).getTime() - Date.now();
  if (remainMs > 10 * 60 * 1000) return stored.access_token;

  if (!refreshInFlight) {
    refreshInFlight = refreshToken(stored)
      .catch((error) => {
        // 90日を過ぎるとリフレッシュも通らない。再認可が要ることを画面に出したいので
        // 壊れたトークンは消しておく(次回のstatusが「未連携」になる)
        clearToken();
        const err = new Error('freeeとの連携の有効期限が切れました。管理メニューの「freee連携」から認可し直してください');
        err.code = 'NOT_AUTHORIZED';
        err.cause = error;
        throw err;
      })
      .finally(() => { refreshInFlight = null; });
  }
  const token = await refreshInFlight;
  return token.access_token;
}

/** 連携状態(画面表示用)。トークンの中身そのものは絶対に返さない */
function status() {
  if (!isConfigured()) {
    // セットアップの切り分け用に「サーバーから見えているキー名」だけ返す。
    // 全角文字やスペース混じりで書くとdotenvが読めず、原因が画面から分からないため。
    // ★値は絶対に返さない(名前だけ)
    return {
      state: 'unconfigured',
      message: '.env に FREEE_CLIENT_ID / FREEE_CLIENT_SECRET を設定してください',
      detected_keys: Object.keys(process.env).filter((k) => /FRE|CLIENT|COMPANY/i.test(k)),
    };
  }
  const stored = readToken();
  if (!stored) {
    // セットアップで「値が途中で切れている」事故が実際に起きたので、
    // 長さだけ返す(値は絶対に返さない)。freeeの画面の入力欄の文字数と見比べれば
    // コピー漏れがすぐ分かる。Client Secretは86文字、Client IDは15文字だった
    const c = config();
    return {
      state: 'unauthorized',
      message: 'freeeの認可がまだです',
      config_check: {
        client_id_len: c.clientId.length,
        client_secret_len: c.clientSecret.length,
        redirect_uri: c.redirectUri,
      },
    };
  }
  return {
    state: 'ready',
    // リフレッシュトークンの寿命(90日)。この日を過ぎると再認可が必要
    reauth_by: new Date(new Date(stored.obtained_at).getTime() + 90 * 86400000).toISOString().slice(0, 10),
  };
}

/* ---------- API呼び出し ---------- */

async function callApi(url, options = {}) {
  const token = await getAccessToken();
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { /* JSONでない応答はそのまま扱う */ }
  if (!resp.ok) {
    const err = new Error(freeeErrorMessage(resp.status, body, text));
    err.status = resp.status;
    throw err;
  }
  return body;
}

/** freeeのエラー応答を人が読める1行にする(顧客データは載せない) */
function freeeErrorMessage(httpStatus, body, rawText) {
  const messages = [];
  if (body && Array.isArray(body.errors)) {
    body.errors.forEach((e) => {
      if (typeof e === 'string') messages.push(e);
      else if (e && e.messages) messages.push([].concat(e.messages).join(' / '));
      else if (e && e.message) messages.push(e.message);
    });
  }
  if (!messages.length && body && body.message) messages.push(body.message);
  if (!messages.length && body && body.detail) messages.push(body.detail);
  if (!messages.length) messages.push(String(rawText || '').slice(0, 200));
  return `freee側でエラーになりました (HTTP ${httpStatus}): ${messages.join(' / ')}`;
}

/** 取引先を名前で部分一致検索する。確認画面の候補表示に使う */
async function searchPartners(keyword) {
  const params = new URLSearchParams({
    company_id: String(await getCompanyId()),
    limit: '30',
  });
  if (keyword) params.set('keyword', keyword);
  const body = await callApi(`${AC_BASE}/partners?${params.toString()}`);
  return (body.partners || []).map((p) => ({
    id: p.id,
    name: p.name,
    code: p.code || null,
  }));
}

/**
 * 転記シート(quote-sim の buildSheet() の戻り値と同じ形) → freeeの見積書リクエスト
 *
 * シミュレーターの単価は**税込**なので tax_entry_method は必ず 'in'(内税)。
 * ここを外税にすると金額が1割ずれる(手入力時に一番多かった間違い)。
 */
function buildQuotationPayload(sheet, partner, companyId) {
  return {
    company_id: companyId,
    partner_id: partner.id,
    partner_title: partner.title || '御中',
    // マスタの登録名が「◆ACTIVE」のように記号付きでも、帳票の宛名だけ整えられる
    ...(partner.display_name ? { partner_display_name: partner.display_name } : {}),
    ...(partner.contact_name ? { partner_contact_name: partner.contact_name } : {}),
    quotation_date: sheet.date,
    expiration_date: sheet.due,
    // 件名はシミュレーターが「顧客名 品名 加工名 数量」で組み立てたもの(freeeの一覧で見分けるため)
    subject: sheet.subject || `${sheet.title} ${sheet.qty}枚`,
    // 社内メモにも同じ内容を入れる(2026-08-21 社長指示)。
    // ★項目名が違って400になっても発行そのものは通したいので、createQuotation 側で
    //   memo を外して1回だけ入れ直す(検証エラーなのでfreeeには何も作られていない)
    memo: sheet.subject || `${sheet.title} ${sheet.qty}枚`,
    tax_entry_method: 'in',
    // シミュレーターは税抜を Math.round で出しているので四捨五入を選ぶ(端数1円のズレを防ぐ)
    tax_fraction: 'round',
    // ★tax_entry_method と揃えないとfreeeが400を返す
    //   (「withholding_tax_entry_method が out の場合、tax_entry_method は out を指定してください」)。
    //   当社は源泉徴収の対象外だがこの項目は必須なので、内税に合わせて 'in' を渡す
    withholding_tax_entry_method: 'in',
    quotation_note: (sheet.notes || []).join('\n'),
    lines: (sheet.lines || []).map((l) => ({
      type: 'item',
      description: l.desc,
      unit: l.unit,
      quantity: l.qty,
      unit_price: String(l.price),
      tax_rate: 10,
    })),
  };
}

/** 見積書を作成する。戻り値の report_url を案件に紐づける */
async function createQuotation(sheet, partner) {
  const payload = buildQuotationPayload(sheet, partner, await getCompanyId());
  const post = (p) => callApi(`${IV_BASE}/quotations`, { method: 'POST', body: JSON.stringify(p) });

  let body;
  let memoSkipped = false;
  try {
    body = await post(payload);
  } catch (error) {
    // 社内メモの項目名がfreee側と合わないときに発行そのものを止めたくない。
    // 400は検証エラーで帳票は作られていないため、memoを外して1回だけやり直す
    if (error.status === 400 && payload.memo) {
      const { memo, ...withoutMemo } = payload;
      body = await post(withoutMemo);
      memoSkipped = true;
    } else {
      throw error;
    }
  }
  const q = (body && body.quotation) || {};
  return {
    id: q.id,
    quotation_number: q.quotation_number,
    report_url: q.report_url,
    amount_including_tax: q.amount_including_tax,
    memo_skipped: memoSkipped,
  };
}

/**
 * 転記シートの検算。freeeへ送る前に、明細の積み上げと合計が合っているか確かめる。
 * (画面で作った値をそのまま信じない。ズレたまま発行すると取り消ししか手が無い)
 *
 * freeeは「税込単価×数量」の積み上げで帳票の合計を出すので、ここが画面の合計と
 * 一致していれば、お客様に見せた金額とfreeeの見積書が必ず同じになる。
 *
 * ★現在この検算は常に一致する: 初期費用(製版代4,000/8,000・版下5,000/10,000・
 *   八木繊維様3,520/7,040)がすべて10円単位で、税込換算(×1.1)に端数が出ないため、
 *   「合計に1回だけ税込換算」と「行ごとに税込換算」の結果が同じになる。
 *   **10円単位でない初期費用を料金表に足すと、1円のズレでここが止まりうる**。
 *   その場合は行ごとの税込換算に合わせて合計の計算(quote-sim.js の recalc)を直すこと。
 */
function verifyTotal(sheet) {
  const sum = (sheet.lines || []).reduce((acc, l) => acc + Math.round(l.price * l.qty), 0);
  return { ok: sum === sheet.total, sum, total: sheet.total };
}

module.exports = {
  isConfigured,
  status,
  buildAuthorizeUrl,
  consumeState,
  exchangeCode,
  clearToken,
  searchPartners,
  createQuotation,
  buildQuotationPayload,
  verifyTotal,
};
