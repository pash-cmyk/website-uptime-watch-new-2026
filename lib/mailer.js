// Sends email alerts one of two ways:
//
//  - Brevo's HTTPS API (preferred when BREVO_API_KEY is set) — this is what
//    lets alerts work when the app is hosted somewhere that blocks outbound
//    SMTP ports, like Render's free tier (which blocks 25/465/587 entirely).
//    Since this rides over normal HTTPS (port 443), it's never blocked.
//  - Plain SMTP via nodemailer (used when SMTP_HOST/USER/PASS are set instead)
//    — fine for local use, or any host that doesn't block outbound SMTP.
//
// If neither is configured, it logs a warning instead of crashing, so the
// app still works without email set up at all.

const axios = require('axios');
const nodemailer = require('nodemailer');

function brevoApiConfigured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.ALERT_TO_EMAIL);
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.ALERT_TO_EMAIL);
}

function isConfigured() {
  return brevoApiConfigured() || smtpConfigured();
}

// ALERT_TO_EMAIL supports a comma-separated list of recipients.
function recipientList() {
  return String(process.env.ALERT_TO_EMAIL)
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((email) => ({ email }));
}

async function sendViaBrevoApi({ subject, html, text }) {
  try {
    await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: {
          email: process.env.ALERT_FROM_EMAIL || process.env.SMTP_USER,
          name: 'Uptime Watch',
        },
        to: recipientList(),
        subject,
        htmlContent: html,
        textContent: text,
      },
      {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 10000,
      }
    );
  } catch (e) {
    // Surface Brevo's actual error message (e.g. "sender not verified",
    // "invalid api-key") instead of a generic axios status-code message.
    const brevoMessage = e.response && e.response.data && (e.response.data.message || JSON.stringify(e.response.data));
    throw new Error(brevoMessage || e.message);
  }
}

function getSmtpTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendViaSmtp({ subject, html, text }) {
  const transport = getSmtpTransport();
  await transport.sendMail({
    from: process.env.ALERT_FROM_EMAIL || process.env.SMTP_USER,
    to: process.env.ALERT_TO_EMAIL,
    subject,
    text,
    html,
  });
}

async function sendAlert({ subject, html, text }) {
  if (!isConfigured()) {
    console.warn(`[mailer] Email not configured — skipping alert: "${subject}"`);
    return { sent: false, reason: 'Email not configured (see .env)' };
  }

  // Brevo's API takes priority when both happen to be set, since it's the
  // more reliable option on hosts (like Render's free tier) that silently
  // block outbound SMTP ports.
  if (brevoApiConfigured()) {
    await sendViaBrevoApi({ subject, html, text });
    return { sent: true, via: 'brevo-api' };
  }

  await sendViaSmtp({ subject, html, text });
  return { sent: true, via: 'smtp' };
}

module.exports = { sendAlert, isConfigured };
