const DEFAULT_INTERVAL_MS = 10000;
const DEFAULT_CALLBACK_TIMEOUT_MS = 8000;
const DEFAULT_JOB_TTL_SECONDS = 48 * 60 * 60;
const DONE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;

function normalizeCode(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeOrderId(value) {
  return String(value || '').trim();
}

function baseUrlFromProfile(profile) {
  const website = String(profile?.website || '').trim();
  if (!website) return '';
  return website.startsWith('http://') || website.startsWith('https://')
    ? website.replace(/\/+$/, '')
    : `https://${website.replace(/\/+$/, '')}`;
}

function retryDelayMs(attempts) {
  const safeAttempts = Math.max(1, Number(attempts || 1));
  return Math.min(MAX_RETRY_DELAY_MS, 10000 * (2 ** Math.min(safeAttempts - 1, 12)));
}

function createDeliveredCallbackOutbox({
  redisCommand,
  k,
  fetchWordPress,
  logger = console,
  now = () => Date.now(),
  callbackTimeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  setIntervalImpl = setInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  if (typeof redisCommand !== 'function' || typeof k !== 'function' || typeof fetchWordPress !== 'function') {
    throw new Error('Delivered callback outbox requires Redis, key helper and WordPress fetch.');
  }

  const inFlight = new Set();
  let tickRunning = false;
  let interval = null;

  const pendingSetKey = code => k(code, 'wp_delivered_callbacks_pending');
  const jobKey = (code, orderId) => k(code, `wp_delivered_callback:${orderId}`);
  const doneKey = (code, orderId) => k(code, `wp_delivered_callback_done:${orderId}`);

  async function enqueue({ restaurant_code, order_id, delivery_name = '', delivered_at = '' }) {
    const code = normalizeCode(restaurant_code);
    const orderId = normalizeOrderId(order_id);
    if (!code || !orderId) return false;

    const done = await redisCommand('GET', doneKey(code, orderId));
    if (done.result) return false;

    const existing = await redisCommand('GET', jobKey(code, orderId));
    let job;
    if (existing.result) {
      try { job = JSON.parse(existing.result); } catch (_) { job = null; }
    }

    if (!job || typeof job !== 'object') {
      job = {
        restaurant_code: code,
        order_id: orderId,
        delivery_name: String(delivery_name || ''),
        delivered_at: String(delivered_at || ''),
        attempts: 0,
        created_at: new Date(now()).toISOString(),
        next_attempt_at: now(),
      };
    } else {
      if (delivery_name) job.delivery_name = String(delivery_name);
      if (delivered_at) job.delivered_at = String(delivered_at);
      if (!Number.isFinite(Number(job.next_attempt_at))) job.next_attempt_at = now();
    }

    await redisCommand('SET', jobKey(code, orderId), JSON.stringify(job), 'EX', DEFAULT_JOB_TTL_SECONDS);
    await redisCommand('SADD', pendingSetKey(code), orderId);
    return true;
  }

  async function scheduleRetry(code, orderId, job, reason) {
    const attempts = Math.max(0, Number(job.attempts || 0)) + 1;
    const updated = {
      ...job,
      attempts,
      last_error: String(reason || 'callback_failed').slice(0, 240),
      last_attempt_at: new Date(now()).toISOString(),
      next_attempt_at: now() + retryDelayMs(attempts),
    };
    await redisCommand('SET', jobKey(code, orderId), JSON.stringify(updated), 'EX', DEFAULT_JOB_TTL_SECONDS);
    await redisCommand('SADD', pendingSetKey(code), orderId);
    logger.warn?.(`[delivered-callback] retry ${code}/${orderId} attempt ${attempts}: ${updated.last_error}`);
  }

  async function markDone(code, orderId) {
    await redisCommand('DEL', jobKey(code, orderId));
    await redisCommand('SREM', pendingSetKey(code), orderId);
    await redisCommand('SET', doneKey(code, orderId), 'yes', 'EX', DONE_TTL_SECONDS);
  }

  async function processOne(codeValue, orderIdValue) {
    const code = normalizeCode(codeValue);
    const orderId = normalizeOrderId(orderIdValue);
    if (!code || !orderId) return false;

    const flightKey = `${code}:${orderId}`;
    if (inFlight.has(flightKey)) return false;
    inFlight.add(flightKey);

    try {
      const done = await redisCommand('GET', doneKey(code, orderId));
      if (done.result) {
        await redisCommand('SREM', pendingSetKey(code), orderId);
        await redisCommand('DEL', jobKey(code, orderId));
        return true;
      }

      const stored = await redisCommand('GET', jobKey(code, orderId));
      if (!stored.result) {
        await redisCommand('SREM', pendingSetKey(code), orderId);
        return false;
      }

      let job;
      try { job = JSON.parse(stored.result); } catch (_) { job = null; }
      if (!job || typeof job !== 'object') {
        await redisCommand('SREM', pendingSetKey(code), orderId);
        await redisCommand('DEL', jobKey(code, orderId));
        logger.error?.(`[delivered-callback] invalid job removed for ${code}/${orderId}`);
        return false;
      }

      if (Number(job.next_attempt_at || 0) > now()) return false;

      const profileData = await redisCommand('GET', k(code, 'restaurant_profile'));
      let profile = null;
      try { profile = profileData.result ? JSON.parse(profileData.result) : null; } catch (_) {}
      const baseUrl = baseUrlFromProfile(profile);
      if (!baseUrl) {
        await scheduleRetry(code, orderId, job, 'restaurant_website_missing');
        return false;
      }

      const controller = new AbortController();
      const timeout = setTimeoutImpl(() => controller.abort(), callbackTimeoutMs);
      try {
        const response = await fetchWordPress(
          code,
          `${baseUrl}/wp-json/foodup/v1/order-delivered`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              order_id: Number.isFinite(Number(orderId)) ? Number(orderId) : orderId,
              delivery_name: String(job.delivery_name || ''),
              delivered_at: String(job.delivered_at || ''),
            }),
            signal: controller.signal,
          }
        );

        const result = await response.json().catch(() => ({}));
        if (!response.ok || result?.success !== true) {
          await scheduleRetry(code, orderId, job, `wordpress_http_${response.status || 0}`);
          return false;
        }

        await markDone(code, orderId);
        logger.log?.(`[delivered-callback] confirmed ${code}/${orderId}`);
        return true;
      } catch (error) {
        const reason = error?.name === 'AbortError' ? 'wordpress_timeout' : (error?.code || error?.message || 'wordpress_request_failed');
        await scheduleRetry(code, orderId, job, reason);
        return false;
      } finally {
        clearTimeoutImpl(timeout);
      }
    } finally {
      inFlight.delete(flightKey);
    }
  }

  async function tick() {
    if (tickRunning) return;
    tickRunning = true;
    try {
      const restaurants = await redisCommand('SMEMBERS', 'restaurants');
      for (const code of (restaurants.result || [])) {
        const pending = await redisCommand('SMEMBERS', pendingSetKey(code));
        for (const orderId of (pending.result || []).slice(0, 25)) {
          await processOne(code, orderId);
        }
      }
    } catch (error) {
      logger.error?.(`[delivered-callback] worker error: ${error?.message || error}`);
    } finally {
      tickRunning = false;
    }
  }

  function kick(code, orderId) {
    const timer = setTimeoutImpl(() => {
      processOne(code, orderId).catch(error => {
        logger.error?.(`[delivered-callback] kick failed ${normalizeCode(code)}/${normalizeOrderId(orderId)}: ${error?.message || error}`);
      });
    }, 0);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    if (interval) return interval;
    interval = setIntervalImpl(() => {
      tick().catch(error => logger.error?.(`[delivered-callback] tick failed: ${error?.message || error}`));
    }, intervalMs);
    if (interval && typeof interval.unref === 'function') interval.unref();
    return interval;
  }

  return { enqueue, processOne, tick, kick, start, retryDelayMs };
}

module.exports = { createDeliveredCallbackOutbox, retryDelayMs, baseUrlFromProfile };
