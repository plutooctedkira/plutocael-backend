const express = require('express');
const fs = require('fs');
const path = require('path');
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

// 读取 mcp_config.json 返回配置列表
router.get('/list', (req, res) => {
  try {
    const configPath = path.join(__dirname, '..', 'mcp_config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const servers = JSON.parse(raw);
    res.json({ ok: true, data: servers });
  } catch (err) {
    console.error('MCP list error:', err.message);
    res.status(500).json({ error: '配置文件读取失败' });
  }
});

module.exports = router;
