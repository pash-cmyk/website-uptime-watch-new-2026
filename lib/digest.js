// Builds and sends ONE consolidated "digest" alert email per check cycle,
// instead of a separate email for every individual site/page transition.
//
// Fires from checkAllSites() (the scheduler, the homepage "Check all"
// button, and server boot) whenever there's something worth reporting:
// at least one target currently in trouble (Down / Warning / Slow), and/or
// at least one target that just recovered this cycle. It fires every cycle
// while a problem persists — even if the list of problems hasn't changed —
// rather than only on change, so the team always has an up-to-date report
// instead of having to remember what the last alert said.
//
// Recipients come from the "Alert recipients" field in the dashboard's
// Settings panel (kept in sync with process.env.ALERT_TO_EMAIL — see
// server.js) rather than a hardcoded env var, so they're editable live.

const store = require('./store');
const { sendAlert } = require('./mailer');

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function baseUrl() {
  return String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
}

// Absolute link to the site/page's own detail page in the tool.
function detailUrl(t) {
  const path = t.pageId ? `/site.html?id=${t.siteId}&page=${t.pageId}` : `/site.html?id=${t.siteId}`;
  return baseUrl() ? `${baseUrl()}${path}` : path;
}

// "Mark as Fixed" has to work as a plain link clicked from an email client —
// no JS, no auth header the app can attach — so it's a GET endpoint that
// mutates and then redirects into the tool. See server.js's /ack routes.
function ackUrl(t) {
  const path = t.pageId ? `/api/sites/${t.siteId}/pages/${t.pageId}/ack` : `/api/sites/${t.siteId}/ack`;
  return baseUrl() ? `${baseUrl()}${path}` : path;
}

const SEVERITY_LABEL = { down: 'DOWN', warning: 'WARNING', slow: 'SLOW' };
const SEVERITY_ORDER = ['down', 'warning', 'slow'];
// Colored circles so every line — subject, section header, and each
// individual site/page row — is scannable at a glance without reading the
// words: red = Down, yellow = Warning, blue = Slow, green = Recovered/Up.
// Kept in sync with the same colors used for badges/chart in the dashboard
// (see public/style.css's --slow etc.) so the email and the app agree.
const SEVERITY_EMOJI = { down: '\u{1F534}', warning: '\u{1F7E1}', slow: '\u{1F535}' };
const SEVERITY_COLOR = { down: '#b91c1c', warning: '#92400e', slow: '#1d4ed8' };
const RECOVERED_EMOJI = '\u{1F7E2}';
const RECOVERED_COLOR = '#16a34a';
const BRAND_LABEL = 'Uptime Watch.com';

// A short, precise detail for the subject/body — "HTTP 404", "Timed out
// waiting for a response", "1842ms response" — never the whole page dump.
function shortDetail(t) {
  if (t.category === 'down') return t.error ? t.error.replace(/\.+$/, '') : (t.httpStatus ? `HTTP ${t.httpStatus}` : 'Down');
  if (t.category === 'warning') return `HTTP ${t.httpStatus}`;
  if (t.category === 'slow') return `${t.responseTimeMs}ms response`;
  return '';
}

// Subject is always "[state summary] — Uptime Watch.com", so the brand name
// is right there in the inbox regardless of which case below fires.
function buildSubject(problems, recovered) {
  let statePart;
  if (!problems.length && recovered.length === 1) {
    statePart = `UP - ${recovered[0].name} is back up`;
  } else if (!problems.length && recovered.length > 1) {
    statePart = `UP - ${recovered.length} sites recovered`;
  } else if (problems.length === 1 && !recovered.length) {
    const t = problems[0];
    statePart = `${SEVERITY_LABEL[t.category]} - ${t.targetName} | ${shortDetail(t)}`;
  } else {
    const worst = SEVERITY_ORDER.find((sev) => problems.some((p) => p.category === sev));
    const counts = SEVERITY_ORDER
      .map((sev) => [sev, problems.filter((p) => p.category === sev).length])
      .filter(([, n]) => n)
      .map(([sev, n]) => `${n} ${SEVERITY_LABEL[sev]}`)
      .join(', ');
    const recoveredPart = recovered.length ? `, ${recovered.length} recovered` : '';
    statePart = `${SEVERITY_LABEL[worst]} - ${counts}${recoveredPart}`;
  }
  return `${statePart} — ${BRAND_LABEL}`;
}

function buildBody(problems, recovered) {
  const groups = SEVERITY_ORDER
    .map((sev) => ({ sev, items: problems.filter((p) => p.category === sev) }))
    .filter((g) => g.items.length);

  const textLines = [];
  const htmlSections = [];

  if (!problems.length) {
    textLines.push('All monitored sites are currently up.');
  }

  for (const { sev, items } of groups) {
    const emoji = SEVERITY_EMOJI[sev];
    textLines.push(`\n${emoji} ${SEVERITY_LABEL[sev]} (${items.length}):`);
    const rows = items.map((t) => {
      // Every "website line" carries the same colored circle as its section
      // header, so a line stands out on its own even if the list is scanned
      // quickly without reading the section headings.
      textLines.push(`  ${emoji} ${t.targetName} (${t.targetUrl}) -- ${shortDetail(t)} -- mark fixed: ${ackUrl(t)}`);
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;">
          <div style="font-weight:600;">${emoji} ${escapeHtml(t.targetName)}</div>
          <a href="${detailUrl(t)}" style="color:#64748b;font-size:12px;text-decoration:none;">${escapeHtml(t.targetUrl)}</a>
        </td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;">${escapeHtml(shortDetail(t))}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;white-space:nowrap;">
          <a href="${ackUrl(t)}" style="color:#fff;background:#2a78d6;padding:5px 12px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;">Mark as Fixed</a>
        </td>
      </tr>`;
    }).join('');
    htmlSections.push(`
      <h3 style="margin:20px 0 8px;font-size:14px;color:${SEVERITY_COLOR[sev]};">${emoji} ${SEVERITY_LABEL[sev]} (${items.length})</h3>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>`);
  }

  if (recovered.length) {
    // Recovered/Up gets the same circle treatment, just green — the "vice
    // versa" of the problem colors above, so a glance at the color alone
    // tells you good news from bad news.
    textLines.push(`\n${RECOVERED_EMOJI} RECOVERED (${recovered.length}):`);
    const rows = recovered.map((t) => {
      textLines.push(`  ${RECOVERED_EMOJI} ${t.name} (${t.url}) is back up`);
      return `<tr><td style="padding:8px 10px;border-bottom:1px solid #eee;">
        <div style="font-weight:600;">${RECOVERED_EMOJI} ${escapeHtml(t.name)}</div>
        <span style="color:#64748b;font-size:12px;">${escapeHtml(t.url)}</span>
      </td></tr>`;
    }).join('');
    htmlSections.push(`
      <h3 style="margin:20px 0 8px;font-size:14px;color:${RECOVERED_COLOR};">${RECOVERED_EMOJI} RECOVERED (${recovered.length})</h3>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>`);
  }

  const text = `Uptime Watch report\n${textLines.join('\n')}\n\n-- Uptime Watch`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:600px;">
    <p style="font-size:15px;font-weight:700;">Uptime Watch report</p>
    ${htmlSections.join('') || '<p style="color:#16a34a;">All monitored sites are currently up.</p>'}
    <p style="color:#64748b;font-size:12px;margin-top:24px;">Sent automatically by Uptime Watch. "Mark as Fixed" silences this alert until the next automatic check.</p>
  </div>`;

  return { text, html };
}

// recoveredTargets: [{ siteId, pageId, name, url }] — targets that flipped
// from a problem category to 'up' during THIS check cycle (computed by
// monitor.js, which already has the before/after per target).
async function sendDigestIfNeeded(recoveredTargets) {
  const problems = await store.getProblemTargets();
  const recovered = recoveredTargets || [];
  if (!problems.length && !recovered.length) return { sent: false, reason: 'nothing to report' };

  const subject = buildSubject(problems, recovered);
  const { text, html } = buildBody(problems, recovered);

  let result;
  try {
    result = await sendAlert({ subject, text, html });
  } catch (e) {
    result = { sent: false, reason: e.message };
  }

  try {
    await store.recordMailLog({
      subject,
      recipients: process.env.ALERT_TO_EMAIL || '',
      success: Boolean(result.sent),
      error: result.sent ? null : result.reason,
      issueCount: problems.length,
    });
  } catch (e) {
    console.error('[digest] failed to write mail log:', e.message);
  }

  if (!result.sent) console.warn(`[digest] email not sent: ${result.reason}`);
  else console.log(`[digest] sent "${subject}" (${problems.length} problem(s), ${recovered.length} recovered)`);

  return result;
}

module.exports = { sendDigestIfNeeded };
