// 编码 agent：直接在 VPS 上读写 Plutocael 的代码并部署
// 复用 settings 里当前选中的渠道（跟 Cael 聊天同一套 key），不额外要 Anthropic 官方 key
const router = require('express').Router();
const { queryOne, getTaskChannel } = require('../db');
const { streamOnce } = require('../services/anthropicStream');
const { TOOLS, runTool, ROOTS } = require('../services/codingTools');
const { labelOf } = require('../services/tasks');

const MAX_ROUNDS = 40;      // agent 要连续调很多轮工具，比聊天的 5 轮高得多
const MAX_TOKENS = 8000;    // 写代码需要的输出空间，比聊天的 2000 大

// 单用户，会话放内存即可；pm2 重启会清空（重启后从头说一遍就行）
let convo = [];

const SYSTEM = `你是克老师（Claude），Jasmine 的编程搭档。你现在直接跑在她的 VPS 上，能真的读写文件、执行命令、部署代码。

可操作的仓库目录：
${ROOTS.map(r => '  ' + r).join('\n')}

代码同步（重要，每次都要做）：
- Jasmine 的电脑上还有一份同样的仓库，她也会在那边改代码并 push。你这份随时可能是旧的。
- 所以**动手改任何文件之前，先在对应仓库跑 git pull**，拿到最新代码再改。改完 commit + push。
- 如果 pull 或 push 有冲突，停下来告诉她，别硬合并、别 force push。

关于这个项目：
- Plutocael 是 Jasmine 的私人 AI 陪伴 app，前端 React + Vite（PWA，iPhone 上用），后端 Node/Express + sql.js。
- 前端部署：改完 git commit + push，Vercel 会自动部署，不需要你做别的。
- 后端部署：git push 之后需要 pm2 restart plutocael 才生效。
  ⚠️ 但 pm2 restart 会把你自己这个进程也重启掉，当前对话会断。所以要重启后端时，先把话说完告诉她「我要重启后端了，这次对话会断，重开一个就行」，再执行。
- 前端改完记得先 npm run build 验证能编译过，再提交。

工作方式：
- 你是完全自主的：该读就读，该改就改，该部署就部署，不用每一步都问她。
- 但动手前先用一两句话说清楚你要做什么，让她能跟上。
- 改代码要贴合周围代码的风格（她的代码用中文注释、行内样式、单文件大组件，别擅自重构成别的风格）。
- 遇到问题自己排查，别把报错原样甩给她。
- 全程用中文回复，语气自然一点，她不是工程师，别堆术语。
- 说完成之前先确认真的做完了（编译过了/命令成功了）。如果有没做完的，直接讲清楚哪里卡住。`;

function creds() {
  const s = queryOne('SELECT * FROM settings LIMIT 1') || {};
  const ok = (v) => (v && /^[\x21-\x7E]+$/.test(String(v).trim()) ? String(v).trim() : null);
  const pinned = getTaskChannel('agent'); // 设置里给"工作台"指定了渠道就用它
  if (pinned) return { apiBaseUrl: pinned.url, apiKey: pinned.key, model: pinned.model, thinking: !!s.enable_thinking };
  const base = ok(s.api_base_url) || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  return {
    apiBaseUrl: base + '/v1/messages',
    apiKey: ok(s.api_key) || process.env.ANTHROPIC_API_KEY,
    model: process.env.AGENT_MODEL || s.model || 'claude-sonnet-4-6',
    thinking: !!s.enable_thinking,
  };
}

router.get('/info', (req, res) => {
  const c = creds();
  res.json({ roots: ROOTS, model: c.model, ready: !!c.apiKey, turns: convo.length });
});

router.post('/reset', (req, res) => { convo = []; res.json({ ok: true }); });

router.post('/stream', async (req, res) => {
  const { message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: '需要 message' });

  const { apiBaseUrl, apiKey, model, thinking } = creds();
  if (!apiKey) return res.status(400).json({ error: '没有可用的 API Key，请先在设置里配好渠道' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const sse = (o) => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch (e) {} };

  convo.push({ role: 'user', content: String(message) });

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const body = {
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        messages: convo.map(m => ({ role: m.role, content: m.content })),
        tools: TOOLS,
      };
      if (thinking) body.thinking = { type: 'adaptive' };

      const { assistantContent, stopReason, usage } = await streamOnce({
        apiBaseUrl, apiKey, body,
        onText: (t) => sse({ type: 'text', text: t }),
        onThinking: (t) => sse({ type: 'thinking', text: t }),
      });
      // 工作台一次能跑几十轮，不记账的话完全看不出它烧了多少
      try { require('../gateway-tracker').logUsage(labelOf('agent'), model, usage); } catch (e) {}

      if (assistantContent.length === 0) { sse({ type: 'error', text: '渠道返回了空内容，多半是这个中转渠道不稳，换个渠道再试' }); break; }
      convo.push({ role: 'assistant', content: assistantContent });

      const toolUses = assistantContent.filter(b => b.type === 'tool_use');
      if (stopReason !== 'tool_use' || toolUses.length === 0) break;

      const results = [];
      for (const tu of toolUses) {
        sse({ type: 'tool_use', name: tu.name, input: tu.input || {} });
        const r = await runTool(tu.name, tu.input || {});
        sse({ type: 'tool_result', name: tu.name, ok: r.ok, output: r.output.slice(0, 400) });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.output, ...(r.ok ? {} : { is_error: true }) });
      }
      convo.push({ role: 'user', content: results });

      if (round === MAX_ROUNDS - 1) sse({ type: 'text', text: '\n\n（到达单次最多 40 轮工具调用的上限，先停下。要继续的话再说一声。）' });
    }
    sse({ type: 'done' });
  } catch (e) {
    sse({ type: 'error', text: e.message });
  }
  res.end();
});

module.exports = router;
