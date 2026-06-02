const CHECK_INTERVAL_MS = 5 * 60 * 1000;

async function checkWebsite(url) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'FoodUp-Monitor/1.0' },
    });
    clearTimeout(timeout);
    const response_ms = Date.now() - start;
    return {
      status: response.ok ? 'online' : 'down',
      response_ms,
      http_status: response.status,
      checked_at: new Date().toISOString(),
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (e) {
    return {
      status: 'down',
      response_ms: Date.now() - start,
      http_status: null,
      checked_at: new Date().toISOString(),
      error: e.name === 'AbortError' ? 'Timeout after 10s' : e.message,
    };
  }
}

function startWebsiteMonitor(redisCommand, k, alertService) {
  async function runChecks() {
    try {
      const restaurantsResult = await redisCommand('SMEMBERS', 'restaurants');
      const restaurants = restaurantsResult.result || [];
      for (const code of restaurants) {
        try {
          const profileData = await redisCommand('GET', k(code, 'restaurant_profile'));
          if (!profileData.result) continue;
          const profile = JSON.parse(profileData.result);
          if (!profile.website) continue;
          const url = profile.website.startsWith('http')
            ? profile.website
            : `https://${profile.website}`;
          const result = await checkWebsite(url);
          await redisCommand('SET', k(code, 'website_health'), JSON.stringify(result));
          console.log(`[websiteMonitor] ${code} → ${result.status} (${result.response_ms}ms)`);
          await alertService.handleWebsiteAlert(code, result, profile.name || code);
        } catch (e) {
          console.log(`[websiteMonitor] error for ${code}:`, e.message);
        }
      }
    } catch (e) {
      console.log('[websiteMonitor] run error:', e.message);
    }
  }

  runChecks();
  setInterval(runChecks, CHECK_INTERVAL_MS);
}

module.exports = { startWebsiteMonitor, checkWebsite };
