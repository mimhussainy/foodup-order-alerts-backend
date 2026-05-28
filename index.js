const express = require("express");
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

async function getTokens(code) {
  const result = await redisCommand("SMEMBERS", k(code, "device_tokens"));
  return result.result || [];
}

async function saveToken(code, token) {
  await redisCommand("SADD", k(code, "device_tokens"), token);
}

async function removeToken(code, token) {
  await redisCommand("SREM", k(code, "device_tokens"), token);
}

// -------------------------------------------------------
// RATE LIMITER
// -------------------------------------------------------

const rateLimitStore = {};

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
  const { token, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });
  console.log("Registering token for:", code);
  await saveToken(code, token);
  res.json({ success: true });
});

app.post("/unregister-token", async (req, res) => {
  const { token, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });
  await removeToken(code, token);
  console.log("Unregistered token for:", code);
  res.json({ success: true });
});

app.post("/new-order", async (req, res) => {
  const order = req.body;
  const code = order.restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });
  console.log("New order received for:", code, order.order_id);
  console.log("Order date:", order.orderable_order_date, "Order time:", order.orderable_order_time);
  if (!order.date_created) {
    order.date_created = new Date().toISOString();
  }
  await redisCommand("SET", k(code, "last_order"), JSON.stringify(order));
  await redisCommand("LPUSH", k(code, "orders"), JSON.stringify(order));
  await redisCommand("LTRIM", k(code, "orders"), 0, 99);
  const deviceTokens = await getTokens(code);
  if (deviceTokens.length === 0) {
    return res.json({ success: false, message: "No device tokens registered" });
  }

  let itemsString = '[]';
  try {
    const safeItems = (order.items || []).map(item => ({
      name: String(item.name || ''),
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

  const messages = deviceTokens.map(token => ({
    to: token,
    sound: order.sound === false ? null : "default",
    title: `🛒 New Order #${order.order_id}`,
    body: `${order.customer_name} - ${order.currency} ${order.total}`,
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
    },
  }));

  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(messages),
  });

  const result = await response.json();
console.log("Push result:", JSON.stringify(result));

// Remove tokens from old eatime project
const oldTokens = ['ExponentPushToken[Oyk8uvHt-8fn54wYhHGHWK]', 'ExponentPushToken[4yn6i8O119fnX-bmQ6Cwbc]'];
for (const token of oldTokens) {
  await removeToken(code, token);
  console.log("Removed old token:", token);
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
  try {
    const listData = await redisCommand("LRANGE", k(code, "orders"), 0, 99);
    const orders = (listData.result || []).map((o) => JSON.parse(o));
    const index = orders.findIndex((o) => String(o.order_id) === String(order.order_id));
    if (index !== -1) {
      orders[index].status = order.status;
      await redisCommand("DEL", k(code, "orders"));
      await Promise.all(orders.reverse().map((o) => redisCommand("RPUSH", k(code, "orders"), JSON.stringify(o))));
    }
  } catch(e) {}

  const deviceTokens = await getTokens(code);
  if (deviceTokens.length === 0) return res.json({ success: false });

  let itemsString = '[]';
  try {
    const safeItems = (order.items || []).map(item => ({
      name: String(item.name || ''),
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

  const storedPin = await redisCommand("GET", k(code, "pin"));
  if (!storedPin.result || storedPin.result !== owner_pin) {
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

  const storedPin = await redisCommand("GET", k(code, "pin"));
  if (!storedPin.result || storedPin.result !== owner_pin) {
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

  const storedPin = await redisCommand("GET", k(code, "pin"));
  if (!storedPin.result || storedPin.result !== owner_pin) {
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

  const storedPin = await redisCommand("GET", k(code, "pin"));
  if (!storedPin.result || storedPin.result !== owner_pin) {
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

  const deliveredAt = new Date().toISOString();

  await redisCommand("SET", k(code, `delivered:${order_id}`), JSON.stringify({
    order_id, delivery_name, delivered_at: deliveredAt, ...(order_data || {}),
  }));

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
  try {
    const claims = {};

// Get delivered status first
    const listData = await redisCommand("LRANGE", k(code, "orders"), 0, 99);
    const orders = (listData.result || []).map((o) => JSON.parse(o));
    await Promise.all(orders.map(async (order) => {
      const deliveredData = await redisCommand("GET", k(code, `delivered:${order.order_id}`));
      if (deliveredData.result) {
        const delivered = JSON.parse(deliveredData.result);
        claims[String(delivered.order_id)] = { name: delivered.delivery_name, status: 'delivered' };
      }
    }));

    // Get active claims second — only add if not already delivered
    const claimKeys = await redisCommand("KEYS", k(code, "claimed:*"));
    if (claimKeys.result && claimKeys.result.length > 0) {
      await Promise.all(claimKeys.result.map(async (key) => {
        const data = await redisCommand("GET", key);
        if (data.result) {
          const claim = JSON.parse(data.result);
          const orderId = String(claim.order_id);
          // Don't overwrite delivered status with active claim
          if (!claims[orderId] || claims[orderId].status !== 'delivered') {
            claims[orderId] = { name: claim.delivery_name, status: claim.delivery_status || 'in_bag' };
          }
        }
      }));
    }

    res.json({ success: true, claims });
  } catch(e) {
    res.json({ success: true, claims: {} });
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
    const storedPin = await redisCommand("GET", k(code, "pin"));
    if (!storedPin.result || storedPin.result !== owner_pin) {
      return res.json({ success: false, message: "Unauthorized" });
    }
  }
  const existing = await redisCommand("GET", k(code, "restaurant_profile"));
  const current = existing.result ? JSON.parse(existing.result) : {};

const { print_logo_url } = req.body;
  await redisCommand("SET", k(code, "restaurant_profile"), JSON.stringify({
    name: name !== undefined ? name : current.name,
    phone: phone !== undefined ? phone : current.phone,
    address: address !== undefined ? address : current.address,
    website: website !== undefined ? website : current.website,
    print_logo_url: print_logo_url !== undefined ? print_logo_url : current.print_logo_url,
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
  await redisCommand("EXPIRE", k(code, `accepted_time:${order_id}`), 86400);
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
  const storedPin = await redisCommand("GET", k(code, "pin"));
  if (!storedPin.result || storedPin.result !== owner_pin) {
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
  if (!code) return res.json({ success: false });
  const storedPin = await redisCommand("GET", k(code, "pin"));
  if (!storedPin.result || storedPin.result !== owner_pin) {
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
    await redisCommand("LPUSH", k(code, "orders"), JSON.stringify(order));
    await redisCommand("LTRIM", k(code, "orders"), 0, 99);

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
  const { message } = req.body;
  console.log("APP LOG:", message);
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
// NODEMAILER SETUP
// -------------------------------------------------------

const nodemailer = require('nodemailer');

const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.ALERT_EMAIL_USER,
    pass: process.env.ALERT_EMAIL_PASS,
  },
});

async function sendAlertEmail(to, subject, html) {
  try {
    await emailTransporter.sendMail({
      from: `"FoodUp Monitor" <${process.env.ALERT_EMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log('Alert email sent to:', to);
  } catch(e) {
    console.log('Alert email error:', e.message);
  }
}

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
// DASHBOARD
// -------------------------------------------------------

app.get("/dashboard", async (req, res) => {
  const { p } = req.query;
  const dashPassword = process.env.DASHBOARD_PASSWORD || 'foodup2026';

  if (p !== dashPassword) {
    return res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>FoodUp Dashboard</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f5f5f5; display:flex; align-items:center; justify-content:center; min-height:100vh; padding:20px; }
  .login-card { background:#fff; border-radius:16px; padding:32px 28px; max-width:360px; width:100%; box-shadow:0 4px 20px rgba(0,0,0,0.1); }
  .logo { text-align:center; margin-bottom:24px; }
  .logo h1 { font-size:24px; font-weight:800; color:#8B38CB; }
  .logo p { font-size:13px; color:#888; margin-top:4px; }
  input { width:100%; padding:12px 16px; border:1px solid #ddd; border-radius:10px; font-size:15px; margin-bottom:16px; outline:none; }
  input:focus { border-color:#8B38CB; box-shadow:0 0 0 3px rgba(139,56,203,0.1); }
  button { width:100%; padding:14px; background:#8B38CB; color:#fff; border:none; border-radius:10px; font-size:15px; font-weight:700; cursor:pointer; }
  button:hover { background:#7a2fb8; }
  .error { color:#e74c3c; font-size:13px; text-align:center; margin-top:12px; display:none; }
</style>
</head>
<body>
<div class="login-card">
  <div class="logo">
    <h1>🍽️ FoodUp</h1>
    <p>Restaurant Monitor Dashboard</p>
  </div>
  <input type="password" id="pwd" placeholder="Enter dashboard password" onkeydown="if(event.key==='Enter')login()" />
  <button onclick="login()">Login</button>
  <p class="error" id="err">Incorrect password. Try again.</p>
</div>
<script>
function login() {
  const pwd = document.getElementById('pwd').value;
  if (pwd) window.location.href = '/dashboard?p=' + encodeURIComponent(pwd);
  else { document.getElementById('err').style.display='block'; }
}
</script>
</body>
</html>`);
  }

  // Fetch all restaurants
  const restaurantsResult = await redisCommand("SMEMBERS", "restaurants");
  const restaurants = restaurantsResult.result || [];

  // Fetch alert settings
  const alertData = await redisCommand("GET", "alert_settings");
  const alertSettings = alertData.result ? JSON.parse(alertData.result) : { alert_email: '', offline_threshold_minutes: 30 };

  // Fetch data for each restaurant
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

      // Orders today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const ordersToday = orders.filter(o => {
        if (!o.date_created) return false;
        return new Date(o.date_created) >= today;
      }).length;

      // Last order
      const lastOrder = orders.length > 0 ? orders[0] : null;
      const lastOrderTime = lastOrder?.date_created ? new Date(lastOrder.date_created) : null;

      // App status
      let appStatus = 'never';
      let appMinutesAgo = null;
      if (heartbeat?.last_seen) {
        appMinutesAgo = Math.floor((Date.now() - new Date(heartbeat.last_seen).getTime()) / 60000);
        if (appMinutesAgo < 10) appStatus = 'online';
        else if (appMinutesAgo < 30) appStatus = 'idle';
        else appStatus = 'offline';
      }

      return {
        code,
        name: profile?.name || code,
        website: profile?.website || '',
        appStatus,
        appMinutesAgo,
        lastSeen: heartbeat?.last_seen || null,
        tokens: tokens.length,
        ordersToday,
        lastOrderTime,
        hasPrinter: !!printerData.result,
      };
    } catch(e) {
      return { code, name: code, appStatus: 'unknown', tokens: 0, ordersToday: 0 };
    }
  }));

  const dashHtml = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<title>FoodUp Monitor</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f0f0f5; min-height:100vh; }
  .topbar { background:#8B38CB; padding:16px 20px; display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:100; }
  .topbar h1 { color:#fff; font-size:18px; font-weight:800; }
  .topbar .time { color:rgba(255,255,255,0.8); font-size:12px; }
  .topbar .refresh-btn { background:rgba(255,255,255,0.2); border:none; color:#fff; padding:6px 12px; border-radius:20px; font-size:12px; font-weight:700; cursor:pointer; }
  .content { padding:16px; max-width:600px; margin:0 auto; }
  .summary-row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:16px; }
  .summary-card { background:#fff; border-radius:12px; padding:12px; text-align:center; }
  .summary-card .val { font-size:22px; font-weight:800; color:#8B38CB; }
  .summary-card .lbl { font-size:11px; color:#888; margin-top:2px; text-transform:uppercase; letter-spacing:0.5px; }
  .section-title { font-size:13px; font-weight:700; color:#444; text-transform:uppercase; letter-spacing:1px; margin:0 0 10px 0; }
  .restaurant-card { background:#fff; border-radius:14px; padding:16px; margin-bottom:12px; box-shadow:0 1px 4px rgba(0,0,0,0.06); }
  .restaurant-card.online { border-left:4px solid #2ecc71; }
  .restaurant-card.idle { border-left:4px solid #f39c12; }
  .restaurant-card.offline { border-left:4px solid #e74c3c; }
  .restaurant-card.never { border-left:4px solid #ccc; }
  .restaurant-card.unknown { border-left:4px solid #ccc; }
  .card-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
  .card-title { font-size:16px; font-weight:700; color:#111; }
  .card-code { font-size:11px; color:#999; margin-top:2px; }
  .status-badge { padding:4px 10px; border-radius:20px; font-size:12px; font-weight:700; }
  .status-badge.online { background:#e8fdf2; color:#1a7a45; }
  .status-badge.idle { background:#fffbeb; color:#92400e; }
  .status-badge.offline { background:#fef2f2; color:#991b1b; }
  .status-badge.never { background:#f5f5f5; color:#888; }
  .status-badge.unknown { background:#f5f5f5; color:#888; }
  .card-stats { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .stat-item { background:#f9f9f9; border-radius:8px; padding:8px 10px; }
  .stat-label { font-size:11px; color:#999; margin-bottom:2px; }
  .stat-value { font-size:13px; font-weight:700; color:#333; }
  .stat-value.good { color:#2ecc71; }
  .stat-value.warn { color:#f39c12; }
  .stat-value.bad { color:#e74c3c; }
  .alert-section { background:#fff; border-radius:14px; padding:16px; margin-bottom:16px; }
  .alert-section h3 { font-size:14px; font-weight:700; color:#111; margin-bottom:12px; }
  .alert-field { margin-bottom:12px; }
  .alert-field label { font-size:12px; color:#666; font-weight:600; display:block; margin-bottom:6px; }
  .alert-field input { width:100%; padding:10px 12px; border:1px solid #ddd; border-radius:8px; font-size:14px; outline:none; }
  .alert-field input:focus { border-color:#8B38CB; }
  .save-btn { background:#8B38CB; color:#fff; border:none; padding:10px 20px; border-radius:8px; font-size:14px; font-weight:700; cursor:pointer; width:100%; }
  .save-btn:active { background:#7a2fb8; }
  .saved-msg { text-align:center; font-size:13px; color:#2ecc71; margin-top:8px; display:none; }
  .last-updated { text-align:center; font-size:11px; color:#bbb; margin-top:16px; padding-bottom:32px; }
</style>
</head>
<body>
<div class="topbar">
  <div>
    <h1>🍽️ FoodUp Monitor</h1>
    <div class="time" id="current-time"></div>
  </div>
  <button class="refresh-btn" onclick="location.reload()">↻ Refresh</button>
</div>

<div class="content">

  <div class="summary-row">
    <div class="summary-card">
      <div class="val">${restaurants.length}</div>
      <div class="lbl">Restaurants</div>
    </div>
    <div class="summary-card">
      <div class="val" style="color:#2ecc71;">${restaurantData.filter(r => r.appStatus === 'online').length}</div>
      <div class="lbl">Online</div>
    </div>
    <div class="summary-card">
      <div class="val" style="color:#e74c3c;">${restaurantData.filter(r => r.appStatus === 'offline' || r.appStatus === 'never').length}</div>
      <div class="lbl">Offline</div>
    </div>
  </div>

  <p class="section-title">Restaurants</p>

  ${restaurantData.map(r => {
    const statusLabel = r.appStatus === 'online' ? '🟢 Online' : r.appStatus === 'idle' ? '🟡 Idle' : r.appStatus === 'never' ? '⚫ Never Seen' : '🔴 Offline';
    const appTime = r.appMinutesAgo !== null ? (r.appMinutesAgo < 60 ? r.appMinutesAgo + ' min ago' : Math.floor(r.appMinutesAgo/60) + 'h ' + (r.appMinutesAgo%60) + 'm ago') : 'Never';
    const lastOrderStr = r.lastOrderTime ? (() => { const m = Math.floor((Date.now() - new Date(r.lastOrderTime).getTime()) / 60000); return m < 60 ? m + ' min ago' : Math.floor(m/60) + 'h ago'; })() : 'No orders';
    return `
    <div class="restaurant-card ${r.appStatus}">
      <div class="card-header">
        <div>
          <div class="card-title">${r.name || r.code}</div>
          <div class="card-code">${r.code}${r.website ? ' · ' + r.website : ''}</div>
        </div>
        <div class="status-badge ${r.appStatus}">${statusLabel}</div>
      </div>
      <div class="card-stats">
        <div class="stat-item">
          <div class="stat-label">App Last Seen</div>
          <div class="stat-value ${r.appStatus === 'online' ? 'good' : r.appStatus === 'idle' ? 'warn' : 'bad'}">${appTime}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Orders Today</div>
          <div class="stat-value ${r.ordersToday > 0 ? 'good' : ''}">${r.ordersToday}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Last Order</div>
          <div class="stat-value">${lastOrderStr}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Devices</div>
          <div class="stat-value ${r.tokens > 0 ? 'good' : 'bad'}">${r.tokens} registered</div>
        </div>
      </div>
    </div>`;
  }).join('')}

  <p class="section-title" style="margin-top:20px;">Alert Settings</p>
  <div class="alert-section">
    <div class="alert-field">
      <label>Alert Email (receives notifications when restaurants go offline)</label>
      <input type="email" id="alert_email" value="${alertSettings.alert_email}" placeholder="your@email.com" />
    </div>
    <div class="alert-field">
      <label>Offline Threshold (minutes before alert is sent)</label>
      <input type="number" id="offline_threshold" value="${alertSettings.offline_threshold_minutes}" min="5" max="120" />
    </div>
    <button class="save-btn" onclick="saveAlertSettings()">Save Alert Settings</button>
    <p class="saved-msg" id="saved_msg">✓ Settings saved!</p>
  </div>

  <div class="last-updated">Last updated: ${new Date().toLocaleString('de-CH')}</div>
</div>

<script>
function updateTime() {
  document.getElementById('current-time').textContent = new Date().toLocaleTimeString('de-CH');
}
updateTime();
setInterval(updateTime, 1000);

async function saveAlertSettings() {
  const email = document.getElementById('alert_email').value;
  const threshold = document.getElementById('offline_threshold').value;
  try {
    const res = await fetch('/alert-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'foodup2026', alert_email: email, offline_threshold_minutes: parseInt(threshold) })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('saved_msg').style.display = 'block';
      setTimeout(() => document.getElementById('saved_msg').style.display = 'none', 3000);
    }
  } catch(e) {}
}

// Auto refresh every 60 seconds
setTimeout(() => location.reload(), 60000);
</script>
</body>
</html>`;

  res.send(dashHtml);
});

// -------------------------------------------------------
// ALERT CHECKER
// -------------------------------------------------------

async function checkAndSendAlerts() {
  try {
    const alertData = await redisCommand("GET", "alert_settings");
    if (!alertData.result) return;
    const alertSettings = JSON.parse(alertData.result);
    if (!alertSettings.alert_email) return;

    const thresholdMs = (alertSettings.offline_threshold_minutes || 30) * 60 * 1000;
    const restaurantsResult = await redisCommand("SMEMBERS", "restaurants");
    const restaurants = restaurantsResult.result || [];

    for (const code of restaurants) {
      try {
        const heartbeatData = await redisCommand("GET", k(code, "heartbeat"));
        const alertSentData = await redisCommand("GET", k(code, "alert_sent"));
        const profileData = await redisCommand("GET", k(code, "restaurant_profile"));
        const profile = profileData.result ? JSON.parse(profileData.result) : null;
        const name = profile?.name || code;

        if (!heartbeatData.result) {
          // App never seen — only alert once
          if (!alertSentData.result) {
            await sendAlertEmail(
              alertSettings.alert_email,
              `⚠️ FoodUp Alert — ${name} app never connected`,
              `<div style="font-family:Arial,sans-serif; padding:20px;">
                <h2 style="color:#8B38CB;">⚠️ FoodUp Monitor Alert</h2>
                <p>Restaurant <strong>${name}</strong> (${code}) has never sent a heartbeat.</p>
                <p>The app may not be installed or logged in correctly.</p>
                <p style="color:#999; font-size:12px;">Sent at ${new Date().toLocaleString('de-CH')}</p>
              </div>`
            );
            await redisCommand("SET", k(code, "alert_sent"), "never_seen");
            await redisCommand("EXPIRE", k(code, "alert_sent"), 86400);
          }
          continue;
        }

        const heartbeat = JSON.parse(heartbeatData.result);
        const minutesOffline = Math.floor((Date.now() - new Date(heartbeat.last_seen).getTime()) / 60000);

        if (minutesOffline >= alertSettings.offline_threshold_minutes) {
          // Only send alert once per offline period
          if (!alertSentData.result) {
            const hoursOffline = minutesOffline >= 60 ? Math.floor(minutesOffline/60) + 'h ' + (minutesOffline%60) + 'm' : minutesOffline + ' minutes';
            await sendAlertEmail(
              alertSettings.alert_email,
              `🔴 FoodUp Alert — ${name} is offline`,
              `<div style="font-family:Arial,sans-serif; padding:20px;">
                <h2 style="color:#e74c3c;">🔴 FoodUp Monitor Alert</h2>
                <p>Restaurant <strong>${name}</strong> (${code}) has been offline for <strong>${hoursOffline}</strong>.</p>
                <p>Last seen: ${new Date(heartbeat.last_seen).toLocaleString('de-CH')}</p>
                <p>Please check if the app is open and the device is connected to internet.</p>
                <br>
                <a href="https://foodup-order-alerts-backend.onrender.com/dashboard" style="background:#8B38CB; color:#fff; padding:10px 20px; border-radius:8px; text-decoration:none; font-weight:700;">Open Dashboard</a>
                <p style="color:#999; font-size:12px; margin-top:16px;">Sent at ${new Date().toLocaleString('de-CH')}</p>
              </div>`
            );
            await redisCommand("SET", k(code, "alert_sent"), "offline");
            await redisCommand("EXPIRE", k(code, "alert_sent"), 3600); // Re-alert after 1 hour if still offline
          }
        } else {
          // App is back online — clear alert sent flag and send recovery email if was offline
          if (alertSentData.result === "offline") {
            await sendAlertEmail(
              alertSettings.alert_email,
              `✅ FoodUp Alert — ${name} is back online`,
              `<div style="font-family:Arial,sans-serif; padding:20px;">
                <h2 style="color:#2ecc71;">✅ FoodUp Monitor — Recovered</h2>
                <p>Restaurant <strong>${name}</strong> (${code}) is back online.</p>
                <p>Last seen: ${new Date(heartbeat.last_seen).toLocaleString('de-CH')}</p>
                <p style="color:#999; font-size:12px;">Sent at ${new Date().toLocaleString('de-CH')}</p>
              </div>`
            );
            await redisCommand("DEL", k(code, "alert_sent"));
          }
        }
      } catch(e) {
        console.log(`Alert check error for ${code}:`, e.message);
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
        // Get auto settings
        const autoSettingsData = await redisCommand("GET", k(code, "auto_settings"));
        if (!autoSettingsData.result) continue;
        const autoSettings = JSON.parse(autoSettingsData.result);
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
            // Only process processing orders
            if (order.status === 'cancelled' || order.status === 'completed') continue;

            // Check if already accepted
            const acceptedData = await redisCommand("GET", k(code, `accepted_time:${order.order_id}`));
            if (acceptedData.result) continue;

            // Check if already auto-actioned
            const autoActioned = await redisCommand("GET", k(code, `auto_actioned:${order.order_id}`));
            if (autoActioned.result) continue;

            // Check order age
            const orderDate = order.date_created ? new Date(order.date_created).getTime() : null;
            if (!orderDate) continue;
            const age = Date.now() - orderDate;
            if (age < waitMs) continue;
            if (age > 2 * 60 * 60 * 1000) continue; // skip orders older than 2 hours

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
