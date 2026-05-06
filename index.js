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

async function getTokens() {
  const result = await redisCommand("SMEMBERS", "device_tokens");
  return result.result || [];
}

async function saveToken(token) {
  await redisCommand("SADD", "device_tokens", token);
}

app.post("/register-token", async (req, res) => {
  const { token } = req.body;
  console.log("Registering token:", token);
  await saveToken(token);
  const tokens = await getTokens();
  console.log("Total tokens:", tokens.length);
  res.json({ success: true });
});

app.post("/new-order", async (req, res) => {
  const order = req.body;
  console.log("New order received:", order.order_id);

  await redisCommand("SET", "last_order", JSON.stringify(order));

  const deviceTokens = await getTokens();
  console.log("Device tokens:", deviceTokens.length);

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
  console.log("Status update:", order.order_id, order.status);

  const deviceTokens = await getTokens();
  if (deviceTokens.length === 0) {
    return res.json({ success: false });
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
    sound: null,
    title: `Order #${order.order_id} updated`,
    body: `Status: ${order.status}`,
    data: {
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

app.post("/verify-pin", (req, res) => {
  const { pin } = req.body;
  const correctPin = process.env.OWNER_PIN || '1234';
  if (pin === correctPin) {
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

// -------------------------------------------------------
// DELIVERY ACCOUNTS
// -------------------------------------------------------

app.post("/add-delivery-account", async (req, res) => {
  const { username, password, owner_pin } = req.body;
  const correctPin = process.env.OWNER_PIN || '1234';
  if (owner_pin !== correctPin) {
    return res.json({ success: false, message: "Unauthorized" });
  }
  if (!username || !password) {
    return res.json({ success: false, message: "Username and password required" });
  }
  // Check if username already exists
  const existing = await redisCommand("GET", `delivery_account:${username.toLowerCase()}`);
  if (existing.result) {
    return res.json({ success: false, message: "Username already exists" });
  }
  await redisCommand("SET", `delivery_account:${username.toLowerCase()}`, JSON.stringify({
    username,
    password,
    created_at: new Date().toISOString(),
  }));
  await redisCommand("SADD", "delivery_accounts", username.toLowerCase());
  res.json({ success: true });
});

app.post("/verify-delivery-account", async (req, res) => {
  const { username, password } = req.body;
  const data = await redisCommand("GET", `delivery_account:${username.toLowerCase()}`);
  if (!data.result) {
    return res.json({ success: false, message: "Account not found" });
  }
  const account = JSON.parse(data.result);
  if (account.password === password) {
    res.json({ success: true, username: account.username });
  } else {
    res.json({ success: false, message: "Incorrect password" });
  }
});

app.get("/delivery-accounts", async (req, res) => {
  const { owner_pin } = req.query;
  const correctPin = process.env.OWNER_PIN || '1234';
  if (owner_pin !== correctPin) {
    return res.json({ success: false, message: "Unauthorized" });
  }
  const result = await redisCommand("SMEMBERS", "delivery_accounts");
  const usernames = result.result || [];
  const accounts = await Promise.all(usernames.map(async (u) => {
    const data = await redisCommand("GET", `delivery_account:${u}`);
    return data.result ? JSON.parse(data.result) : null;
  }));
  res.json({ success: true, accounts: accounts.filter(Boolean) });
});

app.delete("/delete-delivery-account", async (req, res) => {
  const { username, owner_pin } = req.body;
  const correctPin = process.env.OWNER_PIN || '1234';
  if (owner_pin !== correctPin) {
    return res.json({ success: false, message: "Unauthorized" });
  }
  await redisCommand("DEL", `delivery_account:${username.toLowerCase()}`);
  await redisCommand("SREM", "delivery_accounts", username.toLowerCase());
  res.json({ success: true });
});

// -------------------------------------------------------
// DELIVERY TRACKING
// -------------------------------------------------------

app.post("/mark-delivered", async (req, res) => {
  const { order_id, delivery_name } = req.body;
  await redisCommand("SET", `delivered:${order_id}`, JSON.stringify({
    order_id,
    delivery_name,
    delivered_at: new Date().toISOString(),
  }));
  res.json({ success: true });
});

app.get("/check-delivered/:id", async (req, res) => {
  const data = await redisCommand("GET", `delivered:${req.params.id}`);
  if (data.result) {
    res.json({ success: true, delivered: true, info: JSON.parse(data.result) });
  } else {
    res.json({ success: true, delivered: false });
  }
});

app.get("/order/:id", async (req, res) => {
  const orderId = req.params.id;
  try {
    const data = await redisCommand("GET", "last_order");
    if (data.result) {
      const order = JSON.parse(data.result);
      if (String(order.order_id) === String(orderId)) {
        return res.json({ success: true, order });
      }
    }
    res.json({ success: false, message: "Order not found" });
  } catch(e) {
    res.json({ success: false, message: "Error fetching order" });
  }
});

app.get("/last-order", async (req, res) => {
  const data = await redisCommand("GET", "last_order");
  res.json(data.result ? JSON.parse(data.result) : {});
});

// Claim an order
app.post("/claim-order", async (req, res) => {
  const { order_id, delivery_name } = req.body;
  
  // Check if already claimed
  const existing = await redisCommand("GET", `claimed:${order_id}`);
  if (existing.result) {
    const claim = JSON.parse(existing.result);
    return res.json({ success: false, message: `Already being delivered by ${claim.delivery_name}` });
  }

  await redisCommand("SET", `claimed:${order_id}`, JSON.stringify({
    order_id,
    delivery_name,
    claimed_at: new Date().toISOString(),
  }));
  res.json({ success: true });
});

// Check if order is claimed
app.get("/check-claimed/:id", async (req, res) => {
  const data = await redisCommand("GET", `claimed:${req.params.id}`);
  if (data.result) {
    res.json({ success: true, claimed: true, info: JSON.parse(data.result) });
  } else {
    res.json({ success: true, claimed: false });
  }
});

// Release claim when delivered
app.post("/release-claim", async (req, res) => {
  const { order_id } = req.body;
  await redisCommand("DEL", `claimed:${order_id}`);
  res.json({ success: true });
});

app.post("/reset-delivery-password", async (req, res) => {
  const { username, new_password, owner_pin } = req.body;
  const correctPin = process.env.OWNER_PIN || '1234';
  if (owner_pin !== correctPin) {
    return res.json({ success: false, message: "Unauthorized" });
  }
  const data = await redisCommand("GET", `delivery_account:${username.toLowerCase()}`);
  if (!data.result) {
    return res.json({ success: false, message: "Account not found" });
  }
  const account = JSON.parse(data.result);
  account.password = new_password;
  await redisCommand("SET", `delivery_account:${username.toLowerCase()}`, JSON.stringify(account));
  res.json({ success: true });
});

app.post("/restaurant-profile", async (req, res) => {
  const { owner_pin, name, phone, address, hours, website } = req.body;
  const correctPin = process.env.OWNER_PIN || '1234';
  if (owner_pin !== correctPin) {
    return res.json({ success: false, message: "Unauthorized" });
  }
  await redisCommand("SET", "restaurant_profile", JSON.stringify({
    name, phone, address, hours, website,
    updated_at: new Date().toISOString(),
  }));
  res.json({ success: true });
});

app.get("/restaurant-profile", async (req, res) => {
  const data = await redisCommand("GET", "restaurant_profile");
  if (data.result) {
    res.json({ success: true, profile: JSON.parse(data.result) });
  } else {
    res.json({ success: false });
  }
});

app.get("/", async (req, res) => {
  const tokens = await getTokens();
  res.json({ status: "FoodUp Order Alerts backend is running!", tokens: tokens.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
