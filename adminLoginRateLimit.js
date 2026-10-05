const crypto = require('crypto');

const ADMIN_LOGIN_LIMIT = 5;
const ADMIN_LOGIN_WINDOW_SECONDS = 15 * 60;

function adminLoginLimitKey(ip) {
  const normalized = String(ip || 'unknown').trim() || 'unknown';
  const hash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32);
  return `foodup:admin_login_limit:${hash}`;
}

async function adminLoginRateLimitState(redisCommand, ip, options = {}) {
  const limit = Math.max(1, Number(options.limit || ADMIN_LOGIN_LIMIT));
  const windowSeconds = Math.max(1, Number(options.windowSeconds || ADMIN_LOGIN_WINDOW_SECONDS));
  const key = adminLoginLimitKey(ip);
  const countResult = await redisCommand('GET', key);
  const failures = Math.max(0, Number(countResult.result || 0));
  let retryAfter = windowSeconds;
  if (failures >= limit) {
    const ttlResult = await redisCommand('TTL', key);
    retryAfter = Math.max(1, Number(ttlResult.result || 0)) || windowSeconds;
  }
  return {
    key,
    blocked: failures >= limit,
    failures,
    limit,
    retryAfter,
  };
}

async function recordAdminLoginFailure(redisCommand, ip, options = {}) {
  const limit = Math.max(1, Number(options.limit || ADMIN_LOGIN_LIMIT));
  const windowSeconds = Math.max(1, Number(options.windowSeconds || ADMIN_LOGIN_WINDOW_SECONDS));
  const key = adminLoginLimitKey(ip);

  const created = await redisCommand('SET', key, '1', 'EX', windowSeconds, 'NX');
  let failures = 1;
  if (created.result !== 'OK') {
    const incremented = await redisCommand('INCR', key);
    failures = Math.max(0, Number(incremented.result || 0));
    const ttlCheck = await redisCommand('TTL', key);
    if (Number(ttlCheck.result) < 0) await redisCommand('EXPIRE', key, windowSeconds);
  }

  const ttlResult = await redisCommand('TTL', key);
  const retryAfter = Math.max(1, Number(ttlResult.result || 0)) || windowSeconds;
  return {
    key,
    blocked: failures >= limit,
    failures,
    limit,
    retryAfter,
  };
}

async function clearAdminLoginFailures(redisCommand, ip) {
  await redisCommand('DEL', adminLoginLimitKey(ip));
}

module.exports = {
  ADMIN_LOGIN_LIMIT,
  ADMIN_LOGIN_WINDOW_SECONDS,
  adminLoginLimitKey,
  adminLoginRateLimitState,
  recordAdminLoginFailure,
  clearAdminLoginFailures,
};
