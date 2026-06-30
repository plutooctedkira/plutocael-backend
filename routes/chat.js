const express = require('express');
const router = express.Router();
const { queryAll, queryOne, run } = require('../db');

// 消息压缩：当消息数超过阈值，用 Claude 总结旧消息
async function compressOldMessages(session_id, threshold = 40, keepRecent = 20) {
  try {
    const all = queryAll("SELECT id, role, content FROM messages WHERE session_id = ? AND visible = 1 ORDER BY id ASC", [session_id]);
    if (all.length <= threshold) return;

    const recent = all.slice(-keepRecent);
    const old = all.slice(0, -keepRecent);
    const total = old.length;
    if (total === 0) return;

    // 近期（最后40%）→ 详细，中期（中间30%）→ 概括，早期（最前30%）→ 极简
    const recentStart = Math.floor(total * 0.6);
    const midStart = Math.floor(total * 0.3);
    const oldRecent = old.slice(recentStart);
    const oldMid = old.slice(midStart, recentStart);
    const oldEarly = old.slice(0, midStart);

    const buildLayer = (msgs) => msgs.map(m => `[${m.role}]: ${m.content}`).join('\n');
    const layerText = `【近期对话-详细记录】\n${buildLayer(oldRecent)}\n\n【中期对话-概括】\n${buildLayer(oldMid)}\n\n【早期对话-极简记录】\n${buildLayer(oldEarly)}`;

    const compressPrompt = `请将以下分层对话历史压缩成摘要。
${layerText}
输出要求：
用第三人称。按以下格式输出：
【近期】（500-800字）详细记录最近的对话
【中期】（200-350字）概括较早的对话
【早期】（80-150字）极简记录最早的对话
关键规则：
1. 必须保留所有日程、日期、时间、约定
2. 必须保留具体的数字、人名、地点
3. 必须保留所有承诺和待办
4. 禁止用"讨论了""聊到了"这种空话替代具体内容`;

    const settings = queryOne("SELECT * FROM settings LIMIT 1");
    const apiBaseUrl = ((settings && settings.api_base_url) || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
    const apiKey = (settings && settings.api_key) || process.env.ANTHROPIC_API_KEY;
    const compressModels = ['claude-opus-4-6', 'claude-sonnet-4-6'];

    let summary = null;
    for (const model of compressModels) {
      try {
        const resp = await fetch(apiBaseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model,
            max_tokens: 2000,
            temperature: 0.3,
            system: '你是一个专业的对话摘要助手。请严格按照要求的格式输出摘要，保留所有关键信息。',
            messages: [{ role: 'user', content: compressPrompt }]
          })
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        summary = data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
        if (summary) break;
      } catch (e) {}
    }
    if (!summary) return; // 摘要失败不打断主流程

    run("UPDATE sessions SET summary = ? WHERE id = ?", [summary, session_id]);

    // 删除已压缩的旧消息
    const oldIds = old.map(m => m.id);
    if (oldIds.length > 0) {
      const placeholders = oldIds.map(() => '?').join(',');
      run(`DELETE FROM messages WHERE id IN (${placeholders})`, oldIds);
    }
  } catch (e) { /* 压缩异常不打断对话 */ }
}

// 共用的上下文组装逻辑
async function buildContext(session_id) {
  const settings = queryOne("SELECT * FROM settings LIMIT 1");
  if (!settings) throw new Error("设置不存在");

  // 先尝试压缩旧消息
  await compressOldMessages(session_id);

  // 取当前可见消息
  const history = queryAll(
    "SELECT role, content FROM messages WHERE session_id = ? AND visible = 1 ORDER BY created_at DESC LIMIT ?",
    [session_id, (settings.max_context_rounds || 10) * 2]
  ).reverse();

  // 如果有摘要，放在历史消息最前面
  const sess = queryOne("SELECT summary FROM sessions WHERE id = ?", [session_id]);
  if (sess && sess.summary) {
    history.unshift({ role: 'assistant', content: `[对话历史摘要]\n${sess.summary}` });
  }

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const systemPrompt = (settings.system_prompt || '你是Cael。')
    + `\n\n当前时间：${now}`;

  const apiBaseUrl = (settings.api_base_url || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
  const apiKey = settings.api_key || process.env.ANTHROPIC_API_KEY;
  const model = settings.model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

  return { settings, history, systemPrompt, apiBaseUrl, apiKey, model };
}

// 非流式
router.post('/', async (req, res) => {
  try {
    const { session_id, content } = req.body;
    if (!session_id || !content) return res.status(400).json({ error: '需要 session_id 和 content' });

    run("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)", [session_id, content]);

    const { settings, history, systemPrompt, apiBaseUrl, apiKey, model } = await buildContext(session_id);

    const apiRes = await fetch(apiBaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: settings.max_reply_tokens || 2000,
        temperature: settings.temperature || 1,
        system: systemPrompt,
        messages: history.map(m => ({ role: m.role, content: m.content }))
      })
    });

    if (!apiRes.ok) { const errBody = await apiRes.text(); throw new Error(`Claude API 错误 ${apiRes.status}: ${errBody}`); }

    const apiData = await apiRes.json();
    const reply = apiData.content.filter(b => b.type === 'text').map(b => b.text).join('');

    run("INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)", [session_id, reply]);
    run("UPDATE sessions SET updated_at = datetime('now', '+8 hours') WHERE id = ?", [session_id]);

    res.json({ role: 'assistant', content: reply });
  } catch (err) { console.error('Chat error:', err); res.status(500).json({ error: err.message }); }
});

// 流式
router.post('/stream', async (req, res) => {
  try {
    const { session_id, content } = req.body;
    if (!session_id || !content) return res.status(400).json({ error: '需要 session_id 和 content' });

    run("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)", [session_id, content]);

    const { settings, history, systemPrompt, apiBaseUrl, apiKey, model } = await buildContext(session_id);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const apiRes = await fetch(apiBaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: settings.max_reply_tokens || 2000,
        temperature: settings.temperature || 1,
        system: systemPrompt,
        messages: history.map(m => ({ role: m.role, content: m.content })),
        stream: true
      })
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      res.write(`data: ${JSON.stringify({ type: 'error', text: errBody })}\n\n`);
      res.end();
      return;
    }

    let fullReply = '';
    const reader = apiRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            fullReply += event.delta.text;
            res.write(`data: ${JSON.stringify({ type: 'text', text: event.delta.text })}\n\n`);
          } else if (event.type === 'message_stop') {
            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
          }
        } catch (e) {}
      }
    }

    if (fullReply) {
      run("INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)", [session_id, fullReply]);
      run("UPDATE sessions SET updated_at = datetime('now', '+8 hours') WHERE id = ?", [session_id]);
    }
    res.end();
  } catch (err) {
    console.error('Stream error:', err);
    try { res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`); res.end(); } catch (e) {}
  }
});

module.exports = router;
