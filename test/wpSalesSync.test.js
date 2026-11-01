const test = require('node:test');
const assert = require('node:assert/strict');
const { createDailyStats, buildPeriods, mergeDaily, periodStarts } = require('../dailyStats');
const { createWpSalesSync, planSync, chunkRanges, fillDays } = require('../wpSalesSync');

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

function wpAnswer(days, extra = {}) {
  return { ok: true, status: 200, async json() { return { success: true, partial: false, days, ...extra }; } };
}

function setup({ fetchWordPress, nowRef = { t: NOW }, website = 'https://shop.example' } = {}) {
  const r = fakeRedis();
  const dailyStats = createDailyStats({ redisCommand: r.redisCommand, k });
  const calls = [];
  const sync = createWpSalesSync({
    redisCommand: r.redisCommand, k,
    fetchWordPress: async (code, url, options) => { calls.push(url); return fetchWordPress(code, url, options); },
    getBaseUrl: async () => website,
    dailyStats, logger: silent, now: () => nowRef.t,
  });
  return { r, dailyStats, sync, calls, nowRef };
}

test('chunkRanges splits into <= 31 day blocks without gaps', () => {
  const ranges = chunkRanges('2025-01-01', '2025-03-10');
  assert.equal(ranges[0].from, '2025-01-01');
  assert.equal(ranges[ranges.length - 1].to, '2025-03-10');
  for (let i = 1; i < ranges.length; i++) {
    const prev = new Date(ranges[i - 1].to + 'T00:00:00Z').getTime();
    assert.equal(new Date(ranges[i].from + 'T00:00:00Z').getTime() - prev, 86400000);
  }
});

test('fillDays gives zeros for days WordPress did not list', () => {
  const days = fillDays('2026-01-01', '2026-01-03', { '2026-01-02': { o: 2, cash: 10, online: 5.5, del: 1, pick: 1 } });
  assert.deepEqual(Object.keys(days), ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.equal(days['2026-01-01'].o, 0);
  assert.equal(days['2026-01-02'].online, 5.5);
});

test('planSync: full first, then nothing, then recent refresh, then weekly full', () => {
  const today = '2026-11-01';
  assert.deepEqual(planSync(null, today, '', NOW), { full: true, from: '2025-01-01', to: today });
  const fresh = { at: NOW - 3600e3, from: '2025-01-01', fullAt: NOW - 3600e3 };
  assert.equal(planSync(fresh, today, '', NOW), null);
  const old = { at: NOW - 7 * 3600e3, from: '2025-01-01', fullAt: NOW - 3600e3 };
  assert.deepEqual(planSync(old, today, '', NOW), { full: false, from: '2026-10-18', to: today });
  const weekly = { at: NOW - 3600e3, from: '2025-01-01', fullAt: NOW - 8 * 86400e3 };
  assert.equal(planSync(weekly, today, '', NOW).full, true);
  const covered = { at: NOW - 3600e3, from: '2025-01-01', fullAt: NOW };
  assert.equal(planSync(covered, '2027-01-02', '', NOW), null);      // history from 2025 already covers 2026+
  const short = { at: NOW - 3600e3, from: '2026-01-01', fullAt: NOW };
  assert.equal(planSync(short, '2026-11-01', '', NOW).full, true);   // last year missing -> full
  assert.equal(planSync({ ...fresh, retryAt: NOW + 1000 }, today, '', NOW), null);
});

test('full sync stores the history; past days come from WordPress, today stays live', async () => {
  const { dailyStats, sync, calls } = setup({
    fetchWordPress: async (code, url) => {
      const from = new URL(url).searchParams.get('from');
      if (from === '2025-01-01') return wpAnswer({ '2025-01-05': { o: 3, cash: 30, online: 60, del: 2, pick: 1 } });
      if (from <= '2026-10-31') return wpAnswer({ '2026-10-15': { o: 4, cash: 40, online: 10, del: 4, pick: 0 } });
      return wpAnswer({});
    },
  });
  // a live record for today and for a past day the WordPress copy also knows
  await dailyStats.recordOrder('a', { order_id: 9, received_at: '2026-11-01T09:00:00Z', total: '25', payment_method: 'Online', status: 'processing', shipping: { method: 'Lieferung' } });
  await dailyStats.recordOrder('a', { order_id: 8, received_at: '2026-10-15T10:00:00Z', total: '999', payment_method: 'Online', status: 'processing', shipping: { method: 'Lieferung' } });

  const result = await sync.maybeSync('a');
  assert.equal(result.synced, true);
  assert.ok(calls.length >= 20, 'two years in month blocks');
  assert.ok(calls.every(u => u.startsWith('https://shop.example/wp-json/foodup/v1/sales-history?')));

  const p = buildPeriods(await dailyStats.readDaily('a', NOW), NOW);
  assert.equal(p.previousYear.totalOrders, 3);        // 2025 only exists in WordPress
  assert.equal(p.previousYear.total, 90);
  assert.equal(p.year.totalOrders, 4 + 1);            // WP 15 Oct (live 999 is replaced) + live today
  assert.equal(p.year.total, 50 + 25);
  assert.equal(p.today.totalOrders, 1);
});

test('second call is skipped until the refresh time, then only the last days are asked', async () => {
  const { sync, calls, nowRef } = setup({ fetchWordPress: async () => wpAnswer({}) });
  await sync.maybeSync('a');
  const firstCalls = calls.length;
  assert.deepEqual(await sync.maybeSync('a'), { skipped: true });
  assert.equal(calls.length, firstCalls);
  nowRef.t += 7 * 3600e3;
  const again = await sync.maybeSync('a');
  assert.equal(again.synced, true);
  assert.equal(again.full, false);
  assert.equal(calls.length, firstCalls + 1);
});

test('a failing WordPress never breaks the numbers and retries later', async () => {
  let fail = true;
  const { dailyStats, sync, r, nowRef } = setup({
    fetchWordPress: async () => (fail ? { ok: false, status: 404, async json() { return {}; } } : wpAnswer({ '2026-10-01': { o: 1, cash: 5, online: 0, del: 1, pick: 0 } })),
  });
  await dailyStats.recordOrder('a', { order_id: 1, received_at: '2026-10-20T10:00:00Z', total: '12', payment_method: 'Online', status: 'processing', shipping: { method: 'Lieferung' } });
  const failed = await sync.maybeSync('a');
  assert.equal(failed.failed, true);
  assert.deepEqual(buildPeriods(await dailyStats.readDaily('a', NOW), NOW).year.totalOrders, 1); // live data still there
  assert.deepEqual(await sync.maybeSync('a'), { skipped: true });   // waits for retryAt
  fail = false;
  nowRef.t += 7 * 3600e3;
  assert.equal((await sync.maybeSync('a')).synced, true);
  assert.equal(r.strings.has('a:stats_wp_lock'), false);
});

test('a partial answer is not stored', async () => {
  const { sync, r } = setup({ fetchWordPress: async () => wpAnswer({ '2026-10-01': { o: 9, cash: 1, online: 1, del: 9, pick: 0 } }, { partial: true }) });
  const out = await sync.maybeSync('a');
  assert.equal(out.failed, true);
  assert.equal(r.hashes.has('a:stats_wp'), false);
});

test('clear orders resets everything and WordPress days before it stay hidden', async () => {
  const { dailyStats, sync } = setup({ fetchWordPress: async () => wpAnswer({ '2026-10-01': { o: 5, cash: 50, online: 0, del: 5, pick: 0 } }) });
  await sync.maybeSync('a');
  assert.equal(buildPeriods(await dailyStats.readDaily('a', NOW), NOW).year.totalOrders, 5);
  await dailyStats.clear('a');
  assert.equal(buildPeriods(await dailyStats.readDaily('a', NOW), NOW).year.totalOrders, 0);
  assert.equal(await dailyStats.readWpFloor('a'), periodStarts(Date.now()).today);
});

test('mergeDaily ignores WordPress for today and for days before the floor', () => {
  const live = { '2026-11-01': { o: 1, cash: 0, online: 5, del: 1, pick: 0 } };
  const wp = {
    '2026-11-01': { o: 99, cash: 0, online: 999, del: 99, pick: 0 },
    '2026-10-01': { o: 2, cash: 0, online: 20, del: 2, pick: 0 },
    '2026-09-01': { o: 3, cash: 0, online: 30, del: 3, pick: 0 },
  };
  const merged = mergeDaily(live, wp, '2026-11-01', '2026-10-01');
  assert.equal(merged['2026-11-01'].o, 1);
  assert.equal(merged['2026-10-01'].o, 2);
  assert.equal(merged['2026-09-01'], undefined);
});
