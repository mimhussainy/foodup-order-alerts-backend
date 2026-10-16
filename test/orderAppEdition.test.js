'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrderAppEdition } = require('../orderAppEdition');

const k = (code, key) => `${code}:${key}`;
const quiet = { warn() {} };

function memoryRedis(initial = {}) {
  const store = { ...initial };
  const fn = async (command, key, value) => {
    if (command === 'GET') return { result: Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null };
    if (command === 'SET') { store[key] = value; return { result: 'OK' }; }
    throw new Error('unsupported');
  };
  fn.store = store;
  return fn;
}

const failingRedis = async () => { throw Object.assign(new Error('down'), { code: 'FOODUP_REDIS_UNAVAILABLE' }); };

function runGate(edition, { mode, path, body = {}, query = {}, sessionCode, redis } = {}) {
  const svc = createOrderAppEdition({
    redisCommand: redis || memoryRedis(edition ? { 'demo:orders_app_edition': edition } : {}),
    k, env: mode ? { FOODUP_EDITION_ENFORCEMENT: mode } : {}, logger: quiet,
  });
  const gate = svc.gate(sessionCode);
  return new Promise(resolve => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ blocked: true, status: this.statusCode, payload }); },
    };
    gate({ method: 'GET', path, body, query }, res, () => resolve({ blocked: false }));
  });
}

test('missing edition is pro', async () => {
  const svc = createOrderAppEdition({ redisCommand: memoryRedis(), k, logger: quiet });
  assert.equal(await svc.get('demo'), 'pro');
});

test('unknown stored value is pro', async () => {
  const svc = createOrderAppEdition({ redisCommand: memoryRedis({ 'demo:orders_app_edition': 'lite' }), k, logger: quiet });
  assert.equal(await svc.get('demo'), 'pro');
});

test('redis failure is pro and never throws', async () => {
  const svc = createOrderAppEdition({ redisCommand: failingRedis, k, logger: quiet });
  assert.equal(await svc.get('demo'), 'pro');
});

test('explicit free is free', async () => {
  const svc = createOrderAppEdition({ redisCommand: memoryRedis({ 'demo:orders_app_edition': 'free' }), k, logger: quiet });
  assert.equal(await svc.get('demo'), 'free');
});

test('set validates and updates cache immediately', async () => {
  const redis = memoryRedis();
  const svc = createOrderAppEdition({ redisCommand: redis, k, logger: quiet });
  assert.equal(await svc.get('demo'), 'pro');
  await svc.set('demo', 'free');
  assert.equal(redis.store['demo:orders_app_edition'], 'free');
  assert.equal(await svc.get('demo'), 'free');
  await assert.rejects(() => svc.set('demo', 'gold'));
  await assert.rejects(() => svc.set('', 'pro'));
});

test('default mode is log_only and never blocks', async () => {
  assert.deepEqual(await runGate('free', { path: '/stats/demo' }), { blocked: false });
});

test('enforce blocks pro-only routes for free restaurants', async () => {
  const r = await runGate('free', { mode: 'enforce', path: '/stats/demo' });
  assert.equal(r.blocked, true);
  assert.equal(r.status, 403);
  assert.equal(r.payload.code, 'foodup_pro_required');
});

test('enforce reads restaurant code from body and query', async () => {
  assert.equal((await runGate('free', { mode: 'enforce', path: '/claim-order', body: { restaurant_code: 'DEMO' } })).blocked, true);
  assert.equal((await runGate('free', { mode: 'enforce', path: '/delivery-accounts', query: { restaurant_code: 'demo' } })).blocked, true);
});

test('enforce never blocks pro or unset restaurants', async () => {
  assert.equal((await runGate('pro', { mode: 'enforce', path: '/stats/demo' })).blocked, false);
  assert.equal((await runGate(null, { mode: 'enforce', path: '/stats/demo' })).blocked, false);
});

test('enforce never blocks when redis is down', async () => {
  assert.equal((await runGate(null, { mode: 'enforce', path: '/stats/demo', redis: failingRedis })).blocked, false);
});

test('order flow routes are never gated', async () => {
  for (const path of ['/orders/demo', '/live-sync/demo', '/accepted-time', '/rejected-time', '/status-update',
    '/heartbeat', '/auto-settings/demo', '/new-order', '/set-printer-device', '/store-status', '/verify-pin']) {
    const r = await runGate('free', { mode: 'enforce', path, body: { restaurant_code: 'demo' } });
    assert.equal(r.blocked, false, path);
  }
});

test('trailing slash, upper case and encoded codes cannot bypass enforce', async () => {
  for (const path of ['/stats/demo/', '/STATS/demo', '/Stats/DEMO', '/stats/de%6Do', '/claim-order/', '/CLAIM-ORDER']) {
    const r = await runGate('free', { mode: 'enforce', path, body: { restaurant_code: 'demo' } });
    assert.equal(r.blocked, true, path);
  }
});

test('session-only courier request (no restaurant_code) is still gated', async () => {
  const r = await runGate('free', { mode: 'enforce', path: '/claim-order', body: {}, sessionCode: async () => 'demo' });
  assert.equal(r.blocked, true);
});

test('session lookup failure lets the request through to its own auth', async () => {
  const r = await runGate('free', { mode: 'enforce', path: '/claim-order', body: {}, sessionCode: async () => { throw new Error('x'); } });
  assert.equal(r.blocked, false);
});

test('cache is bounded', async () => {
  const svc = createOrderAppEdition({ redisCommand: memoryRedis(), k, logger: quiet });
  for (let i = 0; i < 2500; i++) await svc.get(`r${i}`);
  assert.equal(await svc.get('r1'), 'pro');
});

test('off mode never gates', async () => {
  assert.equal((await runGate('free', { mode: 'off', path: '/stats/demo' })).blocked, false);
});
