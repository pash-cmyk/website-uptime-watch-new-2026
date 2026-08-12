// Orchestrates a monitoring pass: check every site, record the result, and
// fire an email alert when a site's status changes (goes down, or recovers).

const store = require('./store');
const { checkUrl } = require('./checker');
const { sendAlert } = require('./mailer');

async function checkOneSite(site) {
  const prevHistory = await store.getHistory(site.id, { limit: 1 });
  const prevEntry = prevHistory[0] || null;

  const result = await checkUrl(site.url);
  await store.recordCheck(site.id, result);

  const wasOk = prevEntry ? prevEntry.ok : true; // assume ok if never checked, to avoid a false "recovered" email on first run
  const isOk = result.ok;

  if (wasOk && !isOk) {
    await sendAlert(buildDownAlert(site, result));
  } else if (!wasOk && isOk) {
    await sendAlert(buildRecoveredAlert(site, result));
  }

  return result;
}

async function checkAllSites() {
  const sites = await store.listSites();
  const results = [];
  for (const site of sites) {
    // Sequential on purpose — gentle on outbound connections and easy to read in logs.
    const result = await checkOneSite(site);
    results.push({ site, result });
    console.log(`[monitor] ${site.name} (${site.url}) -> ${result.category.toUpperCase()} ${result.httpStatus || ''} ${result.error || ''}`.trim());
  }
  return results;
}

function buildDownAlert(site, result) {
  const detail = result.error || `HTTP ${result.httpStatus}`;
  return {
    subject: `🔴 Website Down Alert: ${site.name}`,
    text: `${site.name} (${site.url}) appears to be DOWN.\n\nDetail: ${detail}\nChecked at: ${result.ts}\n\n— Uptime Watch`,
    html: `<p><strong>${escapeHtml(site.name)}</strong> (<a href="${site.url}">${site.url}</a>) appears to be <strong style="color:#dc2626">DOWN</strong>.</p>
           <p><strong>Detail:</strong> ${escapeHtml(detail)}<br/><strong>Checked at:</strong> ${result.ts}</p>
           <p style="color:#64748b;font-size:13px">Sent automatically by Uptime Watch.</p>`,
  };
}

function buildRecoveredAlert(site, result) {
  return {
    subject: `✅ Website Recovered: ${site.name}`,
    text: `Good news — ${site.name} (${site.url}) is back UP.\n\nHTTP status: ${result.httpStatus}\nResponse time: ${result.responseTimeMs}ms\nChecked at: ${result.ts}\n\n— Uptime Watch`,
    html: `<p>Good news — <strong>${escapeHtml(site.name)}</strong> (<a href="${site.url}">${site.url}</a>) is back <strong style="color:#16a34a">UP</strong>.</p>
           <p><strong>HTTP status:</strong> ${result.httpStatus}<br/><strong>Response time:</strong> ${result.responseTimeMs}ms<br/><strong>Checked at:</strong> ${result.ts}</p>
           <p style="color:#64748b;font-size:13px">Sent automatically by Uptime Watch.</p>`,
  };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { checkAllSites, checkOneSite };
