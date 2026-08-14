const params = new URLSearchParams(location.search);
const siteId = params.get('id');
const pageId = params.get('page');
if (!siteId) {
  document.body.innerHTML = '<div class="container py-5"><p>No site specified. <a href="/">Back to dashboard</a></p></div>';
  throw new Error('missing id');
}

const STATUS_COLORS = { up: '#0ca30c', warning: '#fab219', down: '#d03b3b' };

// Base for header/analytics/check/history calls — page-scoped when ?page= is present.
const apiBase = pageId ? `/api/sites/${siteId}/pages/${pageId}` : `/api/sites/${siteId}`;

// A single page's own detail view only ever shows its own data — no nested
// pages list, no combined analytics. The CSS uses this to hide the "Page"
// (source) column in the daily log, which only makes sense when checks from
// more than one target (root + pages) are mixed together.
if (pageId) document.body.classList.add('page-detail-view');

let chart = null;
let allPages = [];

function currentRange() {
  const selected = document.querySelector('input[name="range"]:checked').value;
  const now = new Date();
  if (selected === 'all') return { from: null, to: null };
  if (selected === 'custom') {
    const from = document.getElementById('customFrom').value;
    const to = document.getElementById('customTo').value;
    return {
      from: from ? new Date(from + 'T00:00:00').toISOString() : null,
      to: to ? new Date(to + 'T23:59:59').toISOString() : null,
    };
  }
  const days = Number(selected);
  const from = new Date(now);
  if (days === 1) {
    from.setHours(0, 0, 0, 0); // start of today
  } else {
    from.setDate(from.getDate() - days);
  }
  return { from: from.toISOString(), to: null };
}

async function loadSiteHeader() {
  const backLink = document.getElementById('backLink');

  if (pageId) {
    const data = await fetchJSON(`${apiBase}`);
    const site = await fetchJSON(`/api/sites/${siteId}`).catch(() => null);
    const siteName = site ? site.name : '';
    document.getElementById('siteTitle').textContent = siteName ? `${siteName} / ${data.name}` : data.name;
    document.title = `${data.name} — Uptime Watch`;
    const link = document.getElementById('siteUrlLink');
    link.href = data.url;
    link.textContent = data.url;
    const info = statusInfo(data.latest);
    const badge = document.getElementById('siteStatusBadge');
    badge.className = 'status-badge badge rounded-pill ' + info.cls;
    badge.textContent = info.label;
    backLink.href = `/site.html?id=${siteId}`;
    document.getElementById('pagesSection').classList.add('d-none');
    return data;
  }

  const site = await fetchJSON(`/api/sites/${siteId}`);
  document.getElementById('siteTitle').textContent = site.name;
  document.title = `${site.name} — Uptime Watch`;
  const link = document.getElementById('siteUrlLink');
  link.href = site.url;
  link.textContent = site.url;
  // The header badge reflects the whole site (root + pages), same rule as
  // the homepage card — not just the root URL's own status.
  const info = aggregateStatusInfo(site);
  const badge = document.getElementById('siteStatusBadge');
  badge.className = 'status-badge badge rounded-pill ' + info.cls;
  badge.textContent = info.label;
  backLink.href = '/';
  document.getElementById('pagesSection').classList.remove('d-none');
  return site;
}

async function loadAnalytics() {
  const { from, to } = currentRange();
  const data = await fetchJSON(`${apiBase}/analytics${qs({ from, to })}`);
  document.getElementById('rangeUptime').textContent = data.uptimePct != null ? `${data.uptimePct}%` : '—';
  document.getElementById('rangeAvgResponse').textContent = data.avgResponseMs != null ? `${data.avgResponseMs}ms` : '—';
  document.getElementById('rangeChecks').textContent = data.totalChecks;
  document.getElementById('rangeIncidents').textContent = data.incidents;

  renderChart(data.series);
  renderDailySummary(data.dailySummary);
}

function renderChart(series) {
  const canvas = document.getElementById('responseChart');
  const emptyEl = document.getElementById('chartEmpty');
  emptyEl.classList.toggle('d-none', series.length > 0);
  canvas.classList.toggle('d-none', series.length === 0);
  if (chart) { chart.destroy(); chart = null; }
  if (!series.length) return;

  const labels = series.map((s) => formatTime(s.ts));
  const dataPoints = series.map((s) => s.responseTimeMs);
  const pointColors = series.map((s) => STATUS_COLORS[s.category] || '#898781');

  chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Response time (ms)',
        data: dataPoints,
        borderColor: '#2a78d6',
        borderWidth: 2,
        backgroundColor: 'rgba(42,120,214,0.08)',
        fill: true,
        tension: 0.15,
        pointRadius: 2,
        pointHoverRadius: 6,
        pointHitRadius: 10,
        pointBackgroundColor: pointColors,
        spanGaps: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const s = series[ctx.dataIndex];
              const parts = [`${ctx.parsed.y}ms`];
              if (s.category !== 'up') parts.push(s.category === 'warning' ? 'Warning' : 'Down');
              return parts.join(' · ');
            },
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 8, autoSkip: true }, grid: { display: false } },
        y: { beginAtZero: true, title: { display: true, text: 'ms' }, grid: { color: '#e1e0d9' } },
      },
    },
  });
}

function renderDailySummary(days) {
  const list = document.getElementById('dailySummaryList');
  const emptyEl = document.getElementById('dailyEmpty');
  list.innerHTML = '';
  emptyEl.classList.toggle('d-none', days.length > 0);

  const logFilter = document.querySelector('input[name="logStatusFilter"]:checked').value;

  days.forEach((day, idx) => {
    const tpl = document.getElementById('daySummaryTemplate').content.cloneNode(true);
    tpl.querySelector('.day-date').textContent = formatDay(day.date);

    const badge = tpl.querySelector('.day-uptime-badge');
    const cls = day.uptimePct === 100 ? 'status-up' : day.uptimePct === 0 ? 'status-down' : 'status-warning';
    badge.classList.add(cls);
    badge.textContent = `${day.uptimePct}% uptime`;

    tpl.querySelector('.day-meta').textContent =
      `${day.checksCount} check${day.checksCount === 1 ? '' : 's'} · avg ${day.avgResponseMs != null ? day.avgResponseMs + 'ms' : '—'} · first ${formatClock(day.firstCheck)}, last ${formatClock(day.lastCheck)}`;

    const collapseEl = tpl.querySelector('.day-collapse');
    const collapseId = `day-collapse-${idx}`;
    collapseEl.id = collapseId;
    tpl.querySelector('.day-header').setAttribute('data-bs-target', `#${collapseId}`);
    tpl.querySelector('.day-header').setAttribute('aria-controls', collapseId);

    const tbody = tpl.querySelector('.day-log-body');
    const checks = logFilter === 'all' ? day.checks : day.checks.filter((c) => c.category === logFilter);
    if (!checks.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" class="text-muted small">No checks match the current filter.</td>';
      tbody.appendChild(tr);
    } else {
      checks.slice().reverse().forEach((c) => {
        const tr = document.createElement('tr');
        const info = statusInfo(c);
        const tdTime = document.createElement('td');
        tdTime.textContent = formatClock(c.ts);
        const tdSource = document.createElement('td');
        tdSource.className = 'source-col small text-muted';
        tdSource.textContent = c.targetName || '';
        const tdStatus = document.createElement('td');
        const span = document.createElement('span');
        span.className = 'status-badge badge rounded-pill ' + info.cls;
        span.textContent = info.label.startsWith('HTTP') ? info.label : info.label;
        tdStatus.appendChild(span);
        const tdHttp = document.createElement('td');
        tdHttp.textContent = c.httpStatus || '—';
        const tdResp = document.createElement('td');
        tdResp.textContent = c.responseTimeMs != null ? `${c.responseTimeMs}ms` : '—';
        const tdDetail = document.createElement('td');
        tdDetail.className = 'small text-muted';
        tdDetail.textContent = c.error || '';
        tr.append(tdTime, tdSource, tdStatus, tdHttp, tdResp, tdDetail);
        tbody.appendChild(tr);
      });
    }

    list.appendChild(tpl);
  });
}

// ---------- Pages list (site-root view only) ----------

async function loadPages() {
  if (pageId) return; // page-detail view has no nested pages list
  allPages = await fetchJSON(`/api/sites/${siteId}/pages`);
  updatePagesHeaderMeta();
  renderPagesFiltered();
}

function currentPageFilter() {
  const el = document.querySelector('input[name="pageStatusFilter"]:checked');
  return el ? el.value : 'all';
}

function updatePagesHeaderMeta() {
  const el = document.getElementById('pagesHeaderMeta');
  if (!el) return;
  if (!allPages.length) { el.textContent = 'No pages yet'; return; }
  const down = allPages.filter((p) => p.latest && p.latest.category === 'down').length;
  const warning = allPages.filter((p) => p.latest && p.latest.category === 'warning').length;
  let text = `${allPages.length} page${allPages.length === 1 ? '' : 's'}`;
  const issues = [];
  if (down) issues.push(`${down} down`);
  if (warning) issues.push(`${warning} warning`);
  if (issues.length) text += ` · ${issues.join(', ')}`;
  el.textContent = text;
}

function renderPagesFiltered() {
  const filter = currentPageFilter();
  const filtered = filter === 'all'
    ? allPages
    : allPages.filter((p) => (p.latest ? p.latest.category : 'unknown') === filter);
  renderPages(filtered);
  document.getElementById('pagesNoMatch').classList.toggle('d-none', !(allPages.length > 0 && filtered.length === 0));
}

function renderPages(pages) {
  const grid = document.getElementById('pageGrid');
  const emptyEl = document.getElementById('pagesEmpty');
  const tpl = document.getElementById('pageCardTemplate');
  grid.innerHTML = '';
  emptyEl.classList.toggle('d-none', allPages.length > 0);

  pages.forEach((page) => {
    const info = statusInfo(page.latest);
    const node = tpl.content.cloneNode(true);

    const row = node.querySelector('.page-list-row');
    row.addEventListener('click', () => { location.href = `/site.html?id=${siteId}&page=${page.id}`; });

    node.querySelector('.page-name').textContent = page.name;
    node.querySelector('.page-url').textContent = page.url.replace(/^https?:\/\//, '');

    const badge = node.querySelector('.status-badge');
    badge.classList.add(info.cls);
    badge.textContent = info.label;

    const uptimeText = typeof page.uptimePct === 'number' ? ` · ${page.uptimePct}% uptime` : '';
    node.querySelector('.detail-line').textContent = `${detailLine(page.latest)}${uptimeText}`;

    node.querySelector('.meta-line').textContent = timeAgo(page.latest && page.latest.ts);

    node.querySelector('.btn-recheck-page').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = '…';
      try {
        await fetchJSON(`/api/sites/${siteId}/pages/${page.id}/check`, { method: 'POST' });
        await loadPages();
      } catch (err) {
        alert('Check failed: ' + err.message);
      } finally {
        btn.disabled = false; btn.textContent = '↻';
      }
    });

    node.querySelector('.btn-remove-page').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Stop tracking "${page.name}"?`)) return;
      await fetchJSON(`/api/sites/${siteId}/pages/${page.id}`, { method: 'DELETE' });
      await loadPages();
    });

    grid.appendChild(node);
  });
}

// ---------- Add page modal (single + bulk) ----------

if (!pageId) {
  const modeTabs = document.getElementById('addPageModeTabs');
  const singleForm = document.getElementById('singlePageAddForm');
  const bulkForm = document.getElementById('bulkPageAddForm');
  const submitLabel = document.getElementById('addPageSubmitLabel');
  let addPageMode = 'single';

  modeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    addPageMode = btn.dataset.mode;
    modeTabs.querySelectorAll('.nav-link').forEach((b) => b.classList.toggle('active', b === btn));
    singleForm.classList.toggle('d-none', addPageMode !== 'single');
    bulkForm.classList.toggle('d-none', addPageMode !== 'bulk');
    submitLabel.textContent = addPageMode === 'bulk' ? 'Add all & check now' : 'Add & check now';
  });

  function parseBulkPageInput(text) {
    return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const commaIdx = line.indexOf(',');
      if (commaIdx > -1) {
        return { name: line.slice(0, commaIdx).trim(), url: line.slice(commaIdx + 1).trim() };
      }
      return { url: line };
    });
  }

  document.getElementById('addPageSubmitBtn').addEventListener('click', async () => {
    const errorEl = document.getElementById('addPageError');
    const summaryEl = document.getElementById('addPageSummary');
    const spinner = document.getElementById('addPageSpinner');
    const submitBtn = document.getElementById('addPageSubmitBtn');
    errorEl.classList.add('d-none');
    summaryEl.classList.add('d-none');

    let payload, endpoint;
    if (addPageMode === 'single') {
      const name = document.getElementById('pageName').value.trim();
      const url = document.getElementById('pageUrl').value.trim();
      if (!url) { errorEl.textContent = 'Enter a URL.'; errorEl.classList.remove('d-none'); return; }
      endpoint = `/api/sites/${siteId}/pages`;
      payload = { name, url };
    } else {
      const entries = parseBulkPageInput(document.getElementById('bulkPages').value);
      if (!entries.length) { errorEl.textContent = 'Enter at least one URL.'; errorEl.classList.remove('d-none'); return; }
      endpoint = `/api/sites/${siteId}/pages/bulk`;
      payload = { entries };
    }

    spinner.classList.remove('d-none');
    submitBtn.disabled = true;
    try {
      const result = await fetchJSON(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (addPageMode === 'bulk') {
        let msg = `Added ${result.createdCount} page${result.createdCount === 1 ? '' : 's'}.`;
        if (result.skippedCount) msg += ` Skipped ${result.skippedCount} already tracked.`;
        if (result.invalidCount) msg += ` ${result.invalidCount} line(s) had no valid URL.`;
        summaryEl.textContent = msg;
        summaryEl.classList.remove('d-none');
        document.getElementById('bulkPages').value = '';
      } else {
        document.getElementById('pageName').value = '';
        document.getElementById('pageUrl').value = '';
        bootstrap.Modal.getInstance(document.getElementById('addPageModal')).hide();
      }
      await loadPages();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('d-none');
    } finally {
      spinner.classList.add('d-none');
      submitBtn.disabled = false;
    }
  });

  document.getElementById('addPageModal').addEventListener('hidden.bs.modal', () => {
    document.getElementById('addPageError').classList.add('d-none');
    document.getElementById('addPageSummary').classList.add('d-none');
  });

  // ---------- Scan for pages (sitemap first, homepage-link crawl fallback) ----------

  document.getElementById('scanPagesBtn').addEventListener('click', async () => {
    const btn = document.getElementById('scanPagesBtn');
    const spinner = document.getElementById('scanPagesSpinner');
    const summaryEl = document.getElementById('scanPagesSummary');
    btn.disabled = true;
    spinner.classList.remove('d-none');
    summaryEl.classList.add('d-none');
    try {
      const result = await fetchJSON(`/api/sites/${siteId}/scan-pages`, { method: 'POST' });
      let msg;
      if (!result.discoveredCount) {
        msg = "Didn't find any pages — the site may not publish a sitemap, or has no crawlable links on its homepage.";
      } else {
        msg = `Scanned and found ${result.discoveredCount} page${result.discoveredCount === 1 ? '' : 's'}. Added ${result.createdCount} new.`;
        if (result.skippedCount) msg += ` ${result.skippedCount} were already tracked.`;
      }
      summaryEl.textContent = msg;
      summaryEl.classList.remove('d-none');
      await loadPages();
    } catch (err) {
      summaryEl.textContent = 'Scan failed: ' + err.message;
      summaryEl.classList.remove('d-none');
    } finally {
      btn.disabled = false;
      spinner.classList.add('d-none');
    }
  });
}

// ---------- Prev / next page nav (page-detail view only) ----------

async function setupPageNav() {
  if (!pageId) return;
  try {
    const pages = await fetchJSON(`/api/sites/${siteId}/pages`);
    const idx = pages.findIndex((p) => p.id === pageId);
    if (idx === -1 || pages.length <= 1) return;

    document.getElementById('pageNavGroup').classList.remove('d-none');
    document.getElementById('pageNavLabel').textContent = `${idx + 1} of ${pages.length}`;

    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    if (idx > 0) {
      prevBtn.addEventListener('click', () => { location.href = `/site.html?id=${siteId}&page=${pages[idx - 1].id}`; });
    } else {
      prevBtn.disabled = true;
    }
    if (idx < pages.length - 1) {
      nextBtn.addEventListener('click', () => { location.href = `/site.html?id=${siteId}&page=${pages[idx + 1].id}`; });
    } else {
      nextBtn.disabled = true;
    }
  } catch (e) {
    console.error('page nav setup failed', e);
  }
}

// ---------- Controls ----------

document.querySelectorAll('input[name="range"]').forEach((el) => {
  el.addEventListener('change', () => {
    document.getElementById('customRangeWrap').classList.toggle('d-none', el.value !== 'custom' || !el.checked);
    if (el.checked && el.value !== 'custom') loadAnalytics();
  });
});
document.getElementById('applyCustomRange').addEventListener('click', loadAnalytics);
document.querySelectorAll('input[name="logStatusFilter"]').forEach((el) => el.addEventListener('change', loadAnalytics));

if (!pageId) {
  document.querySelectorAll('input[name="pageStatusFilter"]').forEach((el) => el.addEventListener('change', renderPagesFiltered));
}

document.getElementById('checkNowBtn').addEventListener('click', async () => {
  const btn = document.getElementById('checkNowBtn');
  const spinner = document.getElementById('checkNowSpinner');
  btn.disabled = true;
  spinner.classList.remove('d-none');
  try {
    // On a site's own dashboard, "Check now" checks the root URL AND every
    // page tracked under it, so the combined analytics/daily summary reflect
    // everything right away. A single page's own view only checks itself.
    const checkEndpoint = pageId ? `${apiBase}/check` : `/api/sites/${siteId}/check-all`;
    await fetchJSON(checkEndpoint, { method: 'POST' });
    const tasks = [loadSiteHeader(), loadAnalytics()];
    if (!pageId) tasks.push(loadPages());
    await Promise.all(tasks);
  } catch (err) {
    alert('Check failed: ' + err.message);
  } finally {
    btn.disabled = false;
    spinner.classList.add('d-none');
  }
});

// ---------- Init ----------

loadSiteHeader().catch((e) => {
  document.getElementById('siteTitle').textContent = pageId ? 'Page not found' : 'Site not found';
  console.error(e);
});
loadAnalytics();
if (!pageId) loadPages();
setupPageNav();
