// Orchestrates a monitoring pass: check every site (and every page under each
// site), record the result, and fire an email alert when a target's status
// changes (goes down, or recovers).

const store = require('./store');
const { checkUrl } = require('./checker');
const { sendAlert } = require('./mailer');
const { discoverPages } = require('./discover');

// How many pages a single scan (automatic, on adding a site, or a manual
// "Scan for pages" click) will add at most.
const PAGE_DISCOVERY_LIMIT = 25;

// target: { siteId, pageId (null for the site's own root URL), name, url }
async function checkTarget(target) {
  const prevHistory = await store.getHistory(target.siteId, { pageId: target.pageId, limit: 1 });
  const prevEntry = prevHistory[0] || null;

  const result = await checkUrl(target.url);
  await store.recordCheck(target.siteId, result, target.pageId);

  const wasOk = prevEntry ? prevEntry.ok : true; // assume ok if never checked, to avoid a false "recovered" email on first run
  const isOk = result.ok;

  if (wasOk && !isOk) {
    await sendAlert(buildDownAlert(target, result));
  } else if (!wasOk && isOk) {
    await sendAlert(buildRecoveredAlert(target, result));
  }

  return result;
}

// Back-compat wrapper: checking a whole site (its own root URL).
async function checkOneSite(site) {
  return checkTarget({ siteId: site.id, pageId: null, name: site.name, url: site.url });
}

async function checkOnePage(site, page) {
  return checkTarget({ siteId: site.id, pageId: page.id, name: `${page.name} (${site.name})`, url: page.url });
}

// Checks one site's root URL plus every page tracked under it — what the
// site-detail dashboard's "Check now" button triggers, so a single click
// refreshes everything shown on that page (not just the root URL).
async function checkAllForSite(site) {
  const results = [];
  const rootResult = await checkOneSite(site);
  results.push({ site, result: rootResult });

  const pages = await store.listPages(site.id);
  for (const page of pages) {
    const pageResult = await checkOnePage(site, page);
    results.push({ site, page, result: pageResult });
  }
  return results;
}

// Scans a site for its pages (sitemap first, homepage-link crawl as a
// fallback) and adds whatever it finds — up to `limit` — as tracked pages.
// Safe to call on a site that already has pages: addPagesBulk dedupes by URL,
// so already-tracked pages are left exactly as they are, never duplicated or
// removed; only genuinely new ones get added. Newly added pages are checked
// immediately, same as any other page add.
async function discoverAndAddPages(site, opts = {}) {
  const limit = opts.limit || PAGE_DISCOVERY_LIMIT;
  const found = await discoverPages(site.url, { limit, siteName: site.name });
  if (!found.length) return { discoveredCount: 0, createdCount: 0, skippedCount: 0 };

  const { created, skipped } = await store.addPagesBulk(site.id, found);
  for (const page of created) {
    try {
      await checkOnePage(site, page);
    } catch (e) {
      console.error('[monitor] initial check failed for discovered page', page.url, e.message);
    }
  }
  return { discoveredCount: found.length, createdCount: created.length, skippedCount: skipped.length };
}

async function checkAllSites() {
  const sites = await store.listSites();
  const results = [];
  for (const site of sites) {
    const result = await checkOneSite(site);
    results.push({ site, result });
    console.log(`[monitor] ${site.name} (${site.url}) -> ${result.category.toUpperCase()} ${result.httpStatus || ''} ${result.error || ''}`.trim());

    const pages = await store.listPages(site.id);
    for (const page of pages) {
      const pageResult = await checkOnePage(site, page);
      results.push({ site, page, result: pageResult });
      console.log(`[monitor]   ↳ page ${page.name} (${page.url}) -> ${pageResult.category.toUpperCase()} ${pageResult.httpStatus || ''} ${pageResult.error || ''}`.trim());
    }
  }
  return results;
}

function buildDownAlert(target, result) {
  const detail = result.error || `HTTP ${result.httpStatus}`;
  return {
    subject: `🔴 Down Alert: ${target.name}`,
    text: `${target.name} (${target.url}) appears to be DOWN.\n\nDetail: ${detail}\nChecked at: ${result.ts}\n\n— Uptime Watch`,
    html: `<p><strong>${escapeHtml(target.name)}</strong> (<a href="${target.url}">${target.url}</a>) appears to be <strong style="color:#dc2626">DOWN</strong>.</p>
           <p><strong>Detail:</strong> ${escapeHtml(detail)}<br/><strong>Checked at:</strong> ${result.ts}</p>
           <p style="color:#64748b;font-size:13px">Sent automatically by Uptime Watch.</p>`,
  };
}

function buildRecoveredAlert(target, result) {
  return {
    subject: `✅ Recovered: ${target.name}`,
    text: `Good news — ${target.name} (${target.url}) is back UP.\n\nHTTP status: ${result.httpStatus}\nResponse time: ${result.responseTimeMs}ms\nChecked at: ${result.ts}\n\n— Uptime Watch`,
    html: `<p>Good news — <strong>${escapeHtml(target.name)}</strong> (<a href="${target.url}">${target.url}</a>) is back <strong style="color:#16a34a">UP</strong>.</p>
           <p><strong>HTTP status:</strong> ${result.httpStatus}<br/><strong>Response time:</strong> ${result.responseTimeMs}ms<br/><strong>Checked at:</strong> ${result.ts}</p>
           <p style="color:#64748b;font-size:13px">Sent automatically by Uptime Watch.</p>`,
  };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = {
  checkAllSites,
  checkOneSite,
  checkOnePage,
  checkAllForSite,
  checkTarget,
  discoverAndAddPages,
  PAGE_DISCOVERY_LIMIT,
};
