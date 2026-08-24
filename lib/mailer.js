// Sends email alerts via whichever of these is configured, checked in this
// order:
//
//  1. Mailjet's HTTPS API (MJ_API_KEY + MJ_API_SECRET)
//  2. Brevo's HTTPS API (BREVO_API_KEY)
//  3. Plain SMTP via nodemailer (SMTP_HOST/USER/PASS)
//
// The two API options exist because the app may be hosted somewhere that
// blocks outbound SMTP ports, like Render's free tier (which blocks
// 25/465/587 entirely) — HTTPS (port 443) is never blocked, so either API
// option works there. Plain SMTP is fine for local use, or any host that
// doesn't block outbound SMTP.
//
// If nothing is configured, it logs a warning instead of crashing, so the
// app still works without email set up at all.

const axios = require('axios');
const nodemailer = require('nodemailer');

function mailjetConfigured() {
  return Boolean(process.env.MJ_API_KEY && process.env.MJ_API_SECRET && process.env.ALERT_TO_EMAIL);
}

function brevoApiConfigured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.ALERT_TO_EMAIL);
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.ALERT_TO_EMAIL);
}

function isConfigured() {
  return mailjetConfigured() || brevoApiConfigured() || smtpConfigured();
}

// ALERT_TO_EMAIL supports a comma-separated list of recipients.
function recipientEmails() {
  return String(process.env.ALERT_TO_EMAIL)
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

async function sendViaMailjet({ subject, html, text }) {
  try {
    const res = await axios.post(
      'https://api.mailjet.com/v3.1/send',
      {
        Messages: [
          {
            From: { Email: process.env.ALERT_FROM_EMAIL || process.env.MJ_API_KEY, Name: 'Uptime Watch' },
            To: recipientEmails().map((email) => ({ Email: email })),
            Subject: subject,
            TextPart: text,
            HTMLPart: html,
          },
        ],
      },
      {
        auth: { username: process.env.MJ_API_KEY, password: process.env.MJ_API_SECRET },
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
    // Mailjet returns HTTP 200 even for a per-message failure (e.g. an
    // unverified sender) — the actual result is nested inside the body.
    const msg = res.data && res.data.Messages && res.data.Messages[0];
    if (msg && msg.Status === 'error') {
      const detail = (msg.Errors || []).map((e) => e.ErrorMessage).join('; ') || 'Unknown Mailjet error';
      throw new Error(detail);
    }
  } catch (e) {
    const mjMessage =
      e.response && e.response.data && (e.response.data.ErrorMessage || JSON.stringify(e.response.data));
    throw new Error(mjMessage || e.message);
  }
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
        to: recipientEmails().map((email) => ({ email })),
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

  if (mailjetConfigured()) {
    await sendViaMailjet({ subject, html, text });
    return { sent: true, via: 'mailjet' };
  }

  if (brevoApiConfigured()) {
    await sendViaBrevoApi({ subject, html, text });
    return { sent: true, via: 'brevo-api' };
  }

  await sendViaSmtp({ subject, html, text });
  return { sent: true, via: 'smtp' };
}

module.exports = { sendAlert, isConfigured };
