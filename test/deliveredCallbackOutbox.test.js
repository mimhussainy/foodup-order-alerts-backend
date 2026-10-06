const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDeliveredCallbackOutbox,
  GLOBAL_PENDING_RESTAURANTS_KEY,
  MAX_RETRY_WINDOW_MS,
} = require('../deliveredCallbackOutbox');

function makeRedis() {
  const kv = new Map();
  const sets = new Map();
  const calls = [];
  const expiries = new Map();

  async function redisCommand(command, ...args) {
    command = String(command).toUpperCase();
    calls.push([command, ...args]);
    if (command === 'GET') return { result: kv.has(args[0]) ? kv.get(args[0]) : null };
    if (command === 'MGET') return { result: args.map(key => kv.has(key) ? kv.get(key) : null) };
    if (command === 'SET') {
      kv.set(args[0], args[1]);
      const exIndex = args.findIndex(value => String(value).toUpperCase() === 'EX');
      if (exIndex >= 0) expiries.set(args[0], Number(args[exIndex + 1] || 0));
      return { result: 'OK' };
    }
    if (command === 'DEL') {
      let count = 0;
      for (const key of args) {
        if (kv.delete(key)) count += 1;
        expiries.delete(key);
      }
      return { result: count };
    }
    if (command === 'SADD') {
      if (!sets.has(args[0])) sets.set(args[0], new Set());
      const before = sets.get(args[0]).size;
      for (const value of args.slice(1)) sets.get(args[0]).add(String(value));
      return { result: sets.get(args[0]).size - before };
    }
    if (command === 'SREM') {
      const set = sets.get(args[0]);
      if (!set) return { result: 0 };
      let count = 0;
      for (const value of args.slice(1)) if (set.delete(String(value))) count += 1;
      return { result: count };
    }
    if (command === 'SCARD') return { result: (sets.get(args[0]) || new Set()).size };
    if (command === 'SMEMBERS') return { result: [...(sets.get(args[0]) || new Set())] };
    throw new Error(`Unsupported Redis command ${command}`);
  }

  redisCommand.calls = calls;
  redisCommand.resetCalls = () => { calls.length = 0; };
  redisCommand.expiry = key => expiries.get(key);
  return redisCommand;
}

const k = (code, key) => `${code}:${key}`;

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

async function setProfile(redisCommand, code = 'hothouse', website = 'https://hothouse.ch') {
  await redisCommand('SET', k(code, 'restaurant_profile'), JSON.stringify({ website }));
}

test('successful delivered callback is queued, authenticated through backend helper and marked done', async () => {
  const redisCommand = makeRedis();
  await setProfile(redisCommand);

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
  assert.deepEqual((await redisCommand('SMEMBERS', GLOBAL_PENDING_RESTAURANTS_KEY)).result, ['hothouse']);
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
  assert.deepEqual((await redisCommand('SMEMBERS', GLOBAL_PENDING_RESTAURANTS_KEY)).result, []);
});

test('temporary WordPress failure keeps the callback pending and later succeeds', async () => {
  let clock = Date.parse('2026-10-05T16:50:00.000Z');
  const redisCommand = makeRedis();
  await setProfile(redisCommand, 'hothouse', 'hothouse.ch');

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
  assert.deepEqual((await redisCommand('SMEMBERS', GLOBAL_PENDING_RESTAURANTS_KEY)).result, []);
});

test('permanent WordPress error moves callback to dead-letter and is never attempted again', async () => {
  const redisCommand = makeRedis();
  await setProfile(redisCommand);
  let fetches = 0;
  const outbox = createDeliveredCallbackOutbox({
    redisCommand,
    k,
    logger: silentLogger(),
    fetchWordPress: async () => {
      fetches += 1;
      return { ok: false, status: 401, async json() { return { success: false }; } };
    },
  });

  await outbox.enqueue({ restaurant_code: 'hothouse', order_id: 970, delivery_name: 'Ali' });
  assert.equal(await outbox.processOne('hothouse', 970), false);
  assert.equal(fetches, 1);

  const failedRaw = (await redisCommand('GET', k('hothouse', 'wp_delivered_callback_failed:970'))).result;
  const failed = JSON.parse(failedRaw);
  assert.equal(failed.reason, 'wordpress_http_401');
  assert.equal(failed.attempts, 1);
  assert.ok(failed.last_attempt_at);
  assert.equal(redisCommand.expiry(k('hothouse', 'wp_delivered_callback_failed:970')), 30 * 24 * 60 * 60);
  assert.equal((await redisCommand('GET', k('hothouse', 'wp_delivered_callback:970'))).result, null);
  assert.deepEqual((await redisCommand('SMEMBERS', GLOBAL_PENDING_RESTAURANTS_KEY)).result, []);

  assert.equal(await outbox.processOne('hothouse', 970), false);
  assert.equal(fetches, 1);
});

test('temporary failures retry and move to dead-letter when the 24-hour window expires', async () => {
  let clock = Date.parse('2026-10-05T12:00:00.000Z');
  const redisCommand = makeRedis();
  await setProfile(redisCommand);
  let fetches = 0;
  const outbox = createDeliveredCallbackOutbox({
    redisCommand,
    k,
    now: () => clock,
    logger: silentLogger(),
    fetchWordPress: async () => {
      fetches += 1;
      return { ok: false, status: 503, async json() { return { success: false }; } };
    },
  });

  await outbox.enqueue({ restaurant_code: 'hothouse', order_id: 971 });
  assert.equal(await outbox.processOne('hothouse', 971), false);
  let job = JSON.parse((await redisCommand('GET', k('hothouse', 'wp_delivered_callback:971'))).result);
  const firstAttemptMs = job.first_attempt_at_ms;
  assert.equal(job.attempts, 1);

  clock = job.next_attempt_at;
  assert.equal(await outbox.processOne('hothouse', 971), false);
  job = JSON.parse((await redisCommand('GET', k('hothouse', 'wp_delivered_callback:971'))).result);
  assert.equal(job.attempts, 2);
  assert.equal(fetches, 2);

  clock = firstAttemptMs + MAX_RETRY_WINDOW_MS;
  assert.equal(await outbox.processOne('hothouse', 971), false);
  assert.equal(fetches, 2);
  const failed = JSON.parse((await redisCommand('GET', k('hothouse', 'wp_delivered_callback_failed:971'))).result);
  assert.equal(failed.attempts, 2);
  assert.match(failed.reason, /^retry_window_expired:wordpress_http_503$/);
  assert.equal((await redisCommand('GET', k('hothouse', 'wp_delivered_callback:971'))).result, null);
});

test('callback_auth_recovery_required is treated as temporary', async () => {
  let clock = Date.parse('2026-10-05T12:00:00.000Z');
  const redisCommand = makeRedis();
  await setProfile(redisCommand);
  const outbox = createDeliveredCallbackOutbox({
    redisCommand,
    k,
    now: () => clock,
    logger: silentLogger(),
    fetchWordPress: async () => ({
      ok: false,
      status: 503,
      async json() { return { success: false, code: 'callback_auth_recovery_required' }; },
    }),
  });

  await outbox.enqueue({ restaurant_code: 'hothouse', order_id: 972 });
  assert.equal(await outbox.processOne('hothouse', 972), false);
  const job = JSON.parse((await redisCommand('GET', k('hothouse', 'wp_delivered_callback:972'))).result);
  assert.equal(job.attempts, 1);
  assert.equal(job.last_error, 'callback_auth_recovery_required');
  assert.equal((await redisCommand('GET', k('hothouse', 'wp_delivered_callback_failed:972'))).result, null);
});

test('admin retry moves a dead-letter callback back to the pending outbox', async () => {
  let clock = Date.parse('2026-10-05T12:00:00.000Z');
  const redisCommand = makeRedis();
  await setProfile(redisCommand);
  const outbox = createDeliveredCallbackOutbox({
    redisCommand,
    k,
    now: () => clock,
    logger: silentLogger(),
    fetchWordPress: async () => ({ ok: false, status: 404, async json() { return { success: false }; } }),
  });

  await outbox.enqueue({ restaurant_code: 'hothouse', order_id: 973, delivery_name: 'Ali', delivered_at: new Date(clock).toISOString() });
  await outbox.processOne('hothouse', 973);
  assert.ok((await redisCommand('GET', k('hothouse', 'wp_delivered_callback_failed:973'))).result);

  clock += 1000;
  const retried = await outbox.retryFailed('hothouse', 973);
  assert.equal(retried.ok, true);
  assert.equal((await redisCommand('GET', k('hothouse', 'wp_delivered_callback_failed:973'))).result, null);
  const job = JSON.parse((await redisCommand('GET', k('hothouse', 'wp_delivered_callback:973'))).result);
  assert.equal(job.attempts, 0);
  assert.equal(job.manual_retry_of_attempts, 1);
  assert.deepEqual((await redisCommand('SMEMBERS', k('hothouse', 'wp_delivered_callbacks_pending'))).result, ['973']);
  assert.deepEqual((await redisCommand('SMEMBERS', GLOBAL_PENDING_RESTAURANTS_KEY)).result, ['hothouse']);
});

test('idle worker tick performs exactly one Redis command', async () => {
  const redisCommand = makeRedis();
  const outbox = createDeliveredCallbackOutbox({
    redisCommand,
    k,
    logger: silentLogger(),
    fetchWordPress: async () => { throw new Error('should not send'); },
  });

  redisCommand.resetCalls();
  await outbox.tick();
  assert.deepEqual(redisCommand.calls, [['SMEMBERS', GLOBAL_PENDING_RESTAURANTS_KEY]]);
});

test('bootstrap indexes restaurants that already had pending jobs before the global set existed', async () => {
  const redisCommand = makeRedis();
  await redisCommand('SADD', 'restaurants', 'hothouse');
  await redisCommand('SADD', 'restaurants', 'sendi');
  await redisCommand('SADD', k('hothouse', 'wp_delivered_callbacks_pending'), '980');
  const outbox = createDeliveredCallbackOutbox({
    redisCommand,
    k,
    logger: silentLogger(),
    fetchWordPress: async () => { throw new Error('not used'); },
  });

  await outbox.bootstrapPendingRestaurantIndex();
  assert.deepEqual((await redisCommand('SMEMBERS', GLOBAL_PENDING_RESTAURANTS_KEY)).result, ['hothouse']);
});
