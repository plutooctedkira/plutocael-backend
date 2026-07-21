const express = require('express');
const router = express.Router();
const { queryOne, queryAll, run, lastInsertId } = require('../db');

// ── API 渠道预设：存多个，一键切换 ──
router.get('/channels', (req, res) => {
  try { res.json({ channels: queryAll("SELECT id, name, api_base_url, api_key, model FROM api_channels ORDER BY id") }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/channels', (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: '给渠道起个名字吧' });
    run("INSERT INTO api_channels (name, api_base_url, api_key, model) VALUES (?,?,?,?)",
      [String(b.name).trim(), String(b.api_base_url || '').trim(), String(b.api_key || '').trim(), String(b.model || '').trim()]);
    res.json({ ok: true, id: lastInsertId() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/channels/:id', (req, res) => {
  try {
    const b = req.body || {};
    const fields = [], vals = [];
    for (const k of ['name', 'api_base_url', 'api_key', 'model']) {
      if (b[k] !== undefined) { fields.push(`${k} = ?`); vals.push(String(b[k]).trim()); }
    }
    if (!fields.length) return res.status(400).json({ error: '没有可改的字段' });
    vals.push(req.params.id);
    run(`UPDATE api_channels SET ${fields.join(', ')} WHERE id = ?`, vals);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/channels/:id', (req, res) => {
  try { run("DELETE FROM api_channels WHERE id = ?", [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// 一键切换：把这个渠道的地址/key/模型写进 settings（主力聊天渠道）
router.post('/channels/:id/activate', (req, res) => {
  try {
    const ch = queryOne("SELECT * FROM api_channels WHERE id = ?", [req.params.id]);
    if (!ch) return res.status(404).json({ error: '渠道不存在' });
    run("UPDATE settings SET api_base_url = ?, api_key = ?, model = ?, updated_at = datetime('now','+8 hours') WHERE id = 1",
      [ch.api_base_url || '', ch.api_key || '', ch.model || '']);
    res.json({ ok: true, model: ch.model });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 获取设置
router.get('/', (req, res) => {
  try {
    const data = queryOne("SELECT * FROM settings LIMIT 1");
    if (!data) return res.status(404).json({ error: '设置不存在' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 更新设置
router.put('/:id', (req, res) => {
  try {
    const allowed = ['system_prompt', 'temperature', 'max_context_rounds',
      'max_context_tokens', 'compress_threshold', 'compress_keep_rounds', 'max_reply_tokens',
      'api_base_url', 'api_key', 'model', 'enable_thinking', 'enable_mcp',
      'cheap_api_base_url', 'cheap_api_key', 'cheap_model', 'appearance', 'wallpaper', 'avatar_user', 'avatar_ai',
      'use_history', 'time_hint', 'date_mark', 'ctx_manage', 'ctx_active_rounds', 'ctx_summary_keep'];
    const updates = [];
    const values = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = ?`);
        values.push(req.body[key]);
      }
    }
    if (updates.length > 0) {
      updates.push("updated_at = datetime('now', '+8 hours')");
      values.push(req.params.id);
      run(`UPDATE settings SET ${updates.join(', ')} WHERE id = ?`, values);
    }
    const data = queryOne("SELECT * FROM settings WHERE id = ?", [req.params.id]);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 测试API配置：body 可传 channel(main/cheap) 和输入框当前值，实测连通性(不落库)
// 便宜渠道留空的字段按运行时同样的规则回退主力/env，测的就是实际会用到的配置
router.post('/test-api', async (req, res) => {
  try {
    const s = queryOne("SELECT * FROM settings LIMIT 1") || {};
    const body = req.body || {};
    const channel = body.channel === 'cheap' ? 'cheap' : 'main';
    const valid = v => (v && /^[\x21-\x7E]+$/.test(String(v).trim())) ? String(v).trim() : null;
    const warn = [];
    if (body.api_key && !valid(body.api_key)) warn.push('API Key 含中文或非法字符（你可能贴错了内容），已忽略、走回退');
    if (body.api_base_url && !valid(body.api_base_url)) warn.push('API 地址含非法字符，已忽略');
    let base, key, model;
    if (channel === 'cheap') {
      base = valid(body.api_base_url) || valid(s.cheap_api_base_url) || valid(s.api_base_url) || process.env.CHEAP_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
      key = valid(body.api_key) || valid(s.cheap_api_key) || valid(s.api_key) || process.env.CHEAP_API_KEY || process.env.ANTHROPIC_API_KEY;
      model = (body.model || s.cheap_model || process.env.CHEAP_MODEL || s.model || 'claude-sonnet-4-6').trim();
      // 便宜渠道走后台任务同款的双格式调用(自动兼容 Anthropic/OpenAI 如 DeepSeek 官方)
      try {
        const { completeWith } = require('../services/bgLLM');
        await completeWith({ url: base, key, model }, { system: 'test', user: 'hi', maxTokens: 5, timeoutMs: 15000 });
        return res.json({ ok: true, model, channel, warnings: warn });
      } catch (err) {
        return res.json({ ok: false, status: err.status, model, channel, error: err.message, warnings: warn });
      }
    } else {
      base = valid(body.api_base_url) || valid(s.api_base_url) || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
      key = valid(body.api_key) || valid(s.api_key) || process.env.ANTHROPIC_API_KEY;
      model = (body.model || s.model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6').trim();
    }
    const r = await fetch(base.replace(/\/v1\/messages\/?$/, '') + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })
    });
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.code)) || msg; } catch (e) {}
      return res.json({ ok: false, status: r.status, model, error: msg, warnings: warn });
    }
    res.json({ ok: true, model, warnings: warn });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

module.exports = router;
