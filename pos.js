// -------------------------------------------------------
// POS — PRODUCT CATALOG
// -------------------------------------------------------


module.exports = function(app, redisCommand, k) {

  // -------------------------------------------------------
  // Helper: get restaurant website/base URL
  // -------------------------------------------------------
  async function getRestaurantBaseUrl(code) {
    // Try main restaurant profile first
    const profileData = await redisCommand("GET", k(code, "restaurant_profile"));
    if (profileData.result) {
      const profile = JSON.parse(profileData.result);
      if (profile.website) {
        return profile.website.startsWith("http") ? profile.website : `https://${profile.website}`;
      }
    }

    // Fall back to WordPress-only registration
    const wpWebsite = await redisCommand("GET", k(code, "pos_wordpress_website"));
    if (wpWebsite.result) {
      return wpWebsite.result;
    }

    throw new Error("Restaurant not found");
  }

  // -------------------------------------------------------
  // Helper: fetch products from WordPress and cache them
  // -------------------------------------------------------
  async function fetchAndCacheProducts(code) {
    const baseUrl = await getRestaurantBaseUrl(code);
    const endpoint = `${baseUrl}/wp-json/foodup-pos/v1/products?secret=foodup_pos_2026`;

    const response = await fetch(endpoint);

    if (!response.ok) {
      throw new Error(`WordPress products request failed: ${response.status}`);
    }

    const products = await response.json();

    if (!Array.isArray(products)) {
      throw new Error("Invalid products response from WordPress");
    }

    await redisCommand("SET", k(code, "pos_products"), JSON.stringify(products));
    await redisCommand("EXPIRE", k(code, "pos_products"), 600);

    return products;
  }

  // -------------------------------------------------------
  // Helper: fetch addon groups from WordPress and cache them
  // -------------------------------------------------------
  async function fetchAndCacheAddonGroups(code) {
    const baseUrl = await getRestaurantBaseUrl(code);
    const endpoint = `${baseUrl}/wp-json/foodup-pos/v1/addon-groups?secret=foodup_pos_2026`;

    const response = await fetch(endpoint);

    if (!response.ok) {
      throw new Error(`WordPress addon groups request failed: ${response.status}`);
    }

    const addonGroups = await response.json();

    if (!Array.isArray(addonGroups)) {
      throw new Error("Invalid addon groups response from WordPress");
    }

    await redisCommand("SET", k(code, "pos_addon_groups"), JSON.stringify(addonGroups));
    await redisCommand("EXPIRE", k(code, "pos_addon_groups"), 1800);

    return addonGroups;
  }

  // -------------------------------------------------------
  // GET PRODUCTS
  // -------------------------------------------------------
  app.get("/pos/products/:code", async (req, res) => {
    try {
      const code = req.params.code.toLowerCase().trim();
      const cacheKey = k(code, "pos_products");

      const cached = await redisCommand("GET", cacheKey);

      if (cached.result) {
        return res.json({
          success: true,
          products: JSON.parse(cached.result),
          cached: true,
        });
      }

      const products = await fetchAndCacheProducts(code);

      res.json({
        success: true,
        products,
        cached: false,
      });

    } catch (e) {
      console.log("POS products error:", e.message);
      res.json({
        success: false,
        error: e.message,
      });
    }
  });

  // -------------------------------------------------------
  // REFRESH PRODUCTS / ADDONS CACHE
  // -------------------------------------------------------
  app.post("/pos/products/:code/refresh", async (req, res) => {
    try {
      const code = req.params.code.toLowerCase().trim();

      // Clear main product and addon group cache
      await redisCommand("DEL", k(code, "pos_products"));
      await redisCommand("DEL", k(code, "pos_addon_groups"));

      // Clear product-specific addon caches
      try {
        const keysResult = await redisCommand("KEYS", k(code, "pos_addons:*"));
        const keys = keysResult.result || [];

        if (keys.length > 0) {
          await Promise.all(keys.map(key => redisCommand("DEL", key)));
        }
      } catch (e) {
        console.log("POS addon cache clear warning:", e.message);
      }

      res.json({
        success: true,
        message: "POS cache cleared",
      });

    } catch (e) {
      console.log("POS refresh error:", e.message);
      res.json({
        success: false,
        error: e.message,
      });
    }
  });

  // -------------------------------------------------------
  // GET ADDONS FOR PRODUCT
  // -------------------------------------------------------
  app.get("/pos/addons/:code/:product_id", async (req, res) => {
    try {
      const code = req.params.code.toLowerCase().trim();
      const productId = parseInt(req.params.product_id, 10);

      if (!productId || Number.isNaN(productId)) {
        return res.json({
          success: false,
          error: "Invalid product ID",
        });
      }

      const cacheKey = k(code, `pos_addons:${productId}`);
      const cached = await redisCommand("GET", cacheKey);

      if (cached.result) {
        return res.json({
          success: true,
          addons: JSON.parse(cached.result),
          cached: true,
        });
      }

      // ---------------------------------------------------
      // Load addon groups
      // ---------------------------------------------------
const groupsCacheKey = k(code, "pos_addon_groups");
      const groupsCached = await redisCommand("GET", groupsCacheKey);

      let addonGroups = [];

      if (groupsCached.result) {
        addonGroups = JSON.parse(groupsCached.result);
      } else {
        addonGroups = await fetchAndCacheAddonGroups(code);
      }

      console.log('Product ID:', productId, 'Category IDs:', categoryIds);
      console.log('Addon groups count:', addonGroups.length);
      if (addonGroups.length > 0) console.log('First group conditions:', JSON.stringify(addonGroups[0].conditions));

      if (!Array.isArray(addonGroups)) {
        addonGroups = [];
      }

      // ---------------------------------------------------
      // Load products
      // Important fix:
      // If products cache is empty, fetch products from WordPress.
      // Otherwise category-based addons will not work.
      // ---------------------------------------------------
      const productsCacheKey = k(code, "pos_products");
      const productsCached = await redisCommand("GET", productsCacheKey);

      let products = [];

      if (productsCached.result) {
        products = JSON.parse(productsCached.result);
      } else {
        products = await fetchAndCacheProducts(code);
      }

      if (!Array.isArray(products)) {
        products = [];
      }

      const product = products.find(p => Number(p.id) === Number(productId));

      const categoryIds = product && Array.isArray(product.categories)
        ? product.categories.map(c => Number(c.id))
        : [];

      // ---------------------------------------------------
      // Determine applicable addon group IDs dynamically
      // using conditions from WordPress addon groups
      // ---------------------------------------------------
      const applicableGroupIds = new Set();

      addonGroups.forEach(group => {
        if (!Array.isArray(group.conditions)) return;
        const matchesAny = group.conditions.some(orGroup => {
          if (!Array.isArray(orGroup)) return false;
          return orGroup.every(condition => {
            if (!condition || !condition.objectType) return false;
            if (condition.objectType === 'product_category') {
              return categoryIds.includes(Number(condition.objects?.code));
            }
            if (condition.objectType === 'product') {
              return Number(condition.objects?.code) === Number(productId);
            }
            return false;
          });
        });
        if (matchesAny) applicableGroupIds.add(Number(group.id));
      });

      // ---------------------------------------------------
      // Build addons from matching groups
      // ---------------------------------------------------
      const addons = [];

      applicableGroupIds.forEach(groupId => {
        const group = addonGroups.find(g => Number(g.id) === Number(groupId));

        if (group && Array.isArray(group.fields)) {
          group.fields.forEach(field => {
            const options = Array.isArray(field.options)
              ? field.options.map(opt => ({
                  id: opt.id,
                  label: opt.label || '',
                  price: opt.price || '0',
                }))
              : [];

            addons.push({
              id: field.id,
              type: field.type || '',
              title: field.title || '',
              required: !!field.required,
              options,
            });
          });
        }
      });

      await redisCommand("SET", cacheKey, JSON.stringify(addons));
      await redisCommand("EXPIRE", cacheKey, 1800);

      res.json({
        success: true,
        addons,
        cached: false,
        product_id: productId,
        category_ids: categoryIds,
        addon_group_ids: Array.from(applicableGroupIds),
      });

    } catch (e) {
      console.log("POS addons error:", e.message);
      res.json({
        success: false,
        error: e.message,
      });
    }
  });

  // -------------------------------------------------------
  // GET TABLES
  // -------------------------------------------------------
  app.get("/pos/tables/:code", async (req, res) => {
    try {
      const code = req.params.code.toLowerCase().trim();
      const data = await redisCommand("GET", k(code, "pos_tables"));

      if (data.result) {
        return res.json({
          success: true,
          tables: JSON.parse(data.result),
        });
      }

      // Default 10 tables
      const defaultTables = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        name: `Table ${i + 1}`,
        seats: 4,
      }));

      res.json({
        success: true,
        tables: defaultTables,
      });

    } catch (e) {
      console.log("POS tables error:", e.message);
      res.json({
        success: false,
        error: e.message,
      });
    }
  });

  // -------------------------------------------------------
  // SAVE TABLES
  // -------------------------------------------------------
  app.post("/pos/tables/:code", async (req, res) => {
    try {
      const code = req.params.code.toLowerCase().trim();
      const { tables } = req.body;
      if (!Array.isArray(tables)) {
        return res.json({
          success: false,
          error: "Tables must be an array",
        });
      }
      await redisCommand("SET", k(code, "pos_tables"), JSON.stringify(tables));
      res.json({
        success: true,
      });
    } catch (e) {
      console.log("POS save tables error:", e.message);
      res.json({
        success: false,
        error: e.message,
      });
    }
  });

  // -------------------------------------------------------
  // PLACE ORDER
  // -------------------------------------------------------
  app.post("/pos/orders/:code", async (req, res) => {
    try {
      const code = req.params.code.toLowerCase().trim();
      const order = req.body;
      const counterKey = k(code, "pos_order_counter");
      const counterData = await redisCommand("INCR", counterKey);
      const orderNumber = `POS-${String(counterData.result).padStart(3, '0')}`;
      const orderId = `pos_${Date.now()}`;
      const fullOrder = {
        ...order,
        id: orderId,
        order_number: orderNumber,
        restaurant_code: code,
        source: 'pos',
        created_at: new Date().toISOString(),
      };
      await redisCommand("LPUSH", k(code, "pos_orders"), JSON.stringify(fullOrder));
      await redisCommand("LTRIM", k(code, "pos_orders"), 0, 199);
      res.json({ success: true, order_id: orderNumber });
    } catch (e) {
      console.log("POS place order error:", e.message);
      res.json({ success: false, error: e.message });
    }
  });

  // -------------------------------------------------------
  // GET ORDERS
  // -------------------------------------------------------
app.get("/pos/orders/:code", async (req, res) => {
    try {
      const code = req.params.code.toLowerCase().trim();
      const data = await redisCommand("LRANGE", k(code, "pos_orders"), 0, 99);
      const orders = (data.result || []).map(o => JSON.parse(o));
      res.json({ success: true, orders });
    } catch (e) {
      console.log("POS get orders error:", e.message);
      res.json({ success: false, error: e.message });
    }
  });

  app.post("/pos/register-wordpress", async (req, res) => {
    try {
      const { restaurant_code, restaurant_name, website, secret } = req.body;
      if (secret !== 'foodup_pos_2026') {
        return res.json({ success: false, error: 'Invalid secret' });
      }
      if (!restaurant_code || !website) {
        return res.json({ success: false, error: 'Missing fields' });
      }
      await redisCommand("SET", k(restaurant_code, "pos_wordpress_website"), website);
      await redisCommand("SET", k(restaurant_code, "pos_wordpress_name"), restaurant_name || restaurant_code);
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  app.post("/pos/verify-wordpress-pin", async (req, res) => {
    try {
      const { restaurant_code, pin } = req.body;
      if (!restaurant_code || !pin) {
        return res.json({ success: false, error: 'Missing fields' });
      }
      const websiteData = await redisCommand("GET", k(restaurant_code, "pos_wordpress_website"));
      if (!websiteData.result) {
        return res.json({ success: false, error: 'Restaurant not found' });
      }
      const website = websiteData.result;
      const wpRes = await fetch(`${website}/wp-json/foodup-pos/v1/verify-pin?secret=foodup_pos_2026`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const wpResult = await wpRes.json();
      if (wpResult.success) {
        return res.json({
          success: true,
          restaurant_name: wpResult.restaurant_name,
          logo_url: wpResult.logo_url || '',
          website,
        });
      }
      res.json({ success: false, error: 'Invalid PIN' });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

};
