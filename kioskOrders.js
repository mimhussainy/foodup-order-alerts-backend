'use strict';

/*
 * FoodUp Kiosk orders in the FoodUp Orders backend.
 *
 * A kiosk order reaches /new-order from the restaurant's website with
 * source = "kiosk", the daily number in qr_order_number (shared with QR table
 * orders, starts at 100), kiosk_device, kiosk_name, paid and payment_status.
 *
 * - Push title:  "Kiosk #104 · Hier essen" / "Kiosk #104 · Mitnehmen"
 * - Push body:   "CHF 24.50 • Online bezahlt" / "CHF 24.50 • An der Kasse zahlen"
 * - Kiosk orders are always accepted at once, whatever the auto-accept setting is,
 *   so the Orders app prints the ticket without anybody tapping Accept.
 */

// Quick retries first, then once a minute for ten more minutes.
const KIOSK_ACCEPT_RETRY_DELAYS_MS = [0, 2000, 6000, 15000, 45000, ...Array(10).fill(60000)];
const KIOSK_DEFAULT_ACCEPT_TIME = '15 Minutes';
const DAY_SECONDS = 86400;

function isKioskOrder(order) {
  return String(order?.source || '').trim().toLowerCase() === 'kiosk';
}

function kioskNumber(order) {
  const number = Number(order?.qr_order_number || 0);
  return Number.isFinite(number) && number >= 100 ? number : 0;
}

function isKioskDineIn(order) {
  const type = String(order?.fulfillment_type || order?.order_type || '').trim().toLowerCase();
  return type === 'dine_in';
}

function kioskServiceLabel(order) {
  return isKioskDineIn(order) ? 'Hier essen' : 'Mitnehmen';
}

function isOrderPaid(order) {
  if (order?.paid === true || order?.paid === 'true' || order?.paid === 1 || order?.paid === '1') return true;
  return String(order?.payment_status || '').trim().toLowerCase() === 'paid';
}

/** "Kiosk #104", "QR #104" or "Order #5001": the short name used in titles. */
function orderLabel(order) {
  const number = kioskNumber(order);
  if (isKioskOrder(order)) {
    return number ? `Kiosk #${number}` : `Kiosk order #${order?.order_id || ''}`.trim();
  }
  return number ? `QR #${number}` : `Order #${order?.order_id || ''}`;
}

function kioskPushTitle(order) {
  return `🛒 ${orderLabel(order)} · ${kioskServiceLabel(order)}`;
}

function kioskPushBody(order) {
  const amount = `${String(order?.currency || '')} ${String(order?.total || '')}`.trim();
  const payment = isOrderPaid(order) ? 'Online bezahlt' : 'An der Kasse zahlen';
  return [amount, payment].filter(Boolean).join(' • ');
}

/** Extra fields the Orders app needs on every push of a kiosk order. */
function kioskContextPushData(order) {
  const value = order && typeof order === 'object' ? order : {};
  const hasPaid = value.paid !== undefined && value.paid !== null && value.paid !== '';
  return {
    kiosk_device: String(value.kiosk_device || ''),
    kiosk_name: String(value.kiosk_name || ''),
    payment_status: String(value.payment_status || ''),
    payment_method_id: String(value.payment_method_id || ''),
    paid: hasPaid ? String(isOrderPaid(value)) : '',
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Accepts a kiosk order at once.
 *
 * WordPress must confirm first; only then are the same markers written that the
 * per-minute auto-accept writes (so that loop never touches the order again) and
 * the "auto_accepted" push sent that makes the Orders app print.
 * If every attempt fails the per-minute loop still picks the order up (it never
 * auto-rejects kiosk orders).
 */
function createKioskAutoAccept({
  redisCommand,
  k,
  getTokens,
  fetchWordPress,
  sendPush,
  contextPushData,
  itemsString,
  logger = console,
  delaysMs = KIOSK_ACCEPT_RETRY_DELAYS_MS,
}) {
  const inFlight = new Set();

  async function readSettingsAcceptTime(code) {
    try {
      const stored = await redisCommand('GET', k(code, 'auto_settings'));
      const settings = stored?.result ? JSON.parse(stored.result) : null;
      return String(settings?.accept_time || '').trim() || KIOSK_DEFAULT_ACCEPT_TIME;
    } catch (error) {
      return KIOSK_DEFAULT_ACCEPT_TIME;
    }
  }

  async function websiteBaseUrl(code) {
    const profileData = await redisCommand('GET', k(code, 'restaurant_profile'));
    const profile = profileData?.result ? JSON.parse(profileData.result) : null;
    const website = profile?.website;
    if (!website) return null;
    return String(website).startsWith('http') ? String(website) : `https://${website}`;
  }

  async function alreadyDecided(code, orderId) {
    const state = await redisCommand(
      'MGET',
      k(code, `accepted_time:${orderId}`),
      k(code, `rejected_time:${orderId}`),
      k(code, `auto_actioned:${orderId}`),
    );
    return (state?.result || []).some(Boolean);
  }

  async function attempt(code, order, acceptedTime) {
    const baseUrl = await websiteBaseUrl(code);
    if (!baseUrl) throw new Error(`WordPress base URL missing for ${code}`);

    const response = await fetchWordPress(code, `${baseUrl}/wp-json/foodup/v1/order-accepted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: order.order_id, accepted_time: acceptedTime }),
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok || result?.success !== true) {
      throw new Error(`WP accept failed for ${code}, order ${order.order_id}: HTTP ${response.status}`);
    }

    await redisCommand('SET', k(code, `auto_actioned:${order.order_id}`), 'yes', 'EX', DAY_SECONDS);
    await redisCommand('SET', k(code, `auto_accepted:${order.order_id}`), 'yes', 'EX', DAY_SECONDS);
    await redisCommand(
      'SET',
      k(code, `accepted_time:${order.order_id}`),
      JSON.stringify({
        accepted_time: acceptedTime,
        accepted_at: new Date().toISOString(),
        status: 'accepted',
        source: 'auto',
        auto_accepted: true,
      }),
      'EX',
      DAY_SECONDS,
    );

    const tokens = await getTokens(code);
    if (tokens.length > 0) {
      const messages = tokens.map((token) => ({
        to: token,
        priority: 'high',
        ttl: 900,
        sound: null,
        title: `✅ ${orderLabel(order)} · ${kioskServiceLabel(order)}`,
        body: kioskPushBody(order),
        data: {
          event_type: 'auto_accepted',
          restaurant_code: code,
          order_id: String(order.order_id),
          accepted_time: acceptedTime,
          customer_name: String(order.customer_name || ''),
          customer_email: String(order.customer_email || ''),
          customer_phone: String(order.customer_phone || ''),
          total: String(order.total || ''),
          currency: String(order.currency || ''),
          payment_method: String(order.payment_method || ''),
          note: String(order.note || ''),
          fulfillment_type: String(order.fulfillment_type || 'unknown'),
          shipping_method: String(order.shipping?.method || ''),
          shipping_address: String(order.shipping?.address || ''),
          orderable_order_date: String(order.orderable_order_date || ''),
          orderable_order_time: String(order.orderable_order_time || ''),
          date_created: String(order.date_created || ''),
          ...contextPushData(order),
          items: itemsString(order.items),
        },
      }));
      await sendPush(messages);
    }
  }

  /** Never throws. Resolves true when the order was accepted. */
  async function accept(code, order) {
    const orderId = String(order?.order_id || '');
    const key = `${code}:${orderId}`;
    if (!orderId || inFlight.has(key)) return false;
    inFlight.add(key);

    try {
      const acceptedTime = await readSettingsAcceptTime(code);

      for (let index = 0; index < delaysMs.length; index += 1) {
        if (delaysMs[index] > 0) await wait(delaysMs[index]);

        try {
          if (await alreadyDecided(code, orderId)) return true;
          await attempt(code, order, acceptedTime);
          return true;
        } catch (error) {
          logger.warn?.(`[kiosk] accept attempt ${index + 1} failed for ${code}/${orderId}: ${error.message}`);
        }
      }

      logger.error?.(`[kiosk] could not auto-accept ${code}/${orderId}; the per-minute auto-accept may still pick it up`);
      return false;
    } finally {
      inFlight.delete(key);
    }
  }

  return { accept };
}

module.exports = {
  KIOSK_ACCEPT_RETRY_DELAYS_MS,
  createKioskAutoAccept,
  isKioskOrder,
  isOrderPaid,
  kioskContextPushData,
  kioskPushBody,
  kioskPushTitle,
  orderLabel,
};
