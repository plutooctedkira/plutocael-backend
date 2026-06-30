const express = require('express');
const router = express.Router();
const { hybridSearch } = require('../vector-search');

// 混合搜索记忆和对话
router.get('/', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: '需要查询参数 q' });
    const limit = parseInt(req.query.limit) || 8;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const apiBaseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
    const results = await hybridSearch(q, limit, apiKey, apiBaseUrl, true);
    res.json({ query: q, results });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;