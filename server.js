require('dotenv').config();

const path = require('path');
const express = require('express');
const cron = require('node-cron');

const store = require('./lib/store');
const { checkAllSites, checkOneSite } = require('./lib/monitor');
const { isConfigured: emailConfigured } = require('./lib/mailer');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// ---- Basic auth (recommended once this is deployed somewhere public) ----
function basicAuth(req, res, next) {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASS;
  if (!user || !pass) return next(); // auth disabled — not set

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [reqUser, reqPass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (reqUser === user && reqPass === pass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Uptime Watch"');
  return res.status(401).send('Authentication required.');
}

app.use(basicAuth);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Live scheduler (interval is stored in the workbook, adjustable from the UI) ----
let scheduledTask = null;

function startScheduler(cronExpr) {
  if (scheduledTask) scheduledTask.stop();
  if (!cron.validate(cronExpr)) {
    console.error(`[scheduler] Invalid cron expression "${cronExpr}", falling back to hourly.`);
    cronExpr = '0 * * * *';
  }
  console.log(`[scheduler] Automated checks scheduled with cron "${cronExpr}"`);
  scheduledTask = cron.schedule(cronExpr, () => {
    console.log(`[scheduler] Running scheduled check at ${new Date().toISOString()}`);
    checkAllSites().catch((e) => console.error('[scheduler] check run failed', e));
  });
}

// ---- API ----

app.get('/api/status', async (req, res) => {
  const settings = await store.getSettings();
  res.json({ emailConfigured: emailConfigured(), checkIntervalCron: settings.checkIntervalCron });
});

app.get('/api/settings', async (req, res) => {
  res.json(await store.getSettings());
});

app.put('/api/settings', async (req, res) => {
  const { checkIntervalCron, requestTimeoutMs } = req.body || {};
  const patch = {};
  if (checkIntervalCron) {
    if (!cron.validate(checkIntervalCron)) return res.status(400).json({ error: 'Invalid cron expression' });
    patch.checkIntervalCron = checkIntervalCron;
  }
  if (requestTimeoutMs) patch.requestTimeoutMs = Number(requestTimeoutMs);
  const settings = await store.updateSettings(patch);
  if (patch.checkIntervalCron) {
    process.env.CHECK_INTERVAL_CRON = patch.checkIntervalCron;
    startScheduler(patch.checkIntervalCron);
  }
  if (patch.requestTimeoutMs) process.env.REQUEST_TIMEOUT_MS = String(patch.requestTimeoutMs);
  res.json(settings);
});

app.get('/api/analytics', async (req, res) => {
  res.json(await store.getCollectiveAnalytics());
});

app.get('/api/sites', async (req, res) => {
  res.json(await store.listSites());
});

app.get('/api/sites/:id', async (req, res) => {
  const site = await store.getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'site not found' });
  res.json(site);
});

function normalizeUrl(url) {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function deriveNameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

app.post('/api/sites', async (req, res) => {
  const { name, url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  let normalizedUrl;
  try {
    normalizedUrl = normalizeUrl(url);
    // eslint-disable-next-line no-new
    new URL(normalizedUrl);
  } catch {
    return res.status(400).json({ error: 'That does not look like a valid URL' });
  }

  const site = await store.addSite(name || deriveNameFromUrl(normalizedUrl), normalizedUrl);
  try {
    await checkOneSite(site);
  } catch (e) {
    console.error('[api] initial check failed', e);
  }
  res.status(201).json(await store.getSite(site.id));
});

// Bulk add: accepts { entries: [{ name?, url }, ...] } — used by the "Add multiple" modal.
app.post('/api/sites/bulk', async (req, res) => {
  const { entries } = req.body || {};
  if (!Array.isArray(entries) || !entries.length) {
    return res.status(400).json({ error: 'entries must be a non-empty array of { name?, url }' });
  }

  const normalized = [];
  const invalid = [];
  for (const e of entries) {
    if (!e || !e.url) { invalid.push(e); continue; }
    try {
      const url = normalizeUrl(e.url);
      // eslint-disable-next-line no-new
      new URL(url);
      normalized.push({ name: (e.name && e.name.trim()) || deriveNameFromUrl(url), url });
    } catch {
      invalid.push(e);
    }
  }

  const { created, skipped } = await store.addSitesBulk(normalized);

  // Check every newly added site right away so the dashboard isn't blank for them.
  for (const site of created) {
    try {
      await checkOneSite(site);
    } catch (e) {
      console.error('[api] bulk initial check failed for', site.url, e);
    }
  }

  res.status(201).json({
    createdCount: created.length,
    skippedCount: skipped.length,
    invalidCount: invalid.length,
    sites: await store.listSites(),
  });
});

app.delete('/api/sites/:id', async (req, res) => {
  const ok = await store.removeSite(req.params.id);
  if (!ok) return res.status(404).json({ error: 'site not found' });
  res.status(204).end();
});

app.get('/api/sites/:id/history', async (req, res) => {
  const site = await store.getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'site not found' });
  const { from, to, limit } = req.query;
  res.json(await store.getHistory(req.params.id, { from, to, limit: limit ? Number(limit) : undefined }));
});

app.get('/api/sites/:id/analytics', async (req, res) => {
  const site = await store.getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'site not found' });
  const { from, to } = req.query;
  const analytics = await store.getSiteAnalytics(req.params.id, { from, to });
  res.json({ site, ...analytics });
});

app.post('/api/sites/:id/check', async (req, res) => {
  const site = await store.getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'site not found' });
  const result = await checkOneSite(site);
  res.json({ site: await store.getSite(site.id), result });
});

app.post('/api/check-all', async (req, res) => {
  const results = await checkAllSites();
  res.json({ checked: results.length, sites: await store.listSites() });
});

// ---- Boot ----
(async () => {
  const settings = await store.getSettings();
  if (!process.env.REQUEST_TIMEOUT_MS && settings.requestTimeoutMs) {
    process.env.REQUEST_TIMEOUT_MS = String(settings.requestTimeoutMs);
  }
  startScheduler(settings.checkIntervalCron);
  checkAllSites().catch((e) => console.error('[startup] initial check run failed', e));

  app.listen(PORT, () => {
    console.log(`\nUptime Watch running at http://localhost:${PORT}`);
    console.log(`[store] Data file: ${store.XLSX_PATH}`);
    console.log(emailConfigured() ? '[mailer] SMTP is configured — alerts will be emailed.' : '[mailer] SMTP not configured — set SMTP_* vars in .env to enable email alerts.');
  });
})();
