const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeliveredCallbackOutbox } = require('../deliveredCallbackOutbox');

function makeRedis() {
  const kv = new Map();
  const sets = new Map();
  return async function redisCommand(command, ...args) {
    command = String(command).toUpperCase();
    if (command === 'GET') return { result: kv.has(args[0]) ? kv.get(args[0]) : null };
    if (command === 'SET') { kv.set(args[0], args[1]); return { result: 'OK' }; }
    if (command === 'DEL') { const had = kv.delete(args[0]); return { result: had ? 1 : 0 }; }
    if (command === 'SADD') {
      if (!sets.has(args[0])) sets.set(args[0], new Set());
      const before = sets.get(args[0]).size;
      sets.get(args[0]).add(String(args[1]));
      return { result: sets.get(args[0]).size > before ? 1 : 0 };
    }
    if (command === 'SREM') {
      const set = sets.get(args[0]);
      return { result: set && set.delete(String(args[1])) ? 1 : 0 };
    }
    if (command === 'SMEMBERS') return { result: [...(sets.get(args[0]) || new Set())] };
    throw new Error(`Unsupported Redis command ${command}`);
  };
}

const k = (code, key) => `${code}:${key}`;

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

test('successful delivered callback is queued, authenticated through backend helper and marked done', async () => {
  const redisCommand = makeRedis();
  await redisCommand('SADD', 'restaurants', 'hothouse');
  await redisCommand('SET', k('hothouse', 'restaurant_profile'), JSON.stringify({ website: 'https://hothouse.ch' }));

  const calls = [];
  const outbox = createDeliveredCallbackOutbox({
    redisCommand,
    k,
    logger: silentLogger(),
    fetchWordPress: async (code, url, options) => {
      calls.push({ code, url, options });
      return { ok: true, status: 200, async json() { return { success: true }; } };
    },
  });

  assert.equal(await outbox.enqueue({ restaurant_code: 'hothouse', order_id: 968, delivery_name: 'Ali', delivered_at: '2026-10-05T16:50:00.000Z' }), true);
  assert.equal(await outbox.processOne('hothouse', '968'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].code, 'hothouse');
  assert.equal(calls[0].url, 'https://hothouse.ch/wp-json/foodup/v1/order-delivered');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    order_id: 968,
    delivery_name: 'Ali',
    delivered_at: '2026-10-05T16:50:00.000Z',
  });
  assert.equal((await redisCommand('GET', k('hothouse', 'wp_delivered_callback_done:968'))).result, 'yes');
  assert.deepEqual((await redisCommand('SMEMBERS', k('hothouse', 'wp_delivered_callbacks_pending'))).result, []);
});

test('WordPress failure never loses the callback and schedules a retry', async () => {
  let clock = Date.parse('2026-10-05T16:50:00.000Z');
  const redisCommand = makeRedis();
  await redisCommand('SADD', 'restaurants', 'hothouse');
  await redisCommand('SET', k('hothouse', 'restaurant_profile'), JSON.stringify({ website: 'hothouse.ch' }));

  let attempts = 0;
  const outbox = createDeliveredCallbackOutbox({
    redisCommand,
    k,
    now: () => clock,
    logger: silentLogger(),
    fetchWordPress: async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, status: 503, async json() { return { success: false }; } };
      return { ok: true, status: 200, async json() { return { success: true }; } };
    },
  });

  await outbox.enqueue({ restaurant_code: 'hothouse', order_id: 968, delivery_name: 'Ali', delivered_at: new Date(clock).toISOString() });
  assert.equal(await outbox.processOne('hothouse', 968), false);

  const pendingRaw = (await redisCommand('GET', k('hothouse', 'wp_delivered_callback:968'))).result;
  const pending = JSON.parse(pendingRaw);
  assert.equal(pending.attempts, 1);
  assert.ok(pending.next_attempt_at > clock);
  assert.deepEqual((await redisCommand('SMEMBERS', k('hothouse', 'wp_delivered_callbacks_pending'))).result, ['968']);

  clock = pending.next_attempt_at;
  assert.equal(await outbox.processOne('hothouse', 968), true);
  assert.equal(attempts, 2);
  assert.equal((await redisCommand('GET', k('hothouse', 'wp_delivered_callback_done:968'))).result, 'yes');
});

test('replayed mark-delivered does not enqueue another callback after confirmation', async () => {
  const redisCommand = makeRedis();
  await redisCommand('SET', k('hothouse', 'wp_delivered_callback_done:968'), 'yes');
  const outbox = createDeliveredCallbackOutbox({
    redisCommand,
    k,
    logger: silentLogger(),
    fetchWordPress: async () => { throw new Error('should not send'); },
  });

  assert.equal(await outbox.enqueue({ restaurant_code: 'hothouse', order_id: 968 }), false);
  assert.deepEqual((await redisCommand('SMEMBERS', k('hothouse', 'wp_delivered_callbacks_pending'))).result, []);
});
