// Small helpers shared by index.html (dashboard) and site.html (detail page).

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function formatClock(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function formatDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// category -> { label, cls } used for badges everywhere
function statusInfo(latest) {
  if (!latest) return { cls: 'status-unknown', label: 'Checking…' };
  if (latest.category === 'up') return { cls: 'status-up', label: 'Up' };
  if (latest.category === 'warning') return { cls: 'status-warning', label: `HTTP ${latest.httpStatus}` };
  return { cls: 'status-down', label: latest.httpStatus ? `HTTP ${latest.httpStatus}` : 'Down' };
}

function detailLine(latest) {
  if (!latest) return 'Not checked yet';
  if (latest.error) return latest.error;
  if (latest.category === 'up') return `Responded in ${latest.responseTimeMs}ms`;
  if (latest.category === 'warning') return `Server responded but returned HTTP ${latest.httpStatus}`;
  return `HTTP ${latest.httpStatus} — server error`;
}

// A site's status badge is never just its root URL's status — it's the root
// URL AND every page tracked under it, considered together (see
// aggregateStatus() in lib/store.js for the exact rule: all up -> up, all
// down/warning -> down, anything mixed -> warning).
function aggregateStatusInfo(site) {
  if (!site.targetsTotal) return { cls: 'status-unknown', label: 'Checking…' };
  if (site.aggregateStatus === 'up') return { cls: 'status-up', label: 'Up' };
  if (site.aggregateStatus === 'down') return { cls: 'status-down', label: 'Down' };
  return { cls: 'status-warning', label: 'Warning' };
}

// The line under a site's name on its card: a breakdown of how many of its
// targets (root + pages) are up/warning/down, so "9 up, 1 down" is visible
// at a glance instead of hiding behind a single Up/Down badge. Sites with no
// pages just show the root's own detail, since a "1 up" breakdown of one
// target adds nothing.
function targetBreakdownLine(site) {
  if (!site.targetsTotal) return 'Not checked yet';
  if (!site.pageCount) return detailLine(site.latest);
  const parts = [];
  if (site.targetsUp) parts.push(`${site.targetsUp} up`);
  if (site.targetsWarning) parts.push(`${site.targetsWarning} warning`);
  if (site.targetsDown) parts.push(`${site.targetsDown} down`);
  return parts.join(' · ') || 'Not checked yet';
}

const CRON_PRESET_LABELS = {
  '*/5 * * * *': 'every 5 minutes',
  '*/15 * * * *': 'every 15 minutes',
  '*/30 * * * *': 'every 30 minutes',
  '0 * * * *': 'every hour',
  '0 */3 * * *': 'every 3 hours',
  '0 */6 * * *': 'every 6 hours',
  '0 */12 * * *': 'every 12 hours',
  '0 0 * * *': 'once a day',
};

function describeCron(expr) {
  return CRON_PRESET_LABELS[expr] || expr;
}

function qs(params) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') usp.set(k, v); });
  const s = usp.toString();
  return s ? `?${s}` : '';
}
