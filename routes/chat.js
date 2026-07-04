const express = require('express');
const router = express.Router();
const { queryAll, queryOne, run, getBackgroundApiConfig } = require('../db');
const { logUsage } = require('../gateway-tracker');
const { listTools, callTool } = require('../mcp-client');

// MCP 工具列表缓存（60秒），避免每条消息都连一次 MCP 服务器
let mcpToolsCache = { tools: [], ts: 0 };
async function getMcpTools() {
  if (Date.now() - mcpToolsCache.ts < 60000) return mcpToolsCache.tools;
  const raw = await listTools();
  const tools = raw.map(t => ({
    name: t.name,
    description: t.description || '',
    input_schema: (t.inputSchema && t.inputSchema.type) ? t.inputSchema : { type: 'object', properties: {} }
  }));
  mcpToolsCache = { tools, ts: Date.now() };
  return tools;
}

// 执行一批工具调用，返回 tool_result 块（并记录日志行）
async function execToolUses(toolUses, toolLogLines, onEvent) {
  const toolResults = [];
  for (const tu of toolUses) {
    toolLogLines.push(`→ 调用 ${tu.name} ${JSON.stringify(tu.input || {})}`);
    if (onEvent) onEvent({ type: 'tool_use', name: tu.name, input: tu.input || {} });
    const result = await callTool(tu.name, tu.input || {});
    const outputText = result.success ? String(result.output) : `工具调用失败: ${result.error}`;
    toolLogLines.push(`✓ 返回: ${outputText.substring(0, 300)}`);
    if (onEvent) onEvent({ type: 'tool_result', name: tu.name, output: outputText.substring(0, 500) });
    toolResults.push({
      type: 'tool_result',
      tool_use_id: tu.id,
      content: outputText.substring(0, 4000),
      ...(result.success ? {} : { is_error: true })
    });
  }
  return toolResults;
}

const MAX_TOOL_ROUNDS = 5;

// 消息压缩：当消息数超过阈值，用 Claude 总结旧消息
async function compressOldMessages(session_id, threshold = 40, keepRecent = 20) {
  try {
    const all = queryAll("SELECT id, role, content, msg_type FROM messages WHERE session_id = ? AND visible = 1 ORDER BY id ASC", [session_id]);
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

    const buildLayer = (msgs) => msgs.map(m => `[${m.role}]: ${m.msg_type === 'image' ? '[图片]' : m.content}`).join('\n');
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
    // 压缩用便宜渠道，省主力额度（cheap_* 未配则回退主力）
    const bg = getBackgroundApiConfig();
    const compressModels = bg.model ? [bg.model, 'claude-sonnet-4-6'] : ['claude-opus-4-6', 'claude-sonnet-4-6'];

    let summary = null;
    for (const model of compressModels) {
      try {
        const resp = await fetch(bg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': bg.key, 'anthropic-version': '2023-06-01' },
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

  // 取当前可见消息（图片消息转成 Claude vision 内容块）
  const history = queryAll(
    "SELECT role, content, msg_type FROM messages WHERE session_id = ? AND visible = 1 ORDER BY id DESC LIMIT ?",
    [session_id, (settings.max_context_rounds || 10) * 2]
  ).reverse().map(m => {
    if (m.msg_type === 'image') {
      try {
        const img = JSON.parse(m.content);
        const blocks = [{ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } }];
        if (img.text) blocks.push({ type: 'text', text: img.text });
        return { role: m.role, content: blocks };
      } catch (e) { return { role: m.role, content: '[图片]' }; }
    }
    return { role: m.role, content: m.content };
  });

  // 如果有摘要，放在历史消息最前面
  const sess = queryOne("SELECT summary FROM sessions WHERE id = ?", [session_id]);
  if (sess && sess.summary) {
    history.unshift({ role: 'assistant', content: `[对话历史摘要]\n${sess.summary}` });
  }

  // Prompt Cache 原则：稳定内容在前（可缓存），易变内容在后
  // 人设+记忆+留言 → 变化少，打 cache 标记；当前时间 → 每次都变，放最后单独一块
  let stablePart = settings.system_prompt || '你是Cael。';

  // MCP 开启时，明确告诉 Cael 它拥有记忆库能力，避免被追问时自我否认、幻觉工具
  if (settings.enable_mcp) {
    stablePart += '\n\n【你的记忆系统】你连接着一个持久记忆库（MCP），里面存着你和 Jasmine 过去的记忆、留言板、你的人设设定。'
      + '你可以用 memory_search（搜索记忆）、memory_list（列出记忆）、about_list（查你的人设）、message_list（看留言板）等工具随时查询。'
      + '这是真实存在的、跨对话保留的记忆——不是幻觉。聊到过去的约定、事件、Jasmine 的偏好，或被问起记忆相关的事时，先调用工具查询再回答，不要凭空猜测或否认自己有记忆。';
  }

  // 注入记忆库：按重要性取前20条，作为对话背景
  const mems = queryAll("SELECT content, category, importance FROM memories ORDER BY importance DESC, updated_at DESC LIMIT 20");
  if (mems.length > 0) {
    stablePart += '\n\n【记忆库】以下是之前保存的记忆，是过去窗口留下的信息：\n'
      + mems.map(m => `- [${m.category}] ${m.content}`).join('\n');
  }

  // 注入留言板：最近5条留言（带时间），Cael 聊天时能看到
  const boardMsgs = queryAll("SELECT content, created_at FROM board_messages ORDER BY id DESC LIMIT 5");
  if (boardMsgs.length > 0) {
    stablePart += '\n\n【留言板】Jasmine 最近的留言（最新的在前）：\n'
      + boardMsgs.map(b => `- [${b.created_at}] ${b.content}`).join('\n');
  }

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const systemPrompt = [
    { type: 'text', text: stablePart, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `当前时间：${now}` }
  ];

  const apiBaseUrl = (settings.api_base_url || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
  const apiKey = settings.api_key || process.env.ANTHROPIC_API_KEY;
  const model = settings.model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

  return { settings, history, systemPrompt, apiBaseUrl, apiKey, model };
}

// 组装请求体：开启 thinking 时用 adaptive 模式（此时不传 temperature，两者不兼容）
function buildRequestBody(settings, model, systemPrompt, messages, stream = false, tools = null) {
  const body = {
    model,
    max_tokens: settings.max_reply_tokens || 2000,
    system: systemPrompt,
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  };
  if (settings.enable_thinking) {
    body.thinking = { type: 'adaptive' };
  } else {
    body.temperature = settings.temperature ?? 1;
  }
  if (tools && tools.length > 0) body.tools = tools;
  if (stream) body.stream = true;
  return body;
}

// 保存用户消息（支持带图片）
function saveUserMessage(session_id, content, image) {
  if (image && image.data && image.media_type) {
    run("INSERT INTO messages (session_id, role, content, msg_type) VALUES (?, 'user', ?, 'image')",
      [session_id, JSON.stringify({ text: content || '', media_type: image.media_type, data: image.data })]);
  } else {
    run("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)", [session_id, content]);
  }
}

// 非流式
router.post('/', async (req, res) => {
  try {
    const { session_id, content, image } = req.body;
    if (!session_id || (!content && !image)) return res.status(400).json({ error: '需要 session_id 和 content' });

    saveUserMessage(session_id, content, image);

    const { settings, history, systemPrompt, apiBaseUrl, apiKey, model } = await buildContext(session_id);

    // MCP 工具（开关开启且服务器可达时启用，失败则退化为普通聊天）
    let mcpTools = [];
    if (settings.enable_mcp) { try { mcpTools = await getMcpTools(); } catch (e) {} }

    const messages = history.map(m => ({ role: m.role, content: m.content }));
    let reply = '', reasoning = '';
    const toolLogLines = [];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const apiRes = await fetch(apiBaseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(buildRequestBody(settings, model, systemPrompt, messages, false, mcpTools))
      });

      if (!apiRes.ok) { const errBody = await apiRes.text(); throw new Error(`Claude API 错误 ${apiRes.status}: ${errBody}`); }

      const apiData = await apiRes.json();
      try { logUsage(session_id, model, apiData.usage); } catch (e) { console.warn('logUsage failed:', e.message); }

      reply += apiData.content.filter(b => b.type === 'text').map(b => b.text).join('');
      reasoning += apiData.content.filter(b => b.type === 'thinking').map(b => b.thinking).join('');

      if (apiData.stop_reason !== 'tool_use') break;

      // Cael 要调工具：执行后把结果喂回去继续
      const toolUses = apiData.content.filter(b => b.type === 'tool_use');
      messages.push({ role: 'assistant', content: apiData.content });
      const toolResults = await execToolUses(toolUses, toolLogLines);
      messages.push({ role: 'user', content: toolResults });
    }

    // 兜底：一直调工具没吐正文 → 不带工具强制再答一次
    if (!reply.trim()) {
      try {
        const apiRes2 = await fetch(apiBaseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(buildRequestBody(settings, model, systemPrompt, messages, false, null))
        });
        if (apiRes2.ok) {
          const d2 = await apiRes2.json();
          reply += (d2.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        }
      } catch (e) { console.warn('兜底回复失败:', e.message); }
    }

    const toolLog = toolLogLines.length ? toolLogLines.join('\n') : null;
    run("INSERT INTO messages (session_id, role, content, reasoning_content, tool_log) VALUES (?, 'assistant', ?, ?, ?)", [session_id, reply, reasoning || null, toolLog]);
    run("UPDATE sessions SET updated_at = datetime('now', '+8 hours') WHERE id = ?", [session_id]);

    res.json({ role: 'assistant', content: reply, reasoning_content: reasoning || null, tool_log: toolLog });
  } catch (err) { console.error('Chat error:', err); res.status(500).json({ error: err.message }); }
});

// 流式
router.post('/stream', async (req, res) => {
  try {
    const { session_id, content, image } = req.body;
    if (!session_id || (!content && !image)) return res.status(400).json({ error: '需要 session_id 和 content' });

    saveUserMessage(session_id, content, image);

    const { settings, history, systemPrompt, apiBaseUrl, apiKey, model } = await buildContext(session_id);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // MCP 工具（开关开启且服务器可达时启用，失败则退化为普通聊天）
    let mcpTools = [];
    if (settings.enable_mcp) { try { mcpTools = await getMcpTools(); } catch (e) {} }

    const messages = history.map(m => ({ role: m.role, content: m.content }));
    let fullReply = '';
    let fullThinking = '';
    const toolLogLines = [];
    const usage = {};

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const apiRes = await fetch(apiBaseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(buildRequestBody(settings, model, systemPrompt, messages, true, mcpTools))
      });

      if (!apiRes.ok) {
        const errBody = await apiRes.text();
        sse({ type: 'error', text: errBody });
        res.end();
        return;
      }

      // 解析本轮 SSE，重组内容块（工具调用循环需要把完整的块喂回 API）
      const assistantContent = [];
      let curBlock = null, curJson = '';
      let stopReason = null, roundOutput = 0;
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
          try {
            const event = JSON.parse(line.slice(6).trim());
            if (event.type === 'content_block_start') {
              const b = event.content_block;
              if (b.type === 'tool_use') { curBlock = { type: 'tool_use', id: b.id, name: b.name }; curJson = ''; }
              else if (b.type === 'thinking') curBlock = { type: 'thinking', thinking: '' };
              else if (b.type === 'redacted_thinking') curBlock = { type: 'redacted_thinking', data: b.data };
              else curBlock = { type: 'text', text: '' };
            } else if (event.type === 'content_block_delta' && curBlock) {
              const d = event.delta;
              if (d.type === 'text_delta') {
                curBlock.text += d.text; fullReply += d.text;
                sse({ type: 'text', text: d.text });
              } else if (d.type === 'thinking_delta') {
                curBlock.thinking += d.thinking; fullThinking += d.thinking;
                sse({ type: 'thinking', text: d.thinking });
              } else if (d.type === 'signature_delta') {
                curBlock.signature = (curBlock.signature || '') + d.signature;
              } else if (d.type === 'input_json_delta') {
                curJson += d.partial_json;
              }
            } else if (event.type === 'content_block_stop' && curBlock) {
              if (curBlock.type === 'tool_use') {
                try { curBlock.input = curJson ? JSON.parse(curJson) : {}; } catch (e) { curBlock.input = {}; }
              }
              assistantContent.push(curBlock);
              curBlock = null;
            } else if (event.type === 'message_start' && event.message?.usage) {
              for (const [k, v] of Object.entries(event.message.usage)) {
                if (typeof v === 'number' && k !== 'output_tokens') usage[k] = (usage[k] || 0) + v;
              }
            } else if (event.type === 'message_delta') {
              if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
              if (event.usage?.output_tokens) roundOutput = event.usage.output_tokens;
            }
          } catch (e) {}
        }
      }

      usage.output_tokens = (usage.output_tokens || 0) + roundOutput;

      if (stopReason !== 'tool_use') break;

      // Cael 要调工具：执行后把结果喂回去，进入下一轮
      const toolUses = assistantContent.filter(b => b.type === 'tool_use');
      if (toolUses.length === 0) break;
      messages.push({ role: 'assistant', content: assistantContent });
      const toolResults = await execToolUses(toolUses, toolLogLines, sse);
      messages.push({ role: 'user', content: toolResults });
    }

    // 兜底：模型一直调工具没吐正文（绕到上限或末轮仍在调工具）→ 强制不带工具再答一次，杜绝空回复
    if (!fullReply.trim()) {
      try {
        const apiRes2 = await fetch(apiBaseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(buildRequestBody(settings, model, systemPrompt, messages, true, null))
        });
        if (apiRes2.ok) {
          const reader2 = apiRes2.body.getReader();
          const decoder2 = new TextDecoder();
          let buf2 = '';
          while (true) {
            const { done, value } = await reader2.read();
            if (done) break;
            buf2 += decoder2.decode(value, { stream: true });
            const lines2 = buf2.split('\n');
            buf2 = lines2.pop();
            for (const line of lines2) {
              if (!line.startsWith('data: ')) continue;
              try {
                const ev = JSON.parse(line.slice(6).trim());
                if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                  fullReply += ev.delta.text;
                  sse({ type: 'text', text: ev.delta.text });
                }
              } catch (e) {}
            }
          }
        }
      } catch (e) { console.warn('兜底回复失败:', e.message); }
    }

    sse({ type: 'done' });

    if (fullReply) {
      run("INSERT INTO messages (session_id, role, content, reasoning_content, tool_log) VALUES (?, 'assistant', ?, ?, ?)",
        [session_id, fullReply, fullThinking || null, toolLogLines.length ? toolLogLines.join('\n') : null]);
      run("UPDATE sessions SET updated_at = datetime('now', '+8 hours') WHERE id = ?", [session_id]);
      try { logUsage(session_id, model, usage.output_tokens ? usage : null); } catch (e) { console.warn('logUsage failed:', e.message); }
    }
    res.end();
  } catch (err) {
    console.error('Stream error:', err);
    try { res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`); res.end(); } catch (e) {}
  }
});

module.exports = router;
