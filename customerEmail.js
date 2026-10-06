const ALLOWED_TYPES = new Set([
  'received',
  'accepted',
  'kitchen',
  'ready_pickup',
  'out_for_delivery',
  'rejected',
  'delivered',
  'refunded',
  'invoice',
]);

const DEFAULT_RESEND_TIMEOUT_MS = 8_000;
const DEFAULT_INVOICE_RESEND_TIMEOUT_MS = 12_000;
const DEFAULT_RATE_LIMIT = 300;
const DEFAULT_RATE_WINDOW_SECONDS = 60 * 60;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;


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

function normalizeAttachments(type, input, orderId) {
  const attachments = Array.isArray(input) ? input : [];
  const invoice = type === 'invoice';
  const delivered = type === 'delivered';

  if (!invoice && !delivered) {
    return attachments.length === 0
      ? { ok: true, attachments: [] }
      : { ok: false, code: 'attachments_not_allowed' };
  }

  // Invoice always carries one PDF. Delivered normally has no attachment, but
  // may carry the same single validated PDF when WordPress combines the final
  // delivery update with the receipt.
  if (delivered && attachments.length === 0) {
    return { ok: true, attachments: [] };
  }

  if (attachments.length !== 1 || !attachments[0] || typeof attachments[0] !== 'object') {
    return { ok: false, code: invoice ? 'invoice_pdf_required' : 'invalid_email_attachment' };
  }

  const invalidCode = invoice ? 'invoice_pdf_invalid' : 'invalid_email_attachment';
  const attachment = attachments[0];
  const content = String(attachment.content || '').trim();
  let filename = String(attachment.filename || '').trim();

  if (!content || content.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 8) {
    return { ok: false, code: invalidCode };
  }
  if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) {
    return { ok: false, code: invalidCode };
  }

  let bytes;
  try {
    bytes = Buffer.from(content, 'base64');
  } catch (_) {
    return { ok: false, code: invalidCode };
  }

  if (
    bytes.length < 100 ||
    bytes.length > MAX_ATTACHMENT_BYTES ||
    bytes.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    bytes.toString('base64').replace(/=+$/, '') !== content.replace(/=+$/, '')
  ) {
    return { ok: false, code: invalidCode };
  }

  filename = filename
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\r\n<>:"|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120);

  if (!filename || !/\.pdf$/i.test(filename)) {
    return { ok: false, code: invalidCode };
  }

  return {
    ok: true,
    attachments: [{
      content: bytes.toString('base64'),
      filename,
    }],
  };
}

function resolveResendTimeoutMs(attachments, resendTimeoutMs = DEFAULT_RESEND_TIMEOUT_MS, attachmentResendTimeoutMs = DEFAULT_INVOICE_RESEND_TIMEOUT_MS) {
  return Array.isArray(attachments) && attachments.length > 0
    ? Math.max(1, Number(attachmentResendTimeoutMs || DEFAULT_INVOICE_RESEND_TIMEOUT_MS))
    : Math.max(1, Number(resendTimeoutMs || DEFAULT_RESEND_TIMEOUT_MS));
}

async function consumeRestaurantEmailRateLimit(redisCommand, key, options = {}) {
  const limit = Math.max(1, Number(options.limit || DEFAULT_RATE_LIMIT));
  const windowSeconds = Math.max(1, Number(options.windowSeconds || DEFAULT_RATE_WINDOW_SECONDS));

  const created = await redisCommand('SET', key, '1', 'EX', windowSeconds, 'NX');
  let count = 1;
  if (created.result !== 'OK') {
    const incremented = await redisCommand('INCR', key);
    count = Math.max(0, Number(incremented.result || 0));
    const ttlCheck = await redisCommand('TTL', key);
    if (Number(ttlCheck.result) < 0) await redisCommand('EXPIRE', key, windowSeconds);
  }

  const ttlResult = await redisCommand('TTL', key);
  const retryAfter = Math.max(1, Number(ttlResult.result || 0)) || windowSeconds;
  return {
    allowed: count <= limit,
    count,
    limit,
    retryAfter,
  };
}

function createCustomerEmailService({
  fetchImpl = global.fetch,
  env = process.env,
  logger = console,
  resendTimeoutMs = DEFAULT_RESEND_TIMEOUT_MS,
  invoiceResendTimeoutMs = DEFAULT_INVOICE_RESEND_TIMEOUT_MS,
} = {}) {
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

    const normalizedAttachments = normalizeAttachments(type, input.attachments, orderId);
    if (!normalizedAttachments.ok) {
      return {
        status: 400,
        body: {
          success: false,
          handled: true,
          code: normalizedAttachments.code || 'invalid_email_attachment',
          message: 'Invalid customer email attachment.',
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
    if (normalizedAttachments.attachments.length) requestBody.attachments = normalizedAttachments.attachments;

    const idempotencyKey = `foodup/${code}/${orderId}/${type}`;
    const controller = new AbortController();
    const timeoutMs = resolveResendTimeoutMs(normalizedAttachments.attachments, resendTimeoutMs, invoiceResendTimeoutMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
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
      if (error?.name === 'AbortError') {
        logger.error(`[customer-email] Resend timed out ${code}/${orderId}/${type}`);
        return {
          status: 502,
          body: {
            success: false,
            handled: true,
            code: 'resend_timeout',
            message: 'Central email provider timed out.',
          },
        };
      }
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
    } finally {
      clearTimeout(timeout);
    }
  }

  return { send };
}

function createCustomerEmailRequestHandler({
  restaurantSecurity,
  redisCommand,
  k,
  customerEmailService,
  logger = console,
  rateLimit = DEFAULT_RATE_LIMIT,
  rateWindowSeconds = DEFAULT_RATE_WINDOW_SECONDS,
} = {}) {
  if (!restaurantSecurity || typeof restaurantSecurity.isStrictWordPressProof !== 'function') {
    throw new Error('Customer email route requires restaurant security.');
  }
  if (typeof redisCommand !== 'function' || typeof k !== 'function') {
    throw new Error('Customer email route requires Redis and key helpers.');
  }
  if (!customerEmailService || typeof customerEmailService.send !== 'function') {
    throw new Error('Customer email route requires the customer email service.');
  }

  return async function customerEmailRequestHandler(req, res) {
    const code = normalizeCode(req.body?.restaurant_code);
    if (!code) {
      return res.status(400).json({
        success: false,
        handled: true,
        code: 'restaurant_code_required',
        message: 'Restaurant code is required.',
      });
    }

    let strictProof = false;
    try {
      strictProof = await restaurantSecurity.isStrictWordPressProof(
        code,
        String(req.headers?.['x-foodup-secret'] || '').trim(),
        String(req.headers?.['x-foodup-client'] || '').trim()
      );
    } catch (error) {
      logger.error(`[customer-email] strict authentication lookup failed for ${code}: ${error?.code || error?.name || 'error'}`);
      return res.status(503).json({
        success: false,
        handled: true,
        code: 'central_email_auth_unavailable',
        message: 'Central email authentication is temporarily unavailable.',
      });
    }

    if (!strictProof) {
      return res.status(200).json({
        success: false,
        handled: false,
        code: 'central_email_requires_restaurant_secret',
        message: 'Central email requires the stored restaurant secret.',
      });
    }

    let restaurantName = code;
    let emailSettings = {};
    try {
      const [profileData, emailSettingsData] = await Promise.all([
        redisCommand('GET', k(code, 'restaurant_profile')),
        redisCommand('GET', k(code, 'customer_email_settings')),
      ]);
      if (profileData.result) {
        const profile = JSON.parse(profileData.result);
        if (profile && profile.name) restaurantName = String(profile.name);
      }
      if (emailSettingsData.result) {
        const parsed = JSON.parse(emailSettingsData.result);
        if (parsed && typeof parsed === 'object') emailSettings = parsed;
      }
    } catch (error) {
      logger.warn(`[customer-email] settings lookup failed for ${code}: ${error?.name || 'error'}`);
      return res.status(503).json({
        success: false,
        handled: true,
        code: 'email_settings_unavailable',
        message: 'Customer email settings are temporarily unavailable.',
      });
    }

    if (emailSettings.resend_enabled !== true) {
      const disabled = await customerEmailService.send({ restaurantCode: code, enabled: false });
      return res.status(disabled.status).json(disabled.body);
    }

    let limitState;
    try {
      limitState = await consumeRestaurantEmailRateLimit(
        redisCommand,
        k(code, 'customer_email_rate_limit'),
        { limit: rateLimit, windowSeconds: rateWindowSeconds }
      );
    } catch (error) {
      logger.error(`[customer-email] rate limit lookup failed for ${code}: ${error?.name || 'error'}`);
      return res.status(503).json({
        success: false,
        handled: true,
        code: 'central_email_rate_limit_unavailable',
        message: 'Customer email rate limit is temporarily unavailable.',
      });
    }

    if (!limitState.allowed) {
      res.setHeader('Retry-After', String(limitState.retryAfter));
      return res.status(429).json({
        success: false,
        handled: true,
        code: 'central_email_rate_limited',
        message: 'Customer email rate limit exceeded.',
        retry_after_seconds: limitState.retryAfter,
      });
    }

    const result = await customerEmailService.send({
      restaurantCode: code,
      enabled: true,
      restaurantName,
      orderId: req.body?.order_id,
      type: req.body?.type,
      to: req.body?.to,
      replyTo: req.body?.reply_to,
      subject: req.body?.subject,
      html: req.body?.html,
      attachments: req.body?.attachments,
    });

    return res.status(result.status).json(result.body);
  };
}

module.exports = {
  ALLOWED_TYPES,
  DEFAULT_RATE_LIMIT,
  DEFAULT_RATE_WINDOW_SECONDS,
  DEFAULT_RESEND_TIMEOUT_MS,
  DEFAULT_INVOICE_RESEND_TIMEOUT_MS,
  MAX_ATTACHMENT_BYTES,
  createCustomerEmailRequestHandler,
  createCustomerEmailService,
  consumeRestaurantEmailRateLimit,
  normalizeAttachments,
  resolveResendTimeoutMs,
  safeDisplayName,
};
