// Performs the actual HTTP check against a site and classifies the result.

const axios = require('axios');

function timeoutMs() {
  return Number(process.env.REQUEST_TIMEOUT_MS || 10000);
}

function slowThresholdMs() {
  return Number(process.env.SLOW_THRESHOLD_MS || 3000);
}

// Categorize an outcome the way an uptime tool should — and, importantly,
// the way this team actually needs to read it: "down" and "slow" are NOT
// the same thing and must never be conflated (see README for the exact
// rule this was built to). The distinction:
//  - 'up'      : 2xx/3xx response, well within the slow threshold — healthy.
//  - 'slow'    : 2xx/3xx response (a real SUCCESS — the site loaded and the
//                user's request completed), but it took longer than the
//                configured slow threshold. This is a performance problem,
//                NOT an availability failure — the user could still finish
//                what they came to do, just with more friction/wait.
//  - 'warning' : 4xx response — server responded, but something's off (bad path, blocked, auth wall...)
//  - 'down'    : 5xx response, timeout, DNS failure, connection refused, TLS
//                error, etc. — an actual availability failure that blocks
//                users completely. Timeouts and connection failures are
//                ALWAYS 'down', never 'slow', no matter how close to
//                completing they were.
function classify(httpStatus, errorCode, responseTimeMs) {
  if (httpStatus && httpStatus >= 200 && httpStatus < 400) {
    if (typeof responseTimeMs === 'number' && responseTimeMs > slowThresholdMs()) return 'slow';
    return 'up';
  }
  if (httpStatus && httpStatus >= 400 && httpStatus < 500) return 'warning';
  return 'down'; // 5xx, timeout, or no response at all
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
    const category = classify(res.status, null, responseTimeMs);
    return {
      ts: new Date().toISOString(),
      // 'slow' still means the request genuinely succeeded, so it counts as
      // "ok"/available for uptime% purposes — only 'warning' and 'down' don't.
      ok: category === 'up' || category === 'slow',
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
