const express = require('express');
const router = express.Router();
const { getStats, getCurrentPricing } = require('../gateway-tracker');

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