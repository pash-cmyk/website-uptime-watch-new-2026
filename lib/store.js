// Excel-backed data store. Everything (sites, check history, settings) lives in
// a single .xlsx workbook at data/uptime-data.xlsx — no external database.
// Trade-off: every write reads+rewrites the whole workbook, which is fine at
// personal-monitoring scale (a handful of sites, checks every few minutes/hours)
// but isn't meant for high-frequency or multi-writer use.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const XLSX_PATH = path.join(DATA_DIR, 'uptime-data.xlsx');

const MAX_HISTORY_PER_SITE = 5000; // bounds file growth over months/years of checks

const SITES_HEADER = ['id', 'name', 'url', 'createdAt'];
const HISTORY_HEADER = ['siteId', 'ts', 'ok', 'category', 'httpStatus', 'responseTimeMs', 'error'];
const SETTINGS_HEADER = ['key', 'value'];

const DEFAULT_SETTINGS = {
  checkIntervalCron: '0 * * * *',
  requestTimeoutMs: '10000',
};

// A tiny in-process write queue so concurrent requests don't race on the same
// file (exceljs has no file locking of its own).
let writeChain = Promise.resolve();
function serialize(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {}); // don't let one failure jam the queue
  return run;
}

async function ensureWorkbook() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(XLSX_PATH)) return;

  const wb = new ExcelJS.Workbook();
  const sites = wb.addWorksheet('Sites');
  sites.addRow(SITES_HEADER);
  const history = wb.addWorksheet('Checks');
  history.addRow(HISTORY_HEADER);
  const settings = wb.addWorksheet('Settings');
  settings.addRow(SETTINGS_HEADER);
  const initialSettings = {
    checkIntervalCron: process.env.CHECK_INTERVAL_CRON || DEFAULT_SETTINGS.checkIntervalCron,
    requestTimeoutMs: process.env.REQUEST_TIMEOUT_MS || DEFAULT_SETTINGS.requestTimeoutMs,
  };
  Object.entries(initialSettings).forEach(([k, v]) => settings.addRow([k, v]));
  await wb.xlsx.writeFile(XLSX_PATH);
}

async function loadWorkbook() {
  await ensureWorkbook();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);
  // Guard against a hand-edited file missing a sheet.
  if (!wb.getWorksheet('Sites')) wb.addWorksheet('Sites').addRow(SITES_HEADER);
  if (!wb.getWorksheet('Checks')) wb.addWorksheet('Checks').addRow(HISTORY_HEADER);
  if (!wb.getWorksheet('Settings')) {
    const s = wb.addWorksheet('Settings');
    s.addRow(SETTINGS_HEADER);
    Object.entries(DEFAULT_SETTINGS).forEach(([k, v]) => s.addRow([k, v]));
  }
  return wb;
}

function sheetToObjects(sheet, header) {
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const obj = {};
    header.forEach((key, i) => {
      const cell = row.getCell(i + 1);
      obj[key] = cell.value === null || cell.value === undefined ? null : cell.value;
    });
    if (Object.values(obj).some((v) => v !== null && v !== '')) rows.push(obj);
  });
  return rows;
}

// Rewrites a sheet's contents. Deliberately removes + re-adds the worksheet
// rather than using spliceRows: exceljs's spliceRows(1, rowCount) is a no-op
// when deleting *every* row in the sheet (its internal loop range is empty
// in that case), which would silently leave stale rows behind.
function resetSheet(wb, sheetName, header, objects) {
  wb.removeWorksheet(sheetName);
  const sheet = wb.addWorksheet(sheetName);
  sheet.addRow(header);
  objects.forEach((obj) => sheet.addRow(header.map((k) => (obj[k] === undefined ? null : obj[k]))));
  return sheet;
}

// ---- Sites ----

async function listSitesRaw() {
  const wb = await loadWorkbook();
  return sheetToObjects(wb.getWorksheet('Sites'), SITES_HEADER);
}

async function addSite(name, url) {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const sheet = wb.getWorksheet('Sites');
    const site = {
      id: crypto.randomBytes(6).toString('hex'),
      name: name.trim(),
      url: url.trim(),
      createdAt: new Date().toISOString(),
    };
    sheet.addRow(SITES_HEADER.map((k) => site[k]));
    await wb.xlsx.writeFile(XLSX_PATH);
    return site;
  });
}

// Adds many sites in one workbook write (much faster than N sequential addSite calls
// and avoids N separate read-modify-write cycles).
async function addSitesBulk(entries) {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const sheet = wb.getWorksheet('Sites');
    const existing = sheetToObjects(sheet, SITES_HEADER);
    const existingUrls = new Set(existing.map((s) => normalizeUrlKey(s.url)));
    const created = [];
    const skipped = [];

    for (const entry of entries) {
      const key = normalizeUrlKey(entry.url);
      if (existingUrls.has(key)) {
        skipped.push(entry);
        continue;
      }
      const site = {
        id: crypto.randomBytes(6).toString('hex'),
        name: entry.name.trim(),
        url: entry.url.trim(),
        createdAt: new Date().toISOString(),
      };
      sheet.addRow(SITES_HEADER.map((k) => site[k]));
      existingUrls.add(key);
      created.push(site);
    }
    await wb.xlsx.writeFile(XLSX_PATH);
    return { created, skipped };
  });
}

function normalizeUrlKey(url) {
  return String(url).trim().toLowerCase().replace(/\/+$/, '');
}

async function removeSite(id) {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const sites = sheetToObjects(wb.getWorksheet('Sites'), SITES_HEADER);
    const before = sites.length;
    const remaining = sites.filter((s) => s.id !== id);
    resetSheet(wb, 'Sites', SITES_HEADER, remaining);

    const history = sheetToObjects(wb.getWorksheet('Checks'), HISTORY_HEADER);
    const remainingHistory = history.filter((h) => h.siteId !== id);
    resetSheet(wb, 'Checks', HISTORY_HEADER, remainingHistory);

    await wb.xlsx.writeFile(XLSX_PATH);
    return remaining.length < before;
  });
}

async function recordCheck(siteId, entry) {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const sheet = wb.getWorksheet('Checks');
    sheet.addRow(HISTORY_HEADER.map((k) => (k === 'siteId' ? siteId : entry[k])));

    // Trim this site's history if it's grown past the cap (keep the most recent).
    const all = sheetToObjects(sheet, HISTORY_HEADER);
    const forSite = all.filter((h) => h.siteId === siteId);
    if (forSite.length > MAX_HISTORY_PER_SITE) {
      const toDrop = forSite.length - MAX_HISTORY_PER_SITE;
      const dropTsSet = new Set(forSite.slice(0, toDrop).map((h) => h.ts));
      const kept = all.filter((h) => !(h.siteId === siteId && dropTsSet.has(h.ts)));
      resetSheet(wb, 'Checks', HISTORY_HEADER, kept);
    }
    await wb.xlsx.writeFile(XLSX_PATH);
  });
}

async function getHistory(siteId, opts = {}) {
  const wb = await loadWorkbook();
  let rows = sheetToObjects(wb.getWorksheet('Checks'), HISTORY_HEADER).filter((h) => h.siteId === siteId);
  if (opts.from) rows = rows.filter((h) => new Date(h.ts) >= new Date(opts.from));
  if (opts.to) rows = rows.filter((h) => new Date(h.ts) <= new Date(opts.to));
  rows.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (opts.limit) rows = rows.slice(-opts.limit);
  return rows;
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

async function listSites() {
  const wb = await loadWorkbook();
  const sites = sheetToObjects(wb.getWorksheet('Sites'), SITES_HEADER);
  const historyAll = sheetToObjects(wb.getWorksheet('Checks'), HISTORY_HEADER);
  return sites.map((site) => {
    const hist = historyAll.filter((h) => h.siteId === site.id).sort((a, b) => new Date(a.ts) - new Date(b.ts));
    return { ...site, ...computeStats(hist) };
  });
}

async function getSite(id) {
  const wb = await loadWorkbook();
  const sites = sheetToObjects(wb.getWorksheet('Sites'), SITES_HEADER);
  const site = sites.find((s) => s.id === id);
  if (!site) return null;
  const hist = sheetToObjects(wb.getWorksheet('Checks'), HISTORY_HEADER)
    .filter((h) => h.siteId === id)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return { ...site, ...computeStats(hist) };
}

// ---- Settings ----

async function getSettings() {
  const wb = await loadWorkbook();
  const rows = sheetToObjects(wb.getWorksheet('Settings'), SETTINGS_HEADER);
  const settings = { ...DEFAULT_SETTINGS };
  rows.forEach((r) => {
    settings[r.key] = String(r.value);
  });
  return settings;
}

async function updateSettings(partial) {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const sheet = wb.getWorksheet('Settings');
    const rows = sheetToObjects(sheet, SETTINGS_HEADER);
    const merged = { ...DEFAULT_SETTINGS };
    rows.forEach((r) => { merged[r.key] = String(r.value); });
    Object.entries(partial).forEach(([k, v]) => { merged[k] = String(v); });
    resetSheet(wb, 'Settings', SETTINGS_HEADER, Object.entries(merged).map(([key, value]) => ({ key, value })));
    await wb.xlsx.writeFile(XLSX_PATH);
    return merged;
  });
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

  return {
    totalSites: sites.length,
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

async function getSiteAnalytics(siteId, opts = {}) {
  const history = await getHistory(siteId, opts);
  const upCount = history.filter((h) => h.ok).length;
  const uptimePct = history.length ? Math.round((upCount / history.length) * 1000) / 10 : null;
  const responses = history.filter((h) => typeof h.responseTimeMs === 'number').map((h) => h.responseTimeMs);
  const avgResponseMs = responses.length ? Math.round(responses.reduce((a, b) => a + b, 0) / responses.length) : null;
  const medianResponseMs = median(responses);

  // Incidents = number of times status flipped from ok -> not-ok within the range.
  let incidents = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i - 1].ok && !history[i].ok) incidents++;
  }

  // Daily summary, grouped by calendar date (UTC) of each check.
  const byDay = new Map();
  for (const h of history) {
    const day = h.ts.slice(0, 10); // YYYY-MM-DD
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(h);
  }
  const dailySummary = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // most recent day first
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
        checks: checks.map((c) => ({
          ts: c.ts, ok: c.ok, category: c.category, httpStatus: c.httpStatus, responseTimeMs: c.responseTimeMs, error: c.error,
        })),
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

module.exports = {
  listSites,
  getSite,
  addSite,
  addSitesBulk,
  removeSite,
  recordCheck,
  getHistory,
  getSettings,
  updateSettings,
  getCollectiveAnalytics,
  getSiteAnalytics,
  XLSX_PATH,
};
