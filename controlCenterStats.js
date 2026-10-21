// FoodUp Control Center — history + analytics.
//
// Read-only towards the live order pipeline: this module only READS the
// existing `<code>:orders` list, `<code>:heartbeat` and `rejected_time:*`
// keys, and WRITES its own `cc_*` keys. It never touches order data that the
// apps or WordPress rely on.
//
// Keys written (all with TTL):
//   <code>:cc_orders:<YYYY-MM-DD>  hash  order_id -> compact JSON (no customer data)
//   <code>:cc_beats:<YYYY-MM-DD>   hash  5-min bucket -> g|a|r|n
//   cc:history_since               string ISO time of the first snapshot

const TZ = 'Europe/Zurich';
const VOID_STATUSES = new Set(['cancelled', 'canceled', 'refunded', 'failed', 'rejected', 'trash', 'checkout-draft']);
const ORDER_DAY_TTL_SECONDS = 40 * 86400;
const BEAT_TTL_SECONDS = 2 * 86400;
const BUCKET_MS = 5 * 60 * 1000;
const RECORD_INTERVAL_MS = 5 * 60 * 1000;

const zurichFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function zurichParts(date) {
  const out = {};
  for (const part of zurichFormat.formatToParts(date)) out[part.type] = part.value;
  return {
    day: `${out.year}-${out.month}-${out.day}`,
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
  };
}

function zurichOffsetMs(date) {
  const p = zurichParts(date);
  const [y, m, d] = p.day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, p.hour, p.minute);
  const instant = Math.floor(date.getTime() / 60000) * 60000;
  return wall - instant;
}

// received_at is ISO with Z. date_created from WordPress is Swiss wall time
// without offset ("2026-10-21 12:04:11"), so it must not be parsed as UTC.
function parseOrderTime(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    const dt = new Date(s.replace(' ', 'T'));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const offset = zurichOffsetMs(new Date(guess));
  const dt = new Date(guess - offset);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function orderTime(order) {
  return parseOrderTime(order?.received_at) || parseOrderTime(order?.date_created);
}

function addDays(day, n) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekdayShort(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function isVoidOrder(order, rejectedIds) {
  const status = String(order?.status || '').toLowerCase().replace(/^wc-/, '');
  if (VOID_STATUSES.has(status)) return true;
  return !!(rejectedIds && rejectedIds.has(String(order?.order_id)));
}

function normalizePayment(value) {
  const s = String(value || '').toLowerCase();
  if (!s) return 'Unknown';
  if (s.includes('twint')) return 'TWINT';
  if (/bar|cash|cod|nachnahme/.test(s)) return 'Cash';
  if (/card|karte|stripe|payrexx|credit|visa|master|apple|google|sumup/.test(s)) return 'Card';
  return 'Other';
}

function normalizeFulfillment(order) {
  const ft = String(order?.fulfillment_type || '').toLowerCase();
  if (ft === 'delivery' || ft === 'pickup' || ft === 'dine_in') return ft;
  return 'unknown';
}

function compactOrder(order, rejectedIds) {
  const time = orderTime(order);
  return {
    t: time ? time.toISOString() : null,
    total: Number(order?.total || 0) || 0,
    s: String(order?.status || ''),
    f: normalizeFulfillment(order),
    p: normalizePayment(order?.payment_method),
    v: isVoidOrder(order, rejectedIds) ? 1 : 0,
  };
}

function parseJsonList(values) {
  return (values || []).map(v => { try { return JSON.parse(v); } catch (_) { return null; } }).filter(Boolean);
}

function hashResultToObject(result) {
  if (!result) return {};
  if (!Array.isArray(result)) return typeof result === 'object' ? result : {};
  const out = {};
  for (let i = 0; i + 1 < result.length; i += 2) out[result[i]] = result[i + 1];
  return out;
}

function beatFromHeartbeat(heartbeat, nowMs) {
  if (!heartbeat?.last_seen) return 'n';
  const minutes = (nowMs - new Date(heartbeat.last_seen).getTime()) / 60000;
  if (!Number.isFinite(minutes)) return 'n';
  if (minutes < 10) return 'g';
  if (minutes < 30) return 'a';
  return 'r';
}

function createControlCenterStats({ redisCommand, k, logger = console, now = () => new Date() }) {
  const lastWritten = new Map();
  let ticking = false;
  let interval = null;

  async function rejectedIdsFor(code, orders) {
    const ids = orders.map(o => String(o?.order_id || '')).filter(Boolean);
    if (!ids.length) return new Set();
    const res = await redisCommand('MGET', ...ids.map(id => k(code, `rejected_time:${id}`)));
    const set = new Set();
    (res.result || []).forEach((value, i) => { if (value) set.add(ids[i]); });
    return set;
  }

  async function loadOrders(code) {
    const res = await redisCommand('LRANGE', k(code, 'orders'), 0, 99);
    return parseJsonList(res.result);
  }

  // Copies the current last-100 window into per-day history hashes.
  // Idempotent: HSET by order_id; unchanged orders are skipped in memory.
  async function snapshotRestaurant(code, preloaded) {
    const orders = preloaded?.orders || await loadOrders(code);
    const rejected = preloaded?.rejected || await rejectedIdsFor(code, orders);
    const byDay = new Map();
    for (const order of orders) {
      const id = String(order?.order_id || '');
      if (!id) continue;
      const rec = compactOrder(order, rejected);
      if (!rec.t) continue;
      const sig = JSON.stringify(rec);
      const memoKey = `${code}:${id}`;
      if (lastWritten.get(memoKey) === sig) continue;
      const day = zurichParts(new Date(rec.t)).day;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push([id, sig, memoKey]);
    }
    await Promise.all(Array.from(byDay.entries()).map(async ([day, entries]) => {
      const key = k(code, `cc_orders:${day}`);
      const args = [];
      entries.forEach(([id, sig]) => args.push(id, sig));
      await redisCommand('HSET', key, ...args);
      await redisCommand('EXPIRE', key, ORDER_DAY_TTL_SECONDS);
      entries.forEach(([, sig, memoKey]) => lastWritten.set(memoKey, sig));
    }));
    if (lastWritten.size > 20000) lastWritten.clear();
    return { orders, rejected };
  }

  async function recordBeat(code, heartbeat) {
    const nowMs = now().getTime();
    const bucket = Math.floor(nowMs / BUCKET_MS);
    const day = new Date(bucket * BUCKET_MS).toISOString().slice(0, 10);
    const key = k(code, `cc_beats:${day}`);
    await redisCommand('HSET', key, String(bucket), beatFromHeartbeat(heartbeat, nowMs));
    await redisCommand('EXPIRE', key, BEAT_TTL_SECONDS);
  }

  // Oldest -> newest. The newest bucket is always derived live from the
  // current heartbeat so the strip never lags behind the status pill.
  async function getBeats(code, heartbeat, count = 12) {
    const nowMs = now().getTime();
    const current = Math.floor(nowMs / BUCKET_MS);
    const buckets = [];
    for (let i = count - 1; i >= 0; i--) buckets.push(current - i);
    const byKey = new Map();
    buckets.slice(0, -1).forEach(b => {
      const key = k(code, `cc_beats:${new Date(b * BUCKET_MS).toISOString().slice(0, 10)}`);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(b);
    });
    const found = new Map();
    await Promise.all(Array.from(byKey.entries()).map(async ([key, list]) => {
      const res = await redisCommand('HMGET', key, ...list.map(String));
      (res.result || []).forEach((value, i) => { if (value) found.set(list[i], value); });
    }));
    return buckets.map((b, i) => (i === buckets.length - 1 ? beatFromHeartbeat(heartbeat, nowMs) : (found.get(b) || 'n')));
  }

  async function listCodes() {
    const res = await redisCommand('SMEMBERS', 'restaurants');
    return (res.result || []).map(c => String(c || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '')).filter(Boolean);
  }

  async function markHistoryStart() {
    await redisCommand('SET', 'cc:history_since', now().toISOString(), 'NX');
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await markHistoryStart();
      const codes = await listCodes();
      for (const code of codes) {
        try {
          const hbRaw = await redisCommand('GET', k(code, 'heartbeat'));
          let heartbeat = null;
          try { heartbeat = hbRaw.result ? JSON.parse(hbRaw.result) : null; } catch (_) {}
          await recordBeat(code, heartbeat);
          await snapshotRestaurant(code);
        } catch (error) {
          logger.warn?.(`[control-center] history tick failed for ${code}: ${error?.name || 'error'}`);
        }
      }
    } catch (error) {
      logger.warn?.(`[control-center] history tick failed: ${error?.name || 'error'}`);
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (interval) return;
    const first = setTimeout(() => { tick().catch(() => {}); }, 20000);
    first.unref?.();
    interval = setInterval(() => { tick().catch(() => {}); }, RECORD_INTERVAL_MS);
    interval.unref?.();
  }

  function stop() {
    if (interval) clearInterval(interval);
    interval = null;
  }

  async function readDay(code, day) {
    const res = await redisCommand('HGETALL', k(code, `cc_orders:${day}`));
    const obj = hashResultToObject(res.result);
    return Object.values(obj).map(v => { try { return JSON.parse(v); } catch (_) { return null; } }).filter(Boolean);
  }

  async function analytics(options = {}) {
    const nowDate = now();
    const nowParts = zurichParts(nowDate);
    const today = nowParts.day;
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(addDays(today, -i));
    const lastWeekDay = addDays(today, -7);
    const nowMinuteOfDay = nowParts.hour * 60 + nowParts.minute;

    await markHistoryStart();
    const sinceRaw = await redisCommand('GET', 'cc:history_since');
    const since = sinceRaw.result ? new Date(sinceRaw.result) : nowDate;
    const sinceDay = zurichParts(since).day;

    const allCodes = await listCodes();
    const codes = Array.isArray(options.codes) ? allCodes.filter(c => options.codes.includes(c)) : allCodes;
    const hourlyToday = Array(24).fill(0);
    const hourlyRevenueToday = Array(24).fill(0);
    const hourlyLastWeek = Array(24).fill(0);
    const daily = days.map(day => ({ day, label: `${weekdayShort(day)} ${Number(day.slice(8))}`, orders: 0, revenue: 0, complete: day > sinceDay }));
    const mix = { fulfillment: {}, payment: {} };
    const perRestaurant = [];
    const sameTime = { orders: 0, revenue: 0 };
    let rejectedToday = 0;
    let rejectedRevenueToday = 0;

    // Restaurants and days are read in parallel: Upstash is a remote REST API,
    // so sequential round trips would make the dashboard slow.
    const allDays = [...days, lastWeekDay];
    const perCode = await Promise.all(codes.map(async code => {
      try {
        await snapshotRestaurant(code);
      } catch (error) {
        logger.warn?.(`[control-center] analytics snapshot failed for ${code}: ${error?.name || 'error'}`);
      }
      const recordsByDay = await Promise.all(allDays.map(day => readDay(code, day).catch(() => [])));
      return { code, recordsByDay };
    }));

    for (const { code, recordsByDay } of perCode) {
      const entry = { code, orders: 0, revenue: 0 };
      for (let di = 0; di < allDays.length; di++) {
        const day = allDays[di];
        const records = recordsByDay[di];
        for (const rec of records) {
          const t = rec.t ? new Date(rec.t) : null;
          if (!t || Number.isNaN(t.getTime())) continue;
          const p = zurichParts(t);
          if (p.day !== day) continue;
          const total = Number(rec.total || 0) || 0;
          if (day === today && rec.v) { rejectedToday += 1; rejectedRevenueToday += total; }
          if (rec.v) continue;
          if (day === lastWeekDay) {
            hourlyLastWeek[p.hour] += 1;
            if (p.hour * 60 + p.minute <= nowMinuteOfDay) { sameTime.orders += 1; sameTime.revenue += total; }
            continue;
          }
          const d = daily.find(x => x.day === day);
          if (d) { d.orders += 1; d.revenue += total; }
          if (day === today) {
            hourlyToday[p.hour] += 1;
            hourlyRevenueToday[p.hour] += total;
            entry.orders += 1;
            entry.revenue += total;
            mix.fulfillment[rec.f || 'unknown'] = (mix.fulfillment[rec.f || 'unknown'] || 0) + 1;
            mix.payment[rec.p || 'Unknown'] = (mix.payment[rec.p || 'Unknown'] || 0) + 1;
          }
        }
      }
      perRestaurant.push(entry);
    }

    const todayTotals = daily[daily.length - 1];
    return {
      timezone: TZ,
      generated_at: nowDate.toISOString(),
      today,
      now_hour: nowParts.hour,
      now_minute: nowParts.minute,
      history_since: since.toISOString(),
      today_complete: today > sinceDay,
      last_week_day: lastWeekDay,
      last_week_label: `${weekdayShort(lastWeekDay)} ${Number(lastWeekDay.slice(8))}`,
      last_week_complete: lastWeekDay > sinceDay,
      hourly: { today: hourlyToday, today_revenue: hourlyRevenueToday, last_week: hourlyLastWeek },
      daily,
      same_time_last_week: sameTime,
      today_totals: { orders: todayTotals.orders, revenue: todayTotals.revenue, rejected: rejectedToday, rejected_revenue: rejectedRevenueToday },
      mix,
      restaurants: perRestaurant,
    };
  }

  return { start, stop, tick, snapshotRestaurant, recordBeat, getBeats, analytics, rejectedIdsFor };
}

module.exports = {
  createControlCenterStats,
  zurichParts,
  parseOrderTime,
  orderTime,
  isVoidOrder,
  normalizePayment,
  addDays,
  beatFromHeartbeat,
  VOID_STATUSES,
};
