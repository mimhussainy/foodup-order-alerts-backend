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

  // -------------------------------------------------------
  // Helper: get restaurant website/base URL
  // -------------------------------------------------------
  async function getRestaurantBaseUrl(code) {
    const profileData = await redisCommand("GET", k(code, "restaurant_profile"));

    if (!profileData.result) {
      throw new Error("Restaurant not found");
    }

    const profile = JSON.parse(profileData.result);
    const website = profile.website;

    if (!website) {
      throw new Error("No website configured for this restaurant");
    }

    return website.startsWith("http") ? website : `https://${website}`;
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
      // Determine applicable addon group IDs
      // ---------------------------------------------------
      const applicableGroupIds = new Set();

      // Product-specific addon groups
      if (PRODUCT_ADDON_MAP[productId]) {
        PRODUCT_ADDON_MAP[productId].forEach(id => applicableGroupIds.add(Number(id)));
      }

      // Category-based addon groups
      categoryIds.forEach(catId => {
        if (CATEGORY_ADDON_MAP[catId]) {
          CATEGORY_ADDON_MAP[catId].forEach(id => applicableGroupIds.add(Number(id)));
        }
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

};
