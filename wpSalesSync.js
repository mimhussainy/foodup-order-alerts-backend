// FoodUp Orders - WordPress sales history.
//
// The backend only keeps the newest 100 orders per restaurant, so older sales
// cannot be counted from them. WordPress/WooCommerce holds every order: this
// module asks the FoodUp Ordering plugin (GET /wp-json/foodup/v1/sales-history,
// plugin 0.5.256+) for the daily totals and stores them in the same daily store
// that the app statistics read (see dailyStats.js, key <code>:stats_wp).
//
// - First run for a restaurant: last year + this year (full sync).
// - After that: the last 14 days are refreshed every 6 hours (late refunds or
//   status changes), and everything again once a week.
// - If WordPress cannot answer (old plugin, legacy plugin, site down) nothing
//   breaks: the statistics keep using the live records and the sync retries later.
// - It never blocks a stats request; it runs in the background.

const { zurichParts, addDays } = require('./controlCenterStats');

const HOUR = 3600 * 1000;
const REFRESH_MS = 6 * HOUR;
const FULL_REFRESH_MS = 7 * 24 * HOUR;
const RETRY_UNSUPPORTED_MS = 6 * HOUR; // 401/403/404: plugin too old or not reachable
const RETRY_TEMPORARY_MS = 30 * 60 * 1000;
const RECENT_DAYS = 14;
const CHUNK_DAYS = 31;
const LOCK_SECONDS = 900;
const REQUEST_TIMEOUT_MS = 40000;

const ZERO = () => ({ o: 0, cash: 0, online: 0, del: 0, pick: 0 });

function wantedFrom(today) {
  return `${Number(today.slice(0, 4)) - 1}-01-01`;
}

function maxDay(a, b) {
  return a > b ? a : b;
}

function chunkRanges(from, to, size = CHUNK_DAYS) {
  const out = [];
  let start = from;
  while (start <= to) {
    const end = addDays(start, size - 1);
    out.push({ from: start, to: end < to ? end : to });
    start = addDays(end, 1);
  }
  return out;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Every day of the range gets an entry (zeros for days without orders), so a
// day that lost its orders in WordPress is corrected too.
function fillDays(from, to, wpDays) {
  const days = {};
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const row = wpDays && wpDays[day];
    days[day] = row
      ? { o: num(row.o), cash: num(row.cash), online: num(row.online), del: num(row.del), pick: num(row.pick) }
      : ZERO();
  }
  return days;
}

// What to do now: null (nothing), or { full, from, to }.
function planSync(marker, today, floor, nowMs) {
  const want = maxDay(wantedFrom(today), floor || '');
  if (!marker) return { full: true, from: want, to: today };
  if (marker.retryAt && nowMs < marker.retryAt) return null;
  const coverageMissing = !marker.from || marker.from > want;
  const fullStale = nowMs - (marker.fullAt || 0) > FULL_REFRESH_MS;
  if (coverageMissing || fullStale) return { full: true, from: want, to: today };
  if (nowMs - (marker.at || 0) < REFRESH_MS) return null;
  return { full: false, from: maxDay(want, addDays(today, -RECENT_DAYS)), to: today };
}

class SyncError extends Error {
  constructor(message, retryMs) {
    super(message);
    this.retryMs = retryMs;
  }
}

function createWpSalesSync({
  redisCommand,
  k,
  fetchWordPress,
  getBaseUrl,
  dailyStats,
  onUpdated = () => {},
  logger = console,
  now = () => Date.now(),
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const running = new Map();

  async function readMarker(code) {
    const res = await redisCommand('GET', k(code, 'stats_wp_sync'));
    if (!res.result) return null;
    try { return JSON.parse(res.result); } catch (_) { return null; }
  }

  async function writeMarker(code, marker) {
    await redisCommand('SET', k(code, 'stats_wp_sync'), JSON.stringify(marker));
  }

  async function fetchRange(code, base, from, to) {
    const url = `${base}/wp-json/foodup/v1/sales-history?from=${from}&to=${to}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchWordPress(code, url, { method: 'GET', signal: controller.signal });
    } catch (error) {
      throw new SyncError(`request failed: ${error.message}`, RETRY_TEMPORARY_MS);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const status = response.status;
      const retry = [401, 403, 404].includes(status) ? RETRY_UNSUPPORTED_MS : RETRY_TEMPORARY_MS;
      throw new SyncError(`WordPress answered ${status}`, retry);
    }
    const body = await response.json().catch(() => null);
    if (!body || body.success !== true || typeof body.days !== 'object' || body.days === null) {
      throw new SyncError('unexpected answer from WordPress', RETRY_TEMPORARY_MS);
    }
    if (body.partial) throw new SyncError('WordPress answered only partly', 10 * 60 * 1000);
    return body.days;
  }

  async function runSync(code, plan, marker) {
    const base = String((await getBaseUrl(code)) || '').replace(/\/+$/, '');
    if (!base) throw new SyncError('restaurant website is not set', RETRY_UNSUPPORTED_MS);
    for (const range of chunkRanges(plan.from, plan.to)) {
      const wpDays = await fetchRange(code, base, range.from, range.to);
      await dailyStats.writeWpDays(code, fillDays(range.from, range.to, wpDays));
    }
    const t = now();
    await writeMarker(code, {
      at: t,
      from: plan.full ? plan.from : marker?.from || plan.from,
      fullAt: plan.full ? t : marker?.fullAt || t,
    });
  }

  async function run(code) {
    const t = now();
    const today = zurichParts(new Date(t)).day;
    const [marker, floor] = await Promise.all([readMarker(code), dailyStats.readWpFloor(code)]);
    const plan = planSync(marker, today, floor, t);
    if (!plan) return { skipped: true };

    const lock = await redisCommand('SET', k(code, 'stats_wp_lock'), String(t), 'NX', 'EX', LOCK_SECONDS);
    if (!lock.result) return { skipped: true };
    try {
      await runSync(code, plan, marker);
      logger.log(`stats: WordPress history synced for ${code} (${plan.full ? 'full' : 'recent'} ${plan.from}..${plan.to})`);
      try { onUpdated(code); } catch (_) { /* cache clearing is best effort */ }
      return { synced: true, full: plan.full };
    } catch (error) {
      const retryMs = error instanceof SyncError ? error.retryMs : RETRY_TEMPORARY_MS;
      logger.log(`stats: WordPress history sync failed for ${code}: ${error.message} (retry in ${Math.round(retryMs / 60000)} min)`);
      await writeMarker(code, { ...(marker || {}), error: error.message, retryAt: now() + retryMs });
      return { failed: true, error: error.message };
    } finally {
      await redisCommand('DEL', k(code, 'stats_wp_lock')).catch(() => {});
    }
  }

  // Safe to call on every stats request: it checks one small marker and returns.
  function maybeSync(code) {
    if (running.has(code)) return running.get(code);
    const promise = run(code).finally(() => running.delete(code));
    running.set(code, promise);
    return promise;
  }

  return { maybeSync };
}

module.exports = { createWpSalesSync, planSync, chunkRanges, fillDays, wantedFrom };
