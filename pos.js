// -------------------------------------------------------
// POS — PRODUCT CATALOG
// -------------------------------------------------------

// Category ID → addon group post ID mapping
const CATEGORY_ADDON_MAP = {
  36: [2015],        // Pizza 32cm
  52: [2674],        // Pizza 50cm
  40: [2027, 3908],  // Kebab
  55: [2027, 3908],  // Box
  42: [2028],        // Burger
  44: [2029],        // Salate
  56: [3906],        // Cordon Bleu
};

// Specific product → addon group mapping
const PRODUCT_ADDON_MAP = {
  1907: [2027, 3908], 1908: [2027, 3908], 1909: [2027, 3908],
  1910: [2027, 3908], 1911: [2027, 3908], 1912: [2027, 3908],
  1915: [2027, 3908], 1916: [2027, 3908], 1917: [2027, 3908],
  1918: [2027, 3908], 1919: [2027, 3908], 1920: [2027, 3908],
};

module.exports = function(app, redisCommand, k) {

  app.get("/pos/products/:code", async (req, res) => {
    try {
      const code = req.params.code.toLowerCase().trim();
      const cacheKey = k(code, "pos_products");
      const cached = await redisCommand("GET", cacheKey);
      if (cached.result) {
        return res.json({ success: true, products: JSON.parse(cached.result), cached: true });
      }
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
      const productId = parseInt(req.params.product_id);

      const cacheKey = k(code, `pos_addons:${productId}`);
      const cached = await redisCommand("GET", cacheKey);
      if (cached.result) {
        return res.json({ success: true, addons: JSON.parse(cached.result), cached: true });
      }

      // Get addon groups — fetch and cache if needed
      const groupsCacheKey = k(code, "pos_addon_groups");
      const groupsCached = await redisCommand("GET", groupsCacheKey);
      let addonGroups = [];

      if (groupsCached.result) {
        addonGroups = JSON.parse(groupsCached.result);
      } else {
        const profileData = await redisCommand("GET", k(code, "restaurant_profile"));
        if (!profileData.result) return res.json({ success: false, error: "Restaurant not found" });
        const profile = JSON.parse(profileData.result);
        const website = profile.website;
        if (!website) return res.json({ success: false, error: "No website configured" });
        const baseUrl = website.startsWith("http") ? website : `https://${website}`;
        const response = await fetch(`${baseUrl}/wp-json/foodup-pos/v1/addon-groups?secret=foodup_pos_2026`);
        addonGroups = await response.json();
        await redisCommand("SET", groupsCacheKey, JSON.stringify(addonGroups));
        await redisCommand("EXPIRE", groupsCacheKey, 1800);
      }

      // Get products to find categories for this product
      const productsCacheKey = k(code, "pos_products");
      const productsCached = await redisCommand("GET", productsCacheKey);
      let products = [];
      if (productsCached.result) products = JSON.parse(productsCached.result);

      const product = products.find(p => p.id === productId);
      const categoryIds = product ? product.categories.map(c => c.id) : [];

      // Determine applicable addon group IDs
      const applicableGroupIds = new Set();

      if (PRODUCT_ADDON_MAP[productId]) {
        PRODUCT_ADDON_MAP[productId].forEach(id => applicableGroupIds.add(id));
      }

      categoryIds.forEach(catId => {
        if (CATEGORY_ADDON_MAP[catId]) {
          CATEGORY_ADDON_MAP[catId].forEach(id => applicableGroupIds.add(id));
        }
      });

      // Build addons from matching groups
      const addons = [];
      applicableGroupIds.forEach(groupId => {
        const group = addonGroups.find(g => g.id === groupId);
        if (group && Array.isArray(group.fields)) {
          group.fields.forEach(field => {
            const options = (field.options || []).map(opt => ({
              id: opt.id,
              label: opt.label,
              price: opt.price || '0',
            }));
            addons.push({
              id: field.id,
              type: field.type,
              title: field.title,
              required: !!field.required,
              options,
            });
          });
        }
      });

      await redisCommand("SET", cacheKey, JSON.stringify(addons));
      await redisCommand("EXPIRE", cacheKey, 1800);

      res.json({ success: true, addons, cached: false });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

};
