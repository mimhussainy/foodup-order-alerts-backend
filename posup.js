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
        .select('id, price, price_overridden')
        .eq('restaurant_id', restaurantId)
        .eq('wc_id', product.wc_id)
        .single();

      const priceOverridden = existing?.price_overridden === true;
      const finalPrice = priceOverridden ? existing.price : (product.price || 0);

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
    // Get restaurant
    const { data: restaurant, error: restErr } = await supabase
      .from('restaurants')
      .select('id, name, logo_url, printer_ip, printer_port, printer_model, currency, currency_symbol')
      .eq('code', code)
      .single();

    if (restErr || !restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const restaurantId = restaurant.id;

    // Get categories
    const { data: categories } = await supabase
      .from('categories')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .eq('active', true)
      .order('name');

    // Get products with their category IDs
    const { data: products } = await supabase
      .from('products')
      .select(`
        *,
        product_categories(category_id),
        variations(*)
      `)
      .eq('restaurant_id', restaurantId)
      .eq('active', true)
      .order('name');

    // Get addon groups with options and assignments
    const { data: addonGroups } = await supabase
      .from('addon_groups')
      .select(`
        *,
        addon_options(*),
        addon_category_assignments(category_id),
        addon_product_assignments(product_id)
      `)
      .eq('restaurant_id', restaurantId)
      .eq('active', true);

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
      .select('name, logo_url, printer_ip, printer_port, printer_model, currency, currency_symbol, wp_site_url, secret_key')
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
          // Update Supabase with latest printer + pin settings
          await supabase.from('restaurants').update({
            printer_ip:    wpProfile.printer_ip || restaurant.printer_ip,
            printer_port:  wpProfile.printer_port || restaurant.printer_port,
            printer_model: wpProfile.printer_model || restaurant.printer_model,
            pin:           wpProfile.pin || restaurant.pin,
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
  const { name, description, price, active, image_url } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (price !== undefined) { updates.price = price; updates.price_overridden = true; }
  if (active !== undefined) updates.active = active;
  if (image_url !== undefined) updates.image_url = image_url;

  const { error } = await supabase
    .from('products')
    .update(updates)
    .eq('id', id);

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
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
    .insert({ restaurant_id: restaurant.id, name, slug, active: true, sort_order: 0 })
    .select()
    .single();

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, category: { ...data, category_ids: [] } });
});

// POST /posup/product — add new product
router.post('/product', async (req, res) => {
  const { name, description, price, active, image_url, restaurant_code } = req.body;

  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('id')
    .eq('code', restaurant_code)
    .single();

  if (!restaurant) return res.status(404).json({ success: false, error: 'Restaurant not found' });

  const { data: product, error } = await supabase
    .from('products')
    .insert({ restaurant_id: restaurant.id, name, description, price, active, image_url, type: 'simple', wc_id: -(Date.now() % 1000000) })
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

// POST /posup/login — validate restaurant code and PIN
router.post('/login', async (req, res) => {
  const { code, pin } = req.body;
  try {
    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('id, name, logo_url, pin, wp_site_url, secret_key')
      .eq('code', code)
      .single();

    if (!restaurant) return res.status(404).json({ success: false, error: 'Restaurant not found' });

    let currentPin = restaurant.pin;

    // Try to fetch live PIN from WordPress before validating
    if (restaurant.wp_site_url && restaurant.secret_key) {
      try {
        const wpRes = await fetch(`${restaurant.wp_site_url}/wp-json/posup/v1/profile`, {
          headers: { 'X-POSUP-Key': restaurant.secret_key },
          signal: AbortSignal.timeout(4000),
        });
        if (wpRes.ok) {
          const wpProfile = await wpRes.json();
          if (wpProfile.pin) {
            currentPin = wpProfile.pin;
            if (currentPin !== restaurant.pin) {
              await supabase.from('restaurants').update({ pin: currentPin }).eq('code', code);
            }
          }
        }
      } catch (wpErr) {
        console.log('WordPress PIN fetch failed, using cached PIN:', wpErr.message);
      }
    }

    if (currentPin && currentPin !== pin) return res.status(401).json({ success: false, error: 'Incorrect PIN' });

    res.json({ success: true, name: restaurant.name, logo_url: restaurant.logo_url });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
module.exports = router;
