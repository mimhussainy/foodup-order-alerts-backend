const path = require('path');
const crypto = require('crypto');
const express = require('express');

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

function createControlCenter(app, redisCommand, k, dashPassword) {
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

  app.post('/admin/api/login', (req, res) => {
    const password = String(req.body?.password || '');
    if (!timingSafeEqualString(password, dashPassword)) {
      return res.status(401).json({ success: false, message: 'Incorrect password' });
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
    const [profileRaw, heartbeatRaw, tokensRaw, ordersRaw, printerRaw, autoRaw, websiteRaw, modulesRaw, storeRaw, courierRaw] = await Promise.all([
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
    ]);

    const profile = safeJson(profileRaw.result, {}) || {};
    const heartbeat = safeJson(heartbeatRaw.result, null);
    const tokens = tokensRaw.result || [];
    const orders = (ordersRaw.result || []).map(v => safeJson(v)).filter(Boolean);
    const autoSettings = safeJson(autoRaw.result, {}) || {};
    const websiteHealth = safeJson(websiteRaw.result, null);
    const storedModules = safeJson(modulesRaw.result, null);
    const couriers = courierRaw.result || [];

    let appMinutesAgo = null;
    let appStatus = 'never';
    if (heartbeat?.last_seen) {
      appMinutesAgo = Math.max(0, Math.floor((Date.now() - new Date(heartbeat.last_seen).getTime()) / 60000));
      appStatus = appMinutesAgo < 10 ? 'online' : appMinutesAgo < 30 ? 'idle' : 'offline';
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayOrders = orders.filter(order => {
      const raw = order.received_at || order.date_created;
      if (!raw) return false;
      const dt = new Date(String(raw).replace(' ', 'T'));
      return !Number.isNaN(dt.getTime()) && dt >= today;
    });

    let lastOrderAt = null;
    for (const order of orders) {
      const raw = order.received_at || order.date_created;
      if (!raw) continue;
      const dt = new Date(String(raw).replace(' ', 'T'));
      if (!Number.isNaN(dt.getTime()) && (!lastOrderAt || dt > lastOrderAt)) lastOrderAt = dt;
    }

    const modules = storedModules || {
      website_ordering: !!profile.website,
      orders_app: tokens.length > 0 || !!heartbeat,
      courier: couriers.length > 0,
      customer_app: false,
      online_payments: false,
      auto_handling: !!autoSettings.auto_action && autoSettings.auto_action !== 'disabled',
      printing: !!printerRaw.result,
    };

    const attention = [];
    if (appStatus === 'offline') attention.push('Orders app offline');
    if (appStatus === 'never') attention.push('Orders app never seen');
    if (!profile.website) attention.push('Website missing');
    if (websiteHealth?.status === 'down') attention.push('Website down');
    if (modules.orders_app && tokens.length === 0) attention.push('No push device');
    if (modules.printing && !printerRaw.result) attention.push('Printer not assigned');

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
      courier_count: couriers.length,
      store_status: storeRaw.result || 'open',
      website_health: websiteHealth,
      auto_settings: autoSettings,
      modules,
      attention,
      orders_today: todayOrders.length,
      revenue_today: todayOrders.reduce((sum, o) => sum + Number(o.total || 0), 0),
      last_order_at: lastOrderAt ? lastOrderAt.toISOString() : null,
      recent_orders: includeOrders ? orders : orders.slice(0, 8),
    };
  }

  async function getAllRestaurants(includeOrders = false) {
    const result = await redisCommand('SMEMBERS', 'restaurants');
    const codes = (result.result || []).map(normalizeCode).filter(Boolean);
    return Promise.all(codes.map(async code => {
      try { return await loadRestaurant(code, includeOrders); }
      catch (error) {
        return { code, name: code, app_status: 'unknown', attention: ['Backend read failed'], error: error.message, orders_today: 0, revenue_today: 0, modules: {} };
      }
    }));
  }

  app.get('/admin/api/overview', requireAdmin, async (req, res) => {
    try {
      const restaurants = await getAllRestaurants(false);
      const todayOrders = restaurants.reduce((sum, r) => sum + Number(r.orders_today || 0), 0);
      const revenue = restaurants.reduce((sum, r) => sum + Number(r.revenue_today || 0), 0);
      const online = restaurants.filter(r => r.app_status === 'online').length;
      const attentionRestaurants = restaurants.filter(r => (r.attention || []).length > 0);
      res.json({
        success: true,
        summary: {
          restaurants: restaurants.length,
          online,
          attention: attentionRestaurants.length,
          orders_today: todayOrders,
          revenue_today: revenue,
        },
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
      orders.sort((a, b) => {
        const aa = new Date(String(a.received_at || a.date_created || 0).replace(' ', 'T')).getTime() || 0;
        const bb = new Date(String(b.received_at || b.date_created || 0).replace(' ', 'T')).getTime() || 0;
        return bb - aa;
      });
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
