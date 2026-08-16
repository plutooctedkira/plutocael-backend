const express = require('express');
const router = express.Router();
const { queryOne, queryAll, run, lastInsertId } = require('../db');

// ── Skill：额外指令块，启用的追加到 system prompt 末尾 ──
router.get('/skills', (req, res) => {
  try { res.json({ skills: queryAll("SELECT id, name, content, grp, active FROM skills ORDER BY grp, ord, id") }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/skills', (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: '给 skill 起个名字' });
    run("INSERT INTO skills (name, content, grp) VALUES (?,?,?)", [String(b.name).trim(), String(b.content || ''), String(b.grp || '').trim()]);
    res.json({ ok: true, id: lastInsertId() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/skills/:id', (req, res) => {
  try {
    const b = req.body || {};
    const fields = [], vals = [];
    for (const k of ['name', 'content', 'grp', 'active']) {
      if (b[k] !== undefined) { fields.push(`${k} = ?`); vals.push(k === 'active' ? (b[k] ? 1 : 0) : (k === 'name' || k === 'grp' ? String(b[k]).trim() : String(b[k]))); }
    }
    if (!fields.length) return res.status(400).json({ error: '没有可改的字段' });
    vals.push(req.params.id);
    run(`UPDATE skills SET ${fields.join(', ')} WHERE id = ?`, vals);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/skills/:id', (req, res) => {
  try { run("DELETE FROM skills WHERE id = ?", [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 各类任务用哪个渠道 ──
const { TASKS } = require('../services/tasks'); // 与用量记账共用同一份清单

router.get('/task-models', (req, res) => {
  try {
    const rows = queryAll("SELECT task, channel_id FROM task_models");
    const map = Object.fromEntries(rows.map(r => [r.task, r.channel_id]));
    res.json({ tasks: TASKS, assigned: map });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// channel_id 为 null/空 = 取消指定，回到默认回退链
router.put('/task-models/:task', (req, res) => {
  try {
    const task = String(req.params.task);
    if (!TASKS.some(t => t.key === task)) return res.status(400).json({ error: '未知任务' });
    const cid = req.body && req.body.channel_id;
    run("DELETE FROM task_models WHERE task = ?", [task]);
    if (cid) run("INSERT INTO task_models (task, channel_id) VALUES (?, ?)", [task, Number(cid)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    const allowed = ['system_prompt', 'user_prompt', 'temperature', 'max_context_rounds',
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
    // 主力/便宜的区分已经去掉了，测试一律走双格式探测：
    // 先试 Anthropic(/v1/messages)，不通再试 OpenAI(/v1/chat/completions)，
    // 这样第三方中转和 DeepSeek 官方这类 OpenAI 格式的都能测通
    const base = valid(body.api_base_url) || valid(s.api_base_url) || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const key = valid(body.api_key) || valid(s.api_key) || process.env.ANTHROPIC_API_KEY;
    const model = (body.model || s.model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6').trim();
    try {
      const { completeWith } = require('../services/bgLLM');
      await completeWith({ url: base, key, model }, { system: 'test', user: 'hi', maxTokens: 5, timeoutMs: 15000 });
      return res.json({ ok: true, model, channel, warnings: warn });
    } catch (err) {
      return res.json({ ok: false, status: err.status, model, channel, error: err.message, warnings: warn });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

module.exports = router;
