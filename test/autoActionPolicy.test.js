const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AUTO_ACTION_STALE_TTL_SECONDS,
  isPermanentMissingOrderResponse,
  handleAutoActionWordPressFailure,
} = require('../autoActionPolicy');

const k = (code, key) => `${code}:${key}`;

function makeRedis() {
  const calls = [];
  async function redisCommand(command, ...args) {
    calls.push([String(command).toUpperCase(), ...args]);
    return { result: 'OK' };
  }
  redisCommand.calls = calls;
  return redisCommand;
}

function silentLogger() {
  return { warn() {} };
}

test('404 order_not_found is the only permanent missing-order response', () => {
  assert.equal(
    isPermanentMissingOrderResponse({ status: 404 }, { code: 'order_not_found' }),
    true
  );
  assert.equal(
    isPermanentMissingOrderResponse({ status: 404 }, {}),
    false
  );
  assert.equal(
    isPermanentMissingOrderResponse({ status: 404 }, { code: 'rest_no_route' }),
    false
  );
  assert.equal(
    isPermanentMissingOrderResponse({ status: 503 }, { code: 'order_not_found' }),
    false
  );
});

test('stale WooCommerce order gets a bounded auto_actioned skip marker', async () => {
  const redisCommand = makeRedis();
  const handled = await handleAutoActionWordPressFailure({
    redisCommand,
    k,
    code: 'hothouse',
    orderId: 680,
    action: 'accept',
    wpResponse: { status: 404 },
    wpResult: { code: 'order_not_found', message: 'Order not found.' },
    logger: silentLogger(),
  });

  assert.equal(handled, true);
  assert.deepEqual(redisCommand.calls, [[
    'SET',
    'hothouse:auto_actioned:680',
    'yes',
    'EX',
    AUTO_ACTION_STALE_TTL_SECONDS,
  ]]);
});

test('temporary or route-level failures remain retryable and write no skip marker', async () => {
  for (const scenario of [
    { wpResponse: { status: 503 }, wpResult: { code: 'service_unavailable' } },
    { wpResponse: { status: 404 }, wpResult: { code: 'rest_no_route' } },
    { wpResponse: { status: 401 }, wpResult: { code: 'unauthorized' } },
  ]) {
    const redisCommand = makeRedis();
    const handled = await handleAutoActionWordPressFailure({
      redisCommand,
      k,
      code: 'hothouse',
      orderId: 680,
      action: 'accept',
      ...scenario,
      logger: silentLogger(),
    });
    assert.equal(handled, false);
    assert.deepEqual(redisCommand.calls, []);
  }
});

test('same permanent policy applies to auto-reject', async () => {
  const redisCommand = makeRedis();
  const handled = await handleAutoActionWordPressFailure({
    redisCommand,
    k,
    code: 'hothouse',
    orderId: 678,
    action: 'reject',
    wpResponse: { status: 404 },
    wpResult: { code: 'order_not_found' },
    logger: silentLogger(),
  });

  assert.equal(handled, true);
  assert.equal(redisCommand.calls.length, 1);
  assert.equal(redisCommand.calls[0][1], 'hothouse:auto_actioned:678');
});
