// 自动记忆分类中间件：每轮对话结束后异步判断"这轮有没有值得长期记住的内容"
// 有 → 调 OB 的 hold 写入(带分类标签)；没有 → 什么都不做
// 完全异步(fire-and-forget)，不阻塞回复；用便宜渠道 API，失败只记日志不影响对话

const CLASSIFY_PROMPT = `你是记忆分类器，判断这轮对话里有没有【第一次出现的、几周后还值得记起的具体新信息】。
默认 memorable:false。绝大多数日常对话都不值得存，只有极少数才存。宁可漏存，不要滥存。

只有出现下列【全新且具体】的内容才 memorable:true：
- 决定：这轮刚做出的决定、计划、约定（带具体的事/时间）
- 偏好：Jasmine 这轮刚明确表达的喜好、雷点、习惯
- 事实：关于 Jasmine 生活的具体事实（工作、考试、日程、身边的人等）
- 里程碑：这轮刚发生的、真实的重要进展
- 创意：这轮刚提出的具体点子、设定、灵感

以下一律 memorable:false（重点，别再犯）：
- Cael 的感慨、夸赞、鼓励、情绪表达
- Cael 在回顾/复述/总结【之前已经聊过或已知】的事（哪怕说得很动人）
- 关于这个 app、代码、UI、部署、调试、bug 的一切对话
- 日常寒暄、闲聊、情绪起伏、提问但没带来新事实
- 和上一轮换汤不换药、同一话题的重复延续

判断"新不新"：如果这条信息本质上是把已经知道的事再说一遍，就是 false。
importance 必须 ≥6 才值得存；给不到 6 就 memorable:false。

只输出 JSON，别的什么都不要：
值得 → {"memorable":true,"summary":"一句话摘要(40字内,第三人称,人物用Jasmine和Cael)","category":"决定|偏好|事实|里程碑|创意","tags":["1-2个标签"],"importance":6到10}
不值得 → {"memorable":false}`;

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

// 最近存过的摘要（内存里留一小段），近似重复就跳过，避免同话题连存
const recentSummaries = [];
function isDuplicate(summary) {
  const norm = s => String(s || '').replace(/[，。、,.\s]/g, '');
  const cur = norm(summary);
  if (cur.length < 4) return false;
  for (const prev of recentSummaries) {
    const p = norm(prev);
    // 取较短的一方，若有 60% 以上的字符重合，视为重复
    const [short, long] = cur.length < p.length ? [cur, p] : [p, cur];
    let hit = 0;
    for (const ch of new Set(short)) if (long.includes(ch)) hit++;
    if (hit / new Set(short).size > 0.6) return true;
  }
  return false;
}

// 对外入口：afterResponse hook。同步返回，内部全异步。
function autoMemorize(userText, aiText) {
  if (!userText || !aiText || !String(aiText).trim()) return;
  setImmediate(async () => {
    try {
      const verdict = await classifyRound(userText, aiText);
      if (!verdict || !verdict.memorable || !verdict.summary) return;
      if ((Number(verdict.importance) || 0) < 6) { console.log('[autoMemory] importance<6 跳过:', String(verdict.summary).slice(0, 40)); return; }
      if (isDuplicate(verdict.summary)) { console.log('[autoMemory] 近似重复跳过:', String(verdict.summary).slice(0, 40)); return; }
      await storeToOB(verdict);
      recentSummaries.push(verdict.summary);
      if (recentSummaries.length > 12) recentSummaries.shift();
      console.log('[autoMemory] 已存记忆:', verdict.category, '-', String(verdict.summary).slice(0, 60));
    } catch (e) {
      console.warn('[autoMemory] 写入失败:', e.message);
    }
  });
}

module.exports = { autoMemorize };
