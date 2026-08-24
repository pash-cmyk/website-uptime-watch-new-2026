// Orchestrates a monitoring pass: check every site (and every page under each
// site), record the result, and — once a full pass finishes — send a single
// consolidated digest email covering everything currently in trouble plus
// anything that just recovered, instead of a separate email per target.

const store = require('./store');
const { checkUrl } = require('./checker');
const { discoverPages } = require('./discover');
const { sendDigestIfNeeded } = require('./digest');

// How many pages a single scan (automatic, on adding a site, or a manual
// "Scan for pages" click) will add at most.
const PAGE_DISCOVERY_LIMIT = 25;

// target: { siteId, pageId (null for the site's own root URL), name, url }
// Returns the check result plus `justRecovered` — true when this target was
// in trouble (any non-'up' category) on its previous check and is fully 'up'
// now, so checkAllSites() can fold that into the one digest email for this
// cycle instead of firing a separate "recovered" email per target.
async function checkTarget(target) {
  const prevHistory = await store.getHistory(target.siteId, { pageId: target.pageId, limit: 1 });
  const prevEntry = prevHistory[0] || null;

  const result = await checkUrl(target.url);
  await store.recordCheck(target.siteId, result, target.pageId);

  const prevCategory = prevEntry ? prevEntry.category : 'up'; // assume up if never checked, to avoid a false "recovered" note on first run
  const justRecovered = prevCategory !== 'up' && result.category === 'up';

  return { ...result, justRecovered };
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

// Checks every site (and every page under each), then sends one digest email
// for the whole pass — this is what the scheduler, the homepage "Check all"
// button, and server boot all call. Manual single-site/single-page rechecks
// (checkOneSite/checkOnePage/checkAllForSite called directly) deliberately
// do NOT trigger a digest send on their own, so clicking "↻" on one card
// doesn't fire off a report about the whole system.
async function checkAllSites() {
  const sites = await store.listSites();
  const results = [];
  const recovered = [];
  for (const site of sites) {
    const result = await checkOneSite(site);
    results.push({ site, result });
    console.log(`[monitor] ${site.name} (${site.url}) -> ${result.category.toUpperCase()} ${result.httpStatus || ''} ${result.error || ''}`.trim());
    if (result.justRecovered) recovered.push({ siteId: site.id, pageId: null, name: site.name, url: site.url });

    const pages = await store.listPages(site.id);
    for (const page of pages) {
      const pageResult = await checkOnePage(site, page);
      results.push({ site, page, result: pageResult });
      console.log(`[monitor]   ↳ page ${page.name} (${page.url}) -> ${pageResult.category.toUpperCase()} ${pageResult.httpStatus || ''} ${pageResult.error || ''}`.trim());
      if (pageResult.justRecovered) recovered.push({ siteId: site.id, pageId: page.id, name: `${page.name} (${site.name})`, url: page.url });
    }
  }

  // Same as check failures elsewhere: a broken/misconfigured mail provider
  // must never break the check run itself — worst case here is a missed
  // digest email, logged clearly, not a crashed scheduler.
  try {
    await sendDigestIfNeeded(recovered);
  } catch (e) {
    console.error('[monitor] digest send failed:', e.message);
  }

  return results;
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
