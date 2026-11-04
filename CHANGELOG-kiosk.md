# FoodUp Orders backend: kiosk changelog

## 1.1.0: kiosk orders

New files: `kioskOrders.js`, `test/kioskOrders.test.js`. Edited: `index.js`, `package.json`.

- **Push data** (every push of an order, `foodupOrderContextPushData`): `kiosk_device`, `kiosk_name`,
  `payment_status`, `payment_method_id` and `paid` ("true" / "false") are passed on, so the Orders app
  knows the kiosk and whether the order is paid.
- **Push title and body** for kiosk orders (`source = "kiosk"`):
  `🛒 Kiosk #104 · Hier essen` / `· Mitnehmen`, body `CHF 24.50 • Online bezahlt` or `CHF 24.50 • An der Kasse zahlen`.
  Status pushes and auto-accepted pushes use the label `Kiosk #104`. QR and normal orders keep their wording.
- **Always accepted**: a kiosk order is accepted right after it arrives, whatever the auto-accept setting is
  (even when it is switched off). WordPress is asked first (`/order-accepted`); only when it confirms are the
  usual markers written and the `auto_accepted` push sent, which makes the Orders app print the ticket.
  Retries: 0 s, 2 s, 6 s, 15 s, 45 s, then every minute for 10 minutes.
- The per-minute auto-action never auto-rejects a kiosk order.
- `npm test` includes the new tests.
