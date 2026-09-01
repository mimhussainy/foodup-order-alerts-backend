const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const POSUP_PAYMENT_TERMINAL_MODES = new Set(['manual', 'goodcom', 'cash_only']);
const POSUP_PAYMENT_STATUSES = new Set(['created', 'processing', 'succeeded', 'failed', 'cancelled', 'completed']);

function normalizePaymentTerminalMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return POSUP_PAYMENT_TERMINAL_MODES.has(mode) ? mode : 'manual';
}

function isMissingPaymentSchemaError(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === '42703' || error?.code === '42P01' || message.includes('payment_terminal_mode') || message.includes('goodcom_terminal_id') || message.includes('posup_payment_transactions');
}

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
        .select('id, price, price_overridden, is_alcohol, image_url')
        .eq('restaurant_id', restaurantId)
        .eq('wc_id', product.wc_id)
        .single();

            const priceOverridden = existing?.price_overridden === true;
      const finalPrice = priceOverridden ? existing.price : (product.price || 0);
      const isAlcohol = existing?.is_alcohol === true;
      // Preserve images uploaded through SmartKasse's QR/camera flow on later WordPress imports.
      const hasSmartKasseImage = String(existing?.image_url || '').includes(`/storage/v1/object/public/${PRODUCT_IMAGE_BUCKET}/`);
      const finalImageUrl = hasSmartKasseImage
        ? existing.image_url
        : (product.image_url || existing?.image_url || '');

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
          image_url:      finalImageUrl,
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
  const includeInactive = ['1', 'true', 'yes'].includes(String(req.query.include_inactive || '').toLowerCase());
  try {
    // Get restaurant first (needed for restaurantId)
    const { data: restaurant, error: restErr } = await supabase
      .from('restaurants')
      .select('id, name, logo_url, printer_ip, printer_port, printer_model, currency, currency_symbol')
      .eq('code', code)
      .single();
    if (restErr || !restaurant) return res.status(404).json({ error: 'Restaurant not found' });
    const restaurantId = restaurant.id;

    // The POS app receives only active menu data by default.
    // The dashboard can request inactive rows as well so disabled categories/products
    // remain manageable and can be re-enabled later.
    let categoriesQuery = supabase
      .from('categories')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('name');

    let productsQuery = supabase
      .from('products')
      .select(`
        *,
        product_categories(category_id),
        variations(*)
      `)
      .eq('restaurant_id', restaurantId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (!includeInactive) {
      categoriesQuery = categoriesQuery.eq('active', true);
      productsQuery = productsQuery.eq('active', true);
    }

    const [categoriesRes, productsRes, addonGroupsRes] = await Promise.all([
      categoriesQuery,
      productsQuery,
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

    const products = productsRes.data || [];
    const addonGroups = addonGroupsRes.data;
    let categories = categoriesRes.data || [];

    // App safety: never expose an empty category title. This also repairs the
    // old state where a category stayed active while all of its products were disabled.
    if (!includeInactive) {
      const visibleCategoryIds = new Set();
      products.forEach(product => {
        (product.product_categories || []).forEach(link => visibleCategoryIds.add(String(link.category_id)));
      });
      categories = categories.filter(category => visibleCategoryIds.has(String(category.id)));
    }

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
    // POSUP Bluetooth dashboard selection must win over legacy WordPress printer sync.
    if (restaurant.printer_model === 'epson_bluetooth') {
      return res.json({
        name:            restaurant.name,
        logo_url:        restaurant.logo_url,
        printer_ip:      '',
        printer_port:    '',
        printer_model:   'epson_bluetooth',
        currency:        restaurant.currency,
        currency_symbol: restaurant.currency_symbol,
      });
    }

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

// ─────────────────────────────────────────
// SMARTKASSE PRODUCT IMAGE QR / PHONE CAMERA FLOW
// ─────────────────────────────────────────
const PRODUCT_IMAGE_BUCKET = process.env.SMARTKASSE_PRODUCT_IMAGE_BUCKET || 'product-images';
const PRODUCT_IMAGE_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function productImageSigningSecret() {
  return process.env.POSUP_IMAGE_UPLOAD_SECRET || process.env.SUPABASE_SERVICE_KEY || '';
}

function signProductImageToken(payload) {
  const secret = productImageSigningSecret();
  if (!secret) throw new Error('Product image upload secret is not configured');
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyProductImageToken(token) {
  const secret = productImageSigningSecret();
  if (!secret || !token || !token.includes('.')) throw new Error('Invalid upload link');
  const [encoded, signature] = String(token).split('.', 2);
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(signature || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Invalid upload link');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!payload.exp || Date.now() > Number(payload.exp)) throw new Error('This QR code has expired');
  if (!payload.restaurant_code || !payload.product_id) throw new Error('Invalid upload link');
  return payload;
}

function safeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function ensureProductImageBucket() {
  const probe = await supabase.storage.from(PRODUCT_IMAGE_BUCKET).list('', { limit: 1 });
  if (!probe.error) return;

  const message = String(probe.error.message || '');
  if (!/bucket|not found|does not exist/i.test(message)) throw probe.error;

  const created = await supabase.storage.createBucket(PRODUCT_IMAGE_BUCKET, {
    public: true,
    fileSizeLimit: 5 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  });
  if (created.error && !/already exists/i.test(String(created.error.message || ''))) {
    throw created.error;
  }
}

// POST /posup/product-image-token
// Authenticated from SmartKasse Settings with the owner PIN.
// The QR contains only a short-lived signed token — never the PIN.
router.post('/product-image-token', async (req, res) => {
  try {
    const restaurant_code = String(req.body.restaurant_code || '').toLowerCase().trim();
    const product_id = String(req.body.product_id || '').trim();
    const pin = String(req.body.pin || '').trim();

    if (!restaurant_code || !product_id || !pin) {
      return res.status(400).json({ success: false, error: 'Missing restaurant_code, product_id, or pin' });
    }

    const { data: restaurant, error: restError } = await supabase
      .from('restaurants')
      .select('id, code, pin')
      .eq('code', restaurant_code)
      .single();

    if (restError || !restaurant) return res.status(404).json({ success: false, error: 'Business not found' });
    if (String(restaurant.pin || '') !== pin) return res.status(401).json({ success: false, error: 'Incorrect PIN' });

    const { data: product, error: productError } = await supabase
      .from('products')
      .select('id, name')
      .eq('id', product_id)
      .eq('restaurant_id', restaurant.id)
      .single();

    if (productError || !product) return res.status(404).json({ success: false, error: 'Product not found' });

    const token = signProductImageToken({
      restaurant_code,
      product_id: String(product.id),
      exp: Date.now() + PRODUCT_IMAGE_TOKEN_TTL_MS,
    });

    const host = req.get('host');
    const protocol = /^localhost(?::|$)|^127\.0\.0\.1(?::|$)/i.test(host || '') ? 'http' : 'https';
    const upload_url = `${protocol}://${host}/posup/product-image-upload/${encodeURIComponent(token)}`;

    return res.json({ success: true, upload_url, expires_in_hours: 12 });
  } catch (err) {
    console.error('Product image token error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /posup/product-image-upload/:token
// Mobile-friendly page opened after the restaurant owner scans the product QR.
router.get('/product-image-upload/:token', async (req, res) => {
  try {
    const payload = verifyProductImageToken(req.params.token);

    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('id, name')
      .eq('code', payload.restaurant_code)
      .single();

    if (!restaurant) throw new Error('Business not found');

    const { data: product } = await supabase
      .from('products')
      .select('id, name, image_url')
      .eq('id', payload.product_id)
      .eq('restaurant_id', restaurant.id)
      .single();

    if (!product) throw new Error('Product not found');

    const token = String(req.params.token);
    const currentImage = product.image_url
      ? `<img class="preview current" src="${safeHtml(product.image_url)}" alt="Current product image">`
      : `<div class="empty" id="emptyState"><span>▧</span><strong>No image yet</strong><small>Take a photo below</small></div>`;

    res.type('html').send(`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#102A43">
<title>SmartKasse – Produktbild</title>
<style>
  *{box-sizing:border-box} body{margin:0;background:#F5F7FA;color:#17202A;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}
  .wrap{max-width:520px;margin:0 auto;min-height:100vh;padding:20px 16px 36px}.brand{display:flex;align-items:center;gap:10px;margin:4px 0 20px}.mark{width:38px;height:38px;border-radius:11px;background:#102A43;color:white;display:grid;place-items:center;font-weight:800}.brand b{font-size:18px}.brand small{display:block;color:#8A94A6;margin-top:1px}.card{background:white;border:1px solid #E4E7EC;border-radius:18px;overflow:hidden;box-shadow:0 8px 28px rgba(16,42,67,.06)}.head{padding:18px 18px 14px;border-bottom:1px solid #EEF1F4}.eyebrow{font-size:11px;font-weight:800;color:#2F6BFF;letter-spacing:.08em;text-transform:uppercase}.head h1{font-size:23px;line-height:1.2;margin:5px 0 3px}.head p{font-size:13px;color:#667085;margin:0}.media{padding:16px}.preview,.empty{width:100%;aspect-ratio:4/3;border-radius:14px;background:#F1F4F7;object-fit:cover}.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;color:#98A2B3;border:1px dashed #D0D5DD}.empty span{font-size:38px}.empty strong{font-size:14px;margin-top:4px}.empty small{font-size:12px;margin-top:3px}.actions{padding:0 16px 18px}.btn{width:100%;min-height:52px;border:0;border-radius:13px;font-size:15px;font-weight:750;cursor:pointer}.primary{background:#102A43;color:#fff}.secondary{background:#EEF3FF;color:#214DB8;margin-top:10px;display:none}.hint{text-align:center;color:#667085;font-size:12px;line-height:1.5;margin:12px 8px 0}.status{display:none;margin:14px 16px 18px;border-radius:12px;padding:13px;font-size:13px;font-weight:650}.status.ok{display:block;background:#ECFDF3;color:#067647}.status.err{display:block;background:#FEF3F2;color:#B42318}.spinner{display:none;margin-right:8px}input{display:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><div class="mark">SK</div><div><b>SmartKasse</b><small>Produktbild hinzufügen</small></div></div>
  <div class="card">
    <div class="head"><div class="eyebrow">${safeHtml(restaurant.name || payload.restaurant_code)}</div><h1>${safeHtml(product.name)}</h1><p>Dieses Foto wird nur diesem Produkt zugeordnet.</p></div>
    <div class="media" id="media">${currentImage}</div>
    <div class="actions">
      <input id="camera" type="file" accept="image/jpeg,image/png,image/webp,image/*" capture="environment">
      <button class="btn primary" id="cameraBtn">Kamera öffnen</button>
      <button class="btn secondary" id="uploadBtn">Foto verwenden & speichern</button>
      <div class="hint">Am besten das Produkt gut beleuchtet und von oben bzw. leicht schräg fotografieren.</div>
    </div>
    <div class="status" id="status"></div>
  </div>
</div>
<script>
const token=${JSON.stringify(token)};
const input=document.getElementById('camera');
const cameraBtn=document.getElementById('cameraBtn');
const uploadBtn=document.getElementById('uploadBtn');
const media=document.getElementById('media');
const status=document.getElementById('status');
let prepared=null;

function showStatus(message,type){status.textContent=message;status.className='status '+type;}

cameraBtn.addEventListener('click',()=>input.click());
async function savePreparedImage(){
  if(!prepared)return;
  uploadBtn.disabled=true;
  cameraBtn.disabled=true;
  uploadBtn.style.display='none';
  cameraBtn.textContent='Wird gespeichertâ€¦';
  showStatus('Foto wird automatisch gespeichertâ€¦','ok');
  try{
    const response=await fetch('/posup/product-image-upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,image_base64:prepared.base64,mime_type:prepared.mime})});
    const data=await response.json();
    if(!response.ok||!data.success)throw new Error(data.error||'Upload fehlgeschlagen');
    if(data.image_url) media.innerHTML='<img class="preview" src="'+data.image_url+'?v='+Date.now()+'" alt="Saved product image">';
    showStatus('âœ“ Bild gespeichert','ok');
    prepared=null;
    input.value='';
    cameraBtn.textContent='Gespeichert âœ“';

    // Best effort on iPhone Camera/Safari. iOS may refuse window.close() for
    // pages that were not opened by JavaScript, so also try browser history.
    setTimeout(()=>{
      try{window.close();}catch(_){}
      setTimeout(()=>{
        try{if(window.history.length>1)window.history.back();}catch(_){}
      },120);
    },700);
  }catch(e){
    showStatus(e.message||'Upload fehlgeschlagen','err');
    uploadBtn.style.display='block';
    uploadBtn.textContent='Nochmals versuchen';
    cameraBtn.textContent='Kamera Ã¶ffnen';
  }finally{
    uploadBtn.disabled=false;
    cameraBtn.disabled=false;
  }
}

input.addEventListener('change',async()=>{
  const file=input.files&&input.files[0]; if(!file)return;
  try{
    prepared=await prepareImage(file);
    media.innerHTML='<img class="preview" src="'+prepared.dataUrl+'" alt="Preview">';
    status.className='status';
    await savePreparedImage();
  }catch(e){
    showStatus(e.message||'Foto konnte nicht verarbeitet werden','err');
    cameraBtn.textContent='Kamera Ã¶ffnen';
  }
});

// Retry only appears if the automatic upload failed.
uploadBtn.addEventListener('click',savePreparedImage);
function prepareImage(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('Foto konnte nicht gelesen werden'));
    reader.onload=()=>{
      const img=new Image();
      img.onerror=()=>reject(new Error('Ungültiges Bild'));
      img.onload=()=>{
        const max=1600; let w=img.width,h=img.height;
        if(Math.max(w,h)>max){const scale=max/Math.max(w,h);w=Math.round(w*scale);h=Math.round(h*scale);}
        const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
        const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,w,h);
        const dataUrl=canvas.toDataURL('image/jpeg',0.82);
        resolve({dataUrl,base64:dataUrl.split(',')[1],mime:'image/jpeg'});
      };
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });
}
</script>
</body></html>`);
  } catch (err) {
    res.status(400).type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial;padding:30px;background:#f5f7fa"><h2>SmartKasse</h2><p>${safeHtml(err.message)}</p><p>Bitte in SmartKasse einen neuen QR-Code erstellen.</p></body>`);
  }
});

// POST /posup/product-image-upload
// Receives a compressed image from the mobile camera page and assigns it to the product.
router.post('/product-image-upload', async (req, res) => {
  try {
    const payload = verifyProductImageToken(req.body.token);
    const mime = String(req.body.mime_type || 'image/jpeg').toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
      return res.status(400).json({ success: false, error: 'Unsupported image type' });
    }

    const raw = String(req.body.image_base64 || '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
    if (!raw) return res.status(400).json({ success: false, error: 'Image is missing' });
    const buffer = Buffer.from(raw, 'base64');
    if (!buffer.length || buffer.length > 4.5 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: 'Image is too large' });
    }

    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('id, code')
      .eq('code', payload.restaurant_code)
      .single();
    if (!restaurant) return res.status(404).json({ success: false, error: 'Business not found' });

    const { data: product } = await supabase
      .from('products')
      .select('id')
      .eq('id', payload.product_id)
      .eq('restaurant_id', restaurant.id)
      .single();
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });

    await ensureProductImageBucket();
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const safeCode = String(restaurant.code || payload.restaurant_code).replace(/[^a-z0-9_-]/gi, '-');
    const path = `${safeCode}/${String(product.id).replace(/[^a-z0-9_-]/gi, '-')}-${Date.now()}.${ext}`;

    const upload = await supabase.storage.from(PRODUCT_IMAGE_BUCKET).upload(path, buffer, {
      contentType: mime,
      cacheControl: '3600',
      upsert: true,
    });
    if (upload.error) throw upload.error;

    const publicResult = supabase.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(path);
    const image_url = publicResult?.data?.publicUrl;
    if (!image_url) throw new Error('Could not create public image URL');

    const updated = await supabase
      .from('products')
      .update({ image_url })
      .eq('id', product.id)
      .eq('restaurant_id', restaurant.id);
    if (updated.error) throw updated.error;

    return res.json({ success: true, image_url });
  } catch (err) {
    console.error('Product image upload error:', err);
    return res.status(400).json({ success: false, error: err.message || 'Upload failed' });
  }
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



// PATCH /posup/category/:id — update category fields (used for enable/disable)
router.patch('/category/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const allowed = {};
    if (typeof req.body.active === 'boolean') allowed.active = req.body.active;
    if (typeof req.body.name === 'string' && req.body.name.trim()) allowed.name = req.body.name.trim();
    if (Number.isFinite(Number(req.body.sort_order))) allowed.sort_order = Number(req.body.sort_order);

    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid category fields provided' });
    }

    const { data, error } = await supabase
      .from('categories')
      .update(allowed)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ success: true, category: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /posup/category/:id — remove category only, keep products
router.delete('/category/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Remove all references first. Products themselves are intentionally kept.
    const { error: pcError } = await supabase.from('product_categories').delete().eq('category_id', id);
    if (pcError) throw new Error(pcError.message);

    const { error: addonError } = await supabase.from('addon_category_assignments').delete().eq('category_id', id);
    if (addonError) throw new Error(addonError.message);

    const { error } = await supabase.from('categories').delete().eq('id', id);
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
// POSUP Excel import + template
// ─────────────────────────────────────────

const POSUP_EXCEL_TEMPLATE_BASE64 = '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';

function posupManualWcId() {
  return -(Math.floor(Math.random() * 1900000000) + 1);
}

function posupExcelBool(value, fallback = false) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return fallback;
  if (['yes', 'y', 'true', '1', 'ja', 'aktiv', 'active'].includes(text)) return true;
  if (['no', 'n', 'false', '0', 'nein', 'inaktiv', 'inactive'].includes(text)) return false;
  return fallback;
}

function posupSlug(value) {
  const slug = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `category-${Math.abs(posupManualWcId())}`;
}

router.get('/excel-template', (req, res) => {
  const buffer = Buffer.from(POSUP_EXCEL_TEMPLATE_BASE64, 'base64');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="POSUP-Excel-Import-Template.xlsx"');
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
});

router.post('/import-excel/:code', async (req, res) => {
  const code = String(req.params.code || '').trim();
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const mode = req.body?.mode === 'overwrite' ? 'overwrite' : 'update';
  const overwriteStart = mode === 'overwrite' && req.body?.overwrite_start === true;

  if (!code) return res.status(400).json({ success: false, error: 'Restaurant code is required' });
  if (!rows.length) return res.status(400).json({ success: false, error: 'No Excel rows supplied' });
  if (rows.length > 100) return res.status(400).json({ success: false, error: 'Import chunks are limited to 100 rows' });

  try {
    const { data: restaurant, error: restaurantError } = await supabase
      .from('restaurants')
      .select('id')
      .eq('code', code)
      .single();

    if (restaurantError || !restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    // Overwrite mode is intentionally non-destructive: on the first chunk,
    // deactivate the current menu. Rows present in the Excel sheet are then
    // reactivated/updated as they are processed. This preserves historical
    // records and lets the restaurant reverse the import if needed.
    if (overwriteStart) {
      const [productsOff, categoriesOff] = await Promise.all([
        supabase.from('products').update({ active: false }).eq('restaurant_id', restaurant.id),
        supabase.from('categories').update({ active: false }).eq('restaurant_id', restaurant.id)
      ]);
      if (productsOff.error) throw new Error(`Could not deactivate existing products: ${productsOff.error.message}`);
      if (categoriesOff.error) throw new Error(`Could not deactivate existing categories: ${categoriesOff.error.message}`);
    }

    const [categoryResult, productResult] = await Promise.all([
      supabase.from('categories').select('id, name').eq('restaurant_id', restaurant.id),
      supabase.from('products').select('id, name').eq('restaurant_id', restaurant.id)
    ]);

    if (categoryResult.error) throw new Error(categoryResult.error.message);
    if (productResult.error) throw new Error(productResult.error.message);

    const categoryMap = new Map(
      (categoryResult.data || []).map(c => [String(c.name || '').trim().toLowerCase(), c.id])
    );
    const productMap = new Map(
      (productResult.data || []).map(p => [String(p.name || '').trim().toLowerCase(), p.id])
    );

    let created = 0;
    let updated = 0;
    let categoriesCreated = 0;
    let failed = 0;
    const errors = [];

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index] || {};
      const sourceRow = Number(row.source_row || index + 2);

      try {
        const name = String(row.name || '').trim();
        const categoryName = String(row.category || '').trim();
        const description = String(row.description || '').trim();
        const imageUrl = String(row.image_url || '').trim();
        const price = Number(row.price);

        if (!name) throw new Error('Product Name is required');
        if (!categoryName) throw new Error('Category is required');
        if (!Number.isFinite(price) || price < 0) throw new Error('Price CHF must be a valid number');

        const active = posupExcelBool(row.active, true);
        const isAlcohol = posupExcelBool(row.is_alcohol, false);

        const categoryKey = categoryName.toLowerCase();
        let categoryId = categoryMap.get(categoryKey);

        if (!categoryId) {
          const { data: newCategory, error: categoryError } = await supabase
            .from('categories')
            .insert({
              restaurant_id: restaurant.id,
              wc_id: posupManualWcId(),
              name: categoryName,
              slug: posupSlug(categoryName),
              active: true,
              sort_order: 0
            })
            .select('id, name')
            .single();

          if (categoryError) throw new Error(`Could not create category "${categoryName}": ${categoryError.message}`);

          categoryId = newCategory.id;
          categoryMap.set(categoryKey, categoryId);
          categoriesCreated++;
        } else {
          // Any category explicitly present in the Excel sheet should be active.
          // This is especially important after an overwrite reset.
          const { error: categoryEnableError } = await supabase
            .from('categories')
            .update({ active: true })
            .eq('id', categoryId);
          if (categoryEnableError) throw new Error(`Could not enable category "${categoryName}": ${categoryEnableError.message}`);
        }

        const productKey = name.toLowerCase();
        let productId = productMap.get(productKey);

        if (productId) {
          const { error: updateError } = await supabase
            .from('products')
            .update({
              description,
              price,
              active,
              image_url: imageUrl,
              is_alcohol: isAlcohol,
              type: 'simple',
              price_overridden: true
            })
            .eq('id', productId);

          if (updateError) throw new Error(updateError.message);
          updated++;
        } else {
          const { data: newProduct, error: productError } = await supabase
            .from('products')
            .insert({
              restaurant_id: restaurant.id,
              wc_id: posupManualWcId(),
              name,
              description,
              type: 'simple',
              price,
              regular_price: price,
              image_url: imageUrl,
              sort_order: 0,
              active,
              is_alcohol: isAlcohol
            })
            .select('id, name')
            .single();

          if (productError) throw new Error(productError.message);

          productId = newProduct.id;
          productMap.set(productKey, productId);
          created++;
        }

        const { error: deleteMappingError } = await supabase
          .from('product_categories')
          .delete()
          .eq('product_id', productId);
        if (deleteMappingError) throw new Error(deleteMappingError.message);

        const { error: mappingError } = await supabase
          .from('product_categories')
          .insert({
            product_id: productId,
            category_id: categoryId
          });
        if (mappingError) throw new Error(mappingError.message);

      } catch (rowError) {
        failed++;
        errors.push({
          row: sourceRow,
          name: String(row.name || '').trim(),
          error: rowError.message
        });
      }
    }

    res.json({
      success: true,
      mode,
      overwrite_started: overwriteStart,
      created,
      updated,
      categories_created: categoriesCreated,
      failed,
      errors
    });
  } catch (err) {
    console.error('POSUP Excel import error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// POSUP logo upload (Supabase Storage)
// ─────────────────────────────────────────

const POSUP_ASSET_BUCKET = 'posup-assets';

async function ensurePosupAssetBucket() {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw new Error(`Could not access storage buckets: ${listError.message}`);

  const existingBucket = (buckets || []).find(bucket => bucket.name === POSUP_ASSET_BUCKET);
  if (!existingBucket) {
    const { error: createError } = await supabase.storage.createBucket(POSUP_ASSET_BUCKET, {
      public: true,
      fileSizeLimit: 1048576,
      allowedMimeTypes: ['image/webp', 'image/png', 'image/jpeg']
    });
    if (createError) throw new Error(`Could not create POSUP asset bucket: ${createError.message}`);
  } else if (existingBucket.public !== true) {
    const { error: updateError } = await supabase.storage.updateBucket(POSUP_ASSET_BUCKET, {
      public: true,
      fileSizeLimit: 1048576,
      allowedMimeTypes: ['image/webp', 'image/png', 'image/jpeg']
    });
    if (updateError) throw new Error(`Could not make POSUP asset bucket public: ${updateError.message}`);
  }
}

router.post('/restaurants/:code/logo-upload', async (req, res) => {
  const code = String(req.params.code || '').trim();
  const dataUrl = String(req.body?.data_url || '');

  if (!code) return res.status(400).json({ success: false, error: 'Restaurant code is required' });

  const match = dataUrl.match(/^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    return res.status(400).json({ success: false, error: 'Invalid logo image. Use PNG, JPG or WEBP.' });
  }

  const contentType = match[1];
  const buffer = Buffer.from(match[2], 'base64');

  if (!buffer.length || buffer.length > 750000) {
    return res.status(400).json({ success: false, error: 'Logo must be smaller than 750 KB after compression' });
  }

  try {
    const { data: restaurant, error: restaurantError } = await supabase
      .from('restaurants')
      .select('id, wp_site_url')
      .eq('code', code)
      .single();

    if (restaurantError || !restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    if (restaurant.wp_site_url) {
      return res.status(400).json({ success: false, error: 'WordPress-linked logos must be changed in WordPress' });
    }

    await ensurePosupAssetBucket();

    const ext = contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1];
    const safeCode = code.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const filePath = `${safeCode}/posup-logo-${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(POSUP_ASSET_BUCKET)
      .upload(filePath, buffer, {
        contentType,
        cacheControl: '3600',
        upsert: false
      });

    if (uploadError) throw new Error(`Logo upload failed: ${uploadError.message}`);

    const { data: publicData } = supabase.storage
      .from(POSUP_ASSET_BUCKET)
      .getPublicUrl(filePath);

    const logoUrl = publicData?.publicUrl;
    if (!logoUrl) throw new Error('Could not create public logo URL');

    const { data: updated, error: updateError } = await supabase
      .from('restaurants')
      .update({ logo_url: logoUrl })
      .eq('code', code)
      .select('code, name, logo_url')
      .single();

    if (updateError) throw new Error(updateError.message);

    res.json({ success: true, logo_url: logoUrl, restaurant: updated });
  } catch (err) {
    console.error('POSUP logo upload error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// POSUP customer helpers
// ─────────────────────────────────────────
function cleanPosupCustomerPayload(customer = {}) {
  return {
    first_name: String(customer.first_name || '').trim(),
    last_name:  String(customer.last_name || '').trim(),
    phone:      String(customer.phone || '').trim(),
    street:     String(customer.street || '').trim(),
    zip:        String(customer.zip || '').trim(),
    city:       String(customer.city || '').trim(),
  };
}

function normalizePosupPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

async function findPosupCustomerByPhone(code, phone) {
  const cleanPhone = String(phone || '').trim();
  const normalized = normalizePosupPhone(cleanPhone);

  if (!cleanPhone && !normalized) return null;

  // First try exact match. This is fast and covers most saved customers.
  const exact = await supabase
    .from('posup_customers')
    .select('*')
    .eq('restaurant_code', code)
    .eq('phone', cleanPhone)
    .maybeSingle();

  if (exact.error) throw new Error(exact.error.message);
  if (exact.data) return exact.data;

  // Fallback: match the same number even if it contains spaces, +, or dashes.
  const all = await supabase
    .from('posup_customers')
    .select('*')
    .eq('restaurant_code', code)
    .limit(500);

  if (all.error) throw new Error(all.error.message);

  return (all.data || []).find(row => {
    const savedNormalized = normalizePosupPhone(row.phone);
    return normalized && savedNormalized && savedNormalized === normalized;
  }) || null;
}

async function upsertPosupCustomer(code, customer, options = {}) {
  const cleaned = cleanPosupCustomerPayload(customer);
  const incrementOrder = options.incrementOrder === true;
  const now = new Date().toISOString();

  if (!cleaned.phone) {
    return null;
  }

  const existing = await findPosupCustomerByPhone(code, cleaned.phone);

  const payload = {
    restaurant_code: code,
    first_name: cleaned.first_name || existing?.first_name || '',
    last_name:  cleaned.last_name  || existing?.last_name  || '',
    phone:      cleaned.phone,
    street:     cleaned.street     || existing?.street     || '',
    zip:        cleaned.zip        || existing?.zip        || '',
    city:       cleaned.city       || existing?.city       || '',
    updated_at: now,
  };

  if (incrementOrder) {
    payload.order_count = existing ? (existing.order_count || 0) + 1 : 1;
    payload.last_order_at = now;
  } else if (existing) {
    // Manual customer edits must not fake customer history.
    payload.order_count = existing.order_count || 0;
    payload.last_order_at = existing.last_order_at || null;
  } else {
    payload.order_count = 0;
    payload.last_order_at = null;
  }

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
        created_at: now,
      })
      .select()
      .single();
  }

  if (result.error) throw new Error(result.error.message);
  return result.data;
}

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
      .limit(500);

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
// Manual save does NOT increase order_count unless increment_order is true.
// ─────────────────────────────────────────
router.post('/customers/:code', async (req, res) => {
  const { code } = req.params;

  try {
    const customer = cleanPosupCustomerPayload(req.body);

    if (!customer.phone) {
      return res.status(400).json({
        success: false,
        error: 'Phone is required',
      });
    }

    const saved = await upsertPosupCustomer(code, customer, {
      incrementOrder: req.body.increment_order === true,
    });

    res.json({
      success: true,
      customer: saved,
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

    let customerHistory = null;
    let customerHistoryError = null;
    const orderCustomer = order.customer || order.phone_customer || order.customer_info || null;

    if (orderCustomer?.phone) {
      try {
        customerHistory = await upsertPosupCustomer(code, orderCustomer, {
          incrementOrder: true,
        });
      } catch (customerErr) {
        customerHistoryError = customerErr.message;
        console.error('POSUP customer history update failed:', customerErr);
      }
    }

    res.json({
      success: true,
      order_id: orderNumber,
      order: data,
      customer_history: customerHistory,
      customer_history_error: customerHistoryError,
    });
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

  let paymentTerminalMode = 'manual';
  let goodcomTerminalId = '';
  const paymentSettings = await supabase
    .from('restaurants')
    .select('payment_terminal_mode, goodcom_terminal_id')
    .eq('code', code)
    .single();

  if (!paymentSettings.error && paymentSettings.data) {
    paymentTerminalMode = normalizePaymentTerminalMode(paymentSettings.data.payment_terminal_mode);
    goodcomTerminalId = paymentSettings.data.goodcom_terminal_id || '';
  }

  res.json({
    success: true,
    restaurant: {
      ...restaurant,
      payment_terminal_mode: paymentTerminalMode,
      goodcom_terminal_id: goodcomTerminalId,
      payment_schema_ready: !paymentSettings.error,
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
  const { name, pin, admin_pin, printer_ip, printer_port, printer_model, logo_url, payment_terminal_mode, goodcom_terminal_id } = req.body;

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (pin) updates.pin = pin;
  if (admin_pin) updates.admin_pin = admin_pin;
  if (printer_ip !== undefined) updates.printer_ip = printer_ip;
  if (printer_port !== undefined) updates.printer_port = printer_port;
  if (printer_model !== undefined) updates.printer_model = printer_model;
  if (logo_url !== undefined) updates.logo_url = logo_url;
  if (payment_terminal_mode !== undefined) {
    const normalizedMode = String(payment_terminal_mode || '').trim().toLowerCase();
    if (!POSUP_PAYMENT_TERMINAL_MODES.has(normalizedMode)) {
      return res.status(400).json({ success: false, error: 'Invalid payment terminal mode' });
    }
    updates.payment_terminal_mode = normalizedMode;
  }
  if (goodcom_terminal_id !== undefined) updates.goodcom_terminal_id = String(goodcom_terminal_id || '').trim() || null;

  const { data, error } = await supabase
    .from('restaurants')
    .update(updates)
    .eq('code', code)
    .select()
    .single();

  if (error) {
    if (isMissingPaymentSchemaError(error)) {
      return res.status(503).json({
        success: false,
        error: 'Payment terminal database migration is required before this setting can be saved.',
        code: 'payment_terminal_migration_required',
      });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
  if (!data) return res.status(404).json({ success: false, error: 'Restaurant not found' });

  res.json({ success: true, restaurant: data });
});

// Public POS-safe payment configuration. Does not expose PINs/admin secrets.
router.get('/payment-config/:code', async (req, res) => {
  const { code } = req.params;

  const result = await supabase
    .from('restaurants')
    .select('payment_terminal_mode')
    .eq('code', code)
    .single();

  if (result.error) {
    if (isMissingPaymentSchemaError(result.error)) {
      return res.json({ success: true, payment_terminal_mode: 'manual', payment_schema_ready: false });
    }
    return res.status(404).json({ success: false, error: 'Restaurant not found' });
  }

  res.json({
    success: true,
    payment_terminal_mode: normalizePaymentTerminalMode(result.data?.payment_terminal_mode),
    payment_schema_ready: true,
  });
});

// Create a server-side trace before a Goodcom card attempt.
router.post('/payment-transactions/:code', async (req, res) => {
  const { code } = req.params;
  const amount = Number(req.body?.amount);
  const currency = String(req.body?.currency || 'CHF').trim().toUpperCase();
  const clientReference = String(req.body?.client_reference || '').trim();

  if (!Number.isFinite(amount) || amount <= 0 || !clientReference) {
    return res.status(400).json({ success: false, error: 'Valid amount and client_reference are required' });
  }

  try {
    const restaurantResult = await supabase
      .from('restaurants')
      .select('id, payment_terminal_mode')
      .eq('code', code)
      .single();

    if (restaurantResult.error || !restaurantResult.data) {
      if (isMissingPaymentSchemaError(restaurantResult.error)) {
        return res.status(503).json({ success: false, code: 'payment_terminal_migration_required', error: 'Payment terminal database migration is required.' });
      }
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    const terminalMode = normalizePaymentTerminalMode(restaurantResult.data.payment_terminal_mode);
    if (terminalMode !== 'goodcom') {
      return res.status(409).json({ success: false, error: 'This restaurant is not configured for Goodcom integrated payments' });
    }

    const insertResult = await supabase
      .from('posup_payment_transactions')
      .insert({
        restaurant_id: restaurantResult.data.id,
        client_reference: clientReference,
        amount: Math.round(amount * 100) / 100,
        currency,
        terminal_mode: 'goodcom',
        status: 'created',
      })
      .select('id, client_reference, amount, currency, terminal_mode, status, created_at')
      .single();

    if (insertResult.error) {
      if (isMissingPaymentSchemaError(insertResult.error)) {
        return res.status(503).json({ success: false, code: 'payment_terminal_migration_required', error: 'Payment transaction table is not installed yet.' });
      }
      throw new Error(insertResult.error.message);
    }

    res.json({ success: true, transaction: insertResult.data });
  } catch (err) {
    console.error('POSUP payment transaction start error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update a Goodcom transaction as the device returns processing/result state.
router.patch('/payment-transactions/:code/:id', async (req, res) => {
  const { code, id } = req.params;
  const updates = { updated_at: new Date().toISOString() };

  if (req.body?.status !== undefined) {
    const status = String(req.body.status || '').trim().toLowerCase();
    if (!POSUP_PAYMENT_STATUSES.has(status)) {
      return res.status(400).json({ success: false, error: 'Invalid payment status' });
    }
    updates.status = status;
  }
  if (req.body?.terminal_reference !== undefined) updates.terminal_reference = String(req.body.terminal_reference || '').trim() || null;
  if (req.body?.order_number !== undefined) updates.order_number = String(req.body.order_number || '').trim() || null;
  if (req.body?.error_message !== undefined) updates.error_message = String(req.body.error_message || '').trim() || null;

  try {
    const restaurant = await supabase.from('restaurants').select('id').eq('code', code).single();
    if (restaurant.error || !restaurant.data) return res.status(404).json({ success: false, error: 'Restaurant not found' });

    const result = await supabase
      .from('posup_payment_transactions')
      .update(updates)
      .eq('id', id)
      .eq('restaurant_id', restaurant.data.id)
      .select('id, client_reference, amount, currency, terminal_mode, status, terminal_reference, order_number, error_message, created_at, updated_at')
      .single();

    if (result.error) {
      if (isMissingPaymentSchemaError(result.error)) {
        return res.status(503).json({ success: false, code: 'payment_terminal_migration_required', error: 'Payment transaction table is not installed yet.' });
      }
      throw new Error(result.error.message);
    }

    res.json({ success: true, transaction: result.data });
  } catch (err) {
    console.error('POSUP payment transaction update error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
