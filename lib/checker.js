// Performs the actual HTTP check against a site and classifies the result.

const axios = require('axios');

function timeoutMs() {
  return Number(process.env.REQUEST_TIMEOUT_MS || 10000);
}

// Categorize an outcome the way an uptime tool should:
//  - 'up'      : 2xx/3xx response — site is healthy
//  - 'warning' : 4xx response — server responded, but something's off (bad path, blocked, auth wall...)
//  - 'down'    : 5xx response, timeout, DNS failure, connection refused, TLS error, etc.
function classify(httpStatus, errorCode) {
  if (httpStatus && httpStatus >= 200 && httpStatus < 400) return 'up';
  if (httpStatus && httpStatus >= 400 && httpStatus < 500) return 'warning';
  return 'down'; // 5xx or no response at all
}

function describeError(err) {
  if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) return 'Timed out waiting for a response';
  if (err.code === 'ENOTFOUND') return 'DNS lookup failed — domain does not resolve';
  if (err.code === 'ECONNREFUSED') return 'Connection refused by the server';
  if (err.code === 'ECONNRESET') return 'Connection was reset by the server';
  if (err.code === 'CERT_HAS_EXPIRED' || /certificate/i.test(err.message)) return 'SSL/TLS certificate error';
  return err.message || 'Unknown network error';
}

async function checkUrl(url) {
  const start = Date.now();
  try {
    const res = await axios.get(url, {
      timeout: timeoutMs(),
      maxRedirects: 5,
      validateStatus: () => true, // never throw on HTTP status; we classify it ourselves
      headers: { 'User-Agent': 'Uptime-Watch/1.0 (+self-hosted downtime tracker)' },
    });
    const responseTimeMs = Date.now() - start;
    const category = classify(res.status, null);
    return {
      ts: new Date().toISOString(),
      ok: category === 'up',
      category,
      httpStatus: res.status,
      responseTimeMs,
      error: null,
    };
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    return {
      ts: new Date().toISOString(),
      ok: false,
      category: 'down',
      httpStatus: null,
      responseTimeMs,
      error: describeError(err),
    };
  }
}

module.exports = { checkUrl };
