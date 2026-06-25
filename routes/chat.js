const express = require('express');
const router = express.Router();
const { queryAll, queryOne, run } = require('../db');
const { fetchMemories } = require('../mcp-client');

// 共用的上下文组装逻辑
async function buildContext(session_id) {
  const settings = queryOne("SELECT * FROM settings LIMIT 1");
  if (!settings) throw new Error("设置不存在");

  const history = queryAll(
    "SELECT role, content FROM messages WHERE session_id = ? AND visible = 1 ORDER BY created_at DESC LIMIT ?",
    [session_id, (settings.max_context_rounds || 10) * 2]
  ).reverse();

  const memories = await fetchMemories(20);

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const memoryBlock = memories.length > 0
    ? '\n\n<memories>\n' + memories.map(m => `【${m.title}】${m.content}`).join('\n\n') + '\n</memories>'
    : '';

  const systemPrompt = (settings.system_prompt || '你是Cael。')
    + `\n\n当前时间：${now}`
    + memoryBlock;

  return { settings, history, systemPrompt };
}

// 非流式
router.post('/', async (req, res) => {
  try {
    const { session_id, content } = req.body;
    if (!session_id || !content) return res.status(400).json({ error: '需要 session_id 和 content' });

    run("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)", [session_id, content]);

    const { settings, history, systemPrompt } = await buildContext(session_id);

    const apiUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
    const apiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
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

    const { settings, history, systemPrompt } = await buildContext(session_id);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const apiUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
    const apiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
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
