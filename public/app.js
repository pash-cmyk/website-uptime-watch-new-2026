const siteGrid = document.getElementById('siteGrid');
const emptyState = document.getElementById('emptyState');
const noMatchState = document.getElementById('noMatchState');
const template = document.getElementById('siteCardTemplate');

let allSites = [];

// ---------- Analytics (collective) ----------

async function loadAnalytics() {
  const a = await fetchJSON('/api/analytics');
  document.getElementById('statTotal').textContent = a.totalSites;
  document.getElementById('statUp').textContent = a.up;
  document.getElementById('statDown').textContent = a.down + a.warning;
  document.getElementById('statMedianUptime').textContent = a.medianUptimePct != null ? `${a.medianUptimePct}%` : '—';
  document.getElementById('statMedianResponse').textContent = a.medianResponseMs != null ? `${a.medianResponseMs}ms` : '—';
  document.getElementById('statAvgUptime').textContent = a.avgUptimePct != null ? `${a.avgUptimePct}%` : '—';
  document.getElementById('statAvgResponse').textContent = a.avgResponseMs != null ? `${a.avgResponseMs}ms` : '—';
}

async function loadStatus() {
  try {
    const status = await fetchJSON('/api/status');
    const badge = document.getElementById('emailStatusBadge');
    badge.textContent = status.emailConfigured ? 'Email alerts on' : 'Email alerts off';
    document.getElementById('statInterval').textContent = describeCron(status.checkIntervalCron);
  } catch (e) { /* non-critical */ }
}

// ---------- Sites list + filters ----------

async function loadSites() {
  allSites = await fetchJSON('/api/sites');
  renderFiltered();
}

function currentFilters() {
  const status = document.querySelector('input[name="statusFilter"]:checked').value;
  const search = document.getElementById('searchInput').value.trim().toLowerCase();
  return { status, search };
}

function renderFiltered() {
  const { status, search } = currentFilters();
  let filtered = allSites;
  if (status !== 'all') {
    filtered = filtered.filter((s) => (s.latest ? s.latest.category : 'unknown') === status);
  }
  if (search) {
    filtered = filtered.filter((s) => s.name.toLowerCase().includes(search) || s.url.toLowerCase().includes(search));
  }
  render(filtered);
  document.getElementById('filterCount').textContent = allSites.length
    ? `Showing ${filtered.length} of ${allSites.length}`
    : '';
}

function render(sites) {
  siteGrid.innerHTML = '';
  emptyState.classList.toggle('d-none', allSites.length > 0);
  noMatchState.classList.toggle('d-none', !(allSites.length > 0 && sites.length === 0));

  sites.forEach((site) => {
    const info = statusInfo(site.latest);
    const node = template.content.cloneNode(true);

    const link = node.querySelector('.site-card-link');
    link.href = `/site.html?id=${site.id}`;

    node.querySelector('.site-name').textContent = site.name;
    node.querySelector('.site-url').textContent = site.url.replace(/^https?:\/\//, '');

    const badge = node.querySelector('.status-badge');
    badge.classList.add(info.cls);
    badge.textContent = info.label;

    node.querySelector('.detail-line').textContent = detailLine(site.latest);

    const uptimeText = typeof site.uptimePct === 'number' ? ` · ${site.uptimePct}% uptime` : '';
    node.querySelector('.meta-line').textContent = `Checked ${timeAgo(site.latest && site.latest.ts)}${uptimeText}`;

    node.querySelector('.btn-recheck').addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = '…';
      try {
        await fetchJSON(`/api/sites/${site.id}/check`, { method: 'POST' });
        await Promise.all([loadSites(), loadAnalytics()]);
      } catch (err) {
        alert('Check failed: ' + err.message);
      } finally {
        btn.disabled = false; btn.textContent = '↻';
      }
    });

    node.querySelector('.btn-remove').addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!confirm(`Stop monitoring "${site.name}"?`)) return;
      await fetchJSON(`/api/sites/${site.id}`, { method: 'DELETE' });
      await Promise.all([loadSites(), loadAnalytics()]);
    });

    siteGrid.appendChild(node);
  });
}

document.getElementById('searchInput').addEventListener('input', renderFiltered);
document.querySelectorAll('input[name="statusFilter"]').forEach((el) => el.addEventListener('change', renderFiltered));

// ---------- Add site modal (single + bulk) ----------

const modeTabs = document.getElementById('addModeTabs');
const singleForm = document.getElementById('singleAddForm');
const bulkForm = document.getElementById('bulkAddForm');
const submitLabel = document.getElementById('addSiteSubmitLabel');
let addMode = 'single';

modeTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mode]');
  if (!btn) return;
  addMode = btn.dataset.mode;
  modeTabs.querySelectorAll('.nav-link').forEach((b) => b.classList.toggle('active', b === btn));
  singleForm.classList.toggle('d-none', addMode !== 'single');
  bulkForm.classList.toggle('d-none', addMode !== 'bulk');
  submitLabel.textContent = addMode === 'bulk' ? 'Add all & check now' : 'Add & check now';
});

function parseBulkInput(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const commaIdx = line.indexOf(',');
    if (commaIdx > -1) {
      return { name: line.slice(0, commaIdx).trim(), url: line.slice(commaIdx + 1).trim() };
    }
    return { url: line };
  });
}

document.getElementById('addSiteSubmitBtn').addEventListener('click', async () => {
  const errorEl = document.getElementById('addSiteError');
  const summaryEl = document.getElementById('addSiteSummary');
  const spinner = document.getElementById('addSiteSpinner');
  const submitBtn = document.getElementById('addSiteSubmitBtn');
  errorEl.classList.add('d-none');
  summaryEl.classList.add('d-none');

  let payload, endpoint;
  if (addMode === 'single') {
    const name = document.getElementById('siteName').value.trim();
    const url = document.getElementById('siteUrl').value.trim();
    if (!url) { errorEl.textContent = 'Enter a URL.'; errorEl.classList.remove('d-none'); return; }
    endpoint = '/api/sites';
    payload = { name, url };
  } else {
    const entries = parseBulkInput(document.getElementById('bulkSites').value);
    if (!entries.length) { errorEl.textContent = 'Enter at least one URL.'; errorEl.classList.remove('d-none'); return; }
    endpoint = '/api/sites/bulk';
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
    if (addMode === 'bulk') {
      let msg = `Added ${result.createdCount} site${result.createdCount === 1 ? '' : 's'}.`;
      if (result.skippedCount) msg += ` Skipped ${result.skippedCount} already tracked.`;
      if (result.invalidCount) msg += ` ${result.invalidCount} line(s) had no valid URL.`;
      summaryEl.textContent = msg;
      summaryEl.classList.remove('d-none');
      document.getElementById('bulkSites').value = '';
    } else {
      document.getElementById('siteName').value = '';
      document.getElementById('siteUrl').value = '';
      bootstrap.Modal.getInstance(document.getElementById('addSiteModal')).hide();
    }
    await Promise.all([loadSites(), loadAnalytics()]);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('d-none');
  } finally {
    spinner.classList.add('d-none');
    submitBtn.disabled = false;
  }
});

document.getElementById('addSiteModal').addEventListener('hidden.bs.modal', () => {
  document.getElementById('addSiteError').classList.add('d-none');
  document.getElementById('addSiteSummary').classList.add('d-none');
});

// ---------- Settings modal ----------

const scheduleSelect = document.getElementById('scheduleSelect');
const customCronWrap = document.getElementById('customCronWrap');
const customCronInput = document.getElementById('customCronInput');

document.getElementById('settingsModal').addEventListener('show.bs.modal', async () => {
  document.getElementById('settingsError').classList.add('d-none');
  document.getElementById('settingsSaved').classList.add('d-none');
  const settings = await fetchJSON('/api/settings');
  const knownValues = Array.from(scheduleSelect.options).map((o) => o.value);
  if (knownValues.includes(settings.checkIntervalCron)) {
    scheduleSelect.value = settings.checkIntervalCron;
    customCronWrap.classList.add('d-none');
  } else {
    scheduleSelect.value = 'custom';
    customCronWrap.classList.remove('d-none');
    customCronInput.value = settings.checkIntervalCron;
  }
  document.getElementById('timeoutInput').value = settings.requestTimeoutMs;
});

scheduleSelect.addEventListener('change', () => {
  customCronWrap.classList.toggle('d-none', scheduleSelect.value !== 'custom');
});

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const errorEl = document.getElementById('settingsError');
  const savedEl = document.getElementById('settingsSaved');
  errorEl.classList.add('d-none');
  savedEl.classList.add('d-none');

  const checkIntervalCron = scheduleSelect.value === 'custom' ? customCronInput.value.trim() : scheduleSelect.value;
  const requestTimeoutMs = document.getElementById('timeoutInput').value;

  try {
    await fetchJSON('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkIntervalCron, requestTimeoutMs }),
    });
    savedEl.classList.remove('d-none');
    await loadStatus();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('d-none');
  }
});

// ---------- Check all ----------

document.getElementById('checkAllBtn').addEventListener('click', async () => {
  const btn = document.getElementById('checkAllBtn');
  const spinner = document.getElementById('checkAllSpinner');
  btn.disabled = true;
  spinner.classList.remove('d-none');
  try {
    await fetchJSON('/api/check-all', { method: 'POST' });
    await Promise.all([loadSites(), loadAnalytics()]);
  } catch (err) {
    alert('Check failed: ' + err.message);
  } finally {
    btn.disabled = false;
    spinner.classList.add('d-none');
  }
});

// ---------- Init ----------

loadStatus();
loadAnalytics();
loadSites();
setInterval(() => { loadSites(); loadAnalytics(); }, 30000);
