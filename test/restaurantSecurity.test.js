const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createRestaurantSecurity, safeEqual, sha256, clientIpFromRequest } = require('../restaurantSecurity');

function randomValue(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

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
    values,
    expiresAt,
    async command(command, ...args) {
      const op = String(command).toUpperCase();
      if (op === 'GET') {
        purge(args[0]);
        return { result: values.get(args[0]) ?? null };
      }
      if (op === 'MGET') {
        return { result: args.map(key => { purge(key); return values.get(key) ?? null; }) };
      }
      if (op === 'SET') {
        const key = args[0];
        const value = args[1];
        purge(key);
        const options = args.slice(2).map(value => String(value).toUpperCase());
        const nx = options.includes('NX');
        if (nx && values.has(key)) return { result: null };
        values.set(key, value);
        const exIndex = options.indexOf('EX');
        const pxIndex = options.indexOf('PX');
        if (exIndex >= 0) {
          expiresAt.set(key, Date.now() + Number(args[2 + exIndex + 1]) * 1000);
        } else if (pxIndex >= 0) {
          expiresAt.set(key, Date.now() + Number(args[2 + pxIndex + 1]));
        } else {
          expiresAt.delete(key);
        }
        return { result: 'OK' };
      }
      if (op === 'INCR') {
        const key = args[0];
        purge(key);
        const next = Number(values.get(key) || 0) + 1;
        values.set(key, String(next));
        return { result: next };
      }
      if (op === 'TTL') {
        const key = args[0];
        purge(key);
        if (!values.has(key)) return { result: -2 };
        if (!expiresAt.has(key)) return { result: -1 };
        return { result: Math.max(0, Math.ceil((expiresAt.get(key) - Date.now()) / 1000)) };
      }
      if (op === 'EXPIRE') {
        const key = args[0];
        purge(key);
        if (!values.has(key)) return { result: 0 };
        expiresAt.set(key, Date.now() + Number(args[1]) * 1000);
        return { result: 1 };
      }
      if (op === 'DEL') {
        let removed = 0;
        for (const key of args) {
          purge(key);
          if (values.delete(key)) removed += 1;
          expiresAt.delete(key);
        }
        return { result: removed };
      }
      throw new Error(`Unsupported test Redis command: ${op}`);
    },
  };
}

function makeSecurity(extraEnv = {}, redis = makeRedis(), logger = { error() {}, warn() {}, log() {} }) {
  const env = {
    FOODUP_SECRET_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    FOODUP_LEGACY_SHARED_SECRET: randomValue(),
    FOODUP_LEGACY_APP_ACCESS_ENABLED: 'true',
    ...extraEnv,
  };
  const security = createRestaurantSecurity({
    redisCommand: redis.command.bind(redis),
    k: (code, key) => `${code}:${key}`,
    env,
    logger,
  });
  return { security, redis, env };
}

test('restaurant secret is encrypted at rest', async () => {
  const { security, redis } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  const secret = randomValue();
  await security.setStoredRestaurantSecret(restaurant, secret);
  const stored = redis.values.get(`${restaurant}:callback_secret_enc`);
  assert.ok(stored);
  assert.equal(stored.includes(secret), false);
  assert.equal(await security.getStoredRestaurantSecret(restaurant), secret);
});

test('takeover attempt cannot replace an established restaurant secret', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  const current = randomValue();
  await security.setStoredRestaurantSecret(restaurant, current);
  const decision = await security.profileAuthorization({
    code: restaurant,
    providedSecret: randomValue(),
    callbackSecret: randomValue(),
    ownerPinValid: true,
    client: 'wordpress',
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.canEstablishSecret, false);
});

test('rotation requires the stored secret as proof and then accepts the new secret', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  const current = randomValue();
  const next = randomValue();
  await security.setStoredRestaurantSecret(restaurant, current);
  const decision = await security.profileAuthorization({
    code: restaurant,
    providedSecret: current,
    callbackSecret: next,
    ownerPinValid: false,
    client: 'wordpress',
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.mode, 'rotation');
  assert.equal(decision.canEstablishSecret, true);
  await security.setStoredRestaurantSecret(restaurant, next);
  await security.setLegacyAppAccess(restaurant, false);
  assert.equal((await security.authorizeWordPress(restaurant, current, 'wordpress')).ok, false);
  assert.equal((await security.authorizeWordPress(restaurant, next, 'wordpress')).ok, true);
});

test('first migration needs owner proof; logo-only sync cannot establish a secret', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  const candidate = randomValue();
  const logoOnly = await security.profileAuthorization({
    code: restaurant,
    providedSecret: candidate,
    callbackSecret: candidate,
    ownerPinValid: false,
    client: 'wordpress',
  });
  assert.equal(logoOnly.ok, true);
  assert.equal(logoOnly.mode, 'logo_only');
  assert.equal(logoOnly.canEstablishSecret, false);

  const migration = await security.profileAuthorization({
    code: restaurant,
    providedSecret: candidate,
    callbackSecret: candidate,
    ownerPinValid: true,
    client: 'wordpress',
  });
  assert.equal(migration.mode, 'first_migration');
  assert.equal(migration.canEstablishSecret, true);
});

test('session token is bound to restaurant, device and app', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  const otherRestaurant = randomValue(8).toLowerCase();
  const device = randomValue(12);
  const issued = await security.issueSession({ code: restaurant, deviceId: device, app: 'orders' });
  assert.equal((await security.verifySession({ token: issued.token, deviceId: device, app: 'orders', requestedCode: restaurant })).ok, true);
  assert.equal((await security.verifySession({ token: issued.token, deviceId: device, app: 'orders', requestedCode: otherRestaurant })).reason, 'wrong_restaurant');
  assert.equal((await security.verifySession({ token: issued.token, deviceId: randomValue(12), app: 'orders', requestedCode: restaurant })).reason, 'wrong_device');
  assert.equal((await security.verifySession({ token: issued.token, deviceId: device, app: 'courier', requestedCode: restaurant })).reason, 'wrong_app');
});

test('revoked sessions are rejected', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  const device = randomValue(12);
  const issued = await security.issueSession({ code: restaurant, deviceId: device, app: 'courier' });
  assert.equal(await security.revokeSession(issued.token), true);
  const verified = await security.verifySession({ token: issued.token, deviceId: device, app: 'courier', requestedCode: restaurant });
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, 'revoked_token');
});

test('legacy WordPress credential is used only when no restaurant secret is stored', async () => {
  const { security, env } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  const before = await security.getOutboundWordPressSecret(restaurant);
  assert.equal(before.source, 'legacy');
  assert.equal(before.secret, env.FOODUP_LEGACY_SHARED_SECRET);

  const current = randomValue();
  await security.setStoredRestaurantSecret(restaurant, current);
  const after = await security.getOutboundWordPressSecret(restaurant);
  assert.equal(after.source, 'restaurant');
  assert.equal(after.secret, current);
});

test('backend callback does not retry with legacy authentication after authorization failure', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  await security.setStoredRestaurantSecret(restaurant, randomValue());
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return { ok: false, status: 401 };
  };
  const response = await security.fetchWordPress(restaurant, 'https://example.invalid/callback', { method: 'POST' }, fakeFetch);
  assert.equal(response.status, 401);
  assert.equal(calls, 1);
});

test('known default PIN hashes are detected without embedding PIN values', async () => {
  const pin = String(crypto.randomInt(100000, 999999));
  const { security } = makeSecurity({ FOODUP_DEFAULT_PIN_HASHES: sha256(pin) });
  assert.equal(security.isKnownDefaultPin(pin), true);
  assert.equal(security.isKnownDefaultPin(String(crypto.randomInt(100000, 999999))), false);
});

test('missing outbound restaurant and legacy secrets fail closed', async () => {
  const { security } = makeSecurity({ FOODUP_LEGACY_SHARED_SECRET: '' });
  const restaurant = randomValue(8).toLowerCase();
  const outbound = await security.getOutboundWordPressSecret(restaurant);
  assert.equal(outbound.source, 'missing');
  assert.equal(outbound.secret, '');
  await assert.rejects(
    security.fetchWordPress(restaurant, 'https://example.invalid/callback', { method: 'POST' }, async () => ({ ok: true, status: 200 })),
    /not configured/i
  );
});

test('old app request without a session token is accepted while legacy access is enabled', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  const oldStyle = await security.authorizeAppRequest({
    code: restaurant,
    token: '',
    deviceId: '',
    client: '',
    allowedApps: ['orders'],
  });
  assert.equal(oldStyle.ok, true);
  assert.equal(oldStyle.legacy, true);
  assert.equal(oldStyle.session.restaurant_code, restaurant);

  const suppliedBadToken = await security.authorizeAppRequest({
    code: restaurant,
    token: randomValue(),
    deviceId: randomValue(8),
    client: 'orders',
    allowedApps: ['orders'],
  });
  assert.equal(suppliedBadToken.ok, false);
  assert.equal(suppliedBadToken.legacy, false);

  await security.setLegacyAppAccess(restaurant, false);
  const disabled = await security.authorizeAppRequest({
    code: restaurant,
    token: '',
    deviceId: '',
    client: '',
    allowedApps: ['orders'],
  });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.reason, 'legacy_disabled');
});

test('global legacy app switch can disable old app requests without changing per-restaurant data', async () => {
  const { security } = makeSecurity({ FOODUP_LEGACY_APP_ACCESS_ENABLED: 'false' });
  const restaurant = randomValue(8).toLowerCase();
  const result = await security.authorizeAppRequest({
    code: restaurant,
    token: '',
    deviceId: '',
    client: '',
    allowedApps: ['courier'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'legacy_disabled');
});

test('WordPress request without headers is accepted during transition', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  const beforeMigration = await security.authorizeWordPress(restaurant, '', '');
  assert.equal(beforeMigration.ok, true);
  assert.equal(beforeMigration.source, 'pre_migration_compat');

  await security.setStoredRestaurantSecret(restaurant, randomValue());
  const duringTransition = await security.authorizeWordPress(restaurant, '', '');
  assert.equal(duringTransition.ok, true);
  assert.equal(duringTransition.source, 'legacy_compat');

  await security.setLegacyAppAccess(restaurant, false);
  const afterCutover = await security.authorizeWordPress(restaurant, '', '');
  assert.equal(afterCutover.ok, false);
});

test('WordPress request with an unknown restaurant secret is accepted before first migration', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  const result = await security.authorizeWordPress(restaurant, randomValue(), 'wordpress');
  assert.equal(result.ok, true);
  assert.equal(result.hasRestaurantSecret, false);
  assert.equal(result.source, 'pre_migration_compat');
});

test('old WordPress profile sync remains compatible but cannot replace an established secret', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  await security.setStoredRestaurantSecret(restaurant, randomValue());

  const oldFullProfile = await security.profileAuthorization({
    code: restaurant,
    providedSecret: '',
    callbackSecret: '',
    ownerPinValid: true,
    client: '',
  });
  assert.equal(oldFullProfile.ok, true);
  assert.equal(oldFullProfile.mode, 'legacy_profile');
  assert.equal(oldFullProfile.canUpdateProtectedProfile, true);
  assert.equal(oldFullProfile.canEstablishSecret, false);

  const attemptedReplacement = await security.profileAuthorization({
    code: restaurant,
    providedSecret: '',
    callbackSecret: randomValue(),
    ownerPinValid: true,
    client: '',
  });
  assert.equal(attemptedReplacement.ok, false);
  assert.equal(attemptedReplacement.canEstablishSecret, false);
});

test('default PIN login from an old app remains allowed and only adds a change-required flag', async () => {
  const pin = String(crypto.randomInt(100000, 999999));
  const { security } = makeSecurity({ FOODUP_DEFAULT_PIN_HASHES: sha256(pin) });
  const policy = security.evaluatePinLogin(pin);
  assert.equal(policy.allowed, true);
  assert.equal(policy.pinPolicyConfigured, true);
  assert.equal(policy.pinChangeRequired, true);
});

test('Redis PIN limiter blocks a source IP after five failures', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  const ip = `198.51.100.${crypto.randomInt(1, 200)}`;
  const args = { action: 'owner-profile', code: restaurant, ip, windowSeconds: 900 };

  for (let i = 0; i < 4; i += 1) {
    const failure = await security.recordPinFailure(args);
    assert.equal(failure.blocked, false);
  }
  const fifth = await security.recordPinFailure(args);
  assert.equal(fifth.blocked, true);
  assert.equal(fifth.ipFailures, 5);
  assert.equal(fifth.restaurantFailures, 5);
  assert.equal((await security.pinAttemptRateLimitState(args)).allowed, false);
});

test('five wrong attempts from one IP do not block the restaurant for another IP', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  const blockedIp = `198.51.100.${crypto.randomInt(1, 200)}`;
  const otherIp = `203.0.113.${crypto.randomInt(1, 200)}`;
  const base = { action: 'owner-profile', code: restaurant, windowSeconds: 900 };

  for (let i = 0; i < 5; i += 1) {
    await security.recordPinFailure({ ...base, ip: blockedIp });
  }

  const blockedSource = await security.pinAttemptRateLimitState({ ...base, ip: blockedIp });
  const otherSource = await security.pinAttemptRateLimitState({ ...base, ip: otherIp });
  assert.equal(blockedSource.allowed, false);
  assert.equal(otherSource.allowed, true);
  assert.equal(otherSource.restaurantFailures, 5);
  assert.equal(otherSource.restaurantThreshold, 20);
});

test('twenty distributed failures block the restaurant across source IPs', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  const base = { action: 'owner-profile', code: restaurant, windowSeconds: 900 };

  for (let i = 0; i < 20; i += 1) {
    await security.recordPinFailure({ ...base, ip: `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}` });
  }

  const state = await security.pinAttemptRateLimitState({ ...base, ip: '203.0.113.210' });
  assert.equal(state.allowed, false);
  assert.equal(state.restaurantFailures, 20);
  assert.equal(state.restaurantThreshold, 20);
});

test('client IP ignores a spoofed first X-Forwarded-For entry', () => {
  const request = {
    ip: '203.0.113.44',
    headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.44' },
    socket: { remoteAddress: '10.0.0.10' },
  };
  assert.equal(clientIpFromRequest(request), '203.0.113.44');

  const fallbackRequest = {
    headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.44' },
    socket: { remoteAddress: '10.0.0.10' },
  };
  assert.equal(clientIpFromRequest(fallbackRequest), '203.0.113.44');
});

test('PIN-only legacy profile proof cannot change a stored website', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  await security.setStoredRestaurantSecret(restaurant, randomValue());

  const legacyDecision = await security.profileAuthorization({
    code: restaurant,
    providedSecret: '',
    callbackSecret: '',
    ownerPinValid: true,
    client: '',
  });
  assert.equal(legacyDecision.mode, 'legacy_profile');
  assert.equal(legacyDecision.canUpdateProtectedProfile, true);
  assert.equal(legacyDecision.canUpdateWebsite, false);

  const policy = security.profileWebsitePolicy({
    decision: legacyDecision,
    currentWebsite: 'https://restaurant.invalid',
    requestedWebsite: 'https://different.invalid',
    callbackSecret: '',
  });
  assert.equal(policy.changeRequested, true);
  assert.equal(policy.allowed, false);
});

test('first migration refuses a callback secret that the stored website does not accept', async () => {
  const { security } = makeSecurity();
  const candidate = randomValue();
  let calls = 0;
  const rejected = await security.verifyRestaurantSecretAgainstWebsite(
    'https://restaurant.invalid',
    candidate,
    async () => { calls += 1; return { status: 401 }; }
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'wordpress_rejected_secret');
  assert.equal(calls, 1);

  const accepted = await security.verifyRestaurantSecretAgainstWebsite(
    'https://restaurant.invalid',
    candidate,
    async (url, options) => {
      assert.match(url, /\/wp-json\/foodup\/v1\/products$/);
      assert.equal(options.headers['X-FoodUp-Client'], 'backend');
      assert.equal(options.headers['x-foodup-secret'], candidate);
      return { status: 200 };
    }
  );
  assert.equal(accepted.ok, true);
});

test('brand-new first migration may use its requested website only with a candidate secret', async () => {
  const { security } = makeSecurity();
  const decision = { mode: 'first_migration', canEstablishSecret: true, canUpdateWebsite: false };
  const candidate = randomValue();
  const allowed = security.profileWebsitePolicy({
    decision,
    currentWebsite: '',
    requestedWebsite: 'https://restaurant.invalid',
    callbackSecret: candidate,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.mayUseBrandNewWebsite, true);

  const pinOnly = security.profileWebsitePolicy({
    decision: { ...decision, canEstablishSecret: false },
    currentWebsite: '',
    requestedWebsite: 'https://restaurant.invalid',
    callbackSecret: '',
  });
  assert.equal(pinOnly.allowed, false);
});

test('secret decryption failure keeps transition order auth and app login available', async () => {
  const sharedRedis = makeRedis();
  const first = makeSecurity({}, sharedRedis);
  const restaurant = randomValue(8).toLowerCase();
  await first.security.setStoredRestaurantSecret(restaurant, randomValue());

  const changedKeyEnv = {
    FOODUP_SECRET_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    FOODUP_LEGACY_SHARED_SECRET: first.env.FOODUP_LEGACY_SHARED_SECRET,
    FOODUP_LEGACY_APP_ACCESS_ENABLED: 'true',
  };
  const recovered = makeSecurity(changedKeyEnv, sharedRedis);

  const inbound = await recovered.security.authorizeWordPress(restaurant, '', '');
  assert.equal(inbound.ok, true);
  assert.equal(inbound.source, 'decrypt_error_compat');
  assert.equal(await recovered.security.getLoginCallbackSecret(restaurant), '');

  let outboundCalls = 0;
  const outbound = await recovered.security.fetchWordPress(
    restaurant,
    'https://restaurant.invalid/callback',
    { method: 'POST' },
    async () => { outboundCalls += 1; return { ok: true, status: 200 }; }
  );
  assert.equal(outbound.ok, false);
  assert.equal(outbound.status, 503);
  assert.equal(outboundCalls, 0);

  await recovered.security.setLegacyAppAccess(restaurant, false);
  assert.equal((await recovered.security.authorizeWordPress(restaurant, '', '')).ok, false);
});

test('decryption failure cannot replace a stored secret until admin reset', async () => {
  const sharedRedis = makeRedis();
  const first = makeSecurity({}, sharedRedis);
  const restaurant = randomValue(8).toLowerCase();
  await first.security.setStoredRestaurantSecret(restaurant, randomValue());
  const changed = makeSecurity({
    FOODUP_SECRET_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    FOODUP_LEGACY_SHARED_SECRET: first.env.FOODUP_LEGACY_SHARED_SECRET,
  }, sharedRedis);
  const decision = await changed.security.profileAuthorization({
    code: restaurant,
    providedSecret: '',
    callbackSecret: randomValue(),
    ownerPinValid: true,
    client: 'wordpress',
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.mode, 'secret_recovery_required');
});

test('admin reset primitive deletes the stored restaurant secret for a clean first migration', async () => {
  const { security } = makeSecurity();
  const restaurant = randomValue(8).toLowerCase();
  await security.setStoredRestaurantSecret(restaurant, randomValue());
  await security.resetStoredRestaurantSecret(restaurant);
  assert.equal(await security.getStoredRestaurantSecret(restaurant), '');
});

test('timing-safe equality helper accepts equal admin credentials and rejects different ones', () => {
  const value = randomValue(20);
  assert.equal(safeEqual(value, value), true);
  assert.equal(safeEqual(value, randomValue(20)), false);
  assert.equal(safeEqual('', ''), false);
});

