// 自动记忆分类中间件：每轮对话结束后异步判断"这轮有没有值得长期记住的内容"
// 有 → 调 OB 的 hold 写入(带分类标签)；没有 → 什么都不做
// 完全异步(fire-and-forget)，不阻塞回复；用便宜渠道 API，失败只记日志不影响对话

const CLASSIFY_PROMPT = `你是记忆分类器。判断下面这轮对话中有没有值得长期记住的内容。

值得记住的五类：
- 决定：做出的决定、计划、约定
- 偏好：表达的喜好、习惯、雷点、审美倾向
- 创意：新点子、设定、灵感、创作内容
- 里程碑：完成的事、重要进展、第一次做到的事
- 关系：关系变化、重要的情感时刻、新的相处默契

不值得记住：日常寒暄、临时情绪波动、技术调试细节、重复已知的信息、单纯的UI改动指令。

只输出 JSON，不要输出任何其它文字：
值得 → {"memorable":true,"summary":"一句话摘要(50字内,第三人称,人物用Jasmine和Cael称呼)","category":"决定|偏好|创意|里程碑|关系","tags":["1-3个补充标签"],"importance":5}
不值得 → {"memorable":false}

importance 取 1-10：日常小事 3-5，重要决定/里程碑 6-8，改变关系或长期方向的 9-10。`;

async function classifyRound(userText, aiText) {
  const dialogue = `【Jasmine】${String(userText || '').slice(0, 2000)}\n\n【Cael】${String(aiText || '').slice(0, 2000)}`;
  try {
    const { bgComplete } = require('./bgLLM');
    const text = await bgComplete({ system: CLASSIFY_PROMPT, user: dialogue, maxTokens: 300, timeoutMs: 30000 });
    // 剥掉可能的 ```json 围栏，抓第一个 JSON 对象
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('[autoMemory] 分类失败:', e.message);
    return null;
  }
}

async function storeToOB(verdict) {
  const { callTool } = require('../mcp-client');
  const tags = [verdict.category, ...(Array.isArray(verdict.tags) ? verdict.tags : [])]
    .filter(Boolean).map(String).join(',');
  const importance = Math.max(1, Math.min(10, Math.round(Number(verdict.importance) || 5)));
  await callTool('hold', { content: String(verdict.summary || '').slice(0, 500), tags, importance });
}

// 对外入口：afterResponse hook。同步返回，内部全异步。
function autoMemorize(userText, aiText) {
  if (!userText || !aiText || !String(aiText).trim()) return;
  setImmediate(async () => {
    try {
      const verdict = await classifyRound(userText, aiText);
      if (verdict && verdict.memorable && verdict.summary) {
        await storeToOB(verdict);
        console.log('[autoMemory] 已存记忆:', verdict.category, '-', String(verdict.summary).slice(0, 60));
      }
    } catch (e) {
      console.warn('[autoMemory] 写入失败:', e.message);
    }
  });
}

module.exports = { autoMemorize };
