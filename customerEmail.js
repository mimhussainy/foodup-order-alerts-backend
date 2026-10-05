const ALLOWED_TYPES = new Set([
  'received',
  'accepted',
  'kitchen',
  'ready_pickup',
  'out_for_delivery',
  'rejected',
  'delivered',
  'refunded',
]);

function normalizeCode(value) {
  return String(value || '').trim().toLowerCase();
}

function safeDisplayName(value, fallback = 'FoodUp Restaurant') {
  const cleaned = String(value || '')
    .replace(/[\r\n<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned || fallback;
}

function looksLikeEmail(value) {
  const email = String(value || '').trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createCustomerEmailService({ fetchImpl = global.fetch, env = process.env, logger = console } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Customer email service requires fetch.');

  async function send(input = {}) {
    const code = normalizeCode(input.restaurantCode);
    const enabled = input.enabled === true;

    if (!code || !enabled) {
      return {
        status: 200,
        body: {
          success: false,
          handled: false,
          code: 'resend_not_enabled',
          message: 'Central email delivery is not enabled for this restaurant.',
        },
      };
    }

    const apiKey = String(env.RESEND_API_KEY || '').trim();
    if (!apiKey) {
      logger.error(`[customer-email] RESEND_API_KEY missing for ${code}`);
      return {
        status: 503,
        body: {
          success: false,
          handled: true,
          code: 'resend_not_configured',
          message: 'Central email delivery is not configured.',
        },
      };
    }

    const orderId = String(input.orderId || '').trim();
    const type = String(input.type || '').trim().toLowerCase();
    const to = String(input.to || '').trim();
    const replyTo = String(input.replyTo || '').trim();
    const subject = String(input.subject || '').replace(/[\r\n]+/g, ' ').trim();
    const html = String(input.html || '');

    if (!/^\d+$/.test(orderId) || !ALLOWED_TYPES.has(type) || !looksLikeEmail(to) || !subject || !html) {
      return {
        status: 400,
        body: {
          success: false,
          handled: true,
          code: 'invalid_email_payload',
          message: 'Invalid customer email payload.',
        },
      };
    }

    if (subject.length > 998 || html.length > 2_000_000 || (replyTo && !looksLikeEmail(replyTo))) {
      return {
        status: 400,
        body: {
          success: false,
          handled: true,
          code: 'invalid_email_payload',
          message: 'Invalid customer email payload.',
        },
      };
    }

    const restaurantName = safeDisplayName(input.restaurantName, code);
    const requestBody = {
      from: `${restaurantName} via FoodUp <no-reply@foodup.ch>`,
      to: [to],
      subject,
      html,
    };
    if (replyTo) requestBody.reply_to = replyTo;

    const idempotencyKey = `foodup/${code}/${orderId}/${type}`;

    try {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(requestBody),
      });

      const raw = await response.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch (_) {
        data = {};
      }

      if (!response.ok || !data.id) {
        logger.error(`[customer-email] Resend rejected ${code}/${orderId}/${type}: HTTP ${response.status}`);
        return {
          status: 502,
          body: {
            success: false,
            handled: true,
            code: 'resend_send_failed',
            message: 'Central email provider rejected the message.',
            provider_status: response.status,
          },
        };
      }

      logger.log(`[customer-email] Resend accepted ${code}/${orderId}/${type}: ${data.id}`);
      return {
        status: 200,
        body: {
          success: true,
          handled: true,
          provider: 'resend',
          email_id: String(data.id),
        },
      };
    } catch (error) {
      logger.error(`[customer-email] Resend request failed ${code}/${orderId}/${type}: ${error?.name || 'error'}`);
      return {
        status: 502,
        body: {
          success: false,
          handled: true,
          code: 'resend_request_failed',
          message: 'Central email provider could not be reached.',
        },
      };
    }
  }

  return { send };
}

module.exports = {
  ALLOWED_TYPES,
  createCustomerEmailService,
  safeDisplayName,
};
