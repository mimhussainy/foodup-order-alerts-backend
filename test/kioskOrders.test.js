const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createKioskAutoAccept,
  isKioskOrder,
  kioskContextPushData,
  kioskPushBody,
  kioskPushTitle,
  orderLabel,
} = require('../kioskOrders');

const kioskOrder = (extra = {}) => ({
  order_id: 5001,
  source: 'kiosk',
  qr_order_number: 104,
  fulfillment_type: 'dine_in',
  order_type: 'dine_in',
  kiosk_device: 'kd_1',
  kiosk_name: 'Kiosk 1 · Eingang',
  currency: 'CHF',
  total: '24.50',
  paid: false,
  payment_status: 'unpaid',
  payment_method_id: 'foodup_offline',
  items: [],
  ...extra,
});

test('titles and bodies', () => {
  assert.equal(isKioskOrder(kioskOrder()), true);
  assert.equal(isKioskOrder({ source: 'table' }), false);
  assert.equal(kioskPushTitle(kioskOrder()), '🛒 Kiosk #104 · Hier essen');
  assert.equal(kioskPushTitle(kioskOrder({ fulfillment_type: 'pickup', order_type: 'pickup' })), '🛒 Kiosk #104 · Mitnehmen');
  assert.equal(kioskPushBody(kioskOrder()), 'CHF 24.50 • An der Kasse zahlen');
  assert.equal(kioskPushBody(kioskOrder({ paid: true, payment_status: 'paid' })), 'CHF 24.50 • Online bezahlt');
  assert.equal(kioskPushBody(kioskOrder({ paid: false, payment_status: 'paid' })), 'CHF 24.50 • Online bezahlt');
});

test('labels keep the old wording for other orders', () => {
  assert.equal(orderLabel(kioskOrder()), 'Kiosk #104');
  assert.equal(orderLabel({ order_id: 77, qr_order_number: 104, source: 'table' }), 'QR #104');
  assert.equal(orderLabel({ order_id: 77, qr_order_number: 0 }), 'Order #77');
  assert.equal(orderLabel({ order_id: 77, qr_order_number: 99 }), 'Order #77');
});

test('push data carries kiosk name, payment and paid as text', () => {
  assert.deepEqual(kioskContextPushData(kioskOrder()), {
    kiosk_device: 'kd_1',
    kiosk_name: 'Kiosk 1 · Eingang',
    payment_status: 'unpaid',
    payment_method_id: 'foodup_offline',
    paid: 'false',
  });
  assert.equal(kioskContextPushData(kioskOrder({ paid: true })).paid, 'true');
  assert.equal(kioskContextPushData({ order_id: 1 }).paid, '');
  assert.equal(kioskContextPushData(null).kiosk_name, '');
});

function setup({ failures = 0, profile = { website: 'eatime.ch' }, accepted = false } = {}) {
  const store = new Map();
  if (profile) store.set('eatime:restaurant_profile', JSON.stringify(profile));
  if (accepted) store.set('eatime:accepted_time:5001', '{}');
  const calls = [];
  const pushes = [];
  let remaining = failures;

  const redisCommand = async (command, ...args) => {
    if (command === 'GET') return { result: store.get(args[0]) ?? null };
    if (command === 'SET') { store.set(args[0], args[1]); return { result: 'OK' }; }
    if (command === 'MGET') return { result: args.map((key) => store.get(key) ?? null) };
    throw new Error(`unexpected ${command}`);
  };

  const accept = createKioskAutoAccept({
    redisCommand,
    k: (code, key) => `${code}:${key}`,
    getTokens: async () => ['ExponentPushToken[abc]'],
    fetchWordPress: async (code, url, options) => {
      calls.push({ code, url, body: JSON.parse(options.body) });
      if (remaining > 0) {
        remaining -= 1;
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    },
    sendPush: async (messages) => { pushes.push(...messages); },
    contextPushData: kioskContextPushData,
    itemsString: () => '[]',
    logger: { warn() {}, error() {} },
    delaysMs: [0, 1, 1],
  });

  return { accept, calls, pushes, store };
}

test('accepts a kiosk order at once and sends the print push', async () => {
  const { accept, calls, pushes, store } = setup();
  assert.equal(await accept.accept('eatime', kioskOrder()), true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://eatime.ch/wp-json/foodup/v1/order-accepted');
  assert.equal(calls[0].body.order_id, 5001);
  assert.equal(store.get('eatime:auto_accepted:5001'), 'yes');
  assert.equal(store.get('eatime:auto_actioned:5001'), 'yes');
  assert.equal(JSON.parse(store.get('eatime:accepted_time:5001')).auto_accepted, true);

  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, '✅ Kiosk #104 · Hier essen');
  assert.equal(pushes[0].body, 'CHF 24.50 • An der Kasse zahlen');
  assert.equal(pushes[0].data.event_type, 'auto_accepted');
  assert.equal(pushes[0].data.kiosk_name, 'Kiosk 1 · Eingang');
  assert.equal(pushes[0].data.paid, 'false');
});

test('retries when WordPress is slow, and gives up quietly', async () => {
  const retry = setup({ failures: 2 });
  assert.equal(await retry.accept.accept('eatime', kioskOrder()), true);
  assert.equal(retry.calls.length, 3);
  assert.equal(retry.pushes.length, 1);

  const never = setup({ failures: 99 });
  assert.equal(await never.accept.accept('eatime', kioskOrder()), false);
  assert.equal(never.pushes.length, 0);
  assert.equal(never.store.get('eatime:auto_accepted:5001'), undefined);
});

test('does nothing twice and does nothing for an order someone already handled', async () => {
  const handled = setup({ accepted: true });
  assert.equal(await handled.accept.accept('eatime', kioskOrder()), true);
  assert.equal(handled.calls.length, 0);
  assert.equal(handled.pushes.length, 0);

  const missing = setup({ profile: null });
  assert.equal(await missing.accept.accept('eatime', kioskOrder()), false);
  assert.equal(missing.calls.length, 0);

  const twice = setup();
  const [first, second] = await Promise.all([
    twice.accept.accept('eatime', kioskOrder()),
    twice.accept.accept('eatime', kioskOrder()),
  ]);
  assert.deepEqual([first, second], [true, false]);
  assert.equal(twice.calls.length, 1);
});
