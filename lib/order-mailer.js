const nodemailer = require('nodemailer');

// Web注文の受付控えメール送信。
// .envにSMTP設定が無い環境では isMailerConfigured() が false になり、送信は行われない
// (開発機ではスキップ、本番機は .env にSMTP設定を追記した時点で有効になる)。
//
// 必要な .env 設定:
//   SMTP_HOST=メールサーバーのホスト名
//   SMTP_PORT=587 (465ならSSL接続になる)
//   SMTP_USER=SMTP認証ユーザー
//   SMTP_PASS=SMTP認証パスワード
//   MAIL_FROM="表示名" <差出人アドレス>  例: "HIYOSHI" <info@hiyoshi1954.com>
//   MAIL_ADMIN_TO=会社側の通知先アドレス(任意。設定すると新規Web注文のたびに通知メールが届く)
//
// 社内通知だけ別アカウントから送りたい場合(任意):
//   ADMIN_SMTP_HOST / ADMIN_SMTP_PORT / ADMIN_SMTP_USER / ADMIN_SMTP_PASS=社内通知専用SMTP
//   ADMIN_MAIL_FROM="表示名" <差出人アドレス>  例: "HIYOSHI" <contact@hiyoshi-1954.com>
//   ※お客様向け(MAIL_FROM)と社内の受信者(MAIL_ADMIN_TO)が同じメールボックスだと、
//     Gmailは自己送信を受信トレイに入れず送信済みにだけ残す。社内通知を別アカウントから
//     送ることでこれを回避し、受信トレイに届くようにする。
//   ※ADMIN_SMTP_HOST 未設定時は従来どおり MAIL_FROM/SMTP_* の経路で送信する。

let transporter = null;
let adminTransporter = null;

function isMailerConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM);
}

function buildTransport(host, port, user, pass) {
  const p = Number(port || 587);
  return nodemailer.createTransport({
    host,
    port: p,
    secure: p === 465, // 465はSSL、587はSTARTTLS
    auth: user ? { user, pass } : undefined,
  });
}

// お客様向けメール(受付控え)の送信経路。差出人は MAIL_FROM(例: info@hiyoshi1954.com)。
function getTransporter() {
  if (!transporter) {
    transporter = buildTransport(
      process.env.SMTP_HOST,
      process.env.SMTP_PORT,
      process.env.SMTP_USER,
      process.env.SMTP_PASS,
    );
  }
  return transporter;
}

// 社内通知メールの送信経路。ADMIN_SMTP_HOST を設定すると、お客様向けとは別の
// アカウント(例: contact@hiyoshi-1954.com)から送る。差出人と受信者が別メールボックスに
// なるため、Gmailの自己送信スキップ(自分宛てが受信トレイに入らない現象)を回避できる。
// ADMIN_SMTP_HOST 未設定なら従来どおりお客様向けと同じ経路にフォールバックする。
function getAdminTransporter() {
  if (!process.env.ADMIN_SMTP_HOST) return getTransporter();
  if (!adminTransporter) {
    adminTransporter = buildTransport(
      process.env.ADMIN_SMTP_HOST,
      process.env.ADMIN_SMTP_PORT,
      process.env.ADMIN_SMTP_USER,
      process.env.ADMIN_SMTP_PASS,
    );
  }
  return adminTransporter;
}

// 社内通知メールの差出人。ADMIN_MAIL_FROM 未設定なら MAIL_FROM にフォールバック。
function adminMailFrom() {
  return process.env.ADMIN_MAIL_FROM || process.env.MAIL_FROM;
}

// 受付控えメールを送信する。SMTP未設定ならfalseを返して何もしない。
// summary の各値は null 可(nullの行は本文から省く)。
async function sendOrderConfirmation({ to, receiptNo, requestTypeLabel, orderer, summary }) {
  if (!isMailerConfigured()) return false;

  const L = [];
  L.push(`${[orderer.org_name, orderer.contact_name].filter(Boolean).join(' ')} 様`);
  L.push('');
  L.push(`この度は${requestTypeLabel}のご依頼をいただき、誠にありがとうございます。`);
  L.push('以下の内容で受け付けました。担当者が内容を確認のうえ、あらためてご連絡いたします。');
  L.push('');
  L.push(`■受付番号: ${receiptNo}`);
  L.push(`■ご依頼種別: ${requestTypeLabel}`);
  if (summary.items) L.push(`■ご依頼内容: ${summary.items}`);
  if (summary.quantity) L.push(`■数量: ${summary.quantity}`);
  if (summary.deadline) L.push(`■ご希望納期: ${summary.deadline}`);
  if (summary.contact_time) {
    L.push(`■ご希望連絡時間帯: ${summary.contact_time}`);
    L.push('');
    L.push('担当者よりお電話にて詳細をお伺いいたします。');
  }
  L.push('');
  L.push('お問い合わせの際は、受付番号をお伝えいただくとスムーズにご案内できます。');
  L.push('');
  L.push('※本メールはシステムによる自動送信です。');
  L.push('※お心当たりのない場合は、お手数ですが本メールを破棄してください。');

  await getTransporter().sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: `【受付完了】${requestTypeLabel}を受け付けました(受付番号 ${receiptNo})`,
    text: L.join('\n'),
  });
  return true;
}

// 会社側への新規注文通知。MAIL_ADMIN_TO が未設定なら何もしない。
// お客様がメールアドレスを書かなかった注文でも、会社側には必ず届く。
async function sendOrderNotificationToAdmin({ receiptNo, requestTypeLabel, orderer, summary }) {
  const adminTo = process.env.MAIL_ADMIN_TO;
  if (!isMailerConfigured() || !adminTo) return false;

  const L = [];
  L.push(`Webオーダーフォームから新しい${requestTypeLabel}が届きました。`);
  L.push('');
  L.push(`■受付番号: ${receiptNo}`);
  L.push(`■ご依頼種別: ${requestTypeLabel}`);
  L.push(`■注文者: ${orderer.org_name || '(会社/団体名なし)'} / ${orderer.contact_name}`);
  L.push(`■電話: ${orderer.phone}`);
  if (summary.contact_time) L.push(`■希望連絡時間帯: ${summary.contact_time} ← お電話でヒアリングをお願いします`);
  if (orderer.email) L.push(`■メール: ${orderer.email}`);
  if (summary.items) L.push(`■ご依頼内容: ${summary.items}`);
  if (summary.quantity) L.push(`■数量: ${summary.quantity}`);
  if (summary.deadline) L.push(`■ご希望納期: ${summary.deadline}`);
  L.push('');
  L.push('詳細は生産管理アプリの「コピペ取り込み」タブ(AI受注候補)から確認・登録してください。');

  await getAdminTransporter().sendMail({
    from: adminMailFrom(),
    to: adminTo,
    subject: `【新規受付 ${receiptNo}】${orderer.org_name || orderer.contact_name} 様より${requestTypeLabel}`,
    text: L.join('\n'),
  });
  return true;
}

module.exports = { isMailerConfigured, sendOrderConfirmation, sendOrderNotificationToAdmin };
