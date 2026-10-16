'use strict';

// FoodUp Orders edition (Free / Pro) per restaurant.
//
// Safety rules (learned from the 16.10.2026 incident):
// - The edition is stored in Redis, written only by the restaurant's
//   WordPress (FoodUp Ordering -> Orders App). The backend NEVER calls
//   WordPress to look it up.
// - Anything unclear (no value, unknown value, Redis error) means PRO, so an
//   existing restaurant can never lose features because of a lookup problem.
// - Pro-only routes are gated by FOODUP_EDITION_ENFORCEMENT:
//     off      -> never gate
//     log_only -> (default) only log what would be blocked
//     enforce  -> answer 403 foodup_pro_required for Free restaurants
// - Gated routes are matched case-insensitively, with or without a trailing
//   slash, like Express itself routes them.

const EDITIONS = ['free', 'pro'];
const MODES = ['off', 'log_only', 'enforce'];
const CACHE_MS = 30000;
const FAILURE_CACHE_MS = 10000;
const CACHE_MAX_ENTRIES = 2000;

// Courier + statistics features. Order reception, accept/reject, printing,
// auto handling, store status and all WordPress callbacks stay available.
const PRO_ONLY_ROUTES = [
  /^\/stats\/[^/]+\/?$/i,
  /^\/courier-stats\/[^/]+\/?$/i,
  /^\/claims\/[^/]+\/?$/i,
  /^\/add-delivery-account\/?$/i,
  /^\/verify-delivery-account\/?$/i,
  /^\/delivery-accounts\/?$/i,
  /^\/delivery-accounts-ios\/?$/i,
  /^\/delete-delivery-account\/?$/i,
  /^\/courier-phone\/[^/]+\/[^/]+\/?$/i,
  /^\/change-delivery-password\/?$/i,
  /^\/update-delivery-phone\/?$/i,
  /^\/reset-delivery-password\/?$/i,
  /^\/mark-delivered\/?$/i,
  /^\/remove-delivered\/?$/i,
  /^\/all-couriers-delivered\/[^/]+\/?$/i,
  /^\/courier-delivered\/[^/]+\/[^/]+\/?$/i,
  /^\/clear-courier-delivered\/[^/]+\/[^/]+\/?$/i,
  /^\/claim-order\/?$/i,
  /^\/release-claim\/?$/i,
];
// Routes whose restaurant code is the first path segment after the route name.
const PATH_CODE_ROUTE = /^\/(stats|courier-stats|claims|courier-phone|all-couriers-delivered|courier-delivered|clear-courier-delivered)\//i;

function normalizeCode(value) {
  const code = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,100}$/.test(code) ? code : '';
}

function normalizeEdition(value) {
  const edition = String(value || '').trim().toLowerCase();
  return EDITIONS.includes(edition) ? edition : '';
}

function createOrderAppEdition({ redisCommand, k, env = process.env, logger = console, now = Date.now }) {
  const cache = new Map();

  function remember(code, edition, ms) {
    if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(code)) cache.clear();
    cache.set(code, { edition, expires: now() + ms });
  }

  function enforcementMode() {
    const mode = String(env.FOODUP_EDITION_ENFORCEMENT || 'log_only').trim().toLowerCase();
    return MODES.includes(mode) ? mode : 'log_only';
  }

  // Never throws. Returns 'free' only when Redis explicitly says 'free'.
  async function get(code) {
    const normalized = normalizeCode(code);
    if (!normalized) return 'pro';
    const cached = cache.get(normalized);
    if (cached && cached.expires > now()) return cached.edition;
    if (cached) cache.delete(normalized);
    let edition = 'pro';
    try {
      const stored = await redisCommand('GET', k(normalized, 'orders_app_edition'));
      edition = normalizeEdition(stored && stored.result) || 'pro';
    } catch (error) {
      logger.warn?.(`[edition] read failed for ${normalized}, using pro: ${error?.code || error?.name || 'error'}`);
      // Short fallback cache: a slow Redis must not delay every Pro request.
      remember(normalized, 'pro', FAILURE_CACHE_MS);
      return 'pro';
    }
    remember(normalized, edition, CACHE_MS);
    return edition;
  }

  async function set(code, value) {
    const normalized = normalizeCode(code);
    const edition = normalizeEdition(value);
    if (!normalized || !edition) throw new Error('invalid_edition');
    await redisCommand('SET', k(normalized, 'orders_app_edition'), edition);
    remember(normalized, edition, CACHE_MS);
    return edition;
  }

  function isProOnlyRoute(req) {
    const path = String(req.path || '');
    return PRO_ONLY_ROUTES.some(pattern => pattern.test(path));
  }

  // Returns '' when the request itself names no restaurant.
  function proOnlyRouteCode(req) {
    const path = String(req.path || '');
    if (!PRO_ONLY_ROUTES.some(pattern => pattern.test(path))) return null;
    if (PATH_CODE_ROUTE.test(path)) {
      let segment = path.split('/')[2] || '';
      try { segment = decodeURIComponent(segment); } catch (_) { segment = ''; }
      return normalizeCode(segment);
    }
    return normalizeCode(req.body?.restaurant_code || req.query?.restaurant_code || '');
  }

  // sessionCode(req) resolves the restaurant from an app session token for
  // requests that do not name the restaurant (their handlers use the session).
  // No WordPress exemption: WordPress never calls these courier/stats routes
  // for order processing, and a client header must not bypass the gate.
  function gate(sessionCode = async () => '') {
    return async (req, res, next) => {
      try {
        const mode = enforcementMode();
        if (mode === 'off') return next();
        if (!isProOnlyRoute(req)) return next();
        let code = proOnlyRouteCode(req);
        if (!code) code = normalizeCode(await sessionCode(req));
        if (!code) return next();
        if ((await get(code)) !== 'free') return next();
        if (mode === 'log_only') {
          logger.warn?.(`[edition] log_only: would block ${req.method} ${req.path} for free restaurant ${code}`);
          return next();
        }
        return res.status(403).json({
          success: false,
          code: 'foodup_pro_required',
          edition: 'free',
          message: 'Available in FoodUp Pro.',
        });
      } catch (_) {
        return next();
      }
    };
  }

  return { get, set, gate, enforcementMode, proOnlyRouteCode };
}

module.exports = { createOrderAppEdition, PRO_ONLY_ROUTES, normalizeEdition };
