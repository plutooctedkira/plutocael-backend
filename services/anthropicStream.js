// 流式调用 Claude 并重组内容块。逻辑照搬 routes/chat.js 里已经跑通的那套
// （含中转渠道把思考当正文吐出来的 <thinking> 剥离），单独成文件是为了不动正在用的 chat.js。

// 流式剥离内联 <thinking>...</thinking>：标签内走 onThink，其余走 onText；标签可跨分片
function makeThinkStripper(onText, onThink) {
  const OPEN = '<thinking>', CLOSE = '</thinking>';
  let inThink = false, buf = '';
  const push = (chunk) => {
    buf += chunk;
    let go = true;
    while (go) {
      go = false;
      if (!inThink) {
        const i = buf.indexOf(OPEN);
        if (i !== -1) { if (i > 0) onText(buf.slice(0, i)); buf = buf.slice(i + OPEN.length); inThink = true; go = true; }
        else { const safe = buf.length - (OPEN.length - 1); if (safe > 0) { onText(buf.slice(0, safe)); buf = buf.slice(safe); } }
      } else {
        const j = buf.indexOf(CLOSE);
        if (j !== -1) { if (j > 0) onThink(buf.slice(0, j)); buf = buf.slice(j + CLOSE.length); inThink = false; go = true; }
        else { const safe = buf.length - (CLOSE.length - 1); if (safe > 0) { onThink(buf.slice(0, safe)); buf = buf.slice(safe); } }
      }
    }
  };
  const flush = () => { if (buf) { (inThink ? onThink : onText)(buf); buf = ''; } };
  return { push, flush };
}

// 跑一轮流式请求，返回重组好的 assistant 内容块 + stop_reason + usage
async function streamOnce({ apiBaseUrl, apiKey, body, onText, onThinking }) {
  const res = await fetch(apiBaseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ ...body, stream: true })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`API ${res.status}: ${String(t).slice(0, 600)}`);
  }

  const assistantContent = [];
  const usage = {};
  let curBlock = null, curJson = '', stopReason = null, roundOutput = 0;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const stripper = makeThinkStripper(
    (t) => { if (curBlock && curBlock.type === 'text') curBlock.text += t; onText && onText(t); },
    (t) => { onThinking && onThinking(t); }
  );

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
          if (d.type === 'text_delta') stripper.push(d.text);
          else if (d.type === 'thinking_delta') { curBlock.thinking += d.thinking; onThinking && onThinking(d.thinking); }
          else if (d.type === 'signature_delta') curBlock.signature = (curBlock.signature || '') + d.signature;
          else if (d.type === 'input_json_delta') curJson += d.partial_json;
        } else if (event.type === 'content_block_stop' && curBlock) {
          if (curBlock.type === 'text') stripper.flush();
          if (curBlock.type === 'tool_use') {
            try { curBlock.input = curJson ? JSON.parse(curJson) : {}; } catch (e) { curBlock.input = {}; }
          }
          assistantContent.push(curBlock);
          curBlock = null;
        } else if (event.type === 'message_start' && event.message && event.message.usage) {
          for (const [k, v] of Object.entries(event.message.usage)) {
            if (typeof v === 'number' && k !== 'output_tokens') usage[k] = (usage[k] || 0) + v;
          }
        } else if (event.type === 'message_delta') {
          if (event.delta && event.delta.stop_reason) stopReason = event.delta.stop_reason;
          if (event.usage && event.usage.output_tokens) roundOutput = event.usage.output_tokens;
        }
      } catch (e) {}
    }
  }
  usage.output_tokens = (usage.output_tokens || 0) + roundOutput;
  return { assistantContent, stopReason, usage };
}

module.exports = { streamOnce, makeThinkStripper };
