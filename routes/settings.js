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

module.exports = router;
