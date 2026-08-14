// Auto-discovers pages on a site so you don't have to add every page by hand.
// Tries the site's sitemap first (via robots.txt and the usual sitemap.xml /
// sitemap_index.xml locations) since that's the site's own authoritative
// list of pages; if none is published, falls back to scanning the links on
// the homepage. Deliberately dependency-free (uses regex instead of a real
// XML/HTML parser) to keep the app's install simple — sitemap.xml and <a>/
// <title> tags are simple enough formats that this holds up well in practice.

const axios = require('axios');

const FETCH_TIMEOUT_MS = 6000;
const OVERALL_BUDGET_MS = 20000; // give up gracefully rather than hang a request indefinitely
const TITLE_FETCH_CONCURRENCY = 5;
const MAX_CHILD_SITEMAPS = 10;

const SKIP_EXTENSIONS = /\.(jpe?g|png|gif|svg|webp|ico|bmp|css|js|mjs|json|xml|pdf|zip|rar|7z|gz|mp4|mp3|wav|avi|mov|woff2?|ttf|eot|txt|csv|docx?|xlsx?|pptx?)(\?|#|$)/i;

// Blog posts, tag/category archives, author pages, etc. — usually far more
// numerous than a site's actual business pages, and rarely what you want
// checked hourly. Not excluded outright (some sites are mostly a blog), just
// sorted after everything else when the candidate list has to be capped.
const LIKELY_ARCHIVE_PATH = /\/(blog|news|articles?|posts?|category|categories|tag|tags|author|page\/?\d|\d{4}\/\d{2})(\/|$)/i;

async function fetchText(url) {
  const res = await axios.get(url, {
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: { 'User-Agent': 'UptimeWatch-PageScanner/1.0 (+https://github.com/)' },
  });
  return typeof res.data === 'string' ? res.data : String(res.data);
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

async function getSitemapUrls(origin, deadline) {
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];

  try {
    const robots = await fetchText(`${origin}/robots.txt`);
    robots
      .split('\n')
      .filter((l) => /^sitemap:/i.test(l.trim()))
      .forEach((l) => candidates.unshift(l.split(':').slice(1).join(':').trim()));
  } catch {
    // no robots.txt (or it errored) — the two default sitemap locations are still worth trying
  }

  for (const sitemapUrl of candidates) {
    if (Date.now() > deadline || !sitemapUrl) continue;
    try {
      const xml = await fetchText(sitemapUrl);
      if (/<sitemapindex/i.test(xml)) {
        const childSitemaps = extractLocs(xml).slice(0, MAX_CHILD_SITEMAPS);
        const urls = [];
        for (const child of childSitemaps) {
          if (Date.now() > deadline) break;
          try {
            urls.push(...extractLocs(await fetchText(child)));
          } catch {
            // one broken child sitemap shouldn't sink the whole scan
          }
        }
        if (urls.length) return urls;
      } else if (/<urlset/i.test(xml)) {
        const urls = extractLocs(xml);
        if (urls.length) return urls;
      }
    } catch {
      // try the next candidate location
    }
  }
  return null; // no usable sitemap found anywhere
}

async function crawlHomepageLinks(origin) {
  try {
    const html = await fetchText(origin);
    return [...html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  } catch {
    return [];
  }
}

function normalizeKey(url) {
  return String(url).trim().toLowerCase().replace(/\/+$/, '');
}

// Same-origin, dedup, drop the homepage itself and obvious non-page assets.
function cleanCandidates(rawUrls, origin, rootUrl) {
  const seen = new Set();
  const rootKey = normalizeKey(rootUrl);
  const out = [];
  for (const raw of rawUrls) {
    let abs;
    try {
      abs = new URL(raw, origin);
    } catch {
      continue;
    }
    if (abs.origin !== origin) continue;
    if (SKIP_EXTENSIONS.test(abs.pathname)) continue;
    abs.hash = '';
    const clean = abs.toString();
    const key = normalizeKey(clean);
    if (key === rootKey || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  // Prefer shallower pages (likely primary nav pages) over deep ones, and
  // non-archive pages over blog/tag/category pages, when we have to cap the
  // list — so e.g. "/locations/downtown" outranks "/blog/post-42" even
  // though both are two levels deep.
  out.sort((a, b) => {
    const pathA = new URL(a).pathname;
    const pathB = new URL(b).pathname;
    const da = pathA.split('/').filter(Boolean).length;
    const db = pathB.split('/').filter(Boolean).length;
    if (da !== db) return da - db;
    const archiveA = LIKELY_ARCHIVE_PATH.test(pathA) ? 1 : 0;
    const archiveB = LIKELY_ARCHIVE_PATH.test(pathB) ? 1 : 0;
    if (archiveA !== archiveB) return archiveA - archiveB;
    return a.localeCompare(b);
  });
  return out;
}

function nameFromPath(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || 'Home';
    return last
      .replace(/\.(html?|php|aspx?)$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return url;
  }
}

// Page <title> tags very commonly repeat the site's own name — "Contact -
// Acme Dental", "Acme Dental | Pricing" — which just duplicates the site
// name already shown in the breadcrumb above it. Trim that off when it's an
// exact match on one side of a common separator, so page names stay short
// and specific to the page itself.
function stripSiteName(title, siteName) {
  if (!siteName) return title;
  for (const sep of ['-', '–', '—', '|', '•', '::', ':']) {
    const suffix = ` ${sep} ${siteName}`;
    const prefix = `${siteName} ${sep} `;
    if (title.toLowerCase().endsWith(suffix.toLowerCase())) {
      const trimmed = title.slice(0, title.length - suffix.length).trim();
      if (trimmed) return trimmed;
    } else if (title.toLowerCase().startsWith(prefix.toLowerCase())) {
      const trimmed = title.slice(prefix.length).trim();
      if (trimmed) return trimmed;
    }
  }
  return title;
}

async function titleFor(url, siteName) {
  try {
    const html = await fetchText(url);
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    let title = match && match[1].replace(/\s+/g, ' ').trim();
    if (title) {
      title = stripSiteName(title, siteName);
      return title.length > 80 ? `${title.slice(0, 77)}…` : title;
    }
  } catch {
    // page didn't respond in time / errored — name it from the URL instead
  }
  return nameFromPath(url);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return results;
}

// Discovers up to `limit` pages on a site: tries its sitemap first, falls
// back to the links on its homepage. Never throws — returns [] if nothing
// usable turns up (no sitemap, no reachable homepage, everything filtered
// out) or the time budget runs out. Result: [{ name, url }, ...].
async function discoverPages(rootUrl, { limit = 25, siteName } = {}) {
  let origin;
  try {
    origin = new URL(rootUrl).origin;
  } catch {
    return [];
  }
  const deadline = Date.now() + OVERALL_BUDGET_MS;

  let rawUrls = null;
  try {
    rawUrls = await getSitemapUrls(origin, deadline);
  } catch {
    rawUrls = null;
  }
  if (!rawUrls || !rawUrls.length) {
    rawUrls = await crawlHomepageLinks(origin);
  }

  const candidates = cleanCandidates(rawUrls || [], origin, rootUrl).slice(0, limit);
  if (!candidates.length) return [];

  return mapWithConcurrency(candidates, TITLE_FETCH_CONCURRENCY, async (url) => {
    if (Date.now() > deadline) return { name: nameFromPath(url), url };
    return { name: await titleFor(url, siteName), url };
  });
}

module.exports = { discoverPages };
