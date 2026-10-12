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
  // Comma-separated list of email addresses that receive the digest alert —
  // editable live from the dashboard's Settings panel (no redeploy needed).
  alertRecipients: '',
  // A successful (2xx/3xx) response slower than this is classified 'slow'
  // rather than 'up' — a performance problem, distinct from an actual
  // availability failure ('down').
  slowThresholdMs: '3000',
};

// Which env var seeds each setting the FIRST time the app runs against a
// brand-new database (after that, the database is the source of truth).
const SETTINGS_ENV_SEED = {
  checkIntervalCron: 'CHECK_INTERVAL_CRON',
  requestTimeoutMs: 'REQUEST_TIMEOUT_MS',
  alertRecipients: 'ALERT_TO_EMAIL',
  slowThresholdMs: 'SLOW_THRESHOLD_MS',
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
    -- Set (independently of the live check result) when someone clicks
    -- "Mark as Fixed" — either from the digest email or in the dashboard.
    -- It silences that one target's alerts immediately, but only until the
    -- NEXT automatic check records a newer result: comparing timestamps
    -- (rather than clearing a flag) means there's no separate "un-silence"
    -- step to get wrong, and a still-broken site reliably reappears in the
    -- very next report.
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
    -- Internal-only flag for downtime entered by hand (the hidden "add
    -- downtime" shortcut on the site page). Nothing in the UI reads it —
    -- manual rows deliberately look identical to automatic ones — but it's
    -- kept so they can always be told apart in the database / Excel export.
    ALTER TABLE checks ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT false;
    -- A record of every digest email attempt — who it went to, what it said,
    -- and whether it actually sent — shown in the dashboard's Mail log view.
    CREATE TABLE IF NOT EXISTS mail_log (
      id BIGSERIAL PRIMARY KEY,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      subject TEXT NOT NULL,
      recipients TEXT NOT NULL,
      success BOOLEAN NOT NULL,
      error TEXT,
      issue_count INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mail_log_sent_at ON mail_log (sent_at DESC);
  `);

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const seed = process.env[SETTINGS_ENV_SEED[key]];
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

// A site's overall status is never just its root URL's status — it's every
// target under it (the root, plus every tracked page) considered together.
//
// 'slow' targets DID succeed (a real 2xx/3xx response, just a slow one), so
// they count as healthy for this rollup — same as 'up' — and must never be
// folded into 'warning'/'down' territory. That's the whole point of keeping
// Slow and Down separate: a team glancing at the dashboard should never read
// "degraded performance" as "the site is broken".
//
// all healthy (up/slow) -> up, or 'slow' if at least one target was slow.
// nothing healthy at all -> down (a real, total failure).
// anything in between (some healthy, some not) -> warning, a genuine partial
// problem even if the homepage itself is perfectly reachable.
function aggregateStatus(targets) {
  const total = targets.length;
  if (!total) return { status: 'unknown', up: 0, slow: 0, warning: 0, down: 0, total: 0 };
  const up = targets.filter((t) => t.category === 'up').length;
  const slow = targets.filter((t) => t.category === 'slow').length;
  const warning = targets.filter((t) => t.category === 'warning').length;
  const down = targets.filter((t) => t.category === 'down').length;
  const healthy = up + slow;
  let status;
  if (healthy === total) status = slow > 0 ? 'slow' : 'up';
  else if (healthy === 0) status = 'down';
  else status = 'warning';
  return { status, up, slow, warning, down, total };
}

function withAggregateFields(obj, agg) {
  return {
    ...obj,
    aggregateStatus: agg.status,
    targetsUp: agg.up,
    targetsSlow: agg.slow,
    targetsWarning: agg.warning,
    targetsDown: agg.down,
    targetsTotal: agg.total,
  };
}

// A "Mark as Fixed" click silences a target's alerts (and its displayed
// status) as long as the acknowledgment is NEWER than the latest recorded
// check — the instant a fresh check comes in with its own timestamp, the
// acknowledgment is stale and the real, current category takes over again.
// No separate flag to clear, no risk of a silence outliving its purpose.
function isAcknowledged(acknowledgedAt, latestTs) {
  if (!acknowledgedAt || !latestTs) return false;
  return new Date(acknowledgedAt).getTime() >= new Date(latestTs).getTime();
}

// The most recent check for every target (a site's root URL, and each of its
// pages) across every site, in one query — used to compute each site's
// aggregate status without an extra round-trip per page. Each target's own
// "Mark as Fixed" acknowledgment (the site's for its root URL, the page's
// own for a page — never inherited from one to the other) is applied here so
// aggregateStatus() always reflects what the dashboard/digest should treat
// as true right now, not necessarily the raw last check.
async function getLatestStatusesBySite() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (c.site_id, c.page_id) c.site_id, c.page_id, c.category, c.ts,
           COALESCE(p.acknowledged_at, s.acknowledged_at) AS acknowledged_at
    FROM checks c
    JOIN sites s ON s.id = c.site_id
    LEFT JOIN pages p ON p.id = c.page_id
    ORDER BY c.site_id, c.page_id NULLS FIRST, c.ts DESC
  `);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.site_id)) map.set(r.site_id, []);
    const category = isAcknowledged(r.acknowledged_at, r.ts) ? 'up' : r.category;
    map.get(r.site_id).push({ category });
  }
  return map;
}

// ---- Sites ----

// Applies a target's own "Mark as Fixed" acknowledgment to its displayed
// `latest` check (from computeStats) — leaves real history untouched, this
// only affects what's shown as the CURRENT status.
function withAcknowledgement(stats, acknowledgedAt) {
  const acknowledged = isAcknowledged(acknowledgedAt, stats.latest && stats.latest.ts);
  return {
    ...stats,
    latest: acknowledged ? { ...stats.latest, category: 'up', ok: true } : stats.latest,
    acknowledged,
    acknowledgedAt: acknowledgedAt ? new Date(acknowledgedAt).toISOString() : null,
  };
}

async function listSites() {
  await ready;
  const { rows: sites } = await pool.query('SELECT id, name, url, created_at, acknowledged_at FROM sites ORDER BY created_at ASC');
  const { rows: pageCounts } = await pool.query('SELECT site_id, COUNT(*)::int AS count FROM pages GROUP BY site_id');
  const countMap = new Map(pageCounts.map((r) => [r.site_id, r.count]));
  const latestBySite = await getLatestStatusesBySite();
  const out = [];
  for (const s of sites) {
    const { rows: checks } = await pool.query(
      'SELECT ts, ok, category, http_status, response_time_ms, error FROM checks WHERE site_id = $1 AND page_id IS NULL ORDER BY ts ASC',
      [s.id]
    );
    const agg = aggregateStatus(latestBySite.get(s.id) || []);
    out.push(withAggregateFields({
      id: s.id,
      name: s.name,
      url: s.url,
      createdAt: s.created_at.toISOString(),
      pageCount: countMap.get(s.id) || 0,
      ...withAcknowledgement(computeStats(checks.map(rowToCheck)), s.acknowledged_at),
    }, agg));
  }
  return out;
}

async function getSite(id) {
  await ready;
  const { rows } = await pool.query('SELECT id, name, url, created_at, acknowledged_at FROM sites WHERE id = $1', [id]);
  if (!rows.length) return null;
  const s = rows[0];
  const { rows: checks } = await pool.query(
    'SELECT ts, ok, category, http_status, response_time_ms, error FROM checks WHERE site_id = $1 AND page_id IS NULL ORDER BY ts ASC',
    [id]
  );
  const { rows: pageCountRows } = await pool.query('SELECT COUNT(*)::int AS count FROM pages WHERE site_id = $1', [id]);
  const { rows: latestRows } = await pool.query(
    `SELECT DISTINCT ON (c.page_id) c.page_id, c.category, c.ts,
            COALESCE(p.acknowledged_at, s.acknowledged_at) AS acknowledged_at
     FROM checks c
     JOIN sites s ON s.id = c.site_id
     LEFT JOIN pages p ON p.id = c.page_id
     WHERE c.site_id = $1
     ORDER BY c.page_id NULLS FIRST, c.ts DESC`,
    [id]
  );
  const agg = aggregateStatus(latestRows.map((r) => ({
    category: isAcknowledged(r.acknowledged_at, r.ts) ? 'up' : r.category,
  })));
  return withAggregateFields({
    id: s.id,
    name: s.name,
    url: s.url,
    createdAt: s.created_at.toISOString(),
    pageCount: pageCountRows[0].count,
    ...withAcknowledgement(computeStats(checks.map(rowToCheck)), s.acknowledged_at),
  }, agg);
}

// Marks a site's root URL as fixed — silences its alerts/status until the
// next automatic check records a newer result (see isAcknowledged above).
async function acknowledgeSite(id) {
  await ready;
  const { rowCount } = await pool.query('UPDATE sites SET acknowledged_at = now() WHERE id = $1', [id]);
  return rowCount > 0;
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
  const { rows: pages } = await pool.query('SELECT id, name, url, created_at, acknowledged_at FROM pages WHERE site_id = $1 ORDER BY created_at ASC', [siteId]);
  const out = [];
  for (const p of pages) {
    const { rows: checks } = await pool.query(
      'SELECT ts, ok, category, http_status, response_time_ms, error FROM checks WHERE site_id = $1 AND page_id = $2 ORDER BY ts ASC',
      [siteId, p.id]
    );
    out.push({
      id: p.id, siteId, name: p.name, url: p.url, createdAt: p.created_at.toISOString(),
      ...withAcknowledgement(computeStats(checks.map(rowToCheck)), p.acknowledged_at),
    });
  }
  return out;
}

async function getPage(siteId, pageId) {
  await ready;
  const { rows } = await pool.query('SELECT id, name, url, created_at, acknowledged_at FROM pages WHERE site_id = $1 AND id = $2', [siteId, pageId]);
  if (!rows.length) return null;
  const p = rows[0];
  const { rows: checks } = await pool.query(
    'SELECT ts, ok, category, http_status, response_time_ms, error FROM checks WHERE site_id = $1 AND page_id = $2 ORDER BY ts ASC',
    [siteId, pageId]
  );
  return {
    id: p.id, siteId, name: p.name, url: p.url, createdAt: p.created_at.toISOString(),
    ...withAcknowledgement(computeStats(checks.map(rowToCheck)), p.acknowledged_at),
  };
}

// Marks a single page as fixed — same "silenced until the next automatic
// check" behavior as acknowledgeSite, scoped to just this page.
async function acknowledgePage(siteId, pageId) {
  await ready;
  const { rowCount } = await pool.query(
    'UPDATE pages SET acknowledged_at = now() WHERE site_id = $1 AND id = $2',
    [siteId, pageId]
  );
  return rowCount > 0;
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

// ---- Manual downtime (hidden feature) -------------------------------------
//
// Lets someone back-fill an outage the monitor missed (e.g. the server was
// asleep, or the outage fell between two scheduled checks). It's stored as a
// run of ordinary 'down' check rows spaced at the target's normal check
// cadence, so every chart, daily log, uptime % and export treats it exactly
// like an outage the monitor itself recorded.
const MANUAL_MAX_DAYS = 14;
const MANUAL_MAX_ROWS = 5000;

class ManualDowntimeError extends Error {}

async function addManualDowntime(siteId, pageId, startIso, endIso, note) {
  await ready;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (isNaN(start) || isNaN(end)) throw new ManualDowntimeError('Start and end must be valid dates and times.');
  if (start >= end) throw new ManualDowntimeError('The end time must be after the start time.');
  if ((end - start) > MANUAL_MAX_DAYS * 86400000) throw new ManualDowntimeError(`A single entry can cover at most ${MANUAL_MAX_DAYS} days.`);

  const site = await getSite(siteId);
  if (!site) throw new ManualDowntimeError('Site not found.');
  if (pageId) {
    const { rows } = await pool.query('SELECT 1 FROM pages WHERE id = $1 AND site_id = $2', [pageId, siteId]);
    if (!rows.length) throw new ManualDowntimeError('Page not found for this site.');
  }

  // The target's own recent (automatic) checks decide the spacing, and the
  // latest one is the ceiling: back-filled rows must sit in the past so they
  // can never become the "current" status of the target.
  const scope = pageId ? 'site_id = $1 AND page_id = $2' : 'site_id = $1 AND page_id IS NULL';
  const params = pageId ? [siteId, pageId] : [siteId];
  const { rows: recent } = await pool.query(
    `SELECT ts FROM checks WHERE ${scope} AND manual = false ORDER BY ts DESC LIMIT 20`, params);
  if (!recent.length) throw new ManualDowntimeError('This target has no checks yet — click "Check now" first.');
  const latest = new Date(recent[0].ts);
  if (end > latest) {
    throw new ManualDowntimeError('The end time must be before the most recent check. Click "Check now" first, then try again.');
  }

  // Gaps under 2 minutes are almost certainly back-to-back "Check now" clicks
  // rather than the scheduler's rhythm, so they're ignored; with nothing left
  // to go on, fall back to hourly.
  let stepMs = 60 * 60000;
  const gaps = [];
  for (let i = 0; i < recent.length - 1; i++) {
    const gap = new Date(recent[i].ts) - new Date(recent[i + 1].ts);
    if (gap >= 2 * 60000) gaps.push(gap);
  }
  if (gaps.length) {
    gaps.sort((a, b) => a - b);
    stepMs = Math.min(Math.max(gaps[Math.floor(gaps.length / 2)], 5 * 60000), 24 * 60 * 60000);
  }

  const stamps = [];
  for (let t = start.getTime(); t < end.getTime(); t += stepMs) stamps.push(new Date(t));
  if (!stamps.length) stamps.push(start);
  if (stamps.length > MANUAL_MAX_ROWS) throw new ManualDowntimeError('That range would create too many entries — use a shorter range.');

  const err = (note && String(note).trim()) ? String(note).trim().slice(0, 300) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const ts of stamps) {
      await client.query(
        `INSERT INTO checks (site_id, page_id, ts, ok, category, http_status, response_time_ms, error, manual)
         VALUES ($1, $2, $3, false, 'down', NULL, NULL, $4, true)`,
        [siteId, pageId || null, ts, err]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { added: stamps.length, stepMinutes: Math.round(stepMs / 60000) };
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

// Like getHistory, but covers a site's root URL AND every page tracked under
// it, combined into one timeline — each row tagged with which target it came
// from. Used for the site-detail dashboard, so "Check now" / the daily
// summary / the chart reflect the whole site, not just its root URL.
async function getCombinedHistory(siteId, opts = {}) {
  await ready;
  const clauses = ['c.site_id = $1'];
  const params = [siteId];
  if (opts.from) { params.push(opts.from); clauses.push(`c.ts >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); clauses.push(`c.ts <= $${params.length}`); }
  let sql = `
    SELECT c.ts, c.ok, c.category, c.http_status, c.response_time_ms, c.error, c.page_id,
           COALESCE(p.name, s.name) AS target_name, COALESCE(p.url, s.url) AS target_url
    FROM checks c
    JOIN sites s ON s.id = c.site_id
    LEFT JOIN pages p ON p.id = c.page_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY c.ts ASC`;
  if (opts.limit) { params.push(opts.limit); sql = `SELECT * FROM (${sql.replace('ORDER BY c.ts ASC', 'ORDER BY c.ts DESC')} LIMIT $${params.length}) sub ORDER BY ts ASC`; }
  const { rows } = await pool.query(sql, params);
  return rows.map((r) => ({
    ts: r.ts.toISOString(),
    ok: r.ok,
    category: r.category,
    httpStatus: r.http_status,
    responseTimeMs: r.response_time_ms,
    error: r.error,
    pageId: r.page_id,
    targetName: r.target_name,
    targetUrl: r.target_url,
  }));
}

// ---- Problem targets (for the digest email) & Mail log ----

// Every target (a site's root URL, or one of its pages) whose CURRENT status
// — after "Mark as Fixed" acknowledgments are applied — is not 'up', across
// the whole system. This is the single source of truth for "what's actually
// wrong right now", used to build the consolidated digest email instead of
// firing a separate email per page.
async function getProblemTargets() {
  await ready;
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (c.site_id, c.page_id)
      c.site_id, c.page_id, c.category, c.ts, c.http_status, c.response_time_ms, c.error,
      s.name AS site_name, s.url AS site_url, s.acknowledged_at AS site_ack,
      p.name AS page_name, p.url AS page_url, p.acknowledged_at AS page_ack
    FROM checks c
    JOIN sites s ON s.id = c.site_id
    LEFT JOIN pages p ON p.id = c.page_id
    ORDER BY c.site_id, c.page_id NULLS FIRST, c.ts DESC
  `);
  const out = [];
  for (const r of rows) {
    const acknowledgedAt = r.page_id ? r.page_ack : r.site_ack;
    const category = isAcknowledged(acknowledgedAt, r.ts) ? 'up' : r.category;
    if (category === 'up') continue;
    out.push({
      siteId: r.site_id,
      pageId: r.page_id,
      siteName: r.site_name,
      targetName: r.page_id ? r.page_name : r.site_name,
      targetUrl: r.page_id ? r.page_url : r.site_url,
      category,
      httpStatus: r.http_status,
      responseTimeMs: r.response_time_ms,
      error: r.error,
      ts: r.ts.toISOString(),
    });
  }
  return out;
}

async function recordMailLog({ subject, recipients, success, error, issueCount }) {
  await ready;
  await pool.query(
    `INSERT INTO mail_log (subject, recipients, success, error, issue_count) VALUES ($1, $2, $3, $4, $5)`,
    [subject, recipients || '', Boolean(success), error || null, issueCount != null ? issueCount : null]
  );
}

async function getMailLog(limit = 50) {
  await ready;
  const { rows } = await pool.query(
    'SELECT id, sent_at, subject, recipients, success, error, issue_count FROM mail_log ORDER BY sent_at DESC LIMIT $1',
    [limit]
  );
  return rows.map((r) => ({
    id: r.id,
    sentAt: r.sent_at.toISOString(),
    subject: r.subject,
    recipients: r.recipients,
    success: r.success,
    error: r.error,
    issueCount: r.issue_count,
  }));
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
  // Counted by each site's aggregate status (root URL + all its pages
  // together), not just the root URL's own status — a site with 9 pages up
  // and 1 down is a real partial problem, not a clean "up".
  const up = sites.filter((s) => s.aggregateStatus === 'up').length;
  const slow = sites.filter((s) => s.aggregateStatus === 'slow').length;
  const warning = sites.filter((s) => s.aggregateStatus === 'warning').length;
  const down = sites.filter((s) => s.aggregateStatus === 'down').length;
  const unchecked = sites.filter((s) => s.aggregateStatus === 'unknown').length;

  const { rows: pageCountRows } = await pool.query('SELECT COUNT(*)::int AS count FROM pages');

  return {
    totalSites: sites.length,
    totalPages: pageCountRows[0].count,
    up,
    slow,
    warning,
    down,
    unchecked,
    medianUptimePct: median(uptimes),
    medianResponseMs: median(responses),
    avgUptimePct: uptimes.length ? Math.round((uptimes.reduce((a, b) => a + b, 0) / uptimes.length) * 10) / 10 : null,
    avgResponseMs: responses.length ? Math.round(responses.reduce((a, b) => a + b, 0) / responses.length) : null,
  };
}

function analyticsFromHistory(history) {
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
    series: history.map((h) => ({
      ts: h.ts,
      responseTimeMs: h.responseTimeMs,
      category: h.category,
      ok: h.ok,
      targetName: h.targetName,
      targetUrl: h.targetUrl,
      pageId: h.pageId,
    })),
  };
}

// Site's own root URL only (not its pages) — kept for completeness/scripting.
async function getSiteAnalytics(siteId, opts = {}) {
  const history = await getHistory(siteId, { from: opts.from, to: opts.to });
  return analyticsFromHistory(history);
}

// A single page's own history only.
async function getPageAnalytics(siteId, pageId, opts = {}) {
  const history = await getHistory(siteId, { from: opts.from, to: opts.to, pageId });
  return analyticsFromHistory(history);
}

// The site-detail dashboard's analytics: root URL + every page under it,
// combined — each daily-summary/log row is tagged with which target (root or
// a specific page) it came from via targetName/targetUrl.
async function getSiteCombinedAnalytics(siteId, opts = {}) {
  const history = await getCombinedHistory(siteId, { from: opts.from, to: opts.to });
  return analyticsFromHistory(history);
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
  checksSheet.addRow(['siteId', 'pageId', 'ts', 'ok', 'category', 'httpStatus', 'responseTimeMs', 'error', 'manual']);
  const { rows: checks } = await pool.query('SELECT site_id, page_id, ts, ok, category, http_status, response_time_ms, error, manual FROM checks ORDER BY ts');
  checks.forEach((c) => checksSheet.addRow([c.site_id, c.page_id, c.ts.toISOString(), c.ok, c.category, c.http_status, c.response_time_ms, c.error, c.manual]));

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
  acknowledgeSite,
  listPages,
  getPage,
  addPage,
  addPagesBulk,
  removePage,
  acknowledgePage,
  recordCheck,
  addManualDowntime,
  ManualDowntimeError,
  getHistory,
  getProblemTargets,
  recordMailLog,
  getMailLog,
  getSettings,
  updateSettings,
  getCollectiveAnalytics,
  getSiteAnalytics,
  getPageAnalytics,
  getSiteCombinedAnalytics,
  exportWorkbookBuffer,
};
