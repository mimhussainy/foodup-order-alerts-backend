const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ADMIN_LOGIN_LIMIT,
  ADMIN_LOGIN_WINDOW_SECONDS,
  adminLoginRateLimitState,
  recordAdminLoginFailure,
  clearAdminLoginFailures,
} = require('../adminLoginRateLimit');

function makeRedis() {
  const values = new Map();
  const expiresAt = new Map();

  function purge(key) {
    const expiry = expiresAt.get(key);
    if (expiry !== undefined && expiry <= Date.now()) {
      values.delete(key);
      expiresAt.delete(key);
    }
  }

  return {
    async command(command, ...args) {
      const op = String(command).toUpperCase();
      const key = args[0];
      if (op === 'GET') {
        purge(key);
        return { result: values.get(key) ?? null };
      }
      if (op === 'SET') {
        purge(key);
        const options = args.slice(2).map(value => String(value).toUpperCase());
        if (options.includes('NX') && values.has(key)) return { result: null };
        values.set(key, args[1]);
        const exIndex = options.indexOf('EX');
        if (exIndex >= 0) expiresAt.set(key, Date.now() + Number(args[2 + exIndex + 1]) * 1000);
        return { result: 'OK' };
      }
      if (op === 'INCR') {
        purge(key);
        const next = Number(values.get(key) || 0) + 1;
        values.set(key, String(next));
        return { result: next };
      }
      if (op === 'TTL') {
        purge(key);
        if (!values.has(key)) return { result: -2 };
        if (!expiresAt.has(key)) return { result: -1 };
        return { result: Math.max(0, Math.ceil((expiresAt.get(key) - Date.now()) / 1000)) };
      }
      if (op === 'EXPIRE') {
        if (!values.has(key)) return { result: 0 };
        expiresAt.set(key, Date.now() + Number(args[1]) * 1000);
        return { result: 1 };
      }
      if (op === 'DEL') {
        values.delete(key);
        expiresAt.delete(key);
        return { result: 1 };
      }
      throw new Error(`Unsupported Redis command in test: ${op}`);
    },
  };
}

test('Control Center login limiter blocks an IP after five failures for 15 minutes', async () => {
  const redis = makeRedis();
  const command = redis.command.bind(redis);
  const ip = '203.0.113.15';

  for (let i = 1; i <= ADMIN_LOGIN_LIMIT; i += 1) {
    const failure = await recordAdminLoginFailure(command, ip);
    assert.equal(failure.failures, i);
    assert.equal(failure.blocked, i >= ADMIN_LOGIN_LIMIT);
  }

  const state = await adminLoginRateLimitState(command, ip);
  assert.equal(state.blocked, true);
  assert.equal(state.failures, ADMIN_LOGIN_LIMIT);
  assert.ok(state.retryAfter > 0 && state.retryAfter <= ADMIN_LOGIN_WINDOW_SECONDS);

  const otherIp = await adminLoginRateLimitState(command, '203.0.113.16');
  assert.equal(otherIp.blocked, false);
  assert.equal(otherIp.failures, 0);
});

test('Control Center login limiter clears failures after a successful login', async () => {
  const redis = makeRedis();
  const command = redis.command.bind(redis);
  const ip = '198.51.100.25';

  await recordAdminLoginFailure(command, ip);
  await recordAdminLoginFailure(command, ip);
  await clearAdminLoginFailures(command, ip);

  const state = await adminLoginRateLimitState(command, ip);
  assert.equal(state.blocked, false);
  assert.equal(state.failures, 0);
});
