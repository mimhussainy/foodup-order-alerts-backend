const test = require('node:test');
const assert = require('node:assert/strict');
const { createDailyStats, contribution, buildPeriods, periodStarts, weekStartDay } = require('../dailyStats');

function fakeRedis() {
  const strings = new Map();
  const hashes = new Map();
  async function redisCommand(cmd, ...args) {
    switch (cmd) {
      case 'GET': return { result: strings.has(args[0]) ? strings.get(args[0]) : null };
      case 'SET':
        if (args.includes('NX') && strings.has(args[0])) return { result: null };
        strings.set(args[0], args[1]);
        return { result: 'OK' };
      case 'EXPIRE': return { result: 1 };
      case 'HSET': {
        const h = hashes.get(args[0]) || new Map();
        for (let i = 1; i + 1 < args.length; i += 2) h.set(args[i], args[i + 1]);
        hashes.set(args[0], h);
        return { result: 1 };
      }
      case 'HVALS': return { result: Array.from((hashes.get(args[0]) || new Map()).values()) };
      case 'HKEYS': return { result: Array.from((hashes.get(args[0]) || new Map()).keys()) };
      case 'HGETALL': {
        const out = [];
        for (const [f, v] of (hashes.get(args[0]) || new Map())) out.push(f, v);
        return { result: out };
      }
      case 'DEL': hashes.delete(args[0]); strings.delete(args[0]); return { result: 1 };
      default: throw new Error('unexpected ' + cmd);
    }
  }
  return { redisCommand, strings, hashes };
}

const k = (code, key) => `${code}:${key}`;
const NOW = Date.parse('2026-11-01T11:00:00Z'); // Sunday 12:00 Zurich

function order(id, iso, total, extra = {}) {
  return { order_id: id, received_at: iso, total: String(total), payment_method: 'Online', status: 'processing', shipping: { method: 'Lieferung' }, ...extra };
}

test('contribution splits cash/online, pickup/delivery and ignores void orders', () => {
  const cash = contribution(order(1, '2026-11-01T10:00:00Z', 20.5, { payment_method: 'Barzahlung' }));
  assert.deepEqual(cash.entry, { o: 1, cash: 20.5, online: 0, del: 1, pick: 0 });
  const pick = contribution(order(2, '2026-11-01T10:00:00Z', 10, { shipping: { method: 'Abholung' } }));
  assert.deepEqual(pick.entry, { o: 1, cash: 0, online: 10, del: 0, pick: 1 });
  const pick2 = contribution(order(3, '2026-11-01T10:00:00Z', 10, { fulfillment_type: 'pickup' }));
  assert.equal(pick2.entry.pick, 1);
  for (const status of ['cancelled', 'refunded', 'failed']) {
    const v = contribution(order(4, '2026-11-01T10:00:00Z', 99, { status }));
    assert.deepEqual(v.entry, { o: 0, cash: 0, online: 0, del: 0, pick: 0 });
  }
  assert.equal(contribution({ order_id: 5, total: '1' }), null);
});

test('day is the Swiss calendar day (23:30Z on 31 Oct is already 1 Nov in winter time)', () => {
  assert.equal(contribution(order(1, '2026-10-31T23:30:00Z', 5)).day, '2026-11-01');
  assert.equal(contribution(order(2, '2026-07-01T22:30:00Z', 5)).day, '2026-07-02');
});

test('period starts: Sunday 1 Nov 2026 belongs to the week of Monday 26 Oct', () => {
  assert.equal(weekStartDay('2026-11-01'), '2026-10-26');
  assert.equal(weekStartDay('2026-10-26'), '2026-10-26');
  assert.deepEqual(periodStarts(NOW), { today: '2026-11-01', week: '2026-10-26', month: '2026-11-01', year: '2026-01-01', previousYear: '2025-01-01' });
});

test('more than 100 orders are all counted for month, year and last year', async () => {
  const r = fakeRedis();
  const stats = createDailyStats({ redisCommand: r.redisCommand, k });
  const orders = [];
  let id = 1;
  const add = (iso, n, total) => { for (let i = 0; i < n; i++) orders.push(order(id++, iso, total)); };
  add('2025-06-10T10:00:00Z', 30, 10);   // last year: 300
  add('2026-03-10T10:00:00Z', 120, 10);  // this year, March: 1200
  add('2026-10-28T10:00:00Z', 20, 10);   // this week, October: 200
  add('2026-11-01T09:00:00Z', 5, 10);    // today: 50
  for (const o of orders) await stats.ensureReady('grill', []), await stats.recordOrder('grill', o);
  const p = buildPeriods(await stats.readDaily('grill'), NOW);
  assert.equal(p.today.totalOrders, 5);
  assert.equal(p.today.total, 50);
  assert.equal(p.week.totalOrders, 25);
  assert.equal(p.month.totalOrders, 5);
  assert.equal(p.year.totalOrders, 145);
  assert.equal(p.year.total, 1450);
  assert.equal(p.previousYear.totalOrders, 30);
  assert.equal(p.previousYear.total, 300);
});

test('a status change replaces the order instead of counting it twice', async () => {
  const r = fakeRedis();
  const stats = createDailyStats({ redisCommand: r.redisCommand, k });
  await stats.recordOrder('a', order(7, '2026-11-01T09:00:00Z', 40));
  await stats.recordOrder('a', order(7, '2026-11-01T09:00:00Z', 40, { status: 'completed' }));
  let p = buildPeriods(await stats.readDaily('a'), NOW);
  assert.equal(p.today.totalOrders, 1);
  assert.equal(p.today.total, 40);
  await stats.recordOrder('a', order(7, '2026-11-01T09:00:00Z', 40, { status: 'cancelled' }));
  p = buildPeriods(await stats.readDaily('a'), NOW);
  assert.equal(p.today.totalOrders, 0);
  assert.equal(p.today.total, 0);
});

test('backfill takes over the existing list once and does not double count', async () => {
  const r = fakeRedis();
  const stats = createDailyStats({ redisCommand: r.redisCommand, k });
  const list = [order(1, '2026-11-01T09:00:00Z', 12), order(2, '2026-10-20T09:00:00Z', 8)];
  await stats.ensureReady('b', list);
  await stats.ensureReady('b', list);
  const again = createDailyStats({ redisCommand: r.redisCommand, k }); // e.g. after a restart
  await again.ensureReady('b', list);
  await again.recordOrder('b', list[0]);
  const p = buildPeriods(await again.readDaily('b'), NOW);
  assert.equal(p.year.totalOrders, 2);
  assert.equal(p.year.total, 20);
  assert.equal(p.today.totalOrders, 1);
});

test('clear resets the numbers', async () => {
  const r = fakeRedis();
  const stats = createDailyStats({ redisCommand: r.redisCommand, k });
  await stats.ensureReady('c', [order(1, '2026-11-01T09:00:00Z', 12)]);
  await stats.clear('c');
  assert.deepEqual(await stats.readDaily('c'), {});
  assert.equal(r.strings.has('c:stats_daily_ready'), false);
});
