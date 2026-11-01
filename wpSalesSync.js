// FoodUp Orders - sales history sent by WordPress.
//
// The backend only keeps the newest 100 orders per restaurant, so older sales
// cannot be counted from them. WordPress/WooCommerce holds every order: the
// FoodUp Ordering plugin (0.5.257+) sends the DAILY totals to POST /stats-history
// (same address and restaurant secret as new orders). They are stored in the
// daily store the app statistics read (dailyStats.js, key <code>:stats_wp).
//
// Rules:
// - Only complete days are accepted: today and later are ignored (today stays live).
// - Days before the "clear orders" date (floor) are ignored.
// - Every day of the sent range is written, with zeros for days without orders,
//   so a day that lost its orders in WordPress is corrected too.

const { zurichParts, addDays } = require('./controlCenterStats');

const MAX_RANGE_DAYS = 62;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRealDay(value) {
  if (!DAY_PATTERN.test(String(value))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function daysBetween(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

function cleanNumber(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return n;
}

function cleanRow(row) {
  if (!row || typeof row !== 'object') return null;
  const out = {
    o: cleanNumber(row.o, 100000),
    cash: cleanNumber(row.cash, 1e9),
    online: cleanNumber(row.online, 1e9),
    del: cleanNumber(row.del, 100000),
    pick: cleanNumber(row.pick, 100000),
  };
  return Object.values(out).some(v => v === null) ? null : out;
}

// Every day of from..to gets an entry (zeros for days WordPress did not list).
function fillDays(from, to, wpDays) {
  const days = {};
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const row = wpDays && wpDays[day];
    days[day] = row || { o: 0, cash: 0, online: 0, del: 0, pick: 0 };
  }
  return days;
}

// Validates and stores one batch. Returns { status, body } for the route.
function createSalesHistoryReceiver({ dailyStats, onUpdated = () => {}, logger = console, now = () => Date.now() }) {
  async function receive(code, body) {
    const from = body && body.from;
    const to = body && body.to;
    if (!isRealDay(from) || !isRealDay(to) || from > to || daysBetween(from, to) > MAX_RANGE_DAYS - 1) {
      return { status: 400, body: { success: false, code: 'bad_range', message: 'from/to must be YYYY-MM-DD, at most 62 days.' } };
    }
    const rawDays = body.days;
    if (!rawDays || typeof rawDays !== 'object' || Array.isArray(rawDays)) {
      return { status: 400, body: { success: false, code: 'bad_days', message: 'days must be an object.' } };
    }
    const clean = {};
    for (const [day, row] of Object.entries(rawDays)) {
      if (!isRealDay(day) || day < from || day > to) {
        return { status: 400, body: { success: false, code: 'bad_day', message: `Unexpected day ${String(day).slice(0, 12)}.` } };
      }
      const cleaned = cleanRow(row);
      if (!cleaned) {
        return { status: 400, body: { success: false, code: 'bad_row', message: `Invalid numbers for ${day}.` } };
      }
      clean[day] = cleaned;
    }

    const today = zurichParts(new Date(now())).day;
    const floor = await dailyStats.readWpFloor(code);
    const start = floor && floor > from ? floor : from;
    const lastDay = addDays(today, -1);
    const end = to < lastDay ? to : lastDay;
    let stored = 0;
    if (start <= end) {
      const days = fillDays(start, end, clean);
      await dailyStats.writeWpDays(code, days);
      stored = Object.keys(days).length;
    }
    logger.log(`stats: sales history received for ${code} ${from}..${to} (${stored} days stored)`);
    if (stored > 0) {
      try { onUpdated(code); } catch (_) { /* cache clearing is best effort */ }
    }
    return { status: 200, body: { success: true, stored_days: stored } };
  }
  return { receive };
}

module.exports = { createSalesHistoryReceiver, fillDays, isRealDay };
