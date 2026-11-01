const test = require('node:test');
const assert = require('node:assert/strict');
const { createDailyStats, buildPeriods, mergeDaily, periodStarts } = require('../dailyStats');
const { createSalesHistoryReceiver, fillDays, isRealDay } = require('../wpSalesSync');

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
const NOW = Date.parse('2026-11-01T11:00:00Z'); // Sunday 2026-11-01 in Zurich
const silent = { log() {} };
const row = (o, cash, online, del = o, pick = 0) => ({ o, cash, online, del, pick });

function setup(nowRef = { t: NOW }) {
  const r = fakeRedis();
  const dailyStats = createDailyStats({ redisCommand: r.redisCommand, k });
  let updates = 0;
  const receiver = createSalesHistoryReceiver({ dailyStats, onUpdated: () => { updates++; }, logger: silent, now: () => nowRef.t });
  return { r, dailyStats, receiver, nowRef, updates: () => updates };
}

test('isRealDay accepts real dates only', () => {
  assert.equal(isRealDay('2026-02-28'), true);
  assert.equal(isRealDay('2026-02-30'), false);
  assert.equal(isRealDay('2026-2-3'), false);
  assert.equal(isRealDay('x'), false);
});

test('fillDays gives zeros for days WordPress did not list', () => {
  const days = fillDays('2026-01-01', '2026-01-03', { '2026-01-02': row(2, 10, 5.5, 1, 1) });
  assert.deepEqual(Object.keys(days), ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.equal(days['2026-01-01'].o, 0);
  assert.equal(days['2026-01-02'].online, 5.5);
});

test('stored history feeds the statistics; past days come from WordPress, today stays live', async () => {
  const { dailyStats, receiver, updates } = setup();
  await dailyStats.recordOrder('a', { order_id: 9, received_at: '2026-11-01T09:00:00Z', total: '25', payment_method: 'Online', status: 'processing', shipping: { method: 'Lieferung' } });
  await dailyStats.recordOrder('a', { order_id: 8, received_at: '2026-10-15T10:00:00Z', total: '999', payment_method: 'Online', status: 'processing', shipping: { method: 'Lieferung' } });

  const a = await receiver.receive('a', { from: '2025-01-01', to: '2025-01-31', days: { '2025-01-05': row(3, 30, 60, 2, 1) } });
  const b = await receiver.receive('a', { from: '2026-10-01', to: '2026-10-31', days: { '2026-10-15': row(4, 40, 10, 4, 0) } });
  assert.equal(a.status, 200);
  assert.equal(b.body.stored_days, 31);
  assert.ok(updates() >= 2);

  const p = buildPeriods(await dailyStats.readDaily('a', NOW), NOW);
  assert.equal(p.previousYear.totalOrders, 3);   // 2025 exists only in WordPress
  assert.equal(p.previousYear.total, 90);
  assert.equal(p.year.totalOrders, 4 + 1);       // WP 15 Oct (live 999 replaced) + live today
  assert.equal(p.year.total, 50 + 25);
  assert.equal(p.today.totalOrders, 1);
});

test('today and later are never taken from WordPress (the day is not complete)', async () => {
  const { dailyStats, receiver } = setup();
  const out = await receiver.receive('a', { from: '2026-10-30', to: '2026-11-03', days: { '2026-10-31': row(2, 0, 20), '2026-11-01': row(9, 0, 999), '2026-11-02': row(9, 0, 999) } });
  assert.equal(out.body.stored_days, 2); // 30 Oct (zero) and 31 Oct
  const wp = await dailyStats.readDaily('a', NOW);
  assert.equal(wp['2026-11-01'], undefined);
  assert.equal(wp['2026-10-31'].online, 20);
});

test('a range that is entirely today or later stores nothing', async () => {
  const { receiver, updates } = setup();
  const out = await receiver.receive('a', { from: '2026-11-01', to: '2026-11-02', days: {} });
  assert.equal(out.status, 200);
  assert.equal(out.body.stored_days, 0);
  assert.equal(updates(), 0);
});

test('a later push replaces earlier numbers (refund or cancellation), including days that dropped to zero', async () => {
  const { dailyStats, receiver } = setup();
  await receiver.receive('a', { from: '2026-10-01', to: '2026-10-03', days: { '2026-10-01': row(2, 0, 30), '2026-10-02': row(1, 0, 10) } });
  await receiver.receive('a', { from: '2026-10-01', to: '2026-10-03', days: { '2026-10-01': row(1, 0, 12) } });
  const p = buildPeriods(await dailyStats.readDaily('a', NOW), NOW);
  assert.equal(p.month.totalOrders, 0);
  const daily = await dailyStats.readDaily('a', NOW);
  assert.equal(daily['2026-10-01'].o, 1);
  assert.equal(daily['2026-10-02'].o, 0);
});

test('bad input is rejected and stores nothing', async () => {
  const { r, receiver } = setup();
  const bad = [
    { from: 'x', to: '2026-10-01', days: {} },
    { from: '2026-10-05', to: '2026-10-01', days: {} },
    { from: '2025-01-01', to: '2026-10-01', days: {} },
    { from: '2026-10-01', to: '2026-10-02', days: [] },
    { from: '2026-10-01', to: '2026-10-02', days: { '2026-09-30': row(1, 0, 1) } },
    { from: '2026-10-01', to: '2026-10-02', days: { '2026-10-01': { o: -1, cash: 0, online: 0, del: 0, pick: 0 } } },
    { from: '2026-10-01', to: '2026-10-02', days: { '2026-10-01': { o: 'a', cash: 0, online: 0, del: 0, pick: 0 } } },
    { from: '2026-10-01', to: '2026-10-02', days: { '2026-10-01': null } },
    null,
  ];
  for (const body of bad) {
    const out = await receiver.receive('a', body);
    assert.equal(out.status, 400, JSON.stringify(body));
  }
  assert.equal(r.hashes.has('a:stats_wp'), false);
});

test('clear orders resets everything; WordPress days before it stay hidden', async () => {
  const { dailyStats, receiver } = setup();
  await receiver.receive('a', { from: '2026-10-01', to: '2026-10-31', days: { '2026-10-01': row(5, 50, 0) } });
  assert.equal(buildPeriods(await dailyStats.readDaily('a', NOW), NOW).year.totalOrders, 5);
  await dailyStats.clear('a');
  assert.equal(buildPeriods(await dailyStats.readDaily('a', NOW), NOW).year.totalOrders, 0);
  assert.equal(await dailyStats.readWpFloor('a'), periodStarts(Date.now()).today);
});

test('mergeDaily ignores WordPress for today and for days before the floor', () => {
  const live = { '2026-11-01': row(1, 0, 5) };
  const wp = {
    '2026-11-01': row(99, 0, 999),
    '2026-10-01': row(2, 0, 20),
    '2026-09-01': row(3, 0, 30),
  };
  const merged = mergeDaily(live, wp, '2026-11-01', '2026-10-01');
  assert.equal(merged['2026-11-01'].o, 1);
  assert.equal(merged['2026-10-01'].o, 2);
  assert.equal(merged['2026-09-01'], undefined);
});
