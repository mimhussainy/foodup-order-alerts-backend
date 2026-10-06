const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createRestaurantSecurity } = require('../restaurantSecurity');
const {
  createCustomerEmailRequestHandler,
  createCustomerEmailService,
  DEFAULT_INVOICE_RESEND_TIMEOUT_MS,
  resolveResendTimeoutMs,
} = require('../customerEmail');

function quietLogger() {
  return { log() {}, warn() {}, error() {} };
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

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); },
  };
}

function makeRouteFixture(options = {}) {
  const redis = makeRedis();
  redis.values.set('hothouse:restaurant_profile', JSON.stringify({ name: 'Hot House' }));
  redis.values.set('hothouse:customer_email_settings', JSON.stringify({ resend_enabled: true }));
  let sends = 0;
  const customerEmailService = {
    async send(input) {
      sends += 1;
      return { status: 200, body: { success: true, handled: true, provider: 'resend', input } };
    },
  };
  const restaurantSecurity = {
    async isStrictWordPressProof(code, secret, client) {
      return code === 'hothouse' && secret === 'stored-secret' && client === 'wordpress';
    },
  };
  const handler = createCustomerEmailRequestHandler({
    restaurantSecurity,
    redisCommand: redis.command.bind(redis),
    k: (code, key) => `${code}:${key}`,
    customerEmailService,
    logger: quietLogger(),
    rateLimit: options.rateLimit || 300,
    rateWindowSeconds: 3600,
  });
  return { redis, handler, sends: () => sends };
}

function emailRequest(headers = {}) {
  return {
    headers,
    body: {
      restaurant_code: 'hothouse',
      order_id: 965,
      type: 'accepted',
      to: 'customer@example.com',
      reply_to: 'restaurant@example.com',
      subject: 'Bestellung angenommen',
      html: '<p>Accepted</p>',
    },
  };
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
  assert.ok(request.options.signal);
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
  assert.equal(JSON.stringify(result.body).includes('rate limited'), false);
});

test('aborts a slow Resend request and returns handled timeout before WordPress timeout', async () => {
  const service = createCustomerEmailService({
    env: { RESEND_API_KEY: 'test-key' },
    resendTimeoutMs: 10,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
    logger: quietLogger(),
  });

  const result = await service.send({
    restaurantCode: 'hothouse',
    enabled: true,
    restaurantName: 'Hot House',
    orderId: 965,
    type: 'received',
    to: 'customer@example.com',
    subject: 'Received',
    html: '<p>Received</p>',
  });

  assert.equal(result.status, 502);
  assert.equal(result.body.handled, true);
  assert.equal(result.body.code, 'resend_timeout');
});

test('headerless or legacy-only customer-email request is not sent and falls back safely', async () => {
  const fixture = makeRouteFixture();

  for (const headers of [
    { 'x-foodup-client': 'wordpress' },
    { 'x-foodup-client': 'wordpress', 'x-foodup-secret': 'legacy-secret' },
  ]) {
    const res = makeResponse();
    await fixture.handler(emailRequest(headers), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.handled, false);
    assert.equal(res.body.code, 'central_email_requires_restaurant_secret');
  }
  assert.equal(fixture.sends(), 0);
});

test('wrong restaurant secret is not sent even when transition compatibility would otherwise be available', async () => {
  const fixture = makeRouteFixture();
  const res = makeResponse();
  await fixture.handler(emailRequest({ 'x-foodup-client': 'wordpress', 'x-foodup-secret': 'wrong-secret' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.handled, false);
  assert.equal(res.body.code, 'central_email_requires_restaurant_secret');
  assert.equal(fixture.sends(), 0);
});

test('correct stored restaurant secret can send through central Resend route', async () => {
  const fixture = makeRouteFixture();
  const res = makeResponse();
  await fixture.handler(emailRequest({ 'x-foodup-client': 'wordpress', 'x-foodup-secret': 'stored-secret' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.provider, 'resend');
  assert.equal(fixture.sends(), 1);
});

test('customer-email route rate limits authenticated restaurant after configured hourly allowance', async () => {
  const fixture = makeRouteFixture({ rateLimit: 2 });
  const headers = { 'x-foodup-client': 'wordpress', 'x-foodup-secret': 'stored-secret' };

  const first = makeResponse();
  const second = makeResponse();
  const third = makeResponse();
  await fixture.handler(emailRequest(headers), first);
  await fixture.handler(emailRequest(headers), second);
  await fixture.handler(emailRequest(headers), third);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(third.statusCode, 429);
  assert.equal(third.body.handled, true);
  assert.equal(third.body.code, 'central_email_rate_limited');
  assert.ok(Number(third.headers['retry-after']) > 0);
  assert.equal(fixture.sends(), 2);
});


test('customer-email strict auth does not inherit legacy transition compatibility from authorizeWordPress', async () => {
  const redis = makeRedis();
  const command = redis.command.bind(redis);
  const storedSecret = 'stored-restaurant-secret-0123456789abcdef';
  const legacySecret = 'legacy-shared-secret-0123456789abcdef';
  const restaurantSecurity = createRestaurantSecurity({
    redisCommand: command,
    k: (code, key) => `${code}:${key}`,
    env: {
      FOODUP_SECRET_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      FOODUP_LEGACY_SHARED_SECRET: legacySecret,
      FOODUP_LEGACY_APP_ACCESS_ENABLED: 'true',
    },
    logger: quietLogger(),
  });
  await restaurantSecurity.setStoredRestaurantSecret('hothouse', storedSecret);

  const transitionAuth = await restaurantSecurity.authorizeWordPress('hothouse', legacySecret, 'wordpress');
  assert.equal(transitionAuth.ok, true);
  assert.equal(transitionAuth.source, 'legacy_compat');

  redis.values.set('hothouse:restaurant_profile', JSON.stringify({ name: 'Hot House' }));
  redis.values.set('hothouse:customer_email_settings', JSON.stringify({ resend_enabled: true }));
  let sends = 0;
  const handler = createCustomerEmailRequestHandler({
    restaurantSecurity,
    redisCommand: command,
    k: (code, key) => `${code}:${key}`,
    customerEmailService: {
      async send() {
        sends += 1;
        return { status: 200, body: { success: true, handled: true, provider: 'resend' } };
      },
    },
    logger: quietLogger(),
  });

  const legacyRes = makeResponse();
  await handler(emailRequest({ 'x-foodup-client': 'wordpress', 'x-foodup-secret': legacySecret }), legacyRes);
  assert.equal(legacyRes.statusCode, 200);
  assert.equal(legacyRes.body.handled, false);
  assert.equal(legacyRes.body.code, 'central_email_requires_restaurant_secret');
  assert.equal(sends, 0);

  const strictRes = makeResponse();
  await handler(emailRequest({ 'x-foodup-client': 'wordpress', 'x-foodup-secret': storedSecret }), strictRes);
  assert.equal(strictRes.statusCode, 200);
  assert.equal(strictRes.body.success, true);
  assert.equal(sends, 1);
});


test('sends an invoice PDF attachment through Resend with invoice idempotency', async () => {
  let request;
  const service = createCustomerEmailService({
    env: { RESEND_API_KEY: 'test-key' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'invoice-email-123' }) };
    },
    logger: quietLogger(),
  });

  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'ascii'),
    Buffer.alloc(200, 65),
  ]).toString('base64');

  const result = await service.send({
    restaurantCode: 'hothouse',
    enabled: true,
    restaurantName: 'Hot House',
    orderId: 969,
    type: 'invoice',
    to: 'customer@example.com',
    replyTo: 'restaurant@example.com',
    subject: 'Beleg für Bestellung #969',
    html: '<p>Ihr Bestellbeleg</p>',
    attachments: [{
      filename: 'foodup-beleg-bestellung-969.pdf',
      content: pdf,
    }],
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(request.options.headers['Idempotency-Key'], 'foodup/hothouse/969/invoice');

  const body = JSON.parse(request.options.body);
  assert.equal(body.attachments.length, 1);
  assert.equal(body.attachments[0].filename, 'foodup-beleg-bestellung-969.pdf');
  assert.equal(body.attachments[0].content, pdf);
});

test('rejects an invoice without a valid PDF attachment and never calls Resend', async () => {
  let calls = 0;
  const service = createCustomerEmailService({
    env: { RESEND_API_KEY: 'test-key' },
    fetchImpl: async () => {
      calls += 1;
      throw new Error('should not run');
    },
    logger: quietLogger(),
  });

  for (const attachments of [
    [],
    [{ filename: 'invoice.pdf', content: Buffer.from('not a pdf').toString('base64') }],
    [{ filename: 'invoice.exe', content: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200)]).toString('base64') }],
  ]) {
    const result = await service.send({
      restaurantCode: 'hothouse',
      enabled: true,
      restaurantName: 'Hot House',
      orderId: 969,
      type: 'invoice',
      to: 'customer@example.com',
      subject: 'Invoice',
      html: '<p>Invoice</p>',
      attachments,
    });

    assert.equal(result.status, 400);
    assert.equal(result.body.handled, true);
  }

  assert.equal(calls, 0);
});

test('sends a delivered email with the validated PDF receipt attachment', async () => {
  let request;
  const service = createCustomerEmailService({
    env: { RESEND_API_KEY: 'test-key' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'delivered-email-123' }) };
    },
    logger: quietLogger(),
  });

  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'ascii'),
    Buffer.alloc(200, 65),
  ]).toString('base64');

  const result = await service.send({
    restaurantCode: 'hothouse',
    enabled: true,
    restaurantName: 'Hot House',
    orderId: 973,
    type: 'delivered',
    to: 'customer@example.com',
    replyTo: 'restaurant@example.com',
    subject: 'Bestellung #973 wurde geliefert',
    html: '<p>Delivered with receipt</p>',
    attachments: [{ filename: 'foodup-beleg-bestellung-973.pdf', content: pdf }],
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(request.options.headers['Idempotency-Key'], 'foodup/hothouse/973/delivered');
  const body = JSON.parse(request.options.body);
  assert.equal(body.attachments.length, 1);
  assert.equal(body.attachments[0].filename, 'foodup-beleg-bestellung-973.pdf');
  assert.equal(body.attachments[0].content, pdf);
});

test('delivered remains valid without an attachment', async () => {
  let request;
  const service = createCustomerEmailService({
    env: { RESEND_API_KEY: 'test-key' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'delivered-no-pdf-123' }) };
    },
    logger: quietLogger(),
  });

  const result = await service.send({
    restaurantCode: 'hothouse', enabled: true, restaurantName: 'Hot House', orderId: 973,
    type: 'delivered', to: 'customer@example.com', subject: 'Delivered', html: '<p>Delivered</p>',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  const body = JSON.parse(request.options.body);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'attachments'), false);
});

test('rejects an invalid delivered PDF attachment and never calls Resend', async () => {
  let calls = 0;
  const service = createCustomerEmailService({
    env: { RESEND_API_KEY: 'test-key' },
    fetchImpl: async () => { calls += 1; throw new Error('should not run'); },
    logger: quietLogger(),
  });

  const result = await service.send({
    restaurantCode: 'hothouse', enabled: true, restaurantName: 'Hot House', orderId: 973,
    type: 'delivered', to: 'customer@example.com', subject: 'Delivered', html: '<p>Delivered</p>',
    attachments: [{ filename: 'receipt.pdf', content: Buffer.from('not a pdf').toString('base64') }],
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.handled, true);
  assert.equal(result.body.code, 'invalid_email_attachment');
  assert.equal(calls, 0);
});

test('delivered with an attachment uses the 12-second attachment timeout while plain delivered stays at 8 seconds', () => {
  assert.equal(DEFAULT_INVOICE_RESEND_TIMEOUT_MS, 12_000);
  assert.equal(resolveResendTimeoutMs([{ filename: 'receipt.pdf' }]), 12_000);
  assert.equal(resolveResendTimeoutMs([]), 8_000);
});

test('rejects attachments on lifecycle emails other than delivered or invoice', async () => {
  let calls = 0;
  const service = createCustomerEmailService({
    env: { RESEND_API_KEY: 'test-key' },
    fetchImpl: async () => {
      calls += 1;
      throw new Error('should not run');
    },
    logger: quietLogger(),
  });

  const result = await service.send({
    restaurantCode: 'hothouse',
    enabled: true,
    restaurantName: 'Hot House',
    orderId: 969,
    type: 'accepted',
    to: 'customer@example.com',
    subject: 'Accepted',
    html: '<p>Accepted</p>',
    attachments: [{
      filename: 'invoice.pdf',
      content: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200)]).toString('base64'),
    }],
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.handled, true);
  assert.equal(result.body.code, 'attachments_not_allowed');
  assert.equal(calls, 0);
});

test('strict customer-email route forwards invoice attachment only after stored-secret proof', async () => {
  const fixture = makeRouteFixture();
  const headers = { 'x-foodup-client': 'wordpress', 'x-foodup-secret': 'stored-secret' };
  const request = emailRequest(headers);
  request.body.type = 'invoice';
  request.body.attachments = [{
    filename: 'foodup-beleg-bestellung-969.pdf',
    content: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200)]).toString('base64'),
  }];

  const res = makeResponse();
  await fixture.handler(request, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.input.type, 'invoice');
  assert.equal(res.body.input.attachments.length, 1);
});
