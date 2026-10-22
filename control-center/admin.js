/* FoodUp Control Center 3.0 — frontend (no framework, no external icon font) */
(() => {
  'use strict';

  const VIEWS = ['overview', 'restaurants', 'orders', 'health'];
  const TITLES = { overview: 'Overview', restaurants: 'Restaurants', orders: 'Orders', health: 'Health & Alerts' };
  const REFRESH_MS = 60 * 1000;
  const ANALYTICS_MS = 5 * 60 * 1000;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    view: 'overview',
    page: null,
    overview: null,
    analytics: null,
    orders: [],
    search: '',
    overviewFilter: 'all',
    restaurantFilter: 'all',
    restaurantSort: 'attention',
    orderStatus: 'all',
    drawer: null,
    firstPaint: true,
    countPending: true,
    lastAnalyticsAt: 0,
    refreshing: false,
  };

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const chf = (n) => {
    const parts = (Number(n) || 0).toFixed(2).split('.');
    return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '’') + '.' + parts[1];
  };
  const money = (n, currency = 'CHF') => `${currency || 'CHF'} ${chf(n)}`;
  const parseTime = (raw) => {
    if (!raw) return null;
    const s = String(raw).trim();
    const dt = new Date(/([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s.replace(' ', 'T') : s.replace(' ', 'T'));
    return Number.isNaN(dt.getTime()) ? null : dt;
  };
  const orderDate = (o) => parseTime(o?.received_at) || parseTime(o?.date_created);
  const fmtAgo = (value) => {
    const dt = value instanceof Date ? value : parseTime(value);
    if (!dt) return 'Never';
    const min = Math.max(0, Math.floor((Date.now() - dt.getTime()) / 60000));
    if (min < 1) return 'Just now';
    if (min < 60) return `${min} min ago`;
    if (min < 1440) return `${Math.floor(min / 60)} h ago`;
    return `${Math.floor(min / 1440)} d ago`;
  };
  const fmtTime = (value) => {
    const dt = value instanceof Date ? value : parseTime(value);
    return dt ? dt.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' }) : '—';
  };
  const fmtDateTime = (value) => {
    const dt = value instanceof Date ? value : parseTime(value);
    return dt ? dt.toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' }) : '—';
  };
  const fmtDuration = (seconds) => {
    const s = Math.max(0, Number(seconds) || 0);
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h`;
    return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
  };
  const statusLabel = s => ({ online: 'Online', idle: 'Idle', offline: 'Offline', never: 'Never seen', unknown: 'Unknown' }[s] || 'Unknown');
  const initials = name => String(name || 'F').split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase() || 'F';
  const pctDelta = (now, base) => (base > 0 ? Math.round(((now - base) / base) * 1000) / 10 : null);
  const deltaText = d => (d === null ? '' : `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0)}%`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const swissDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const dayLabel = (day) => { const [y, m, d] = day.split('-'); return `${d}.${m}.${y}`; };
  const addDays = (day, n) => { const [y, m, d] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

  const ICONS = {
    dashboard: 'M4 4h6v8H4zM14 4h6v5h-6zM4 16h6v4H4zM14 13h6v7h-6z',
    store: 'M3 21h18M5 21V10M19 21V10M3 7l2-4h14l2 4M3 7a3 3 0 0 0 6 0a3 3 0 0 0 6 0a3 3 0 0 0 6 0M9 21v-6h6v6',
    receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
    pulse: 'M3 12h4l3-7 4 14 3-7h4',
    logout: 'M14 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2M9 12h12M18 9l3 3-3 3',
    search: 'M10 4a6 6 0 1 0 0 12a6 6 0 1 0 0-12zM20 20l-5.6-5.6',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
    x: 'M6 6l12 12M18 6L6 18',
    'arrow-right': 'M5 12h14M13 6l6 6-6 6',
    chevron: 'M9 6l6 6-6 6',
    alert: 'M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    check: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM9 12l2 2 4-4',
    trend: 'M3 17l6-6 4 4 8-8M14 7h7v7',
    printer: 'M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M17 9V4H7v5M7 13h10v8H7z',
    device: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
    globe: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9s1.3-6.3 3.8-9z',
    clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7v5l3 2',
    bike: 'M5.5 14a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7zM18.5 14a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7zM5.5 17.5L9 10h6l3.5 7.5M9 10L7.5 6H5M15 10l-1.5-4H16',
    bag: 'M6 8h12l-1 12H7zM9 8V6a3 3 0 0 1 6 0v2',
    table: 'M4 9h16M6 9v10M18 9v10M8 5h8l2 4H6z',
    phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
    user: 'M12 12a4 4 0 1 0 0-8a4 4 0 1 0 0 8zM4 21a8 8 0 0 1 16 0',
    wallet: 'M3 7h18v12H3zM3 7l3-3h12l3 3M16 13h2',
    mail: 'M3 6h18v12H3zM3 6l9 7 9-7',
    key: 'M15 7a4 4 0 1 1-3.9 5H9l-1 1-1-1-1 1-1-1-1 1v-2l5.1-5.1A4 4 0 0 1 15 7zM16 8h.01',
    plug: 'M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5',
    trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
    star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
    note: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
    'arrow-left': 'M19 12H5M11 6l-6 6 6 6',
    pin: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 7.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z',
    external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    plus: 'M12 5v14M5 12h14',
    lock: 'M6 11h12v10H6zM8 11V8a4 4 0 0 1 8 0v3M12 15v2',
    menu: 'M4 6h16M4 12h16M4 18h16',
  };
  const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ''}"></path></svg>`;
  const hydrateIcons = (root = document) => $$('[data-icon]', root).forEach(el => { if (!el.querySelector('svg')) el.innerHTML = icon(el.dataset.icon); });

  // ---------- API ----------
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
    setTimeout(() => node.remove(), 3400);
  }

  // ---------- sliding segmented control ----------
  function segmented(el, options, value, onChange) {
    const sig = options.map(o => `${o.value}:${o.label}:${o.count ?? ''}`).join('|');
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.innerHTML = '<span class="seg-thumb" aria-hidden="true"></span>' + options.map(o => `<button type="button" class="seg-btn" role="tab" data-value="${esc(o.value)}" aria-selected="false">${esc(o.label)}${o.count != null ? `<span class="seg-count">${esc(o.count)}</span>` : ''}</button>`).join('');
      el.onclick = (event) => {
        const btn = event.target.closest('.seg-btn');
        if (!btn || btn.getAttribute('aria-selected') === 'true') return;
        selectSegment(el, btn.dataset.value);
        el._onChange?.(btn.dataset.value);
      };
      el.dataset.ready = '';
    }
    el._onChange = onChange;
    selectSegment(el, value);
  }
  function selectSegment(el, value) {
    $$('.seg-btn', el).forEach(b => b.setAttribute('aria-selected', String(b.dataset.value === value)));
    positionThumb(el);
  }
  function positionThumb(el) {
    const thumb = $('.seg-thumb', el);
    const active = $('.seg-btn[aria-selected="true"]', el);
    if (!thumb || !active || !active.offsetWidth) return;
    if (!el.dataset.ready) {
      thumb.style.transition = 'none';
      requestAnimationFrame(() => { thumb.style.transition = ''; });
      el.dataset.ready = '1';
    }
    thumb.style.width = `${active.offsetWidth}px`;
    thumb.style.transform = `translateX(${active.offsetLeft}px)`;
  }
  const positionAllThumbs = () => $$('.segmented').forEach(positionThumb);

  // ---------- views ----------
  function showLogin() {
    $('#appView').classList.add('hidden');
    $('#loginView').classList.remove('hidden');
    setTimeout(() => ($('#username').value ? $('#password') : $('#username'))?.focus(), 20);
  }
  function showApp() {
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
  }

  function setActiveView(view, navView) {
    state.view = view;
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
    $$('.nav-item[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === navView));
    $('#backLink').classList.toggle('hidden', view !== 'restaurant');
  }

  function switchView(view, updateUrl = true) {
    if (!VIEWS.includes(view)) view = 'overview';
    if (updateUrl && location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
    setActiveView(view, view);
    $('#pageTitle').textContent = TITLES[view];
    document.title = 'FoodUp Control Center';
    renderCurrentView();
    requestAnimationFrame(positionAllThumbs);
  }

  // Routes: #overview, #restaurants, #orders, #health, #restaurant/<code>[/<tab>]
  function parseRoute() {
    const hash = location.hash.replace(/^#/, '');
    const m = hash.match(/^restaurant\/([a-z0-9_-]+)(?:\/([a-z]+))?$/i);
    if (m) return { view: 'restaurant', code: decodeURIComponent(m[1]).toLowerCase(), tab: (m[2] || 'overview').toLowerCase() };
    return { view: VIEWS.includes(hash) ? hash : 'overview' };
  }
  function route() {
    const r = parseRoute();
    if (r.view === 'restaurant') showRestaurantPage(r.code, r.tab);
    else switchView(r.view, false);
  }

  function renderPageSub() {
    const s = state.overview?.summary || {};
    const now = new Date();
    const date = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Zurich' });
    const text = {
      overview: `${date} · updated ${fmtTime(now)}`,
      restaurants: `${plural(s.restaurants || 0, 'restaurant')} connected to FoodUp`,
      orders: 'Latest 100 orders per restaurant',
      health: s.issues ? `${plural(s.issues, 'open issue')} across ${plural(s.attention || 0, 'restaurant')}` : 'No open issues',
      restaurant: '',
    }[state.view];
    $('#pageSub').textContent = text || '';
  }

  function renderAll() {
    renderSidebar();
    renderOverview();
    renderRestaurants();
    renderOrders();
    renderHealth();
    renderPageSub();
  }
  function renderCurrentView() {
    if (state.view === 'overview') renderOverview();
    if (state.view === 'restaurants') renderRestaurants();
    if (state.view === 'orders') renderOrders();
    if (state.view === 'health') renderHealth();
    if (state.view === 'restaurant') renderRestaurantPage({ skipSide: settingsBusy() });
    renderPageSub();
  }

  // ---------- data ----------
  async function refreshAll({ silent = false } = {}) {
    if (state.refreshing) return;
    state.refreshing = true;
    const btn = $('#refreshBtn');
    btn.disabled = true;
    btn.classList.add('spinning');
    try {
      // First load waits for analytics too, so the entrance motion plays once with final numbers.
      const withAnalytics = !state.analytics;
      const [overview, orders, analytics] = await Promise.all([
        api('/admin/api/overview'),
        api('/admin/api/orders'),
        withAnalytics ? api('/admin/api/analytics').catch(() => null) : Promise.resolve(null),
      ]);
      state.overview = overview;
      state.orders = orders.orders || [];
      if (analytics?.analytics) { state.analytics = analytics.analytics; state.lastAnalyticsAt = Date.now(); }
      setBackendStatus(true);
      populateRestaurantFilter();
      renderAll();
      if (state.firstPaint) startEntranceMotion();
      const analyticsDue = !withAnalytics && (Date.now() - state.lastAnalyticsAt > ANALYTICS_MS || !silent);
      if (analyticsDue || !state.analytics) loadAnalytics();
      if (state.view === 'restaurant' && state.page?.data) {
        loadRestaurantPage({ silent, withAnalytics: !silent || Date.now() - state.page.lastAnalyticsAt > ANALYTICS_MS });
      }
    } catch (error) {
      if (error.message !== 'Authentication required') {
        setBackendStatus(false);
        if (!silent) toast(error.message, 'error');
      }
    } finally {
      state.refreshing = false;
      btn.disabled = false;
      btn.classList.remove('spinning');
    }
  }

  async function loadAnalytics() {
    try {
      const data = await api('/admin/api/analytics');
      const first = !state.analytics;
      state.analytics = data.analytics;
      state.lastAnalyticsAt = Date.now();
      renderOverview({ analyticsJustArrived: first });
    } catch (error) {
      if (!state.analytics) renderChart(overviewChart);
    }
  }

  function setBackendStatus(ok) {
    const dot = $('#backendDot');
    dot.className = `status-dot ${ok ? 'online' : 'offline'} live`;
    $('#backendLabel').textContent = ok ? 'Backend online' : 'Backend unreachable';
    $('#lastRefresh').textContent = ok ? `Updated ${fmtTime(new Date())} · auto every 60 s` : 'Retrying automatically';
  }

  let animateTimer = null;
  function startEntranceMotion() {
    if (reduceMotion) { state.firstPaint = false; state.countPending = false; return; }
    document.body.classList.add('cc-animate');
    runCountUps($('#kpiTiles'));
    state.countPending = false;
    clearTimeout(animateTimer);
    animateTimer = setTimeout(() => {
      document.body.classList.remove('cc-animate');
      state.firstPaint = false;
    }, 2600);
  }

  function runCountUps(root) {
    if (!root || reduceMotion) return;
    $$('[data-count]', root).forEach(el => {
      const target = Number(el.dataset.count) || 0;
      const fmt = el.dataset.fmt;
      const t0 = performance.now();
      const step = (t) => {
        const p = Math.min(1, (t - t0) / 1100);
        const e = 1 - Math.pow(1 - p, 3);
        el.textContent = fmt === 'chf' ? money(target * e) : String(Math.round(target * e));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  const restaurantsList = () => state.overview?.restaurants || [];
  const restaurantName = (code) => restaurantsList().find(r => r.code === code)?.name || code;
  const matchesSearch = (text) => !state.search || String(text).toLowerCase().includes(state.search);

  // ---------- sidebar ----------
  function renderSidebar() {
    const s = state.overview?.summary || {};
    const services = state.overview?.services;
    $('#navRestaurantCount').textContent = s.restaurants || '';
    $('#navIssueCount').textContent = s.issues || '';
    if (!services) { $('#servicesBox').innerHTML = ''; return; }
    const rows = [
      { name: 'API', meta: `up ${fmtDuration(services.api_uptime_seconds)}`, ok: true },
      { name: 'Redis', meta: services.redis_ms == null ? 'error' : `${services.redis_ms} ms`, ok: services.redis_ms != null },
      { name: 'Websites', meta: services.websites_total ? `${services.websites_up}/${services.websites_total} up` : 'no checks', ok: services.websites_up === services.websites_total },
      { name: 'Callbacks', meta: `${services.callbacks_failed} failed`, ok: !services.callbacks_failed },
    ];
    $('#servicesBox').innerHTML = `<div class="services-title">Services</div>` + rows.map(r => `<div class="service-row"><span class="status-dot ${r.ok ? 'online' : 'offline'} live"></span><span class="name">${esc(r.name)}</span><span class="meta">${esc(r.meta)}</span></div>`).join('');
  }

  // ---------- overview ----------
  function sparkPath(values, w = 120, h = 36) {
    if (!values.length) return { line: '', area: '' };
    const max = Math.max(...values), min = Math.min(...values);
    const pts = values.map((v, i) => [values.length === 1 ? w : i * w / (values.length - 1), 3 + (1 - (v - min) / ((max - min) || 1)) * (h - 6)]);
    const line = smoothPath(pts, 1, h - 1);
    return { line, area: `${line} L${w} ${h} L0 ${h} Z` };
  }
  function smoothPath(pts, lo, hi) {
    const f = q => `${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
    if (!pts.length) return '';
    if (pts.length === 1) return `M0 ${pts[0][1].toFixed(1)} L${f(pts[0])}`;
    let d = `M${f(pts[0])}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, Math.min(hi, Math.max(lo, p1[1] + (p2[1] - p0[1]) / 6))];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, Math.min(hi, Math.max(lo, p2[1] - (p3[1] - p1[1]) / 6))];
      d += ` C${f(c1)} ${f(c2)} ${f(p2)}`;
    }
    return d;
  }

  function todayFigures() {
    const s = state.overview?.summary || {};
    const a = state.analytics;
    const orders = a ? a.today_totals.orders : (s.orders_today || 0);
    const revenue = a ? a.today_totals.revenue : (s.revenue_today || 0);
    const rejected = a ? a.today_totals.rejected : (s.rejected_today || 0);
    return { orders, revenue, rejected, aov: orders ? revenue / orders : 0 };
  }

  function comparisonStart(a = state.analytics) {
    if (!a) return null;
    const sinceDay = swissDay(new Date(a.history_since));
    return dayLabel(addDays(sinceDay, 8));
  }

  function renderKpis() {
    const s = state.overview?.summary;
    if (!s) return;
    const a = state.analytics;
    const t = todayFigures();
    const counting = state.countPending && !reduceMotion;
    const canCompare = !!(a && a.last_week_complete);
    const base = a?.same_time_last_week || { orders: 0, revenue: 0 };
    const dOrders = canCompare ? pctDelta(t.orders, base.orders) : null;
    const dRevenue = canCompare ? pctDelta(t.revenue, base.revenue) : null;
    const baseAov = base.orders ? base.revenue / base.orders : 0;
    const dAov = canCompare && baseAov ? pctDelta(t.aov, baseAov) : null;
    const lastWeekLabel = a ? `${a.last_week_label}` : 'last week';
    const compareNote = canCompare
      ? `vs ${base.orders} at this time on ${lastWeekLabel}`
      : (a ? `Comparison with last week from ${comparisonStart()}` : 'Loading trend…');
    const badge = (d) => (d === null ? '' : `<span class="pill ${d >= 0 ? 'green' : 'amber'}">${deltaText(d)}</span>`);

    const daily = a?.daily || [];
    const so = sparkPath(daily.map(d => d.orders));
    const sr = sparkPath(daily.map(d => d.revenue));
    const aovs = daily.map(d => (d.orders ? d.revenue / d.orders : 0));
    const aovMax = Math.max(1, ...aovs);
    const total = s.restaurants || 0;
    const online = s.online || 0, idle = s.idle || 0, offline = Math.max(0, total - online - idle);
    const pOn = total ? (online / total) * 100 : 0;
    const pIdle = total ? ((online + idle) / total) * 100 : 0;
    const critical = s.critical || 0, warnings = s.warnings || 0;
    const sevSegments = [...Array(Math.min(critical, 8)).fill('critical'), ...Array(Math.min(warnings, Math.max(0, 8 - critical))).fill('warning')];
    const affected = restaurantsList().filter(r => (r.attention_items || []).length).map(r => r.name);
    const valueOrders = counting ? '0' : String(t.orders);
    const valueRevenue = counting ? money(0) : money(t.revenue);

    $('#kpiTiles').innerHTML = `
      <div class="kpi anim-rise" style="--d:0ms">
        <div class="kpi-top"><span class="kpi-label">Orders today</span>${badge(dOrders)}</div>
        <div class="kpi-value" data-count="${t.orders}">${valueOrders}</div>
        <svg class="kpi-spark anim-reveal" viewBox="0 0 120 36" preserveAspectRatio="none" aria-hidden="true"><path d="${so.area}" fill="var(--accent)" fill-opacity=".08"></path><path d="${so.line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"></path></svg>
        <div class="kpi-note">${esc(compareNote)}</div>
      </div>
      <div class="kpi anim-rise" style="--d:70ms">
        <div class="kpi-top"><span class="kpi-label">Revenue today</span>${badge(dRevenue)}</div>
        <div class="kpi-value" data-count="${t.revenue}" data-fmt="chf">${valueRevenue}</div>
        <svg class="kpi-spark anim-reveal" viewBox="0 0 120 36" preserveAspectRatio="none" aria-hidden="true"><path d="${sr.area}" fill="var(--amber)" fill-opacity=".1"></path><path d="${sr.line}" fill="none" stroke="var(--amber)" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"></path></svg>
        <div class="kpi-note">excl. rejected, cancelled &amp; refunded</div>
      </div>
      <div class="kpi anim-rise" style="--d:140ms">
        <div class="kpi-top"><span class="kpi-label">Avg. order value</span>${dAov === null ? '' : `<span class="pill amber">${deltaText(dAov)}</span>`}</div>
        <div class="kpi-value">${esc(money(t.aov))}</div>
        <div class="kpi-bars" aria-hidden="true">${aovs.map((v, i) => `<span class="anim-bar ${i === aovs.length - 1 ? 'now' : ''}" style="height:${Math.round(18 + 82 * (v / aovMax))}%;--d:${300 + i * 60}ms"></span>`).join('')}</div>
        <div class="kpi-note">last 7 days</div>
      </div>
      <div class="kpi kpi-ring anim-rise" style="--d:210ms">
        <svg viewBox="0 0 36 36" role="img" aria-label="${online} of ${total} restaurants online">
          <circle cx="18" cy="18" r="15.5" fill="none" stroke="#eef0f4" stroke-width="4"></circle>
          ${offline ? '<circle class="anim-ring" cx="18" cy="18" r="15.5" fill="none" stroke="var(--red)" stroke-width="4" pathLength="100" stroke-dasharray="100 100"></circle>' : ''}
          ${idle ? `<circle class="anim-ring" cx="18" cy="18" r="15.5" fill="none" stroke="var(--amber)" stroke-width="4" pathLength="100" stroke-dasharray="${pIdle.toFixed(1)} 100"></circle>` : ''}
          ${online ? `<circle class="anim-ring" cx="18" cy="18" r="15.5" fill="none" stroke="var(--green)" stroke-width="4" pathLength="100" stroke-dasharray="${pOn.toFixed(1)} 100"></circle>` : ''}
        </svg>
        <div>
          <div class="kpi-label">Orders App</div>
          <div class="kpi-value" style="margin-top:2px">${online}<small> / ${total} online</small></div>
          <div class="legend-col">
            ${idle ? `<span class="legend-item"><span class="legend-sw" style="background:var(--amber)"></span>${idle} idle</span>` : ''}
            ${offline ? `<span class="legend-item"><span class="legend-sw" style="background:var(--red)"></span>${offline} offline</span>` : ''}
            ${!idle && !offline ? '<span class="legend-item"><span class="legend-sw" style="background:var(--green)"></span>All online</span>' : ''}
          </div>
        </div>
      </div>
      <div class="kpi ${s.issues ? 'alert' : ''} anim-rise" style="--d:280ms">
        <div class="kpi-top"><span class="kpi-label">Open issues</span><span class="icon-chip ${s.issues ? 'red' : 'green'}">${icon(s.issues ? 'alert' : 'check')}</span></div>
        <div class="kpi-value ${s.issues ? 'red' : ''}">${s.issues || 0}</div>
        <div class="sev-bar" aria-hidden="true">${(sevSegments.length ? sevSegments : ['', '', '']).map(c => `<span class="${c}"></span>`).join('')}</div>
        <div class="kpi-note">${s.issues ? `${critical} critical · ${warnings} warning${warnings === 1 ? '' : 's'}${affected.length ? ' · ' + esc(affected.slice(0, 2).join(', ')) : ''}` : 'All restaurants healthy'}</div>
      </div>`;
  }

  function renderOverview(opts = {}) {
    if (!state.overview) return;
    renderKpis();
    renderChart(overviewChart, opts.analyticsJustArrived);
    renderShareAndMix();

    const all = restaurantsList();
    segmented($('#overviewFilter'), [
      { value: 'all', label: 'All', count: all.length },
      { value: 'online', label: 'Online', count: all.filter(r => r.app_status === 'online').length },
      { value: 'attention', label: 'Needs attention', count: all.filter(r => (r.attention || []).length).length },
    ], state.overviewFilter, v => { state.overviewFilter = v; renderOverviewRestaurants(); });
    renderOverviewRestaurants();
    renderAttention();
    $('#overviewOrders').innerHTML = orderRows(filteredOrders().slice(0, 6), true);
    bindOpeners($('#view-overview'));
  }

  function restaurantFilterFn(filter) {
    return r => (filter === 'online' ? r.app_status === 'online' : filter === 'attention' ? (r.attention || []).length > 0 : true);
  }

  function beatsHtml(beats) {
    const list = (beats && beats.length ? beats : Array(12).fill('n')).slice(-12);
    const names = { g: 'online', a: 'idle', r: 'offline', n: 'no data' };
    const aria = `Orders App last 60 minutes: ${list.map(b => names[b] || 'no data').join(', ')}`;
    return `<span class="beats"><span class="beat-row" role="img" aria-label="${esc(aria)}">${list.map((b, i) => `<span class="${esc(b)} anim-bar" style="--d:${600 + i * 25}ms" title="${(60 - i * 5)}–${(55 - i * 5)} min ago · ${names[b] || 'no data'}"></span>`).join('')}</span><span class="beat-scale"><span>60 min</span><span>now</span></span></span>`;
  }

  function restaurantRow(r, full) {
    const bad = (r.attention || []).length > 0;
    const seen = r.app_minutes_ago != null ? (r.app_minutes_ago < 1 ? 'Just now' : `${r.app_minutes_ago} min ago`) : 'No heartbeat yet';
    const features = full ? `<span class="feature-badges">${Object.entries(MODULE_SHORT).map(([key, label]) => `<span class="feature-badge ${r.modules?.[key] ? 'on' : ''}">${label}</span>`).join('')}</span>` : '';
    return `<button class="gt-row r-row" type="button" data-open-restaurant="${esc(r.code)}">
      <span class="cell-main c-main"><span class="avatar ${bad ? 'bad' : ''}" aria-hidden="true">${esc(initials(r.name))}</span><span style="min-width:0"><span class="t">${esc(r.name)}</span><span class="s">${esc(r.code)} · ${plural(r.device_count || 0, 'device')}</span></span></span>
      <span class="cell-stack c-status"><span class="pill ${esc(r.app_status)}"><span class="status-dot ${esc(r.app_status)} ${r.app_status === 'online' || r.app_status === 'offline' ? 'live' : ''}"></span>${esc(statusLabel(r.app_status))}</span><span class="s">${esc(seen)}</span></span>
      <span class="c-beats">${beatsHtml(r.beats)}</span>
      ${features ? `<span class="c-feat">${features}</span>` : ''}
      <span class="c-ed"><span class="tag ${r.edition === 'free' ? 'free' : 'pro'}">${r.edition === 'free' ? 'Free' : 'Pro'}</span></span>
      <span class="right strong num c-orders" data-unit="${(r.orders_today || 0) === 1 ? 'order' : 'orders'}">${esc(r.orders_today || 0)}</span>
      <span class="right num c-rev">${esc(money(r.revenue_today))}</span>
      ${full ? `<span class="with-icon c-printer ${r.printer_device_id ? '' : 'printer-missing'}">${icon('printer')}${r.printer_device_id ? 'Assigned' : 'Not assigned'}</span>` : ''}
      <span class="chev c-chev">${icon('chevron')}</span>
    </button>`;
  }

  function restaurantHead(full) {
    return `<div class="gt-head"><span>Restaurant</span><span>Orders App</span><span>Last 60 min</span>${full ? '<span>Features</span>' : ''}<span>Edition</span><span class="right">Orders</span><span class="right">Revenue</span>${full ? '<span>Printer</span>' : ''}<span></span></div>`;
  }

  function renderOverviewRestaurants() {
    const list = restaurantsList()
      .filter(restaurantFilterFn(state.overviewFilter))
      .filter(r => matchesSearch(`${r.name} ${r.code} ${r.website}`))
      .sort(byAttention);
    $('#overviewRestaurants').innerHTML = restaurantHead(false) + (list.length ? list.map(r => restaurantRow(r, false)).join('') : '<div class="empty-box">No restaurants match this filter.</div>');
    bindOpeners($('#overviewRestaurants'));
  }

  function byAttention(a, b) {
    const crit = r => (r.attention_items || []).filter(i => i.severity === 'critical').length;
    return crit(b) - crit(a) || (b.attention?.length || 0) - (a.attention?.length || 0) || String(a.name).localeCompare(String(b.name));
  }

  function renderAttention() {
    const all = restaurantsList();
    const list = all.filter(r => (r.attention_items || []).length).filter(r => matchesSearch(`${r.name} ${r.code} ${(r.attention || []).join(' ')}`)).sort(byAttention);
    const healthy = all.length - all.filter(r => (r.attention_items || []).length).length;
    const items = list.map(r => {
      const issues = [...r.attention_items].sort((x, y) => (x.severity === 'critical' ? -1 : 1) - (y.severity === 'critical' ? -1 : 1));
      const since = r.app_status === 'offline' && r.app_minutes_ago != null ? `${statusLabel(r.app_status)} for ${r.app_minutes_ago} min` : statusLabel(r.app_status);
      return `<div class="att-item">
        <div class="att-head"><span class="avatar bad" aria-hidden="true">${esc(initials(r.name))}</span><span><span class="t">${esc(r.name)}</span><span class="s">${esc(since)}</span></span></div>
        <div class="issue-list">${issues.map((i, idx) => `<div class="issue ${esc(i.severity)} anim-fade" style="--d:${700 + idx * 90}ms"><span class="sev ${esc(i.severity)}">${i.severity === 'critical' ? 'CRITICAL' : 'WARNING'}</span><span class="text">${esc(i.text)}</span></div>`).join('')}</div>
        <div class="att-actions"><button class="btn btn-primary" type="button" data-open-restaurant="${esc(r.code)}">Open restaurant</button>${r.phone ? `<a class="btn btn-secondary" href="tel:${esc(String(r.phone).replace(/[^+\d]/g, ''))}">${icon('phone')}Call</a>` : ''}</div>
      </div>`;
    }).join('');
    const footer = list.length
      ? (healthy ? `<div class="healthy-line">${icon('check')}${plural(healthy, 'other restaurant')} healthy</div>` : '')
      : `<div class="healthy-line">${icon('check')}All ${plural(all.length, 'restaurant')} healthy</div>`;
    $('#attentionList').innerHTML = items + footer;
  }

  // ---------- chart ----------
  // One renderer for the Overview chart and the restaurant page chart.
  const overviewChart = {
    st: { period: 'today', hover: null, animated: false },
    ids: { sub: '#chartSub', sw: '#periodSwitch', body: '#chartBody', stats: '#chartStats' },
    analytics: () => state.analytics,
    single: false,
  };

  function renderChart(ctx, animate) {
    const a = ctx.analytics();
    segmented($(ctx.ids.sw), [{ value: 'today', label: 'Today' }, { value: 'week', label: '7 days' }], ctx.st.period, v => {
      ctx.st.period = v; ctx.st.hover = null; renderChart(ctx, true);
    });
    if (!a) {
      $(ctx.ids.sub).textContent = 'Loading…';
      $(ctx.ids.body).innerHTML = '<div class="loading-box chart-loading">Loading chart…</div>';
      $(ctx.ids.stats).innerHTML = '';
      return;
    }
    const replay = animate || !ctx.st.animated;
    ctx.st.animated = true;
    if (ctx.st.period === 'week') renderWeekChart(ctx, a, replay); else renderTodayChart(ctx, a, replay);
  }

  function hourRange(a) {
    const today = a.hourly.today, lw = a.hourly.last_week;
    let start = 10, end = 22;
    for (let h = 0; h < 24; h++) {
      if (today[h] || lw[h]) { start = Math.min(start, h); end = Math.max(end, h); }
    }
    start = Math.min(start, a.now_hour);
    end = Math.max(end, a.now_hour);
    if (end - start < 6) end = Math.min(23, start + 6);
    return { start, end, n: end - start + 1 };
  }

  const statStrip = (rows) => rows.map(([l, v]) => `<div><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div></div>`).join('');

  function renderTodayChart(ctx, a, replay) {
    const { start, end, n } = hourRange(a);
    const today = a.hourly.today.slice(start, a.now_hour + 1);
    const lw = a.hourly.last_week.slice(start, end + 1);
    const showLast = lw.some(Boolean);
    const max = Math.max(4, ...today, ...(showLast ? lw : []));
    const stepY = Math.ceil(max / 4);
    const maxV = stepY * 4;
    const CW = 720, top = 10, base = 190;
    const X = i => (n === 1 ? 0 : i * CW / (n - 1));
    const Y = v => base - (v / maxV) * (base - top);
    const pct = y => `${(y / 200 * 100).toFixed(2)}%`;
    const step = 100 / (n - 1);
    const tPts = today.map((v, i) => [X(i), Y(v)]);
    const todayLine = smoothPath(tPts, top, base);
    const todayArea = tPts.length ? `${todayLine} L${X(tPts.length - 1).toFixed(1)} ${base} L0 ${base} Z` : '';
    const lastLine = showLast ? smoothPath(lw.map((v, i) => [X(i), Y(v)]), top, base) : '';
    const nowLeft = ((a.now_hour - start) + a.now_minute / 60) * step;
    const last = tPts[tPts.length - 1];
    const body = $(ctx.ids.body);

    $(ctx.ids.sub).textContent = showLast ? `Per hour · today vs ${a.last_week_label}${a.last_week_complete ? '' : ' (partial)'}` : 'Per hour · today';
    body.innerHTML = `
      <div class="chart-legend"><span class="legend-item"><span class="line-sw"></span>Today</span>${showLast ? `<span class="legend-item"><span class="dash-sw"></span>${esc(a.last_week_label)}</span>` : ''}</div>
      <div class="chart-area">
        ${[4, 3, 2, 1, 0].map(g => `<div class="chart-grid-line" style="top:${pct(Y(g * stepY))}"></div><span class="chart-y" style="top:${pct(Y(g * stepY))}">${g * stepY}</span>`).join('')}
        <div class="chart-now" style="left:${Math.min(100, nowLeft).toFixed(2)}%"><span>now</span></div>
        <svg class="chart-svg anim-reveal ${replay ? 'replay' : ''}" viewBox="0 0 720 200" preserveAspectRatio="none" role="img" aria-label="Orders per hour today${showLast ? ' compared with ' + esc(a.last_week_label) : ''}">
          ${showLast ? `<path class="${replay ? 'replay-fade' : ''}" d="${lastLine}" fill="none" stroke="#a4aab5" stroke-width="2" stroke-dasharray="5 5" vector-effect="non-scaling-stroke"></path>` : ''}
          <path class="${replay ? 'replay-fade' : ''}" d="${todayArea}" fill="var(--accent)" fill-opacity=".09"></path>
          <path d="${todayLine}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
        </svg>
        ${last ? `<span class="chart-end status-dot accent live" style="left:${(X(tPts.length - 1) / CW * 100).toFixed(2)}%;top:${pct(last[1])}"></span>` : ''}
        <div class="chart-hit" style="left:${(-step / 2).toFixed(3)}%;width:${(100 + step).toFixed(3)}%">
          ${Array.from({ length: n }, (_, i) => `<button type="button" data-hour="${i}" aria-label="${start + i}:00, today ${i < today.length ? today[i] : 'no data yet'}${showLast ? ', ' + esc(a.last_week_label) + ' ' + lw[i] : ''}"></button>`).join('')}
        </div>
        <div class="chart-tip-layer"></div>
      </div>
      <div class="chart-x">${Array.from({ length: n }, (_, i) => i).filter(i => n <= 9 || i % 2 === 0 || i === n - 1).map(i => `<span style="left:${(i * step).toFixed(3)}%">${start + i}:00</span>`).join('')}</div>
      ${!a.last_week_complete ? `<div class="chart-note">${icon('clock')}History is being collected since ${esc(fmtDateTime(a.history_since))}. Full comparison with last week from ${esc(comparisonStart(a))}.</div>` : ''}`;

    const hit = $('.chart-hit', body);
    const tipLayer = $('.chart-tip-layer', body);
    const renderTip = () => {
      const h = ctx.st.hover;
      if (h === null || h === undefined) { tipLayer.innerHTML = ''; return; }
      const hasToday = h < today.length;
      const left = h * step;
      const right = left > 62;
      tipLayer.innerHTML = `
        <div class="chart-guide" style="left:${left.toFixed(3)}%"></div>
        ${showLast ? `<span class="chart-dot ghost" style="left:${left.toFixed(3)}%;top:${pct(Y(lw[h]))}"></span>` : ''}
        ${hasToday ? `<span class="chart-dot" style="left:${left.toFixed(3)}%;top:${pct(Y(today[h]))}"></span>` : ''}
        <div class="chart-tip" style="left:${left.toFixed(3)}%;transform:translateX(${right ? 'calc(-100% - 12px)' : '12px'})">
          <strong>${start + h}:00 – ${start + h + 1}:00</strong>
          <div><span>Today</span><b class="num">${hasToday ? plural(today[h], 'order') : '—'}</b></div>
          ${hasToday ? `<div><span>Revenue</span><b class="num">${esc(money(a.hourly.today_revenue[start + h]))}</b></div>` : ''}
          ${showLast ? `<div><span>${esc(a.last_week_label)}</span><b class="num">${plural(lw[h], 'order')}</b></div>` : ''}
        </div>`;
    };
    const pick = e => { const b = e.target.closest('button[data-hour]'); if (!b) return; ctx.st.hover = Number(b.dataset.hour); renderTip(); };
    hit.addEventListener('mouseover', pick);
    hit.addEventListener('focusin', pick);
    hit.addEventListener('mouseleave', () => { ctx.st.hover = null; renderTip(); });
    hit.addEventListener('focusout', () => { ctx.st.hover = null; renderTip(); });
    renderTip();

    const peakIdx = today.reduce((best, v, i) => (v > today[best] ? i : best), 0);
    const peak = ['Peak hour', today.length && today[peakIdx] ? `${start + peakIdx}:00 · ${plural(today[peakIdx], 'order')}` : '—'];
    const rejected = ['Rejected / cancelled today', `${a.today_totals.rejected}${a.today_totals.rejected ? ' · ' + money(a.today_totals.rejected_revenue) : ''}`];
    let middle;
    if (ctx.single) {
      middle = ['Revenue today', money(a.today_totals.revenue)];
    } else {
      const busiest = (a.restaurants || []).slice().sort((x, y) => y.orders - x.orders)[0];
      middle = ['Busiest restaurant', busiest && busiest.orders ? `${restaurantName(busiest.code)} · ${busiest.orders}` : '—'];
    }
    $(ctx.ids.stats).innerHTML = statStrip([peak, middle, rejected]);
  }

  function renderWeekChart(ctx, a, replay) {
    const days = a.daily || [];
    const max = Math.max(1, ...days.map(d => d.orders));
    const anyPartial = days.some((d, i) => !d.complete && i < days.length - 1);
    $(ctx.ids.sub).textContent = 'Per day · last 7 days';
    $(ctx.ids.body).innerHTML = `
      <div class="chart-legend"><span class="legend-item"><span class="box-sw"></span>Orders per day</span><span class="legend-item"><span class="box-sw soft"></span>Today so far</span></div>
      <div class="week-bars">${days.map((d, i) => {
        const isToday = i === days.length - 1;
        const cls = isToday ? 'today' : (!d.complete ? 'partial' : '');
        return `<div class="week-col" title="${esc(d.label)} · ${plural(d.orders, 'order')} · ${esc(money(d.revenue))}${!d.complete && !isToday ? ' · partial history' : ''}"><span class="v ${replay ? 'replay-fade' : ''}">${d.orders}</span><span class="bar ${cls} ${replay ? 'replay-bar' : ''}" style="height:${(d.orders / max * 86).toFixed(1)}%;--d:${i * 70}ms"></span></div>`;
      }).join('')}</div>
      <div class="week-labels">${days.map((d, i) => `<span class="${i === days.length - 1 ? 'today' : ''}">${esc(d.label)}</span>`).join('')}</div>
      ${anyPartial ? `<div class="chart-note">${icon('clock')}Striped days are partial: history is collected since ${esc(fmtDateTime(a.history_since))}.</div>` : ''}`;
    const complete = days.slice(0, -1).filter(d => d.complete);
    const best = days.slice().sort((x, y) => y.orders - x.orders)[0];
    const total = days.reduce((sum, d) => sum + d.orders, 0);
    const revenue = days.reduce((sum, d) => sum + d.revenue, 0);
    $(ctx.ids.stats).innerHTML = statStrip([
      ['Orders in 7 days', `${total} · ${money(revenue)}`],
      ['Best day', best && best.orders ? `${best.label} · ${plural(best.orders, 'order')}` : '—'],
      ['Avg. per full day', complete.length ? `${Math.round(complete.reduce((s, d) => s + d.orders, 0) / complete.length)} orders` : 'Collecting…'],
    ]);
  }

  // ---------- share + mix ----------
  const SHADES = ['var(--accent)', 'var(--accent-2)', 'var(--accent-3)', 'var(--accent-4)'];
  function renderShareAndMix() {
    const a = state.analytics;
    const source = a ? a.restaurants.map(r => ({ code: r.code, revenue: r.revenue, orders: r.orders }))
      : restaurantsList().map(r => ({ code: r.code, revenue: r.revenue_today || 0, orders: r.orders_today || 0 }));
    const total = source.reduce((s, r) => s + r.revenue, 0);
    const max = Math.max(0, ...source.map(r => r.revenue));
    const sorted = source.slice().sort((x, y) => y.revenue - x.revenue);
    $('#revenueShare').innerHTML = total > 0 ? sorted.map((r, i) => `
      <div class="share-row">
        <div class="top"><span>${esc(restaurantName(r.code))}</span><span class="num"><strong>${esc(money(r.revenue))}</strong> <span class="muted-sm">· ${Math.round(r.revenue / total * 100)}%</span></span></div>
        <div class="track"><div class="anim-width" style="width:${(r.revenue / max * 100).toFixed(1)}%;background:${SHADES[Math.min(i, SHADES.length - 1)]};--d:${500 + i * 90}ms"></div></div>
      </div>`).join('') : '<div class="empty-box">No revenue yet today.</div>';

    if (!a) { $('#orderMix').innerHTML = '<div class="empty-box">Loading…</div>'; return; }
    const F = { delivery: 'Delivery', pickup: 'Pickup', dine_in: 'Dine-in', unknown: 'Unknown' };
    const groups = [
      { title: 'Fulfilment', data: Object.entries(a.mix.fulfillment || {}).map(([key, v]) => [F[key] || key, v]) },
      { title: 'Payment', data: Object.entries(a.mix.payment || {}) },
    ];
    const anyOrders = groups[0].data.some(([, v]) => v > 0);
    $('#orderMix').innerHTML = anyOrders ? groups.map((g, gi) => {
      const sum = g.data.reduce((s, [, v]) => s + v, 0) || 1;
      const parts = g.data.sort((x, y) => y[1] - x[1]);
      return `<div class="mix-block">
        <div class="mix-title">${esc(g.title)}</div>
        <div class="stack-bar" aria-hidden="true">${parts.map(([, v], i) => `<span class="anim-width" style="width:${(v / sum * 100).toFixed(1)}%;background:${SHADES[Math.min(i, SHADES.length - 1)]};--d:${600 + gi * 150 + i * 80}ms"></span>`).join('')}</div>
        <div class="mix-legend">${parts.map(([label, v], i) => `<span><span class="legend-sw" style="background:${SHADES[Math.min(i, SHADES.length - 1)]}"></span>${esc(label)} <strong>${v}</strong></span>`).join('')}</div>
      </div>`;
    }).join('') : '<div class="empty-box">No orders yet today.</div>';
  }

  // ---------- orders ----------
  const ORDER_STATUS = {
    pending: ['Pending', 'amber'], processing: ['Processing', 'blue'], 'on-hold': ['On hold', 'amber'],
    completed: ['Completed', 'green'], cancelled: ['Cancelled', 'red'], canceled: ['Cancelled', 'red'],
    refunded: ['Refunded', 'grey'], failed: ['Failed', 'red'], delivered: ['Delivered', 'green'],
  };
  // Most advanced state wins. The stored WooCommerce status is only updated when
  // WordPress reports a change, so app actions (accept / deliver / reject) are
  // read from the backend's own records as well.
  function orderStatus(o) {
    const s = String(o.status || '').toLowerCase().replace(/^wc-/, '');
    if (o.rejected) return { label: 'Rejected', cls: 'red', group: 'void' };
    if (['cancelled', 'canceled', 'refunded', 'failed'].includes(s)) return { label: ORDER_STATUS[s][0], cls: ORDER_STATUS[s][1], group: 'void' };
    if (o.app_delivered) return { label: String(o.fulfillment_type || '').toLowerCase() === 'delivery' ? 'Delivered' : 'Picked up', cls: 'green', group: 'done' };
    if (s === 'delivered') return { label: 'Delivered', cls: 'green', group: 'done' };
    // FoodUp Ordering sets WooCommerce to "Completed" the moment the restaurant
    // accepts, so Completed and the app's own accept record both mean Accepted.
    if (o.app_accepted || s === 'completed') return { label: 'Accepted', cls: 'blue', group: 'accepted' };
    if (s === 'processing') return { label: 'New', cls: 'amber', group: 'new' };
    if (s === 'pending') return { label: 'Awaiting payment', cls: 'amber', group: 'new' };
    const [label, cls] = ORDER_STATUS[s] || [s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ') : '—', 'grey'];
    return { label, cls, group: 'new' };
  }
  function fulfillment(o) {
    const f = String(o.fulfillment_type || '').toLowerCase();
    if (f === 'delivery') return ['Delivery', 'bike'];
    if (f === 'pickup') return ['Pickup', 'bag'];
    if (f === 'dine_in') return ['Dine-in', 'table'];
    const m = o.shipping?.method || o.shipping_method || '';
    return [m || '—', 'bag'];
  }
  function filteredOrders() {
    const code = $('#ordersRestaurantFilter')?.value || 'all';
    return state.orders.filter(o => code === 'all' || state.view !== 'orders' || o.restaurant_code === code);
  }
  function orderRows(list, isOverview, single = false) {
    // The restaurant page has a narrower column, so it uses 5 columns:
    // the time sits under the order number and the payment under the type.
    const head = single
      ? '<div class="gt-head"><span>Order</span><span>Customer</span><span>Type</span><span>Status</span><span class="right">Total</span></div>'
      : '<div class="gt-head"><span>Order</span><span>Restaurant</span><span>Customer</span><span>Type</span><span>Payment</span><span>Status</span><span class="right">Total</span><span class="right">Time</span></div>';
    if (!list.length) return head + '<div class="empty-box">No orders found.</div>';
    return head + list.map((o, i) => {
      const st = orderStatus(o);
      const [type, typeIcon] = fulfillment(o);
      const fresh = isOverview && i === 0 && state.firstPaint;
      if (single) {
        return `<button class="gt-row o-row" type="button" data-open-order="${esc(o.restaurant_code)}|${esc(o.order_id)}">
        <span class="cell-stack c-id"><span class="strong num">#${esc(o.order_id)}</span><span class="s">${esc(fmtAgo(orderDate(o)))}</span></span>
        <span class="cell-stack c-cust"><span class="strong">${esc(o.customer_name || '—')}</span>${o.customer_phone ? `<span class="s">${esc(o.customer_phone)}</span>` : ''}</span>
        <span class="cell-stack c-type"><span class="with-icon">${icon(typeIcon)}${esc(type)}</span><span class="s">${esc(o.payment_method || '—')}</span></span>
        <span class="c-status"><span class="pill ${st.cls}">${esc(st.label)}</span></span>
        <span class="right strong num c-total">${esc(money(o.total, o.currency))}</span>
      </button>`;
      }
      return `<button class="gt-row o-row ${fresh ? 'new' : ''}" type="button" data-open-order="${esc(o.restaurant_code)}|${esc(o.order_id)}">
        <span class="strong num c-id">#${esc(o.order_id)}</span>
        ${single ? '' : `<span class="c-rest">${esc(o.restaurant_name)}</span>`}
        <span class="cell-stack c-cust"><span class="strong">${esc(o.customer_name || '—')}</span>${o.customer_phone ? `<span class="s">${esc(o.customer_phone)}</span>` : ''}</span>
        <span class="with-icon c-type">${icon(typeIcon)}${esc(type)}</span>
        <span class="c-pay">${esc(o.payment_method || '—')}</span>
        <span class="c-status"><span class="pill ${st.cls}">${esc(st.label)}</span></span>
        <span class="right strong num c-total">${esc(money(o.total, o.currency))}</span>
        <span class="right muted-sm c-time">${esc(fmtAgo(orderDate(o)))}</span>
      </button>`;
    }).join('');
  }

  function populateRestaurantFilter() {
    const select = $('#ordersRestaurantFilter');
    const current = select.value;
    select.innerHTML = '<option value="all">All restaurants</option>' + restaurantsList().slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).map(r => `<option value="${esc(r.code)}">${esc(r.name)}</option>`).join('');
    if ([...select.options].some(o => o.value === current)) select.value = current;
  }

  function renderOrders() {
    const code = $('#ordersRestaurantFilter').value || 'all';
    let list = state.orders.filter(o => code === 'all' || o.restaurant_code === code);
    if (state.search) list = list.filter(o => matchesSearch(`${o.order_id} ${o.restaurant_name} ${o.customer_name} ${o.customer_phone} ${o.status} ${o.payment_method}`));
    const counts = { all: list.length, new: 0, accepted: 0, done: 0, void: 0 };
    list.forEach(o => { counts[orderStatus(o).group] += 1; });
    segmented($('#orderStatusFilter'), [
      { value: 'all', label: 'All', count: counts.all },
      { value: 'new', label: 'New', count: counts.new },
      { value: 'accepted', label: 'Accepted', count: counts.accepted },
      { value: 'done', label: 'Delivered', count: counts.done },
      { value: 'void', label: 'Rejected & cancelled', count: counts.void },
    ], state.orderStatus, v => { state.orderStatus = v; renderOrders(); });
    if (state.orderStatus !== 'all') list = list.filter(o => orderStatus(o).group === state.orderStatus);
    $('#ordersCount').textContent = `${list.length} shown`;
    $('#ordersTable').innerHTML = orderRows(list, false);
    bindOpeners($('#ordersTable'));
  }

  // ---------- restaurants view ----------
  const MODULE_SHORT = { website_ordering: 'Web', orders_app: 'Orders', courier: 'Courier', customer_app: 'App', online_payments: 'Pay', auto_handling: 'Auto', printing: 'Print' };
  function renderRestaurants() {
    if (!state.overview) return;
    const all = restaurantsList();
    segmented($('#restaurantFilter'), [
      { value: 'all', label: 'All', count: all.length },
      { value: 'online', label: 'Online', count: all.filter(r => r.app_status === 'online').length },
      { value: 'attention', label: 'Needs attention', count: all.filter(r => (r.attention || []).length).length },
    ], state.restaurantFilter, v => { state.restaurantFilter = v; renderRestaurants(); });
    let list = all.filter(restaurantFilterFn(state.restaurantFilter)).filter(r => matchesSearch(`${r.name} ${r.code} ${r.website} ${(r.attention || []).join(' ')}`));
    list.sort((a, b) => {
      if (state.restaurantSort === 'name') return String(a.name).localeCompare(String(b.name));
      if (state.restaurantSort === 'orders') return (b.orders_today || 0) - (a.orders_today || 0);
      if (state.restaurantSort === 'revenue') return (b.revenue_today || 0) - (a.revenue_today || 0);
      return byAttention(a, b);
    });
    $('#restaurantsTable').innerHTML = restaurantHead(true) + (list.length ? list.map(r => restaurantRow(r, true)).join('') : '<div class="empty-box">No restaurants match your filters.</div>');
    bindOpeners($('#restaurantsTable'));
  }

  // ---------- health ----------
  function renderHealth() {
    if (!state.overview) return;
    const all = restaurantsList();
    const s = state.overview.summary || {};
    const services = state.overview.services || {};
    const sites = all.filter(r => r.website_health?.status);
    const down = sites.filter(r => r.website_health.status === 'down').length;
    const upSites = sites.filter(r => r.website_health.status !== 'down');
    const avgMs = upSites.length ? Math.round(upSites.reduce((sum, r) => sum + Number(r.website_health.response_ms || 0), 0) / upSites.length) : null;
    const tiles = [
      { label: 'Critical issues', value: s.critical || 0, note: s.critical ? 'Needs action now' : 'None', chip: s.critical ? 'red' : 'green', ic: s.critical ? 'alert' : 'check' },
      { label: 'Warnings', value: s.warnings || 0, note: s.warnings ? 'Check when possible' : 'None', chip: s.warnings ? 'amber' : 'green', ic: s.warnings ? 'alert' : 'check' },
      { label: 'Orders App online', value: `${s.online || 0}<small> / ${s.restaurants || 0}</small>`, note: `${s.idle || 0} idle · ${s.offline || 0} offline`, chip: s.offline ? 'red' : 'green', ic: 'device', raw: true },
      { label: 'Websites up', value: `${sites.length - down}<small> / ${sites.length}</small>`, note: avgMs != null ? `avg. response ${avgMs} ms` : 'No checks yet', chip: down ? 'red' : 'green', ic: 'globe', raw: true },
      { label: 'Failed callbacks', value: services.callbacks_failed || 0, note: services.callbacks_failed ? 'Retry in the restaurant panel' : 'Delivered status synced', chip: services.callbacks_failed ? 'amber' : 'green', ic: 'plug' },
    ];
    $('#healthSummary').innerHTML = tiles.map(t => `<div class="kpi"><div class="kpi-top"><span class="kpi-label">${esc(t.label)}</span><span class="icon-chip ${t.chip}">${icon(t.ic)}</span></div><div class="kpi-value">${t.raw ? t.value : esc(t.value)}</div><div class="kpi-note">${esc(t.note)}</div></div>`).join('');

    const list = all.filter(r => matchesSearch(`${r.name} ${r.code} ${(r.attention || []).join(' ')}`)).sort(byAttention);
    $('#healthTable').innerHTML = '<div class="gt-head"><span>Restaurant</span><span>Orders App · 60 min</span><span>Website</span><span class="center">Devices</span><span>Printer</span><span>Last order</span></div>' + list.map(r => {
      const wh = r.website_health;
      const web = wh ? `<span class="cell-stack"><span class="pill ${wh.status === 'down' ? 'red' : 'green'}">${wh.status === 'down' ? 'Down' : 'Up'}${wh.status !== 'down' && wh.response_ms != null ? ' · ' + esc(wh.response_ms) + ' ms' : ''}</span><span class="s">${wh.error ? esc(wh.error) + ' · ' : ''}checked ${esc(fmtAgo(wh.checked_at))}</span></span>` : `<span class="muted-sm">${r.website ? 'Not checked yet' : 'No website'}</span>`;
      return `<button class="gt-row h-row" type="button" data-open-restaurant="${esc(r.code)}">
        <span class="cell-main c-main"><span class="avatar ${(r.attention || []).length ? 'bad' : ''}" aria-hidden="true">${esc(initials(r.name))}</span><span style="min-width:0"><span class="t">${esc(r.name)}</span><span class="s"><span class="status-dot ${esc(r.app_status)}"></span> ${esc(statusLabel(r.app_status))}${r.app_minutes_ago != null ? ' · ' + esc(r.app_minutes_ago) + ' min' : ''}</span></span></span>
        <span class="c-beats">${beatsHtml(r.beats)}</span>
        <span class="c-web">${web}</span>
        <span class="center num c-dev ${r.device_count ? '' : 'printer-missing'}" data-unit="${(r.device_count || 0) === 1 ? 'device' : 'devices'}">${esc(r.device_count || 0)}</span>
        <span class="with-icon c-printer ${r.printer_device_id ? '' : 'printer-missing'}">${icon('printer')}${r.printer_device_id ? 'Assigned' : 'Not assigned'}</span>
        <span class="muted-sm c-last">${esc(r.last_order_at ? fmtAgo(r.last_order_at) : 'No orders')}</span>
      </button>`;
    }).join('');

    const issues = [];
    all.forEach(r => (r.attention_items || []).forEach(i => issues.push({ ...i, code: r.code, name: r.name })));
    issues.sort((x, y) => (x.severity === 'critical' ? 0 : 1) - (y.severity === 'critical' ? 0 : 1) || String(x.name).localeCompare(String(y.name)));
    const shown = issues.filter(i => matchesSearch(`${i.name} ${i.code} ${i.text}`));
    $('#healthIssues').innerHTML = shown.length
      ? `<div class="issue-list" style="padding:14px 16px;margin:0">${shown.map(i => `<button type="button" class="issue ${esc(i.severity)}" data-open-restaurant="${esc(i.code)}" style="border:0;text-align:left;cursor:pointer;width:100%"><span class="sev ${esc(i.severity)}">${i.severity === 'critical' ? 'CRITICAL' : 'WARNING'}</span><span class="text">${esc(i.text)}<br><span class="where">${esc(i.name)}</span></span>${icon('chevron')}</button>`).join('')}</div>`
      : `<div class="healthy-line">${icon('check')}No active platform issues</div>`;
    bindOpeners($('#view-health'));
  }

  // ---------- openers ----------
  function bindOpeners(root) {
    $$('[data-open-restaurant]', root).forEach(node => {
      if (node._bound) return;
      node._bound = true;
      node.addEventListener('click', (event) => { event.stopPropagation(); openRestaurant(node.dataset.openRestaurant); });
    });
    $$('[data-open-order]', root).forEach(node => {
      if (node._bound) return;
      node._bound = true;
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        const [code, id] = node.dataset.openOrder.split('|');
        openOrder(code, id);
      });
    });
  }

  // ---------- drawer ----------
  let lastFocus = null;
  function openDrawerShell() {
    if ($('#drawer').classList.contains('hidden')) lastFocus = document.activeElement;
    $('#drawerBackdrop').classList.remove('hidden');
    $('#drawer').classList.remove('hidden');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#drawerContent').scrollTop = 0;
    setTimeout(() => $('#drawerClose').focus(), 30);
  }
  function closeDrawer(restoreFocus = true) {
    $('#drawerBackdrop').classList.add('hidden');
    $('#drawer').classList.add('hidden');
    $('#drawer').setAttribute('aria-hidden', 'true');
    state.drawer = null;
    if (restoreFocus && lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  // ---------- restaurant page (#restaurant/<code>) ----------

  function restaurantChartCtx() {
    return {
      st: state.page.chart,
      ids: { sub: '#rpChartSub', sw: '#rpPeriodSwitch', body: '#rpChartBody', stats: '#rpChartStats' },
      analytics: () => state.page?.analytics,
      single: true,
    };
  }

  function openRestaurant(code) {
    if (!$('#drawer').classList.contains('hidden')) closeDrawer(false);
    const target = `#restaurant/${encodeURIComponent(code)}`;
    if (location.hash !== target) history.pushState(null, '', target);
    showRestaurantPage(code);
  }

  async function showRestaurantPage(code, tab = 'overview') {
    if (!state.page || state.page.code !== code) {
      state.page = { code, data: null, analytics: null, chart: { period: 'today', hover: null, animated: false }, dirty: false, lastAnalyticsAt: 0, couriers: null, wp: null, menu: null, webEdits: {}, webTab: 'style', an: null, tab: 'overview', orderFilter: 'all', orderSearch: '', setSec: 'ordering' };
      const anRoot = $('#rpAnalytics');
      if (anRoot) { anRoot.innerHTML = ''; delete anRoot.dataset.built; }
    }
    state.page.tab = RP_TAB_IDS.includes(tab) ? tab : 'overview';
    setActiveView('restaurant', 'restaurants');
    const known = restaurantsList().find(r => r.code === code);
    $('#pageTitle').textContent = state.page.data?.name || known?.name || code;
    renderPageSub();
    window.scrollTo(0, 0);
    renderRestaurantPage();
    setRpTab(state.page.tab, { replace: false });
    await loadRestaurantPage({ withAnalytics: true });
  }

  async function loadRestaurantPage({ withAnalytics = false, silent = false } = {}) {
    const page = state.page;
    if (!page) return;
    try {
      const [detail, analytics] = await Promise.all([
        api(`/admin/api/restaurants/${encodeURIComponent(page.code)}`),
        withAnalytics ? api(`/admin/api/analytics?code=${encodeURIComponent(page.code)}`).catch(() => null) : Promise.resolve(null),
      ]);
      if (state.page !== page || state.view !== 'restaurant') return;
      page.data = detail.restaurant;
      if (analytics?.analytics) { page.analytics = analytics.analytics; page.lastAnalyticsAt = Date.now(); }
      // Never overwrite a form the admin is typing in.
      renderRestaurantPage({ skipSide: silent && settingsBusy() });
      if (!silent) { loadWordpress(page); loadCouriers(page); }
    } catch (error) {
      if (state.page !== page) return;
      if (!page.data) $('#rpHero').innerHTML = `<div class="rp-loading">${esc(error.message)}</div>`;
      else if (!silent) toast(error.message, 'error');
    }
  }

  // Collapsible restaurant-page sections; the open/closed choice is remembered per browser.
  const SECTION_DEFAULT_CLOSED = ['resend', 'danger'];
  let sectionMemory = {};
  try { sectionMemory = JSON.parse(localStorage.getItem('cc_sections_v2') || '{}') || {}; } catch (_) { sectionMemory = {}; }
  const sectionOpen = (id) => (id in sectionMemory ? !!sectionMemory[id] : !SECTION_DEFAULT_CLOSED.includes(id));
  function rememberSections(root) {
    $$('details[data-sec]', root).forEach(el => {
      el.addEventListener('toggle', () => {
        sectionMemory[el.dataset.sec] = el.open;
        try { localStorage.setItem('cc_sections_v2', JSON.stringify(sectionMemory)); } catch (_) {}
        if (el.open) requestAnimationFrame(() => $$('.segmented', el).forEach(positionThumb));
      });
    });
  }
  function section(id, title, badge, body, opts = {}) {
    const foot = opts.saveId ? `<div class="d-foot">${opts.footExtra || ''}<button id="${opts.saveId}" class="btn ${opts.saveClass || 'btn-primary'}" type="button">${esc(opts.saveLabel || 'Save')}</button></div>` : '';
    return `<details class="d-section ${opts.danger ? 'danger' : ''}" data-sec="${id}" ${sectionOpen(id) ? 'open' : ''}>
      <summary class="d-head"><h3>${opts.icon ? icon(opts.icon) : ''}${esc(title)}</h3><span class="d-head-right">${badge || ''}<span class="d-chev">${icon('chevron')}</span></span></summary>
      <div class="d-body">${body}${foot}</div>
    </details>`;
  }

  const STORE_REASON = {
    open: 'Open now · within opening hours',
    outside_opening_hours: 'Outside opening hours · preorders only',
    scheduled_closure: 'Closed by a scheduled closure',
    manually_closed: 'Closed manually',
  };

  function renderRestaurantPage({ skipSide = false } = {}) {
    const page = state.page;
    if (!page) return;
    const r = page.data;
    if (!r) {
      $('#rpHero').innerHTML = '<div class="rp-loading">Loading restaurant…</div>';
      $('#rpKpis').innerHTML = '';
      $('#rpSettings').innerHTML = '';
      $('#rpOrders').innerHTML = '';
      $('#rpOrdersAll').innerHTML = '';
      $('#rpAttention').innerHTML = '';
      $('#rpOrdersSub').textContent = '';
      $('#rpMenu').innerHTML = '';
      renderRpTabs();
      renderWebsite();
      renderAnalyticsPanel();
      renderChart(restaurantChartCtx());
      return;
    }
    $('#pageTitle').textContent = r.name;
    document.title = `${r.name} · FoodUp Control Center`;
    renderHero();

    const a = page.analytics;
    const orders = a ? a.today_totals.orders : (r.orders_today || 0);
    const revenue = a ? a.today_totals.revenue : (r.revenue_today || 0);
    const rejected = a ? a.today_totals.rejected : (r.rejected_today || 0);
    const tiles = [
      ['Orders today', String(orders), rejected ? `+${rejected} rejected / cancelled` : 'Swiss calendar day', 'receipt', 'accent'],
      ['Revenue today', money(revenue), 'excl. rejected & refunded', 'trend', 'amber'],
      ['Avg. order', money(orders ? revenue / orders : 0), 'value today', 'wallet', 'blue'],
      ['Last order', r.last_order_at ? fmtAgo(r.last_order_at) : 'None yet', r.last_order_at ? fmtDateTime(r.last_order_at) : '—', 'clock', 'blue'],
      ['Devices', `${r.device_count || 0}`, r.device_count ? 'registered for push' : 'no push device', 'device', r.device_count ? 'green' : 'red'],
      ['Printer', r.printer_device_id ? 'Assigned' : 'Missing', r.printer_device_id ? `device ${String(r.printer_device_id).slice(0, 8)}…` : 'no printer assigned', 'printer', r.printer_device_id ? 'green' : 'red'],
    ];
    $('#rpKpis').innerHTML = tiles.map(([label, value, note, ic, chip]) => `<div class="kpi"><div class="kpi-top"><span class="kpi-label">${esc(label)}</span><span class="icon-chip ${chip}">${icon(ic)}</span></div><div class="kpi-value">${esc(value)}</div><div class="kpi-note">${esc(note)}</div></div>`).join('');

    if (page.tab === 'overview') renderChart(restaurantChartCtx());

    const list = rpOrderList();
    $('#rpOrdersSub').textContent = list.length ? `${Math.min(5, list.length)} of ${list.length} stored orders` : '';
    $('#rpOrders').innerHTML = orderRows(list.slice(0, 5), false, true);
    bindOpeners($('#rpOrders'));
    $('#rpAllOrders').onclick = () => setRpTab('orders');
    renderRpAttention(r);
    renderRpTabs();
    if (page.tab === 'orders') renderRpOrders();

    if (!skipSide) renderRestaurantSide(r);
    if (page.tab === 'menu') renderMenu();
    if (page.tab === 'website') renderWebsite();
    if (page.tab === 'analytics') renderAnalyticsPanel();
  }

  function renderHero() {
    const page = state.page;
    const r = page?.data;
    if (!r) return;
    const bad = (r.attention_items || []).length > 0;
    const websiteUrl = r.website ? (/^https?:/.test(r.website) ? r.website : `https://${r.website}`) : '';
    const tel = r.phone ? `tel:${String(r.phone).replace(/[^+\d]/g, '')}` : '';
    const since = r.app_minutes_ago != null ? (r.app_minutes_ago < 1 ? 'last seen just now' : `last seen ${r.app_minutes_ago} min ago`) : 'no heartbeat yet';
    const storeOpen = r.store_status !== 'closed';
    const availability = page.wp?.data?.availability;
    let storeNote = storeOpen ? 'Customers can order' : 'Closed for customers until you open again';
    if (availability) {
      storeNote = STORE_REASON[availability.reason] || storeNote;
      if (availability.reason === 'scheduled_closure' && availability.active_closure) {
        storeNote = `Closed${availability.active_closure.reason ? ': ' + availability.active_closure.reason : ''} until ${dayLabel(availability.active_closure.end)}`;
      }
    }

    $('#rpHero').innerHTML = `
      <div class="who">
        <span class="avatar lg ${bad ? 'bad' : ''}" aria-hidden="true">${esc(initials(r.name))}</span>
        <div style="min-width:0">
          <div class="line"><span class="pill ${esc(r.app_status)}"><span class="status-dot ${esc(r.app_status)} live"></span>Orders App ${esc(statusLabel(r.app_status).toLowerCase())}</span><span>${esc(since)}</span><span class="tag ${r.edition === 'free' ? 'free' : 'pro'}">${r.edition === 'free' ? 'FoodUp Free' : 'FoodUp Pro'}</span></div>
          <div class="line">
            <span class="with-icon">${icon('store')}${esc(r.code)}</span>
            ${websiteUrl ? `<a class="with-icon" href="${esc(websiteUrl)}" target="_blank" rel="noopener">${icon('globe')}${esc(r.website)}</a>` : ''}
            ${r.phone ? `<span class="with-icon">${icon('phone')}${esc(r.phone)}</span>` : ''}
            ${r.address ? `<span class="with-icon">${icon('pin')}${esc(r.address)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="store-box">
        <div class="mix-title">Online ordering</div>
        <div id="rpStore" class="segmented store-switch ${storeOpen ? 'is-open' : 'is-closed'}" role="tablist" aria-label="Online ordering"></div>
        <div class="store-note">${esc(storeNote)}</div>
      </div>
      <div class="beat-box"><div class="mix-title">Orders App · last 60 minutes</div>${beatsHtml(r.beats)}</div>
      <div class="hero-actions">
        ${tel ? `<a class="btn btn-secondary" href="${esc(tel)}">${icon('phone')}Call</a>` : ''}
        ${websiteUrl ? `<a class="btn btn-secondary" href="${esc(websiteUrl)}" target="_blank" rel="noopener">${icon('external')}Website</a>` : ''}
      </div>`;

    const storeEl = $('#rpStore');
    segmented(storeEl, [{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }], storeOpen ? 'open' : 'closed', (value) => {
      const revert = () => selectSegment(storeEl, storeOpen ? 'open' : 'closed');
      const apply = async () => {
        try {
          const data = await api(`/admin/api/restaurants/${encodeURIComponent(r.code)}`, { method: 'PATCH', body: JSON.stringify({ store_open: value === 'open' }) });
          if (state.page !== page) return;
          page.data = data.restaurant;
          toast(value === 'open' ? `${r.name} is open for orders` : `${r.name} is closed for orders`);
          renderHero();
          setTimeout(() => { if (state.page === page) loadWordpress(page); }, 4000);
        } catch (error) {
          toast(error.message, 'error');
          revert();
        }
      };
      if (value === 'closed') {
        choiceModal('Close online ordering?', `Customers can no longer order from ${r.name} until you open again. The website updates within about 30 seconds.`, 'Close ordering', 'btn-danger', apply, revert);
      } else {
        apply();
      }
    });
    requestAnimationFrame(() => positionThumb(storeEl));
  }

  function choiceModal(title, message, label, cls, onConfirm, onCancel) {
    let done = false;
    openModal(title, `<p>${esc(message)}</p><div class="modal-actions"><button id="cancelModal" class="btn btn-secondary" type="button">Cancel</button><button id="confirmModal" class="btn ${cls}" type="button">${esc(label)}</button></div>`);
    modalCloseHook = () => { if (!done) { done = true; onCancel?.(); } };
    $('#cancelModal').onclick = closeModal;
    $('#confirmModal').onclick = async () => {
      done = true;
      closeModal();
      await onConfirm();
    };
    setTimeout(() => $('#cancelModal')?.focus(), 20);
  }

  function renderRestaurantSide(r) {
    const page = state.page;
    const email = r.customer_email_settings || {};
    const failed = Array.isArray(r.failed_delivered_callbacks) ? r.failed_delivered_callbacks : [];
    const couriers = page.couriers;
    const courierRows = !couriers
      ? '<div class="muted-sm">Loading couriers…</div>'
      : couriers.length
        ? `<div class="mini-list">${couriers.map(c => `<div class="mini-row courier-row"><span class="cell-main" style="gap:10px"><span class="avatar sm" aria-hidden="true">${esc(initials(c.username))}</span><span><strong>${esc(c.username)}</strong><span class="s">${c.phone ? esc(c.phone) : 'no phone'}${c.created_at ? ' · since ' + esc(dayLabel(String(c.created_at).slice(0, 10))) : ''}</span></span></span><span class="row-actions"><button class="icon-button sm" type="button" data-courier-phone="${esc(c.key)}" aria-label="Edit phone of ${esc(c.username)}" title="Edit phone">${icon('phone')}</button><button class="icon-button sm" type="button" data-courier-password="${esc(c.key)}" aria-label="New password for ${esc(c.username)}" title="New password">${icon('key')}</button><button class="icon-button sm danger" type="button" data-courier-delete="${esc(c.key)}" aria-label="Remove ${esc(c.username)}" title="Remove">${icon('trash')}</button></span></div>`).join('')}</div>`
        : '<div class="muted-sm">No courier accounts yet.</div>';

    const couriersHtml = section('couriers', 'Couriers', `<span class="pill grey">${couriers ? couriers.length : '…'}</span>`, `${courierRows}
        <div class="add-row">
          <div class="mix-title" style="margin:14px 0 8px">Add courier</div>
          <div class="edit-grid">
            <div class="field"><label for="cNewName">Username</label><input id="cNewName" autocomplete="off" placeholder="Aziz"></div>
            <div class="field"><label for="cNewPass">Password</label><input id="cNewPass" type="password" autocomplete="new-password" placeholder="At least 4 characters"></div>
            <div class="field"><label for="cNewPhone">Phone</label><input id="cNewPhone" type="tel" placeholder="+41 79 000 00 00"></div>
          </div>
        </div>
        <p class="d-note">The same accounts the FoodUp Courier app logs in with. Passwords are never shown.</p>`, { saveId: 'cAddBtn', saveLabel: 'Add courier', icon: 'user' });
    const securityHtml = section('security', 'PINs & devices', `<span class="pill ${r.ios_pin_set ? 'green' : 'amber'}">iOS PIN ${r.ios_pin_set ? 'set' : 'not set'}</span>`, `
        <div class="mini-list">
          <div class="mini-row"><span><strong>Owner PIN</strong><span class="s">Android owner login and app settings · never shown</span></span><button id="resetPinBtn" class="btn btn-secondary" type="button">${icon('key')}Set new</button></div>
          <div class="mini-row"><span><strong>iOS PIN</strong><span class="s">${r.ios_pin_set ? 'Set · never shown' : 'Not set yet'}</span></span><button id="iosPinBtn" class="btn btn-secondary" type="button">${icon('key')}Set new</button></div>
          <div class="mini-row"><span><strong>Orders App devices</strong><span class="s">${plural(r.device_count || 0, 'device')} registered for push</span></span><button id="resetDevicesBtn" class="btn btn-secondary" type="button">${icon('device')}Reset</button></div>
          <div class="mini-row"><span><strong>Printer</strong><span class="s">${r.printer_device_id ? 'Device ' + esc(String(r.printer_device_id).slice(0, 12)) + '…' : 'Not assigned'}</span></span><button id="resetPrinterBtn" class="btn btn-secondary" type="button">${icon('printer')}Clear</button></div>
        </div>`, { icon: 'lock' });
    const profileHtml = section('profile', 'Connection profile', '', `<div class="edit-grid">
        <div class="field"><label for="editName">Name</label><input id="editName" value="${esc(r.name)}"></div>
        <div class="field"><label for="editWebsite">Website</label><input id="editWebsite" value="${esc(r.website)}" placeholder="restaurant.ch"></div>
        <div class="field"><label for="editPhone">Phone</label><input id="editPhone" value="${esc(r.phone)}" placeholder="+41 44 000 00 00"></div>
        <div class="field"><label for="editAddress">Address</label><input id="editAddress" value="${esc(r.address)}" placeholder="Street 1, 8000 Zürich"></div>
      </div><p class="d-note">Stored in the FoodUp backend. The website here is where the backend sends order callbacks; the apps show name, phone and address.</p>`, { saveId: 'saveProfileBtn', icon: 'store' });
    const callbacksHtml = section('callbacks', 'Failed delivered callbacks', `<span class="pill ${failed.length ? 'amber' : 'green'}">${failed.length}</span>`, `
        ${failed.length ? `<div class="mini-list">${failed.map(item => `<div class="mini-row"><span><strong>#${esc(item.order_id)}</strong><span class="s">${esc(item.reason || 'callback_failed')} · ${plural(Number(item.attempts || 0), 'attempt')} · ${esc(item.last_attempt_at ? fmtAgo(item.last_attempt_at) : 'no attempt time')}</span></span><button class="btn btn-secondary" type="button" data-retry-delivered-callback="${esc(item.order_id)}">${icon('refresh')}Retry</button></div>`).join('')}</div>` : '<div class="muted-sm">All delivered statuses reached WordPress.</div>'}
        <p class="d-note">Permanent failures and callbacks that exhaust their 24-hour retry window are kept for 30 days.</p>`, { icon: 'plug' });
    const resendHtml = section('resend', 'Customer email (Resend, legacy)', email.resend_enabled ? '<span class="pill amber">On</span>' : '<span class="pill grey">Off</span>', `
        <label class="module-toggle"><span>Allow central FoodUp email via Resend</span><span class="switch"><input id="resendEnabledToggle" type="checkbox" ${email.resend_enabled ? 'checked' : ''}><span></span></span></label>
        <p class="d-note">Restaurant emails now run through Brevo (see Email above). This switch only controls the old central Resend endpoint.</p>`, { saveId: 'saveCustomerEmailBtn', saveClass: 'btn-secondary', icon: 'mail' });
    const dangerHtml = section('danger', 'Danger zone', '', `<p class="d-note" style="margin:0 0 12px">These actions permanently change backend data for this restaurant.</p><div class="actions-row"><button id="clearOrdersBtn" class="btn btn-outline-danger" type="button">${icon('trash')}Clear order history</button><button id="removeRestaurantBtn" class="btn btn-danger" type="button">${icon('trash')}Remove restaurant</button></div>`, { danger: true, icon: 'alert' });

    const pane = (id, title, note, html) => `<div class="set-pane" data-pane="${id}" hidden><div class="set-pane-head"><h2>${esc(title)}</h2><p>${esc(note)}</p></div><div class="set-stack">${html}</div></div>`;
    $('#rpSettings').innerHTML = `${settingsNavHtml(r)}
      <div class="set-panes rp-side">
        ${pane('ordering', 'Ordering', 'When and how customers can order', '<div class="wp-host set-stack" data-wp="ordering"></div>')}
        ${pane('apps', 'Apps & staff', 'FoodUp Orders, couriers and access', `<div class="wp-host set-stack" data-wp="apps"></div>${couriersHtml}${securityHtml}`)}
        ${pane('shop', 'Shop & communication', 'What customers see and receive', `<div class="wp-host set-stack" data-wp="shop"></div>${resendHtml}`)}
        ${pane('conn', 'Connection & advanced', 'Rarely needed', `<div class="wp-host set-stack" data-wp="conn"></div>${profileHtml}${callbacksHtml}${dangerHtml}`)}
      </div>`;
    $('#rpSetNav').onclick = (event) => { const btn = event.target.closest('[data-set]'); if (btn) selectSettingsSection(btn.dataset.set); };
    state.page.dirty = false;
    rememberSections($('#rpSettings'));
    bindRestaurantActions();
    renderWordpress();
    selectSettingsSection(state.page.setSec);
  }

  async function loadCouriers(page) {
    try {
      const data = await api(`/admin/api/restaurants/${encodeURIComponent(page.code)}/couriers`);
      if (state.page !== page) return;
      page.couriers = data.couriers || [];
    } catch (_) {
      if (state.page !== page) return;
      page.couriers = page.couriers || [];
    }
    if (!page.dirty) renderRestaurantSide(page.data);
  }

  function bindRestaurantActions() {
    const page = state.page;
    const code = page.data.code;
    const name = page.data.name;
    const side = $('#rpSettings');
    side.oninput = (event) => { if (!event.target.closest('.wp-host')) page.dirty = true; };
    const patch = async (body, message) => {
      const data = await api(`/admin/api/restaurants/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify(body) });
      if (state.page !== page) return;
      page.data = data.restaurant;
      page.dirty = false;
      toast(message);
      renderRestaurantPage();
      refreshAll({ silent: true });
    };
    const busy = (btn, fn) => async () => { btn.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; } };
    const courierCall = async (method, path, body, message) => {
      const data = await api(`/admin/api/restaurants/${encodeURIComponent(code)}/couriers${path}`, { method, body: JSON.stringify(body || {}) });
      if (state.page !== page) return;
      page.couriers = data.couriers || [];
      page.dirty = false;
      toast(message);
      renderRestaurantSide(page.data);
    };

    const saveProfile = $('#saveProfileBtn');
    saveProfile.addEventListener('click', busy(saveProfile, () => patch({ name: $('#editName').value, website: $('#editWebsite').value, phone: $('#editPhone').value, address: $('#editAddress').value }, 'Restaurant profile saved')));
    const saveEmail = $('#saveCustomerEmailBtn');
    saveEmail.addEventListener('click', busy(saveEmail, () => patch({ customer_email_settings: { resend_enabled: $('#resendEnabledToggle').checked } }, 'Customer email setting updated')));
    $$('[data-retry-delivered-callback]', side).forEach(button => {
      button.addEventListener('click', busy(button, async () => {
        const orderId = button.dataset.retryDeliveredCallback;
        const data = await api(`/admin/api/restaurants/${encodeURIComponent(code)}/delivered-callbacks/${encodeURIComponent(orderId)}/retry`, { method: 'POST', body: '{}' });
        if (state.page !== page) return;
        page.data = data.restaurant;
        toast(`Delivered callback #${orderId} queued for retry`);
        renderRestaurantPage();
      }));
    });

    const addBtn = $('#cAddBtn');
    addBtn.addEventListener('click', busy(addBtn, () => courierCall('POST', '', {
      username: $('#cNewName').value.trim(), password: $('#cNewPass').value, phone: $('#cNewPhone').value.trim(),
    }, 'Courier added')));
    $$('[data-courier-phone]', side).forEach(btn => btn.addEventListener('click', () => {
      const key = btn.dataset.courierPhone;
      const current = (page.couriers || []).find(c => c.key === key);
      inputModal(`Phone for ${current?.username || key}`, 'The phone number customers and the restaurant see for this courier.', '+41 79 000 00 00', value => courierCall('PATCH', `/${encodeURIComponent(key)}`, { phone: value }, 'Courier phone updated'), 'tel', current?.phone || '');
    }));
    $$('[data-courier-password]', side).forEach(btn => btn.addEventListener('click', () => {
      const key = btn.dataset.courierPassword;
      inputModal('New courier password', 'At least 4 characters. The courier needs it for the next login.', 'New password', value => courierCall('PATCH', `/${encodeURIComponent(key)}`, { password: value }, 'Courier password changed'), 'password');
    }));
    $$('[data-courier-delete]', side).forEach(btn => btn.addEventListener('click', () => {
      const key = btn.dataset.courierDelete;
      confirmationModal('Remove courier', `Remove the courier account "${key}"? The Courier app logs this account out at its next check.`, 'Remove courier', () => courierCall('DELETE', `/${encodeURIComponent(key)}`, {}, 'Courier removed'));
    }));

    $('#resetDevicesBtn').addEventListener('click', () => confirmationModal('Reset Orders devices', `Disconnect all registered Orders App devices for ${name}? They will need to log in again.`, 'Reset devices', async () => {
      await api(`/admin/api/restaurants/${encodeURIComponent(code)}/reset-devices`, { method: 'POST', body: '{}' });
      toast('Orders devices reset'); refreshAll({ silent: true }); await loadRestaurantPage();
    }));
    $('#resetPrinterBtn').addEventListener('click', () => confirmationModal('Clear printer assignment', `Remove the assigned printer device for ${name}?`, 'Clear printer', async () => {
      await api(`/admin/api/restaurants/${encodeURIComponent(code)}/reset-printer`, { method: 'POST', body: '{}' });
      toast('Printer assignment cleared'); refreshAll({ silent: true }); await loadRestaurantPage();
    }));
    $('#resetPinBtn').addEventListener('click', () => inputModal('Set new owner PIN', 'Enter a new owner PIN (at least 4 characters). The current PIN is never shown. WordPress keeps its own copy for Save & Connect, so update it there too.', 'New owner PIN', value => patch({ owner_pin: value }, 'Owner PIN updated'), 'password'));
    $('#iosPinBtn').addEventListener('click', () => inputModal('Set new iOS PIN', 'Used by the FoodUp Orders app on iPhone/iPad (at least 4 characters, not a default PIN).', 'New iOS PIN', value => patch({ ios_pin: value }, 'iOS PIN updated'), 'password'));
    $('#clearOrdersBtn').addEventListener('click', () => typedConfirmation('Clear order history', `This permanently clears the stored FoodUp backend order history for ${name}. Type ${code} to continue.`, code, async () => {
      await api(`/admin/api/restaurants/${encodeURIComponent(code)}/orders`, { method: 'DELETE', body: JSON.stringify({ confirm: code }) });
      toast('Order history cleared'); refreshAll({ silent: true }); await loadRestaurantPage({ withAnalytics: true });
    }));
    $('#removeRestaurantBtn').addEventListener('click', () => typedConfirmation('Remove restaurant', `This permanently removes ${name} from FoodUp Control Center and deletes all backend data stored under this restaurant code. Type ${code} to confirm.`, code, async () => {
      await api(`/admin/api/restaurants/${encodeURIComponent(code)}`, { method: 'DELETE', body: JSON.stringify({ confirm: code }) });
      state.page = null;
      toast('Restaurant removed');
      switchView('restaurants');
      refreshAll({ silent: true });
    }));
  }

  // ---------- WordPress plugin settings on the restaurant page ----------
  const WP_REASON_TITLES = {
    plugin_outdated: 'FoodUp Ordering needs an update',
    unauthorized: 'WordPress refused the connection',
    secret_missing: 'Restaurant secret not set up',
    website_missing: 'No website stored',
    unreachable: 'WordPress not reachable',
    timeout: 'WordPress did not answer',
  };

  async function loadWordpress(page) {
    page.wp = { ...(page.wp || {}), loading: true };
    if (!page.wpDirty) renderWordpress();
    try {
      const data = await api(`/admin/api/restaurants/${encodeURIComponent(page.code)}/wordpress`);
      if (state.page !== page) return;
      page.wp = data.connected
        ? { loading: false, connected: true, data: data.wordpress, backend: data.backend }
        : { loading: false, connected: false, reason: data.reason, message: data.message };
    } catch (error) {
      if (state.page !== page) return;
      page.wp = { loading: false, connected: false, reason: 'error', message: error.message };
    }
    if (!page.wpDirty) renderWordpress();
    renderHero();
    renderWebsite();
    renderAnalyticsPanel();
    if (page.wp.connected && !page.menu) loadMenu(page);
    else if (!page.wp.connected) renderMenu();
  }

  function wpField(id, label, value, opts = {}) {
    return `<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" type="${opts.type || 'text'}" value="${esc(value ?? '')}" ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''} ${opts.min != null ? `min="${opts.min}" max="${opts.max}"` : ''} ${opts.inputmode ? `inputmode="${opts.inputmode}"` : ''}></div>`;
  }

  function hoursRowsHtml(days) {
    return days.map(d => `<div class="hours-row ${d.enabled ? '' : 'is-off'}" data-day="${d.day}">
      <label class="hours-day"><span class="switch"><input type="checkbox" data-h-enabled ${d.enabled ? 'checked' : ''} aria-label="${esc(d.label)} open"><span></span></span><span>${esc(d.label)}</span></label>
      <div class="hours-periods">
        ${[0, 1].map(i => `<span class="period"><input class="time-input" inputmode="numeric" maxlength="5" placeholder="--:--" data-h="s${i}" value="${esc(d.periods[i]?.start || '')}" aria-label="${esc(d.label)} period ${i + 1} from"><span class="dash">–</span><input class="time-input" inputmode="numeric" maxlength="5" placeholder="--:--" data-h="e${i}" value="${esc(d.periods[i]?.end || '')}" aria-label="${esc(d.label)} period ${i + 1} until"></span>`).join('')}
      </div>
    </div>`).join('');
  }
  // Read-only week view of the saved opening hours (08:00 – 24:00).
  function weekTimelineHtml(days) {
    const toH = (t) => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) + Number(m[2]) / 60 : null; };
    const pos = (h) => Math.max(0, Math.min(100, (h - 8) / 16 * 100));
    const rows = days.map(d => {
      const slots = d.enabled ? (d.periods || []).map(p => { const a = toH(p.start); let b = toH(p.end); if (a === null || b === null) return ''; if (b <= a) b = 24; return `<span class="wk-slot" style="left:${pos(a).toFixed(2)}%;width:${(pos(b) - pos(a)).toFixed(2)}%" title="${esc(p.start)} – ${esc(p.end)}"></span>`; }).join('') : '';
      return `<span class="wk-day">${esc(String(d.label || '').slice(0, 3))}</span><span class="wk-track">${slots}${d.enabled ? '' : '<em>Closed</em>'}</span>`;
    }).join('');
    return `<div class="wk" aria-hidden="true">${rows}<span></span><span class="wk-scale"><span>08</span><span>12</span><span>16</span><span>20</span><span>24</span></span></div>`;
  }
  function closureRowHtml(c) {
    return `<div class="closure-row"><input type="date" data-c="start" value="${esc(c.start || '')}" aria-label="Closed from"><span class="dash">–</span><input type="date" data-c="end" value="${esc(c.end || '')}" aria-label="Closed until"><input data-c="reason" value="${esc(c.reason || '')}" placeholder="Reason (shown to customers)" aria-label="Reason"><button class="icon-button sm danger" type="button" data-c-remove aria-label="Remove closure">${icon('trash')}</button></div>`;
  }
  function zoneRowHtml(z) {
    return `<div class="zone-row"><input data-z="plz" value="${esc(z.plz || '')}" placeholder="PLZ" inputmode="numeric" aria-label="Postcode"><input data-z="city" value="${esc(z.city || '')}" placeholder="Place" aria-label="Place"><span class="money-input"><span>CHF</span><input data-z="min" value="${esc(z.min ?? '')}" inputmode="decimal" placeholder="0" aria-label="Minimum order"></span><button class="icon-button sm danger" type="button" data-z-remove aria-label="Remove zone">${icon('trash')}</button></div>`;
  }

  // Puts WordPress sections into their settings panes; the rest of each pane is untouched.
  function placeWordpressSections(html, notice) {
    const hosts = {};
    $$('#rpSettings .wp-host').forEach(h => { hosts[h.dataset.wp] = h; h.innerHTML = ''; });
    const staging = document.createElement('div');
    staging.innerHTML = html;
    Array.from(staging.children).forEach(el => {
      const paneId = WP_SECTION_PANE[el.dataset.sec] || 'conn';
      if (hosts[paneId]) hosts[paneId].appendChild(el);
    });
    if (notice) Object.entries(hosts).forEach(([id, h]) => { if (id !== 'conn' && !h.children.length) h.innerHTML = `<div class="set-notice">${notice}</div>`; });
    Object.values(hosts).forEach(h => rememberSections(h));
  }

  function renderWordpress() {
    const page = state.page;
    const host = $('#rpSettings');
    if (!page || !host || !$('#rpSettings .wp-host')) return;
    renderRpTabs();
    const wp = page.wp || { loading: true };
    if (wp.loading && !wp.data) {
      placeWordpressSections(section('wp_status', 'WordPress · FoodUp Ordering', '<span class="pill grey">Connecting…</span>', '<div class="muted-sm">Reading the plugin settings from the restaurant\'s website…</div>', { icon: 'globe' }), 'Reading the settings from WordPress…');
      return;
    }
    if (!wp.connected) {
      placeWordpressSections(section('wp_status', 'WordPress · FoodUp Ordering', '<span class="pill red">Not connected</span>', `
        <div class="issue warning" style="margin:0"><span class="text"><strong>${esc(WP_REASON_TITLES[wp.reason] || 'Connection problem')}</strong><br><span class="where">${esc(wp.message || '')}</span></span></div>
        <div class="actions-row" style="margin-top:12px"><button id="wpRetryBtn" class="btn btn-secondary" type="button">${icon('refresh')}Try again</button></div>`, { icon: 'globe' }), 'WordPress is not connected. See Connection &amp; advanced.');
      $('#wpRetryBtn').addEventListener('click', () => loadWordpress(page));
      return;
    }

    const d = wp.data;
    const s = d.settings || {};
    const f = s.features || {};
    const info = d.feature_info || {};
    const oa = s.orders_app || {};
    const shop = s.shop || {};
    const ordering = s.ordering || null;
    const report = s.monthly_report || null;
    const hours = s.hours || null;
    const zones = Array.isArray(s.delivery_zones) ? s.delivery_zones : null;
    const mail = d.email || null;
    const avail = d.availability || null;
    const v2 = Number(d.bridge_version || 1) >= 2;
    const brand = (s.branding || {}).brand_color || '#FF6600';
    const backendEdition = wp.backend?.edition;
    const editionMismatch = backendEdition && backendEdition !== oa.edition;
    const featureOrder = ['website_ordering', 'orders_app', 'courier', 'online_payments', 'auto_handling', 'printing', 'marketing', 'monthly_reports', 'table_ordering', 'customer_app'];
    const featureKeys = featureOrder.filter(key => key in f).concat(Object.keys(f).filter(key => !featureOrder.includes(key)));
    const updateNote = '<div class="muted-sm">Needs FoodUp Ordering 0.5.238 or newer on this site.</div>';
    const availPill = avail ? (avail.accepting_orders ? '<span class="pill green">Open now</span>' : (avail.reason === 'outside_opening_hours' ? '<span class="pill amber">Closed now</span>' : '<span class="pill red">Closed</span>')) : '';

    placeWordpressSections(`
      ${section('wp_status', 'WordPress · FoodUp Ordering', '<span class="pill green"><span class="status-dot online"></span>Connected</span>', `
        <div class="wp-meta"><span class="with-icon">${icon('plug')}Plugin ${esc(d.plugin_version || '?')}</span><a class="with-icon" href="${esc(d.site_url || '#')}/wp-admin/" target="_blank" rel="noopener">${icon('external')}wp-admin</a>${wp.loading ? '<span class="muted-sm">refreshing…</span>' : ''}</div>
        <p class="d-note">These settings are stored in the restaurant's WordPress and saved there directly.</p>`, { icon: 'globe' })}

      ${section('hours', 'Opening hours & closures', availPill, v2 && hours ? `
        ${weekTimelineHtml(hours.days)}
        <div class="hours-list" id="wpHours">${hoursRowsHtml(hours.days)}</div>
        <div class="mix-title" style="margin:16px 0 8px">Scheduled closures</div>
        <div id="wpClosures" class="closure-list">${(hours.closures || []).map(closureRowHtml).join('')}</div>
        <button id="wpAddClosure" class="btn btn-secondary btn-sm" type="button">${icon('plus')}Add closure</button>
        <p class="d-note">Times in ${esc(hours.timezone || 'Europe/Zurich')}. Two periods per day, for example lunch and dinner. A closure closes the shop for whole days.</p>` : updateNote, v2 && hours ? { saveId: 'wpSaveHours', icon: 'clock' } : { icon: 'clock' })}

      ${section('delivery', 'Delivery & pickup', zones ? `<span class="pill grey">${plural(zones.length, 'zone')}</span>` : '', v2 && ordering && zones ? `
        <div class="field"><label>Order types</label><div id="wpOrderMode" class="segmented" role="tablist" aria-label="Order types"></div></div>
        <div class="edit-grid" style="margin-top:12px">${wpField('wpLead', 'Minimum preorder lead time (minutes)', ordering.preorder_min_lead_minutes, { type: 'number', min: 0, max: 10080, inputmode: 'numeric' })}</div>
        <div class="mix-title" style="margin:16px 0 8px">Delivery zones · minimum order</div>
        <div id="wpZones" class="zone-list">${zones.map(zoneRowHtml).join('')}</div>
        <button id="wpAddZone" class="btn btn-secondary btn-sm" type="button">${icon('plus')}Add zone</button>` : updateNote, v2 && ordering && zones ? { saveId: 'wpSaveDelivery', icon: 'bike' } : { icon: 'bike' })}

      ${section('features', 'Features', `<span class="pill grey">${featureKeys.filter(k2 => f[k2]).length}/${featureKeys.length} on</span>`, `
        <div class="module-grid">${featureKeys.map(key => `<label class="module-toggle" title="${esc(info[key]?.description || '')}"><span>${esc(info[key]?.label || key)}</span><span class="switch"><input type="checkbox" data-wp-feature="${esc(key)}" ${f[key] ? 'checked' : ''}><span></span></span></label>`).join('')}</div>
        <p class="d-note">Real plugin switches (General → Features). Website Ordering is the base module: switching it off turns every other module off.</p>`, { saveId: 'wpSaveFeatures', icon: 'dashboard' })}

      ${section('orders_app', 'Orders App', `<span class="tag ${oa.edition === 'free' ? 'free' : 'pro'}">${oa.edition === 'free' ? 'Free' : 'Pro'}</span>`, `
        <div class="field"><label>Edition</label><div id="wpEdition" class="segmented" role="tablist" aria-label="Edition"></div></div>
        ${editionMismatch ? `<p class="d-note warn-note">The apps currently run as ${backendEdition === 'free' ? 'Free' : 'Pro'}. Saving applies the edition shown here.</p>` : ''}
        <div class="field" style="margin-top:14px"><label>Automatic handling</label><div id="wpAutoAction" class="segmented" role="tablist" aria-label="Automatic handling"></div></div>
        ${f.auto_handling ? '' : '<p class="d-note warn-note">The Automatic Order Handling feature is off, so these values are stored but not used.</p>'}
        <div class="edit-grid" style="margin-top:12px">
          ${wpField('wpAutoWait', 'Wait before acting (minutes)', oa.auto_wait_minutes, { type: 'number', min: 1, max: 60, inputmode: 'numeric' })}
          ${wpField('wpAutoAccept', 'Preparation time when accepting', oa.auto_accept_time, { placeholder: '30 Minutes' })}
          ${wpField('wpAutoReject', 'Reason when rejecting', oa.auto_reject_reason, { placeholder: 'Zu beschäftigt' })}
        </div>
        <p class="d-note">Legacy app access: ${d.legacy_secret_enabled ? 'on' : 'off'} (changed in wp-admin only).</p>`, { saveId: 'wpSaveOrders', icon: 'device' })}

      ${section('shop', 'Shop details', '', `<div class="edit-grid">
        ${wpField('wpShopName', 'Restaurant name', shop.restaurant_name)}
        ${wpField('wpShopAddress', 'Address', shop.address, { placeholder: 'Street 1, 8000 Zürich' })}
        ${wpField('wpShopPhone', 'Phone', shop.contact_phone, { type: 'tel', placeholder: '+41 44 000 00 00' })}
        ${wpField('wpShopEmail', 'Email', shop.contact_email, { type: 'email', placeholder: 'info@restaurant.ch' })}
        ${wpField('wpShopVat', 'VAT number', shop.vat_number, { placeholder: 'CHE-000.000.000 MWST' })}
        ${wpField('wpShopReview', 'Google review link', shop.google_review_url, { type: 'url', placeholder: 'https://g.page/r/…' })}
      </div><p class="d-note">Shown on the website, in emails and on invoices.</p>`, { saveId: 'wpSaveShop', icon: 'store' })}

      ${section('branding', 'Branding', `<span class="brand-dot" style="background:${esc(brand)}"></span>`, `
        <div class="brand-row">
          <label class="brand-swatch" style="background:${esc(brand)}"><span class="sr-only">Pick brand colour</span><input id="wpBrandPicker" type="color" value="${esc(brand)}"></label>
          <div class="field" style="flex:1"><label for="wpBrandHex">Brand colour</label><input id="wpBrandHex" value="${esc(brand)}" maxlength="7"></div>
        </div>
        <p class="d-note">Used for buttons and accents on the website and in emails.</p>`, { saveId: 'wpSaveBrand', icon: 'star' })}

      ${section('report', 'Monthly report', report ? `<span class="pill ${report.auto ? 'green' : 'grey'}">${report.auto ? 'Automatic' : 'Off'}</span>` : '', v2 && report ? `
        <label class="module-toggle"><span>Send the PDF sales report automatically on the 1st of each month</span><span class="switch"><input id="wpReportAuto" type="checkbox" ${report.auto ? 'checked' : ''}><span></span></span></label>
        <div class="edit-grid" style="margin-top:12px">${wpField('wpReportEmail', 'Send to', report.email, { type: 'email', placeholder: 'chef@restaurant.ch' })}</div>
        ${f.monthly_reports ? '' : '<p class="d-note warn-note">The Monthly Reports feature is off, so nothing is sent.</p>'}` : updateNote, v2 && report ? { saveId: 'wpSaveReport', icon: 'note' } : { icon: 'note' })}

      ${section('email', 'Email (Brevo)', mail ? `<span class="pill ${mail.brevo_configured ? 'green' : 'amber'}">${mail.brevo_configured ? 'Active' : 'Not set up'}</span>` : '', v2 && mail ? `
        <dl class="kv">
          <dt>Status</dt><dd>${mail.brevo_configured ? 'Brevo SMTP configured' : 'Not configured — emails use the server mailer'}</dd>
          <dt>Sender</dt><dd>${esc(mail.from_name || '—')}${mail.from_email ? ` &lt;${esc(mail.from_email)}&gt;` : ''}</dd>
          <dt>Sent today</dt><dd>${esc(mail.sent_today)}</dd>
          <dt>Last test</dt><dd>${mail.last_test ? `${mail.last_test.success ? 'OK' : 'Failed'} · ${esc(mail.last_test.time)}` : 'No test yet'}</dd>
        </dl>
        <p class="d-note">Read-only. SMTP keys stay in wp-admin (FoodUp Ordering → Brevo) and are never sent to the Control Center.</p>` : updateNote, { icon: 'mail' })}`);
    bindWordpressActions(page, d);
    $$('#rpSettings .wp-host').forEach(h => { h.oninput = () => { page.wpDirty = true; }; });
  }

  function bindWordpressActions(page, d) {
    const host = $('#rpSettings');
    const s = d.settings || {};
    const f = s.features || {};
    const oa = s.orders_app || {};

    const save = (btn, changes, message) => async () => {
      btn.disabled = true;
      try {
        const res = await api(`/admin/api/restaurants/${encodeURIComponent(page.code)}/wordpress`, { method: 'PATCH', body: JSON.stringify({ changes }) });
        if (state.page !== page) return;
        page.wp = { loading: false, connected: true, data: res.wordpress, backend: res.backend };
        page.wpDirty = false;
        toast(message);
        if (res.warning) toast(res.warning, 'error');
        renderWordpress();
        renderHero();
        if (changes.features || changes.orders_app) { loadRestaurantPage({ silent: true }); refreshAll({ silent: true }); }
      } catch (error) {
        toast(error.message, 'error');
        btn.disabled = false;
      }
    };

    // Hours + closures
    if ($('#wpSaveHours')) {
      $$('[data-h-enabled]', host).forEach(input => input.addEventListener('change', () => input.closest('.hours-row').classList.toggle('is-off', !input.checked)));
      const closures = $('#wpClosures');
      closures.addEventListener('click', e => { const b = e.target.closest('[data-c-remove]'); if (b) { b.closest('.closure-row').remove(); page.wpDirty = true; } });
      $('#wpAddClosure').addEventListener('click', () => {
        const today = swissDay(new Date());
        closures.insertAdjacentHTML('beforeend', closureRowHtml({ start: today, end: today, reason: '' }));
        page.wpDirty = true;
      });
      // 24-hour times typed as 1130 or 11:30 are normalised to 11:30.
      host.addEventListener('change', e => {
        const input = e.target.closest('.time-input');
        if (!input) return;
        const digits = input.value.replace(/\D/g, '');
        if (/^\d{3,4}$/.test(digits)) input.value = `${digits.slice(0, -2).padStart(2, '0')}:${digits.slice(-2)}`;
        input.classList.toggle('invalid', !!input.value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.value));
      });
      const btn = $('#wpSaveHours');
      btn.addEventListener('click', () => {
        const bad = $$('.time-input', host).filter(i => i.value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(i.value));
        if (bad.length) { bad.forEach(i => i.classList.add('invalid')); toast('Enter times as HH:MM, for example 11:30', 'error'); bad[0].focus(); return; }
        const days = $$('.hours-row', host).map(row => ({
          day: Number(row.dataset.day),
          enabled: $('[data-h-enabled]', row).checked,
          periods: [0, 1].map(i => ({ start: $(`[data-h="s${i}"]`, row).value, end: $(`[data-h="e${i}"]`, row).value })),
        }));
        const list = $$('.closure-row', closures).map(row => ({ start: $('[data-c="start"]', row).value, end: $('[data-c="end"]', row).value, reason: $('[data-c="reason"]', row).value }))
          .filter(c => c.start || c.end || c.reason);
        save(btn, { hours: { days, closures: list } }, 'Opening hours saved')();
      });
    }

    // Delivery & pickup
    if ($('#wpSaveDelivery')) {
      let mode = s.ordering?.order_mode || 'both';
      segmented($('#wpOrderMode'), [{ value: 'both', label: 'Both' }, { value: 'delivery_only', label: 'Delivery' }, { value: 'pickup_only', label: 'Pickup' }], mode, v => { mode = v; page.wpDirty = true; });
      const zones = $('#wpZones');
      zones.addEventListener('click', e => { const b = e.target.closest('[data-z-remove]'); if (b) { b.closest('.zone-row').remove(); page.wpDirty = true; } });
      $('#wpAddZone').addEventListener('click', () => { zones.insertAdjacentHTML('beforeend', zoneRowHtml({ plz: '', city: '', min: '' })); $('.zone-row:last-child [data-z="plz"]', zones).focus(); page.wpDirty = true; });
      const btn = $('#wpSaveDelivery');
      btn.addEventListener('click', () => {
        const list = $$('.zone-row', zones).map(row => ({ plz: $('[data-z="plz"]', row).value.trim(), city: $('[data-z="city"]', row).value.trim(), min: $('[data-z="min"]', row).value.trim() || '0' }))
          .filter(z => z.plz || z.city);
        save(btn, { ordering: { order_mode: mode, preorder_min_lead_minutes: Number($('#wpLead').value || 0) }, delivery_zones: list }, 'Delivery & pickup saved')();
      });
    }

    // Features
    const featuresBtn = $('#wpSaveFeatures');
    featuresBtn.addEventListener('click', () => {
      const next = {};
      $$('[data-wp-feature]', host).forEach(input => { next[input.dataset.wpFeature] = input.checked; });
      const run = save(featuresBtn, { features: next }, 'Features saved in WordPress');
      const stopsOrders = (f.website_ordering && !next.website_ordering) || (f.orders_app && !next.orders_app);
      if (stopsOrders) {
        confirmationModal('Stop online orders?', next.website_ordering === false
          ? 'Switching off Website Ordering disables the online shop and every other module. Customers can no longer order on this website.'
          : 'Switching off the FoodUp Orders App means new orders no longer reach the restaurant’s Orders app or printer.', 'Switch off', run);
      } else {
        run();
      }
    });

    // Orders App
    let edition = oa.edition === 'free' ? 'free' : 'pro';
    let autoAction = ['accept', 'reject'].includes(oa.auto_action) ? oa.auto_action : 'disabled';
    segmented($('#wpEdition'), [{ value: 'free', label: 'Free' }, { value: 'pro', label: 'Pro' }], edition, v => { edition = v; page.wpDirty = true; });
    segmented($('#wpAutoAction'), [{ value: 'disabled', label: 'Off' }, { value: 'accept', label: 'Auto accept' }, { value: 'reject', label: 'Auto reject' }], autoAction, v => { autoAction = v; page.wpDirty = true; });
    const ordersBtn = $('#wpSaveOrders');
    ordersBtn.addEventListener('click', () => save(ordersBtn, { orders_app: {
      edition, auto_action: autoAction,
      auto_wait_minutes: Number($('#wpAutoWait').value || 5),
      auto_accept_time: $('#wpAutoAccept').value,
      auto_reject_reason: $('#wpAutoReject').value,
    } }, 'Orders App settings saved')());

    // Shop
    const shopBtn = $('#wpSaveShop');
    shopBtn.addEventListener('click', () => save(shopBtn, { shop: {
      restaurant_name: $('#wpShopName').value, address: $('#wpShopAddress').value, contact_phone: $('#wpShopPhone').value,
      contact_email: $('#wpShopEmail').value, vat_number: $('#wpShopVat').value, google_review_url: $('#wpShopReview').value,
    } }, 'Shop details saved in WordPress')());

    // Branding
    const picker = $('#wpBrandPicker');
    const hex = $('#wpBrandHex');
    picker.addEventListener('input', () => { hex.value = picker.value.toUpperCase(); picker.parentElement.style.background = picker.value; });
    hex.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(hex.value)) { picker.value = hex.value; picker.parentElement.style.background = hex.value; } });
    const brandBtn = $('#wpSaveBrand');
    brandBtn.addEventListener('click', () => {
      if (!/^#[0-9a-f]{6}$/i.test(hex.value)) { toast('Enter a colour like #FF6600', 'error'); return; }
      save(brandBtn, { branding: { brand_color: hex.value.toUpperCase() } }, 'Brand colour saved')();
    });

    // Monthly report
    if ($('#wpSaveReport')) {
      const btn = $('#wpSaveReport');
      btn.addEventListener('click', () => save(btn, { monthly_report: { auto: $('#wpReportAuto').checked, email: $('#wpReportEmail').value.trim() } }, 'Monthly report settings saved')());
    }

    requestAnimationFrame(() => $$('.segmented', host).forEach(positionThumb));
  }

  // ---------- Analytics tab (plugin analytics via the bridge, v4) ----------
  const AN_RANGES = [{ value: 'today', label: 'Today' }, { value: 'last7', label: '7 days' }, { value: 'last30', label: '30 days' }, { value: 'this_month', label: 'This month' }];
  const AN_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const AN_ICONS = {
    fire: 'M12 3c1 3 4 5 4 9a4 4 0 0 1-8 0c0-2 1-3 2-4c0 2 1 3 2 3c0-3-1-5 0-8z',
    star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
    pin: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 7.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z',
    bag: 'M6 8h12l-1 12H7zM9 8V6a3 3 0 0 1 6 0v2',
  };
  const fmtInt = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '’');
  const svgPath = (d, size = 16) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg>`;

  async function loadAnalyticsPanel(page, range) {
    page.an = { ...(page.an || {}), range: range || page.an?.range || 'last7', loading: true };
    renderAnalyticsPanel();
    try {
      const data = await api(`/admin/api/restaurants/${encodeURIComponent(page.code)}/wordpress/analytics?range=${encodeURIComponent(page.an.range)}`);
      if (state.page !== page) return;
      page.an = { ...page.an, loading: false, data, renderedFor: null };
    } catch (error) {
      if (state.page !== page) return;
      page.an = { ...page.an, loading: false, data: { available: false, message: error.message }, renderedFor: null };
    }
    renderAnalyticsPanel();
  }

  function anDelta(now, base, { points = false } = {}) {
    if (points) {
      if (now === null || base === null || base === undefined) return '';
      const d = Math.round((now - base) * 10) / 10;
      return `<span class="pill ${d >= 0 ? 'green' : 'amber'}">${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toFixed(1)} pts</span>`;
    }
    const d = pctDelta(now, base);
    if (d === null) return '';
    return `<span class="pill ${d >= 0 ? 'green' : 'amber'}">${deltaText(d)}</span>`;
  }

  function anSpark(values, color) {
    if (!values.length || values.every(v => !v)) return '';
    const max = Math.max(...values), min = Math.min(...values);
    const pts = values.map((v, i) => [values.length === 1 ? 60 : (i / (values.length - 1)) * 120, 30 - ((v - min) / (max - min || 1)) * 26]);
    const line = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    return `<svg class="an-spark" viewBox="0 0 120 34" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,34 ${line} 120,34" fill="${color}" opacity=".12"></polygon><polyline class="an-draw" points="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></polyline></svg>`;
  }

  function anRing(share, color, label, sub, size = 104, width = 11, track = 'var(--line)') {
    const r = 42, c = 2 * Math.PI * r;
    const dash = Math.max(0, Math.min(1, share)) * c;
    return `<svg class="an-ring" viewBox="0 0 100 100" style="width:${size}px;height:${size}px" role="img" aria-label="${esc(sub)} ${esc(label)}"><circle cx="50" cy="50" r="${r}" fill="none" stroke="${track}" stroke-width="${width}"></circle><circle class="an-ring-arc" cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 50 50)"></circle><text x="50" y="${sub ? 50 : 56}" text-anchor="middle" class="an-ring-value">${esc(label)}</text>${sub ? `<text x="50" y="64" text-anchor="middle" class="an-ring-sub">${esc(sub)}</text>` : ''}</svg>`;
  }

  function anBarRow(label, valueHtml, pct, color, delay) {
    return `<div class="an-row" style="--d:${delay}ms"><div class="an-row-top"><span>${esc(label)}</span><span class="num">${valueHtml}</span></div><div class="track"><div class="an-widen" style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%;background:${color}"></div></div></div>`;
  }

  function renderAnalyticsPanel() {
    const page = state.page;
    const root = $('#rpAnalytics');
    if (!page || !root) return;
    if (!root.dataset.built) {
      root.dataset.built = '1';
      root.innerHTML = `
        <section class="panel an-head">
          <div class="title-inline"><span class="icon-chip accent lg">${icon('trend')}</span><div><h2>Website &amp; sales analytics</h2><p id="rpAnSub">From the restaurant's WordPress</p></div></div>
          <div id="rpAnRange" class="segmented" role="tablist" aria-label="Analytics period"></div>
        </section>
        <div id="rpAnBody" class="an-body"></div>`;
    }
    const body = $('#rpAnBody');
    const sw = $('#rpAnRange');
    const sub = $('#rpAnSub');
    const wp = page.wp;
    const notice = (html) => { body.innerHTML = `<section class="panel"><div class="empty-box">${html}</div></section>`; sw.hidden = true; page.an && (page.an.renderedFor = null); };
    if (!wp || (wp.loading && !wp.data)) return notice('Connecting to WordPress…');
    if (!wp.connected) return notice('Connect WordPress to see website and sales analytics.');
    if (Number(wp.data.bridge_version || 1) < 4) return notice('Needs FoodUp Ordering 0.5.247 or newer on this site.');
    if (page.tab !== 'analytics') return;
    if (!page.an) { loadAnalyticsPanel(page, 'last7'); return; }
    sw.hidden = false;
    segmented(sw, AN_RANGES, page.an.range, v => loadAnalyticsPanel(page, v));
    const a = page.an.data;
    body.classList.toggle('is-loading', !!page.an.loading);
    if (!a) { body.innerHTML = '<section class="panel"><div class="empty-box">Loading analytics…</div></section>'; return; }
    if (!a.available) { body.innerHTML = `<section class="panel"><div class="empty-box">${esc(a.message || 'Analytics are not available.')}</div></section>`; return; }
    if (page.an.renderedFor === a) return;
    page.an.renderedFor = a;

    const cc = a.currency || 'CHF';
    const cur = a.current || {};
    const prev = a.previous || {};
    const vis = a.visitors || {};
    const vc = vis.current;
    const vp = vis.previous;
    const tracking = !!vis.tracking_enabled && !!vc;
    const conv = tracking && vc.sessions ? Math.round(vc.converted_sessions / vc.sessions * 1000) / 10 : null;
    const convPrev = tracking && vp && vp.sessions ? Math.round(vp.converted_sessions / vp.sessions * 1000) / 10 : null;
    const r = a.range || {};
    sub.textContent = r.from ? `${dayLabel(r.from)}${r.to && r.to !== r.from ? ' – ' + dayLabel(r.to) : ''} · compared with the previous ${r.days === 1 ? 'day' : r.days + ' days'}` : "From the restaurant's WordPress";

    // timeline (hourly: trim to the active part of the day)
    let tl = (a.timeline || []).slice();
    if (a.granularity === 'hour' && tl.length === 24) {
      const active = tl.map((t, i) => (t.orders ? i : -1)).filter(i => i >= 0);
      const from = Math.min(10, active.length ? active[0] : 10);
      const to = Math.max(22, active.length ? active[active.length - 1] + 1 : 22);
      tl = tl.slice(from, to);
    }
    const ordersSeries = tl.map(t => t.orders);
    const revenueSeries = tl.map(t => t.revenue);

    const tiles = [
      { label: 'Website visitors', value: tracking ? fmtInt(vc.visitors) : 'Off', delta: tracking ? anDelta(vc.visitors, vp?.visitors) : '', note: tracking ? `${fmtInt(vc.sessions)} visits` : 'Visitor tracking is off on this site',
        extra: tracking && vc.visitors ? `<div class="an-mini-split" title="Returning visitors"><span class="an-widen" style="width:${(vc.returning_visitors / vc.visitors * 100).toFixed(1)}%"></span></div><div class="kpi-note">${Math.round(vc.returning_visitors / vc.visitors * 100)}% returning</div>` : '' },
      { label: 'Conversion', value: conv === null ? '—' : `${conv.toFixed(1)}%`, delta: conv === null ? '' : anDelta(conv, convPrev, { points: true }), note: tracking ? `${fmtInt(vc.converted_sessions)} visits led to an order` : 'Needs visitor tracking', extra: '' },
      { label: 'Orders', value: fmtInt(cur.orders || 0), delta: anDelta(cur.orders, prev.orders), note: cur.lost ? `${plural(cur.lost, 'order')} cancelled or failed` : 'From WooCommerce', extra: anSpark(ordersSeries, '#8b38cb') },
      { label: 'Revenue', value: money(cur.revenue, cc), delta: anDelta(cur.revenue, prev.revenue), note: `avg. ${money(cur.aov, cc)} per order`, extra: anSpark(revenueSeries, '#e79b24') },
    ];

    // insights
    const insights = [];
    const heat = Array.isArray(a.heat) && a.heat.length === 7 ? a.heat : null;
    if (heat) {
      let best = { v: 0, d: 0, h: 0 };
      heat.forEach((row, d) => (row || []).forEach((v, h) => { if (v > best.v) best = { v, d, h }; }));
      if (best.v) insights.push({ icon: AN_ICONS.fire, tone: 'amber', label: 'Busiest time', value: `${AN_WEEKDAYS[best.d]}, ${String(best.h).padStart(2, '0')}:00 – ${String(best.h + 1).padStart(2, '0')}:00`, note: plural(best.v, 'order') });
    } else if (Array.isArray(a.hours) && a.hours.some(Boolean)) {
      const h = a.hours.indexOf(Math.max(...a.hours));
      insights.push({ icon: AN_ICONS.fire, tone: 'amber', label: 'Busiest hour', value: `${String(h).padStart(2, '0')}:00 – ${String(h + 1).padStart(2, '0')}:00`, note: plural(a.hours[h], 'order') });
    }
    const labels = a.source_labels || {};
    const srcLabel = key => labels[key] || key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
    const orderSources = a.order_sources || {};
    const totalSourced = Object.values(orderSources).reduce((x, y) => x + y, 0);
    const bestSource = Object.entries(orderSources).filter(([k]) => k !== 'unknown').sort((x, y) => y[1] - x[1])[0];
    if (bestSource && bestSource[1]) insights.push({ icon: AN_ICONS.star, tone: 'blue', label: 'Best source', value: srcLabel(bestSource[0]), note: `${Math.round(bestSource[1] / Math.max(1, totalSourced) * 100)}% of orders` });
    const zones = a.zones || [];
    const deliveryOrders = (a.modes || {}).delivery || 0;
    if (zones[0] && zones[0].orders) insights.push({ icon: AN_ICONS.pin, tone: 'green', label: 'Strongest zone', value: zones[0].name, note: `${Math.round(zones[0].orders / Math.max(1, deliveryOrders) * 100)}% of delivery orders` });
    else if ((a.products || [])[0]) insights.push({ icon: AN_ICONS.bag, tone: 'green', label: 'Top product', value: a.products[0].name, note: `${a.products[0].qty}× sold` });

    // orders & revenue chart
    const barMax = Math.max(1, ...ordersSeries);
    const revMax = Math.max(1, ...revenueSeries);
    const revPoints = revenueSeries.map((v, i) => `${(((i + 0.5) / revenueSeries.length) * 100).toFixed(2)},${(100 - (v / revMax) * 92).toFixed(2)}`).join(' ');
    const step = Math.max(1, Math.ceil(tl.length / 6));
    const chart = tl.length ? `
      <div class="an-chart">
        <div class="an-bars">${tl.map((t, i) => `<div class="an-bar" title="${esc(t.label)} · ${plural(t.orders, 'order')} · ${esc(money(t.revenue, cc))}"><span class="an-grow" style="height:${(t.orders / barMax * 100).toFixed(1)}%;--d:${i * 18}ms"></span></div>`).join('')}</div>
        ${revenueSeries.some(Boolean) ? `<svg class="an-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points="${revPoints}" fill="none" stroke="#e79b24" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"></polyline></svg>` : ''}
        <div class="an-axis">${tl.map((t, i) => `<span>${i % step === 0 ? esc(t.label) : ''}</span>`).join('')}</div>
      </div>` : '<div class="empty-box">No orders in this period.</div>';

    // funnel
    const funnel = tracking ? `
      <div class="an-funnel">
        ${anRing((conv || 0) / 100 * 5, '#8b38cb', conv === null ? '—' : `${conv.toFixed(1)}%`, 'conversion')}
        <div class="an-funnel-rows">
          ${anBarRow('Visits', `<strong>${fmtInt(vc.sessions)}</strong>`, 100, '#e3d3f2', 0)}
          ${anBarRow('Unique visitors', `<strong>${fmtInt(vc.visitors)}</strong>`, vc.sessions ? vc.visitors / vc.sessions * 100 : 0, '#c49be6', 80)}
          ${anBarRow('Visits with an order', `<strong>${fmtInt(vc.converted_sessions)}</strong>`, vc.sessions ? vc.converted_sessions / vc.sessions * 100 : 0, '#8b38cb', 160)}
        </div>
      </div>
      <p class="d-note">The ring fills completely at 20% conversion.</p>`
      : `<div class="an-off">${icon('user')}<div><strong>Visitor tracking is off</strong><p>Orders still show below. Switch it on in wp-admin under FoodUp Ordering → Analytics → Visitors &amp; acquisition, after updating the privacy notice.</p></div></div>`;

    // sources
    const visitSources = (tracking && vc.sources) || {};
    const sourceRows = Array.from(new Set([...Object.keys(orderSources), ...Object.keys(visitSources)]))
      .map(key => ({ key, orders: orderSources[key] || 0, visits: visitSources[key]?.sessions || 0 }))
      .filter(x => x.orders || x.visits).sort((x, y) => y.orders - x.orders || y.visits - x.visits).slice(0, 7);
    const maxSrcOrders = Math.max(1, ...sourceRows.map(x => x.orders));
    const maxSrcVisits = Math.max(1, ...sourceRows.map(x => x.visits));
    const sources = sourceRows.length ? sourceRows.map((x, i) => `
      <div class="an-row" style="--d:${i * 60}ms">
        <div class="an-row-top"><span>${esc(srcLabel(x.key))}</span><span class="num"><strong>${plural(x.orders, 'order')}</strong>${tracking && x.visits ? ` <span class="muted-sm">· ${plural(x.visits, 'visit')}</span>` : ''}</span></div>
        <div class="track"><div class="an-widen" style="width:${(x.orders / maxSrcOrders * 100).toFixed(1)}%;background:#8b38cb"></div></div>
        ${tracking ? `<div class="track thin"><div class="an-widen" style="width:${(x.visits / maxSrcVisits * 100).toFixed(1)}%;background:#d9c2ee"></div></div>` : ''}
      </div>`).join('') : '<div class="muted-sm an-empty">No orders in this period.</div>';

    // heatmap
    let heatHtml;
    if (heat) {
      const active = [];
      heat.forEach(row => (row || []).forEach((v, h) => { if (v) active.push(h); }));
      const hFrom = Math.min(10, active.length ? Math.min(...active) : 10);
      const hTo = Math.max(22, active.length ? Math.max(...active) + 1 : 22);
      const cols = hTo - hFrom;
      const hmax = Math.max(1, ...heat.flat());
      heatHtml = `<div class="an-heat-scroll"><div class="an-heat" style="--cols:${cols}">
        ${heat.map((row, d) => `<span class="an-heat-day">${AN_WEEKDAYS[d].slice(0, 3)}</span>${Array.from({ length: cols }, (_, k) => { const h = hFrom + k; const v = (row || [])[h] || 0; return `<span class="an-cell" style="opacity:${v ? (0.14 + 0.86 * v / hmax).toFixed(2) : '0.06'};--d:${(d * cols + k) * 6}ms" title="${AN_WEEKDAYS[d]} ${String(h).padStart(2, '0')}:00 · ${plural(v, 'order')}"></span>`; }).join('')}`).join('')}
        <span></span>${Array.from({ length: cols }, (_, k) => `<span class="an-heat-h">${(hFrom + k) % 2 === 0 ? String(hFrom + k).padStart(2, '0') : ''}</span>`).join('')}
      </div></div>
      <div class="an-legend"><span>Quiet</span><span class="an-legend-bar"></span><span>Busy</span></div>`;
    } else {
      heatHtml = '<div class="muted-sm an-empty">The weekday × hour view needs FoodUp Ordering 0.5.248 or newer.</div>';
    }

    // products
    const products = a.products || [];
    const maxQty = Math.max(1, ...products.map(p => p.qty));
    const productsHtml = products.length ? products.slice(0, 6).map((p, i) => `
      <div class="an-rank-row" style="--d:${i * 60}ms"><span class="an-rank">${i + 1}</span><div style="flex:1;min-width:0">
        <div class="an-row-top"><span>${esc(p.name)}</span><span class="num"><strong>${p.qty}×</strong> <span class="muted-sm">${esc(money(p.revenue, cc))}</span></span></div>
        <div class="track"><div class="an-widen" style="width:${(p.qty / maxQty * 100).toFixed(1)}%;background:#a768d9"></div></div></div></div>`).join('') : '<div class="muted-sm an-empty">No products sold in this period.</div>';

    // platform + app clicks + mix
    const platform = a.platform || {};
    const pTotal = (platform.website || 0) + (platform.app || 0) + (platform.unknown || 0);
    const clicks = a.app_clicks;
    const modes = a.modes || {};
    const pay = a.payment || {};
    const mTotal = (modes.delivery || 0) + (modes.pickup || 0) + (modes.table || 0);
    const payTotal = (pay.online || 0) + (pay.cash || 0) + (pay.table || 0);
    const split = (parts) => `<div class="an-split">${parts.filter(x => x[1]).map(([, v, color, total]) => `<span class="an-widen" style="width:${(v / total * 100).toFixed(1)}%;background:${color}"></span>`).join('')}</div>`;
    const platformHtml = pTotal ? `
      <div class="an-donut-row">${anRing((platform.website || 0) / pTotal, '#8b38cb', `${Math.round((platform.website || 0) / pTotal * 100)}%`, 'website', 110, 14, '#d9c2ee')}
        <div class="an-legend-list"><span><i style="background:#8b38cb"></i>Website <strong>${platform.website || 0}</strong></span><span><i style="background:#d9c2ee"></i>Customer App <strong>${platform.app || 0}</strong></span>${platform.unknown ? `<span><i style="background:#e3d3f2"></i>Other <strong>${platform.unknown}</strong></span>` : ''}</div></div>` : '<div class="muted-sm an-empty">No orders in this period.</div>';
    const clicksHtml = clicks ? `
      <div class="mix-title an-sub-title">App Store &amp; Google Play link opens ${anDelta(clicks.total, clicks.previous_total)}</div>
      <div class="an-clicks">
        ${[['Homepage', clicks.homepage], ['Emails', clicks.email]].map(([label, c]) => { const t = (c?.ios || 0) + (c?.android || 0); return `<div><span>${label}</span><strong>${t}</strong>${t ? `<div class="an-split"><span class="an-widen" style="width:${((c.ios || 0) / t * 100).toFixed(1)}%;background:#15171c"></span><span class="an-widen" style="width:${((c.android || 0) / t * 100).toFixed(1)}%;background:#22b36b"></span></div>` : ''}<em>iOS ${c?.ios || 0} · Android ${c?.android || 0}</em></div>`; }).join('')}
      </div>` : '';
    const mixHtml = mTotal ? `
      <div class="an-mix"><div class="an-row-top"><span>Delivery ${modes.delivery || 0} · Pickup ${modes.pickup || 0}${modes.table ? ` · Table ${modes.table}` : ''}</span></div>${split([['d', modes.delivery || 0, '#8b38cb', mTotal], ['p', modes.pickup || 0, '#c49be6', mTotal], ['t', modes.table || 0, '#e3d3f2', mTotal]])}</div>
      ${payTotal ? `<div class="an-mix"><div class="an-row-top"><span>Online ${pay.online || 0} · Cash ${pay.cash || 0}${pay.table ? ` · Table ${pay.table}` : ''}</span></div>${split([['o', pay.online || 0, '#1d5fd1', payTotal], ['c', pay.cash || 0, '#9db8ec', payTotal], ['t', pay.table || 0, '#d6e2f8', payTotal]])}</div>` : ''}` : '';
    const maxZone = Math.max(1, ...zones.map(z => z.orders));
    const zonesHtml = zones.length ? zones.slice(0, 6).map((z, i) => anBarRow(z.name, `<strong>${plural(z.orders, 'order')}</strong> <span class="muted-sm">· ${esc(money(z.revenue, cc))}</span>`, z.orders / maxZone * 100, '#e79b24', i * 60)).join('') : '<div class="muted-sm an-empty">No delivery orders in this period.</div>';
    const emails = a.emails || {};
    const sent = (emails.brevo || 0) + (emails.wordpress || 0) + (emails.resend || 0);

    body.innerHTML = `
      <div class="an-tiles">${tiles.map((t, i) => `<div class="kpi an-tile an-rise" style="--d:${i * 70}ms"><div class="kpi-top"><span class="kpi-label">${esc(t.label)}</span>${t.delta}</div><div class="kpi-value">${esc(t.value)}</div>${t.extra}<div class="kpi-note">${esc(t.note)}</div></div>`).join('')}</div>
      ${insights.length ? `<div class="an-insights">${insights.map((x, i) => `<div class="an-insight an-rise tone-${x.tone}" style="--d:${120 + i * 60}ms"><span class="an-insight-icon">${svgPath(x.icon)}</span><div><span class="muted-sm">${esc(x.label)}</span><strong>${esc(x.value)}</strong><span class="muted-sm">${esc(x.note)}</span></div></div>`).join('')}</div>` : ''}
      <div class="split">
        <section class="panel pad grow-wide an-rise" style="--d:160ms">
          <div class="panel-title-row"><h2>Orders &amp; revenue</h2><span class="an-key"><span><i style="background:#c49be6"></i>Orders</span>${revenueSeries.some(Boolean) ? '<span><i class="line" style="background:#e79b24"></i>Revenue</span>' : ''}</span></div>
          ${chart}
        </section>
        <section class="panel pad grow-side an-rise" style="--d:220ms">
          <div class="panel-title-row"><h2>From visit to order</h2><span class="muted-sm">website</span></div>
          ${funnel}
        </section>
      </div>
      <div class="split">
        <section class="panel pad grow-side an-rise" style="--d:260ms; flex-basis: 380px">
          <div class="panel-title-row"><h2>Where orders come from</h2>${tracking ? '<span class="an-key"><span><i style="background:#8b38cb"></i>Orders</span><span><i style="background:#d9c2ee"></i>Visits</span></span>' : ''}</div>
          <div class="an-list">${sources}</div>
        </section>
        <section class="panel pad grow-side an-rise" style="--d:300ms; flex-basis: 380px">
          <div class="panel-title-row"><h2>Busiest times</h2><span class="muted-sm">orders by weekday and hour</span></div>
          ${heatHtml}
        </section>
      </div>
      <div class="split">
        <section class="panel pad grow-side an-rise" style="--d:340ms">
          <div class="panel-title-row"><h2>Top products</h2><span class="muted-sm">by quantity</span></div>
          <div class="an-list">${productsHtml}</div>
        </section>
        <section class="panel pad grow-side an-rise" style="--d:380ms">
          <div class="panel-title-row"><h2>Website vs. App</h2>${sent ? `<span class="muted-sm">${plural(sent, 'email')} sent${emails.failed ? ` · ${emails.failed} failed` : ''}</span>` : ''}</div>
          ${platformHtml}${mixHtml}${clicksHtml}
        </section>
        <section class="panel pad grow-side an-rise" style="--d:420ms">
          <div class="panel-title-row"><h2>Delivery zones</h2><span class="muted-sm">by orders</span></div>
          <div class="an-list">${zonesHtml}</div>
        </section>
      </div>
      <p class="d-note an-note">${tracking ? 'Visitors are counted anonymously and only after cookie consent.' : ''}${a.partial ? ' Some days are still being calculated; open the tab again in a minute for complete figures.' : ''} Link opens are store-link clicks, not confirmed downloads.</p>`;
  }

  // ---------- restaurant page tabs ----------
  // A refresh never rebuilds Settings while the admin is editing there.
  function settingsBusy() {
    const page = state.page;
    if (!page) return false;
    const box = $('#rpSettings');
    return !!(page.dirty || page.wpDirty || (box && box.contains(document.activeElement) && document.activeElement !== document.body));
  }

  const RP_TABS = [
    { value: 'overview', label: 'Overview' }, { value: 'orders', label: 'Orders' }, { value: 'analytics', label: 'Analytics' },
    { value: 'menu', label: 'Menu' }, { value: 'website', label: 'Website' }, { value: 'settings', label: 'Settings' },
  ];
  const RP_TAB_IDS = RP_TABS.map(t => t.value);
  const SET_SECTIONS = [
    { id: 'ordering', label: 'Ordering', sub: 'Hours, delivery, features', icon: 'clock' },
    { id: 'apps', label: 'Apps & staff', sub: 'Orders app, couriers, PINs', icon: 'device' },
    { id: 'shop', label: 'Shop & communication', sub: 'Details, brand, email, report', icon: 'store' },
    { id: 'conn', label: 'Connection & advanced', sub: 'WordPress, callbacks, danger zone', icon: 'plug' },
  ];
  // Which pane each WordPress section belongs to.
  const WP_SECTION_PANE = { wp_status: 'conn', hours: 'ordering', delivery: 'ordering', features: 'ordering', orders_app: 'apps', shop: 'shop', branding: 'shop', report: 'shop', email: 'shop' };

  function renderRpTabs() {
    const page = state.page;
    const el = $('#rpTabs');
    if (!page || !el) return;
    const r = page.data;
    const issues = (r?.attention_items || []).length;
    const failed = (r?.failed_delivered_callbacks || []).length;
    const wpProblem = page.wp && !page.wp.loading && !page.wp.connected;
    const badges = { overview: issues ? String(issues) : '', settings: failed ? String(failed) : (wpProblem ? '!' : '') };
    el.innerHTML = '<span class="seg-thumb" aria-hidden="true"></span>' + RP_TABS.map(t => `<button type="button" class="seg-btn" role="tab" data-value="${t.value}" aria-selected="false" aria-controls="rpPane-${t.value}">${esc(t.label)}${badges[t.value] ? `<span class="tab-badge ${t.value === 'overview' ? 'red' : 'amber'}">${esc(badges[t.value])}</span>` : ''}</button>`).join('');
    el.dataset.ready = '';
    el.onclick = (event) => {
      const btn = event.target.closest('.seg-btn');
      if (btn) setRpTab(btn.dataset.value);
    };
    selectSegment(el, page.tab);
  }

  function setRpTab(tab, { replace = true } = {}) {
    const page = state.page;
    if (!page) return;
    page.tab = RP_TAB_IDS.includes(tab) ? tab : 'overview';
    const target = `#restaurant/${encodeURIComponent(page.code)}${page.tab === 'overview' ? '' : '/' + page.tab}`;
    if (replace && location.hash !== target) history.replaceState(null, '', target);
    $$('#view-restaurant .rp-pane').forEach(p => { p.hidden = p.dataset.pane !== page.tab; });
    selectSegment($('#rpTabs'), page.tab);
    // On a phone the tab bar scrolls: keep the chosen tab in view.
    const wrap = $('.rp-tabs-wrap');
    const tabBtn = $(`#rpTabs .seg-btn[data-value="${page.tab}"]`);
    if (wrap && tabBtn && wrap.scrollWidth > wrap.clientWidth) {
      const left = tabBtn.offsetLeft - 16, right = tabBtn.offsetLeft + tabBtn.offsetWidth + 16;
      if (left < wrap.scrollLeft || right > wrap.scrollLeft + wrap.clientWidth) wrap.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
    }
    if (page.tab === 'overview') renderChart(restaurantChartCtx());
    if (page.tab === 'orders') renderRpOrders();
    if (page.tab === 'analytics') renderAnalyticsPanel();
    if (page.tab === 'menu') renderMenu();
    if (page.tab === 'website') renderWebsite({ force: !Object.keys(page.webEdits || {}).length });
    if (page.tab === 'settings') selectSettingsSection(page.setSec);
    requestAnimationFrame(() => $$(`#view-restaurant .rp-pane[data-pane="${page.tab}"] .segmented`).forEach(positionThumb));
  }

  function renderRpAttention(r) {
    const host = $('#rpAttention');
    if (!host) return;
    const items = r?.attention_items || [];
    $('#rpAttentionSub').textContent = items.length ? 'Sorted by severity' : '';
    if (!items.length) { host.innerHTML = `<div class="healthy-line">${icon('check')}No open issues for this restaurant</div>`; return; }
    const sorted = items.slice().sort((x, y) => (x.severity === 'critical' ? 0 : 1) - (y.severity === 'critical' ? 0 : 1));
    host.innerHTML = `<div class="issue-list" style="padding:14px 16px;margin:0">${sorted.map(i => `<div class="issue ${esc(i.severity)}"><span class="sev ${esc(i.severity)}">${i.severity === 'critical' ? 'CRITICAL' : 'WARNING'}</span><span class="text">${esc(i.text)}</span>${i.kind === 'edition_mismatch' && r.wp_edition ? `<button id="applyEditionBtn" class="btn btn-secondary btn-sm" type="button">Apply ${r.wp_edition === 'free' ? 'Free' : 'Pro'}</button>` : ''}</div>`).join('')}</div>`;
    const applyEdition = $('#applyEditionBtn');
    if (applyEdition) {
      const target = r.wp_edition;
      const page = state.page;
      applyEdition.addEventListener('click', () => confirmationModal(
        `Switch the apps to ${target === 'free' ? 'Free' : 'Pro'}?`,
        `WordPress has ${r.name} set to FoodUp ${target === 'free' ? 'Free' : 'Pro'}. The Orders app switches within a few minutes. ${target === 'free' ? 'Free prints the full address without QR code and locks the Pro tabs (statistics, couriers).' : 'Pro unlocks statistics and couriers and prints the courier QR code.'}`,
        `Apply ${target === 'free' ? 'Free' : 'Pro'}`,
        async () => {
          await api(`/admin/api/restaurants/${encodeURIComponent(r.code)}/wordpress`, { method: 'PATCH', body: JSON.stringify({ changes: { orders_app: { edition: target } } }) });
          toast(`${r.name} now runs as FoodUp ${target === 'free' ? 'Free' : 'Pro'}`);
          refreshAll({ silent: true });
          if (state.page === page) await loadRestaurantPage();
        }));
    }
  }

  function rpOrderList() {
    const r = state.page?.data;
    return (r?.recent_orders || []).map(o => ({ ...o, restaurant_code: r.code, restaurant_name: r.name }));
  }

  function renderRpOrders() {
    const page = state.page;
    if (!page?.data) return;
    const all = rpOrderList();
    const q = String(page.orderSearch || '').trim().toLowerCase();
    const searched = q ? all.filter(o => `${o.order_id} ${o.customer_name} ${o.customer_phone} ${o.payment_method}`.toLowerCase().includes(q)) : all;
    const counts = { all: searched.length, new: 0, accepted: 0, done: 0, void: 0 };
    searched.forEach(o => { counts[orderStatus(o).group] += 1; });
    segmented($('#rpOrderFilter'), [
      { value: 'all', label: 'All', count: counts.all }, { value: 'new', label: 'New', count: counts.new },
      { value: 'accepted', label: 'Accepted', count: counts.accepted }, { value: 'done', label: 'Delivered', count: counts.done },
      { value: 'void', label: 'Rejected & cancelled', count: counts.void },
    ], page.orderFilter, v => { page.orderFilter = v; renderRpOrders(); });
    const list = page.orderFilter === 'all' ? searched : searched.filter(o => orderStatus(o).group === page.orderFilter);
    $('#rpOrdersAll').innerHTML = orderRows(list, false, true);
    bindOpeners($('#rpOrdersAll'));
  }

  function settingsNavHtml(r) {
    const page = state.page;
    const failed = (r.failed_delivered_callbacks || []).length;
    const wpProblem = page.wp && !page.wp.loading && !page.wp.connected;
    const badge = { conn: failed ? String(failed) : (wpProblem ? '!' : ''), apps: r.ios_pin_set ? '' : '!' };
    return `<nav id="rpSetNav" class="panel set-nav" aria-label="Settings sections"><span class="set-thumb" aria-hidden="true"></span>${SET_SECTIONS.map(x => `<button type="button" data-set="${x.id}" aria-current="false"><span class="icon-chip accent">${icon(x.icon)}</span><span class="set-nav-text"><strong>${esc(x.label)}</strong><span>${esc(x.sub)}</span></span>${badge[x.id] ? `<span class="tab-badge amber">${esc(badge[x.id])}</span>` : ''}</button>`).join('')}</nav>`;
  }

  function selectSettingsSection(id) {
    const page = state.page;
    if (!page) return;
    page.setSec = SET_SECTIONS.some(x => x.id === id) ? id : 'ordering';
    $$('#rpSetNav [data-set]').forEach(b => { const on = b.dataset.set === page.setSec; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'true' : 'false'); });
    const thumb = $('#rpSetNav .set-thumb');
    const btn = $(`#rpSetNav [data-set="${page.setSec}"]`);
    if (thumb && btn && btn.offsetHeight) { thumb.style.height = `${btn.offsetHeight}px`; thumb.style.transform = `translateY(${btn.offsetTop - 8}px)`; }
    $$('#rpSettings .set-pane').forEach(p => { p.hidden = p.dataset.pane !== page.setSec; });
    requestAnimationFrame(() => $$(`#rpSettings .set-pane[data-pane="${page.setSec}"] .segmented`).forEach(positionThumb));
  }

  // ---------- Website (FoodUp Restaurant theme via the bridge, v3) ----------
  const WEB_STYLES = {
    delivereat: 'Bold photo homepage with the DeliverEat ordering page. The standard FoodUp look.',
    foodie: 'Fresh olive and lime: compact categories, clean food cards and an app-like feel. Uses its own green palette.',
    motion: 'Colourful and playful: dish stories, top sellers, re-order and product sheets with a photo banner.',
  };
  const WEB_TABS = [{ value: 'style', label: 'Style' }, { value: 'home', label: 'Homepage' }, { value: 'contact', label: 'Contact' }, { value: 'legal', label: 'Legal' }];

  function webValue(page, key) {
    const edits = page.webEdits || {};
    if (key in edits) return edits[key];
    return page.wp?.data?.website?.values?.[key];
  }
  function webText(key, label, opts = {}) {
    const page = state.page;
    const v = webValue(page, key) ?? '';
    if (opts.area) return `<div class="field ${opts.wide ? 'wide' : ''}"><label for="web_${key}">${esc(label)}</label><textarea id="web_${key}" data-web="${key}" rows="${opts.rows || 4}">${esc(v)}</textarea></div>`;
    return `<div class="field ${opts.wide ? 'wide' : ''}"><label for="web_${key}">${esc(label)}</label><input id="web_${key}" data-web="${key}" type="${opts.type || 'text'}" value="${esc(v)}" ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''}></div>`;
  }
  function webImage(key, label) {
    const v = webValue(state.page, key) || '';
    return `<div class="field wide"><label for="web_${key}">${esc(label)}</label><div class="image-field"><span class="image-preview" data-preview="${key}" ${/^https:\/\//.test(v) ? `style="background-image:url('${esc(v)}')"` : ''}>${/^https:\/\//.test(v) ? '' : icon('star')}</span><input id="web_${key}" data-web="${key}" type="url" value="${esc(v)}" placeholder="https://… image link from the media library"></div></div>`;
  }
  function webColor(key, label) {
    const v = webValue(state.page, key) || '#000000';
    return `<div class="field"><label for="web_${key}">${esc(label)}</label><div class="brand-row"><label class="brand-swatch" style="background:${esc(v)}"><span class="sr-only">Pick ${esc(label)}</span><input type="color" data-web-picker="${key}" value="${esc(v)}"></label><input id="web_${key}" data-web="${key}" value="${esc(v)}" maxlength="7"></div></div>`;
  }
  function webSwitch(key, label, note = '') {
    const on = !!webValue(state.page, key);
    return `<label class="module-toggle"><span>${esc(label)}${note ? `<span class="s">${esc(note)}</span>` : ''}</span><span class="switch"><input type="checkbox" data-web-bool="${key}" ${on ? 'checked' : ''}><span></span></span></label>`;
  }
  function webSection(title, toggleKey, body, note = '') {
    const on = toggleKey ? !!webValue(state.page, toggleKey) : true;
    return `<div class="web-block ${on ? '' : 'is-off'}" ${toggleKey ? `data-web-block="${toggleKey}"` : ''}>
      <div class="web-block-head"><div><h3>${esc(title)}</h3>${note ? `<p>${esc(note)}</p>` : ''}</div>${toggleKey ? `<span class="switch"><input type="checkbox" data-web-bool="${toggleKey}" ${on ? 'checked' : ''} aria-label="Show ${esc(title)}"><span></span></span>` : ''}</div>
      <div class="edit-grid web-fields">${body}</div>
    </div>`;
  }

  function webTabHtml(tab) {
    if (tab === 'style') {
      const style = webValue(state.page, 'site_style') || 'delivereat';
      return `<div class="field"><label>Website style</label><div id="webStyle" class="segmented web-style-switch" role="tablist" aria-label="Website style"></div></div>
        <p class="web-style-note" id="webStyleNote">${esc(WEB_STYLES[style] || '')}</p>
        <div class="edit-grid web-fields" style="margin-top:6px">${webColor('accent_color', 'Motion accent colour')}</div>
        <p class="d-note">The accent colour is used by Motion for add buttons and highlights. The brand colour stays under Branding. Sizes and spacing are changed in wp-admin (FoodUp Restaurant → Design).</p>`;
    }
    if (tab === 'home') {
      return `${webSection('Hero', '', `${webText('hero_kicker_text', 'Small line above the title')}${webText('hero_title', 'Title')}${webText('hero_text', 'Text', { wide: true })}${webText('hero_primary_button_text', 'Order button')}${webText('hero_secondary_button_text', 'Second button')}${webColor('hero_button_color', 'Button colour')}${webImage('hero_image', 'Hero image')}`, 'The large photo area at the top of the homepage.')}
        ${webSection('Promotion', 'homepage_promo_enabled', `${webText('homepage_promo_title', 'Title')}${webText('homepage_promo_text', 'Text')}${webImage('homepage_promo_image', 'Image')}`)}
        ${webSection('Popular dishes', 'homepage_popular_enabled', `${webText('homepage_popular_title', 'Title')}${webText('homepage_popular_text', 'Text')}`)}
        ${webSection('Opening hours', 'homepage_hours_enabled', `${webText('homepage_hours_title', 'Title')}`, 'Shows the opening hours set under Opening hours & closures.')}
        ${webSection('Order now', 'homepage_cta_enabled', `${webText('homepage_cta_title', 'Title')}${webText('homepage_cta_text', 'Text')}${webImage('homepage_cta_image', 'Image')}`)}
        ${webSection('App launch notice', 'homepage_app_enabled', `${webText('homepage_app_title', 'Title')}${webText('homepage_app_text', 'Text')}${webText('homepage_app_ios_url', 'App Store link', { type: 'url', placeholder: 'https://apps.apple.com/…' })}${webText('homepage_app_android_url', 'Google Play link', { type: 'url', placeholder: 'https://play.google.com/…' })}`)}
        ${webSection('Services', '', `${webText('homepage_services_title', 'Title')}${webText('homepage_services_text', 'Text')}<div class="wide">${webSwitch('show_dinein', 'Show dine-in', 'Delivery and pickup follow the order types under Delivery & pickup.')}</div>`)}
        ${webSection('Categories', '', `${webText('homepage_categories_title', 'Title')}${webText('homepage_categories_text', 'Text')}`)}`;
    }
    if (tab === 'contact') {
      return `${webSection('Contact page', '', `${webText('contact_hero_title', 'Title')}${webText('contact_hero_text', 'Text')}${webImage('contact_hero_image', 'Image')}`)}
        <div class="web-block"><div class="web-block-head"><div><h3>Show on the contact page</h3></div></div>
          <div class="module-grid">${webSwitch('contact_show_details', 'Contact details')}${webSwitch('contact_show_hours', 'Opening hours')}${webSwitch('contact_show_zones', 'Delivery zones')}${webSwitch('contact_show_map', 'Map')}</div>
          <div class="edit-grid web-fields" style="margin-top:12px">${webText('contact_zones_title', 'Delivery zones title')}</div>
        </div>`;
    }
    return `${webSection('Impressum', '', `${webText('legal_company_name', 'Company')}${webText('legal_owner', 'Owner')}${webText('legal_address', 'Address')}${webText('legal_country', 'Country')}${webText('legal_phone', 'Phone', { type: 'tel' })}${webText('legal_email', 'Email', { type: 'email' })}${webText('impressum_intro', 'Introduction', { wide: true })}`)}
      ${webSection('AGB', '', `${webText('agb_title', 'Title', { wide: true })}${webText('agb_content', 'Text', { area: true, rows: 14, wide: true })}`, 'Blank line = new paragraph. {{company_name}} is replaced with the company name.')}`;
  }

  function renderWebsite({ force = false } = {}) {
    const page = state.page;
    const body = $('#rpWebBody');
    if (!page || !body) return;
    const sub = $('#rpWebSub');
    const foot = $('#rpWebFoot');
    const purge = $('#rpWebPurge');
    const site = $('#rpWebOpen');
    const wp = page.wp;
    const show = (html) => { body.innerHTML = html; foot.hidden = true; purge.hidden = true; site.hidden = true; page.webRenderedFor = null; };
    if (!wp || (wp.loading && !wp.data)) return show('<div class="empty-box">Connecting to WordPress…</div>');
    if (!wp.connected) return show('<div class="empty-box">Connect WordPress to manage the website here.</div>');
    const d = wp.data;
    if (Number(d.bridge_version || 1) < 3) return show('<div class="empty-box">Needs FoodUp Ordering 0.5.247 or newer on this site.</div>');
    if (!d.website) return show('<div class="empty-box">The FoodUp Restaurant theme is not active on this site.</div>');

    sub.textContent = `${d.website.theme_name || 'Theme'} ${d.website.theme_version || ''}`.trim();
    purge.hidden = false;
    site.hidden = false;
    site.href = d.site_url || '#';
    if (!force && page.webRenderedFor === d && body.dataset.tab === (page.webTab || 'style')) return;
    // Never rebuild the form under the admin's cursor; the next render picks the new data up.
    if (!force && page.webRenderedFor && body.contains(document.activeElement) && document.activeElement !== document.body) return;
    page.webRenderedFor = d;
    page.webTab = page.webTab || 'style';
    page.webEdits = page.webEdits || {};

    body.dataset.tab = page.webTab;
    body.innerHTML = `<div class="web-tabs"><div id="webTabs" class="segmented" role="tablist" aria-label="Website settings"></div></div><div class="web-pane">${webTabHtml(page.webTab)}</div>`;
    segmented($('#webTabs'), WEB_TABS, page.webTab, v => { page.webTab = v; renderWebsite({ force: true }); });
    if (page.webTab === 'style') {
      segmented($('#webStyle'), [{ value: 'delivereat', label: 'DeliverEat' }, { value: 'foodie', label: 'Foodie' }, { value: 'motion', label: 'Motion' }], webValue(page, 'site_style') || 'delivereat', v => {
        setWebEdit(page, 'site_style', v);
        $('#webStyleNote').textContent = WEB_STYLES[v] || '';
      });
    }
    requestAnimationFrame(() => $$('.segmented', body).forEach(positionThumb));

    body.oninput = (e) => {
      const t = e.target;
      if (t.dataset.web) {
        setWebEdit(page, t.dataset.web, t.value);
        const prev = $(`[data-preview="${t.dataset.web}"]`, body);
        if (prev) { const ok = /^https:\/\/\S+$/.test(t.value.trim()); prev.style.backgroundImage = ok ? `url('${t.value.trim().replace(/'/g, '%27')}')` : ''; prev.innerHTML = ok ? '' : icon('star'); }
        const picker = $(`[data-web-picker="${t.dataset.web}"]`, body);
        if (picker && /^#[0-9a-f]{6}$/i.test(t.value)) { picker.value = t.value; picker.parentElement.style.background = t.value; }
      } else if (t.dataset.webPicker) {
        const key = t.dataset.webPicker;
        const hex = $(`[data-web="${key}"]`, body);
        hex.value = t.value.toUpperCase();
        t.parentElement.style.background = t.value;
        setWebEdit(page, key, hex.value);
      }
    };
    body.onchange = (e) => {
      const t = e.target;
      if (t.dataset.webBool) {
        setWebEdit(page, t.dataset.webBool, t.checked);
        $$(`[data-web-bool="${t.dataset.webBool}"]`, body).forEach(x => { x.checked = t.checked; });
        const block = $(`[data-web-block="${t.dataset.webBool}"]`, body);
        if (block) block.classList.toggle('is-off', !t.checked);
      }
    };
    updateWebFoot();
  }

  function setWebEdit(page, key, value) {
    const original = page.wp?.data?.website?.values?.[key];
    const same = typeof original === 'boolean' ? original === !!value : String(original ?? '') === String(value ?? '');
    if (same) delete page.webEdits[key]; else page.webEdits[key] = value;
    updateWebFoot();
  }

  function updateWebFoot() {
    const page = state.page;
    const foot = $('#rpWebFoot');
    if (!page || !foot) return;
    const n = Object.keys(page.webEdits || {}).length;
    foot.hidden = n === 0;
    $('#rpWebCount').textContent = `${plural(n, 'change')} not saved`;
  }

  async function saveWebsite(page, changes, message) {
    const btn = $('#rpWebSave');
    btn.disabled = true;
    $('#rpWebPurge').disabled = true;
    try {
      const res = await api(`/admin/api/restaurants/${encodeURIComponent(page.code)}/wordpress`, { method: 'PATCH', body: JSON.stringify({ changes }) });
      if (state.page !== page) return;
      page.wp = { loading: false, connected: true, data: res.wordpress, backend: res.backend };
      if (changes.website) page.webEdits = {};
      toast(message);
      if (!page.wpDirty) renderWordpress();
      renderWebsite({ force: true });
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      btn.disabled = false;
      $('#rpWebPurge').disabled = false;
    }
  }

  function bindWebsitePanel() {
    $('#rpWebSave').addEventListener('click', () => {
      const page = state.page;
      if (!page || !Object.keys(page.webEdits || {}).length) return;
      const edits = { ...page.webEdits };
      for (const key of ['hero_button_color', 'accent_color']) {
        if (key in edits && !/^#[0-9a-f]{6}$/i.test(edits[key])) { toast('Enter colours like #FF6600', 'error'); return; }
      }
      saveWebsite(page, { website: edits }, 'Website saved. Changes are live within a minute.');
    });
    $('#rpWebDiscard').addEventListener('click', () => {
      const page = state.page;
      if (!page) return;
      page.webEdits = {};
      renderWebsite({ force: true });
    });
    $('#rpWebPurge').addEventListener('click', () => {
      const page = state.page;
      if (page) saveWebsite(page, { purge_website_cache: true }, 'Website cache cleared');
    });
  }

  // ---------- Menu & prices (WooCommerce products via the bridge) ----------
  async function loadMenu(page) {
    page.menu = { loading: true, changes: new Map(), search: page.menu?.search || '', category: page.menu?.category || 'all' };
    renderMenu();
    try {
      const data = await api(`/admin/api/restaurants/${encodeURIComponent(page.code)}/wordpress/products`);
      if (state.page !== page) return;
      page.menu = { ...page.menu, loading: false, available: data.available, reason: data.reason, message: data.message, products: data.products || [], categories: data.categories || [], currency: data.currency || 'CHF' };
    } catch (error) {
      if (state.page !== page) return;
      page.menu = { ...page.menu, loading: false, available: false, message: error.message };
    }
    renderMenu();
  }

  function renderMenu() {
    const page = state.page;
    const host = $('#rpMenu');
    if (!page || !host) return;
    const sub = $('#rpMenuSub');
    const saveBtn = $('#rpMenuSave');
    const m = page.menu;
    if (!page.wp || page.wp.loading && !page.wp.data) { host.innerHTML = '<div class="empty-box">Connecting to WordPress…</div>'; saveBtn.hidden = true; sub.textContent = 'From the restaurant\'s WooCommerce'; return; }
    if (!page.wp.connected) { host.innerHTML = '<div class="empty-box">Connect WordPress to manage the menu here.</div>'; saveBtn.hidden = true; return; }
    if (!m || m.loading) { host.innerHTML = '<div class="empty-box">Loading products…</div>'; saveBtn.hidden = true; return; }
    if (!m.available) { host.innerHTML = `<div class="empty-box">${esc(m.message || 'Products are not available.')}</div>`; saveBtn.hidden = true; return; }

    const enabledCount = m.products.filter(p => p.enabled).length;
    sub.textContent = `${plural(m.products.length, 'product')} · ${enabledCount} available · edit availability and prices`;
    if (!$('#menuSearch', host)) {
      host.innerHTML = `
        <div class="menu-toolbar">
          <label class="search-wrap small"><span class="search-icon">${icon('search')}</span><span class="sr-only">Search products</span><input id="menuSearch" type="search" placeholder="Search products" value="${esc(m.search)}"></label>
          <label class="select-wrap"><span class="sr-only">Category</span><select id="menuCategory" class="select-control"><option value="all">All categories</option>${m.categories.map(c => `<option value="${esc(c)}" ${m.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="__hidden" ${m.category === '__hidden' ? 'selected' : ''}>Unavailable only</option></select></label>
        </div>
        <div id="menuList" class="menu-list"></div>
        <div class="menu-savebar" id="menuSavebar" hidden><span id="menuChangeCount"></span><button id="menuDiscard" class="btn btn-secondary" type="button">Discard</button><button id="menuSaveMobile" class="btn btn-primary" type="button">Save changes</button></div>`;
      $('#menuSearch', host).addEventListener('input', e => { host._menu.search = e.target.value; renderMenuList(); });
      $('#menuCategory', host).addEventListener('change', e => { host._menu.category = e.target.value; renderMenuList(); });
      $('#menuDiscard', host).addEventListener('click', () => { host._menu.changes.clear(); renderMenuList(); });
      $('#menuSaveMobile', host).addEventListener('click', () => { if (state.page) saveMenu(state.page); });
      const list = $('#menuList', host);
      list.addEventListener('input', e => {
        const input = e.target.closest('[data-price]');
        if (!input) return;
        const m = host._menu;
        const id = Number(input.dataset.price);
        const original = input.dataset.original;
        const entry = { ...(m.changes.get(id) || {}) };
        const value = input.value.trim().replace(',', '.');
        if (value === original) delete entry.regular_price; else entry.regular_price = value;
        if (Object.keys(entry).length) m.changes.set(id, entry); else m.changes.delete(id);
        input.classList.toggle('changed', value !== original);
        updateMenuSavebar();
      });
      list.addEventListener('change', e => {
        const input = e.target.closest('[data-enabled]');
        if (!input) return;
        const m = host._menu;
        const id = Number(input.dataset.enabled);
        const original = input.dataset.original === '1';
        const entry = { ...(m.changes.get(id) || {}) };
        if (input.checked === original) delete entry.enabled; else entry.enabled = input.checked;
        if (Object.keys(entry).length) m.changes.set(id, entry); else m.changes.delete(id);
        input.closest('.menu-row').classList.toggle('is-off', !input.checked);
        updateMenuSavebar();
      });
    }
    host._menu = m;
    saveBtn.hidden = false;
    saveBtn.onclick = () => saveMenu(page);
    renderMenuList();
  }

  function renderMenuList() {
    const page = state.page;
    const m = page?.menu;
    const list = $('#menuList');
    if (!m || !list) return;
    const q = String(m.search || '').trim().toLowerCase();
    const items = m.products.filter(p => {
      const enabled = m.changes.get(p.id)?.enabled ?? p.enabled;
      if (m.category === '__hidden' && enabled) return false;
      if (m.category !== 'all' && m.category !== '__hidden' && !p.categories.includes(m.category)) return false;
      if (q && !`${p.name} ${p.categories.join(' ')} ${p.variations.map(v => v.name).join(' ')}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const cur = m.currency || 'CHF';
    const priceInput = (id, value, sale) => {
      const changed = m.changes.get(id)?.regular_price;
      return `<span class="money-input ${sale ? 'has-sale' : ''}"><span>${esc(cur)}</span><input data-price="${id}" data-original="${esc(value)}" value="${esc(changed ?? value)}" inputmode="decimal" class="${changed !== undefined ? 'changed' : ''}" aria-label="Price"></span>${sale ? `<span class="sale-note">Sale ${esc(sale)}</span>` : ''}`;
    };
    list.innerHTML = items.length ? items.map(p => {
      const enabled = m.changes.get(p.id)?.enabled ?? p.enabled;
      return `<div class="menu-item">
        <div class="menu-row ${enabled ? '' : 'is-off'}">
          <span class="menu-main"><span class="t">${esc(p.name)}</span><span class="s">${esc(p.categories.join(', ') || 'No category')}${p.variations.length ? ` · ${plural(p.variations.length, 'size')}` : ''}</span></span>
          <label class="switch" title="${enabled ? 'Available' : 'Hidden'}"><input type="checkbox" data-enabled="${p.id}" data-original="${p.enabled ? '1' : '0'}" ${enabled ? 'checked' : ''} aria-label="${esc(p.name)} available"><span></span></label>
          ${p.variations.length ? '<span class="menu-price-slot"></span>' : `<span class="menu-price-slot">${priceInput(p.id, p.regular_price, p.sale_price)}</span>`}
        </div>
        ${p.variations.map(v => `<div class="menu-row variation"><span class="menu-main"><span class="t">${esc(v.name)}</span></span><span></span><span class="menu-price-slot">${priceInput(v.id, v.regular_price, v.sale_price)}</span></div>`).join('')}
      </div>`;
    }).join('') : '<div class="empty-box">No products match.</div>';
    updateMenuSavebar();
  }

  function updateMenuSavebar() {
    const m = state.page?.menu;
    const bar = $('#menuSavebar');
    const btn = $('#rpMenuSave');
    if (!m || !bar) return;
    const n = m.changes.size;
    bar.hidden = n === 0;
    $('#menuChangeCount').textContent = `${plural(n, 'change')} not saved`;
    btn.disabled = n === 0;
    btn.textContent = n ? `Save ${plural(n, 'change')}` : 'Save changes';
  }

  async function saveMenu(page) {
    const m = page.menu;
    if (!m || !m.changes.size) return;
    const updates = Array.from(m.changes.entries()).map(([id, change]) => ({ id, ...change }));
    const btn = $('#rpMenuSave');
    btn.disabled = true;
    try {
      const data = await api(`/admin/api/restaurants/${encodeURIComponent(page.code)}/wordpress/products`, { method: 'PATCH', body: JSON.stringify({ updates }) });
      if (state.page !== page) return;
      m.products = data.products || m.products;
      m.categories = data.categories || m.categories;
      m.changes.clear();
      toast(`${plural(updates.length, 'product change')} saved`);
      renderMenu();
    } catch (error) {
      toast(error.message, 'error');
      updateMenuSavebar();
    }
  }

  function findOrder(code, id) {
    const fromList = state.orders.find(o => o.restaurant_code === code && String(o.order_id) === String(id));
    if (fromList) return fromList;
    const r = state.page?.data;
    if (r && r.code === code) {
      const o = (r.recent_orders || []).find(x => String(x.order_id) === String(id));
      if (o) return { ...o, restaurant_code: code, restaurant_name: r.name };
    }
    return null;
  }

  function openOrder(code, id) {
    const o = findOrder(code, id);
    if (!o) { toast('Order is no longer in the recent list', 'error'); return; }
    state.drawer = { type: 'order', code, id };
    openDrawerShell();
    const st = orderStatus(o);
    const [type, typeIcon] = fulfillment(o);
    const items = Array.isArray(o.items) ? o.items : [];
    const address = o.shipping?.address || o.shipping_address || '';
    $('#drawerAvatar').className = 'avatar lg';
    $('#drawerAvatar').innerHTML = icon('receipt');
    $('#drawerTitle').textContent = `Order #${o.order_id}`;
    $('#drawerCode').textContent = `${o.restaurant_name || restaurantName(code)} · ${fmtDateTime(orderDate(o))}`;
    $('#drawerStatus').innerHTML = `<span class="pill ${st.cls}">${esc(st.label)}</span>`;
    const telHref = o.customer_phone ? `tel:${String(o.customer_phone).replace(/[^+\d]/g, '')}` : '';
    $('#drawerContent').innerHTML = `
      <div class="d-section"><div class="d-head"><h3>Summary</h3></div><div class="d-body"><div class="d-stats">
        <div class="d-stat"><span class="icon-chip accent">${icon('wallet')}</span><span class="l">Total</span><strong class="num">${esc(money(o.total, o.currency))}</strong></div>
        <div class="d-stat"><span class="icon-chip blue">${icon(typeIcon)}</span><span class="l">Type</span><strong>${esc(type)}</strong></div>
        <div class="d-stat"><span class="icon-chip amber">${icon('wallet')}</span><span class="l">Payment</span><strong>${esc(o.payment_method || '—')}</strong></div>
      </div></div></div>
      <div class="d-section"><div class="d-head"><h3>Customer</h3>${telHref ? `<a class="btn btn-secondary" href="${esc(telHref)}">${icon('phone')}Call</a>` : ''}</div><div class="d-body"><dl class="kv">
        <dt>Name</dt><dd>${esc(o.customer_name || '—')}</dd>
        <dt>Phone</dt><dd>${esc(o.customer_phone || '—')}</dd>
        <dt>Email</dt><dd>${esc(o.customer_email || '—')}</dd>
        ${address ? `<dt>Address</dt><dd>${esc(address)}</dd>` : ''}
        ${o.shipping?.method || o.shipping_method ? `<dt>Shipping</dt><dd>${esc(o.shipping?.method || o.shipping_method)}</dd>` : ''}
        ${o.table_name || o.table_number ? `<dt>Table</dt><dd>${esc(o.table_name || o.table_number)}</dd>` : ''}
      </dl></div></div>
      <div class="d-section"><div class="d-head"><h3>Items</h3><span class="muted-sm">${plural(items.reduce((s, it) => s + Number(it.quantity || 0), 0), 'item')}</span></div><div class="d-body">
        ${items.length ? items.map(it => `<div class="item-row"><span><strong>${esc(it.quantity || 1)}× ${esc(it.name)}</strong>${it.variation ? ` <span class="muted-sm">${esc(it.variation)}</span>` : ''}${(it.addons || []).length ? `<span class="addons">${it.addons.map(ad => `${esc(ad.label)}${ad.value ? ': ' + esc(ad.value) : ''}`).join(' · ')}</span>` : ''}</span><span class="num">${esc(money(it.total, o.currency))}</span></div>`).join('') : '<div class="muted-sm">No item details stored for this order.</div>'}
        <div class="item-total"><span>Total</span><span class="num">${esc(money(o.total, o.currency))}</span></div>
      </div></div>
      ${o.note ? `<div class="d-section"><div class="d-head"><h3>Customer note</h3></div><div class="d-body">${esc(o.note)}</div></div>` : ''}
      <div class="d-section"><div class="d-head"><h3>Timeline</h3></div><div class="d-body"><dl class="kv">
        <dt>Received</dt><dd>${esc(fmtDateTime(o.received_at))}</dd>
        <dt>Created in shop</dt><dd>${esc(o.date_created ? String(o.date_created).replace('T', ' ').slice(0, 16) : '—')}</dd>
        ${o.orderable_order_date || o.orderable_order_time ? `<dt>Requested for</dt><dd>${esc([o.orderable_order_date, o.orderable_order_time].filter(Boolean).join(' · '))}</dd>` : ''}
        <dt>Status</dt><dd>${esc(st.label)}</dd>
        ${o.delivered_at ? `<dt>${String(o.fulfillment_type || '').toLowerCase() === 'delivery' ? 'Delivered' : 'Completed'}</dt><dd>${esc(fmtDateTime(o.delivered_at))}${o.delivered_by && o.delivered_by !== 'Owner' ? ' · ' + esc(o.delivered_by) : ''}</dd>` : ''}
        <dt>Shop status</dt><dd>${esc(o.status || '—')} <span class="muted-sm">· last reported by WooCommerce</span></dd>
      </dl></div></div>
      <div class="actions-row"><button class="btn btn-secondary" type="button" data-open-restaurant="${esc(code)}">${icon('store')}Open ${esc(o.restaurant_name || restaurantName(code))}</button></div>`;
    bindOpeners($('#drawerContent'));
  }

  // ---------- modals ----------
  function openModal(title, html) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    $('#modalBackdrop').classList.remove('hidden');
    $('#modal').classList.remove('hidden');
  }
  let modalCloseHook = null;
  function closeModal() {
    const hook = modalCloseHook;
    modalCloseHook = null;
    hook?.();
    $('#modalBackdrop').classList.add('hidden');
    $('#modal').classList.add('hidden');
    $('#modalBody').innerHTML = '';
  }
  const modalOpen = () => !$('#modal').classList.contains('hidden');
  function modalAction(button, action) {
    return async () => {
      button.disabled = true;
      try { await action(); closeModal(); } catch (e) { toast(e.message, 'error'); button.disabled = false; }
    };
  }
  function confirmationModal(title, message, label, action) {
    openModal(title, `<p>${esc(message)}</p><div class="modal-actions"><button id="cancelModal" class="btn btn-secondary" type="button">Cancel</button><button id="confirmModal" class="btn btn-danger" type="button">${esc(label)}</button></div>`);
    $('#cancelModal').onclick = closeModal;
    $('#confirmModal').onclick = modalAction($('#confirmModal'), action);
    setTimeout(() => $('#cancelModal')?.focus(), 20);
  }
  function typedConfirmation(title, message, expected, action) {
    openModal(title, `<p>${esc(message)}</p><label class="sr-only" for="confirmText">Restaurant code</label><input id="confirmText" autocomplete="off" placeholder="${esc(expected)}"><div class="modal-actions"><button id="cancelModal" class="btn btn-secondary" type="button">Cancel</button><button id="confirmModal" class="btn btn-danger" type="button">Confirm</button></div>`);
    $('#cancelModal').onclick = closeModal;
    const run = modalAction($('#confirmModal'), action);
    $('#confirmModal').onclick = () => ($('#confirmText').value !== expected ? toast('Confirmation code does not match', 'error') : run());
    setTimeout(() => $('#confirmText')?.focus(), 20);
  }
  function inputModal(title, message, placeholder, action, type = 'text', initial = '') {
    openModal(title, `<p>${esc(message)}</p><label class="sr-only" for="modalInput">${esc(placeholder)}</label><input id="modalInput" type="${esc(type)}" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(initial)}"><div class="modal-actions"><button id="cancelModal" class="btn btn-secondary" type="button">Cancel</button><button id="confirmModal" class="btn btn-primary" type="button">Save</button></div>`);
    $('#cancelModal').onclick = closeModal;
    $('#confirmModal').onclick = () => {
      const value = $('#modalInput').value.trim();
      if (!value) return toast('Enter a value', 'error');
      return modalAction($('#confirmModal'), () => action(value))();
    };
    $('#modalInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#confirmModal').click(); });
    setTimeout(() => $('#modalInput')?.focus(), 20);
  }

  // ---------- init ----------
  // Pinch and double-tap zoom are blocked on phones (iOS ignores user-scalable=no).
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(type => document.addEventListener(type, e => e.preventDefault(), { passive: false }));

  function bindStaticEvents() {
    bindWebsitePanel();
    $('#loginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      $('#loginError').textContent = '';
      try {
        await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ username: $('#username').value.trim(), password: $('#password').value }) });
        $('#password').value = '';
        showApp();
        route();
        state.firstPaint = true;
        state.countPending = true;
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
    $('#refreshBtn').addEventListener('click', () => refreshAll());
    let searchTimer = null;
    $('#globalSearch').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.search = e.target.value.trim().toLowerCase(); renderCurrentView(); }, 120);
    });
    $('#restaurantSort').addEventListener('change', (e) => { state.restaurantSort = e.target.value; renderRestaurants(); });
    $('#ordersRestaurantFilter').addEventListener('change', renderOrders);
    $('#drawerClose').addEventListener('click', () => closeDrawer());
    $('#drawerBackdrop').addEventListener('click', () => closeDrawer());
    $('#backLink').addEventListener('click', () => switchView('restaurants'));
    window.addEventListener('popstate', () => { closeDrawer(false); closeModal(); route(); });
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalBackdrop').addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (modalOpen()) { closeModal(); return; }
      if (!$('#drawer').classList.contains('hidden')) closeDrawer();
    });
    window.addEventListener('resize', () => requestAnimationFrame(positionAllThumbs));
    setInterval(() => {
      if (document.visibilityState !== 'visible' || modalOpen() || $('#appView').classList.contains('hidden')) return;
      refreshAll({ silent: true });
    }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.overview && Date.now() - state.lastAnalyticsAt > REFRESH_MS) refreshAll({ silent: true });
    });
  }

  async function init() {
    hydrateIcons();
    bindStaticEvents();
    try {
      const session = await api('/admin/api/session');
      if (!session.authenticated) return showLogin();
      showApp();
      route();
      await refreshAll();
    } catch (_) {
      showLogin();
    }
  }

  init();
})();
