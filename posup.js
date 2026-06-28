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
        currency:         profile.currency || 'CHF',
        currency_symbol:  profile.currency_symbol || 'CHF',
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
    await supabase.from('products').delete().eq('restaurant_id', restaurantId);
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

    // 6. Insert products + variations + category mappings
    const productWcIdToUuid = {};
    for (const product of wpData.products) {
      const { data: inserted, error } = await supabase
        .from('products')
        .insert({
          restaurant_id: restaurantId,
          wc_id:         product.wc_id,
          name:          product.name,
          description:   product.description || '',
          type:          product.type || 'simple',
          price:         product.price || 0,
          regular_price: product.regular_price || 0,
          image_url:     product.image_url || '',
          sort_order:    product.sort_order || 0,
          active:        true,
        })
        .select()
        .single();
      if (error) throw new Error(`Product insert failed (${product.name}): ${error.message}`);

      const productId = inserted.id;
      productWcIdToUuid[product.wc_id] = productId;

      // Category mappings
      for (const catWcId of product.category_ids) {
        const catUuid = categoryWcIdToUuid[catWcId];
        if (!catUuid) continue;
        await supabase.from('product_categories').insert({
          product_id:  productId,
          category_id: catUuid,
        });
      }

      // Variations
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
      .select('id, name, logo_url, printer_ip, printer_port, currency, currency_symbol')
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
      id:            p.id,
      wc_id:         p.wc_id,
      name:          p.name,
      description:   p.description,
      type:          p.type,
      price:         p.price,
      regular_price: p.regular_price,
      image_url:     p.image_url,
      sort_order:    p.sort_order,
      active:        p.active,
      category_ids:  (p.product_categories || []).map(pc => pc.category_id),
      variations:    (p.variations || []).map(v => ({
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
  const { data, error } = await supabase
    .from('restaurants')
    .select('name, logo_url, printer_ip, printer_port, currency, currency_symbol')
    .eq('code', code)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Restaurant not found' });
  res.json(data);
});

module.exports = router;
