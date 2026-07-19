const express = require('express');
const router = express.Router();
const { getStats, getCurrentPricing, getRecentLogs } = require('../gateway-tracker');

// 最近调用日志
router.get('/logs', (req, res) => {
  try {
    res.json({ logs: getRecentLogs(req.query.limit) });
  } catch (err) {
    console.error('Gateway logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 获取用量统计
router.get('/stats', (req, res) => {
  try {
    const period = req.query.period || 'today';
    const data = getStats(period);
    res.json(data);
  } catch (err) {
    console.error('Gateway stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 获取定价
router.get('/pricing', (req, res) => {
  try {
    const data = getCurrentPricing();
    res.json(data);
  } catch (err) {
    console.error('Gateway pricing error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;