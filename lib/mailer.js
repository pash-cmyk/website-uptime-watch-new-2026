// Sends email alerts via SMTP (nodemailer). If SMTP isn't configured, it logs
// a warning instead of crashing, so the app still works without email set up.

const nodemailer = require('nodemailer');

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.ALERT_TO_EMAIL);
}

function getTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendAlert({ subject, html, text }) {
  if (!isConfigured()) {
    console.warn(`[mailer] SMTP not configured — skipping email alert: "${subject}"`);
    return { sent: false, reason: 'SMTP not configured (see .env)' };
  }
  const transport = getTransport();
  await transport.sendMail({
    from: process.env.ALERT_FROM_EMAIL || process.env.SMTP_USER,
    to: process.env.ALERT_TO_EMAIL,
    subject,
    text,
    html,
  });
  return { sent: true };
}

module.exports = { sendAlert, isConfigured };
