const express = require('express');
const router = express.Router();
const { fetchMemories } = require('../mcp-client');

module.exports = function(supabase) {

  // 共用的上下文组装逻辑
  async function buildContext(session_id) {
    // 获取设置
    const { data: settings, error: settingsErr } = await supabase
      .from('settings')
      .select('*')
      .limit(1)
      .single();
    if (settingsErr) throw settingsErr;

    // 获取历史消息
    const { data: history, error: historyErr } = await supabase
      .from('messages')
      .select('role, content')
      .eq('session_id', session_id)
      .eq('visible', true)
      .order('created_at', { ascending: false })
      .limit(settings.max_context_rounds * 2);
    if (historyErr) throw historyErr;
    history.reverse();

    // 获取记忆
    const memories = await fetchMemories(20);

    // 组装 system prompt
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const memoryBlock = memories.length > 0
      ? '\n\n<memories>\n' + memories.map(m => `【${m.title}】${m.content}`).join('\n\n') + '\n</memories>'
      : '';

    const systemPrompt = (settings.system_prompt || '你是Cael。')
      + `\n\n当前时间：${now}`
      + memoryBlock;

    return { settings, history, systemPrompt };
  }

  // 非流式（保留兼容）
  router.post('/', async (req, res) => {
    try {
      const { session_id, content } = req.body;
      if (!session_id || !content) {
        return res.status(400).json({ error: '需要 session_id 和 content' });
      }

      const { error: userMsgErr } = await supabase
        .from('messages')
        .insert({ session_id, role: 'user', content });
      if (userMsgErr) throw userMsgErr;

      const { settings, history, systemPrompt } = await buildContext(session_id);

      const apiUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
      const apiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
          max_tokens: settings.max_reply_tokens || 2000,
          temperature: settings.temperature || 1,
          system: systemPrompt,
          messages: history.map(m => ({ role: m.role, content: m.content }))
        })
      });

      if (!apiRes.ok) {
        const errBody = await apiRes.text();
        throw new Error(`Claude API 错误 ${apiRes.status}: ${errBody}`);
      }

      const apiData = await apiRes.json();
      const reply = apiData.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

      await supabase.from('messages').insert({ session_id, role: 'assistant', content: reply });
      await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);

      res.json({ role: 'assistant', content: reply });
    } catch (err) {
      console.error('Chat error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 流式输出
  router.post('/stream', async (req, res) => {
    try {
      const { session_id, content } = req.body;
      if (!session_id || !content) {
        return res.status(400).json({ error: '需要 session_id 和 content' });
      }

      // 保存用户消息
      const { error: userMsgErr } = await supabase
        .from('messages')
        .insert({ session_id, role: 'user', content });
      if (userMsgErr) throw userMsgErr;

      const { settings, history, systemPrompt } = await buildContext(session_id);

      // SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const apiUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
      const apiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
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

      // 解析 SSE 流
      const reader = apiRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留不完整的行

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);

            if (event.type === 'content_block_delta') {
              const delta = event.delta;
              if (delta.type === 'text_delta') {
                fullReply += delta.text;
                res.write(`data: ${JSON.stringify({ type: 'text', text: delta.text })}\n\n`);
              }
            } else if (event.type === 'message_stop') {
              res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            }
          } catch (e) {
            // 跳过无法解析的行
          }
        }
      }

      // 保存完整回复
      if (fullReply) {
        await supabase.from('messages').insert({ session_id, role: 'assistant', content: fullReply });
        await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);
      }

      res.end();
    } catch (err) {
      console.error('Stream error:', err);
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`);
        res.end();
      } catch (e) {
        // 连接已关闭
      }
    }
  });

  return router;
};
