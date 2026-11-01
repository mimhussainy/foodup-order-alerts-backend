// FoodUp Orders - daily statistics.
//
// Problem this solves: the app statistics were calculated from the newest 100
// orders of a restaurant (the `<code>:orders` list), so "this month", "this
// year" and "last year" stopped growing once a restaurant had 100 orders.
//
// Keys written (never read by the apps or WordPress, only by this module):
//   <code>:stats_daily             hash  YYYY-MM-DD -> JSON {o,cash,online,del,pick}
//   <code>:stats_day_orders:<day>  hash  order_id   -> JSON {o,cash,online,del,pick}
//   <code>:stats_daily_ready       string ISO time the first backfill ran
//   <code>:stats_wp                hash  YYYY-MM-DD -> JSON {o,cash,online,del,pick}
//                                  complete past days sent by WordPress/WooCommerce
//   <code>:stats_wp_floor          string YYYY-MM-DD, set by "clear orders": older
//                                  WordPress days are ignored from then on
//
// Every order is stored under its own id, so a status change (cancelled,
// refunded) replaces the earlier entry and the day total is always re-added
// from the entries: nothing is ever counted twice.

const { zurichParts, orderTime, isVoidOrder } = require('./controlCenterStats');

const DAY_ORDERS_TTL_SECONDS = 400 * 86400;

function isCashPayment(paymentMethod) {
  const method = String(paymentMethod || '').toLowerCase();
  return method.includes('bar') || method.includes('cash');
}

function parseTotal(value) {
  const total = parseFloat(value || '0');
  return Number.isFinite(total) ? total : 0;
}

function isPickup(order) {
  return String(order?.fulfillment_type || '').toLowerCase() === 'pickup'
    || order?.shipping?.method === 'Abholung';
}

// One order -> { day, entry }. `o` is 1 when the order counts (not cancelled,
// refunded, failed ...). Orders that do not count are still stored (as zeros)
// so a later status change can replace them.
function contribution(order) {
  const time = orderTime(order);
  if (!time || !order?.order_id) return null;
  const counts = !isVoidOrder(order);
  const total = counts ? parseTotal(order.total) : 0;
  const cash = counts && isCashPayment(order.payment_method);
  const pickup = counts && isPickup(order);
  return {
    day: zurichParts(time).day,
    entry: {
      o: counts ? 1 : 0,
      cash: cash ? total : 0,
      online: counts && !cash ? total : 0,
      del: counts && !pickup ? 1 : 0,
      pick: pickup ? 1 : 0,
    },
  };
}

function emptySummary() {
  return { o: 0, cash: 0, online: 0, del: 0, pick: 0 };
}

function addInto(sum, entry) {
  sum.o += Number(entry.o) || 0;
  sum.cash += Number(entry.cash) || 0;
  sum.online += Number(entry.online) || 0;
  sum.del += Number(entry.del) || 0;
  sum.pick += Number(entry.pick) || 0;
  return sum;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function hashToObject(result) {
  if (!result) return {};
  if (!Array.isArray(result)) return typeof result === 'object' ? result : {};
  const out = {};
  for (let i = 0; i + 1 < result.length; i += 2) out[result[i]] = result[i + 1];
  return out;
}

// ---- calendar helpers (all in Swiss time, like the restaurants) ------------

function dayParts(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return { y, m, d };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Monday of the week the given day is in.
function weekStartDay(day) {
  const { y, m, d } = dayParts(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  const back = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}

function periodStarts(nowMs) {
  const today = zurichParts(new Date(nowMs)).day;
  const { y, m } = dayParts(today);
  return {
    today,
    week: weekStartDay(today),
    month: `${y}-${pad(m)}-01`,
    year: `${y}-01-01`,
    previousYear: `${y - 1}-01-01`,
  };
}

function sumDays(daily, fromDay, toDayExclusive) {
  const sum = emptySummary();
  for (const [day, entry] of Object.entries(daily)) {
    if (day < fromDay) continue;
    if (toDayExclusive && day >= toDayExclusive) continue;
    addInto(sum, entry);
  }
  return {
    totalOrders: sum.o,
    cash: round2(sum.cash),
    online: round2(sum.online),
    total: round2(sum.cash + sum.online),
    deliveries: sum.del,
    pickups: sum.pick,
  };
}

// Same shape as the old statsBuildPeriod() results, so the apps need no change.
function buildPeriods(daily, nowMs) {
  const s = periodStarts(nowMs);
  return {
    today: sumDays(daily, s.today),
    week: sumDays(daily, s.week),
    month: sumDays(daily, s.month),
    year: sumDays(daily, s.year),
    previousYear: sumDays(daily, s.previousYear, s.year),
  };
}

// Past days come from WordPress (it holds every order), today from the live
// records of this backend. `floor` hides WordPress days before a "clear orders".
function mergeDaily(live, wp, today, floor = '') {
  const merged = { ...live };
  for (const [day, entry] of Object.entries(wp || {})) {
    if (day >= today) continue;
    if (floor && day < floor) continue;
    merged[day] = entry;
  }
  return merged;
}

// ---- storage ----------------------------------------------------------------

function createDailyStats({ redisCommand, k, withLock = async (_key, fn) => fn(), logger = console }) {
  const readyCodes = new Set();

  async function recomputeDay(code, day) {
    const res = await redisCommand('HVALS', k(code, `stats_day_orders:${day}`));
    const sum = emptySummary();
    for (const raw of res.result || []) {
      const entry = parseJson(raw);
      if (entry) addInto(sum, entry);
    }
    sum.cash = round2(sum.cash);
    sum.online = round2(sum.online);
    await redisCommand('HSET', k(code, 'stats_daily'), day, JSON.stringify(sum));
  }

  async function recordOrders(code, orders) {
    const byDay = new Map();
    for (const order of orders || []) {
      const c = contribution(order);
      if (!c) continue;
      if (!byDay.has(c.day)) byDay.set(c.day, []);
      byDay.get(c.day).push(String(order.order_id), JSON.stringify(c.entry));
    }
    for (const [day, fieldsAndValues] of byDay) {
      const key = k(code, `stats_day_orders:${day}`);
      await redisCommand('HSET', key, ...fieldsAndValues);
      await redisCommand('EXPIRE', key, DAY_ORDERS_TTL_SECONDS);
      await recomputeDay(code, day);
    }
  }

  // First use for a restaurant: take over the orders that are still in the
  // `<code>:orders` list so the numbers do not start from zero.
  async function ensureReady(code, orders) {
    if (readyCodes.has(code)) return;
    const marker = await redisCommand('GET', k(code, 'stats_daily_ready'));
    if (!marker.result) {
      await withLock(k(code, 'stats_lock'), async () => {
        await recordOrders(code, orders);
        await redisCommand('SET', k(code, 'stats_daily_ready'), new Date().toISOString(), 'NX');
      });
    }
    readyCodes.add(code);
  }

  async function recordOrder(code, order) {
    await recordOrders(code, [order]);
  }

  async function readHash(key) {
    const res = await redisCommand('HGETALL', key);
    const raw = hashToObject(res.result);
    const out = {};
    for (const [day, value] of Object.entries(raw)) {
      const entry = parseJson(value);
      if (entry) out[day] = entry;
    }
    return out;
  }

  async function readWpFloor(code) {
    const res = await redisCommand('GET', k(code, 'stats_wp_floor'));
    return res.result ? String(res.result) : '';
  }

  // Complete days sent by WordPress, written by wpSalesSync.js.
  async function writeWpDays(code, days) {
    const entries = Object.entries(days || {});
    for (let i = 0; i < entries.length; i += 40) {
      const args = [];
      for (const [day, entry] of entries.slice(i, i + 40)) {
        const sum = addInto(emptySummary(), entry);
        sum.cash = round2(sum.cash);
        sum.online = round2(sum.online);
        args.push(day, JSON.stringify(sum));
      }
      await redisCommand('HSET', k(code, 'stats_wp'), ...args);
    }
  }

  async function readDaily(code, nowMs = Date.now()) {
    const live = await readHash(k(code, 'stats_daily'));
    let wp = {};
    let floor = '';
    try {
      [wp, floor] = await Promise.all([readHash(k(code, 'stats_wp')), readWpFloor(code)]);
    } catch (_) {
      wp = {}; // WordPress history is optional: fall back to the live records
    }
    return mergeDaily(live, wp, periodStarts(nowMs).today, floor);
  }

  // "Clear orders" in the app resets the numbers as it always did.
  async function clear(code) {
    const res = await redisCommand('HKEYS', k(code, 'stats_daily'));
    for (const day of res.result || []) {
      await redisCommand('DEL', k(code, `stats_day_orders:${day}`));
    }
    await redisCommand('DEL', k(code, 'stats_daily'));
    await redisCommand('DEL', k(code, 'stats_daily_ready'));
    // Also reset the history that came from WordPress, and do not pull it back.
    await redisCommand('DEL', k(code, 'stats_wp'));
    await redisCommand('SET', k(code, 'stats_wp_floor'), periodStarts(Date.now()).today);
    readyCodes.delete(code);
  }

  return { ensureReady, recordOrder, readDaily, clear, recomputeDay, writeWpDays, readWpFloor };
}

module.exports = {
  createDailyStats,
  contribution,
  buildPeriods,
  periodStarts,
  weekStartDay,
  sumDays,
  isCashPayment,
  mergeDaily,
};
