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
//   MAIL_FROM="表示名" <差出人アドレス>  例: "ヒヨシ" <info@hiyoshi1954.com>

let transporter = null;

function isMailerConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM);
}

function getTransporter() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  }
  return transporter;
}

// 受付控えメールを送信する。SMTP未設定ならfalseを返して何もしない。
// summary の各値は null 可(nullの行は本文から省く)。
async function sendOrderConfirmation({ to, receiptNo, requestTypeLabel, orderer, summary }) {
  if (!isMailerConfigured()) return false;

  const L = [];
  L.push(`${orderer.org_name} ${orderer.contact_name} 様`);
  L.push('');
  L.push(`この度は${requestTypeLabel}のご依頼をいただき、誠にありがとうございます。`);
  L.push('以下の内容で受け付けました。担当者が内容を確認のうえ、あらためてご連絡いたします。');
  L.push('');
  L.push(`■受付番号: ${receiptNo}`);
  L.push(`■ご依頼種別: ${requestTypeLabel}`);
  if (summary.items) L.push(`■ご依頼内容: ${summary.items}`);
  if (summary.quantity) L.push(`■数量: ${summary.quantity}`);
  if (summary.deadline) L.push(`■ご希望納期: ${summary.deadline}`);
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

module.exports = { isMailerConfigured, sendOrderConfirmation };
