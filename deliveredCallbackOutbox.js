const DEFAULT_INTERVAL_MS = 10000;
const DEFAULT_CALLBACK_TIMEOUT_MS = 8000;
const DEFAULT_JOB_TTL_MS = 48 * 60 * 60 * 1000;
const DONE_TTL_SECONDS = 30 * 24 * 60 * 60;
const FAILED_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;
const MAX_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const GLOBAL_PENDING_RESTAURANTS_KEY = 'wp_delivered_callbacks_restaurants';
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 410, 422]);

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

function safeIso(ms) {
  return new Date(ms).toISOString();
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
  const failedSetKey = code => k(code, 'wp_delivered_callbacks_failed');
  const jobKey = (code, orderId) => k(code, `wp_delivered_callback:${orderId}`);
  const doneKey = (code, orderId) => k(code, `wp_delivered_callback_done:${orderId}`);
  const failedKey = (code, orderId) => k(code, `wp_delivered_callback_failed:${orderId}`);

  function normalizeJobTimes(job) {
    const out = { ...(job || {}) };
    const createdMs = Number(out.created_at_ms) || Date.parse(String(out.created_at || '')) || now();
    const expiresAtMs = Number(out.expires_at_ms) || (createdMs + DEFAULT_JOB_TTL_MS);
    out.created_at_ms = createdMs;
    out.created_at = out.created_at || safeIso(createdMs);
    out.expires_at_ms = expiresAtMs;
    if (!out.first_attempt_at && !Number(out.first_attempt_at_ms || 0) && Number(out.attempts || 0) > 0) {
      // Jobs created by the previous outbox version did not persist first_attempt_at.
      // Their first attempt happened immediately after enqueue, so created_at is the
      // safest conservative migration boundary for the new 24-hour retry window.
      out.first_attempt_at_ms = createdMs;
      out.first_attempt_at = out.created_at;
    }
    return out;
  }

  async function writeJob(code, orderId, job) {
    const normalized = normalizeJobTimes(job);
    const remainingMs = Math.max(0, Number(normalized.expires_at_ms || 0) - now());
    if (remainingMs <= 0) return false;
    const ttlSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    await redisCommand('SET', jobKey(code, orderId), JSON.stringify(normalized), 'EX', ttlSeconds);
    return true;
  }

  async function addPendingReference(code, orderId) {
    await redisCommand('SADD', pendingSetKey(code), orderId);
    await redisCommand('SADD', GLOBAL_PENDING_RESTAURANTS_KEY, code);
  }

  async function removePendingReference(code, orderId) {
    await redisCommand('SREM', pendingSetKey(code), orderId);
    const count = await redisCommand('SCARD', pendingSetKey(code));
    if (Number(count.result || 0) === 0) {
      await redisCommand('SREM', GLOBAL_PENDING_RESTAURANTS_KEY, code);
    }
  }

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
      const createdMs = now();
      job = {
        restaurant_code: code,
        order_id: orderId,
        delivery_name: String(delivery_name || ''),
        delivered_at: String(delivered_at || ''),
        attempts: 0,
        created_at: safeIso(createdMs),
        created_at_ms: createdMs,
        expires_at_ms: createdMs + DEFAULT_JOB_TTL_MS,
        next_attempt_at: createdMs,
      };
    } else {
      job = normalizeJobTimes(job);
      if (delivery_name) job.delivery_name = String(delivery_name);
      if (delivered_at) job.delivered_at = String(delivered_at);
      if (!Number.isFinite(Number(job.next_attempt_at))) job.next_attempt_at = now();
    }

    if (!(await writeJob(code, orderId, job))) return false;
    await addPendingReference(code, orderId);
    return true;
  }

  async function deadLetter(code, orderId, job, reason, { incrementAttempt = false } = {}) {
    const current = normalizeJobTimes(job);
    const attemptTime = now();
    const attempts = Math.max(0, Number(current.attempts || 0)) + (incrementAttempt ? 1 : 0);
    const failure = {
      restaurant_code: code,
      order_id: orderId,
      delivery_name: String(current.delivery_name || ''),
      delivered_at: String(current.delivered_at || ''),
      reason: String(reason || 'callback_failed').slice(0, 240),
      attempts,
      created_at: current.created_at || safeIso(current.created_at_ms || attemptTime),
      first_attempt_at: current.first_attempt_at || null,
      last_attempt_at: incrementAttempt ? safeIso(attemptTime) : (current.last_attempt_at || null),
      failed_at: safeIso(attemptTime),
    };

    const existing = await redisCommand('GET', failedKey(code, orderId));
    await redisCommand('SET', failedKey(code, orderId), JSON.stringify(failure), 'EX', FAILED_TTL_SECONDS);
    await redisCommand('SADD', failedSetKey(code), orderId);
    await redisCommand('DEL', jobKey(code, orderId));
    await removePendingReference(code, orderId);

    if (!existing.result) {
      logger.error?.(`[delivered-callback] dead-letter ${code}/${orderId} after ${attempts} attempt(s): ${failure.reason}`);
    }
    return failure;
  }

  async function scheduleRetry(code, orderId, job, reason) {
    const attemptTime = now();
    const current = normalizeJobTimes(job);
    const attempts = Math.max(0, Number(current.attempts || 0)) + 1;
    const firstAttemptMs = Number(current.first_attempt_at_ms) || Date.parse(String(current.first_attempt_at || '')) || attemptTime;
    const deadline = firstAttemptMs + MAX_RETRY_WINDOW_MS;
    const updated = {
      ...current,
      attempts,
      first_attempt_at_ms: firstAttemptMs,
      first_attempt_at: current.first_attempt_at || safeIso(firstAttemptMs),
      last_error: String(reason || 'callback_failed').slice(0, 240),
      last_attempt_at: safeIso(attemptTime),
      next_attempt_at: Math.min(attemptTime + retryDelayMs(attempts), deadline),
    };

    if (attemptTime >= deadline) {
      return deadLetter(code, orderId, updated, `retry_window_expired:${updated.last_error}`);
    }

    if (!(await writeJob(code, orderId, updated))) {
      return deadLetter(code, orderId, updated, `job_ttl_expired:${updated.last_error}`);
    }
    await addPendingReference(code, orderId);
    logger.warn?.(`[delivered-callback] retry ${code}/${orderId} attempt ${attempts}: ${updated.last_error}`);
    return updated;
  }

  async function markDone(code, orderId) {
    await redisCommand('DEL', jobKey(code, orderId));
    await removePendingReference(code, orderId);
    await redisCommand('SET', doneKey(code, orderId), 'yes', 'EX', DONE_TTL_SECONDS);
  }

  function classifyResponseFailure(status, result) {
    const numericStatus = Number(status || 0);
    const code = String(result?.code || '').trim();
    if (code === 'callback_auth_recovery_required') {
      return { temporary: true, reason: code };
    }
    if (PERMANENT_HTTP_STATUSES.has(numericStatus)) {
      return { temporary: false, reason: `wordpress_http_${numericStatus}` };
    }
    if (numericStatus === 408 || numericStatus === 429 || numericStatus >= 500) {
      return { temporary: true, reason: `wordpress_http_${numericStatus}` };
    }
    return {
      temporary: true,
      reason: code ? `wordpress_${code}` : `wordpress_http_${numericStatus || 0}`,
    };
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
        await redisCommand('DEL', jobKey(code, orderId));
        await removePendingReference(code, orderId);
        return true;
      }

      const stored = await redisCommand('GET', jobKey(code, orderId));
      if (!stored.result) {
        await removePendingReference(code, orderId);
        return false;
      }

      let job;
      try { job = JSON.parse(stored.result); } catch (_) { job = null; }
      if (!job || typeof job !== 'object') {
        await redisCommand('DEL', jobKey(code, orderId));
        await removePendingReference(code, orderId);
        logger.error?.(`[delivered-callback] invalid job removed for ${code}/${orderId}`);
        return false;
      }
      job = normalizeJobTimes(job);

      if (Number(job.next_attempt_at || 0) > now()) return false;

      const existingFirstAttemptMs = Number(job.first_attempt_at_ms) || Date.parse(String(job.first_attempt_at || '')) || 0;
      if (existingFirstAttemptMs && now() >= existingFirstAttemptMs + MAX_RETRY_WINDOW_MS) {
        await deadLetter(code, orderId, job, `retry_window_expired:${String(job.last_error || 'temporary_failure')}`);
        return false;
      }

      if (!existingFirstAttemptMs) {
        const firstAttemptMs = now();
        job.first_attempt_at_ms = firstAttemptMs;
        job.first_attempt_at = safeIso(firstAttemptMs);
        if (!(await writeJob(code, orderId, job))) {
          await deadLetter(code, orderId, job, 'job_ttl_expired_before_first_attempt');
          return false;
        }
      }

      const profileData = await redisCommand('GET', k(code, 'restaurant_profile'));
      let profile = null;
      try { profile = profileData.result ? JSON.parse(profileData.result) : null; } catch (_) {}
      const baseUrl = baseUrlFromProfile(profile);
      if (!baseUrl) {
        await deadLetter(code, orderId, job, 'restaurant_website_missing', { incrementAttempt: true });
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
        if (response.ok && result?.success === true) {
          await markDone(code, orderId);
          logger.log?.(`[delivered-callback] confirmed ${code}/${orderId}`);
          return true;
        }

        const failure = classifyResponseFailure(response.status, result);
        if (failure.temporary) {
          await scheduleRetry(code, orderId, job, failure.reason);
        } else {
          await deadLetter(code, orderId, job, failure.reason, { incrementAttempt: true });
        }
        return false;
      } catch (error) {
        const reason = error?.name === 'AbortError'
          ? 'wordpress_timeout'
          : (error?.code || error?.message || 'wordpress_request_failed');
        await scheduleRetry(code, orderId, job, reason);
        return false;
      } finally {
        clearTimeoutImpl(timeout);
      }
    } finally {
      inFlight.delete(flightKey);
    }
  }

  async function listFailed(codeValue, limit = 50) {
    const code = normalizeCode(codeValue);
    if (!code) return [];
    const idsResult = await redisCommand('SMEMBERS', failedSetKey(code));
    const ids = (idsResult.result || []).map(normalizeOrderId).filter(Boolean);
    if (!ids.length) return [];

    const selected = ids.slice(0, Math.max(1, Number(limit || 50)));
    const values = await redisCommand('MGET', ...selected.map(orderId => failedKey(code, orderId)));
    const failed = [];
    const stale = [];
    (values.result || []).forEach((raw, index) => {
      if (!raw) {
        stale.push(selected[index]);
        return;
      }
      try {
        const record = JSON.parse(raw);
        if (record && typeof record === 'object') failed.push(record);
      } catch (_) {
        stale.push(selected[index]);
      }
    });
    for (const orderId of stale) {
      await redisCommand('SREM', failedSetKey(code), orderId);
    }
    failed.sort((a, b) => Date.parse(String(b.failed_at || '')) - Date.parse(String(a.failed_at || '')));
    return failed;
  }

  async function retryFailed(codeValue, orderIdValue) {
    const code = normalizeCode(codeValue);
    const orderId = normalizeOrderId(orderIdValue);
    if (!code || !orderId) return { ok: false, reason: 'invalid_request' };

    const done = await redisCommand('GET', doneKey(code, orderId));
    if (done.result) {
      await redisCommand('DEL', failedKey(code, orderId));
      await redisCommand('SREM', failedSetKey(code), orderId);
      return { ok: false, reason: 'already_done' };
    }

    const failedRaw = await redisCommand('GET', failedKey(code, orderId));
    if (!failedRaw.result) {
      await redisCommand('SREM', failedSetKey(code), orderId);
      return { ok: false, reason: 'not_found' };
    }

    let failed;
    try { failed = JSON.parse(failedRaw.result); } catch (_) { failed = null; }
    if (!failed || typeof failed !== 'object') {
      await redisCommand('DEL', failedKey(code, orderId));
      await redisCommand('SREM', failedSetKey(code), orderId);
      return { ok: false, reason: 'invalid_failed_record' };
    }

    const createdMs = now();
    const job = {
      restaurant_code: code,
      order_id: orderId,
      delivery_name: String(failed.delivery_name || ''),
      delivered_at: String(failed.delivered_at || ''),
      attempts: 0,
      created_at: safeIso(createdMs),
      created_at_ms: createdMs,
      expires_at_ms: createdMs + DEFAULT_JOB_TTL_MS,
      next_attempt_at: createdMs,
      manual_retry_of_attempts: Math.max(0, Number(failed.attempts || 0)),
    };

    await writeJob(code, orderId, job);
    await addPendingReference(code, orderId);
    await redisCommand('DEL', failedKey(code, orderId));
    await redisCommand('SREM', failedSetKey(code), orderId);
    logger.log?.(`[delivered-callback] admin retry queued ${code}/${orderId}`);
    return { ok: true, job };
  }

  async function bootstrapPendingRestaurantIndex() {
    const restaurants = await redisCommand('SMEMBERS', 'restaurants');
    for (const codeValue of (restaurants.result || [])) {
      const code = normalizeCode(codeValue);
      if (!code) continue;
      const count = await redisCommand('SCARD', pendingSetKey(code));
      if (Number(count.result || 0) > 0) {
        await redisCommand('SADD', GLOBAL_PENDING_RESTAURANTS_KEY, code);
      }
    }
  }

  async function tick() {
    if (tickRunning) return;
    tickRunning = true;
    try {
      const restaurants = await redisCommand('SMEMBERS', GLOBAL_PENDING_RESTAURANTS_KEY);
      for (const code of (restaurants.result || [])) {
        const pending = await redisCommand('SMEMBERS', pendingSetKey(code));
        const orderIds = pending.result || [];
        if (!orderIds.length) {
          await redisCommand('SREM', GLOBAL_PENDING_RESTAURANTS_KEY, code);
          continue;
        }
        for (const orderId of orderIds.slice(0, 25)) {
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
    bootstrapPendingRestaurantIndex().catch(error => {
      logger.error?.(`[delivered-callback] pending-index bootstrap failed: ${error?.message || error}`);
    });
    interval = setIntervalImpl(() => {
      tick().catch(error => logger.error?.(`[delivered-callback] tick failed: ${error?.message || error}`));
    }, intervalMs);
    if (interval && typeof interval.unref === 'function') interval.unref();
    return interval;
  }

  return {
    enqueue,
    processOne,
    listFailed,
    retryFailed,
    bootstrapPendingRestaurantIndex,
    tick,
    kick,
    start,
    retryDelayMs,
  };
}

module.exports = {
  createDeliveredCallbackOutbox,
  retryDelayMs,
  baseUrlFromProfile,
  GLOBAL_PENDING_RESTAURANTS_KEY,
  MAX_RETRY_WINDOW_MS,
};
