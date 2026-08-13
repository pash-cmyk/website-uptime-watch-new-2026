// Postgres-backed data store (designed for a free serverless Postgres like
// Neon). Replaces the earlier Excel-file store, whose data lived on the app
// server's local disk and was wiped whenever the hosting platform recycled
// the container (no persistent disk on most free tiers). A managed Postgres
// database is its own durable service, independent of the app's lifecycle.
//
// Schema: sites -> pages (optional children) -> checks (belong to a site,
// and optionally to one of that site's pages). settings is just a key/value
// table for the live-adjustable scheduler config.

const { Pool } = require('pg');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  console.error('\n[store] DATABASE_URL is not set. This app needs a Postgres connection string');
  console.error('[store] (e.g. from a free Neon database) in your .env / Render environment variables.\n');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
});

const DEFAULT_SETTINGS = {
  checkIntervalCron: '0 * * * *',
  requestTimeoutMs: '10000',
};

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS checks (
      id BIGSERIAL PRIMARY KEY,
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
      ts TIMESTAMPTZ NOT NULL,
      ok BOOLEAN NOT NULL,
      category TEXT NOT NULL,
      http_status INTEGER,
      response_time_ms INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_checks_scope_ts ON checks (site_id, page_id, ts);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const seed = key === 'checkIntervalCron' ? process.env.CHECK_INTERVAL_CRON : process.env.REQUEST_TIMEOUT_MS;
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, seed || value]
    );
  }
}

const ready = migrate().catch((e) => {
  console.error('[store] Failed to connect/migrate Postgres:', e.message);
  process.exit(1);
});

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function normalizeUrlKey(url) {
  return String(url).trim().toLowerCase().replace(/\/+$/, '');
}

function rowToCheck(r) {
  return {
    ts: r.ts.toISOString(),
    ok: r.ok,
    category: r.category,
    httpStatus: r.http_status,
    responseTimeMs: r.response_time_ms,
    error: r.error,
  };
}

function computeStats(history) {
  const window = history.slice(-168); // ~7 days if hourly
  const last = history[history.length - 1] || null;
  const upCount = window.filter((h) => h.ok).length;
  const uptimePct = window.length ? Math.round((upCount / window.length) * 1000) / 10 : null;
  const respTimes = window.filter((h) => typeof h.responseTimeMs === 'number').map((h) => h.responseTimeMs);
  const avgResponseMs = respTimes.length ? Math.round(respTimes.reduce((a, b) => a + b, 0) / respTimes.length) : null;
  return { latest: last, uptimePct, avgResponseMs, checksRecorded: history.length };
}

// ---- Sites ----

async function listSites() {
  await ready;
  const { rows: sites } = await pool.query('SELECT id, name, url, created_at FROM sites ORDER BY created_at ASC');
  const out = [];
  for (const s of sites) {
    const { rows: checks } = await pool.query(
      'SELECT ts, ok, category, http_status, response_time_ms, error FROM checks WHERE site_id = $1 AND page_id IS NULL ORDER BY ts ASC',
      [s.id]
    );
    out.push({ id: s.id, name: s.name, url: s.url, createdAt: s.created_at.toISOString(), ...computeStats(checks.map(rowToCheck)) });
  }
  return out;
}

async function getSite(id) {
  await ready;
  const { rows } = await pool.query('SELECT id, name, url, created_at FROM sites WHERE id = $1', [id]);
  if (!rows.length) return null;
  const s = rows[0];
  const { rows: checks } = await pool.query(
    'SELECT ts, ok, category, http_status, response_time_ms, error FROM checks WHERE site_id = $1 AND page_id IS NULL ORDER BY ts ASC',
    [id]
  );
  return { id: s.id, name: s.name, url: s.url, createdAt: s.created_at.toISOString(), ...computeStats(checks.map(rowToCheck)) };
}

async function addSite(name, url) {
  await ready;
  const site = { id: newId(), name: name.trim(), url: url.trim() };
  const { rows } = await pool.query(
    'INSERT INTO sites (id, name, url) VALUES ($1, $2, $3) RETURNING created_at',
    [site.id, site.name, site.url]
  );
  return { ...site, createdAt: rows[0].created_at.toISOString() };
}

async function addSitesBulk(entries) {
  await ready;
  const { rows: existing } = await pool.query('SELECT url FROM sites');
  const existingUrls = new Set(existing.map((r) => normalizeUrlKey(r.url)));
  const created = [];
  const skipped = [];

  for (const entry of entries) {
    const key = normalizeUrlKey(entry.url);
    if (existingUrls.has(key)) { skipped.push(entry); continue; }
    const site = { id: newId(), name: entry.name.trim(), url: entry.url.trim() };
    await pool.query('INSERT INTO sites (id, name, url) VALUES ($1, $2, $3)', [site.id, site.name, site.url]);
    existingUrls.add(key);
    created.push(site);
  }
  return { created, skipped };
}

async function removeSite(id) {
  await ready;
  const { rowCount } = await pool.query('DELETE FROM sites WHERE id = $1', [id]);
  return rowCount > 0; // ON DELETE CASCADE takes care of pages + checks
}

// ---- Pages ----

async function listPages(siteId) {
  await ready;
  const { rows: pages } = await pool.query('SELECT id, name, url, created_at FROM pages WHERE site_id = $1 ORDER BY created_at ASC', [siteId]);
  const out = [];
  for (const p of pages) {
    const { rows: checks } = await pool.query(
      'SELECT ts, ok, category, http_status, response_time_ms, error FROM checks WHERE site_id = $1 AND page_id = $2 ORDER BY ts ASC',
      [siteId, p.id]
    );
    out.push({ id: p.id, siteId, name: p.name, url: p.url, createdAt: p.created_at.toISOString(), ...computeStats(checks.map(rowToCheck)) });
  }
  return out;
}

async function getPage(siteId, pageId) {
  await ready;
  const { rows } = await pool.query('SELECT id, name, url, created_at FROM pages WHERE site_id = $1 AND id = $2', [siteId, pageId]);
  if (!rows.length) return null;
  const p = rows[0];
  const { rows: checks } = await pool.query(
    'SELECT ts, ok, category, http_status, response_time_ms, error FROM checks WHERE site_id = $1 AND page_id = $2 ORDER BY ts ASC',
    [siteId, pageId]
  );
  return { id: p.id, siteId, name: p.name, url: p.url, createdAt: p.created_at.toISOString(), ...computeStats(checks.map(rowToCheck)) };
}

async function addPage(siteId, name, url) {
  await ready;
  const page = { id: newId(), siteId, name: name.trim(), url: url.trim() };
  const { rows } = await pool.query(
    'INSERT INTO pages (id, site_id, name, url) VALUES ($1, $2, $3, $4) RETURNING created_at',
    [page.id, siteId, page.name, page.url]
  );
  return { ...page, createdAt: rows[0].created_at.toISOString() };
}

async function addPagesBulk(siteId, entries) {
  await ready;
  const { rows: existing } = await pool.query('SELECT url FROM pages WHERE site_id = $1', [siteId]);
  const existingUrls = new Set(existing.map((r) => normalizeUrlKey(r.url)));
  const created = [];
  const skipped = [];

  for (const entry of entries) {
    const key = normalizeUrlKey(entry.url);
    if (existingUrls.has(key)) { skipped.push(entry); continue; }
    const page = { id: newId(), siteId, name: entry.name.trim(), url: entry.url.trim() };
    await pool.query('INSERT INTO pages (id, site_id, name, url) VALUES ($1, $2, $3, $4)', [page.id, siteId, page.name, page.url]);
    existingUrls.add(key);
    created.push(page);
  }
  return { created, skipped };
}

async function removePage(siteId, pageId) {
  await ready;
  const { rowCount } = await pool.query('DELETE FROM pages WHERE site_id = $1 AND id = $2', [siteId, pageId]);
  return rowCount > 0;
}

// ---- Checks ----

async function recordCheck(siteId, entry, pageId = null) {
  await ready;
  await pool.query(
    `INSERT INTO checks (site_id, page_id, ts, ok, category, http_status, response_time_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [siteId, pageId, entry.ts, entry.ok, entry.category, entry.httpStatus, entry.responseTimeMs, entry.error]
  );
}

async function getHistory(siteId, opts = {}) {
  await ready;
  const pageId = opts.pageId || null;
  const clauses = ['site_id = $1', pageId ? 'page_id = $2' : 'page_id IS NULL'];
  const params = pageId ? [siteId, pageId] : [siteId];
  if (opts.from) { params.push(opts.from); clauses.push(`ts >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); clauses.push(`ts <= $${params.length}`); }
  let sql = `SELECT ts, ok, category, http_status, response_time_ms, error FROM checks WHERE ${clauses.join(' AND ')} ORDER BY ts ASC`;
  if (opts.limit) { params.push(opts.limit); sql = `SELECT * FROM (${sql.replace('ORDER BY ts ASC', 'ORDER BY ts DESC')} LIMIT $${params.length}) sub ORDER BY ts ASC`; }
  const { rows } = await pool.query(sql, params);
  return rows.map(rowToCheck);
}

// ---- Settings ----

async function getSettings() {
  await ready;
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const settings = { ...DEFAULT_SETTINGS };
  rows.forEach((r) => { settings[r.key] = r.value; });
  return settings;
}

async function updateSettings(partial) {
  await ready;
  for (const [key, value] of Object.entries(partial)) {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, String(value)]
    );
  }
  return getSettings();
}

// ---- Analytics ----

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10 : sorted[mid];
}

async function getCollectiveAnalytics() {
  const sites = await listSites();
  const uptimes = sites.map((s) => s.uptimePct).filter((v) => typeof v === 'number');
  const responses = sites.map((s) => s.avgResponseMs).filter((v) => typeof v === 'number');
  const up = sites.filter((s) => s.latest && s.latest.category === 'up').length;
  const warning = sites.filter((s) => s.latest && s.latest.category === 'warning').length;
  const down = sites.filter((s) => s.latest && s.latest.category === 'down').length;
  const unchecked = sites.filter((s) => !s.latest).length;

  const { rows: pageCountRows } = await pool.query('SELECT COUNT(*)::int AS count FROM pages');

  return {
    totalSites: sites.length,
    totalPages: pageCountRows[0].count,
    up,
    warning,
    down,
    unchecked,
    medianUptimePct: median(uptimes),
    medianResponseMs: median(responses),
    avgUptimePct: uptimes.length ? Math.round((uptimes.reduce((a, b) => a + b, 0) / uptimes.length) * 10) / 10 : null,
    avgResponseMs: responses.length ? Math.round(responses.reduce((a, b) => a + b, 0) / responses.length) : null,
  };
}

async function computeAnalyticsFromHistory(siteId, opts) {
  const history = await getHistory(siteId, opts);
  const upCount = history.filter((h) => h.ok).length;
  const uptimePct = history.length ? Math.round((upCount / history.length) * 1000) / 10 : null;
  const responses = history.filter((h) => typeof h.responseTimeMs === 'number').map((h) => h.responseTimeMs);
  const avgResponseMs = responses.length ? Math.round(responses.reduce((a, b) => a + b, 0) / responses.length) : null;
  const medianResponseMs = median(responses);

  let incidents = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i - 1].ok && !history[i].ok) incidents++;
  }

  const byDay = new Map();
  for (const h of history) {
    const day = h.ts.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(h);
  }
  const dailySummary = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, checks]) => {
      const dayUp = checks.filter((c) => c.ok).length;
      const dayResponses = checks.filter((c) => typeof c.responseTimeMs === 'number').map((c) => c.responseTimeMs);
      return {
        date,
        checksCount: checks.length,
        upCount: dayUp,
        downCount: checks.length - dayUp,
        uptimePct: Math.round((dayUp / checks.length) * 1000) / 10,
        avgResponseMs: dayResponses.length ? Math.round(dayResponses.reduce((a, b) => a + b, 0) / dayResponses.length) : null,
        firstCheck: checks[0].ts,
        lastCheck: checks[checks.length - 1].ts,
        checks,
      };
    });

  return {
    totalChecks: history.length,
    uptimePct,
    avgResponseMs,
    medianResponseMs,
    incidents,
    dailySummary,
    series: history.map((h) => ({ ts: h.ts, responseTimeMs: h.responseTimeMs, category: h.category, ok: h.ok })),
  };
}

async function getSiteAnalytics(siteId, opts = {}) {
  return computeAnalyticsFromHistory(siteId, { from: opts.from, to: opts.to });
}

async function getPageAnalytics(siteId, pageId, opts = {}) {
  return computeAnalyticsFromHistory(siteId, { from: opts.from, to: opts.to, pageId });
}

// ---- Export (on-demand spreadsheet snapshot, for backups) ----

async function exportWorkbookBuffer() {
  await ready;
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();

  const sitesSheet = wb.addWorksheet('Sites');
  sitesSheet.addRow(['id', 'name', 'url', 'createdAt']);
  const { rows: sites } = await pool.query('SELECT id, name, url, created_at FROM sites ORDER BY created_at');
  sites.forEach((s) => sitesSheet.addRow([s.id, s.name, s.url, s.created_at.toISOString()]));

  const pagesSheet = wb.addWorksheet('Pages');
  pagesSheet.addRow(['id', 'siteId', 'name', 'url', 'createdAt']);
  const { rows: pages } = await pool.query('SELECT id, site_id, name, url, created_at FROM pages ORDER BY created_at');
  pages.forEach((p) => pagesSheet.addRow([p.id, p.site_id, p.name, p.url, p.created_at.toISOString()]));

  const checksSheet = wb.addWorksheet('Checks');
  checksSheet.addRow(['siteId', 'pageId', 'ts', 'ok', 'category', 'httpStatus', 'responseTimeMs', 'error']);
  const { rows: checks } = await pool.query('SELECT site_id, page_id, ts, ok, category, http_status, response_time_ms, error FROM checks ORDER BY ts');
  checks.forEach((c) => checksSheet.addRow([c.site_id, c.page_id, c.ts.toISOString(), c.ok, c.category, c.http_status, c.response_time_ms, c.error]));

  const settingsSheet = wb.addWorksheet('Settings');
  settingsSheet.addRow(['key', 'value']);
  const settings = await getSettings();
  Object.entries(settings).forEach(([k, v]) => settingsSheet.addRow([k, v]));

  return wb.xlsx.writeBuffer();
}

module.exports = {
  listSites,
  getSite,
  addSite,
  addSitesBulk,
  removeSite,
  listPages,
  getPage,
  addPage,
  addPagesBulk,
  removePage,
  recordCheck,
  getHistory,
  getSettings,
  updateSettings,
  getCollectiveAnalytics,
  getSiteAnalytics,
  getPageAnalytics,
  exportWorkbookBuffer,
};
