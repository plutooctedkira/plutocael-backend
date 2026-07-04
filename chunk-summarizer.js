const { queryAll, run, getBackgroundApiConfig } = require('./db');
const { encodeText, vecToJson } = require('./vector-search');

// 调 LLM 给一段对话生成一句话摘要（用便宜渠道，省主力额度）
async function summarizeChunk(chunkText) {
  const { url, key, model } = getBackgroundApiConfig();
  if (!key) return null;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system: '你是一个对话摘要器。用一到两句中文概括这段对话。不超过80字。'
          + '必须保留所有具体细节：日期、时间、地点、人名、数字。禁止抽象化。忽略sticker标记和纯语气词。',
        messages: [{ role: 'user', content: `请概括这段对话：\n\n${chunkText.substring(0, 800)}` }]
      })
    });
    if (!resp.ok) {
      console.warn('[chunk-summarizer] API错误', resp.status);
      return null;
    }
    const data = await resp.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return text || null;
  } catch (e) {
    console.warn('[chunk-summarizer] 请求失败:', e.message);
    return null;
  }
}

// 给还没有摘要的 chunk 生成摘要，并用摘要重新 embed（搜索质量核心）
async function summarizeAndReembed(batchSize = 20) {
  const rows = queryAll("SELECT id, chunk_text FROM chat_chunk_embeddings WHERE summary = '' OR summary IS NULL LIMIT ?", [batchSize]);
  let done = 0;
  for (const row of rows) {
    const summary = await summarizeChunk(row.chunk_text);
    if (!summary) continue;
    const vec = await encodeText(summary);
    run("UPDATE chat_chunk_embeddings SET summary = ?, embedding = ? WHERE id = ?", [summary, vecToJson(vec), row.id]);
    done++;
  }
  return { total: rows.length, summarized: done };
}

module.exports = { summarizeChunk, summarizeAndReembed };
