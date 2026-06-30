const express = require('express');
const router = express.Router();
const { listTools, callTool, fetchMemories, searchMemories, MCP_URL } = require('../mcp-client');

// 获取 MCP 服务器状态
router.get('/status', (req, res) => {
  res.json({ ok: true, url: MCP_URL });
});

// 列出所有可用工具
router.get('/tools', async (req, res) => {
  try {
    const tools = await listTools();
    res.json({ ok: true, tools });
  } catch (err) {
    console.error('MCP tools error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 调用 MCP 工具
router.post('/call', async (req, res) => {
  try {
    const { tool, args } = req.body;
    if (!tool) return res.status(400).json({ error: '需要 tool 参数' });
    const result = await callTool(tool, args || {});
    res.json(result);
  } catch (err) {
    console.error('MCP call error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 获取 MCP 记忆列表
router.get('/memories', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const data = await fetchMemories(limit);
    res.json({ ok: true, data });
  } catch (err) {
    console.error('MCP memories error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 搜索 MCP 记忆
router.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: '需要查询参数 q' });
    const limit = parseInt(req.query.limit) || 10;
    const data = await searchMemories(q, limit);
    res.json({ ok: true, data });
  } catch (err) {
    console.error('MCP search error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;