const express = require("express");
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCommand(...args) {
  const response = await fetch(`${UPSTASH_URL}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  return response.json();
}

const k = (code, key) => `${code}:${key}`;

// -------------------------------------------------------
// SIMPLE DISTRIBUTED LOCK (prevents concurrent list rewrites)
// -------------------------------------------------------

async function withRedisLock(lockKey, fn, maxWaitMs = 5000) {
  const lockValue = String(Date.now()) + Math.random().toString(36).slice(2);
  const start = Date.now();
  let acquired = false;

  while (Date.now() - start < maxWaitMs) {
    const result = await redisCommand("SET", lockKey, lockValue, "NX", "PX", 10000);
    if (result.result === "OK") { acquired = true; break; }
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
  }

  if (!acquired) {
    console.log(`withRedisLock: could not acquire ${lockKey} within ${maxWaitMs}ms, proceeding unlocked`);
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      await redisCommand("DEL", lockKey);
    }
  }
}

async function upsertOrderInList(code, order) {
  if (!order || !order.order_id) {
    console.log("upsertOrderInList skipped: missing order_id");
    return;
  }

  await withRedisLock(k(code, "orders_lock"), async () => {
    try {
      const listData = await redisCommand("LRANGE", k(code, "orders"), 0, 99);
      const orders = (listData.result || []).map(o => {
        try { return JSON.parse(o); } catch(e) { return null; }
      }).filter(Boolean);

      // Remove all existing entries for this order_id
      const filtered = orders.filter(o => String(o.order_id) !== String(order.order_id));

      // Merge: prefer incoming fields but preserve received_at if already set
      const existing = orders.find(o => String(o.order_id) === String(order.order_id));
      const merged = {
        ...(existing || {}),
        ...order,
        received_at: existing?.received_at || order.received_at || new Date().toISOString(),
      };

      // Put merged order at top, keep max 100 unique
      const updated = [merged, ...filtered].slice(0, 100);

      // Rebuild list sequentially — newest first, no Promise.all, no reverse
      await redisCommand("DEL", k(code, "orders"));
      for (const o of updated) {
        await redisCommand("RPUSH", k(code, "orders"), JSON.stringify(o));
      }

      console.log(`upsertOrderInList: order ${order.order_id} upserted for ${code}, list size ${updated.length}`);
    } catch(e) {
      console.log(`upsertOrderInList error for ${code} order ${order.order_id}:`, e.message);
    }
  });
}

async function isValidOwnerOrIosPin(code, pin) {
  const storedPin = await redisCommand("GET", k(code, "pin"));
  const storedIosPin = await redisCommand("GET", k(code, "ios_pin"));
  return storedPin.result === pin || storedIosPin.result === pin;
}

async function getTokens(code) {
  const result = await redisCommand("SMEMBERS", k(code, "device_tokens"));
  return result.result || [];
}

async function saveToken(code, token, channelId = 'foodup_default') {
  await redisCommand("SADD", k(code, "device_tokens"), token);
  await redisCommand("SET", k(code, `token_channel:${token}`), channelId);
}

async function removeToken(code, token) {
  await redisCommand("SREM", k(code, "device_tokens"), token);
  await redisCommand("DEL", k(code, `token_channel:${token}`));
}

async function getOrderAcceptanceState(code, orderId) {
  const rejected = await redisCommand("GET", k(code, `rejected_time:${orderId}`));
  if (rejected.result) {
    return { accepted: false, rejected: true, message: "Order was rejected by restaurant owner" };
  }

  const accepted = await redisCommand("GET", k(code, `accepted_time:${orderId}`));
  if (!accepted.result) {
    return { accepted: false, rejected: false, message: "Order is waiting for restaurant confirmation" };
  }

  return { accepted: true, rejected: false, message: "Order accepted" };
}

// -------------------------------------------------------
// RATE LIMITER
// -------------------------------------------------------

const rateLimitStore = {};
const autoSettingsCache = {};

function rateLimit(ip, action, maxAttempts = 5, windowMs = 15 * 60 * 1000) {
  const key = `${action}:${ip}`;
  const now = Date.now();
  if (!rateLimitStore[key]) {
    rateLimitStore[key] = { attempts: 0, firstAttempt: now, blockedUntil: null };
  }
  const record = rateLimitStore[key];

  // If blocked, check if block has expired
  if (record.blockedUntil) {
    if (now < record.blockedUntil) {
      const minutesLeft = Math.ceil((record.blockedUntil - now) / 60000);
      return { allowed: false, blocked: true, minutesLeft, attemptsLeft: 0 };
    } else {
      // Block expired, reset
      rateLimitStore[key] = { attempts: 0, firstAttempt: now, blockedUntil: null };
      return { allowed: true, blocked: false, attemptsLeft: maxAttempts - 1 };
    }
  }

  // Reset window if expired
  if (now - record.firstAttempt > windowMs) {
    rateLimitStore[key] = { attempts: 1, firstAttempt: now, blockedUntil: null };
    return { allowed: true, blocked: false, attemptsLeft: maxAttempts - 1 };
  }

  record.attempts++;

  if (record.attempts > maxAttempts) {
    record.blockedUntil = now + windowMs;
    return { allowed: false, blocked: true, minutesLeft: 15, attemptsLeft: 0 };
  }

  return { allowed: true, blocked: false, attemptsLeft: maxAttempts - record.attempts };
}

// Clean up old rate limit records every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(rateLimitStore)) {
    const record = rateLimitStore[key];
    const expired = record.blockedUntil ? now > record.blockedUntil + 60000 : now - record.firstAttempt > 16 * 60 * 1000;
    if (expired) delete rateLimitStore[key];
  }
}, 30 * 60 * 1000);

// -------------------------------------------------------
// RESTAURANT REGISTRATION
// -------------------------------------------------------

app.post("/register-restaurant", async (req, res) => {
  const { restaurant_code, pin } = req.body;
  if (!restaurant_code || !pin) {
    return res.json({ success: false, message: "Restaurant code and PIN required" });
  }
  const code = restaurant_code.toLowerCase().trim();
  const existing = await redisCommand("GET", k(code, "pin"));
  if (existing.result) {
    return res.json({ success: true, exists: true, message: "Restaurant already registered" });
  }
  await redisCommand("SET", k(code, "pin"), pin);
  await redisCommand("SADD", "restaurants", code);
  console.log("New restaurant registered:", code);
  res.json({ success: true, exists: false, message: "Restaurant registered successfully" });
});

app.post("/verify-restaurant", async (req, res) => {
  const { restaurant_code } = req.body;
  if (!restaurant_code) {
    return res.json({ success: false, message: "Restaurant code required" });
  }
  const code = restaurant_code.toLowerCase().trim();
  const existing = await redisCommand("GET", k(code, "pin"));
  if (existing.result) {
    res.json({ success: true, message: "Restaurant found" });
  } else {
    res.json({ success: false, message: "Restaurant not found" });
  }
});

// -------------------------------------------------------
// PUSH NOTIFICATIONS
// -------------------------------------------------------

app.post("/register-token", async (req, res) => {
  const { token, restaurant_code, channel_id } = req.body;
  const code = restaurant_code?.toLowerCase().trim();

  if (!code) return res.json({ success: false, message: "Restaurant code required" });
  if (!token) return res.json({ success: false, message: "Token required" });

  console.log("Registering token for:", code, "channel:", channel_id || 'foodup_default');

  // Remove this token from all other restaurants first
  try {
    const allRestaurants = await redisCommand("SMEMBERS", "restaurants");
    const others = (allRestaurants.result || []).filter(function(r) { return r !== code; });

    await Promise.all(others.map(async function(otherCode) {
      const members = await redisCommand("SMEMBERS", k(otherCode, "device_tokens"));
      if (members.result && members.result.includes(token)) {
        await removeToken(otherCode, token);
        console.log("Removed duplicate token from " + otherCode);
      }
    }));
  } catch (e) {
    console.log("Error cleaning duplicate tokens:", e);
  }

  await saveToken(code, token, channel_id || 'foodup_default');
  res.json({ success: true });
});

app.post("/unregister-token", async (req, res) => {
  const { token, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();

  if (!code) return res.json({ success: false, message: "Restaurant code required" });
  if (!token) return res.json({ success: false, message: "Token required" });

  await removeToken(code, token);
  console.log("Unregistered token for:", code);
  res.json({ success: true });
});

app.post("/new-order", async (req, res) => {
  const order = req.body;
  const code = order.restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });

  // Idempotency guard: if a new_order push was already sent for this order_id in the
  // last 60 seconds, suppress this call. Protects against duplicate webhook calls no
  // matter what causes them (checkout hook races, retries, etc.) — the backend no
  // longer blindly trusts WordPress to only call this once.
  const dedupeKey = k(code, `new_order_sent:${order.order_id}`);
  const claimed = await redisCommand("SET", dedupeKey, "1", "NX", "EX", 60);
  if (!claimed.result) {
    console.log(`Duplicate /new-order suppressed for ${code} order ${order.order_id}`);
    return res.json({ success: true, duplicate: true });
  }

  console.log("New order received for:", code, order.order_id);
  console.log("Order date:", order.orderable_order_date, "Order time:", order.orderable_order_time);
  if (!order.date_created) {
    order.date_created = new Date().toISOString();
  }
  order.received_at = new Date().toISOString();
await redisCommand("SET", k(code, "last_order"), JSON.stringify(order));
  await upsertOrderInList(code, order);
  const deviceTokens = await getTokens(code);
  if (deviceTokens.length === 0) {
    return res.json({ success: false, message: "No device tokens registered" });
  }

  let itemsString = '[]';
  try {
    const safeItems = (order.items || []).map(item => ({
      name: String(item.name || ''),
      variation: String(item.variation || ''),
      quantity: Number(item.quantity || 0),
      total: Number(item.total || 0),
      addons: (item.addons || []).map(a => ({
        label: String(a.label || ''),
        value: String(a.value || ''),
      })),
    }));
    itemsString = JSON.stringify(safeItems);
  } catch(e) {
    console.log("Items parse error:", e.message);
  }

 const tokenChannels = {};
  await Promise.all(deviceTokens.map(async token => {
    const ch = await redisCommand("GET", k(code, `token_channel:${token}`));
    tokenChannels[token] = ch.result || 'foodup_default';
  }));

  const messages = deviceTokens.map(token => ({
    to: token,
    sound: order.sound === false ? null : "default",
    title: `🛒 New Order #${order.order_id}`,
    body: `${order.customer_name} - ${order.currency} ${order.total}`,
    channelId: order.sound === false ? 'foodup_default' : (tokenChannels[token] || 'foodup_default'),
    data: {
      restaurant_code: code,
      order_id: String(order.order_id || ''),
      customer_name: String(order.customer_name || ''),
      customer_email: String(order.customer_email || ''),
      customer_phone: String(order.customer_phone || ''),
      total: String(order.total || ''),
      currency: String(order.currency || ''),
      status: String(order.status || ''),
      items: itemsString,
      payment_method: String(order.payment_method || ''),
      note: String(order.note || ''),
      shipping_method: String(order.shipping && order.shipping.method ? order.shipping.method : ''),
      shipping_address: String(order.shipping && order.shipping.address ? order.shipping.address : ''),
      event_type: String(order.event_type || 'new_order'),
      orderable_order_date: String(order.orderable_order_date || ''),
      orderable_order_time: String(order.orderable_order_time || ''),
      date_created: String(order.date_created || ''),
      sent_at: new Date().toISOString(),
    },
  }));

  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(messages),
  });

  const result = await response.json();
console.log("Push result:", JSON.stringify(result));

// Remove invalid tokens based on Expo response
if (result.data) {
  for (let i = 0; i < result.data.length; i++) {
    if (result.data[i].status === 'error' && result.data[i].details && result.data[i].details.error === 'DeviceNotRegistered') {
      const deadToken = deviceTokens[i];
      if (deadToken) {
        await removeToken(code, deadToken);
        console.log("Removed dead token:", deadToken);
      }
    }
  }
}

res.json({ success: true, result });
});

app.post("/status-update", async (req, res) => {
  const order = req.body;
  const code = order.restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });

  console.log("Status update for:", code, order.order_id, order.status);
console.log("Full order data:", JSON.stringify(order));

// Update order status in orders list
  await upsertOrderInList(code, order);

  const deviceTokens = await getTokens(code);
  if (deviceTokens.length === 0) return res.json({ success: false });

  let itemsString = '[]';
  try {
    const safeItems = (order.items || []).map(item => ({
      name: String(item.name || ''),
      variation: String(item.variation || ''),
      quantity: Number(item.quantity || 0),
      total: Number(item.total || 0),
      addons: (item.addons || []).map(a => ({
        label: String(a.label || ''),
        value: String(a.value || ''),
      })),
    }));
    itemsString = JSON.stringify(safeItems);
  } catch(e) {}

  const messages = deviceTokens.map(token => ({
    to: token,
    sound: null,
    title: `Order #${order.order_id} updated`,
    body: `Status: ${order.status}`,
    data: {
      restaurant_code: code,
      order_id: String(order.order_id || ''),
      customer_name: String(order.customer_name || ''),
      customer_email: String(order.customer_email || ''),
      customer_phone: String(order.customer_phone || ''),
      total: String(order.total || ''),
      currency: String(order.currency || ''),
      status: String(order.status || ''),
      items: itemsString,
      payment_method: String(order.payment_method || ''),
      note: String(order.note || ''),
      shipping_method: String(order.shipping && order.shipping.method ? order.shipping.method : ''),
      shipping_address: String(order.shipping && order.shipping.address ? order.shipping.address : ''),
      event_type: 'status_update',
    },
  }));

  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(messages),
  });

  res.json({ success: true });
});

// -------------------------------------------------------
// PIN
// -------------------------------------------------------

app.post("/change-pin", async (req, res) => {
  const { restaurant_code, current_pin, new_pin } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });
  const stored = await redisCommand("GET", k(code, "pin"));
  if (!stored.result || stored.result !== current_pin) {
    return res.json({ success: false, message: "Incorrect current PIN" });
  }
  await redisCommand("SET", k(code, "pin"), new_pin);
  res.json({ success: true });
});

app.post("/verify-pin", async (req, res) => {
  const { pin, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const limit = rateLimit(ip, `verify-pin:${code}`);
  if (!limit.allowed) {
    return res.json({
      success: false,
      rate_limited: true,
      message: limit.blocked
        ? `Too many failed attempts. Try again in ${limit.minutesLeft} minute${limit.minutesLeft > 1 ? 's' : ''}.`
        : 'Rate limit exceeded.',
      minutes_left: limit.minutesLeft,
    });
  }

  const stored = await redisCommand("GET", k(code, "pin"));
  if (stored.result && stored.result === pin) {
    // Reset rate limit on success
    const key = `verify-pin:${code}:${ip}`;
    delete rateLimitStore[key];
    res.json({ success: true });
  } else {
    res.json({
      success: false,
      rate_limited: false,
      attempts_left: limit.attemptsLeft,
      message: limit.attemptsLeft <= 2
        ? `Incorrect PIN. ${limit.attemptsLeft} attempt${limit.attemptsLeft !== 1 ? 's' : ''} left before 15 minute lockout.`
        : 'Incorrect PIN.',
    });
  }
});

app.post("/verify-ios-pin", async (req, res) => {
  const { ios_pin, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const limit = rateLimit(ip, `verify-ios-pin:${code}`);
  if (!limit.allowed) {
    return res.json({
      success: false,
      rate_limited: true,
      message: `Too many failed attempts. Try again in ${limit.minutesLeft} minute${limit.minutesLeft > 1 ? 's' : ''}.`,
      minutes_left: limit.minutesLeft,
    });
  }

  const stored = await redisCommand("GET", k(code, "ios_pin"));
  if (!stored.result) return res.json({ success: false, message: "iOS PIN not set" });
  if (stored.result === ios_pin) {
    res.json({ success: true });
  } else {
    res.json({
      success: false,
      rate_limited: false,
      attempts_left: limit.attemptsLeft,
      message: limit.attemptsLeft <= 2
        ? `Incorrect PIN. ${limit.attemptsLeft} attempt${limit.attemptsLeft !== 1 ? 's' : ''} left before 15 minute lockout.`
        : 'Incorrect iOS PIN.',
    });
  }
});

app.post("/set-ios-pin", async (req, res) => {
  const { restaurant_code, owner_pin, ios_pin } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });
  const storedPin = await redisCommand("GET", k(code, "pin"));
  if (!storedPin.result || storedPin.result !== owner_pin) {
    return res.json({ success: false, message: "Unauthorized" });
  }
  await redisCommand("SET", k(code, "ios_pin"), ios_pin);
  res.json({ success: true });
});

// -------------------------------------------------------
// DELIVERY ACCOUNTS
// -------------------------------------------------------

app.post("/add-delivery-account", async (req, res) => {
  const { username, password, restaurant_code, owner_pin, phone } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });

  if (!await isValidOwnerOrIosPin(code, owner_pin)) {
    return res.json({ success: false, message: "Unauthorized" });
  }
  if (!username || !password) {
    return res.json({ success: false, message: "Username and password required" });
  }
  const existing = await redisCommand("GET", k(code, `delivery_account:${username.toLowerCase()}`));
  if (existing.result) {
    return res.json({ success: false, message: "Username already exists" });
  }
  await redisCommand("SET", k(code, `delivery_account:${username.toLowerCase()}`), JSON.stringify({
    username, password, phone: phone || '', created_at: new Date().toISOString(),
  }));
  await redisCommand("SADD", k(code, "delivery_accounts"), username.toLowerCase());
  res.json({ success: true });
});

app.post("/verify-delivery-account", async (req, res) => {
  const { username, password, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const limit = rateLimit(ip, `verify-delivery:${code}:${username?.toLowerCase()}`);
  if (!limit.allowed) {
    return res.json({
      success: false,
      rate_limited: true,
      message: `Too many failed attempts. Try again in ${limit.minutesLeft} minute${limit.minutesLeft > 1 ? 's' : ''}.`,
      minutes_left: limit.minutesLeft,
    });
  }

  const data = await redisCommand("GET", k(code, `delivery_account:${username.toLowerCase()}`));
  if (!data.result) return res.json({ success: false, message: "Account not found" });

  const account = JSON.parse(data.result);
  if (account.password === password) {
    // Reset courier login rate limit on successful login
    const key = `verify-delivery:${code}:${username.toLowerCase()}:${ip}`;
    delete rateLimitStore[key];

    res.json({ success: true, username: account.username });
  } else {
    res.json({
      success: false,
      rate_limited: false,
      attempts_left: limit.attemptsLeft,
      message: limit.attemptsLeft <= 2
        ? `Incorrect password. ${limit.attemptsLeft} attempt${limit.attemptsLeft !== 1 ? 's' : ''} left before 15 minute lockout.`
        : 'Incorrect password.',
    });
  }
});

app.get("/delivery-accounts", async (req, res) => {
  const { owner_pin, restaurant_code } = req.query;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });

  if (!await isValidOwnerOrIosPin(code, owner_pin)) {
    return res.json({ success: false, message: "Unauthorized" });
  }

  const result = await redisCommand("SMEMBERS", k(code, "delivery_accounts"));
  const usernames = result.result || [];
  const accounts = await Promise.all(usernames.map(async (u) => {
    const data = await redisCommand("GET", k(code, `delivery_account:${u}`));
    return data.result ? JSON.parse(data.result) : null;
  }));
  res.json({ success: true, accounts: accounts.filter(Boolean) });
});

app.delete("/delete-delivery-account", async (req, res) => {
  const { username, owner_pin, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });

if (!await isValidOwnerOrIosPin(code, owner_pin)) {
    return res.json({ success: false, message: "Unauthorized" });
  }
  await redisCommand("DEL", k(code, `delivery_account:${username.toLowerCase()}`));
  await redisCommand("SREM", k(code, "delivery_accounts"), username.toLowerCase());
  res.json({ success: true });
});

app.get("/courier-phone/:code/:username", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const username = req.params.username.toLowerCase();
  const data = await redisCommand("GET", k(code, `delivery_account:${username}`));
  if (!data.result) return res.json({ success: false });
  const account = JSON.parse(data.result);
  res.json({ success: true, phone: account.phone || '' });
});

app.post("/change-delivery-password", async (req, res) => {
  const { username, current_password, new_password, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });
  const data = await redisCommand("GET", k(code, `delivery_account:${username.toLowerCase()}`));
  if (!data.result) return res.json({ success: false, message: "Account not found" });
  const account = JSON.parse(data.result);
  if (account.password !== current_password) {
    return res.json({ success: false, message: "Incorrect current password" });
  }
  account.password = new_password;
  await redisCommand("SET", k(code, `delivery_account:${username.toLowerCase()}`), JSON.stringify(account));
  res.json({ success: true });
});

app.get("/check-auto-accepted/:code/:order_id", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const order_id = req.params.order_id;
  const data = await redisCommand("GET", k(code, `auto_accepted:${order_id}`));
  res.json({ success: true, auto_accepted: !!data.result });
});

app.post("/cancel-auto-action", async (req, res) => {
  const { restaurant_code, order_id, owner_pin, secret } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });
  const isPlugin = secret === 'foodup2026';
  if (!isPlugin) {
    const storedPin = await redisCommand("GET", k(code, "pin"));
    if (!storedPin.result || storedPin.result !== owner_pin) {
      return res.json({ success: false, message: "Unauthorized" });
    }
  }
  console.log(`Cancel auto-action for: ${code} order ${order_id}`);
  await redisCommand("SET", k(code, `auto_actioned:${order_id}`), 'yes');
  await redisCommand("EXPIRE", k(code, `auto_actioned:${order_id}`), 86400);
  res.json({ success: true });
});

app.post("/update-delivery-phone", async (req, res) => {
  const { username, phone, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });
  const data = await redisCommand("GET", k(code, `delivery_account:${username.toLowerCase()}`));
  if (!data.result) return res.json({ success: false, message: "Account not found" });
  const account = JSON.parse(data.result);
  account.phone = phone;
  await redisCommand("SET", k(code, `delivery_account:${username.toLowerCase()}`), JSON.stringify(account));
  res.json({ success: true });
});

app.post("/reset-delivery-password", async (req, res) => {
  const { username, new_password, owner_pin, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });

if (!await isValidOwnerOrIosPin(code, owner_pin)) {
    return res.json({ success: false, message: "Unauthorized" });
  }
  const data = await redisCommand("GET", k(code, `delivery_account:${username.toLowerCase()}`));
  if (!data.result) return res.json({ success: false, message: "Account not found" });

  const account = JSON.parse(data.result);
  account.password = new_password;
  await redisCommand("SET", k(code, `delivery_account:${username.toLowerCase()}`), JSON.stringify(account));
  res.json({ success: true });
});

app.get("/delivery-accounts-ios", async (req, res) => {
  const { ios_pin, restaurant_code } = req.query;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });

  const storedPin = await redisCommand("GET", k(code, "ios_pin"));
  if (!storedPin.result || storedPin.result !== ios_pin) {
    return res.json({ success: false, message: "Unauthorized" });
  }
  const result = await redisCommand("SMEMBERS", k(code, "delivery_accounts"));
  const usernames = result.result || [];
  const accounts = await Promise.all(usernames.map(async (u) => {
    const data = await redisCommand("GET", k(code, `delivery_account:${u}`));
    return data.result ? JSON.parse(data.result) : null;
  }));
  res.json({ success: true, accounts: accounts.filter(Boolean) });
});

// -------------------------------------------------------
// DELIVERY TRACKING
// -------------------------------------------------------

app.post("/mark-delivered", async (req, res) => {
  const { order_id, delivery_name, restaurant_code, order_data } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });

  const acceptance = await getOrderAcceptanceState(code, order_id);
  if (!acceptance.accepted) {
    return res.json({
      success: false,
      not_accepted: true,
      rejected: acceptance.rejected,
      message: acceptance.message,
    });
  }

  const deliveredAt = new Date().toISOString();

await redisCommand("SET", k(code, `delivered:${order_id}`), JSON.stringify({
    order_id, delivery_name, delivered_at: deliveredAt, ...(order_data || {}),
  }));
  await redisCommand("SADD", k(code, "delivered_orders"), String(order_id));
  await redisCommand("SREM", k(code, "active_claims"), String(order_id));
  await redisCommand("DEL", k(code, `claimed:${order_id}`));

  const courierKey = k(code, `courier_delivered:${delivery_name}`);
  const stored = await redisCommand("GET", courierKey);
  let history = stored.result ? JSON.parse(stored.result) : [];

  // Add new entry
  history.unshift({ order_id, delivered_at: deliveredAt, ...(order_data || {}) });

  // Auto-clean orders older than 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  history = history.filter(o => new Date(o.delivered_at) > thirtyDaysAgo);

await redisCommand("SET", courierKey, JSON.stringify(history));
  res.json({ success: true });
});

app.get("/all-couriers-delivered/:code", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  try {
    const accountsResult = await redisCommand("SMEMBERS", k(code, "delivery_accounts"));
    const couriers = accountsResult.result || [];
    const result = {};
    await Promise.all(couriers.map(async (name) => {
      // Try original name first, then capitalized
      let stored = await redisCommand("GET", k(code, `courier_delivered:${name}`));
      if (!stored.result) {
        const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
        stored = await redisCommand("GET", k(code, `courier_delivered:${capitalized}`));
      }
      const displayName = name.charAt(0).toUpperCase() + name.slice(1);
      result[displayName] = stored.result ? JSON.parse(stored.result) : [];
    }));
    res.json({ success: true, couriers: result });
  } catch(e) {
    res.json({ success: false, couriers: {} });
  }
});

app.get("/courier-delivered/:code/:name", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const name = req.params.name;
  const stored = await redisCommand("GET", k(code, `courier_delivered:${name}`));
  const history = stored.result ? JSON.parse(stored.result) : [];
  res.json({ success: true, delivered: history });
});

app.get("/clear-courier-delivered/:code/:name", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const name = req.params.name;
  await redisCommand("DEL", k(code, `courier_delivered:${name}`));
  res.json({ success: true });
});

// Remove single order from courier delivered history
app.post("/remove-delivered", async (req, res) => {
  const { order_id, delivery_name, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });

  const courierKey = k(code, `courier_delivered:${delivery_name}`);
  const stored = await redisCommand("GET", courierKey);
  if (!stored.result) return res.json({ success: true });

  const history = JSON.parse(stored.result);
  const filtered = history.filter(o => String(o.order_id) !== String(order_id));
  await redisCommand("SET", courierKey, JSON.stringify(filtered));
  res.json({ success: true });
});

app.get("/check-delivered/:code/:id", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const data = await redisCommand("GET", k(code, `delivered:${req.params.id}`));
  if (data.result) {
    res.json({ success: true, delivered: true, info: JSON.parse(data.result) });
  } else {
    res.json({ success: true, delivered: false });
  }
});

app.post("/claim-order", async (req, res) => {
  const { order_id, delivery_name, restaurant_code, delivery_status } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });

  const acceptance = await getOrderAcceptanceState(code, order_id);
  if (!acceptance.accepted) {
    return res.json({
      success: false,
      not_accepted: true,
      rejected: acceptance.rejected,
      message: acceptance.message,
    });
  }

  const existing = await redisCommand("GET", k(code, `claimed:${order_id}`));
  if (existing.result) {
    const claim = JSON.parse(existing.result);
    // Only reject if claimed by a DIFFERENT courier
    if (claim.delivery_name !== delivery_name) {
      return res.json({ success: false, message: `Already being delivered by ${claim.delivery_name}` });
    }
  }
  console.log("Claiming order:", order_id, "delivery_status:", delivery_status);
  await redisCommand("SET", k(code, `claimed:${order_id}`), JSON.stringify({
    order_id, delivery_name, claimed_at: new Date().toISOString(), delivery_status: delivery_status || 'in_bag',
  }));
  await redisCommand("SADD", k(code, "active_claims"), String(order_id));
  res.json({ success: true });
});

app.get("/check-claimed/:code/:id", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const data = await redisCommand("GET", k(code, `claimed:${req.params.id}`));
  if (data.result) {
    res.json({ success: true, claimed: true, info: JSON.parse(data.result) });
  } else {
    res.json({ success: true, claimed: false });
  }
});

app.post("/release-claim", async (req, res) => {
  const { order_id, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });
  await redisCommand("DEL", k(code, `claimed:${order_id}`));
  await redisCommand("SREM", k(code, "active_claims"), String(order_id));
  res.json({ success: true });
});

app.get("/order/:code/:id", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const orderId = req.params.id;
  try {
    const data = await redisCommand("GET", k(code, "last_order"));
    if (data.result) {
      const order = JSON.parse(data.result);
      if (String(order.order_id) === String(orderId)) {
        const listData = await redisCommand("LRANGE", k(code, "orders"), 0, 99);
        const orders = (listData.result || []).map((o) => JSON.parse(o));
        const found = orders.find((o) => String(o.order_id) === String(orderId));
        if (found) return res.json({ success: true, order: found });
        return res.json({ success: true, order });
      }
    }
    const listData = await redisCommand("LRANGE", k(code, "orders"), 0, 99);
    const orders = (listData.result || []).map((o) => JSON.parse(o));
    const found = orders.find((o) => String(o.order_id) === String(orderId));
    if (found) {
      return res.json({ success: true, order: found });
    }
    res.json({ success: false, message: "Order not found" });
  } catch(e) {
    res.json({ success: false, message: "Error fetching order" });
  }
});

// -------------------------------------------------------
// ONE-TIME DEDUP CLEANUP
// -------------------------------------------------------

app.get("/dedup-orders/:code", async (req, res) => {
  const { secret } = req.query;
  const adminSecret = process.env.ADMIN_SECRET || 'foodup2026';
  if (secret !== adminSecret) return res.json({ success: false, message: 'Unauthorized' });
  const code = req.params.code.toLowerCase().trim();
  try {
    const listData = await redisCommand("LRANGE", k(code, "orders"), 0, 99);
    const orders = (listData.result || []).map(o => {
      try { return JSON.parse(o); } catch(e) { return null; }
    }).filter(Boolean);

    const seen = new Set();
    const deduped = [];
    for (const order of orders) {
      const id = String(order.order_id);
      if (!seen.has(id)) {
        seen.add(id);
        deduped.push(order);
      }
    }

    // Rebuild list sequentially — preserves order, no Promise.all, no reverse
    await redisCommand("DEL", k(code, "orders"));
    for (const o of deduped) {
      await redisCommand("RPUSH", k(code, "orders"), JSON.stringify(o));
    }

    console.log(`dedup-orders: ${code} before=${orders.length} after=${deduped.length}`);
    res.json({
      success: true,
      before: orders.length,
      after: deduped.length,
      freed: orders.length - deduped.length,
    });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

// -------------------------------------------------------
// ORDERS LIST
// -------------------------------------------------------

app.get("/orders/:code", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  try {
    const result = await redisCommand("LRANGE", k(code, "orders"), 0, 99);
    const orders = (result.result || []).map(o => JSON.parse(o));
    res.json({ success: true, orders });
  } catch(e) {
    res.json({ success: false, orders: [] });
  }
});

// -------------------------------------------------------
// GET ALL CLAIMS
// -------------------------------------------------------

app.get("/claims/:code", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const debug = req.query.debug === '1';
  try {
    const claims = {};
    const debugInfo = {
      deliveredSetCount: 0,
      couriers: [],
      courierHistoryCounts: {},
      layer2Added: [],
      activeClaimIds: [],
    };

    // Layer 1: delivered_orders Set (post-patch deliveries)
    const deliveredIdsResult = await redisCommand("SMEMBERS", k(code, "delivered_orders"));
    const deliveredIds = deliveredIdsResult.result || [];
    debugInfo.deliveredSetCount = deliveredIds.length;
    await Promise.all(deliveredIds.map(async (orderId) => {
      const deliveredData = await redisCommand("GET", k(code, `delivered:${orderId}`));
      if (deliveredData.result) {
        const delivered = JSON.parse(deliveredData.result);
        claims[String(delivered.order_id || orderId)] = {
          name: delivered.delivery_name,
          status: 'delivered',
          delivered_at: delivered.delivered_at || '',
        };
      } else {
        await redisCommand("SREM", k(code, "delivered_orders"), String(orderId));
      }
    }));

    // Layer 2: courier delivered history fallback (pre-patch deliveries)
    const accountsResult = await redisCommand("SMEMBERS", k(code, "delivery_accounts"));
    const couriers = accountsResult.result || [];
    debugInfo.couriers = couriers;
    await Promise.all(couriers.map(async (name) => {
      let stored = await redisCommand("GET", k(code, `courier_delivered:${name}`));
      if (!stored.result) {
        const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
        stored = await redisCommand("GET", k(code, `courier_delivered:${capitalized}`));
      }
      const history = stored.result ? JSON.parse(stored.result) : [];
      const displayName = name.charAt(0).toUpperCase() + name.slice(1);
      debugInfo.courierHistoryCounts[displayName] = history.length;
      await Promise.all(history.map(async (entry) => {
        const oid = String(entry.order_id);
        const courierName = entry.delivery_name || displayName;
        if (!claims[oid] || claims[oid].name === 'Owner') {
          claims[oid] = {
            name: courierName,
            status: 'delivered',
            delivered_at: entry.delivered_at || '',
          };
          debugInfo.layer2Added.push(oid);
        }
        await redisCommand("SADD", k(code, "delivered_orders"), oid);
        const deliveredData = await redisCommand("GET", k(code, `delivered:${oid}`));
        let shouldUpdateDeliveredKey = false;
        if (!deliveredData.result) {
          shouldUpdateDeliveredKey = true;
        } else {
          try {
            const existing = JSON.parse(deliveredData.result);
            if (!existing.delivery_name || existing.delivery_name === 'Owner') {
              shouldUpdateDeliveredKey = true;
            }
          } catch(e) {
            shouldUpdateDeliveredKey = true;
          }
        }
        if (shouldUpdateDeliveredKey) {
          await redisCommand("SET", k(code, `delivered:${oid}`), JSON.stringify({
            ...entry,
            order_id: oid,
            delivery_name: courierName,
            delivered_at: entry.delivered_at || new Date().toISOString(),
          }));
        }
      }));
    }));

    // Layer 3: active claims — never override delivered
    const claimMembers = await redisCommand("SMEMBERS", k(code, "active_claims"));
    const claimIds = claimMembers.result || [];
    debugInfo.activeClaimIds = claimIds;
    await Promise.all(claimIds.map(async (orderId) => {
      const data = await redisCommand("GET", k(code, `claimed:${orderId}`));
      if (data.result) {
        const claim = JSON.parse(data.result);
        const oid = String(claim.order_id || orderId);
        if (!claims[oid] || claims[oid].status !== 'delivered') {
          claims[oid] = { name: claim.delivery_name, status: claim.delivery_status || 'in_bag' };
        }
      } else {
        await redisCommand("SREM", k(code, "active_claims"), String(orderId));
      }
    }));

    res.json(debug ? { success: true, claims, debug: debugInfo } : { success: true, claims });
  } catch(e) {
    console.log("Claims error:", e.message);
    res.json(debug
      ? { success: false, claims: {}, debug: { error: e.message } }
      : { success: true, claims: {} }
    );
  }
});


// -------------------------------------------------------
// RESTAURANT PROFILE
// -------------------------------------------------------

app.post("/restaurant-profile", async (req, res) => {
  const { owner_pin, restaurant_code, name, phone, address, website, secret } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });

  const isPlugin = secret === 'foodup2026';
  if (!isPlugin) {
    if (!await isValidOwnerOrIosPin(code, owner_pin)) {
      return res.json({ success: false, message: "Unauthorized" });
    }
  }
  const existing = await redisCommand("GET", k(code, "restaurant_profile"));
  const current = existing.result ? JSON.parse(existing.result) : {};

const { print_logo_url, email_logo_url } = req.body;
  await redisCommand("SET", k(code, "restaurant_profile"), JSON.stringify({
    name: name !== undefined ? name : current.name,
    phone: phone !== undefined ? phone : current.phone,
    address: address !== undefined ? address : current.address,
    website: website !== undefined ? website : current.website,
    print_logo_url: print_logo_url !== undefined ? print_logo_url : current.print_logo_url,
    email_logo_url: email_logo_url !== undefined ? email_logo_url : current.email_logo_url,
    updated_at: new Date().toISOString(),
  }));
  res.json({ success: true });
});

app.get("/restaurant-profile/:code", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const data = await redisCommand("GET", k(code, "restaurant_profile"));
  if (data.result) {
    res.json({ success: true, profile: JSON.parse(data.result) });
  } else {
    res.json({ success: false });
  }
});

// -------------------------------------------------------
// ACCEPTED TIME
// -------------------------------------------------------

app.post("/accepted-time", async (req, res) => {
  const { restaurant_code, order_id, accepted_time, status, accepted_at } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });

  console.log("Accepted time for:", code, order_id, accepted_time, status);
  console.log("Accepted time caller IP:", req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  console.log("Accepted time user-agent:", req.headers['user-agent']);
  const data = {
    accepted_time,
    status,
    accepted_at: accepted_at || new Date().toISOString(),
  };
  await redisCommand("SET", k(code, `accepted_time:${order_id}`), JSON.stringify(data));
  await redisCommand("EXPIRE", k(code, `accepted_time:${order_id}`), 604800);
  res.json({ success: true });
});

app.post("/rejected-time", async (req, res) => {
  const { restaurant_code, order_id, secret } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });
  if (secret !== 'foodup2026') return res.json({ success: false, message: 'Unauthorized' });
  await redisCommand("SET", k(code, `rejected_time:${order_id}`), new Date().toISOString());
  await redisCommand("EXPIRE", k(code, `rejected_time:${order_id}`), 604800);
  res.json({ success: true });
});

app.get("/accepted-time/:code/:id", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const data = await redisCommand("GET", k(code, `accepted_time:${req.params.id}`));
  if (data.result) {
    try {
      const parsed = JSON.parse(data.result);
      res.json({ success: true, accepted_time: parsed.accepted_time, accepted_at: parsed.accepted_at });
    } catch(e) {
      res.json({ success: true, accepted_time: data.result });
    }
  } else {
    res.json({ success: false });
  }
});

// -------------------------------------------------------
// COURIER STATS
// -------------------------------------------------------

app.get("/courier-stats/:code", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  try {
    const listData = await redisCommand("LRANGE", k(code, "orders"), 0, 99);
    const orders = (listData.result || []).map((o) => JSON.parse(o));
    
const stats = {};    
    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - 7); startOfWeek.setHours(0, 0, 0, 0);
    
    await Promise.all(orders.map(async (order) => {
      const deliveredData = await redisCommand("GET", k(code, `delivered:${order.order_id}`));
      if (deliveredData.result) {
        const delivered = JSON.parse(deliveredData.result);
        const name = delivered.delivery_name;
        if (!name) return;
        
        if (!stats[name]) stats[name] = { today: 0, week: 0, total: 0 };
        
        const deliveredAt = new Date(delivered.delivered_at);
        stats[name].total++;
        if (deliveredAt >= startOfWeek) stats[name].week++;
        if (deliveredAt >= startOfDay) stats[name].today++;
      }
    }));
    
    res.json({ success: true, stats });
  } catch(e) {
    res.json({ success: false, stats: {} });
  }
});





// -------------------------------------------------------
// CLEAR ORDERS
// -------------------------------------------------------

app.delete("/clear-orders/:code", async (req, res) => {
  const { owner_pin } = req.body;
  const code = req.params.code.toLowerCase().trim();
if (!await isValidOwnerOrIosPin(code, owner_pin)) {
    return res.json({ success: false, message: "Unauthorized" });
  }
  await redisCommand("DEL", k(code, "orders"));
  await redisCommand("DEL", k(code, "last_order"));
  res.json({ success: true });
});


// -------------------------------------------------------
// ACCEPTANCE TIMES SETTINGS
// -------------------------------------------------------

app.get("/acceptance-times/:code", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const data = await redisCommand("GET", k(code, "acceptance_times"));
  if (data.result) {
    res.json({ success: true, times: JSON.parse(data.result) });
  } else {
    res.json({ success: true, times: [15, 20, 25, 30, 45, 60] });
  }
});

app.post("/acceptance-times", async (req, res) => {
  const { restaurant_code, owner_pin, times } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });if (!await isValidOwnerOrIosPin(code, owner_pin)) {
    return res.json({ success: false, message: "Unauthorized" });
  }
  await redisCommand("SET", k(code, "acceptance_times"), JSON.stringify(times));
  res.json({ success: true });
});



// -------------------------------------------------------
// STORE STATUS
// -------------------------------------------------------

app.get("/store-status/:code", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const data = await redisCommand("GET", k(code, "store_status"));
  const isOpen = data.result ? data.result === 'open' : true;
  res.json({ success: true, is_open: isOpen });
});

app.post("/store-status", async (req, res) => {
  const { restaurant_code, is_open } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });
  await redisCommand("SET", k(code, "store_status"), is_open ? 'open' : 'closed');
  res.json({ success: true, is_open });
});



// -------------------------------------------------------
// HEALTH CHECK ENDPOINT
// -------------------------------------------------------

app.get("/health-check/:code", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  try {
const [profileData, tokensData, pinData, printerData] = await Promise.all([
      redisCommand("GET", k(code, "restaurant_profile")),
      redisCommand("SMEMBERS", k(code, "device_tokens")),
      redisCommand("GET", k(code, "pin")),
      redisCommand("GET", k(code, "printer_device_id")),
    ]);

    const profile = profileData.result ? JSON.parse(profileData.result) : null;
    const tokens = tokensData.result || [];

    res.json({
      success: true,
      registered: !!pinData.result,
      tokens_count: tokens.length,
      has_tokens: tokens.length > 0,
      has_profile: !!profile,
      has_website: !!(profile?.website),
      has_print_logo: !!(profile?.print_logo_url),
      printer_device_id: printerData.result || '',
    });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

app.delete("/clear-accepted-times/:code", async (req, res) => {
  const { secret } = req.body;
  if (secret !== 'foodup2026') return res.json({ success: false, message: "Unauthorized" });
  const code = req.params.code.toLowerCase().trim();
  const keys = await redisCommand("KEYS", k(code, "accepted_time:*"));
  if (keys.result && keys.result.length > 0) {
    await Promise.all(keys.result.map(key => redisCommand("DEL", key)));
  }
  res.json({ success: true, cleared: keys.result?.length || 0 });
});


app.get("/debug-tokens/:code", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const tokens = await getTokens(code);
  res.json({ success: true, count: tokens.length, tokens });
});

// -------------------------------------------------------
// PRINTER DEVICE ID
// -------------------------------------------------------

app.post("/set-printer-device", async (req, res) => {
  const { restaurant_code, owner_pin, device_id } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });
  const storedPin = await redisCommand("GET", k(code, "pin"));
  if (!storedPin.result || storedPin.result !== owner_pin) {
    return res.json({ success: false, message: "Unauthorized" });
  }
  await redisCommand("SET", k(code, "printer_device_id"), device_id);
  res.json({ success: true });
});

app.get("/printer-device/:code", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const data = await redisCommand("GET", k(code, "printer_device_id"));
  res.json({ success: true, device_id: data.result || null });
});

// -------------------------------------------------------
// WOOCOMMERCE WEBHOOK
// -------------------------------------------------------

app.post("/wc-webhook", async (req, res) => {
  try {
    const data = req.body;
    console.log("WC Webhook received:", JSON.stringify(data).substring(0, 200));

    // Handle WooCommerce ping validation
    if (!data || !data.id) {
      res.status(200).json({ success: true });
      return;
    }

    // Find restaurant code from meta_data
    const metaData = data.meta_data || [];
    const orderableDateMeta = metaData.find(m => m.key === 'orderable_order_date');
    const orderableTimeMeta = metaData.find(m => m.key === 'orderable_order_time');
    const orderableDate = data.orderable_order_date || (orderableDateMeta ? orderableDateMeta.value : '');
    const orderableTime = data.orderable_order_time || (orderableTimeMeta ? orderableTimeMeta.value : '');

    // Get restaurant code from existing orders by order_id
    const orderId = data.id;
    const billing = data.billing || {};
    const shipping = data.shipping || {};
    const lineItems = data.line_items || [];

    // Map line items to our format
    const items = lineItems.map(item => ({
      name: item.name || '',
      quantity: item.quantity || 1,
      total: parseFloat(item.total || 0),
      addons: (item.meta_data || [])
        .filter(m => !m.key.startsWith('_'))
        .map(m => ({ label: m.display_key || m.key, value: m.display_value || m.value })),
    }));

    // Build shipping address
    const shippingAddress = [
      shipping.address_1,
      shipping.address_2,
      shipping.city,
      shipping.postcode,
    ].filter(Boolean).join(', ');

    // Get shipping method
    const shippingLines = data.shipping_lines || [];
    const shippingMethod = shippingLines.length > 0 ? shippingLines[0].method_title : '';

    // Get payment method
    const paymentMethod = data.payment_method_title || '';

    // Find restaurant code - hardcoded for now, need to match by site
    // We'll use the billing email domain or a fixed code
    const code = 'eatime'; // TODO: make dynamic if multiple restaurants

    const order = {
      restaurant_code: code,
      order_id: orderId,
      customer_name: `${billing.first_name || ''} ${billing.last_name || ''}`.trim(),
      customer_email: billing.email || '',
      customer_phone: billing.phone || '',
      total: data.total || '',
      currency: data.currency || 'CHF',
      status: data.status || '',
      event_type: 'new_order',
      items,
      payment_method: paymentMethod,
      note: data.customer_note || '',
      date_created: data.date_created || new Date().toISOString(),
      orderable_order_date: orderableDate,
      orderable_order_time: orderableTime,
      shipping: {
        method: shippingMethod,
        address: shippingAddress,
      },
      sound: true,
    };

    console.log("WC Webhook order:", orderId, "Scheduled:", orderableDate, orderableTime);

    await redisCommand("SET", k(code, "last_order"), JSON.stringify(order));
    await upsertOrderInList(code, order);

    const deviceTokens = await getTokens(code);
    if (deviceTokens.length === 0) return res.json({ success: true, message: "No tokens" });

    const itemsString = JSON.stringify(items);
    const messages = deviceTokens.map(token => ({
      to: token,
      sound: "default",
      title: `🛒 New Order #${orderId}`,
      body: `${order.customer_name} - ${order.currency} ${order.total}`,
      data: {
        restaurant_code: code,
        order_id: String(orderId),
        customer_name: order.customer_name,
        customer_email: order.customer_email,
        customer_phone: order.customer_phone,
        total: String(order.total),
        currency: order.currency,
        status: order.status,
        items: itemsString,
        payment_method: paymentMethod,
        note: order.note,
        shipping_method: shippingMethod,
        shipping_address: shippingAddress,
        event_type: 'new_order',
        orderable_order_date: orderableDate,
        orderable_order_time: orderableTime,
        date_created: order.date_created,
      },
    }));

    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(messages),
    });

    res.json({ success: true });
  } catch(e) {
    console.log("WC Webhook error:", e.message);
    res.json({ success: false });
  }
});




// -------------------------------------------------------
// DEBUG LOG
// -------------------------------------------------------

app.post("/log", async (req, res) => {
  const { message, restaurant_code } = req.body;
  console.log("APP LOG:", message);
  if (restaurant_code) {
    const code = restaurant_code.toLowerCase().trim();
    const entry = JSON.stringify({ message, ts: new Date().toISOString() });
    await redisCommand("LPUSH", k(code, "debug_logs"), entry);
    await redisCommand("LTRIM", k(code, "debug_logs"), 0, 49);
  }
  res.json({ success: true });
});

app.get("/debug-logs/:code", async (req, res) => {
  const { p } = req.query;
  const dashPassword = process.env.DASHBOARD_PASSWORD || 'foodup2026';
  if (p !== dashPassword) return res.json({ success: false, message: 'Unauthorized' });
  const code = req.params.code.toLowerCase().trim();
  const data = await redisCommand("LRANGE", k(code, "debug_logs"), 0, 49);
  const logs = (data.result || []).map(l => { try { return JSON.parse(l); } catch(e) { return { message: l, ts: '' }; } });
  res.json({ success: true, logs });
});

app.delete("/debug-logs/:code", async (req, res) => {
  const { p } = req.query;
  const dashPassword = process.env.DASHBOARD_PASSWORD || 'foodup2026';
  if (p !== dashPassword) return res.json({ success: false, message: 'Unauthorized' });
  const code = req.params.code.toLowerCase().trim();
  await redisCommand("DEL", k(code, "debug_logs"));
  res.json({ success: true });
});


// -------------------------------------------------------
// AUTO SETTINGS
// -------------------------------------------------------

app.get("/auto-settings/:code", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const data = await redisCommand("GET", k(code, "auto_settings"));
  if (data.result) {
    res.json({ success: true, settings: JSON.parse(data.result) });
  } else {
    res.json({ success: true, settings: {
      auto_action: 'disabled',
      wait_minutes: 5,
      accept_time: '30 Minutes',
      reject_reason: 'Zu beschäftigt',
    }});
  }
});

app.post("/auto-settings", async (req, res) => {
  const { restaurant_code, owner_pin, auto_action, wait_minutes, accept_time, reject_reason } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });

  const storedPin = await redisCommand("GET", k(code, "pin"));
  if (!storedPin.result || storedPin.result !== owner_pin) {
    return res.json({ success: false, message: "Unauthorized" });
  }

  await redisCommand("SET", k(code, "auto_settings"), JSON.stringify({
    auto_action: auto_action || 'disabled',
    wait_minutes: parseInt(wait_minutes) || 5,
    accept_time: accept_time || '30 Minutes',
    reject_reason: reject_reason || 'Zu beschäftigt',
  }));

  delete autoSettingsCache[code];
  res.json({ success: true });
});

app.post("/auto-accepted-notify", async (req, res) => {
  const { restaurant_code, order_id, accepted_time, items, ...orderData } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });

  console.log("Auto-accepted notify for:", code, order_id);

  const deviceTokens = await getTokens(code);
  if (deviceTokens.length === 0) return res.json({ success: false, message: "No tokens" });

  let itemsString = '[]';
  try {
    itemsString = JSON.stringify(items || []);
  } catch(e) {}

  const messages = deviceTokens.map(token => ({
    to: token,
    sound: null,
    title: `✓ Order #${order_id} auto-accepted`,
    body: `${orderData.customer_name} - ${orderData.currency} ${orderData.total}`,
    data: {
      event_type: 'auto_accepted',
      restaurant_code: code,
      order_id: String(order_id),
      accepted_time: String(accepted_time || ''),
      customer_name: String(orderData.customer_name || ''),
      customer_email: String(orderData.customer_email || ''),
      customer_phone: String(orderData.customer_phone || ''),
      total: String(orderData.total || ''),
      currency: String(orderData.currency || ''),
      payment_method: String(orderData.payment_method || ''),
      note: String(orderData.note || ''),
      shipping_method: String(orderData.shipping_method || ''),
      shipping_address: String(orderData.shipping_address || ''),
      orderable_order_date: String(orderData.orderable_order_date || ''),
      orderable_order_time: String(orderData.orderable_order_time || ''),
      date_created: String(orderData.date_created || ''),
      items: itemsString,
    },
  }));

  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(messages),
  });

  res.json({ success: true });
});

// -------------------------------------------------------
// SERVICES
// -------------------------------------------------------

const { createAlertService } = require('./alertService');
require('./pos')(app, redisCommand, k);
const posupRoutes = require('./posup');
app.use('/posup', posupRoutes);
const { startWebsiteMonitor } = require('./websiteMonitor');
const { createMonitoringRoutes } = require('./monitoring');

const alertService = createAlertService(redisCommand, k);

// -------------------------------------------------------
// MONITORING ROUTES
// -------------------------------------------------------

const dashPassword = process.env.DASHBOARD_PASSWORD || 'foodup2026';
app.use('/', createMonitoringRoutes(redisCommand, k, dashPassword));

// -------------------------------------------------------
// HEARTBEAT
// -------------------------------------------------------

app.post("/heartbeat", async (req, res) => {
  const { restaurant_code, device_id, app_version } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });

  const heartbeat = {
    last_seen: new Date().toISOString(),
    device_id: device_id || '',
    app_version: app_version || '',
  };

  await redisCommand("SET", k(code, "heartbeat"), JSON.stringify(heartbeat));
  await redisCommand("EXPIRE", k(code, "heartbeat"), 86400);
  res.json({ success: true });
});

app.get("/heartbeat/:code", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const data = await redisCommand("GET", k(code, "heartbeat"));
  if (data.result) {
    res.json({ success: true, heartbeat: JSON.parse(data.result) });
  } else {
    res.json({ success: false });
  }
});

// -------------------------------------------------------
// ALERT SETTINGS
// -------------------------------------------------------

app.post("/alert-settings", async (req, res) => {
  const { secret, alert_email, offline_threshold_minutes } = req.body;
  if (secret !== 'foodup2026') return res.json({ success: false, message: 'Unauthorized' });

  await redisCommand("SET", "alert_settings", JSON.stringify({
    alert_email: alert_email || '',
    offline_threshold_minutes: parseInt(offline_threshold_minutes) || 30,
    updated_at: new Date().toISOString(),
  }));
  res.json({ success: true });
});

app.get("/alert-settings", async (req, res) => {
  const { secret } = req.query;
  if (secret !== 'foodup2026') return res.json({ success: false, message: 'Unauthorized' });
  const data = await redisCommand("GET", "alert_settings");
  if (data.result) {
    res.json({ success: true, settings: JSON.parse(data.result) });
  } else {
    res.json({ success: true, settings: { alert_email: '', offline_threshold_minutes: 30 } });
  }
});

// -------------------------------------------------------
// DASHBOARD SETTINGS PAGE
// -------------------------------------------------------

app.get("/dashboard/settings", async (req, res) => {
  const { p } = req.query;
  const dashPassword = process.env.DASHBOARD_PASSWORD || 'foodup2026';

  if (p !== dashPassword) {
    return res.redirect('/dashboard');
  }

  const alertData = await redisCommand("GET", "alert_settings");
  const alertSettings = alertData.result ? JSON.parse(alertData.result) : { alert_email: '', offline_threshold_minutes: 30 };

  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>FoodUp Monitor - Settings</title>
<link rel="icon" href="https://eatime.ch/wp-content/uploads/2026/05/foodup-icon.png" type="image/png">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f0f0f5; min-height:100vh; }
  .topbar { background:#8B38CB; padding:16px 20px; display:flex; align-items:center; gap:12px; position:sticky; top:0; z-index:100; }
  .back-btn { background:rgba(255,255,255,0.2); border:none; color:#fff; padding:6px 12px; border-radius:20px; font-size:12px; font-weight:700; cursor:pointer; text-decoration:none; }
  .topbar h1 { color:#fff; font-size:18px; font-weight:800; }
  .content { padding:16px; max-width:600px; margin:0 auto; }
  .card { background:#fff; border-radius:14px; padding:20px; margin-bottom:16px; box-shadow:0 1px 4px rgba(0,0,0,0.06); }
  .card h3 { font-size:15px; font-weight:700; color:#111; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid #f0f0f0; }
  .field { margin-bottom:16px; }
  .field label { font-size:12px; color:#666; font-weight:600; display:block; margin-bottom:6px; }
  .field input { width:100%; padding:11px 14px; border:1px solid #ddd; border-radius:10px; font-size:14px; outline:none; }
  .field input:focus { border-color:#8B38CB; box-shadow:0 0 0 3px rgba(139,56,203,0.1); }
  .field .desc { font-size:11px; color:#999; margin-top:5px; }
  .save-btn { background:#8B38CB; color:#fff; border:none; padding:13px 20px; border-radius:10px; font-size:15px; font-weight:700; cursor:pointer; width:100%; }
  .saved-msg { text-align:center; font-size:13px; color:#2ecc71; margin-top:10px; display:none; font-weight:600; }
</style>
</head>
<body>
<div class="topbar">
  <a href="/dashboard?p=${encodeURIComponent(p)}" class="back-btn">Back</a>
  <h1>Settings</h1>
</div>
<div class="content">
  <div class="card">
    <h3>Alert Settings</h3>
    <div class="field">
      <label>Alert Email</label>
      <input type="email" id="alert_email" value="${alertSettings.alert_email}" placeholder="your@email.com" />
      <div class="desc">Receives notifications when a restaurant goes offline.</div>
    </div>
    <div class="field">
      <label>Offline Threshold (minutes)</label>
      <input type="number" id="offline_threshold" value="${alertSettings.offline_threshold_minutes}" min="5" max="120" />
      <div class="desc">How long before an alert is sent.</div>
    </div>
    <button class="save-btn" onclick="saveSettings()">Save Settings</button>
    <p class="saved-msg" id="saved_msg">Settings saved!</p>
  </div>
</div>
<script>
function saveSettings() {
  var email = document.getElementById('alert_email').value;
  var threshold = document.getElementById('offline_threshold').value;
  fetch('/alert-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'foodup2026', alert_email: email, offline_threshold_minutes: parseInt(threshold) })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.success) {
      document.getElementById('saved_msg').style.display = 'block';
      setTimeout(function() { document.getElementById('saved_msg').style.display = 'none'; }, 3000);
    }
  }).catch(function(e) { console.log(e); });
}
</script>
</body>
</html>`);
});

// -------------------------------------------------------
// DASHBOARD
// -------------------------------------------------------

app.get("/dashboard", async (req, res) => {
  const { p } = req.query;
  const dashPassword = process.env.DASHBOARD_PASSWORD || 'foodup2026';

  if (p !== dashPassword) {
    return res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>FoodUp Dashboard</title>
<link rel="icon" href="https://eatime.ch/wp-content/uploads/2026/05/foodup-icon.png" type="image/png">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f5f5f5; display:flex; align-items:center; justify-content:center; min-height:100vh; padding:20px; }
  .login-card { background:#fff; border-radius:16px; padding:32px 28px; max-width:360px; width:100%; box-shadow:0 4px 20px rgba(0,0,0,0.1); }
  .logo { text-align:center; margin-bottom:24px; }
  .logo h1 { font-size:24px; font-weight:800; color:#8B38CB; }
  .logo p { font-size:13px; color:#888; margin-top:4px; }
  input { width:100%; padding:12px 16px; border:1px solid #ddd; border-radius:10px; font-size:15px; margin-bottom:16px; outline:none; }
  input:focus { border-color:#8B38CB; }
  button { width:100%; padding:14px; background:#8B38CB; color:#fff; border:none; border-radius:10px; font-size:15px; font-weight:700; cursor:pointer; }
  .error { color:#e74c3c; font-size:13px; text-align:center; margin-top:12px; display:none; }
</style>
</head>
<body>
<div class="login-card">
  <div class="logo"><h1>FoodUp</h1><p>Restaurant Monitor Dashboard</p></div>
  <input type="password" id="pwd" placeholder="Enter dashboard password" onkeydown="if(event.key==='Enter')login()" />
  <button onclick="login()">Login</button>
  <p class="error" id="err">Incorrect password. Try again.</p>
</div>
<script>
function login() {
  var pwd = document.getElementById('pwd').value;
  if (pwd) window.location.href = '/dashboard?p=' + encodeURIComponent(pwd);
  else document.getElementById('err').style.display = 'block';
}
</script>
</body>
</html>`);
  }

  const restaurantsResult = await redisCommand("SMEMBERS", "restaurants");
  const restaurants = restaurantsResult.result || [];

  const restaurantData = await Promise.all(restaurants.map(async (code) => {
    try {
      const [heartbeatData, tokensData, ordersData, profileData, printerData] = await Promise.all([
        redisCommand("GET", k(code, "heartbeat")),
        redisCommand("SMEMBERS", k(code, "device_tokens")),
        redisCommand("LRANGE", k(code, "orders"), 0, 99),
        redisCommand("GET", k(code, "restaurant_profile")),
        redisCommand("GET", k(code, "printer_device_id")),
      ]);

      const heartbeat = heartbeatData.result ? JSON.parse(heartbeatData.result) : null;
      const tokens = tokensData.result || [];
      const orders = (ordersData.result || []).map(o => JSON.parse(o));
      const profile = profileData.result ? JSON.parse(profileData.result) : null;

      const today = new Date();
      today.setHours(0, 0, 0, 0);

const todayOrdersList = orders.filter(o => {
        const ts = o.received_at || o.date_created;
        if (!ts) return false;
        return new Date(ts.replace(' ', 'T')) >= today;
      }).sort((a,b) => {
        const ta = new Date((a.received_at || a.date_created).replace(' ','T'));
        const tb = new Date((b.received_at || b.date_created).replace(' ','T'));
        return tb - ta;
      });

      const ordersToday = todayOrdersList.length;
      const revenueToday = todayOrdersList.reduce((sum, o) => sum + parseFloat(o.total || 0), 0);

let lastOrderTime = null;
      for (const o of orders) {
        const ts = o.received_at || o.date_created;
        if (!ts) continue;
        const t = new Date(ts.replace(' ', 'T'));
        if (!lastOrderTime || t > lastOrderTime) lastOrderTime = t;
      }

      let appStatus = 'never';
      let appMinutesAgo = null;
      if (heartbeat && heartbeat.last_seen) {
        appMinutesAgo = Math.floor((Date.now() - new Date(heartbeat.last_seen).getTime()) / 60000);
        if (appMinutesAgo < 10) appStatus = 'online';
        else if (appMinutesAgo < 30) appStatus = 'idle';
        else appStatus = 'offline';
      }

      return {
        code,
        name: (profile && profile.name) ? profile.name : code,
        website: (profile && profile.website) ? profile.website : '',
        appStatus,
        appMinutesAgo,
        tokens: tokens.length,
        ordersToday,
        lastOrderTime,
        hasPrinter: !!printerData.result,
        todayOrdersList,
        revenueToday,
      };
    } catch(e) {
      return { code, name: code, appStatus: 'unknown', tokens: 0, ordersToday: 0, todayOrdersList: [], revenueToday: 0 };
    }
  }));

  const offlineCount = restaurantData.filter(r => r.appStatus === 'offline' || r.appStatus === 'never').length;
  const totalOrdersToday = restaurantData.reduce((s,r) => s + r.ordersToday, 0);

  // Build order data for JS - do it server side safely
  const orderDataForJS = {};
  restaurantData.forEach(r => {
    (r.todayOrdersList || []).forEach(o => {
      orderDataForJS[o.order_id] = {
        order_id: o.order_id,
        customer_name: o.customer_name || '',
        customer_phone: o.customer_phone || '',
        customer_email: o.customer_email || '',
        total: o.total || '',
        currency: o.currency || 'CHF',
        status: o.status || '',
        payment_method: o.payment_method || '',
        note: o.note || '',
        orderable_order_date: o.orderable_order_date || '',
        orderable_order_time: o.orderable_order_time || '',
        shipping: o.shipping || {},
        shipping_method: (o.shipping && o.shipping.method) ? o.shipping.method : '',
        shipping_address: (o.shipping && o.shipping.address) ? o.shipping.address : '',
        items: o.items || [],
      };
    });
  });

  // Build restaurant cards HTML server side
  const sortedRestaurants = [...restaurantData].sort((a,b) => {
    const order = {offline:0, never:1, idle:2, online:3, unknown:4};
    return (order[a.appStatus]||4) - (order[b.appStatus]||4);
  });

  const cardsHtml = sortedRestaurants.map((r, idx) => {
    const appTime = r.appMinutesAgo !== null
      ? (r.appMinutesAgo < 60 ? r.appMinutesAgo + ' min ago' : Math.floor(r.appMinutesAgo/60) + 'h ' + (r.appMinutesAgo%60) + 'm ago')
      : 'Never';
    const lastOrderStr = r.lastOrderTime
      ? (() => {
          const m = Math.floor((Date.now() - new Date(r.lastOrderTime).getTime()) / 60000);
          return m < 60 ? m + ' min ago' : m < 1440 ? Math.floor(m/60) + 'h ago' : Math.floor(m/1440) + 'd ago';
        })()
      : 'No orders';
    const previewLastOrder = r.lastOrderTime
      ? (() => {
          const m = Math.floor((Date.now() - new Date(r.lastOrderTime).getTime()) / 60000);
          return m < 60 ? m + 'm ago' : m < 1440 ? Math.floor(m/60) + 'h ago' : Math.floor(m/1440) + 'd ago';
        })()
      : 'none';
    const statusLabel = r.appStatus === 'online' ? 'Online' : r.appStatus === 'idle' ? 'Idle' : r.appStatus === 'never' ? 'Never Seen' : 'Offline';
    const todayOrders = r.todayOrdersList || [];

    let ordersHtml = '<div class="no-orders">No orders today</div>';
    if (todayOrders.length > 0) {
      ordersHtml = todayOrders.slice(0,5).map(o => {
        const mins = o.date_created ? Math.floor((Date.now() - new Date(o.date_created.replace(' ','T')).getTime()) / 60000) : null;
        const timeStr = mins !== null ? (mins < 60 ? mins + ' min ago' : Math.floor(mins/60) + 'h ago') : '';
        return '<div class="order-row" onclick="showOrder(\'' + String(o.order_id) + '\')">'
          + '<div><div class="order-id">#' + o.order_id + '</div><div class="order-customer">' + (o.customer_name||'') + '</div></div>'
          + '<div style="text-align:right"><div class="order-amount">' + (o.currency||'CHF') + ' ' + (o.total||'') + '</div><div class="order-time">' + timeStr + ' ></div></div>'
          + '</div>';
      }).join('');
      if (todayOrders.length > 5) ordersHtml += '<div class="no-orders">+' + (todayOrders.length-5) + ' more</div>';
    }

    return '<div class="restaurant-card" data-status="' + r.appStatus + '" data-name="' + (r.name||r.code).toLowerCase() + '" data-orders="' + r.ordersToday + '" data-lastseen="' + (r.appMinutesAgo !== null ? r.appMinutesAgo : 99999) + '" data-code="' + r.code + '">'
      + '<div class="card-header" onclick="toggleCard(' + idx + ')">'
      + '<div class="card-header-left">'
      + '<div class="status-dot ' + r.appStatus + '"></div>'
      + '<div>'
      + '<div class="card-name">' + (r.name||r.code) + '</div>'
      + '<div class="card-meta">' + r.code + (r.website ? ' - ' + r.website : '') + '</div>'
      + '<div class="card-preview">' + r.ordersToday + ' orders - CHF ' + (r.revenueToday ? r.revenueToday.toFixed(2) : '0.00') + ' - Last: ' + previewLastOrder + '</div>'
      + '</div></div>'
      + '<div class="card-right"><span class="status-badge ' + r.appStatus + '">' + statusLabel + '</span><span class="chevron" id="chevron-' + idx + '">v</span></div>'
      + '</div>'
      + '<div class="card-body" id="body-' + idx + '">'
      + '<div class="stats-grid">'
      + '<div class="stat-box"><div class="stat-label">App Last Seen</div><div class="stat-value ' + (r.appStatus==='online'?'good':r.appStatus==='idle'?'warn':'bad') + '">' + appTime + '</div></div>'
      + '<div class="stat-box"><div class="stat-label">Orders Today</div><div class="stat-value ' + (r.ordersToday>0?'good':'') + '">' + r.ordersToday + '</div></div>'
      + '<div class="stat-box"><div class="stat-label">Last Order</div><div class="stat-value">' + lastOrderStr + '</div></div>'
      + '<div class="stat-box"><div class="stat-label">Devices</div><div class="stat-value ' + (r.tokens>0?'good':'bad') + '">' + r.tokens + ' registered</div></div>'
      + '<div class="stat-box"><div class="stat-label">Revenue Today</div><div class="stat-value good">CHF ' + (r.revenueToday ? r.revenueToday.toFixed(2) : '0.00') + '</div></div>'
      + '<div class="stat-box"><div class="stat-label">Printer</div><div class="stat-value ' + (r.hasPrinter?'good':'warn') + '">' + (r.hasPrinter?'Configured':'Not set') + '</div></div>'
      + '<div class="stat-box" style="grid-column:span 2"><div class="stat-label">Website</div><div id="website-health-' + idx + '" class="stat-value" style="font-size:12px;">Loading...</div></div>'
      + '</div>'
      + '<div class="orders-section"><h4>Today\'s Orders</h4>' + ordersHtml + '</div>'
      + '<div class="debug-section" id="debug-section-' + idx + '">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'
      + '<h4 style="font-size:12px;font-weight:700;color:#8B38CB;text-transform:uppercase;letter-spacing:0.5px;">App Debug Log</h4>'
      + '<div style="display:flex;gap:8px;">'
      + '<button onclick="loadDebugLogs(\'' + r.code + '\',' + idx + ')" style="background:#8B38CB;color:#fff;border:none;border-radius:6px;padding:3px 10px;font-size:11px;font-weight:700;cursor:pointer;">Load</button>'
      + '<button onclick="clearDebugLogs(\'' + r.code + '\',' + idx + ')" style="background:#e74c3c;color:#fff;border:none;border-radius:6px;padding:3px 10px;font-size:11px;font-weight:700;cursor:pointer;">Clear</button>'
      + '</div></div>'
      + '<div id="debug-logs-' + idx + '" style="background:#111;border-radius:8px;padding:8px;max-height:200px;overflow-y:auto;font-family:monospace;font-size:10px;color:#eee;">'
      + '<div style="color:#666;">Tap Load to fetch logs</div>'
      + '</div></div>'
      + '</div></div>';
  }).join('');

  const alertBannerHtml = offlineCount > 0
    ? '<div class="alert-banner"><span>!</span><p>' + offlineCount + ' restaurant' + (offlineCount !== 1 ? 's' : '') + ' need' + (offlineCount === 1 ? 's' : '') + ' attention</p></div>'
    : '';

  const dashHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>FoodUp Monitor</title>
<link rel="icon" href="https://eatime.ch/wp-content/uploads/2026/05/foodup-icon.png" type="image/png">
<style>
  * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f0f0f5; min-height:100vh; }
  .topbar { background:#8B38CB; padding:14px 16px; position:sticky; top:0; z-index:100; }
  .topbar-inner { max-width:700px; margin:0 auto; }
  .topbar-row1 { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
  .topbar h1 { color:#fff; font-size:17px; font-weight:800; }
  .topbar .time { color:rgba(255,255,255,0.8); font-size:11px; }
  .topbar-actions { display:flex; gap:8px; align-items:center; }
  .icon-btn { background:rgba(255,255,255,0.2); border:none; color:#fff; padding:6px 12px; border-radius:20px; font-size:12px; font-weight:700; cursor:pointer; text-decoration:none; display:inline-block; }
  .search-bar { background:rgba(255,255,255,0.2); border:none; border-radius:10px; padding:8px 12px; width:100%; color:#fff; font-size:14px; outline:none; }
  .search-bar::placeholder { color:rgba(255,255,255,0.6); }
  .filter-tabs { display:flex; gap:6px; padding:10px 16px; overflow-x:auto; scrollbar-width:none; background:#f0f0f5; max-width:700px; margin:0 auto; }
  .filter-tabs::-webkit-scrollbar { display:none; }
  .tab { padding:6px 14px; border-radius:20px; font-size:13px; font-weight:700; border:none; cursor:pointer; white-space:nowrap; }
  .tab.all { background:#fff; color:#444; }
  .tab.online { background:#e8fdf2; color:#1a7a45; }
  .tab.offline { background:#fef2f2; color:#991b1b; }
  .tab.idle { background:#fffbeb; color:#92400e; }
  .tab.active.all { background:#444; color:#fff; }
  .tab.active.online { background:#2ecc71; color:#fff; }
  .tab.active.offline { background:#e74c3c; color:#fff; }
  .tab-badge { background:rgba(255,255,255,0.35); border-radius:4px; padding:1px 6px; font-size:11px; font-weight:700; margin-left:4px; }
  .tab:not(.active) .tab-badge { background:rgba(0,0,0,0.08); }
  .summary-row { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; padding:12px 16px; max-width:700px; margin:0 auto; }
  .summary-card { background:#fff; border-radius:12px; padding:10px 8px; text-align:center; }
  .summary-card .val { font-size:20px; font-weight:800; }
  .summary-card .lbl { font-size:10px; color:#888; margin-top:2px; text-transform:uppercase; letter-spacing:0.5px; }
  .summary-card.total .val { color:#8B38CB; }
  .summary-card.s-online .val { color:#2ecc71; }
  .summary-card.s-offline .val { color:#e74c3c; }
  .summary-card.s-orders .val { color:#3498db; }
  .alert-banner { margin:0 auto 8px; max-width:700px; padding:10px 16px; background:#fef2f2; border:1px solid #fecaca; border-radius:12px; display:flex; align-items:center; gap:8px; width:calc(100% - 32px); }
  .alert-banner p { font-size:13px; font-weight:700; color:#991b1b; }
  .content { padding:0 16px 32px; max-width:700px; margin:0 auto; }
  .sort-row { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; padding-top:4px; }
  .sort-row span { font-size:12px; color:#888; }
  .sort-select { background:#fff; border:1px solid #ddd; border-radius:8px; padding:5px 10px; font-size:12px; color:#444; outline:none; }
  .restaurant-card { background:#fff; border-radius:14px; margin-bottom:10px; box-shadow:0 1px 4px rgba(0,0,0,0.06); overflow:hidden; }
  .card-header { padding:14px 16px; display:flex; align-items:center; justify-content:space-between; cursor:pointer; user-select:none; }
  .card-header-left { display:flex; align-items:center; gap:10px; }
  .status-dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
  .status-dot.online { background:#2ecc71; }
  .status-dot.idle { background:#f39c12; }
  .status-dot.offline { background:#e74c3c; animation:pulse 2s infinite; }
  .status-dot.never { background:#ccc; }
  .status-dot.unknown { background:#ccc; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  .card-name { font-size:15px; font-weight:700; color:#111; }
  .card-meta { font-size:11px; color:#999; margin-top:1px; }
  .card-preview { font-size:11px; color:#8B38CB; margin-top:3px; font-weight:600; }
  .card-right { display:flex; align-items:center; gap:8px; }
  .status-badge { padding:3px 9px; border-radius:20px; font-size:11px; font-weight:700; }
  .status-badge.online { background:#e8fdf2; color:#1a7a45; }
  .status-badge.idle { background:#fffbeb; color:#92400e; }
  .status-badge.offline { background:#fef2f2; color:#991b1b; }
  .status-badge.never { background:#f5f5f5; color:#888; }
  .status-badge.unknown { background:#f5f5f5; color:#888; }
  .chevron { font-size:12px; color:#ccc; display:inline-block; transition:transform 0.2s; }
  .chevron.open { transform:rotate(180deg); }
  .card-body { display:none; padding:0 16px 16px; border-top:1px solid #f5f5f5; }
  .card-body.open { display:block; }
  .stats-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:12px; }
  .stat-box { background:#f9f9f9; border-radius:10px; padding:10px 12px; }
  .stat-box .stat-label { font-size:11px; color:#999; margin-bottom:3px; }
  .stat-box .stat-value { font-size:14px; font-weight:700; color:#333; }
  .stat-box .stat-value.good { color:#2ecc71; }
  .stat-box .stat-value.warn { color:#f39c12; }
  .stat-box .stat-value.bad { color:#e74c3c; }
  .orders-section { margin-top:12px; }
  .orders-section h4 { font-size:12px; font-weight:700; color:#444; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; }
  .order-row { display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid #f5f5f5; cursor:pointer; }
  .order-row:last-child { border-bottom:none; }
  .order-id { font-size:12px; font-weight:700; color:#8B38CB; }
  .order-customer { font-size:12px; color:#444; }
  .order-amount { font-size:12px; font-weight:700; color:#111; }
  .order-time { font-size:11px; color:#999; }
  .no-orders { font-size:12px; color:#bbb; text-align:center; padding:12px 0; }
  .modal-overlay { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:1000; align-items:flex-end; justify-content:center; }
  .modal-overlay.open { display:flex; }
  .modal { background:#fff; border-radius:20px 20px 0 0; padding:24px 20px 40px; width:100%; max-width:700px; max-height:85vh; overflow-y:auto; }
  .modal-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
  .modal-title { font-size:18px; font-weight:800; color:#111; }
  .modal-close { background:#f0f0f0; border:none; border-radius:50%; width:32px; height:32px; font-size:18px; cursor:pointer; }
  .modal-section { margin-bottom:16px; }
  .modal-section h4 { font-size:11px; font-weight:700; color:#999; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; }
  .modal-row { display:flex; justify-content:space-between; align-items:flex-start; padding:6px 0; border-bottom:1px solid #f5f5f5; }
  .modal-row:last-child { border-bottom:none; }
  .modal-label { font-size:13px; color:#888; }
  .modal-value { font-size:13px; font-weight:700; color:#111; text-align:right; max-width:60%; }
  .modal-item { padding:8px 0; border-bottom:1px solid #f5f5f5; }
  .modal-item:last-child { border-bottom:none; }
  .modal-item-name { font-size:14px; font-weight:700; color:#111; }
  .modal-item-addon { font-size:12px; color:#888; margin-top:2px; }
  .modal-item-price { font-size:13px; font-weight:700; color:#8B38CB; margin-top:2px; }
  .modal-actions { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:20px; }
  .modal-btn { padding:12px; border-radius:12px; font-size:14px; font-weight:700; border:none; cursor:pointer; text-align:center; text-decoration:none; display:block; }
  .modal-btn.call { background:#2ecc71; color:#fff; }
  .modal-btn.copy { background:#8B38CB; color:#fff; }
  .copy-success { text-align:center; font-size:12px; color:#2ecc71; margin-top:8px; display:none; }
  .empty-state { text-align:center; padding:40px 20px; color:#bbb; }
  .empty-state p { font-size:14px; margin-top:8px; }
  .last-updated { text-align:center; font-size:11px; color:#bbb; margin-top:16px; padding-bottom:32px; }
  .debug-section { margin-top:12px; padding-top:12px; border-top:1px solid #f0f0f0; }
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-inner">
    <div class="topbar-row1">
      <div>
        <h1>FoodUp Monitor</h1>
        <div class="time" id="current-time"></div>
      </div>
      <div class="topbar-actions">
        <a href="/dashboard/settings?p=PASS_PLACEHOLDER" class="icon-btn">Settings</a>
        <button class="icon-btn" onclick="location.reload()">Refresh</button>
      </div>
    </div>
    <input class="search-bar" type="text" id="search" placeholder="Search restaurant..." oninput="applyFilters()" />
  </div>
</div>
<div class="summary-row">
  <div class="summary-card total"><div class="val">TOTAL_PLACEHOLDER</div><div class="lbl">Total</div></div>
  <div class="summary-card s-online"><div class="val">ONLINE_PLACEHOLDER</div><div class="lbl">Online</div></div>
  <div class="summary-card s-offline"><div class="val">OFFLINE_PLACEHOLDER</div><div class="lbl">Offline</div></div>
  <div class="summary-card s-orders"><div class="val">ORDERS_PLACEHOLDER</div><div class="lbl">Orders</div></div>
</div>
ALERTBANNER_PLACEHOLDER
<div class="filter-tabs">
  <button class="tab all active" onclick="setFilter('all',this)">All <span class="tab-badge">TOTAL_PLACEHOLDER</span></button>
  <button class="tab online" onclick="setFilter('online',this)">Online <span class="tab-badge">ONLINE_PLACEHOLDER</span></button>
  <button class="tab offline" onclick="setFilter('offline',this)">Offline <span class="tab-badge">OFFLINE_PLACEHOLDER</span></button>
  <button class="tab idle" onclick="setFilter('idle',this)">Idle <span class="tab-badge">IDLE_PLACEHOLDER</span></button>
</div>
<div class="content">
  <div class="sort-row">
    <span id="result-count">TOTAL_PLACEHOLDER restaurants</span>
    <select class="sort-select" onchange="applyFilters()">
      <option value="status">Sort: Status first</option>
      <option value="name">Sort: Name A-Z</option>
      <option value="orders">Sort: Orders today</option>
      <option value="lastseen">Sort: Last seen</option>
    </select>
  </div>
  <div id="restaurant-list">CARDS_PLACEHOLDER</div>
  <div id="empty-state" class="empty-state" style="display:none;"><div style="font-size:40px;">?</div><p>No restaurants found</p></div>
  <div class="last-updated">Last updated: LASTUPDATED_PLACEHOLDER - Auto-refresh in <span id="countdown">600</span>s</div>
</div>
<div class="modal-overlay" id="order-modal">
  <div class="modal">
    <div class="modal-header">
      <div><div class="modal-title" id="modal-order-id"></div><div style="font-size:12px;color:#888;margin-top:2px;" id="modal-status"></div></div>
      <button class="modal-close" onclick="closeModal()">X</button>
    </div>
    <div class="modal-section"><h4>Items</h4><div id="modal-items"></div></div>
    <div class="modal-section">
      <h4>Customer</h4>
      <div class="modal-row"><span class="modal-label">Name</span><span class="modal-value" id="modal-customer-name"></span></div>
      <div class="modal-row"><span class="modal-label">Phone</span><span class="modal-value" id="modal-customer-phone"></span></div>
      <div class="modal-row"><span class="modal-label">Email</span><span class="modal-value" id="modal-customer-email"></span></div>
    </div>
    <div class="modal-section">
      <h4>Delivery</h4>
      <div class="modal-row"><span class="modal-label">Method</span><span class="modal-value" id="modal-shipping"></span></div>
      <div class="modal-row"><span class="modal-label">Address</span><span class="modal-value" id="modal-address"></span></div>
      <div class="modal-row"><span class="modal-label">Time</span><span class="modal-value" id="modal-time"></span></div>
    </div>
    <div class="modal-section">
      <h4>Payment</h4>
      <div class="modal-row"><span class="modal-label">Method</span><span class="modal-value" id="modal-payment"></span></div>
      <div class="modal-row"><span class="modal-label">Total</span><span class="modal-value" id="modal-total" style="color:#8B38CB;"></span></div>
      <div class="modal-row"><span class="modal-label">Note</span><span class="modal-value" id="modal-note"></span></div>
    </div>
    <div class="modal-actions">
      <a class="modal-btn call" id="modal-call-btn" href="#">Call Customer</a>
      <button class="modal-btn copy" onclick="copyOrder()">Copy Order</button>
    </div>
    <div class="copy-success" id="modal-copy-success">Copied to clipboard!</div>
  </div>
</div>
<script>
var currentFilter = 'all';
var orderData = ORDERDATA_PLACEHOLDER;
var DASH_PASS = DASHPASS_PLACEHOLDER;

function updateTime() {
  document.getElementById('current-time').textContent = new Date().toLocaleTimeString('de-CH');
}
updateTime();
setInterval(updateTime, 1000);

var countdown = 600;
setInterval(function() {
  countdown--;
  var el = document.getElementById('countdown');
  if (el) el.textContent = countdown;
  if (countdown <= 0) location.reload();
}, 1000);

function showOrder(orderId) {
  var o = orderData[orderId];
  if (!o) return;
  var items = Array.isArray(o.items) ? o.items : [];
  try { if (typeof o.items === 'string') items = JSON.parse(o.items); } catch(e) {}
  var itemsHtml = items.map(function(item) {
    var addons = (item.addons || []).map(function(a) {
      return '<div class="modal-item-addon">' + (a.value || a.label || '') + '</div>';
    }).join('');
    return '<div class="modal-item"><div class="modal-item-name">' + item.quantity + 'x ' + item.name + '</div>' + addons + '<div class="modal-item-price">CHF ' + parseFloat(item.total||0).toFixed(2) + '</div></div>';
  }).join('');
  var scheduledTime = 'ASAP';
  if (o.orderable_order_time && o.orderable_order_time.toLowerCase().indexOf('as soon as possible') === -1) {
    scheduledTime = o.orderable_order_time.replace(/\s*\(.*?\)\s*/g, '').trim();
    if (o.orderable_order_date) scheduledTime += ' - ' + o.orderable_order_date;
  }
  document.getElementById('modal-order-id').textContent = '#' + o.order_id;
  document.getElementById('modal-status').textContent = o.status || '';
  document.getElementById('modal-items').innerHTML = itemsHtml;
  document.getElementById('modal-customer-name').textContent = o.customer_name || '-';
  document.getElementById('modal-customer-phone').textContent = o.customer_phone || '-';
  document.getElementById('modal-customer-email').textContent = o.customer_email || '-';
  document.getElementById('modal-payment').textContent = o.payment_method || '-';
  document.getElementById('modal-shipping').textContent = o.shipping_method || '-';
  document.getElementById('modal-address').textContent = o.shipping_address || '-';
  document.getElementById('modal-time').textContent = scheduledTime;
  document.getElementById('modal-note').textContent = o.note || '-';
  document.getElementById('modal-total').textContent = (o.currency || 'CHF') + ' ' + o.total;
  var phone = (o.customer_phone || '').replace(/\s/g, '');
  var callBtn = document.getElementById('modal-call-btn');
  if (phone) { callBtn.href = 'tel:' + phone; callBtn.style.display = 'block'; }
  else { callBtn.style.display = 'none'; }
  document.getElementById('modal-copy-success').style.display = 'none';
  document.getElementById('order-modal').classList.add('open');
}

function closeModal() {
  document.getElementById('order-modal').classList.remove('open');
}

function copyOrder() {
  var lines = [
    'Order ' + document.getElementById('modal-order-id').textContent,
    '---',
    'Name: ' + document.getElementById('modal-customer-name').textContent,
    'Phone: ' + document.getElementById('modal-customer-phone').textContent,
    'Address: ' + document.getElementById('modal-address').textContent,
    'Delivery: ' + document.getElementById('modal-shipping').textContent,
    'Payment: ' + document.getElementById('modal-payment').textContent,
    'Time: ' + document.getElementById('modal-time').textContent,
    '---'
  ];
  var itemEls = document.querySelectorAll('#modal-items .modal-item');
  itemEls.forEach(function(el) {
    var n = el.querySelector('.modal-item-name') ? el.querySelector('.modal-item-name').textContent : '';
    lines.push(n);
    el.querySelectorAll('.modal-item-addon').forEach(function(a) { lines.push('  ' + a.textContent); });
  });
  lines.push('---');
  lines.push('Total: ' + document.getElementById('modal-total').textContent);
  var note = document.getElementById('modal-note').textContent;
  if (note && note !== '-') lines.push('Note: ' + note);
  var text = lines.join(String.fromCharCode(10));
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function() {
      document.getElementById('modal-copy-success').style.display = 'block';
      setTimeout(function() { document.getElementById('modal-copy-success').style.display = 'none'; }, 2000);
    }).catch(function() { fallbackCopy(text); });
  } else { fallbackCopy(text); }
}

function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  document.execCommand('copy'); document.body.removeChild(ta);
  document.getElementById('modal-copy-success').style.display = 'block';
  setTimeout(function() { document.getElementById('modal-copy-success').style.display = 'none'; }, 2000);
}

function toggleCard(idx) {
  var body = document.getElementById('body-' + idx);
  var chevron = document.getElementById('chevron-' + idx);
  var isOpen = body.classList.contains('open');

  // Close all cards first
  document.querySelectorAll('.card-body').forEach(function(b) {
    b.classList.remove('open');
  });
  document.querySelectorAll('.chevron').forEach(function(c) {
    c.classList.remove('open');
  });

  // If it wasn't open, open it
  if (!isOpen) {
    body.classList.add('open');
    chevron.classList.add('open');
    var card = body.closest('.restaurant-card');
    if (card) loadWebsiteHealth(card.dataset.code, idx);
  }
}
function loadWebsiteHealth(code, idx) {
  var el = document.getElementById('website-health-' + idx);
  if (!el) return;
  fetch('/website-health/' + code + '?p=' + encodeURIComponent(DASH_PASS))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.success) { el.innerHTML = '<span style="color:#999;">No data yet</span>'; return; }
      var h = data.health;
      var color = h.status === 'online' ? '#2ecc71' : '#e74c3c';
      var checked = h.checked_at ? new Date(h.checked_at).toLocaleTimeString('de-CH') : '';
      el.innerHTML = '<span style="color:' + color + ';font-weight:700;">' + h.status.toUpperCase() + '</span>'
        + (h.response_ms ? ' <span style="color:#999;">' + h.response_ms + 'ms</span>' : '')
        + (h.error ? ' <span style="color:#e74c3c;font-size:10px;">' + h.error + '</span>' : '')
        + (checked ? ' <span style="color:#bbb;font-size:10px;">checked ' + checked + '</span>' : '');
    })
    .catch(function() { el.innerHTML = '<span style="color:#999;">Failed to load</span>'; });
}

function setFilter(filter, btn) {
  currentFilter = filter;
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
  btn.classList.add('active');
  applyFilters();
}

function applyFilters() {
  var search = document.getElementById('search').value.toLowerCase();
  var sort = document.querySelector('.sort-select').value;
  var cards = Array.from(document.querySelectorAll('.restaurant-card'));
  var visible = 0;
  cards.forEach(function(card) {
    var status = card.dataset.status;
    var name = card.dataset.name;
    var matchesFilter = currentFilter === 'all' ||
      (currentFilter === 'offline' && (status === 'offline' || status === 'never')) ||
      (currentFilter === 'online' && status === 'online') ||
      (currentFilter === 'idle' && status === 'idle');
    var matchesSearch = !search || name.indexOf(search) !== -1;
    if (matchesFilter && matchesSearch) { card.style.display = 'block'; visible++; }
    else card.style.display = 'none';
  });
  var list = document.getElementById('restaurant-list');
  var visibleCards = cards.filter(function(c) { return c.style.display !== 'none'; });
  visibleCards.sort(function(a, b) {
    if (sort === 'name') return a.dataset.name.localeCompare(b.dataset.name);
    if (sort === 'orders') return parseInt(b.dataset.orders) - parseInt(a.dataset.orders);
    if (sort === 'lastseen') return parseInt(a.dataset.lastseen) - parseInt(b.dataset.lastseen);
    var ord = {offline:0,never:1,idle:2,online:3,unknown:4};
    return (ord[a.dataset.status]||4) - (ord[b.dataset.status]||4);
  });
  visibleCards.forEach(function(c) { list.appendChild(c); });
  document.getElementById('result-count').textContent = visible + ' restaurant' + (visible !== 1 ? 's' : '');
  document.getElementById('empty-state').style.display = visible === 0 ? 'block' : 'none';
}

document.getElementById('order-modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

function loadDebugLogs(code, idx) {
  var container = document.getElementById('debug-logs-' + idx);
  container.innerHTML = '<div style="color:#f39c12;">Loading...</div>';
  fetch('/debug-logs/' + code + '?p=' + encodeURIComponent(DASH_PASS))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.success || !data.logs || data.logs.length === 0) {
        container.innerHTML = '<div style="color:#666;">No logs yet</div>';
        return;
      }
      container.innerHTML = data.logs.map(function(l) {
        var time = l.ts ? new Date(l.ts).toLocaleTimeString('de-CH') : '';
        var color = l.message.indexOf('DROP') !== -1 ? '#e74c3c'
          : l.message.indexOf('SHOW') !== -1 ? '#2ecc71'
          : l.message.indexOf('QUEUED') !== -1 ? '#f39c12'
          : l.message.indexOf('SRC:') !== -1 ? '#3498db'
          : '#eee';
        return '<div style="color:' + color + ';margin-bottom:2px;"><span style="color:#666;">' + time + '</span> ' + l.message + '</div>';
      }).join('');
    })
    .catch(function() {
      container.innerHTML = '<div style="color:#e74c3c;">Failed to load</div>';
    });
}

function clearDebugLogs(code, idx) {
  fetch('/debug-logs/' + code + '?p=' + encodeURIComponent(DASH_PASS), { method: 'DELETE' })
    .then(function() {
      var container = document.getElementById('debug-logs-' + idx);
      container.innerHTML = '<div style="color:#666;">Cleared</div>';
    });
}
</script>
</body>
</html>`;

  // Now safely replace all placeholders
  const onlineCount = restaurantData.filter(r=>r.appStatus==='online').length;
  const idleCount = restaurantData.filter(r=>r.appStatus==='idle').length;
  const encodedP = encodeURIComponent(p);
  const lastUpdated = new Date().toLocaleString('de-CH');

const finalHtml = dashHtml
    .replace('DASHPASS_PLACEHOLDER', JSON.stringify(p))
    .replace(/PASS_PLACEHOLDER/g, encodedP)
    .replace(/TOTAL_PLACEHOLDER/g, String(restaurantData.length))
    .replace(/ONLINE_PLACEHOLDER/g, String(onlineCount))
    .replace(/OFFLINE_PLACEHOLDER/g, String(offlineCount))
    .replace(/ORDERS_PLACEHOLDER/g, String(totalOrdersToday))
    .replace(/IDLE_PLACEHOLDER/g, String(idleCount))
    .replace('ALERTBANNER_PLACEHOLDER', alertBannerHtml)
    .replace('CARDS_PLACEHOLDER', cardsHtml)
    .replace('LASTUPDATED_PLACEHOLDER', lastUpdated)
    .replace('ORDERDATA_PLACEHOLDER', JSON.stringify(orderDataForJS).replace(/<\/script>/gi, '<\\/script>').replace(/<!--/g, '<\\!--'));

  res.send(finalHtml);
});

// -------------------------------------------------------
// ALERT CHECKER
// -------------------------------------------------------

async function checkAndSendAlerts() {
  try {
    const restaurantsResult = await redisCommand("SMEMBERS", "restaurants");
    const restaurants = restaurantsResult.result || [];
    const alertData = await redisCommand("GET", "alert_settings");
    if (!alertData.result) return;
    const alertSettings = JSON.parse(alertData.result);
    if (!alertSettings.offline_threshold_minutes) return;

    for (const code of restaurants) {
      try {
        const heartbeatData = await redisCommand("GET", k(code, "heartbeat"));
        const profileData = await redisCommand("GET", k(code, "restaurant_profile"));
        const profile = profileData.result ? JSON.parse(profileData.result) : null;
        const name = (profile && profile.name) ? profile.name : code;

        if (!heartbeatData.result) continue;

        const heartbeat = JSON.parse(heartbeatData.result);
        const minutesOffline = Math.floor((Date.now() - new Date(heartbeat.last_seen).getTime()) / 60000);

        if (minutesOffline >= alertSettings.offline_threshold_minutes) {
          await alertService.handleAppOfflineAlert(code, minutesOffline, heartbeat, name);
        } else {
          await alertService.handleAppRecoveredAlert(code, name, heartbeat.last_seen);
        }
      } catch(e) {
        console.log('Alert check error for ' + code + ':', e.message);
      }
    }
  } catch(e) {
    console.log('Alert checker error:', e.message);
  }
}

// Run alert checker every 5 minutes
setInterval(checkAndSendAlerts, 5 * 60 * 1000);

// -------------------------------------------------------
// HEALTH CHECK
// -------------------------------------------------------

app.get("/", async (req, res) => {
  const restaurants = await redisCommand("SMEMBERS", "restaurants");
  res.json({
    status: "FoodUp Order Alerts backend is running!",
    restaurants: restaurants.result || [],
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startWebsiteMonitor(redisCommand, k, alertService);
});

// -------------------------------------------------------
// AUTO ACCEPT / REJECT — SERVER SIDE
// -------------------------------------------------------

async function runAutoActions() {
  try {
    const restaurantsResult = await redisCommand("SMEMBERS", "restaurants");
    const restaurants = restaurantsResult.result || [];

    for (const code of restaurants) {
      try {
        // Get auto settings (memory cache, invalidated on POST /auto-settings)
        if (!autoSettingsCache[code]) {
          const autoSettingsData = await redisCommand("GET", k(code, "auto_settings"));
          if (!autoSettingsData.result) continue;
          autoSettingsCache[code] = JSON.parse(autoSettingsData.result);
        }
        const autoSettings = autoSettingsCache[code];
        if (autoSettings.auto_action === 'disabled') continue;

        const waitMs = (autoSettings.wait_minutes || 5) * 60 * 1000;
        const acceptTime = autoSettings.accept_time || '30 Minutes';
        const rejectReason = autoSettings.reject_reason || 'Zu beschäftigt';

        // Get orders
        const ordersData = await redisCommand("LRANGE", k(code, "orders"), 0, 99);
        const orders = (ordersData.result || []).map(o => JSON.parse(o));

        // Get restaurant profile for website URL
        const profileData = await redisCommand("GET", k(code, "restaurant_profile"));
        const profile = profileData.result ? JSON.parse(profileData.result) : null;
        const website = profile?.website;
        const baseUrl = website ? (website.startsWith('http') ? website : `https://${website}`) : null;

        for (const order of orders) {
  try {
    // Skip terminal statuses immediately
    if (
      order.status === 'cancelled' ||
      order.status === 'completed' ||
      order.status === 'refunded' ||
      order.status === 'failed'
    ) {
      continue;
    }

    // Detect pre-order/scheduled order
    const ordTime = String(order.orderable_order_time || '').toLowerCase().trim();
    const ordDate = String(order.orderable_order_date || '').trim();

    const isAsap =
      ordTime.includes('as soon as possible') ||
      ordTime.includes('asap');

    const isPreOrder = Boolean((ordDate || ordTime) && !isAsap);

    // For ASAP orders, skip if older than 3 hours
    // Pre-orders stay eligible even if created earlier
    if (!isPreOrder) {
      const ageSrc = order.received_at || order.sent_at || order.date_created;
      const orderDate = ageSrc ? new Date(String(ageSrc).replace(' ', 'T')).getTime() : null;

      if (orderDate && !isNaN(orderDate) && (Date.now() - orderDate) > 3 * 60 * 60 * 1000) {
        continue;
      }
    }

            // Check if already accepted or rejected manually
            const acceptedData = await redisCommand("GET", k(code, `accepted_time:${order.order_id}`));
            const rejectedData = await redisCommand("GET", k(code, `rejected_time:${order.order_id}`));
            if (acceptedData.result || rejectedData.result) {
              console.log(`runAutoActions SKIP ${code} order ${order.order_id}: already ${acceptedData.result ? 'accepted' : 'rejected'} manually`);
              continue;
            }

            // Check if already auto-actioned
            const autoActioned = await redisCommand("GET", k(code, `auto_actioned:${order.order_id}`));
            if (autoActioned.result) {
              console.log(`runAutoActions SKIP ${code} order ${order.order_id}: auto_actioned already set`);
              continue;
            }

            // Check order age — prefer received_at (set by backend on receipt, always UTC) over date_created (WC local time, UTC-naive)
            const ageSrc = order.received_at || order.sent_at || order.date_created;
            const orderDate = ageSrc ? new Date(ageSrc.replace(' ', 'T')).getTime() : null;
            if (!orderDate || isNaN(orderDate)) {
              console.log(`runAutoActions SKIP ${code} order ${order.order_id}: invalid date src="${ageSrc}"`);
              continue;
            }
            const age = Date.now() - orderDate;
            if (age < waitMs) {
              console.log(`runAutoActions SKIP ${code} order ${order.order_id}: too young age=${Math.floor(age/1000)}s waitMs=${waitMs/1000}s`);
              continue;
            }if (!isPreOrder && age > 3 * 60 * 60 * 1000) {
              continue;
            }

            // Mark as auto-actioned to prevent duplicate processing
            await redisCommand("SET", k(code, `auto_actioned:${order.order_id}`), 'yes');
            await redisCommand("EXPIRE", k(code, `auto_actioned:${order.order_id}`), 86400);
            // Mark as auto-accepted for pill display
            await redisCommand("SET", k(code, `auto_accepted:${order.order_id}`), 'yes');
            await redisCommand("EXPIRE", k(code, `auto_accepted:${order.order_id}`), 86400);

            console.log(`Auto ${autoSettings.auto_action} for restaurant ${code}, order ${order.order_id}`);

            // Determine effective accept time (scheduled vs ASAP)
            let effectiveAcceptTime = acceptTime;
            if (autoSettings.auto_action === 'accept') {
              const ordTime = order.orderable_order_time || '';
              const ordDate = order.orderable_order_date || '';
              const isScheduled = ordTime && ordTime.trim() !== '' &&
                !ordTime.toLowerCase().includes('as soon as possible') &&
                !ordTime.toLowerCase().includes('asap') &&
                !ordTime.includes('(');
              if (isScheduled) {
                const cleanTime = ordTime.replace(/\s*\(.*?\)\s*/g, '').trim();
                effectiveAcceptTime = `${cleanTime} — ${ordDate}`;
              }
            }

            if (autoSettings.auto_action === 'accept') {
              // Save accepted time to Redis
              await redisCommand("SET", k(code, `accepted_time:${order.order_id}`), JSON.stringify({
                accepted_time: effectiveAcceptTime,
                accepted_at: new Date().toISOString(),
                status: 'accepted',
              }));
              await redisCommand("EXPIRE", k(code, `accepted_time:${order.order_id}`), 86400);

              // Call WordPress to update order status and send email
              if (baseUrl) {
                fetch(`${baseUrl}/wp-json/foodup/v1/order-accepted`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    secret: 'foodup2026',
                    order_id: order.order_id,
                    accepted_time: effectiveAcceptTime,
                  }),
                }).catch(e => console.log(`WP accept error for ${code}:`, e.message));
              }

              // Send push notification for print button
              const deviceTokens = await getTokens(code);
              if (deviceTokens.length > 0) {
                let itemsString = '[]';
                try { itemsString = JSON.stringify(order.items || []); } catch(e) {}

                const messages = deviceTokens.map(token => ({
                  to: token,
                  sound: null,
                  title: `✓ Order #${order.order_id} auto-accepted`,
                  body: `${order.customer_name} - ${order.currency} ${order.total}`,
                  data: {
                    event_type: 'auto_accepted',
                    restaurant_code: code,
                    order_id: String(order.order_id),
                    accepted_time: effectiveAcceptTime,
                    customer_name: String(order.customer_name || ''),
                    customer_email: String(order.customer_email || ''),
                    customer_phone: String(order.customer_phone || ''),
                    total: String(order.total || ''),
                    currency: String(order.currency || ''),
                    payment_method: String(order.payment_method || ''),
                    note: String(order.note || ''),
                    shipping_method: String(order.shipping?.method || ''),
                    shipping_address: String(order.shipping?.address || ''),
                    orderable_order_date: String(order.orderable_order_date || ''),
                    orderable_order_time: String(order.orderable_order_time || ''),
                    date_created: String(order.date_created || ''),
                    items: itemsString,
                  },
                }));

                fetch("https://exp.host/--/api/v2/push/send", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "Accept": "application/json" },
                  body: JSON.stringify(messages),
                }).catch(() => {});
              }

            } else if (autoSettings.auto_action === 'reject') {
              // Call WordPress to reject order and send email
              if (baseUrl) {
                fetch(`${baseUrl}/wp-json/foodup/v1/order-rejected`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    secret: 'foodup2026',
                    order_id: order.order_id,
                    reason: rejectReason,
                  }),
                }).catch(e => console.log(`WP reject error for ${code}:`, e.message));
              }

              // Send status update push notification
              const deviceTokens = await getTokens(code);
              if (deviceTokens.length > 0) {
                const messages = deviceTokens.map(token => ({
                  to: token,
                  sound: null,
                  title: `Order #${order.order_id} auto-rejected`,
                  body: rejectReason,
                  data: {
                    event_type: 'status_update',
                    restaurant_code: code,
                    order_id: String(order.order_id),
                    status: 'cancelled',
                  },
                }));
                fetch("https://exp.host/--/api/v2/push/send", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "Accept": "application/json" },
                  body: JSON.stringify(messages),
                }).catch(() => {});
              }
            }
          } catch(orderErr) {
            console.log(`Error processing order ${order.order_id} for ${code}:`, orderErr.message);
          }
        }
      } catch(restaurantErr) {
        console.log(`Error processing restaurant ${code}:`, restaurantErr.message);
      }
    }
  } catch(err) {
    console.log('Auto action error:', err.message);
  }
}

// Run every minute
setInterval(runAutoActions, 60 * 1000);
// Also run once on startup after 10 seconds
setTimeout(runAutoActions, 10 * 1000);


app.get("/check-auto-actioned/:code/:order_id", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const data = await redisCommand("GET", k(code, `auto_actioned:${req.params.order_id}`));
  res.json({ auto_actioned: !!data.result, value: data.result });
});
