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
const salesCategory = require('./sales-category');

const AUTHORIZE_URL = 'https://accounts.secure.freee.co.jp/public_api/authorize';
const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const IV_BASE = 'https://api.freee.co.jp/iv';
const AC_BASE = 'https://api.freee.co.jp/api/1';

// トークンはDBではなくこのファイルに置く。DBに入れるとバックアップ(NAS・Google共有ドライブ)の
// コピー全部に認証情報が乗ってしまうため。data/ は .gitignore 済み
const TOKEN_FILE = path.join(__dirname, '..', 'data', 'freee-token.json');

const DEFAULT_REDIRECT_URI = 'http://localhost:3000/api/freee/callback';

// 消費税率。見積書は外税(税抜単価+消費税)で発行する
const TAX_RATE = 10;

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
 * シミュレーターの単価は**税抜**なので tax_entry_method は必ず 'out'(外税)。
 * ここを内税にすると金額が1割ずれる。
 * ★2026-08-25に内税(税込単価)から外税へ切り替えた。単価表がもともと税抜で、
 *   帳票に「税込単価」と「※表示金額は税込」が混在して読み違いが起きたため(社長判断)。
 */
function buildQuotationPayload(sheet, partner, companyId) {
  // ★売上区分(sheet.sales_category)は見積書には載せない。freee請求書APIの見積書の明細行は
  //   勘定科目を持たない(2026-09-24 に account_item_id を送って確認: 400にはならず黙って捨てられ、
  //   読み直した行の項目は id/type/description/unit/quantity/unit_price/tax_rate/withholding/… だけ)。
  //   科目の振り分けは取引(会計API)側で行う → lib/freee-sales-sync.js
  return {
    company_id: companyId,
    partner_id: partner.id,
    partner_title: partner.title || '御中',
    // マスタの登録名が「◆ACTIVE」のように記号付きでも、帳票の宛名だけ整えられる
    ...(partner.display_name ? { partner_display_name: partner.display_name } : {}),
    ...(partner.contact_name ? { partner_contact_name: partner.contact_name } : {}),
    quotation_date: sheet.date,
    expiration_date: sheet.due,
    // 件名はシミュレーターが「品名 加工名 数量」で組み立てたもの(freeeの一覧で見分けるため。
    // 顧客名は取引先欄で分かるので件名には入れない・2026-09-01 社長指示)
    subject: sheet.subject || `${sheet.title} ${sheet.qty}枚`,
    // 社内メモにも同じ内容を入れる(2026-08-21 社長指示)。
    // ★項目名が違って400になっても発行そのものは通したいので、createQuotation 側で
    //   memo を外して1回だけ入れ直す(検証エラーなのでfreeeには何も作られていない)
    memo: sheet.subject || `${sheet.title} ${sheet.qty}枚`,
    tax_entry_method: 'out',
    // 消費税は小計に対して四捨五入(シミュレーターの taxOf() と同じ計算)
    tax_fraction: 'round',
    // ★tax_entry_method と揃えないとfreeeが400を返す
    //   (「withholding_tax_entry_method が out の場合、tax_entry_method は out を指定してください」)。
    //   当社は源泉徴収の対象外だがこの項目は必須なので、外税に合わせて 'out' を渡す
    withholding_tax_entry_method: 'out',
    quotation_note: (sheet.notes || []).join('\n'),
    // 明細はすべて摘要(description)に書く(ボディの品番・名称も摘要へ・2026-09-01 社長指示)。
    // シミュレーターは name を常に空で送るので item_name は実質使われないが、
    // 手作りのシートが name を持つ場合に備えて受け口は残す
    lines: (sheet.lines || []).map((l) => (l.type === 'text'
      // 見出し(品番・持込)は金額の無いテキスト行(三浦さんの見積書の書き方・2026-09-24)
      ? { type: 'text', description: l.desc }
      : {
      type: 'item',
      ...(l.name ? { item_name: l.name } : {}),
      description: l.desc,
      unit: l.unit,
      quantity: l.qty,
      unit_price: String(l.price),
      tax_rate: TAX_RATE,
    })),
  };
}

/** テキスト行を直後の明細の摘要の頭へ畳む(freeeがテキスト行を受け付けなかったときの逃げ道) */
function foldTextLines(payload) {
  const out = [];
  let pending = [];
  payload.lines.forEach((l) => {
    if (l.type === 'text') { pending.push(l.description); return; }
    out.push(pending.length ? { ...l, description: [...pending, l.description].filter(Boolean).join('　') } : l);
    pending = [];
  });
  return { ...payload, lines: out };
}

/** 品名を摘要の頭へ畳む(freeeが item_name を受け付けなかったときの逃げ道) */
function foldItemName(payload) {
  return {
    ...payload,
    lines: payload.lines.map((l) => {
      const { item_name: name, ...rest } = l;
      if (!name) return rest;
      return { ...rest, description: [name, rest.description].filter(Boolean).join('　') };
    }),
  };
}

function dropMemo(payload) {
  const { memo, ...rest } = payload;
  return rest;
}

/**
 * 見積書を作成する。戻り値の report_url を案件に紐づける
 *
 * ★社内メモ(memo)と品名(item_name)は「入らなくても発行は通す」扱いにしている。
 *   どちらもfreee側の項目名が合わないと400になるが、それで発行を止めたくない。
 *   400は検証エラーで帳票は作られていないため、落とす項目を変えて作り直してよい
 *   (金額に関わる項目は絶対に落とさない)。何を落としたかは skipped で返す。
 *   ※item_name は本番APIで通ることを確認済み(2026-08-25)。以下は保険。
 */
async function createQuotation(sheet, partner) {
  const base = buildQuotationPayload(sheet, partner, await getCompanyId());
  const post = (p) => callApi(`${IV_BASE}/quotations`, { method: 'POST', body: JSON.stringify(p) });

  const attempts = [
    { payload: base, skipped: [] },
    { payload: foldItemName(base), skipped: ['item_name'] },
    { payload: dropMemo(base), skipped: ['memo'] },
    { payload: dropMemo(foldItemName(base)), skipped: ['item_name', 'memo'] },
  ];
  // テキスト行(見出し)で400になった場合に備え、見出しを摘要へ畳んだ版も試す(金額は変わらない)
  if (base.lines.some((l) => l.type === 'text')) {
    attempts.push({ payload: dropMemo(foldItemName(foldTextLines(base))), skipped: ['item_name', 'memo', 'text_line'] });
  }
  let body = null;
  let skipped = [];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      body = await post(attempt.payload);
      skipped = attempt.skipped;
      break;
    } catch (error) {
      // 400以外(認証切れ・通信断など)は作り直しても意味がないので即座に投げる
      if (error.status !== 400) throw error;
      lastError = error;
    }
  }
  if (!body) throw lastError;

  const q = (body && body.quotation) || {};
  return {
    id: q.id,
    quotation_number: q.quotation_number,
    report_url: q.report_url,
    amount_including_tax: q.amount_including_tax,
    skipped,
  };
}

/**
 * 転記シートの検算。freeeへ送る前に、明細の積み上げと合計が合っているか確かめる。
 * (画面で作った値をそのまま信じない。ズレたまま発行すると取り消ししか手が無い)
 *
 * freeeは外税なので「税抜単価×数量」の積み上げが小計、それに消費税を足したものが合計。
 * ここが画面の金額と一致していれば、お客様に見せた金額とfreeeの見積書が必ず同じになる。
 *
 * ★外税にしたことで、税の端数は小計に1回しか出ない。画面(quote-sim.js の taxOf)と
 *   同じ「小計×10%を四捨五入」で計算しているので、端数によるズレは構造的に起きない。
 */
function verifyTotal(sheet) {
  const sum = (sheet.lines || []).reduce((acc, l) => acc + Math.round(l.price * l.qty), 0);
  const tax = Math.round((sum * TAX_RATE) / 100);
  const ok = sum === sheet.subtotal && tax === sheet.tax && sum + tax === sheet.total;
  return { ok, sum, tax, subtotal: sheet.subtotal, total: sheet.total };
}

/* ---------- 2026-09-24 追加: 取引先の新規作成・見積書PDFの取得(LINE返信キューからの見積送付用) ---------- */

/** 取引先を新規作成する(会計API)。LINEだけの新規のお客様をfreeeに登録するため */
async function createPartner(name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('取引先名が空です');
  const body = await callApi(`${AC_BASE}/partners`, {
    method: 'POST',
    body: JSON.stringify({ company_id: await getCompanyId(), name: n }),
  });
  const p = (body && body.partner) || {};
  return { id: p.id, name: p.name || n, code: p.code || null };
}

/** バイナリ(PDF)取得。JSON以外の応答をそのまま返す */
async function callApiBinary(url) {
  const token = await getAccessToken();
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf, application/json' } });
  const ct = String(resp.headers.get('content-type') || '');
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!resp.ok) {
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (_) { /* noop */ }
    const err = new Error(freeeErrorMessage(resp.status, body, buf.toString('utf8')));
    err.status = resp.status;
    throw err;
  }
  return { buffer: buf, contentType: ct };
}

/**
 * 見積書のPDFを取る。freeeのリファレンスはブラウザ描画でこちらから機械的に確認できなかったため、
 * 候補のパスを順に試し、PDF(application/pdf か %PDF で始まる本文)が返ったものを採用する。
 * どれも通らなければ null(呼び出し側は「手動で添付」に倒す)。どのパスで通ったかはログに残す
 */
async function downloadQuotationPdf(quotationId) {
  const id = parseInt(quotationId, 10);
  if (!id) return null;
  const cid = await getCompanyId();
  const candidates = [
    `${IV_BASE}/quotations/${id}/pdf?company_id=${cid}`,
    `${IV_BASE}/quotations/${id}/download_pdf?company_id=${cid}`,
    `${IV_BASE}/quotations/${id}.pdf?company_id=${cid}`,
  ];
  for (const url of candidates) {
    try {
      const { buffer, contentType } = await callApiBinary(url);
      const isPdf = /application\/pdf/i.test(contentType) || buffer.slice(0, 4).toString() === '%PDF';
      if (isPdf) {
        console.log(`[freee] 見積書PDFを取得: ${url.replace(/\?.*$/, '')}`);
        return buffer;
      }
    } catch (err) {
      if (err.status && err.status !== 404 && err.status !== 400 && err.status !== 405) throw err;
    }
  }
  // 見積書の本体JSONにPDFのURLが入っている場合(pdf_url 等)に備える
  try {
    const body = await callApi(`${IV_BASE}/quotations/${id}?company_id=${cid}`);
    const q = (body && body.quotation) || {};
    const pdfUrl = q.pdf_url || q.pdf_download_url || q.download_url || null;
    if (pdfUrl) {
      const { buffer, contentType } = await callApiBinary(pdfUrl);
      if (/application\/pdf/i.test(contentType) || buffer.slice(0, 4).toString() === '%PDF') {
        console.log('[freee] 見積書PDFを取得: quotation.pdf_url');
        return buffer;
      }
    }
  } catch (_) { /* 取れなければ null */ }
  console.warn(`[freee] 見積書PDFを取得できませんでした(quotation ${id})。返信キューには手動で添付してください`);
  return null;
}

/** 直近の見積書(番号とIDだけ)。PDF取得の経路確認用 */
async function listRecentQuotations(limit = 3) {
  const cid = await getCompanyId();
  const body = await callApi(`${IV_BASE}/quotations?company_id=${cid}&limit=${limit}`);
  return (body.quotations || []).map((q) => ({ id: q.id, quotation_number: q.quotation_number, quotation_date: q.quotation_date }));
}

/* ---------- 2026-09-24 追加: 売上取引の勘定科目チェック(会計API・取引の参照/更新) ----------
 * 月1回、その月の収入取引のうち売上系の科目で立っているものを一覧にし、
 * 案件の売上区分に合わせて勘定科目を振り替える。HiBoardを通らずfreeeで直接作った請求書の分も
 * ここで拾える(見積書の明細行に科目を付ける仕組みの保険)。
 * ★freeeアプリ「HiBoard」の権限に [会計] 取引 の参照・更新 が要る(docs/freee連携セットアップ手順.md)
 */

/** 権限不足(403)を人が直せる文言にする */
function permissionHint(error) {
  if (error && error.status === 403) {
    const e = new Error('freeeアプリ「HiBoard」に取引の権限がありません。freeeの開発者ページで [会計] 取引 の「参照」と「更新」を有効にして保存し、HiBoardで「freeeと連携」をやり直してください(手順: docs/freee連携セットアップ手順.md)');
    e.status = 403;
    e.need_permission = true;
    return e;
  }
  return error;
}

/** 期間内の収入取引を全部読む(100件ずつ・最大2,000件)。明細(details)付き */
async function listIncomeDeals(startDate, endDate) {
  const cid = await getCompanyId();
  const out = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const params = new URLSearchParams({
      company_id: String(cid), type: 'income', start_issue_date: startDate, end_issue_date: endDate,
      limit: '100', offset: String(offset),
    });
    let body;
    try { body = await callApi(`${AC_BASE}/deals?${params.toString()}`); } catch (e) { throw permissionHint(e); }
    const deals = (body && body.deals) || [];
    out.push(...deals);
    if (deals.length < 100) break;
  }
  return out;
}

/**
 * その月の売上取引(売上系の勘定科目を含む収入取引)を、画面が扱いやすい形で返す。
 * 取引先名は取引先API(参照権限は既存)から引く。住所・連絡先は返さない
 */
async function listSalesDeals(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new Error('月は YYYY-MM で指定してください');
  const [y, m] = month.split('-').map((v) => parseInt(v, 10));
  const last = new Date(y, m, 0).getDate();
  const start = `${month}-01`;
  const end = `${month}-${String(last).padStart(2, '0')}`;
  const salesIds = new Set(salesCategory.salesAccountItemIds());

  const deals = (await listIncomeDeals(start, end)).filter((d) => (d.details || []).some((x) => salesIds.has(x.account_item_id)));
  const partnerIds = [...new Set(deals.map((d) => d.partner_id).filter(Boolean))];
  const names = await partnerNames(partnerIds);

  return deals.map((d) => {
    const salesLines = (d.details || []).filter((x) => salesIds.has(x.account_item_id));
    const codes = [...new Set(salesLines.map((x) => salesCategory.codeOfAccountItemId(x.account_item_id)).filter(Boolean))];
    return {
      id: d.id,
      issue_date: d.issue_date,
      due_date: d.due_date || null,
      partner_id: d.partner_id || null,
      partner_name: names.get(d.partner_id) || (d.partner_id ? `取引先ID ${d.partner_id}` : '(取引先なし)'),
      amount: d.amount,
      due_amount: d.due_amount,
      status: d.status,
      ref_number: d.ref_number || '',
      description: [...new Set(salesLines.map((x) => String(x.description || '').trim()).filter(Boolean))].join(' / ').slice(0, 200),
      // 売上系の行が複数の科目にまたがる取引は「混在」として画面で目立たせる
      current_code: codes.length === 1 ? codes[0] : (codes.length ? 'MIXED' : null),
      sales_line_count: salesLines.length,
    };
  });
}

/** 取引先ID → 名前。件数が少ないので1件ずつ引き、プロセス内に覚える */
const partnerNameCache = new Map();
async function partnerNames(ids) {
  const cid = await getCompanyId();
  const out = new Map();
  for (const id of ids) {
    if (!partnerNameCache.has(id)) {
      try {
        const body = await callApi(`${AC_BASE}/partners/${id}?company_id=${cid}`);
        partnerNameCache.set(id, (body && body.partner && body.partner.name) || '');
      } catch (_) {
        partnerNameCache.set(id, '');
      }
    }
    out.set(id, partnerNameCache.get(id));
  }
  return out;
}

/**
 * 取引の売上系の明細行の勘定科目を、指定の売上区分の科目へ付け替える。
 * 金額・税区分・品目・部門・メモタグ・摘要はそのまま送り返す(freeeの更新は明細を丸ごと受け取るため)。
 * 決済(入金の消込)は更新の対象外なので残る。更新後に合計金額が変わっていたら異常として知らせる
 */
async function updateDealSalesAccount(dealId, categoryCode) {
  const toId = salesCategory.accountItemId(categoryCode);
  if (!toId) throw new Error('売上区分が不正です');
  const cid = await getCompanyId();
  const id = parseInt(dealId, 10);
  if (!(id > 0)) throw new Error('取引IDが不正です');

  let body;
  try { body = await callApi(`${AC_BASE}/deals/${id}?company_id=${cid}`); } catch (e) { throw permissionHint(e); }
  const deal = (body && body.deal) || null;
  if (!deal) throw new Error('取引が見つかりません');
  if (deal.type !== 'income') throw new Error('収入取引ではありません');

  const salesIds = new Set(salesCategory.salesAccountItemIds());
  let changed = 0;
  const details = (deal.details || []).map((x) => {
    const isSales = salesIds.has(x.account_item_id);
    if (isSales && x.account_item_id !== toId) changed += 1;
    const line = {
      id: x.id,
      account_item_id: isSales ? toId : x.account_item_id,
      tax_code: x.tax_code,
      amount: x.amount,
    };
    if (x.item_id) line.item_id = x.item_id;
    if (x.section_id) line.section_id = x.section_id;
    if (Array.isArray(x.tag_ids) && x.tag_ids.length) line.tag_ids = x.tag_ids;
    if (x.description) line.description = x.description;
    if (x.vat !== undefined && x.vat !== null) line.vat = x.vat;
    if (x.entry_side) line.entry_side = x.entry_side;
    return line;
  });
  if (changed === 0) return { ok: true, changed: 0, deal_id: id, amount: deal.amount };

  const payload = { company_id: cid, issue_date: deal.issue_date, type: 'income', details };
  if (deal.due_date) payload.due_date = deal.due_date;
  if (deal.partner_id) payload.partner_id = deal.partner_id;
  if (deal.ref_number) payload.ref_number = deal.ref_number;

  let updated;
  try {
    updated = await callApi(`${AC_BASE}/deals/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  } catch (e) { throw permissionHint(e); }
  const after = (updated && updated.deal) || {};
  if (Number(after.amount) !== Number(deal.amount)) {
    throw new Error(`更新後の金額が一致しません(前 ${deal.amount} / 後 ${after.amount})。freeeで取引 ${id} を確認してください`);
  }
  return { ok: true, changed, deal_id: id, amount: after.amount };
}

module.exports = {
  isConfigured,
  status,
  buildAuthorizeUrl,
  consumeState,
  exchangeCode,
  clearToken,
  searchPartners,
  createPartner,
  createQuotation,
  downloadQuotationPdf,
  listRecentQuotations,
  buildQuotationPayload,
  verifyTotal,
  listSalesDeals,
  updateDealSalesAccount,
  // 診断・検証用(サーバー外のスクリプトから同じトークンでAPIを叩くため)
  _internal: { callApi, getCompanyId },
};
