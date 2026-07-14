const express = require('express');
const router = express.Router();
const { queryOne, run } = require('../db');

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
      'cheap_api_base_url', 'cheap_api_key', 'cheap_model', 'appearance', 'wallpaper'];
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

// 测试当前API配置：用保存的settings(env回退)发一个极小请求，返回真实连通结果
router.post('/test-api', async (req, res) => {
  try {
    const s = queryOne("SELECT * FROM settings LIMIT 1") || {};
    const valid = v => (v && /^[\x21-\x7E]+$/.test(v.trim())) ? v.trim() : null;
    const warn = [];
    if (s.api_key && !valid(s.api_key)) warn.push('API Key 含中文或非法字符（你可能贴错了内容），已忽略、用服务器默认');
    if (s.api_base_url && !valid(s.api_base_url)) warn.push('API 地址含非法字符，已忽略');
    const base = valid(s.api_base_url) || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const key = valid(s.api_key) || process.env.ANTHROPIC_API_KEY;
    const model = (s.model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6').trim();
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
