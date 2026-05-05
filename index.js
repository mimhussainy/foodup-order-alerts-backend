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
  console.log("Items:", JSON.stringify(order.items));

  const deviceTokens = await getTokens();
  console.log("Device tokens:", deviceTokens.length);

  if (deviceTokens.length === 0) {
    return res.json({ success: false, message: "No device tokens registered" });
  }

  // Build a safe items string
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
    sound: "default",
    title: `🛒 New Order #${order.order_id}`,
    body: `${order.customer_name} - ${order.currency} ${order.total}`,
    data: {
      order_id: String(order.order_id || ''),
      customer_name: String(order.customer_name || ''),
      total: String(order.total || ''),
      currency: String(order.currency || ''),
      status: String(order.status || ''),
      items: itemsString,
      payment_method: String(order.payment_method || ''),
      note: String(order.note || ''),
    },
  }));

  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(messages),
  });

  const result = await response.json();
  console.log("Push result:", JSON.stringify(result));
  res.json({ success: true, result });
});

app.get("/", async (req, res) => {
  const tokens = await getTokens();
  res.json({ status: "FoodUp Order Alerts backend is running!", tokens: tokens.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
