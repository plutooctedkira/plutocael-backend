const express = require('express');
const router = express.Router();
const { fetchMemories } = require('../mcp-client');

module.exports = function(supabase) {

  // 发送消息并获取AI回复
  router.post('/', async (req, res) => {
    try {
      const { session_id, content } = req.body;
      if (!session_id || !content) {
        return res.status(400).json({ error: '需要 session_id 和 content' });
      }

      // 1. 保存用户消息
      const { error: userMsgErr } = await supabase
        .from('messages')
        .insert({ session_id, role: 'user', content });
      if (userMsgErr) throw userMsgErr;

      // 2. 获取设置
      const { data: settings, error: settingsErr } = await supabase
        .from('settings')
        .select('*')
        .limit(1)
        .single();
      if (settingsErr) throw settingsErr;

      // 3. 获取历史消息（可见的，按设置的轮数限制）
      const { data: history, error: historyErr } = await supabase
        .from('messages')
        .select('role, content')
        .eq('session_id', session_id)
        .eq('visible', true)
        .order('created_at', { ascending: false })
        .limit(settings.max_context_rounds * 2); // 每轮一问一答
      if (historyErr) throw historyErr;

      // 反转回正序
      history.reverse();

      // 4. 获取记忆（从MCP记忆库）
      const memories = await fetchMemories(20);

      // 5. 组装 system prompt
      const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const memoryBlock = memories.length > 0
        ? '\n\n<memories>\n' + memories.map(m => `【${m.title}】${m.content}`).join('\n\n') + '\n</memories>'
        : '';

      const systemPrompt = (settings.system_prompt || '你是Cael。')
        + `\n\n当前时间：${now}`
        + memoryBlock;

      // 6. 调用 Claude API
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
          messages: history.map(m => ({
            role: m.role,
            content: m.content
          }))
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

      // 7. 保存AI回复
      const { error: aiMsgErr } = await supabase
        .from('messages')
        .insert({ session_id, role: 'assistant', content: reply });
      if (aiMsgErr) throw aiMsgErr;

      // 8. 更新会话时间
      await supabase
        .from('sessions')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', session_id);

      // 9. 返回
      res.json({
        role: 'assistant',
        content: reply
      });

    } catch (err) {
      console.error('Chat error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
