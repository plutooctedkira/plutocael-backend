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

// 新建 MCP 记忆
router.post('/memories', async (req, res) => {
  try {
    const { title, content, importance, author, layer } = req.body;
    if (!content) return res.status(400).json({ error: '需要 content' });
    const r = await callTool('memory_create', {
      title: title || content.slice(0, 20), content,
      importance: importance || 3, author: author || 'Jasmine', layer: layer || 'episodic'
    });
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 更新 MCP 记忆
router.put('/memories/:id', async (req, res) => {
  try {
    const { title, content, importance, layer } = req.body;
    const args = { id: parseInt(req.params.id) };
    if (title !== undefined) args.title = title;
    if (content !== undefined) args.content = content;
    if (importance !== undefined) args.importance = importance;
    if (layer !== undefined) args.layer = layer;
    const r = await callTool('memory_update', args);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 删除 MCP 记忆
router.delete('/memories/:id', async (req, res) => {
  try {
    const r = await callTool('memory_delete', { id: parseInt(req.params.id) });
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// ===== MCP 配置管理 =====

// 列出所有 MCP 配置
router.get('/config', (req, res) => {
  try {
    const configPath = path.join(__dirname, '..', 'mcp_config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    res.json({ ok: true, data: JSON.parse(raw) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 添加 MCP 服务器
router.post('/config', (req, res) => {
  try {
    const { name, url, command, args, env } = req.body;
    if (!name) return res.status(400).json({ error: '需要 name' });
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mcp_config.json'), 'utf-8'));
    const item = { id: Date.now(), name, url: url || '', command: command || '', args: args || '', env: env || '', enabled: true, status: 'deployed', deployedAt: new Date().toLocaleString('zh-CN'), tools: [] };
    list.push(item);
    fs.writeFileSync(path.join(__dirname, '..', 'mcp_config.json'), JSON.stringify(list, null, 2), 'utf-8');
    res.json({ ok: true, data: item });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 更新配置（含启用/停用开关）
router.put('/config/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mcp_config.json'), 'utf-8'));
    const idx = list.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: '未找到' });
    ['name', 'url', 'command', 'args', 'env', 'enabled', 'status'].forEach(k => { if (req.body[k] !== undefined) list[idx][k] = req.body[k]; });
    fs.writeFileSync(path.join(__dirname, '..', 'mcp_config.json'), JSON.stringify(list, null, 2), 'utf-8');
    res.json({ ok: true, data: list[idx] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 删除配置
router.delete('/config/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mcp_config.json'), 'utf-8')).filter(c => c.id !== id);
    fs.writeFileSync(path.join(__dirname, '..', 'mcp_config.json'), JSON.stringify(list, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
