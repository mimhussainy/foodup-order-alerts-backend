(() => {
  const state = {
    view: ['overview','restaurants','orders','health'].includes(location.hash.replace('#','')) ? location.hash.replace('#','') : 'overview',
    overview: null,
    restaurants: [],
    orders: [],
    health: null,
    restaurantFilter: 'all',
    restaurantSort: 'attention',
    search: '',
    selectedRestaurant: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const fmtMoney = (value) => `CHF ${Number(value || 0).toFixed(2)}`;
  const fmtAgo = (value) => {
    if (!value) return 'Never';
    const ms = Date.now() - new Date(value).getTime();
    const min = Math.max(0, Math.floor(ms / 60000));
    if (min < 1) return 'Just now';
    if (min < 60) return `${min}m ago`;
    if (min < 1440) return `${Math.floor(min / 60)}h ago`;
    return `${Math.floor(min / 1440)}d ago`;
  };
  const statusLabel = status => ({ online:'Online', idle:'Idle', offline:'Offline', never:'Never seen', unknown:'Unknown' }[status] || status || 'Unknown');
  const initials = name => String(name || 'F').split(/\s+/).slice(0,2).map(x => x[0] || '').join('').toUpperCase();
  const icon = name => `<i class="ti ti-${name}" aria-hidden="true"></i>`;

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    let body = {};
    try { body = await response.json(); } catch (_) {}
    if (response.status === 401) {
      showLogin();
      throw new Error('Authentication required');
    }
    if (!response.ok || body.success === false) throw new Error(body.message || `Request failed (${response.status})`);
    return body;
  }

  function toast(message, type = '') {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    $('#toastContainer').appendChild(node);
    setTimeout(() => node.remove(), 3200);
  }

  function showLogin() {
    $('#appView').classList.add('hidden');
    $('#loginView').classList.remove('hidden');
    setTimeout(() => $('#password')?.focus(), 20);
  }

  function showApp() {
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
  }

  async function init() {
    bindStaticEvents();
    try {
      const session = await api('/admin/api/session');
      if (!session.authenticated) return showLogin();
      showApp();
      switchView(state.view, false);
      await refreshAll();
    } catch (_) {
      showLogin();
    }
  }

  function bindStaticEvents() {
    $('#loginForm').addEventListener('submit', async event => {
      event.preventDefault();
      $('#loginError').textContent = '';
      try {
        await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
        $('#password').value = '';
        showApp();
        switchView(state.view, false);
        await refreshAll();
      } catch (error) {
        $('#loginError').textContent = error.message;
      }
    });

    $('#logoutBtn').addEventListener('click', async () => {
      try { await api('/admin/api/logout', { method: 'POST', body: '{}' }); } catch (_) {}
      showLogin();
    });

    $$('.nav-item[data-view]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    $$('[data-jump]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.jump)));
    $('#refreshBtn').addEventListener('click', refreshAll);
    $('#globalSearch').addEventListener('input', e => { state.search = e.target.value.trim().toLowerCase(); renderCurrentView(); });
    $$('.filter-pill').forEach(btn => btn.addEventListener('click', () => {
      $$('.filter-pill').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      state.restaurantFilter = btn.dataset.status;
      renderRestaurants();
    }));
    $('#restaurantSort').addEventListener('change', e => { state.restaurantSort = e.target.value; renderRestaurants(); });
    $('#ordersRestaurantFilter').addEventListener('change', renderOrders);
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#drawerBackdrop').addEventListener('click', closeDrawer);
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalBackdrop').addEventListener('click', closeModal);
  }

  async function refreshAll() {
    $('#refreshBtn').disabled = true;
    $('#refreshBtn').innerHTML = icon('loader-2'); $('#refreshBtn').classList.add('is-spinning');
    try {
      const [overview, orders, health] = await Promise.all([
        api('/admin/api/overview'),
        api('/admin/api/orders'),
        api('/admin/api/health'),
      ]);
      state.overview = overview;
      state.restaurants = overview.restaurants || [];
      state.orders = orders.orders || [];
      state.health = health;
      $('#lastRefresh').textContent = `Updated ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
      $('#navRestaurantCount').textContent = state.restaurants.length || '';
      $('#navIssueCount').textContent = health.issues?.length || '';
      populateRestaurantFilter();
      renderAll();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      $('#refreshBtn').disabled = false;
      $('#refreshBtn').innerHTML = icon('refresh'); $('#refreshBtn').classList.remove('is-spinning');
    }
  }

  function switchView(view, updateUrl = true) {
    if (!['overview','restaurants','orders','health'].includes(view)) view = 'overview';
    state.view = view;
    if (updateUrl) history.replaceState(null, '', `#${view}`);
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
    $$('.nav-item[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
    $('#pageTitle').textContent = ({overview:'Overview',restaurants:'Restaurants',orders:'Orders',health:'Health & Alerts'}[view] || view);
    renderCurrentView();
  }

  function renderAll() {
    renderOverview(); renderRestaurants(); renderOrders(); renderHealth();
  }
  function renderCurrentView() {
    if (state.view === 'overview') renderOverview();
    if (state.view === 'restaurants') renderRestaurants();
    if (state.view === 'orders') renderOrders();
    if (state.view === 'health') renderHealth();
  }

  function renderOverview() {
    if (!state.overview) return;
    const s = state.overview.summary || {};
    const cards = [
      ['Restaurants', s.restaurants, 'purple', 'building-store'],
      ['Online', s.online, 'green', 'circle-check'],
      ['Needs attention', s.attention, 'red', 'alert-triangle'],
      ['Orders today', s.orders_today, 'blue', 'receipt-2'],
      ['Revenue today', fmtMoney(s.revenue_today), 'amber', 'trending-up'],
    ];
    $('#summaryCards').innerHTML = cards.map(([label,value,color,iconName]) => `<div class="summary-card"><div class="summary-top"><span class="summary-icon ${color}">${icon(iconName)}</span></div><div class="summary-value">${esc(value)}</div><div class="summary-label">${esc(label)}</div></div>`).join('');

    const query = state.search;
    const restaurants = state.restaurants.filter(r => !query || `${r.name} ${r.code} ${r.website}`.toLowerCase().includes(query));
    $('#overviewRestaurants').innerHTML = restaurants.length ? restaurants
      .sort((a,b) => (b.attention?.length || 0) - (a.attention?.length || 0) || String(a.name).localeCompare(String(b.name)))
      .slice(0,8)
      .map(r => `<div class="compact-row" data-open-restaurant="${esc(r.code)}">
        <div class="restaurant-name-cell"><div class="restaurant-avatar">${esc(initials(r.name))}</div><div><div class="restaurant-name">${esc(r.name)}</div><div class="restaurant-meta">${esc(r.code)}${r.website ? ' · '+esc(r.website) : ''}</div></div></div>
        <div><span class="status-badge ${esc(r.app_status)}"><span class="status-dot ${esc(r.app_status)}"></span>${esc(statusLabel(r.app_status))}</span></div>
        <div class="metric-cell"><strong>${esc(r.orders_today || 0)}</strong><span>orders</span></div>
        <div class="metric-cell"><strong>${esc(fmtMoney(r.revenue_today))}</strong><span>today</span></div>
        <button class="row-action" aria-label="Open restaurant">${icon('chevron-right')}</button>
      </div>`).join('') : '<div class="empty-box">No restaurants found.</div>';

    const attention = (state.overview.attention || []).filter(r => !query || `${r.name} ${r.code} ${(r.attention||[]).join(' ')}`.toLowerCase().includes(query));
    $('#attentionList').innerHTML = attention.length ? attention.map(r => `<div class="attention-item" data-open-restaurant="${esc(r.code)}"><div class="attention-title"><span>${esc(r.name)}</span><span class="status-badge ${esc(r.app_status)}">${esc(statusLabel(r.app_status))}</span></div><div class="attention-issues">${esc((r.attention || []).join(' · '))}</div></div>`).join('') : '<div class="empty-box">Everything looks healthy.</div>';
    bindRestaurantOpeners($('#view-overview'));
  }

  function getFilteredRestaurants() {
    let list = [...state.restaurants];
    const q = state.search;
    if (q) list = list.filter(r => `${r.name} ${r.code} ${r.website} ${(r.attention||[]).join(' ')}`.toLowerCase().includes(q));
    if (state.restaurantFilter === 'online') list = list.filter(r => r.app_status === 'online' && !(r.attention || []).length);
    if (state.restaurantFilter === 'offline') list = list.filter(r => (r.attention || []).length > 0);
    list.sort((a,b) => {
      if (state.restaurantSort === 'name') return String(a.name).localeCompare(String(b.name));
      if (state.restaurantSort === 'orders') return (b.orders_today||0) - (a.orders_today||0);
      if (state.restaurantSort === 'revenue') return (b.revenue_today||0) - (a.revenue_today||0);
      return (b.attention?.length||0) - (a.attention?.length||0) || String(a.name).localeCompare(String(b.name));
    });
    return list;
  }

  const moduleShort = {website_ordering:'Web',orders_app:'Orders',courier:'Courier',customer_app:'App',online_payments:'Pay',auto_handling:'Auto',printing:'Print'};
  function renderFeatureBadges(modules = {}) {
    return Object.entries(moduleShort).map(([key,label]) => `<span class="feature-badge ${modules[key] ? 'on' : ''}">${label}</span>`).join('');
  }

  function renderRestaurants() {
    const list = getFilteredRestaurants();
    $('#restaurantsTableBody').innerHTML = list.length ? list.map(r => `<tr data-open-restaurant="${esc(r.code)}">
      <td><div class="restaurant-name-cell"><div class="restaurant-avatar">${esc(initials(r.name))}</div><div><div class="restaurant-name">${esc(r.name)}</div><div class="restaurant-meta">${esc(r.code)}${r.website ? ' · '+esc(r.website) : ''}</div></div></div></td>
      <td><span class="status-badge ${esc(r.app_status)}"><span class="status-dot ${esc(r.app_status)}"></span>${esc(statusLabel(r.app_status))}</span></td>
      <td><div class="feature-badges">${renderFeatureBadges(r.modules)}</div></td>
      <td><strong>${esc(r.orders_today || 0)}</strong></td><td>${esc(fmtMoney(r.revenue_today))}</td><td>${esc(r.device_count || 0)}</td><td>${r.printer_device_id ? 'Connected' : '—'}</td><td><button class="row-action" aria-label="Open restaurant">${icon('chevron-right')}</button></td>
    </tr>`).join('') : '<tr><td colspan="8"><div class="empty-box">No restaurants match your filters.</div></td></tr>';
    bindRestaurantOpeners($('#view-restaurants'));
  }

  function populateRestaurantFilter() {
    const select = $('#ordersRestaurantFilter');
    const current = select.value;
    select.innerHTML = '<option value="all">All restaurants</option>' + state.restaurants.slice().sort((a,b)=>String(a.name).localeCompare(String(b.name))).map(r => `<option value="${esc(r.code)}">${esc(r.name)}</option>`).join('');
    if ([...select.options].some(o => o.value === current)) select.value = current;
  }

  function renderOrders() {
    const q = state.search;
    const code = $('#ordersRestaurantFilter')?.value || 'all';
    let list = state.orders.filter(o => code === 'all' || o.restaurant_code === code);
    if (q) list = list.filter(o => `${o.order_id} ${o.restaurant_name} ${o.customer_name} ${o.customer_phone} ${o.status}`.toLowerCase().includes(q));
    $('#ordersCount').textContent = `${list.length} shown`;
    $('#ordersTableBody').innerHTML = list.length ? list.map(o => {
      const type = o.shipping?.method || o.shipping_method || '';
      const time = o.received_at || o.date_created;
      return `<tr data-open-restaurant="${esc(o.restaurant_code)}"><td><strong>#${esc(o.order_id)}</strong></td><td>${esc(o.restaurant_name)}</td><td><strong>${esc(o.customer_name || '—')}</strong><div class="restaurant-meta">${esc(o.customer_phone || '')}</div></td><td>${esc(type || '—')}</td><td>${esc(o.payment_method || '—')}</td><td><span class="order-status ${esc(o.status)}">${esc(o.status || '—')}</span></td><td><strong>${esc((o.currency || 'CHF')+' '+Number(o.total||0).toFixed(2))}</strong></td><td>${esc(fmtAgo(time))}</td></tr>`;
    }).join('') : '<tr><td colspan="8"><div class="empty-box">No orders found.</div></td></tr>';
    bindRestaurantOpeners($('#view-orders'));
  }

  function renderHealth() {
    if (!state.health) return;
    const restaurants = state.health.restaurants || [];
    const issues = (state.health.issues || []).filter(x => !state.search || `${x.name} ${x.code} ${x.issue}`.toLowerCase().includes(state.search));
    const websiteDown = restaurants.filter(r => r.website_health?.status === 'down').length;
    const appProblems = restaurants.filter(r => ['offline','never','unknown'].includes(r.app_status)).length;
    $('#healthSummary').innerHTML = [
      ['Open issues', issues.length],['App connectivity', appProblems],['Website problems', websiteDown]
    ].map(([label,val]) => `<div class="health-card"><strong>${esc(val)}</strong><span>${esc(label)}</span></div>`).join('');
    $('#healthIssues').innerHTML = issues.length ? issues.map(x => `<div class="health-row" data-open-restaurant="${esc(x.code)}"><div><div class="restaurant-name">${esc(x.name)}</div><div class="restaurant-meta">${esc(x.code)}</div></div><div class="health-issue">${esc(x.issue)}</div><div><span class="status-badge ${esc(x.app_status)}">${esc(statusLabel(x.app_status))}</span></div></div>`).join('') : '<div class="empty-box">No active platform issues.</div>';
    bindRestaurantOpeners($('#view-health'));
  }

  function bindRestaurantOpeners(root) {
    $$('[data-open-restaurant]', root).forEach(node => {
      node.addEventListener('click', event => {
        event.stopPropagation();
        openRestaurant(node.dataset.openRestaurant);
      });
    });
  }

  async function openRestaurant(code) {
    $('#drawerBackdrop').classList.remove('hidden');
    $('#restaurantDrawer').classList.remove('hidden');
    $('#restaurantDrawer').setAttribute('aria-hidden','false');
    $('#drawerTitle').textContent = 'Loading…';
    $('#drawerCode').textContent = code;
    $('#drawerContent').innerHTML = '<div class="empty-box">Loading restaurant details…</div>';
    try {
      const data = await api(`/admin/api/restaurants/${encodeURIComponent(code)}`);
      state.selectedRestaurant = data.restaurant;
      renderRestaurantDrawer();
    } catch (error) {
      $('#drawerContent').innerHTML = `<div class="empty-box">${esc(error.message)}</div>`;
    }
  }

  function closeDrawer() {
    $('#drawerBackdrop').classList.add('hidden');
    $('#restaurantDrawer').classList.add('hidden');
    $('#restaurantDrawer').setAttribute('aria-hidden','true');
    state.selectedRestaurant = null;
  }

  const moduleLabels = {website_ordering:'Website Ordering',orders_app:'Orders App',courier:'Courier',customer_app:'Customer App',online_payments:'Online Payments',auto_handling:'Automatic Handling',printing:'Printing / Device'};

  function renderRestaurantDrawer() {
    const r = state.selectedRestaurant;
    if (!r) return;
    $('#drawerTitle').textContent = r.name;
    $('#drawerCode').textContent = `${r.code}${r.website ? ' · '+r.website : ''}`;
    $('#drawerStatus').innerHTML = `<span class="status-dot ${esc(r.app_status)}"></span> ${esc(statusLabel(r.app_status))}${r.app_minutes_ago != null ? ' · '+esc(r.app_minutes_ago)+' min ago' : ''}`;
    const modules = r.modules || {};
    const orders = (r.recent_orders || []).slice(0,8);
    $('#drawerContent').innerHTML = `
      ${r.attention?.length ? `<div class="detail-section danger-zone"><div class="detail-section-head"><h3>Needs attention</h3></div><div class="detail-section-body"><div class="attention-issues">${esc(r.attention.join(' · '))}</div></div></div>` : ''}
      <div class="detail-section"><div class="detail-section-head"><h3>Operational status</h3></div><div class="detail-section-body"><div class="detail-grid">
        <div class="detail-stat"><span>Orders App</span><strong>${esc(statusLabel(r.app_status))}</strong></div>
        <div class="detail-stat"><span>Website</span><strong>${esc(r.website_health?.status || (r.website ? 'Configured' : 'Missing'))}</strong></div>
        <div class="detail-stat"><span>Devices</span><strong>${esc(r.device_count)} registered</strong></div>
        <div class="detail-stat"><span>Printer</span><strong>${esc(r.printer_device_id || 'Not assigned')}</strong></div>
        <div class="detail-stat"><span>Orders today</span><strong>${esc(r.orders_today)}</strong></div>
        <div class="detail-stat"><span>Revenue today</span><strong>${esc(fmtMoney(r.revenue_today))}</strong></div>
      </div></div></div>
      <div class="detail-section"><div class="detail-section-head"><h3>Restaurant profile</h3><button id="saveProfileBtn" class="btn btn-primary">Save</button></div><div class="detail-section-body"><div class="edit-grid">
        <div class="field"><label>Name</label><input id="editName" value="${esc(r.name)}"></div>
        <div class="field"><label>Website</label><input id="editWebsite" value="${esc(r.website)}" placeholder="restaurant.ch"></div>
        <div class="field"><label>Phone</label><input id="editPhone" value="${esc(r.phone)}"></div>
        <div class="field"><label>Address</label><input id="editAddress" value="${esc(r.address)}"></div>
      </div></div></div>
      <div class="detail-section"><div class="detail-section-head"><h3>Plan & feature modules</h3><button id="saveModulesBtn" class="btn btn-primary">Save</button></div><div class="detail-section-body"><div class="module-grid">
        ${Object.entries(moduleLabels).map(([key,label]) => `<div class="module-toggle"><span>${esc(label)}</span><label class="switch"><input type="checkbox" data-module="${esc(key)}" ${modules[key] ? 'checked' : ''}><span></span></label></div>`).join('')}
      </div></div></div>
      <div class="detail-section"><div class="detail-section-head"><h3>Connection management</h3></div><div class="detail-section-body"><div class="actions-row">
        <button id="resetDevicesBtn" class="btn btn-secondary">Reset Orders devices</button>
        <button id="resetPrinterBtn" class="btn btn-secondary">Clear printer assignment</button>
        <button id="resetPinBtn" class="btn btn-secondary">Set new owner PIN</button>
      </div></div></div>
      <div class="detail-section"><div class="detail-section-head"><h3>Recent orders</h3><span class="restaurant-meta">Last ${orders.length}</span></div><div class="detail-section-body">${orders.length ? `<table class="mini-orders">${orders.map(o => `<tr><td><strong>#${esc(o.order_id)}</strong><br><span class="restaurant-meta">${esc(o.customer_name || '')}</span></td><td>${esc(o.status || '')}</td><td style="text-align:right"><strong>${esc((o.currency||'CHF')+' '+Number(o.total||0).toFixed(2))}</strong><br><span class="restaurant-meta">${esc(fmtAgo(o.received_at||o.date_created))}</span></td></tr>`).join('')}</table>` : '<div class="empty-box">No recent orders.</div>'}</div></div>
      <div class="detail-section danger-zone"><div class="detail-section-head"><h3>Danger zone</h3></div><div class="detail-section-body"><p class="restaurant-meta" style="margin-top:0;line-height:1.6">These actions affect backend data for this restaurant.</p><div class="actions-row"><button id="clearOrdersBtn" class="btn btn-outline-danger">Clear order history</button><button id="removeRestaurantBtn" class="btn btn-danger">Remove restaurant</button></div></div></div>
    `;
    bindDrawerActions();
  }

  function bindDrawerActions() {
    const code = state.selectedRestaurant.code;
    $('#saveProfileBtn').addEventListener('click', async () => {
      try {
        const body = { name: $('#editName').value, website: $('#editWebsite').value, phone: $('#editPhone').value, address: $('#editAddress').value };
        const data = await api(`/admin/api/restaurants/${encodeURIComponent(code)}`, { method:'PATCH', body: JSON.stringify(body) });
        state.selectedRestaurant = data.restaurant; toast('Restaurant profile saved'); await refreshAll(); renderRestaurantDrawer();
      } catch (e) { toast(e.message,'error'); }
    });
    $('#saveModulesBtn').addEventListener('click', async () => {
      const modules = {}; $$('[data-module]', $('#drawerContent')).forEach(input => modules[input.dataset.module] = input.checked);
      try {
        const data = await api(`/admin/api/restaurants/${encodeURIComponent(code)}`, { method:'PATCH', body: JSON.stringify({ modules }) });
        state.selectedRestaurant = data.restaurant; toast('Feature modules updated'); await refreshAll(); renderRestaurantDrawer();
      } catch (e) { toast(e.message,'error'); }
    });
    $('#resetDevicesBtn').addEventListener('click', () => confirmationModal('Reset Orders devices', `Disconnect all registered Orders App devices for ${state.selectedRestaurant.name}?`, 'Reset devices', async () => {
      await api(`/admin/api/restaurants/${encodeURIComponent(code)}/reset-devices`, {method:'POST',body:'{}'}); toast('Orders devices reset'); await refreshAll(); await openRestaurant(code);
    }));
    $('#resetPrinterBtn').addEventListener('click', () => confirmationModal('Clear printer assignment', `Remove the currently assigned printer device for ${state.selectedRestaurant.name}?`, 'Clear printer', async () => {
      await api(`/admin/api/restaurants/${encodeURIComponent(code)}/reset-printer`, {method:'POST',body:'{}'}); toast('Printer assignment cleared'); await refreshAll(); await openRestaurant(code);
    }));
    $('#resetPinBtn').addEventListener('click', () => inputModal('Set new owner PIN', 'Enter a new owner PIN. The existing PIN is never displayed.', 'New owner PIN', async value => {
      const data = await api(`/admin/api/restaurants/${encodeURIComponent(code)}`, {method:'PATCH',body:JSON.stringify({owner_pin:value})}); state.selectedRestaurant=data.restaurant; toast('Owner PIN updated');
    }, 'password'));
    $('#clearOrdersBtn').addEventListener('click', () => typedConfirmation('Clear order history', `This permanently clears the stored FoodUp backend order history for ${state.selectedRestaurant.name}. Type ${code} to continue.`, code, async () => {
      await api(`/admin/api/restaurants/${encodeURIComponent(code)}/orders`, {method:'DELETE',body:JSON.stringify({confirm:code})}); toast('Order history cleared'); await refreshAll(); await openRestaurant(code);
    }));
    $('#removeRestaurantBtn').addEventListener('click', () => typedConfirmation('Remove restaurant', `This permanently removes ${state.selectedRestaurant.name} from FoodUp Control Center and deletes all backend data stored under this restaurant code. Type ${code} to confirm.`, code, async () => {
      await api(`/admin/api/restaurants/${encodeURIComponent(code)}`, {method:'DELETE',body:JSON.stringify({confirm:code})}); closeDrawer(); toast('Restaurant removed'); await refreshAll();
    }));
  }

  function openModal(title, html) {
    $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html;
    $('#modalBackdrop').classList.remove('hidden'); $('#modal').classList.remove('hidden');
  }
  function closeModal() { $('#modalBackdrop').classList.add('hidden'); $('#modal').classList.add('hidden'); $('#modalBody').innerHTML=''; }
  function confirmationModal(title, message, button, action) {
    openModal(title, `<p>${esc(message)}</p><div class="modal-actions"><button id="cancelModal" class="btn btn-secondary">Cancel</button><button id="confirmModal" class="btn btn-danger">${esc(button)}</button></div>`);
    $('#cancelModal').onclick=closeModal; $('#confirmModal').onclick=async()=>{try{await action();closeModal();}catch(e){toast(e.message,'error')}};
  }
  function typedConfirmation(title, message, expected, action) {
    openModal(title, `<p>${esc(message)}</p><input id="confirmText" autocomplete="off" placeholder="${esc(expected)}"><div class="modal-actions"><button id="cancelModal" class="btn btn-secondary">Cancel</button><button id="confirmModal" class="btn btn-danger">Confirm</button></div>`);
    $('#cancelModal').onclick=closeModal; $('#confirmModal').onclick=async()=>{if($('#confirmText').value!==expected)return toast('Confirmation code does not match','error');try{await action();closeModal();}catch(e){toast(e.message,'error')}};
  }
  function inputModal(title, message, placeholder, action, type='text') {
    openModal(title, `<p>${esc(message)}</p><input id="modalInput" type="${esc(type)}" autocomplete="off" placeholder="${esc(placeholder)}"><div class="modal-actions"><button id="cancelModal" class="btn btn-secondary">Cancel</button><button id="confirmModal" class="btn btn-primary">Save</button></div>`);
    $('#cancelModal').onclick=closeModal; $('#confirmModal').onclick=async()=>{const value=$('#modalInput').value.trim();if(!value)return toast('Enter a value','error');try{await action(value);closeModal();}catch(e){toast(e.message,'error')}}; setTimeout(()=>$('#modalInput')?.focus(),20);
  }

  init();
})();
