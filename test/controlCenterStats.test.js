const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createControlCenterStats, zurichParts, parseOrderTime, isVoidOrder, normalizePayment, beatFromHeartbeat,
} = require('../controlCenterStats');

function fakeRedis() {
  const strings = new Map();
  const hashes = new Map();
  const lists = new Map();
  const sets = new Map();
  const calls = [];
  async function redisCommand(cmd, ...args) {
    calls.push([cmd, ...args]);
    switch (cmd) {
      case 'GET': return { result: strings.has(args[0]) ? strings.get(args[0]) : null };
      case 'SET': {
        if (args.includes('NX') && strings.has(args[0])) return { result: null };
        strings.set(args[0], args[1]);
        return { result: 'OK' };
      }
      case 'MGET': return { result: args.map(key => (strings.has(key) ? strings.get(key) : null)) };
      case 'LRANGE': return { result: (lists.get(args[0]) || []).slice(args[1], args[2] + 1) };
      case 'SMEMBERS': return { result: Array.from(sets.get(args[0]) || []) };
      case 'HSET': {
        const h = hashes.get(args[0]) || new Map();
        for (let i = 1; i + 1 < args.length; i += 2) h.set(args[i], args[i + 1]);
        hashes.set(args[0], h);
        return { result: 1 };
      }
      case 'HMGET': { const h = hashes.get(args[0]) || new Map(); return { result: args.slice(1).map(f => (h.has(f) ? h.get(f) : null)) }; }
      case 'HGETALL': { const h = hashes.get(args[0]) || new Map(); return { result: Array.from(h.entries()).flat() }; }
      case 'EXPIRE': return { result: 1 };
      case 'PING': return { result: 'PONG' };
      default: throw new Error(`unsupported ${cmd}`);
    }
  }
  return { redisCommand, strings, hashes, lists, sets, calls };
}

const k = (code, key) => `${code}:${key}`;

test('Swiss calendar day is used, not UTC', () => {
  // 23:30 UTC on 20 Oct = 01:30 on 21 Oct in Zurich (CEST)
  assert.equal(zurichParts(new Date('2026-10-20T23:30:00Z')).day, '2026-10-21');
  assert.equal(zurichParts(new Date('2026-10-20T23:30:00Z')).hour, 1);
  // winter time (CET, UTC+1)
  assert.equal(zurichParts(new Date('2026-12-01T23:30:00Z')).day, '2026-12-02');
});

test('WordPress wall time without offset is read as Swiss time', () => {
  assert.equal(parseOrderTime('2026-10-21 12:04:00').toISOString(), '2026-10-21T10:04:00.000Z');
  assert.equal(parseOrderTime('2026-12-21 12:04:00').toISOString(), '2026-12-21T11:04:00.000Z');
  assert.equal(parseOrderTime('2026-10-21T10:04:00.000Z').toISOString(), '2026-10-21T10:04:00.000Z');
  assert.equal(parseOrderTime(''), null);
});

test('cancelled, refunded, failed and rejected orders are void', () => {
  assert.equal(isVoidOrder({ status: 'processing' }), false);
  assert.equal(isVoidOrder({ status: 'cancelled' }), true);
  assert.equal(isVoidOrder({ status: 'wc-refunded' }), true);
  assert.equal(isVoidOrder({ status: 'failed' }), true);
  assert.equal(isVoidOrder({ order_id: 7, status: 'processing' }, new Set(['7'])), true);
});

test('payment labels are normalised', () => {
  assert.equal(normalizePayment('TWINT'), 'TWINT');
  assert.equal(normalizePayment('Barzahlung'), 'Cash');
  assert.equal(normalizePayment('Kreditkarte (Stripe)'), 'Card');
  assert.equal(normalizePayment(''), 'Unknown');
});

test('heartbeat buckets map to online / idle / offline', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(beatFromHeartbeat({ last_seen: '2026-10-21T11:55:00Z' }, now), 'g');
  assert.equal(beatFromHeartbeat({ last_seen: '2026-10-21T11:40:00Z' }, now), 'a');
  assert.equal(beatFromHeartbeat({ last_seen: '2026-10-21T10:00:00Z' }, now), 'r');
  assert.equal(beatFromHeartbeat(null, now), 'n');
});

test('analytics counts Swiss today, excludes void orders and only writes cc_ keys', async () => {
  const r = fakeRedis();
  const now = new Date('2026-10-21T11:52:00Z'); // 13:52 Zurich
  r.sets.set('restaurants', new Set(['grillhouse']));
  r.strings.set('cc:history_since', '2026-10-10T00:00:00Z');
  r.lists.set('grillhouse:orders', [
    JSON.stringify({ order_id: 1, total: '40.00', status: 'processing', received_at: '2026-10-21T10:10:00Z', fulfillment_type: 'delivery', payment_method: 'TWINT' }),
    JSON.stringify({ order_id: 2, total: '20.00', status: 'cancelled', received_at: '2026-10-21T10:20:00Z', fulfillment_type: 'pickup', payment_method: 'Bar' }),
    JSON.stringify({ order_id: 3, total: '30.00', status: 'processing', received_at: '2026-10-21T10:30:00Z', fulfillment_type: 'pickup', payment_method: 'Bar' }),
    JSON.stringify({ order_id: 4, total: '55.00', status: 'completed', received_at: '2026-10-20T22:30:00Z', fulfillment_type: 'delivery', payment_method: 'Karte' }),
    JSON.stringify({ order_id: 5, total: '25.00', status: 'completed', received_at: '2026-10-14T10:00:00Z', fulfillment_type: 'delivery', payment_method: 'TWINT' }),
    JSON.stringify({ order_id: 6, total: '25.00', status: 'completed', received_at: '2026-10-14T15:00:00Z', fulfillment_type: 'delivery', payment_method: 'TWINT' }),
  ]);
  r.strings.set('grillhouse:rejected_time:3', '2026-10-21T10:31:00Z');
  const stats = createControlCenterStats({ redisCommand: r.redisCommand, k, logger: { warn() {} }, now: () => now });
  const a = await stats.analytics();

  assert.equal(a.today, '2026-10-21');
  // order 4 was 00:30 Swiss time on the 21st -> today; 2 cancelled, 3 rejected
  assert.equal(a.today_totals.orders, 2);
  assert.equal(a.today_totals.revenue, 95);
  assert.equal(a.today_totals.rejected, 2);
  assert.equal(a.hourly.today[0], 1);
  assert.equal(a.hourly.today[12], 1);
  // last Wednesday: one order before 13:52, one after
  assert.equal(a.same_time_last_week.orders, 1);
  assert.equal(a.hourly.last_week[12] + a.hourly.last_week[17], 2);
  assert.equal(a.mix.payment.TWINT, 1);
  assert.equal(a.mix.payment.Card, 1);

  const written = r.calls.filter(c => ['SET', 'HSET', 'DEL', 'RPUSH', 'LPUSH'].includes(c[0])).map(c => c[1]);
  assert.ok(written.every(key => key === 'cc:history_since' || /:cc_orders:/.test(key)), written.join(','));
});

test('app state reads accepted, delivered and rejected records without writing', async () => {
  const r = fakeRedis();
  r.strings.set('grillhouse:accepted_time:13311', JSON.stringify({ status: 'accepted' }));
  r.strings.set('grillhouse:delivered:13311', JSON.stringify({ order_id: '13311', delivery_name: 'Aziz', delivered_at: '2026-10-21T10:40:00Z' }));
  r.strings.set('grillhouse:rejected_time:13300', '2026-10-21T10:00:00Z');
  const stats = createControlCenterStats({ redisCommand: r.redisCommand, k, logger: { warn() {} } });
  const state = await stats.appStateFor('grillhouse', [{ order_id: 13311, status: 'pending' }, { order_id: 13300 }, { order_id: 13299 }]);
  assert.ok(state.accepted.has('13311'));
  assert.equal(state.delivered.get('13311').delivery_name, 'Aziz');
  assert.ok(state.rejected.has('13300'));
  assert.equal(state.delivered.has('13299'), false);
  assert.ok(r.calls.every(c => c[0] === 'MGET'));
});
