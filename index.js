const express = require("express");
const app = express();
app.use(express.json());

let deviceTokens = [];

app.post("/register-token", (req, res) => {
  const { token } = req.body;
  console.log("Registering token:", token);
  if (token && !deviceTokens.includes(token)) {
    deviceTokens.push(token);
  }
  console.log("Total tokens:", deviceTokens.length);
  res.json({ success: true });
});

app.post("/new-order", async (req, res) => {
  const order = req.body;
  console.log("New order received:", order.order_id);
  console.log("Device tokens:", deviceTokens.length);

  if (deviceTokens.length === 0) {
    return res.json({ success: false, message: "No device tokens registered" });
  }

  const messages = deviceTokens.map(token => ({
    to: token,
    sound: "default",
    title: `🛒 New Order #${order.order_id}`,
    body: `${order.customer_name} - ${order.currency} ${order.total}`,
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

app.get("/", (req, res) => {
  res.json({ status: "FoodUp Order Alerts backend is running!", tokens: deviceTokens.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
