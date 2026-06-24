// -------------------------------------------------------
// POS — PRODUCT CATALOG
// -------------------------------------------------------

module.exports = function(app, redisCommand, k) {

  app.get("/pos/products/:code", async (req, res) => {
    try {
      const code = req.params.code.toLowerCase().trim();

      // Check Redis cache first
      const cacheKey = k(code, "pos_products");
      const cached = await redisCommand("GET", cacheKey);
      if (cached.result) {
        return res.json({ success: true, products: JSON.parse(cached.result), cached: true });
      }

      // Get restaurant profile to find website URL
      const profileData = await redisCommand("GET", k(code, "restaurant_profile"));
      if (!profileData.result) {
        return res.json({ success: false, error: "Restaurant not found" });
      }

      const profile = JSON.parse(profileData.result);
      const website = profile.website;
      if (!website) {
        return res.json({ success: false, error: "No website configured for this restaurant" });
      }

      const baseUrl = website.startsWith("http") ? website : `https://${website}`;
      const endpoint = `${baseUrl}/wp-json/foodup-pos/v1/products?secret=foodup_pos_2026`;

      const response = await fetch(endpoint);
      const products = await response.json();

      if (!Array.isArray(products)) {
        return res.json({ success: false, error: "Invalid response from WordPress" });
      }

      // Cache for 10 minutes
      await redisCommand("SET", cacheKey, JSON.stringify(products));
      await redisCommand("EXPIRE", cacheKey, 600);

      res.json({ success: true, products, cached: false });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  app.post("/pos/products/:code/refresh", async (req, res) => {
    try {
      const code = req.params.code.toLowerCase().trim();
      await redisCommand("DEL", k(code, "pos_products"));
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  app.get("/pos/addons/:code/:product_id", async (req, res) => {
    try {
      const code = req.params.code.toLowerCase().trim();
      const productId = req.params.product_id;

      const cacheKey = k(code, `pos_addons:${productId}`);
      const cached = await redisCommand("GET", cacheKey);
      if (cached.result) {
        return res.json({ success: true, addons: JSON.parse(cached.result), cached: true });
      }

      const profileData = await redisCommand("GET", k(code, "restaurant_profile"));
      if (!profileData.result) {
        return res.json({ success: false, error: "Restaurant not found" });
      }

      const profile = JSON.parse(profileData.result);
      const website = profile.website;
      if (!website) {
        return res.json({ success: false, error: "No website configured" });
      }

      const baseUrl = website.startsWith("http") ? website : `https://${website}`;
      const endpoint = `${baseUrl}/wp-json/foodup-pos/v1/addons/${productId}?secret=foodup_pos_2026`;

      const response = await fetch(endpoint);
      const data = await response.json();

      if (!data.addons) {
        return res.json({ success: true, addons: [] });
      }

      // Cache for 30 minutes
      await redisCommand("SET", cacheKey, JSON.stringify(data.addons));
      await redisCommand("EXPIRE", cacheKey, 1800);

      res.json({ success: true, addons: data.addons, cached: false });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

};
