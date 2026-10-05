const crypto = require('crypto');

class RestaurantSecretDecryptionError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'RestaurantSecretDecryptionError';
    this.code = 'FOODUP_SECRET_DECRYPT_FAILED';
    if (cause) this.cause = cause;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function envBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || String(value).trim() === '') return Boolean(defaultValue);
  return !['0', 'false', 'no', 'off', 'disabled'].includes(String(value).trim().toLowerCase());
}

function clientIpFromRequest(req) {
  const expressIp = String(req?.ip || '').trim();
  if (expressIp) return expressIp;

  const forwarded = String(req?.headers?.['x-forwarded-for'] || '');
  const forwardedParts = forwarded
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  if (forwardedParts.length > 0) return forwardedParts[forwardedParts.length - 1];

  return String(req?.socket?.remoteAddress || 'unknown').trim() || 'unknown';
}

function createRestaurantSecurity({ redisCommand, k, env = process.env, now = () => Date.now(), randomBytes = crypto.randomBytes, logger = console }) {
  if (typeof redisCommand !== 'function' || typeof k !== 'function') {
    throw new Error('Restaurant security requires Redis and key helpers.');
  }

  function encryptionKey() {
    const raw = String(env.FOODUP_SECRET_ENCRYPTION_KEY || '').trim();
    if (!raw) throw new Error('Restaurant secret encryption is not configured.');

    const candidates = [];
    try { candidates.push(Buffer.from(raw, 'base64')); } catch (_) {}
    if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
      try { candidates.push(Buffer.from(raw, 'hex')); } catch (_) {}
    }

    const key = candidates.find(candidate => candidate.length === 32);
    if (!key) throw new Error('Restaurant secret encryption key must decode to 32 bytes.');
    return key;
  }

  function encryptionConfigured() {
    try { encryptionKey(); return true; } catch (_) { return false; }
  }

  function isAcceptableRestaurantSecret(secret) {
    const value = String(secret || '').trim();
    return value.length >= 32 && value.length <= 512;
  }

  function encryptSecret(secret) {
    const value = String(secret || '');
    if (!value) return '';
    const iv = randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: ciphertext.toString('base64'),
    });
  }

  function decryptSecret(payload) {
    if (!payload) return '';
    let parsed;
    try { parsed = typeof payload === 'string' ? JSON.parse(payload) : payload; }
    catch (_) { throw new Error('Stored restaurant secret is invalid.'); }
    if (!parsed || parsed.v !== 1 || !parsed.iv || !parsed.tag || !parsed.data) {
      throw new Error('Stored restaurant secret is invalid.');
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(parsed.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  function isSecretDecryptionError(error) {
    return Boolean(error && error.code === 'FOODUP_SECRET_DECRYPT_FAILED');
  }

  async function getStoredRestaurantSecret(code) {
    const data = await redisCommand('GET', k(code, 'callback_secret_enc'));
    if (!data.result) return '';
    try {
      return decryptSecret(data.result);
    } catch (error) {
      if (isSecretDecryptionError(error)) throw error;
      throw new RestaurantSecretDecryptionError('Stored restaurant secret could not be decrypted.', error);
    }
  }

  async function setStoredRestaurantSecret(code, secret) {
    const value = String(secret || '').trim();
    if (!isAcceptableRestaurantSecret(value)) throw new Error('Restaurant secret does not meet the required format.');
    await redisCommand('SET', k(code, 'callback_secret_enc'), encryptSecret(value));
  }

  async function resetStoredRestaurantSecret(code) {
    const normalizedCode = String(code || '').trim().toLowerCase();
    if (!normalizedCode) throw new Error('Restaurant code is required.');
    await redisCommand('DEL', k(normalizedCode, 'callback_secret_enc'));
    return true;
  }

  function legacySharedSecret() {
    return String(env.FOODUP_LEGACY_SHARED_SECRET || '').trim();
  }

  function globalLegacyAppAccessEnabled() {
    return envBoolean(env.FOODUP_LEGACY_APP_ACCESS_ENABLED, true);
  }

  async function getLegacyAppAccessState(code) {
    const normalizedCode = String(code || '').trim().toLowerCase();
    const globalEnabled = globalLegacyAppAccessEnabled();
    if (!normalizedCode) return { enabled: false, globalEnabled, override: null };
    const data = await redisCommand('GET', k(normalizedCode, 'legacy_app_access_enabled'));
    let override = null;
    if (data.result !== null && data.result !== undefined) {
      override = envBoolean(data.result, true);
    }
    return {
      enabled: globalEnabled && override !== false,
      globalEnabled,
      override,
    };
  }

  async function setLegacyAppAccess(code, enabled) {
    const normalizedCode = String(code || '').trim().toLowerCase();
    if (!normalizedCode) throw new Error('Restaurant code is required.');
    await redisCommand('SET', k(normalizedCode, 'legacy_app_access_enabled'), enabled ? '1' : '0');
    return getLegacyAppAccessState(normalizedCode);
  }

  async function recordLegacyUse(code, kind, metadata = {}) {
    const normalizedCode = String(code || '').trim().toLowerCase();
    if (!normalizedCode) return;
    const safeKind = String(kind || 'unknown').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 40) || 'unknown';
    const entry = {
      restaurant_code: normalizedCode,
      kind: safeKind,
      method: String(metadata.method || '').slice(0, 12),
      path: String(metadata.path || '').slice(0, 160),
      client: String(metadata.client || '').slice(0, 40),
      last_seen: new Date(now()).toISOString(),
    };
    await redisCommand('SET', k(normalizedCode, `legacy_${safeKind}_last_seen`), JSON.stringify(entry));
  }

  async function authorizeWordPress(code, providedSecret, client = '') {
    const normalizedCode = String(code || '').trim().toLowerCase();
    const normalizedClient = String(client || '').trim().toLowerCase();
    let stored = '';
    try {
      stored = await getStoredRestaurantSecret(normalizedCode);
    } catch (error) {
      if (!isSecretDecryptionError(error)) throw error;
      const legacyState = await getLegacyAppAccessState(normalizedCode);
      logger.error?.(`[security] restaurant secret decryption failed for ${normalizedCode}; WordPress authentication ${legacyState.enabled ? 'accepted in transition compatibility mode' : 'rejected because legacy access is disabled'}.`);
      if (legacyState.enabled) {
        return {
          ok: true,
          source: 'decrypt_error_compat',
          hasRestaurantSecret: true,
          legacy: true,
          decryption_error: true,
        };
      }
      return {
        ok: false,
        source: 'decrypt_error',
        hasRestaurantSecret: true,
        legacy: false,
        decryption_error: true,
      };
    }

    if (!stored) {
      return {
        ok: true,
        source: 'pre_migration_compat',
        hasRestaurantSecret: false,
        legacy: true,
      };
    }

    if (normalizedClient === 'wordpress' && safeEqual(stored, providedSecret)) {
      return { ok: true, source: 'restaurant', hasRestaurantSecret: true, legacy: false };
    }

    const legacyState = await getLegacyAppAccessState(normalizedCode);
    if (legacyState.enabled) {
      return { ok: true, source: 'legacy_compat', hasRestaurantSecret: true, legacy: true };
    }

    return { ok: false, source: 'restaurant', hasRestaurantSecret: true, legacy: false };
  }

  async function isStrictWordPressProof(code, providedSecret, client = '') {
    const normalizedCode = String(code || '').trim().toLowerCase();
    if (String(client || '').trim().toLowerCase() !== 'wordpress') return false;
    try {
      const stored = await getStoredRestaurantSecret(normalizedCode);
      return Boolean(stored) && safeEqual(stored, providedSecret);
    } catch (error) {
      if (isSecretDecryptionError(error)) return false;
      throw error;
    }
  }

  async function profileAuthorization({ code, providedSecret, callbackSecret, ownerPinValid, client = '' }) {
    const normalizedCode = String(code || '').trim().toLowerCase();
    const normalizedClient = String(client || '').trim().toLowerCase();
    let stored = '';
    try {
      stored = await getStoredRestaurantSecret(normalizedCode);
    } catch (error) {
      if (!isSecretDecryptionError(error)) throw error;
      const legacyState = await getLegacyAppAccessState(normalizedCode);
      logger.error?.(`[security] restaurant secret decryption failed for ${normalizedCode}; profile secret changes require admin reset before migration can resume.`);
      if (!legacyState.enabled) {
        return { ok: false, mode: 'secret_recovery_required', canEstablishSecret: false, canUpdateProtectedProfile: false, canUpdateWebsite: false, decryption_error: true };
      }
      if (callbackSecret) {
        return { ok: false, mode: 'secret_recovery_required', canEstablishSecret: false, canUpdateProtectedProfile: false, canUpdateWebsite: false, decryption_error: true };
      }
      if (ownerPinValid) {
        return { ok: true, mode: 'legacy_profile', canEstablishSecret: false, canUpdateProtectedProfile: true, canUpdateWebsite: false, decryption_error: true };
      }
      return { ok: true, mode: 'logo_only', canEstablishSecret: false, canUpdateProtectedProfile: false, canUpdateWebsite: false, decryption_error: true };
    }

    if (stored) {
      const strictProof = normalizedClient === 'wordpress' && safeEqual(stored, providedSecret);
      if (strictProof) {
        return {
          ok: true,
          mode: safeEqual(stored, callbackSecret) ? 'normal' : 'rotation',
          canEstablishSecret: Boolean(callbackSecret),
          canUpdateProtectedProfile: true,
          canUpdateWebsite: true,
        };
      }

      // Never rotate or replace an established secret without proof of the
      // currently stored secret, even while legacy compatibility is enabled.
      if (callbackSecret) {
        return { ok: false, mode: 'unauthorized', canEstablishSecret: false, canUpdateProtectedProfile: false, canUpdateWebsite: false };
      }

      const legacyState = await getLegacyAppAccessState(normalizedCode);
      if (!legacyState.enabled) {
        return { ok: false, mode: 'unauthorized', canEstablishSecret: false, canUpdateProtectedProfile: false, canUpdateWebsite: false };
      }

      if (ownerPinValid) {
        return {
          ok: true,
          mode: 'legacy_profile',
          canEstablishSecret: false,
          canUpdateProtectedProfile: true,
          canUpdateWebsite: false,
        };
      }

      return {
        ok: true,
        mode: 'logo_only',
        canEstablishSecret: false,
        canUpdateProtectedProfile: false,
        canUpdateWebsite: false,
      };
    }

    if (ownerPinValid) {
      return {
        ok: true,
        mode: 'first_migration',
        canEstablishSecret: Boolean(callbackSecret),
        canUpdateProtectedProfile: true,
        canUpdateWebsite: false,
      };
    }

    return {
      ok: true,
      mode: 'logo_only',
      canEstablishSecret: false,
      canUpdateProtectedProfile: false,
      canUpdateWebsite: false,
    };
  }

  function normalizeRateLimitPart(value, fallback = 'unknown') {
    const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 80);
    return normalized || fallback;
  }

  function pinRateLimitKeys({ action, code, ip }) {
    const safeAction = normalizeRateLimitPart(action, 'pin');
    const safeCode = normalizeRateLimitPart(code, 'unknown_restaurant');
    const ipHash = sha256(String(ip || 'unknown')).slice(0, 32);
    return {
      restaurant: `foodup:pin_limit:${safeAction}:restaurant:${safeCode}`,
      ip: `foodup:pin_limit:${safeAction}:ip:${ipHash}`,
    };
  }

  async function readPinLimitCounter(key, threshold, windowSeconds) {
    const countResult = await redisCommand('GET', key);
    const failures = Math.max(0, Number(countResult.result || 0));
    let secondsLeft = windowSeconds;
    if (failures >= threshold) {
      const ttlResult = await redisCommand('TTL', key);
      secondsLeft = Math.max(0, Number(ttlResult.result || 0)) || windowSeconds;
    }
    return {
      failures,
      threshold,
      blocked: failures >= threshold,
      attemptsLeft: Math.max(0, threshold - failures),
      secondsLeft,
    };
  }

  async function incrementPinLimitCounter(key, threshold, windowSeconds) {
    const created = await redisCommand('SET', key, '1', 'EX', windowSeconds, 'NX');
    let failures = 1;
    if (created.result !== 'OK') {
      const incremented = await redisCommand('INCR', key);
      failures = Math.max(0, Number(incremented.result || 0));
      const ttlCheck = await redisCommand('TTL', key);
      if (Number(ttlCheck.result) < 0) await redisCommand('EXPIRE', key, windowSeconds);
    }
    const ttlResult = await redisCommand('TTL', key);
    const secondsLeft = Math.max(0, Number(ttlResult.result || 0)) || windowSeconds;
    return {
      failures,
      threshold,
      blocked: failures >= threshold,
      attemptsLeft: Math.max(0, threshold - failures),
      secondsLeft,
    };
  }

  function combinePinLimitState(ipState, restaurantState, windowSeconds) {
    const blocked = ipState.blocked || restaurantState.blocked;
    const blockingSeconds = [
      ipState.blocked ? ipState.secondsLeft : 0,
      restaurantState.blocked ? restaurantState.secondsLeft : 0,
    ];
    const secondsLeft = Math.max(...blockingSeconds, 0) || windowSeconds;
    return {
      allowed: !blocked,
      blocked,
      failures: Math.max(ipState.failures, restaurantState.failures),
      ipFailures: ipState.failures,
      restaurantFailures: restaurantState.failures,
      ipThreshold: ipState.threshold,
      restaurantThreshold: restaurantState.threshold,
      attemptsLeft: Math.min(ipState.attemptsLeft, restaurantState.attemptsLeft),
      secondsLeft,
      minutesLeft: Math.max(1, Math.ceil(secondsLeft / 60)),
    };
  }

  async function pinAttemptRateLimitState({
    action,
    code,
    ip,
    ipMaxFailures = 5,
    restaurantMaxFailures = 20,
    windowSeconds = 15 * 60,
  }) {
    const keys = pinRateLimitKeys({ action, code, ip });
    const [ipState, restaurantState] = await Promise.all([
      readPinLimitCounter(keys.ip, ipMaxFailures, windowSeconds),
      readPinLimitCounter(keys.restaurant, restaurantMaxFailures, windowSeconds),
    ]);
    return combinePinLimitState(ipState, restaurantState, windowSeconds);
  }

  async function recordPinFailure({
    action,
    code,
    ip,
    ipMaxFailures = 5,
    restaurantMaxFailures = 20,
    windowSeconds = 15 * 60,
  }) {
    const keys = pinRateLimitKeys({ action, code, ip });
    const [ipState, restaurantState] = await Promise.all([
      incrementPinLimitCounter(keys.ip, ipMaxFailures, windowSeconds),
      incrementPinLimitCounter(keys.restaurant, restaurantMaxFailures, windowSeconds),
    ]);
    return combinePinLimitState(ipState, restaurantState, windowSeconds);
  }

  async function clearPinFailures({ action, code, ip }) {
    const keys = pinRateLimitKeys({ action, code, ip });
    await redisCommand('DEL', keys.ip, keys.restaurant);
  }

  function websiteProductsUrl(website) {
    const raw = String(website || '').trim();
    if (!raw) return '';
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(withScheme);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported website protocol.');
    return new URL('/wp-json/foodup/v1/products', parsed).toString();
  }

  function profileWebsitePolicy({ decision, currentWebsite, requestedWebsite, callbackSecret }) {
    const current = String(currentWebsite || '').trim();
    const requestedWasSupplied = requestedWebsite !== undefined;
    const requested = requestedWasSupplied ? String(requestedWebsite || '').trim() : '';
    const comparable = value => String(value || '').trim().replace(/\/+$/, '').toLowerCase();
    const changeRequested = requestedWasSupplied && comparable(requested) !== comparable(current);
    const firstMigrationWithCandidate = decision?.mode === 'first_migration'
      && Boolean(decision?.canEstablishSecret)
      && Boolean(String(callbackSecret || '').trim());
    const mayUseBrandNewWebsite = firstMigrationWithCandidate && !current && Boolean(requested);
    return {
      changeRequested,
      mayUseBrandNewWebsite,
      allowed: !changeRequested || Boolean(decision?.canUpdateWebsite) || mayUseBrandNewWebsite,
      verificationWebsite: current || (mayUseBrandNewWebsite ? requested : ''),
    };
  }

  async function verifyRestaurantSecretAgainstWebsite(website, callbackSecret, fetchImpl = global.fetch) {
    if (!isAcceptableRestaurantSecret(callbackSecret)) {
      return { ok: false, status: 0, reason: 'invalid_callback_secret' };
    }
    let url;
    try { url = websiteProductsUrl(website); }
    catch (_) { return { ok: false, status: 0, reason: 'invalid_website' }; }
    if (!url) return { ok: false, status: 0, reason: 'missing_website' };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'x-foodup-secret': String(callbackSecret || '').trim(),
          'X-FoodUp-Client': 'backend',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
      return {
        ok: Number(response?.status || 0) === 200,
        status: Number(response?.status || 0),
        reason: Number(response?.status || 0) === 200 ? 'verified' : 'wordpress_rejected_secret',
      };
    } catch (error) {
      logger.error?.(`[security] restaurant secret website verification request failed: ${error?.name || error?.code || 'error'}`);
      return { ok: false, status: 0, reason: 'website_verification_request_failed' };
    } finally {
      clearTimeout(timeout);
    }
  }

  function configuredDefaultPinHashes() {
    return String(env.FOODUP_DEFAULT_PIN_HASHES || '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(value => /^[0-9a-f]{64}$/.test(value));
  }

  function defaultPinProtectionConfigured() {
    return configuredDefaultPinHashes().length > 0;
  }

  function isKnownDefaultPin(pin) {
    const digest = sha256(pin);
    return configuredDefaultPinHashes().some(hash => safeEqual(hash, digest));
  }

  function evaluatePinLogin(pin) {
    return {
      allowed: true,
      pinPolicyConfigured: defaultPinProtectionConfigured(),
      pinChangeRequired: defaultPinProtectionConfigured() && isKnownDefaultPin(pin),
    };
  }

  function sessionTtlSeconds() {
    const configured = Number(env.FOODUP_SESSION_TTL_SECONDS || 0);
    return Number.isFinite(configured) && configured >= 3600 ? Math.floor(configured) : 30 * 24 * 60 * 60;
  }

  async function issueSession({ code, deviceId, app }) {
    const normalizedApp = String(app || '').trim().toLowerCase();
    if (!['orders', 'courier'].includes(normalizedApp)) throw new Error('Unsupported app session type.');
    const normalizedDevice = String(deviceId || '').trim() || `device_${randomBytes(18).toString('base64url')}`;
    const token = randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    const ttl = sessionTtlSeconds();
    const record = {
      restaurant_code: String(code || '').trim().toLowerCase(),
      device_id: normalizedDevice,
      app: normalizedApp,
      created_at: new Date(now()).toISOString(),
      expires_at: new Date(now() + ttl * 1000).toISOString(),
      revoked_at: '',
    };
    await redisCommand('SET', `foodup:session:${tokenHash}`, JSON.stringify(record), 'EX', ttl);
    return { token, deviceId: normalizedDevice, expiresAt: record.expires_at };
  }

  async function verifySession({ token, deviceId, app, requestedCode }) {
    const supplied = String(token || '').trim();
    if (!supplied) return { ok: false, reason: 'missing_token' };
    const tokenHash = sha256(supplied);
    const data = await redisCommand('GET', `foodup:session:${tokenHash}`);
    if (!data.result) return { ok: false, reason: 'invalid_token' };

    let record;
    try { record = JSON.parse(data.result); }
    catch (_) { return { ok: false, reason: 'invalid_token' }; }

    if (record.revoked_at) return { ok: false, reason: 'revoked_token' };
    if (record.expires_at && new Date(record.expires_at).getTime() <= now()) {
      return { ok: false, reason: 'expired_token' };
    }
    if (app && record.app !== String(app).trim().toLowerCase()) return { ok: false, reason: 'wrong_app' };
    if (deviceId && record.device_id !== String(deviceId).trim()) return { ok: false, reason: 'wrong_device' };
    if (requestedCode && record.restaurant_code !== String(requestedCode).trim().toLowerCase()) {
      return { ok: false, reason: 'wrong_restaurant' };
    }
    return { ok: true, session: record };
  }

  async function authorizeAppRequest({ code, token, deviceId, client, allowedApps = [] }) {
    const normalizedCode = String(code || '').trim().toLowerCase();
    const suppliedToken = String(token || '').trim();
    const normalizedClient = String(client || '').trim().toLowerCase();

    if (suppliedToken) {
      if (!allowedApps.includes(normalizedClient)) return { ok: false, reason: 'wrong_app_client', legacy: false };
      if (!String(deviceId || '').trim()) return { ok: false, reason: 'missing_device', legacy: false };
      const verified = await verifySession({
        token: suppliedToken,
        deviceId,
        app: normalizedClient,
        requestedCode: normalizedCode,
      });
      return { ...verified, legacy: false };
    }

    if (!normalizedCode) return { ok: false, reason: 'missing_restaurant', legacy: true };
    const legacyState = await getLegacyAppAccessState(normalizedCode);
    if (!legacyState.enabled) return { ok: false, reason: 'legacy_disabled', legacy: true };

    return {
      ok: true,
      legacy: true,
      session: {
        restaurant_code: normalizedCode,
        device_id: '',
        app: allowedApps.includes(normalizedClient) ? normalizedClient : 'legacy',
        legacy: true,
      },
    };
  }

  async function revokeSession(token) {
    const tokenHash = sha256(token);
    const data = await redisCommand('GET', `foodup:session:${tokenHash}`);
    if (!data.result) return false;
    let record;
    try { record = JSON.parse(data.result); }
    catch (_) { return false; }
    record.revoked_at = new Date(now()).toISOString();
    const remainingMs = Math.max(1000, new Date(record.expires_at).getTime() - now());
    await redisCommand('SET', `foodup:session:${tokenHash}`, JSON.stringify(record), 'PX', remainingMs);
    return true;
  }

  async function getLoginCallbackSecret(code) {
    try {
      return await getStoredRestaurantSecret(code);
    } catch (error) {
      if (!isSecretDecryptionError(error)) throw error;
      logger.error?.(`[security] restaurant secret decryption failed for ${String(code || '').trim().toLowerCase()}; login will continue without a callback secret.`);
      return '';
    }
  }

  async function getOutboundWordPressSecret(code) {
    try {
      const stored = await getStoredRestaurantSecret(code);
      if (stored) return { secret: stored, source: 'restaurant' };
    } catch (error) {
      if (!isSecretDecryptionError(error)) throw error;
      logger.error?.(`[security] restaurant secret decryption failed for ${String(code || '').trim().toLowerCase()}; outbound WordPress callback authentication is unavailable until recovery.`);
      return { secret: '', source: 'decrypt_error' };
    }
    const legacy = legacySharedSecret();
    return legacy ? { secret: legacy, source: 'legacy' } : { secret: '', source: 'missing' };
  }

  async function fetchWordPress(code, url, options = {}, fetchImpl = global.fetch) {
    const credential = await getOutboundWordPressSecret(code);
    if (!credential.secret) {
      if (credential.source === 'decrypt_error') {
        return {
          ok: false,
          status: 503,
          async json() { return { success: false, code: 'callback_auth_recovery_required' }; },
        };
      }
      throw new Error('WordPress callback authentication is not configured.');
    }
    const headers = {
      ...(options.headers || {}),
      'x-foodup-secret': credential.secret,
      'X-FoodUp-Client': 'backend',
    };
    return fetchImpl(url, { ...options, headers });
  }

  return {
    safeEqual,
    sha256,
    encryptionConfigured,
    isAcceptableRestaurantSecret,
    encryptSecret,
    decryptSecret,
    isSecretDecryptionError,
    getStoredRestaurantSecret,
    setStoredRestaurantSecret,
    resetStoredRestaurantSecret,
    globalLegacyAppAccessEnabled,
    getLegacyAppAccessState,
    setLegacyAppAccess,
    recordLegacyUse,
    authorizeWordPress,
    isStrictWordPressProof,
    profileAuthorization,
    pinAttemptRateLimitState,
    recordPinFailure,
    clearPinFailures,
    profileWebsitePolicy,
    verifyRestaurantSecretAgainstWebsite,
    defaultPinProtectionConfigured,
    isKnownDefaultPin,
    evaluatePinLogin,
    issueSession,
    verifySession,
    authorizeAppRequest,
    revokeSession,
    getLoginCallbackSecret,
    getOutboundWordPressSecret,
    fetchWordPress,
  };
}

module.exports = { createRestaurantSecurity, safeEqual, sha256, clientIpFromRequest, RestaurantSecretDecryptionError };
