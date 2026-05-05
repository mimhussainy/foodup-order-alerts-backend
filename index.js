const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Store device tokens (in memory for now)
let deviceTokens = [];

// Endpoint to register device token from the app
app.post("/register-token", (req, res) => {
  const { token } = req.body;
  if (token && !deviceTokens.includes(token)) {
    deviceTokens.push(token);
  }
  res.json({ success: true });
});

// Endpoint to receive new order from WooCommerce plugin
app.post("/new-order", async (req, res) => {
  const order = req.body;

  if (deviceTokens.length === 0) {
    return res.json({ success: false, message: "No device tokens registered" });
  }

  const message = {
    notification: {
      title: `🛒 New Order #${order.order_id}`,
      body: `${order.customer_name} - ${order.currency} ${order.total}`,
    },
    data: {
      order_id: String(order.order_id),
      customer_name: order.customer_name,
      total: String(order.total),
      currency: order.currency,
      status: order.status,
      items: JSON.stringify(order.items),
      payment_method: order.payment_method,
      note: order.note || "",
    },
    tokens: deviceTokens,
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    res.json({ success: true, sent: response.successCount });
  } catch (error) {
    console.error("Error sending notification:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "FoodUp Order Alerts backend is running!" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
