const test = require('node:test');
const assert = require('node:assert/strict');
const { createCustomerEmailService } = require('../customerEmail');

function quietLogger() {
  return { log() {}, warn() {}, error() {} };
}

test('does not handle restaurants unless central Resend is enabled for that restaurant', async () => {
  let calls = 0;
  const service = createCustomerEmailService({
    env: { RESEND_API_KEY: 'test-key' },
    fetchImpl: async () => { calls += 1; throw new Error('should not run'); },
    logger: quietLogger(),
  });

  const result = await service.send({ restaurantCode: 'hothouse', enabled: false });
  assert.equal(result.status, 200);
  assert.equal(result.body.handled, false);
  assert.equal(result.body.code, 'resend_not_enabled');
  assert.equal(calls, 0);
});

test('requires RESEND_API_KEY for enabled restaurants', async () => {
  const service = createCustomerEmailService({
    env: {},
    fetchImpl: async () => { throw new Error('should not run'); },
    logger: quietLogger(),
  });

  const result = await service.send({ restaurantCode: 'hothouse', enabled: true });
  assert.equal(result.status, 503);
  assert.equal(result.body.handled, true);
  assert.equal(result.body.code, 'resend_not_configured');
});

test('sends through Resend with deterministic idempotency and FoodUp sender', async () => {
  let request;
  const service = createCustomerEmailService({
    env: { RESEND_API_KEY: 'test-key' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'email-123' }) };
    },
    logger: quietLogger(),
  });

  const result = await service.send({
    restaurantCode: 'HotHouse',
    enabled: true,
    restaurantName: 'Hot House',
    orderId: 965,
    type: 'accepted',
    to: 'customer@example.com',
    replyTo: 'restaurant@example.com',
    subject: 'Bestellung angenommen',
    html: '<p>Accepted</p>',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.email_id, 'email-123');
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.options.headers['Idempotency-Key'], 'foodup/hothouse/965/accepted');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(request.options.body);
  assert.equal(body.from, 'Hot House via FoodUp <no-reply@foodup.ch>');
  assert.deepEqual(body.to, ['customer@example.com']);
  assert.equal(body.reply_to, 'restaurant@example.com');
});

test('returns a controlled provider failure without leaking provider body', async () => {
  const service = createCustomerEmailService({
    env: { RESEND_API_KEY: 'test-key' },
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => '{"message":"rate limited"}' }),
    logger: quietLogger(),
  });

  const result = await service.send({
    restaurantCode: 'hothouse',
    enabled: true,
    restaurantName: 'Hot House',
    orderId: 965,
    type: 'kitchen',
    to: 'customer@example.com',
    subject: 'Kitchen',
    html: '<p>Kitchen</p>',
  });

  assert.equal(result.status, 502);
  assert.equal(result.body.success, false);
  assert.equal(result.body.code, 'resend_send_failed');
  assert.equal(result.body.provider_status, 429);
});
