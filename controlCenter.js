const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { adminLoginRateLimitState, recordAdminLoginFailure, clearAdminLoginFailures } = require('./adminLoginRateLimit');
const { createControlCenterStats, zurichParts, orderTime, isVoidOrder } = require('./controlCenterStats');

const SESSION_COOKIE = 'foodup_admin_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const ADMIN_HOST = (process.env.FOODUP_ADMIN_HOST || 'admin.foodup.ch').toLowerCase();

function safeJson(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function normalizeCode(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '');
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function timingSafeEqualString(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function createSessionToken(secret) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_SECONDS * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token, secret) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return false;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    if (!timingSafeEqualString(sig, expected)) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(data.exp || 0) > Date.now();
  } catch (_) {
    return false;
  }
}

function cookieOptions(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  const secure = req.secure || forwarded === 'https';
  return `${secure ? '; Secure' : ''}; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=${SESSION_TTL_SECONDS}`;
}

function createControlCenter(app, redisCommand, k, dashPassword, options = {}) {
  const deliveredCallbackOutbox = options.deliveredCallbackOutbox || null;
  const stats = options.stats || createControlCenterStats({ redisCommand, k });
  if (options.startHistoryRecorder !== false) stats.start();
  const startedAt = Date.now();
  const assetsPath = path.join(__dirname, 'control-center');
  app.use('/admin/assets', express.static(assetsPath, { maxAge: '1h', index: false }));

  // admin.foodup.ch should feel like its own application while the Render host keeps
  // its existing JSON health endpoint and API surface.
  app.get('/', (req, res, next) => {
    const host = String(req.hostname || req.headers.host || '').split(':')[0].toLowerCase();
    if (host === ADMIN_HOST) return res.redirect('/admin');
    next();
  });

  const requireAdmin = (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    if (verifySessionToken(cookies[SESSION_COOKIE], dashPassword)) return next();
    res.status(401).json({ success: false, message: 'Authentication required' });
  };

  app.get('/admin', (req, res) => {
    res.sendFile(path.join(assetsPath, 'index.html'));
  });

  // Legacy monitor links now land on the Control Center domain. These handlers
  // are registered before the old embedded dashboard routes in index.js.
  app.get('/dashboard', (req, res) => res.redirect(`https://${ADMIN_HOST}/admin`));
  app.get('/dashboard/settings', (req, res) => res.redirect(`https://${ADMIN_HOST}/admin`));

  app.get('/admin/api/session', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    res.json({ success: true, authenticated: verifySessionToken(cookies[SESSION_COOKIE], dashPassword) });
  });

  app.post('/admin/api/login', async (req, res) => {
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown').trim() || 'unknown';
    let limitState;
    try {
      limitState = await adminLoginRateLimitState(redisCommand, ip);
    } catch (error) {
      console.warn(`[control-center] login rate-limit lookup failed: ${error?.name || 'error'}`);
      return res.status(503).json({ success: false, message: 'Login temporarily unavailable' });
    }

    if (limitState.blocked) {
      res.setHeader('Retry-After', String(limitState.retryAfter));
      return res.status(429).json({ success: false, message: 'Too many login attempts. Try again later.' });
    }

    const password = String(req.body?.password || '');
    if (!timingSafeEqualString(password, dashPassword)) {
      let failure;
      try {
        failure = await recordAdminLoginFailure(redisCommand, ip);
      } catch (error) {
        console.warn(`[control-center] login rate-limit write failed: ${error?.name || 'error'}`);
        return res.status(503).json({ success: false, message: 'Login temporarily unavailable' });
      }
      if (failure.blocked) {
        res.setHeader('Retry-After', String(failure.retryAfter));
        return res.status(429).json({ success: false, message: 'Too many login attempts. Try again later.' });
      }
      return res.status(401).json({ success: false, message: 'Incorrect password' });
    }

    try {
      await clearAdminLoginFailures(redisCommand, ip);
    } catch (error) {
      console.warn(`[control-center] login rate-limit clear failed: ${error?.name || 'error'}`);
      return res.status(503).json({ success: false, message: 'Login temporarily unavailable' });
    }

    const token = createSessionToken(dashPassword);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}${cookieOptions(req)}`);
    res.json({ success: true });
  });

  app.post('/admin/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0`);
    res.json({ success: true });
  });

  async function loadRestaurant(code, includeOrders = false) {
    const [profileRaw, heartbeatRaw, tokensRaw, ordersRaw, printerRaw, autoRaw, websiteRaw, modulesRaw, storeRaw, courierRaw, customerEmailRaw, editionRaw] = await Promise.all([
      redisCommand('GET', k(code, 'restaurant_profile')),
      redisCommand('GET', k(code, 'heartbeat')),
      redisCommand('SMEMBERS', k(code, 'device_tokens')),
      redisCommand('LRANGE', k(code, 'orders'), 0, 99),
      redisCommand('GET', k(code, 'printer_device_id')),
      redisCommand('GET', k(code, 'auto_settings')),
      redisCommand('GET', k(code, 'website_health')),
      redisCommand('GET', k(code, 'admin_modules')),
      redisCommand('GET', k(code, 'store_status')),
      redisCommand('SMEMBERS', k(code, 'delivery_accounts')),
      redisCommand('GET', k(code, 'customer_email_settings')),
      redisCommand('GET', k(code, 'orders_app_edition')),
    ]);

    const profile = safeJson(profileRaw.result, {}) || {};
    const heartbeat = safeJson(heartbeatRaw.result, null);
    const tokens = tokensRaw.result || [];
    const orders = (ordersRaw.result || []).map(v => safeJson(v)).filter(Boolean);
    const autoSettings = safeJson(autoRaw.result, {}) || {};
    const websiteHealth = safeJson(websiteRaw.result, null);
    const storedModules = safeJson(modulesRaw.result, null);
    const couriers = courierRaw.result || [];
    const customerEmailSettingsRaw = safeJson(customerEmailRaw.result, {}) || {};
    const customerEmailSettings = {
      resend_enabled: customerEmailSettingsRaw.resend_enabled === true,
      updated_at: customerEmailSettingsRaw.updated_at || null,
    };

    let failedDeliveredCallbacks = [];
    if (includeOrders && deliveredCallbackOutbox && typeof deliveredCallbackOutbox.listFailed === 'function') {
      try {
        failedDeliveredCallbacks = await deliveredCallbackOutbox.listFailed(code, 50);
      } catch (error) {
        console.warn(`[control-center] failed delivered callback lookup failed for ${code}: ${error?.name || 'error'}`);
      }
    }

    let appMinutesAgo = null;
    let appStatus = 'never';
    if (heartbeat?.last_seen) {
      appMinutesAgo = Math.max(0, Math.floor((Date.now() - new Date(heartbeat.last_seen).getTime()) / 60000));
      appStatus = appMinutesAgo < 10 ? 'online' : appMinutesAgo < 30 ? 'idle' : 'offline';
    }

    // "Today" is the Swiss calendar day (Render runs on UTC). Cancelled,
    // refunded, failed and app-rejected orders do not count as orders/revenue.
    const [rejectedIds, beats] = await Promise.all([
      stats.rejectedIdsFor(code, orders).catch(error => {
        console.warn(`[control-center] rejected lookup failed for ${code}: ${error?.name || 'error'}`);
        return new Set();
      }),
      stats.getBeats(code, heartbeat, 12).catch(error => {
        console.warn(`[control-center] heartbeat history failed for ${code}: ${error?.name || 'error'}`);
        return [];
      }),
    ]);
    const todayDay = zurichParts(new Date()).day;
    const todayAll = orders.filter(order => {
      const dt = orderTime(order);
      return dt && zurichParts(dt).day === todayDay;
    });
    const todayOrders = todayAll.filter(order => !isVoidOrder(order, rejectedIds));
    const rejectedToday = todayAll.length - todayOrders.length;

    let lastOrderAt = null;
    for (const order of orders) {
      const dt = orderTime(order);
      if (dt && (!lastOrderAt || dt > lastOrderAt)) lastOrderAt = dt;
    }
    const annotatedOrders = orders.map(order => (rejectedIds.has(String(order.order_id))
      ? { ...order, rejected: true }
      : order));

    const modules = storedModules || {
      website_ordering: !!profile.website,
      orders_app: tokens.length > 0 || !!heartbeat,
      courier: couriers.length > 0,
      customer_app: false,
      online_payments: false,
      auto_handling: !!autoSettings.auto_action && autoSettings.auto_action !== 'disabled',
      printing: !!printerRaw.result,
    };

    const attentionItems = [];
    if (appStatus === 'offline') attentionItems.push({ text: 'Orders app offline', severity: 'critical' });
    if (appStatus === 'never') attentionItems.push({ text: 'Orders app never seen', severity: 'critical' });
    if (websiteHealth?.status === 'down') attentionItems.push({ text: 'Website down', severity: 'critical' });
    if (!profile.website) attentionItems.push({ text: 'Website missing', severity: 'warning' });
    if (modules.orders_app && tokens.length === 0) attentionItems.push({ text: 'No push device', severity: 'warning' });
    if (modules.printing && !printerRaw.result) attentionItems.push({ text: 'Printer not assigned', severity: 'warning' });
    const attention = attentionItems.map(item => item.text);

    return {
      code,
      name: profile.name || code,
      website: profile.website || '',
      phone: profile.phone || '',
      address: profile.address || '',
      profile,
      app_status: appStatus,
      app_minutes_ago: appMinutesAgo,
      heartbeat,
      device_count: tokens.length,
      printer_device_id: printerRaw.result || '',
      edition: editionRaw.result === 'free' ? 'free' : 'pro',
      courier_count: couriers.length,
      store_status: storeRaw.result || 'open',
      website_health: websiteHealth,
      auto_settings: autoSettings,
      modules,
      customer_email_settings: customerEmailSettings,
      failed_delivered_callbacks: failedDeliveredCallbacks,
      attention,
      attention_items: attentionItems,
      beats,
      orders_today: todayOrders.length,
      revenue_today: todayOrders.reduce((sum, o) => sum + Number(o.total || 0), 0),
      rejected_today: rejectedToday,
      last_order_at: lastOrderAt ? lastOrderAt.toISOString() : null,
      recent_orders: includeOrders ? annotatedOrders : annotatedOrders.slice(0, 8),
    };
  }

  async function getAllRestaurants(includeOrders = false) {
    const result = await redisCommand('SMEMBERS', 'restaurants');
    const codes = (result.result || []).map(normalizeCode).filter(Boolean);
    return Promise.all(codes.map(async code => {
      try { return await loadRestaurant(code, includeOrders); }
      catch (error) {
        return { code, name: code, app_status: 'unknown', attention: ['Backend read failed'], attention_items: [{ text: 'Backend read failed', severity: 'critical' }], beats: [], error: error.message, orders_today: 0, revenue_today: 0, rejected_today: 0, modules: {} };
      }
    }));
  }

  async function loadServices(restaurants) {
    const services = { api_uptime_seconds: Math.floor((Date.now() - startedAt) / 1000), redis_ms: null, callbacks_failed: 0, websites_up: 0, websites_total: 0 };
    try {
      const t0 = Date.now();
      await redisCommand('PING');
      services.redis_ms = Date.now() - t0;
    } catch (_) {}
    for (const r of restaurants) {
      if (r.website_health?.status) {
        services.websites_total += 1;
        if (r.website_health.status !== 'down') services.websites_up += 1;
      }
    }
    if (deliveredCallbackOutbox && typeof deliveredCallbackOutbox.listFailed === 'function') {
      const counts = await Promise.all(restaurants.map(r => deliveredCallbackOutbox.listFailed(r.code, 50).then(list => list.length).catch(() => 0)));
      services.callbacks_failed = counts.reduce((sum, n) => sum + n, 0);
    }
    return services;
  }

  app.get('/admin/api/analytics', requireAdmin, async (req, res) => {
    try {
      res.json({ success: true, analytics: await stats.analytics() });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get('/admin/api/overview', requireAdmin, async (req, res) => {
    try {
      const restaurants = await getAllRestaurants(false);
      const todayOrders = restaurants.reduce((sum, r) => sum + Number(r.orders_today || 0), 0);
      const revenue = restaurants.reduce((sum, r) => sum + Number(r.revenue_today || 0), 0);
      const online = restaurants.filter(r => r.app_status === 'online').length;
      const idle = restaurants.filter(r => r.app_status === 'idle').length;
      const attentionRestaurants = restaurants.filter(r => (r.attention || []).length > 0);
      const allItems = restaurants.flatMap(r => r.attention_items || []);
      res.json({
        success: true,
        summary: {
          restaurants: restaurants.length,
          online,
          idle,
          offline: restaurants.length - online - idle,
          attention: attentionRestaurants.length,
          issues: allItems.length,
          critical: allItems.filter(i => i.severity === 'critical').length,
          warnings: allItems.filter(i => i.severity !== 'critical').length,
          orders_today: todayOrders,
          revenue_today: revenue,
          rejected_today: restaurants.reduce((sum, r) => sum + Number(r.rejected_today || 0), 0),
        },
        services: await loadServices(restaurants),
        attention: attentionRestaurants
          .sort((a, b) => (b.attention?.length || 0) - (a.attention?.length || 0))
          .slice(0, 8),
        restaurants,
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get('/admin/api/restaurants', requireAdmin, async (req, res) => {
    try {
      const restaurants = await getAllRestaurants(false);
      res.json({ success: true, restaurants });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get('/admin/api/restaurants/:code', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code) return res.status(400).json({ success: false, message: 'Invalid restaurant code' });
    try {
      res.json({ success: true, restaurant: await loadRestaurant(code, true) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.patch('/admin/api/restaurants/:code', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code) return res.status(400).json({ success: false, message: 'Invalid restaurant code' });
    try {
      const profileRaw = await redisCommand('GET', k(code, 'restaurant_profile'));
      const profile = safeJson(profileRaw.result, {}) || {};
      const body = req.body || {};
      const allowedProfile = ['name', 'website', 'phone', 'address'];
      for (const field of allowedProfile) {
        if (Object.prototype.hasOwnProperty.call(body, field)) profile[field] = String(body[field] || '').trim();
      }
      profile.updated_at = new Date().toISOString();
      await redisCommand('SET', k(code, 'restaurant_profile'), JSON.stringify(profile));

      if (body.modules && typeof body.modules === 'object') {
        const defaults = ['website_ordering','orders_app','courier','customer_app','online_payments','auto_handling','printing'];
        const modules = {};
        defaults.forEach(key => { modules[key] = !!body.modules[key]; });
        await redisCommand('SET', k(code, 'admin_modules'), JSON.stringify(modules));
      }

      if (body.customer_email_settings && typeof body.customer_email_settings === 'object') {
        const customerEmailSettings = {
          resend_enabled: body.customer_email_settings.resend_enabled === true,
          updated_at: new Date().toISOString(),
        };
        await redisCommand('SET', k(code, 'customer_email_settings'), JSON.stringify(customerEmailSettings));
      }

      if (body.owner_pin) {
        const pin = String(body.owner_pin).trim();
        if (pin.length < 4) return res.status(400).json({ success: false, message: 'Owner PIN must be at least 4 characters' });
        await redisCommand('SET', k(code, 'pin'), pin);
      }

      res.json({ success: true, restaurant: await loadRestaurant(code, true) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });


  app.post('/admin/api/restaurants/:code/delivered-callbacks/:orderId/retry', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    const orderId = String(req.params.orderId || '').trim();
    if (!code || !orderId) return res.status(400).json({ success: false, message: 'Invalid callback retry request' });
    if (!deliveredCallbackOutbox || typeof deliveredCallbackOutbox.retryFailed !== 'function') {
      return res.status(503).json({ success: false, message: 'Delivered callback outbox is unavailable' });
    }
    try {
      const result = await deliveredCallbackOutbox.retryFailed(code, orderId);
      if (!result?.ok) {
        const status = result?.reason === 'not_found' ? 404 : 409;
        return res.status(status).json({ success: false, code: result?.reason || 'retry_failed', message: 'Failed callback could not be re-queued' });
      }
      if (typeof deliveredCallbackOutbox.kick === 'function') deliveredCallbackOutbox.kick(code, orderId);
      res.json({ success: true, restaurant: await loadRestaurant(code, true) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post('/admin/api/restaurants/:code/reset-devices', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code) return res.status(400).json({ success: false, message: 'Invalid restaurant code' });
    try {
      const tokens = await redisCommand('SMEMBERS', k(code, 'device_tokens'));
      for (const token of (tokens.result || [])) {
        await redisCommand('DEL', k(code, `token_channel:${token}`));
      }
      await redisCommand('DEL', k(code, 'device_tokens'));
      await redisCommand('DEL', k(code, 'heartbeat'));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post('/admin/api/restaurants/:code/reset-printer', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code) return res.status(400).json({ success: false, message: 'Invalid restaurant code' });
    try {
      await redisCommand('DEL', k(code, 'printer_device_id'));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.delete('/admin/api/restaurants/:code/orders', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code || String(req.body?.confirm || '') !== code) return res.status(400).json({ success: false, message: 'Confirmation code does not match' });
    try {
      await redisCommand('DEL', k(code, 'orders'));
      await redisCommand('DEL', k(code, 'last_order'));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.delete('/admin/api/restaurants/:code', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code || String(req.body?.confirm || '') !== code) return res.status(400).json({ success: false, message: 'Type the restaurant code to confirm removal' });
    try {
      const keys = await redisCommand('KEYS', `${code}:*`);
      const list = keys.result || [];
      for (let i = 0; i < list.length; i += 100) {
        const batch = list.slice(i, i + 100);
        if (batch.length) await redisCommand('DEL', ...batch);
      }
      await redisCommand('SREM', 'restaurants', code);
      res.json({ success: true, removed_keys: list.length });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get('/admin/api/orders', requireAdmin, async (req, res) => {
    try {
      const restaurants = await getAllRestaurants(true);
      const orders = [];
      for (const restaurant of restaurants) {
        for (const order of (restaurant.recent_orders || [])) {
          orders.push({ ...order, restaurant_code: restaurant.code, restaurant_name: restaurant.name });
        }
      }
      orders.sort((a, b) => (orderTime(b)?.getTime() || 0) - (orderTime(a)?.getTime() || 0));
      res.json({ success: true, orders: orders.slice(0, 300) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get('/admin/api/health', requireAdmin, async (req, res) => {
    try {
      const restaurants = await getAllRestaurants(false);
      const issues = [];
      restaurants.forEach(r => (r.attention || []).forEach(issue => issues.push({ code: r.code, name: r.name, issue, app_status: r.app_status, website_health: r.website_health })));
      res.json({ success: true, issues, restaurants });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });
}

module.exports = { createControlCenter };
