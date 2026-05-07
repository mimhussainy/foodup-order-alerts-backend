const express = require("express");
const app = express();
app.use(express.json());

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
    },
  }));

  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(messages),
  });

  const result = await response.json();
  console.log("Push result:", JSON.stringify(result));
  res.json({ success: true, result });
});

app.post("/status-update", async (req, res) => {
  const order = req.body;
  const code = order.restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });

  console.log("Status update for:", code, order.order_id, order.status);
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

app.post("/verify-pin", async (req, res) => {
  const { pin, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });
  const stored = await redisCommand("GET", k(code, "pin"));
  if (stored.result && stored.result === pin) {
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

// -------------------------------------------------------
// DELIVERY ACCOUNTS
// -------------------------------------------------------

app.post("/add-delivery-account", async (req, res) => {
  const { username, password, restaurant_code, owner_pin } = req.body;
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
    username, password, created_at: new Date().toISOString(),
  }));
  await redisCommand("SADD", k(code, "delivery_accounts"), username.toLowerCase());
  res.json({ success: true });
});

app.post("/verify-delivery-account", async (req, res) => {
  const { username, password, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });

  const data = await redisCommand("GET", k(code, `delivery_account:${username.toLowerCase()}`));
  if (!data.result) return res.json({ success: false, message: "Account not found" });

  const account = JSON.parse(data.result);
  if (account.password === password) {
    res.json({ success: true, username: account.username });
  } else {
    res.json({ success: false, message: "Incorrect password" });
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

// -------------------------------------------------------
// DELIVERY TRACKING
// -------------------------------------------------------

app.post("/mark-delivered", async (req, res) => {
  const { order_id, delivery_name, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });

  await redisCommand("SET", k(code, `delivered:${order_id}`), JSON.stringify({
    order_id, delivery_name, delivered_at: new Date().toISOString(),
  }));
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
  const { order_id, delivery_name, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false });

  const existing = await redisCommand("GET", k(code, `claimed:${order_id}`));
  if (existing.result) {
    const claim = JSON.parse(existing.result);
    return res.json({ success: false, message: `Already being delivered by ${claim.delivery_name}` });
  }
  await redisCommand("SET", k(code, `claimed:${order_id}`), JSON.stringify({
    order_id, delivery_name, claimed_at: new Date().toISOString(),
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
    // Check last_order first
    const data = await redisCommand("GET", k(code, "last_order"));
    if (data.result) {
      const order = JSON.parse(data.result);
      if (String(order.order_id) === String(orderId)) {
        return res.json({ success: true, order });
      }
    }
    // Check orders list
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
    const keys = await redisCommand("KEYS", k(code, "claimed:*"));
    const claims: any = {};
    if (keys.result && keys.result.length > 0) {
      await Promise.all(keys.result.map(async (key: string) => {
        const data = await redisCommand("GET", key);
        if (data.result) {
          const claim = JSON.parse(data.result);
          claims[String(claim.order_id)] = claim.delivery_name;
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
  const { owner_pin, restaurant_code, name, phone, address, website } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });

  const storedPin = await redisCommand("GET", k(code, "pin"));
  if (!storedPin.result || storedPin.result !== owner_pin) {
    return res.json({ success: false, message: "Unauthorized" });
  }
  await redisCommand("SET", k(code, "restaurant_profile"), JSON.stringify({
    name, phone, address, website, updated_at: new Date().toISOString(),
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
