const express = require('express');
const router = express.Router();

function createMonitoringRoutes(redisCommand, k, dashPassword) {
  router.get('/website-health/:code', async (req, res) => {
    const { p } = req.query;
    if (p !== dashPassword) return res.json({ success: false, message: 'Unauthorized' });
    const code = req.params.code.toLowerCase().trim();
    const data = await redisCommand('GET', k(code, 'website_health'));
    if (data.result) {
      res.json({ success: true, health: JSON.parse(data.result) });
    } else {
      res.json({ success: false, message: 'No data yet' });
    }
  });

  router.get('/debug-logs/:code', async (req, res) => {
    const { p } = req.query;
    if (p !== dashPassword) return res.json({ success: false, message: 'Unauthorized' });
    const code = req.params.code.toLowerCase().trim();
    const data = await redisCommand('LRANGE', k(code, 'debug_logs'), 0, 49);
    const logs = (data.result || []).map(l => {
      try { return JSON.parse(l); } catch (e) { return { message: l, ts: '' }; }
    });
    res.json({ success: true, logs });
  });

  router.delete('/debug-logs/:code', async (req, res) => {
    const { p } = req.query;
    if (p !== dashPassword) return res.json({ success: false, message: 'Unauthorized' });
    const code = req.params.code.toLowerCase().trim();
    await redisCommand('DEL', k(code, 'debug_logs'));
    res.json({ success: true });
  });

  return router;
}

module.exports = { createMonitoringRoutes };
