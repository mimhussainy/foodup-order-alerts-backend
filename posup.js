const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─────────────────────────────────────────
// POST /posup/import/:code
// Triggers a full product import from WordPress into Supabase
// Body: { wp_site_url, secret_key }
// ─────────────────────────────────────────

router.post('/import/:code', async (req, res) => {
  const { code } = req.params;
  const { wp_site_url, secret_key } = req.body;

  if (!wp_site_url || !secret_key) {
    return res.status(400).json({ error: 'wp_site_url and secret_key are required' });
  }

  try {
    // 1. Fetch full product data from WordPress plugin
    const wpRes = await fetch(`${wp_site_url}/wp-json/posup/v1/products-full`, {
      headers: { 'X-POSUP-Key': secret_key }
    });

    if (!wpRes.ok) {
      return res.status(400).json({ error: `WordPress returned ${wpRes.status}. Check wp_site_url and secret_key.` });
    }

    const wpData = await wpRes.json();

    // 2. Fetch profile from WordPress
    const profileRes = await fetch(`${wp_site_url}/wp-json/posup/v1/profile`, {
      headers: { 'X-POSUP-Key': secret_key }
    });
    const profile = profileRes.ok ? await profileRes.json() : {};

    // 3. Upsert restaurant
    const { data: restaurant, error: restErr } = await supabase
      .from('restaurants')
      .upsert({
        code,
        name:             profile.restaurant_name || code,
        wp_site_url,
        secret_key,
        logo_url:         profile.logo_url || '',
        printer_ip:       profile.printer_ip || '',
        printer_port:     profile.printer_port || '9100',
        printer_model:    profile.printer_model || '',
        currency:         profile.currency || 'CHF',
        currency_symbol:  profile.currency_symbol || 'CHF',
        pin:              profile.pin || '1234',
        active:           true,
      }, { onConflict: 'code' })
      .select()
      .single();

    if (restErr) throw new Error(`Restaurant upsert failed: ${restErr.message}`);
    const restaurantId = restaurant.id;

    // 4. Clear existing data for this restaurant (fresh import)
    await supabase.from('addon_category_assignments').delete().in(
      'addon_group_id',
      (await supabase.from('addon_groups').select('id').eq('restaurant_id', restaurantId)).data?.map(r => r.id) || []
    );
    await supabase.from('addon_product_assignments').delete().in(
      'addon_group_id',
      (await supabase.from('addon_groups').select('id').eq('restaurant_id', restaurantId)).data?.map(r => r.id) || []
    );
    await supabase.from('addon_options').delete().in(
      'addon_group_id',
      (await supabase.from('addon_groups').select('id').eq('restaurant_id', restaurantId)).data?.map(r => r.id) || []
    );
    await supabase.from('addon_groups').delete().eq('restaurant_id', restaurantId);
    await supabase.from('product_categories').delete().in(
      'product_id',
      (await supabase.from('products').select('id').eq('restaurant_id', restaurantId)).data?.map(r => r.id) || []
    );
    await supabase.from('variations').delete().in(
      'product_id',
      (await supabase.from('products').select('id').eq('restaurant_id', restaurantId)).data?.map(r => r.id) || []
    );
await supabase.from('categories').delete().eq('restaurant_id', restaurantId);

    // 5. Insert categories
    const categoryWcIdToUuid = {};
    for (const cat of wpData.categories) {
      const { data: inserted, error } = await supabase
        .from('categories')
        .insert({
          restaurant_id: restaurantId,
          wc_id:         cat.wc_id,
          name:          cat.name,
          slug:          cat.slug || '',
          description:   cat.description || '',
          parent_id:     cat.parent_id || null,
          thumbnail_url: cat.thumbnail_url || '',
          sort_order:    cat.sort_order || 0,
          active:        true,
        })
        .select()
        .single();
      if (error) throw new Error(`Category insert failed (${cat.name}): ${error.message}`);
      categoryWcIdToUuid[cat.wc_id] = inserted.id;
    }

// 6. Upsert products + variations + category mappings
    const productWcIdToUuid = {};
    for (const product of wpData.products) {
      // Check if product exists and has price_overridden
      const { data: existing } = await supabase
        .from('products')
        .select('id, price, price_overridden, is_alcohol')
        .eq('restaurant_id', restaurantId)
        .eq('wc_id', product.wc_id)
        .single();

            const priceOverridden = existing?.price_overridden === true;
      const finalPrice = priceOverridden ? existing.price : (product.price || 0);
      const isAlcohol = existing?.is_alcohol === true;

      const { data: inserted, error } = await supabase
        .from('products')
        .upsert({
          restaurant_id:  restaurantId,
          wc_id:          product.wc_id,
          name:           product.name,
          description:    product.description || '',
          type:           product.type || 'simple',
          price:          finalPrice,
          regular_price:  product.regular_price || 0,
          image_url:      product.image_url || '',
          sort_order:     product.sort_order || 0,
          active:         true,
          is_alcohol:     isAlcohol,
        }, { onConflict: 'restaurant_id,wc_id' })
        .select()
        .single();
      if (error) throw new Error(`Product upsert failed (${product.name}): ${error.message}`);

      const productId = inserted.id;
      productWcIdToUuid[product.wc_id] = productId;

      // Clear and re-insert category mappings
      await supabase.from('product_categories').delete().eq('product_id', productId);
      for (const catWcId of product.category_ids) {
        const catUuid = categoryWcIdToUuid[catWcId];
        if (!catUuid) continue;
        await supabase.from('product_categories').insert({
          product_id:  productId,
          category_id: catUuid,
        });
      }

      // Clear and re-insert variations
      await supabase.from('variations').delete().eq('product_id', productId);
      for (const variation of product.variations || []) {
        await supabase.from('variations').insert({
          product_id: productId,
          wc_id:      variation.wc_id,
          name:       variation.name.replace(/<[^>]*>/g, ' - ').replace(/\s+/g, ' ').trim(),
          price:      variation.price || 0,
          attributes: variation.attributes || {},
          active:     true,
        });
      }
    }

    // Delete products that no longer exist in WP
    const wpWcIds = wpData.products.map(p => p.wc_id);
    await supabase.from('products')
      .delete()
      .eq('restaurant_id', restaurantId)
      .not('wc_id', 'in', `(${wpWcIds.join(',')})`);

    // 7. Insert addon groups + options + assignments
    for (const addon of wpData.addons) {
      const { data: insertedGroup, error: groupErr } = await supabase
        .from('addon_groups')
        .insert({
          restaurant_id: restaurantId,
          wc_id:         addon.wc_id,
          name:          addon.name,
          active:        true,
        })
        .select()
        .single();
      if (groupErr) throw new Error(`Addon group insert failed (${addon.name}): ${groupErr.message}`);

      const groupId = insertedGroup.id;

      // Insert options (flatten nested options)
      let sortOrder = 0;
      for (const optionGroup of addon.options || []) {
        for (const opt of optionGroup.options || []) {
          await supabase.from('addon_options').insert({
            addon_group_id: groupId,
            wc_option_id:   opt.id,
            name:           opt.name,
            price:          opt.price || 0,
            type:           optionGroup.type || 'checkbox',
            required:       optionGroup.required || false,
            sort_order:     sortOrder++,
            active:         true,
          });
        }
      }

      // Category assignments
      for (const catWcId of addon.assigned_category_ids || []) {
        const catUuid = categoryWcIdToUuid[catWcId];
        if (!catUuid) continue;
        await supabase.from('addon_category_assignments').insert({
          addon_group_id: groupId,
          category_id:    catUuid,
        });
      }

      // Product assignments
      for (const prodWcId of addon.assigned_product_ids || []) {
        const prodUuid = productWcIdToUuid[prodWcId];
        if (!prodUuid) continue;
        await supabase.from('addon_product_assignments').insert({
          addon_group_id: groupId,
          product_id:     prodUuid,
        });
      }
    }

    res.json({
      success:    true,
      restaurant: code,
      imported:   {
        categories: wpData.categories.length,
        products:   wpData.products.length,
        addons:     wpData.addons.length,
      }
    });

  } catch (err) {
    console.error('POSUP import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /posup/products/:code
// Returns all products for a restaurant from Supabase
// ─────────────────────────────────────────
router.get('/products/:code', async (req, res) => {
  const { code } = req.params;
  try {
    // Get restaurant first (needed for restaurantId)
    const { data: restaurant, error: restErr } = await supabase
      .from('restaurants')
      .select('id, name, logo_url, printer_ip, printer_port, printer_model, currency, currency_symbol')
      .eq('code', code)
      .single();
    if (restErr || !restaurant) return res.status(404).json({ error: 'Restaurant not found' });
    const restaurantId = restaurant.id;

    // Run categories, products, and addons queries in parallel
    const [categoriesRes, productsRes, addonGroupsRes] = await Promise.all([
      supabase
        .from('categories')
        .select('*')
        .eq('restaurant_id', restaurantId)
        .eq('active', true)
        .order('name'),
      supabase
        .from('products')
        .select(`
          *,
          product_categories(category_id),
          variations(*)
        `)
        .eq('restaurant_id', restaurantId)
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true }),
      supabase
        .from('addon_groups')
        .select(`
          *,
          addon_options(*),
          addon_category_assignments(category_id),
          addon_product_assignments(product_id)
        `)
        .eq('restaurant_id', restaurantId)
        .eq('active', true)
    ]);

    const categories = categoriesRes.data;
    const products = productsRes.data;
    const addonGroups = addonGroupsRes.data;

// Format products
    const formattedProducts = (products || []).map(p => ({
      id:              p.id,
      wc_id:           p.wc_id,
      name:            p.name,
      description:     p.description,
      type:            p.type,
      price:           p.price,
      price_overridden: p.price_overridden,
      regular_price:   p.regular_price,
      image_url:       p.image_url,
      sort_order:      p.sort_order,
      active:          p.active,
      is_alcohol:      p.is_alcohol === true,
      category_ids:    (p.product_categories || []).map(pc => pc.category_id),
      variations:      (p.variations || []).map(v => ({
        id:         v.id,
        wc_id:      v.wc_id,
        name:       v.name,
        price:      v.price,
        attributes: v.attributes,
        active:     v.active,
      })),
    }));

    // Format addons
    const formattedAddons = (addonGroups || []).map(g => ({
      id:                    g.id,
      wc_id:                 g.wc_id,
      name:                  g.name,
      options:               (g.addon_options || []).sort((a, b) => a.sort_order - b.sort_order),
      assigned_category_ids: (g.addon_category_assignments || []).map(a => a.category_id),
      assigned_product_ids:  (g.addon_product_assignments || []).map(a => a.product_id),
    }));

    res.json({
      restaurant,
      categories: categories || [],
      products:   formattedProducts,
      addons:     formattedAddons,
    });

  } catch (err) {
    console.error('POSUP products error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /posup/profile/:code
// Returns restaurant profile only
// ─────────────────────────────────────────
router.get('/profile/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const { data: restaurant, error } = await supabase
      .from('restaurants')
.select('name, logo_url, printer_ip, printer_port, printer_model, currency, currency_symbol, admin_pin, wp_site_url, secret_key')
      .eq('code', code)
      .single();

    if (error || !restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    // Try to fetch live printer + pin settings from WordPress
    if (restaurant.wp_site_url && restaurant.secret_key) {
      try {
        const wpRes = await fetch(`${restaurant.wp_site_url}/wp-json/posup/v1/profile`, {
          headers: { 'X-POSUP-Key': restaurant.secret_key },
          signal: AbortSignal.timeout(5000),
        });
        if (wpRes.ok) {
          const wpProfile = await wpRes.json();
                    // Update Supabase with latest printer settings only.
          // PINs are managed by POSUP backend/app/dashboard, not WordPress.
          await supabase.from('restaurants').update({
            printer_ip:    wpProfile.printer_ip || restaurant.printer_ip,
            printer_port:  wpProfile.printer_port || restaurant.printer_port,
            printer_model: wpProfile.printer_model || restaurant.printer_model,
          }).eq('code', code);

          return res.json({
            name:             restaurant.name,
            logo_url:         restaurant.logo_url,
            printer_ip:       wpProfile.printer_ip || restaurant.printer_ip,
            printer_port:     wpProfile.printer_port || restaurant.printer_port,
            printer_model:    wpProfile.printer_model || restaurant.printer_model,
            currency:         restaurant.currency,
            currency_symbol:  restaurant.currency_symbol,
          });
        }
      } catch (wpErr) {
        console.log('WordPress profile fetch failed, using cached data:', wpErr.message);
      }
    }

    // Fallback to Supabase cached data
    res.json({
      name:            restaurant.name,
      logo_url:        restaurant.logo_url,
      printer_ip:      restaurant.printer_ip,
      printer_port:    restaurant.printer_port,
      printer_model:   restaurant.printer_model,
      currency:        restaurant.currency,
      currency_symbol: restaurant.currency_symbol,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// PATCH /posup/product/:id — update product fields
router.patch('/product/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description, price, active, image_url, is_alcohol, sort_order } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (price !== undefined) { updates.price = price; updates.price_overridden = true; }
  if (active !== undefined) updates.active = active;
  if (image_url !== undefined) updates.image_url = image_url;
  if (is_alcohol !== undefined) updates.is_alcohol = is_alcohol === true;
  if (sort_order !== undefined) updates.sort_order = sort_order;

  const { error } = await supabase
    .from('products')
    .update(updates)
    .eq('id', id);

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

// DELETE /posup/product/:id — permanently remove a product
router.delete('/product/:id', async (req, res) => {
  const { id } = req.params;
  try {
        await supabase.from('product_categories').delete().eq('product_id', id);
    await supabase.from('addon_product_assignments').delete().eq('product_id', id);
    await supabase.from('variations').delete().eq('product_id', id);
    const { error } = await supabase.from('products').delete().eq('id', id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});



// POST /posup/category — add new category
router.post('/category', async (req, res) => {
  const { name, restaurant_code } = req.body;
  if (!name || !restaurant_code) return res.status(400).json({ success: false, error: 'Missing fields' });

  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('id')
    .eq('code', restaurant_code)
    .single();

  if (!restaurant) return res.status(404).json({ success: false, error: 'Restaurant not found' });

  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const { data, error } = await supabase
    .from('categories')
    .insert({ restaurant_id: restaurant.id, wc_id: -(Date.now() % 1000000), name, slug, active: true, sort_order: 0 })
    .select()
    .single();

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, category: { ...data, category_ids: [] } });
});

// POST /posup/product — add new product
router.post('/product', async (req, res) => {
  const { name, description, price, active, image_url, restaurant_code, is_alcohol } = req.body;

  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('id')
    .eq('code', restaurant_code)
    .single();

  if (!restaurant) return res.status(404).json({ success: false, error: 'Restaurant not found' });

  const { data: product, error } = await supabase
    .from('products')
    .insert({
      restaurant_id: restaurant.id,
      name,
      description,
      price,
      active,
      image_url,
      is_alcohol: is_alcohol === true,
      type: 'simple',
      wc_id: -(Date.now() % 1000000),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ success: false, error: error.message });

  // Assign category if provided
  if (req.body.category_id && product) {
    await supabase.from('product_categories').insert({
      product_id: product.id,
      category_id: req.body.category_id,
    });
  }

  res.json({ success: true, product });
});

// ─────────────────────────────────────────
// GET /posup/customers/:code?q=
// Search POSUP address book by phone, first name, last name, or street
// ─────────────────────────────────────────
router.get('/customers/:code', async (req, res) => {
  const { code } = req.params;
  const q = String(req.query.q || '').trim();

  try {
    let query = supabase
      .from('posup_customers')
      .select('*')
      .eq('restaurant_code', code)
      .order('last_order_at', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false })
      .limit(30);

    if (q) {
      const safeQ = q.replace(/[%_]/g, '');
      query = query.or(
        `phone.ilike.%${safeQ}%,first_name.ilike.%${safeQ}%,last_name.ilike.%${safeQ}%,street.ilike.%${safeQ}%`
      );
    }

    const { data, error } = await query;

    if (error) throw new Error(error.message);

    res.json({
      success: true,
      customers: data || [],
    });
  } catch (err) {
    console.error('POSUP customers search error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /posup/customers/:code
// Create/update customer by restaurant_code + phone
// ─────────────────────────────────────────
router.post('/customers/:code', async (req, res) => {
  const { code } = req.params;

  const first_name = String(req.body.first_name || '').trim();
  const last_name = String(req.body.last_name || '').trim();
  const phone = String(req.body.phone || '').trim();
  const street = String(req.body.street || '').trim();
  const zip = String(req.body.zip || '').trim();
  const city = String(req.body.city || '').trim();

  if (!phone) {
    return res.status(400).json({
      success: false,
      error: 'Phone is required',
    });
  }

  try {
    const { data: existing } = await supabase
      .from('posup_customers')
      .select('id, order_count')
      .eq('restaurant_code', code)
      .eq('phone', phone)
      .maybeSingle();

    const payload = {
      restaurant_code: code,
      first_name,
      last_name,
      phone,
      street,
      zip,
      city,
      order_count: existing ? (existing.order_count || 0) + 1 : 1,
      last_order_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    let result;

    if (existing) {
      result = await supabase
        .from('posup_customers')
        .update(payload)
        .eq('id', existing.id)
        .select()
        .single();
    } else {
      result = await supabase
        .from('posup_customers')
        .insert({
          ...payload,
          created_at: new Date().toISOString(),
        })
        .select()
        .single();
    }

    if (result.error) throw new Error(result.error.message);

    res.json({
      success: true,
      customer: result.data,
    });
  } catch (err) {
    console.error('POSUP customer save error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /posup/orders/:code — save a new POS order
router.post('/orders/:code', async (req, res) => {
  const { code } = req.params;
  const order = req.body;

  try {
    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('id')
      .eq('code', code)
      .single();

    if (!restaurant) return res.status(404).json({ success: false, error: 'Restaurant not found' });

    // Generate order number
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const { count } = await supabase
      .from('pos_orders')
      .select('*', { count: 'exact', head: true })
      .eq('restaurant_id', restaurant.id);

    const orderNumber = `POS-${String((count || 0) + 1).padStart(3, '0')}`;

    const { data, error } = await supabase
      .from('pos_orders')
      .insert({
        restaurant_id: restaurant.id,
        order_number: orderNumber,
        items: order.items,
        subtotal: parseFloat(order.subtotal),
        discount: parseFloat(order.discount || '0'),
        discount_type: order.discount_type || 'fixed',
        discount_value: order.discount_value || '0',
        total: parseFloat(order.total),
        currency: order.currency || 'CHF',
        payment_method: order.payment_method,
        note: order.note || '',
        source: order.source || 'posup',
        created_at: order.created_at || new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ success: true, order_id: orderNumber, order: data });
  } catch (err) {
    console.error('POSUP order error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// GET /posup/orders/:code — fetch all orders for a restaurant
router.get('/orders/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('id')
      .eq('code', code)
      .single();
    if (!restaurant) return res.status(404).json({ success: false, error: 'Restaurant not found' });
    const { data, error } = await supabase
      .from('pos_orders')
      .select('*')
      .eq('restaurant_id', restaurant.id)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    res.json({ success: true, orders: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /posup/reimport/:code — re-import ADDONS ONLY using stored credentials
router.post('/reimport/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('id, wp_site_url, secret_key')
      .eq('code', code)
      .single();

    if (!restaurant || !restaurant.wp_site_url) {
      return res.status(404).json({ success: false, error: 'Restaurant not found. Import it first from the Import tab.' });
    }

    // Fetch from WordPress
    const wpRes = await fetch(`${restaurant.wp_site_url}/wp-json/posup/v1/products-full`, {
      headers: { 'X-POSUP-Key': restaurant.secret_key }
    });

    if (!wpRes.ok) return res.status(400).json({ success: false, error: `WordPress returned ${wpRes.status}` });

    const wpData = await wpRes.json();
    const addonGroups = wpData.addons || wpData.addon_groups || [];

    // Delete existing addons for this restaurant
    const { data: existingGroups } = await supabase
      .from('addon_groups')
      .select('id')
      .eq('restaurant_id', restaurant.id);

    if (existingGroups?.length > 0) {
      const groupIds = existingGroups.map(g => g.id);
      await supabase.from('addon_options').delete().in('addon_group_id', groupIds);
      await supabase.from('addon_category_assignments').delete().in('addon_group_id', groupIds);
      await supabase.from('addon_product_assignments').delete().in('addon_group_id', groupIds);
      await supabase.from('addon_groups').delete().eq('restaurant_id', restaurant.id);
    }

    // Re-insert addon groups
    let addonsImported = 0;
    for (const group of addonGroups) {
      const { data: insertedGroup } = await supabase
        .from('addon_groups')
        .insert({ restaurant_id: restaurant.id, wc_id: group.id, name: group.name, active: true })
        .select().single();

      if (!insertedGroup) continue;
      addonsImported++;

      // Insert options — handle both flat and nested option structures
      let sortOrder = 0;
      for (const optOrGroup of (group.options || [])) {
        // Nested structure: optOrGroup.options contains actual options
        if (optOrGroup.options && Array.isArray(optOrGroup.options)) {
          for (const opt of optOrGroup.options) {
            await supabase.from('addon_options').insert({
              addon_group_id: insertedGroup.id,
              wc_option_id: opt.id,
              name: opt.name || opt.label,
              price: parseFloat(opt.price) || 0,
              type: optOrGroup.type || 'checkbox',
              required: optOrGroup.required || false,
              sort_order: sortOrder++,
            });
          }
        } else {
          // Flat structure
          await supabase.from('addon_options').insert({
            addon_group_id: insertedGroup.id,
            wc_option_id: optOrGroup.id,
            name: optOrGroup.name || optOrGroup.label,
            price: parseFloat(optOrGroup.price) || 0,
            type: optOrGroup.type || 'checkbox',
            required: optOrGroup.required || false,
            sort_order: sortOrder++,
          });
        }
      }

      // Category assignments
      for (const catId of (group.assigned_category_ids || [])) {
        const { data: cat } = await supabase
          .from('categories')
          .select('id')
          .eq('restaurant_id', restaurant.id)
          .eq('wc_id', catId)
          .single();
        if (cat) await supabase.from('addon_category_assignments').insert({ addon_group_id: insertedGroup.id, category_id: cat.id });
      }
    }

    res.json({ success: true, imported: { addons: addonsImported }, message: 'Addons imported successfully. Products and prices unchanged.' });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /posup/restaurants — list all registered restaurants
router.get('/restaurants', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('restaurants')
      .select('code, name, active')
      .order('name');
    if (error) throw new Error(error.message);
    res.json({ success: true, restaurants: data || [] });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /posup/admin/reset-pin
// POSUP owner/admin can reset a restaurant owner PIN and/or admin PIN
// Body: { admin_key, restaurant_code, new_pin, new_admin_pin }
// ─────────────────────────────────────────
router.post('/admin/reset-pin', async (req, res) => {
  const admin_key = String(req.body.admin_key || '').trim();
  const restaurant_code = String(req.body.restaurant_code || '').trim();
  const new_pin = String(req.body.new_pin || '').trim();
  const new_admin_pin = String(req.body.new_admin_pin || '').trim();

  if (!process.env.POSUP_ADMIN_RESET_KEY) {
    return res.status(500).json({
      success: false,
      error: 'POSUP_ADMIN_RESET_KEY is not configured',
    });
  }

  if (admin_key !== process.env.POSUP_ADMIN_RESET_KEY) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
    });
  }

  if (!restaurant_code) {
    return res.status(400).json({
      success: false,
      error: 'restaurant_code is required',
    });
  }

  if (!new_pin && !new_admin_pin) {
    return res.status(400).json({
      success: false,
      error: 'new_pin or new_admin_pin is required',
    });
  }

  if (new_pin && new_pin.length < 4) {
    return res.status(400).json({
      success: false,
      error: 'Owner PIN must be at least 4 characters',
    });
  }

  if (new_admin_pin && new_admin_pin.length < 4) {
    return res.status(400).json({
      success: false,
      error: 'Admin PIN must be at least 4 characters',
    });
  }

  try {
    const updates = {};
    if (new_pin) updates.pin = new_pin;
    if (new_admin_pin) updates.admin_pin = new_admin_pin;

    const { data, error } = await supabase
      .from('restaurants')
      .update(updates)
      .eq('code', restaurant_code)
      .select('code, name')
      .single();

    if (error) throw new Error(error.message);

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant not found',
      });
    }

    res.json({
      success: true,
      restaurant: data,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// POST /posup/login — validate restaurant code and PIN
router.post('/login', async (req, res) => {
  const { code, pin } = req.body;
  try {
    const { data: restaurant } = await supabase
      .from('restaurants')
.select('id, name, logo_url, pin, admin_pin, wp_site_url, secret_key')
      .eq('code', code)
      .single();

    if (!restaurant) return res.status(404).json({ success: false, error: 'Restaurant not found' });

    const currentPin = restaurant.pin;

    if (currentPin && currentPin !== pin) return res.status(401).json({ success: false, error: 'Incorrect PIN' });

    res.json({ success: true, name: restaurant.name, logo_url: restaurant.logo_url });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /posup/change-admin-pin
// Owner can reset/change the Staff/Admin PIN from POSUP app
// Body: { restaurant_code, owner_pin, new_admin_pin }
// ─────────────────────────────────────────
router.post('/change-admin-pin', async (req, res) => {
  const restaurant_code = String(req.body.restaurant_code || '').trim();
  const owner_pin = String(req.body.owner_pin || '').trim();
  const new_admin_pin = String(req.body.new_admin_pin || '').trim();

  if (!restaurant_code || !owner_pin || !new_admin_pin) {
    return res.status(400).json({
      success: false,
      error: 'restaurant_code, owner_pin, and new_admin_pin are required',
    });
  }

  if (new_admin_pin.length < 4) {
    return res.status(400).json({
      success: false,
      error: 'Admin PIN must be at least 4 characters',
    });
  }

  try {
    const { data: restaurant, error: fetchError } = await supabase
      .from('restaurants')
      .select('pin')
      .eq('code', restaurant_code)
      .single();

    if (fetchError || !restaurant) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant not found',
      });
    }

    if (String(restaurant.pin || '') !== owner_pin) {
      return res.status(401).json({
        success: false,
        error: 'Incorrect owner PIN',
      });
    }

    const { error: updateError } = await supabase
      .from('restaurants')
      .update({ admin_pin: new_admin_pin })
      .eq('code', restaurant_code);

    if (updateError) {
      throw new Error(updateError.message);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────
// Staff Hours — owner-only clock in/out + monthly report
// ─────────────────────────────────────────

// POST /posup/staff/verify-admin-pin
router.post('/staff/verify-admin-pin', async (req, res) => {
  const { code, admin_pin } = req.body;
  try {
    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('admin_pin')
      .eq('code', code)
      .single();

    if (!restaurant) return res.status(404).json({ success: false, error: 'Restaurant not found' });
    if (!restaurant.admin_pin) return res.status(400).json({ success: false, error: 'Admin PIN not configured' });
    if (restaurant.admin_pin !== admin_pin) return res.status(401).json({ success: false, error: 'Incorrect admin PIN' });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /posup/staff/employees/:code
router.get('/staff/employees/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('id')
      .eq('code', code)
      .single();
    if (!restaurant) return res.status(404).json({ success: false, error: 'Restaurant not found' });

    const { data: employees, error } = await supabase
      .from('pos_employees')
      .select('*')
      .eq('restaurant_id', restaurant.id)
      .eq('active', true)
      .order('name');
    if (error) throw new Error(error.message);

    const { data: openEntries } = await supabase
      .from('pos_time_entries')
      .select('employee_id, clock_in')
      .eq('restaurant_id', restaurant.id)
      .is('clock_out', null);

    const openMap = {};
    (openEntries || []).forEach(e => { openMap[e.employee_id] = e.clock_in; });

    const result = (employees || []).map(emp => ({
      ...emp,
      clocked_in: !!openMap[emp.id],
      clock_in_time: openMap[emp.id] || null,
    }));

    res.json({ success: true, employees: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /posup/staff/employees/:code — add employee
router.post('/staff/employees/:code', async (req, res) => {
  const { code } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'Name is required' });

  try {
    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('id')
      .eq('code', code)
      .single();
    if (!restaurant) return res.status(404).json({ success: false, error: 'Restaurant not found' });

    const { data, error } = await supabase
      .from('pos_employees')
      .insert({ restaurant_id: restaurant.id, name: name.trim() })
      .select()
      .single();
    if (error) throw new Error(error.message);

    res.json({ success: true, employee: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /posup/staff/employees/:id/deactivate
router.patch('/staff/employees/:id/deactivate', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('pos_employees')
      .update({ active: false })
      .eq('id', id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /posup/staff/clock/:employeeId — toggle clock in/out
router.post('/staff/clock/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const { code } = req.body;
  try {
    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('id')
      .eq('code', code)
      .single();
    if (!restaurant) return res.status(404).json({ success: false, error: 'Restaurant not found' });

    const { data: open, error: findError } = await supabase
      .from('pos_time_entries')
      .select('*')
      .eq('employee_id', employeeId)
      .is('clock_out', null)
      .maybeSingle();
    if (findError) throw new Error(findError.message);

    if (open) {
      const { error: closeError } = await supabase
        .from('pos_time_entries')
        .update({ clock_out: new Date().toISOString() })
        .eq('id', open.id);
      if (closeError) throw new Error(closeError.message);
      return res.json({ success: true, action: 'clocked_out' });
    } else {
      const { error: openError } = await supabase
        .from('pos_time_entries')
        .insert({ employee_id: employeeId, restaurant_id: restaurant.id, clock_in: new Date().toISOString() });
      if (openError) throw new Error(openError.message);
      return res.json({ success: true, action: 'clocked_in' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /posup/staff/report/:code?month=YYYY-MM
router.get('/staff/report/:code', async (req, res) => {
  const { code } = req.params;
  const { month } = req.query;
  if (!month) return res.status(400).json({ success: false, error: 'month query param required, format YYYY-MM' });

  try {
    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('id')
      .eq('code', code)
      .single();
    if (!restaurant) return res.status(404).json({ success: false, error: 'Restaurant not found' });

    const start = new Date(`${month}-01T00:00:00Z`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);

    const { data: employees, error: empError } = await supabase
      .from('pos_employees')
      .select('id, name')
      .eq('restaurant_id', restaurant.id);
    if (empError) throw new Error(empError.message);

    const { data: entries, error: entriesError } = await supabase
      .from('pos_time_entries')
      .select('employee_id, clock_in, clock_out')
      .eq('restaurant_id', restaurant.id)
      .gte('clock_in', start.toISOString())
      .lt('clock_in', end.toISOString());
    if (entriesError) throw new Error(entriesError.message);

    const report = (employees || []).map(emp => {
      const empEntries = (entries || []).filter(e => e.employee_id === emp.id);
      const totalMs = empEntries.reduce((sum, e) => {
        const inTime = new Date(e.clock_in).getTime();
        const outTime = e.clock_out ? new Date(e.clock_out).getTime() : Date.now();
        return sum + Math.max(0, outTime - inTime);
      }, 0);
      return {
        employee_id: emp.id,
        name: emp.name,
        total_hours: Math.round((totalMs / 3600000) * 100) / 100,
        shifts: empEntries,
      };
    });

    res.json({ success: true, month, report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /posup/restaurants — create a restaurant WITHOUT WordPress
// Used by the dashboard's "no website" onboarding path
// ─────────────────────────────────────────
router.post('/restaurants', async (req, res) => {
  const { code, name, pin, admin_pin } = req.body;

  if (!code || !name) {
    return res.status(400).json({ success: false, error: 'code and name are required' });
  }

  const { data: existing } = await supabase
    .from('restaurants')
    .select('id')
    .eq('code', code)
    .single();

  if (existing) {
    return res.status(409).json({ success: false, error: 'A restaurant with this code already exists' });
  }

  const { data, error } = await supabase
    .from('restaurants')
    .insert({
      code,
      name,
      pin: pin || '1234',
      admin_pin: admin_pin || null,
      wp_site_url: null,
      secret_key: null,
      logo_url: '',
      printer_ip: '',
      printer_port: '9100',
      printer_model: '',
      currency: 'CHF',
      currency_symbol: 'CHF',
      active: true,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, restaurant: data });
});

// ─────────────────────────────────────────
// GET /posup/restaurants/:code/settings — full settings for the dashboard
// (unlike /profile/:code, this exposes pin/admin_pin — dashboard is a trusted admin tool)
// ─────────────────────────────────────────
router.get('/restaurants/:code/settings', async (req, res) => {
  const { code } = req.params;

  const { data: restaurant, error } = await supabase
    .from('restaurants')
    .select('code, name, pin, admin_pin, printer_ip, printer_port, printer_model, logo_url, wp_site_url')
    .eq('code', code)
    .single();

  if (error || !restaurant) return res.status(404).json({ success: false, error: 'Restaurant not found' });

  res.json({
    success: true,
    restaurant: {
      ...restaurant,
      wp_linked: !!restaurant.wp_site_url,
    },
  });
});

// ─────────────────────────────────────────
// PATCH /posup/restaurants/:code — edit settings directly (no WordPress needed)
// NOTE: for restaurants that ARE linked to WordPress (wp_site_url set), pin/printer
// fields edited here will be overwritten the next time /login or /profile/:code
// syncs from WP. This route is meant for WP-less restaurants.
// ─────────────────────────────────────────
router.patch('/restaurants/:code', async (req, res) => {
  const { code } = req.params;
  const { name, pin, admin_pin, printer_ip, printer_port, printer_model, logo_url } = req.body;

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (pin) updates.pin = pin;
  if (admin_pin) updates.admin_pin = admin_pin;
  if (printer_ip !== undefined) updates.printer_ip = printer_ip;
  if (printer_port !== undefined) updates.printer_port = printer_port;
  if (printer_model !== undefined) updates.printer_model = printer_model;
  if (logo_url !== undefined) updates.logo_url = logo_url;

  const { data, error } = await supabase
    .from('restaurants')
    .update(updates)
    .eq('code', code)
    .select()
    .single();

  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: 'Restaurant not found' });

  res.json({ success: true, restaurant: data });
});

module.exports = router;
