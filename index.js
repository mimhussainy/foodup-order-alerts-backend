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

app.post("/verify-ios-pin", async (req, res) => {
  const { ios_pin, restaurant_code } = req.body;
  const code = restaurant_code?.toLowerCase().trim();
  if (!code) return res.json({ success: false, message: "Restaurant code required" });
  const stored = await redisCommand("GET", k(code, "ios_pin"));
  if (!stored.result) return res.json({ success: false, message: "iOS PIN not set" });
  if (stored.result === ios_pin) {
    res.json({ success: true });
  } else {
    res.json({ success: false, message: "Incorrect iOS PIN" });
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

    // Get active claims
    const claimKeys = await redisCommand("KEYS", k(code, "claimed:*"));
    if (claimKeys.result && claimKeys.result.length > 0) {
      await Promise.all(claimKeys.result.map(async (key) => {
        const data = await redisCommand("GET", key);
        if (data.result) {
          const claim = JSON.parse(data.result);
          claims[String(claim.order_id)] = { name: claim.delivery_name, status: claim.delivery_status || 'in_bag' };
        }
      }));
    }

    // Get orders list and check delivered status for each
    const listData = await redisCommand("LRANGE", k(code, "orders"), 0, 99);
    const orders = (listData.result || []).map((o) => JSON.parse(o));
    await Promise.all(orders.map(async (order) => {
      const deliveredData = await redisCommand("GET", k(code, `delivered:${order.order_id}`));
      if (deliveredData.result) {
        const delivered = JSON.parse(deliveredData.result);
        claims[String(delivered.order_id)] = { name: delivered.delivery_name, status: 'delivered' };
      }
    }));

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


app.get("/debug-tokens/:code", async (req, res) => {
  const code = req.params.code.toLowerCase().trim();
  const tokens = await getTokens(code);
  res.json({ success: true, count: tokens.length, tokens });
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
