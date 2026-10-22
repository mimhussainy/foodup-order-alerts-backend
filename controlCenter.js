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
  const restaurantSecurity = options.restaurantSecurity || null;
  const orderAppEdition = options.orderAppEdition || null;
  const fetchImpl = options.fetchImpl || global.fetch;
  const stats = options.stats || createControlCenterStats({ redisCommand, k });
  if (options.startHistoryRecorder !== false) stats.start();
  const startedAt = Date.now();
  // Optional admin username (Render env DASHBOARD_USERNAME). While it is not set,
  // sign-in keeps working with the password alone so a deploy never locks anyone out.
  const adminUsername = String(options.adminUsername ?? process.env.DASHBOARD_USERNAME ?? '').trim().toLowerCase();
  if (!adminUsername) console.warn('[control-center] DASHBOARD_USERNAME is not set; sign-in checks the password only.');
  // Sessions are bound to both values: changing the username or password signs everyone out.
  const sessionSecret = adminUsername ? `${dashPassword}\n${adminUsername}` : dashPassword;
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
    if (verifySessionToken(cookies[SESSION_COOKIE], sessionSecret)) return next();
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
    res.json({ success: true, authenticated: verifySessionToken(cookies[SESSION_COOKIE], sessionSecret) });
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
    const username = String(req.body?.username || '').trim().toLowerCase();
    // Both comparisons always run, so the response time does not reveal which one failed.
    const usernameOk = adminUsername ? timingSafeEqualString(username, adminUsername) : true;
    const passwordOk = timingSafeEqualString(password, dashPassword);
    if (!usernameOk || !passwordOk) {
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
      return res.status(401).json({ success: false, message: adminUsername ? 'Incorrect username or password' : 'Incorrect password' });
    }

    try {
      await clearAdminLoginFailures(redisCommand, ip);
    } catch (error) {
      console.warn(`[control-center] login rate-limit clear failed: ${error?.name || 'error'}`);
      return res.status(503).json({ success: false, message: 'Login temporarily unavailable' });
    }

    const token = createSessionToken(sessionSecret);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}${cookieOptions(req)}`);
    res.json({ success: true });
  });

  app.post('/admin/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0`);
    res.json({ success: true });
  });

  async function loadRestaurant(code, includeOrders = false) {
    const [profileRaw, heartbeatRaw, tokensRaw, ordersRaw, printerRaw, autoRaw, websiteRaw, modulesRaw, storeRaw, courierRaw, customerEmailRaw, editionRaw, iosPinRaw, wpEditionRaw] = await Promise.all([
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
      redisCommand('EXISTS', k(code, 'ios_pin')),
      redisCommand('GET', k(code, 'cc_wp_edition')),
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
    const [appState, beats] = await Promise.all([
      stats.appStateFor(code, orders).catch(error => {
        console.warn(`[control-center] app state lookup failed for ${code}: ${error?.name || 'error'}`);
        return { rejected: new Set(), accepted: new Set(), delivered: new Map() };
      }),
      stats.getBeats(code, heartbeat, 12).catch(error => {
        console.warn(`[control-center] heartbeat history failed for ${code}: ${error?.name || 'error'}`);
        return [];
      }),
    ]);
    const rejectedIds = appState.rejected;
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
    // The stored list is ordered by last change (every update moves an order to
    // the top), so it is re-sorted by order time, newest first.
    const annotatedOrders = orders.slice().sort((a, b) => (orderTime(b)?.getTime() || 0) - (orderTime(a)?.getTime() || 0)).map(order => {
      const id = String(order.order_id);
      const delivered = appState.delivered.get(id);
      return {
        ...order,
        rejected: rejectedIds.has(id) || undefined,
        app_accepted: appState.accepted.has(id) || undefined,
        app_delivered: delivered ? true : undefined,
        delivered_by: delivered?.delivery_name || undefined,
        delivered_at: delivered?.delivered_at || undefined,
      };
    });

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
    // WordPress is where the edition is chosen; the apps follow the backend copy.
    const backendEdition = editionRaw.result === 'free' ? 'free' : 'pro';
    const wpEdition = ['free', 'pro'].includes(wpEditionRaw?.result) ? wpEditionRaw.result : null;
    if (wpEdition && wpEdition !== backendEdition) {
      attentionItems.push({ text: `Edition mismatch: WordPress is ${wpEdition === 'free' ? 'Free' : 'Pro'}, the apps run as ${backendEdition === 'free' ? 'Free' : 'Pro'}`, severity: 'warning', kind: 'edition_mismatch' });
    }
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
      edition: backendEdition,
      wp_edition: wpEdition,
      courier_count: couriers.length,
      store_status: storeRaw.result || 'open',
      ios_pin_set: Number(iosPinRaw?.result || 0) > 0,
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
      const code = req.query.code ? normalizeCode(req.query.code) : '';
      res.json({ success: true, analytics: await stats.analytics(code ? { codes: [code] } : {}) });
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
      const profileTouched = allowedProfile.some(field => Object.prototype.hasOwnProperty.call(body, field));
      for (const field of allowedProfile) {
        if (Object.prototype.hasOwnProperty.call(body, field)) profile[field] = String(body[field] || '').trim();
      }
      if (profileTouched) {
        profile.updated_at = new Date().toISOString();
        await redisCommand('SET', k(code, 'restaurant_profile'), JSON.stringify(profile));
      }

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

      if (body.ios_pin) {
        const pin = String(body.ios_pin).trim();
        if (pin.length < 4) return res.status(400).json({ success: false, message: 'iOS PIN must be at least 4 characters' });
        if (restaurantSecurity && typeof restaurantSecurity.isKnownDefaultPin === 'function' && restaurantSecurity.isKnownDefaultPin(pin)) {
          return res.status(400).json({ success: false, message: 'Choose a PIN that is not a default PIN' });
        }
        await redisCommand('SET', k(code, 'ios_pin'), pin);
      }

      // Same key the Orders app switch writes; WordPress picks it up within ~30 s.
      if (typeof body.store_open === 'boolean') {
        await redisCommand('SET', k(code, 'store_status'), body.store_open ? 'open' : 'closed');
        console.log(`[control-center] store ${body.store_open ? 'opened' : 'closed'} for ${code}`);
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

  // ---------- WordPress plugin settings (FoodUp Ordering bridge) ----------
  // The backend forwards admin requests to the restaurant's own WordPress
  // (/wp-json/foodup/v1/control-center/settings), signed with that
  // restaurant's per-restaurant secret. WordPress stays the place where the
  // plugin settings are stored; the backend only mirrors what the apps need.
  const WP_TIMEOUT_MS = 15000;
  const MODULE_KEYS = ['website_ordering', 'orders_app', 'courier', 'customer_app', 'online_payments', 'auto_handling', 'printing'];

  function wordpressBaseUrl(profile) {
    const website = String(profile?.website || '').trim();
    if (!website) return '';
    return (/^https?:\/\//i.test(website) ? website : `https://${website}`).replace(/\/+$/, '');
  }

  async function wordpressRequest(code, method, payload, path = '/control-center/settings', minVersion = '0.5.234') {
    if (!restaurantSecurity || typeof restaurantSecurity.getOutboundWordPressSecret !== 'function') {
      return { ok: false, reason: 'not_configured', message: 'WordPress bridge is not configured on this backend.' };
    }
    const profileRaw = await redisCommand('GET', k(code, 'restaurant_profile'));
    const base = wordpressBaseUrl(safeJson(profileRaw.result, {}));
    if (!base) return { ok: false, reason: 'website_missing', message: 'No website is stored for this restaurant.' };

    const credential = await restaurantSecurity.getOutboundWordPressSecret(code);
    if (credential.source !== 'restaurant' || !credential.secret) {
      // Never fall back to the old shared secret for settings access.
      return { ok: false, reason: 'secret_missing', message: 'This restaurant has no per-restaurant secret yet. Open FoodUp Ordering → Orders App in WordPress and press Save & Connect once.' };
    }

    const url = `${base}/wp-json/foodup/v1${path}${method === 'GET' ? `${path.includes('?') ? '&' : '?'}restaurant_code=${encodeURIComponent(code)}` : ''}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WP_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-foodup-secret': credential.secret, 'X-FoodUp-Client': 'control-center' },
        body: method === 'GET' ? undefined : JSON.stringify({ restaurant_code: code, ...(payload || {}) }),
        signal: controller.signal,
        redirect: 'follow',
      });
      let body = {};
      try { body = await response.json(); } catch (_) {}
      if (response.ok && body && body.success === true) return { ok: true, data: body };
      if (response.status === 404) return { ok: false, reason: 'plugin_outdated', message: `This site does not have this part of the Control Center bridge yet. Update FoodUp Ordering to ${minVersion} or newer.` };
      if (response.status === 409) return { ok: false, reason: 'unavailable', message: String(body?.message || 'This feature is not available on the site.') };
      if (response.status === 401 || response.status === 403) return { ok: false, reason: 'unauthorized', message: 'WordPress refused the restaurant secret. Open FoodUp Ordering → Orders App and press Save & Connect.' };
      if (response.status === 400) return { ok: false, reason: 'invalid', message: String(body?.message || 'WordPress rejected the values.') };
      return { ok: false, reason: 'error', message: `WordPress answered with HTTP ${response.status}.` };
    } catch (error) {
      if (error?.name === 'AbortError') return { ok: false, reason: 'timeout', message: 'WordPress did not answer within 15 seconds.' };
      return { ok: false, reason: 'unreachable', message: 'WordPress could not be reached.' };
    } finally {
      clearTimeout(timer);
    }
  }

  // Remembers which edition WordPress has, so a mismatch with the apps' copy
  // shows up under Needs attention. Read-only: it never changes the edition.
  async function rememberWordpressEdition(code, settings) {
    const edition = settings?.orders_app?.edition;
    if (edition === 'free' || edition === 'pro') await redisCommand('SET', k(code, 'cc_wp_edition'), edition);
  }

  // Mirrors the real plugin feature switches into the Control Center badges.
  async function mirrorModules(code, features) {
    if (!features || typeof features !== 'object') return;
    const modules = {};
    MODULE_KEYS.forEach(key => { modules[key] = features[key] === true; });
    await redisCommand('SET', k(code, 'admin_modules'), JSON.stringify(modules));
  }

  // After an admin save: apply what the backend itself needs, exactly like the
  // plugin's own Save & Connect would (edition + automatic handling), without
  // touching the printer assignment.
  async function applyOperational(code, settings) {
    const applied = {};
    const orders = settings?.orders_app || {};
    const features = settings?.features || {};
    if (orderAppEdition && typeof orderAppEdition.set === 'function' && (orders.edition === 'free' || orders.edition === 'pro')) {
      applied.edition = await orderAppEdition.set(code, orders.edition);
    }
    const autoSettings = {
      auto_action: features.auto_handling === true ? (orders.auto_action || 'disabled') : 'disabled',
      wait_minutes: parseInt(orders.auto_wait_minutes, 10) || 5,
      accept_time: orders.auto_accept_time || '30 Minutes',
      reject_reason: orders.auto_reject_reason || 'Zu beschäftigt',
    };
    await redisCommand('SET', k(code, 'auto_settings'), JSON.stringify(autoSettings));
    if (typeof options.invalidateAutoSettings === 'function') options.invalidateAutoSettings(code);
    applied.auto_settings = autoSettings;
    return applied;
  }

  async function backendView(code) {
    const [autoRaw, edition] = await Promise.all([
      redisCommand('GET', k(code, 'auto_settings')),
      orderAppEdition && typeof orderAppEdition.get === 'function' ? orderAppEdition.get(code) : Promise.resolve(null),
    ]);
    return { edition, auto_settings: safeJson(autoRaw.result, null) };
  }

  app.get('/admin/api/restaurants/:code/wordpress', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code) return res.status(400).json({ success: false, message: 'Invalid restaurant code' });
    try {
      const result = await wordpressRequest(code, 'GET');
      if (!result.ok) return res.json({ success: true, connected: false, reason: result.reason, message: result.message });
      await mirrorModules(code, result.data.settings.features).catch(() => {});
      await rememberWordpressEdition(code, result.data.settings).catch(() => {});
      res.json({ success: true, connected: true, wordpress: result.data, backend: await backendView(code) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.patch('/admin/api/restaurants/:code/wordpress', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code) return res.status(400).json({ success: false, message: 'Invalid restaurant code' });
    const changes = req.body?.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      return res.status(400).json({ success: false, message: 'changes must be an object' });
    }
    try {
      const result = await wordpressRequest(code, 'POST', { changes });
      if (!result.ok) {
        const status = result.reason === 'invalid' ? 400 : 502;
        return res.status(status).json({ success: false, reason: result.reason, message: result.message });
      }
      const settings = result.data.settings;
      await mirrorModules(code, settings.features).catch(() => {});
      await rememberWordpressEdition(code, settings).catch(() => {});
      let applied = {};
      let warning = '';
      if (changes.orders_app || changes.features) {
        try {
          applied = await applyOperational(code, settings);
        } catch (error) {
          warning = 'Saved in WordPress, but the backend copy (edition / automatic handling) could not be updated. Try saving again.';
        }
      }
      console.log(`[control-center] wordpress settings saved for ${code}: ${Object.keys(changes).join(', ')}`);
      res.json({ success: true, connected: true, wordpress: result.data, backend: await backendView(code), applied, warning });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });


  // Read-only website and sales analytics from the plugin (bridge v4).
  const ANALYTICS_RANGES = ['today', 'yesterday', 'last7', 'last30', 'this_month', 'last_month'];
  app.get('/admin/api/restaurants/:code/wordpress/analytics', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code) return res.status(400).json({ success: false, message: 'Invalid restaurant code' });
    const range = ANALYTICS_RANGES.includes(String(req.query.range || '')) ? String(req.query.range) : 'last7';
    try {
      const result = await wordpressRequest(code, 'GET', null, `/control-center/analytics?range=${range}`, '0.5.247');
      if (!result.ok) return res.json({ success: true, available: false, reason: result.reason, message: result.message });
      res.json({ success: true, available: true, ...result.data });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get('/admin/api/restaurants/:code/wordpress/products', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code) return res.status(400).json({ success: false, message: 'Invalid restaurant code' });
    try {
      const result = await wordpressRequest(code, 'GET', null, '/control-center/products', '0.5.238');
      if (!result.ok) return res.json({ success: true, available: false, reason: result.reason, message: result.message });
      res.json({ success: true, available: true, ...result.data });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.patch('/admin/api/restaurants/:code/wordpress/products', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    const updates = req.body?.updates;
    if (!code) return res.status(400).json({ success: false, message: 'Invalid restaurant code' });
    if (!Array.isArray(updates) || !updates.length || updates.length > 500) {
      return res.status(400).json({ success: false, message: 'updates must be a list of 1–500 changes' });
    }
    try {
      const result = await wordpressRequest(code, 'POST', { updates }, '/control-center/products', '0.5.238');
      if (!result.ok) return res.status(result.reason === 'invalid' ? 400 : 502).json({ success: false, reason: result.reason, message: result.message });
      console.log(`[control-center] ${updates.length} product change(s) saved for ${code}`);
      res.json({ success: true, available: true, ...result.data });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // ---------- Courier accounts (same Redis records as the Orders app) ----------
  const COURIER_NAME = /^[\p{L}\p{N} ._-]{1,40}$/u;
  function courierKey(code, username) {
    return k(code, `delivery_account:${String(username || '').trim().toLowerCase()}`);
  }
  async function loadCouriers(code) {
    const members = await redisCommand('SMEMBERS', k(code, 'delivery_accounts'));
    const names = (members.result || []).filter(Boolean);
    if (!names.length) return [];
    const values = await redisCommand('MGET', ...names.map(name => courierKey(code, name)));
    return (values.result || []).map((raw, i) => {
      const account = safeJson(raw, null);
      if (!account) return null;
      // Passwords are never sent to the browser.
      return { username: account.username || names[i], key: names[i], phone: account.phone || '', created_at: account.created_at || null };
    }).filter(Boolean).sort((a, b) => String(a.username).localeCompare(String(b.username)));
  }

  app.get('/admin/api/restaurants/:code/couriers', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code) return res.status(400).json({ success: false, message: 'Invalid restaurant code' });
    try {
      res.json({ success: true, couriers: await loadCouriers(code) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post('/admin/api/restaurants/:code/couriers', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const phone = String(req.body?.phone || '').trim().slice(0, 40);
    if (!code) return res.status(400).json({ success: false, message: 'Invalid restaurant code' });
    if (!COURIER_NAME.test(username)) return res.status(400).json({ success: false, message: 'Username: 1–40 letters, numbers, spaces, dots, dashes' });
    if (password.length < 4) return res.status(400).json({ success: false, message: 'Password must be at least 4 characters' });
    try {
      const existing = await redisCommand('GET', courierKey(code, username));
      if (existing.result) return res.status(409).json({ success: false, message: 'A courier with this username already exists' });
      await redisCommand('SET', courierKey(code, username), JSON.stringify({ username, password, phone, created_at: new Date().toISOString() }));
      await redisCommand('SADD', k(code, 'delivery_accounts'), username.toLowerCase());
      console.log(`[control-center] courier added for ${code}`);
      res.json({ success: true, couriers: await loadCouriers(code) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.patch('/admin/api/restaurants/:code/couriers/:username', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    const username = String(req.params.username || '').trim();
    if (!code || !username) return res.status(400).json({ success: false, message: 'Invalid courier' });
    try {
      const raw = await redisCommand('GET', courierKey(code, username));
      const account = safeJson(raw.result, null);
      if (!account) return res.status(404).json({ success: false, message: 'Courier not found' });
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'password')) {
        const password = String(req.body.password || '');
        if (password.length < 4) return res.status(400).json({ success: false, message: 'Password must be at least 4 characters' });
        account.password = password;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'phone')) account.phone = String(req.body.phone || '').trim().slice(0, 40);
      await redisCommand('SET', courierKey(code, username), JSON.stringify(account));
      res.json({ success: true, couriers: await loadCouriers(code) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.delete('/admin/api/restaurants/:code/couriers/:username', requireAdmin, async (req, res) => {
    const code = normalizeCode(req.params.code);
    const username = String(req.params.username || '').trim().toLowerCase();
    if (!code || !username) return res.status(400).json({ success: false, message: 'Invalid courier' });
    try {
      await redisCommand('DEL', courierKey(code, username));
      await redisCommand('SREM', k(code, 'delivery_accounts'), username);
      console.log(`[control-center] courier removed for ${code}`);
      res.json({ success: true, couriers: await loadCouriers(code) });
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

  // Every 30 minutes: read each connected site's settings once (sequentially,
  // read-only) so edition mismatches are found without opening every page.
  async function checkWordpressEditions() {
    let codes = [];
    try { codes = ((await redisCommand('SMEMBERS', 'restaurants')).result || []).map(normalizeCode).filter(Boolean); } catch (_) { return; }
    for (const code of codes) {
      try {
        const result = await wordpressRequest(code, 'GET');
        if (!result.ok) continue;
        await rememberWordpressEdition(code, result.data.settings);
        await mirrorModules(code, result.data.settings.features);
      } catch (_) {}
    }
  }
  if (options.startHistoryRecorder !== false) {
    setTimeout(() => { checkWordpressEditions(); setInterval(checkWordpressEditions, 30 * 60 * 1000).unref?.(); }, 90 * 1000).unref?.();
  }

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
