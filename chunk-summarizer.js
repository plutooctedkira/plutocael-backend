const { queryAll, run, getBackgroundApiConfig } = require('./db');
const { encodeText, vecToJson } = require('./vector-search');

// 调 LLM 给一段对话生成一句话摘要（用便宜渠道，省主力额度；bgLLM 自动兼容 Anthropic/OpenAI 格式）
async function summarizeChunk(chunkText) {
  try {
    const { bgComplete } = require('./services/bgLLM');
    const text = await bgComplete({
      system: '你是一个对话摘要器。用一到两句中文概括这段对话。不超过80字。'
        + '必须保留所有具体细节：日期、时间、地点、人名、数字。禁止抽象化。忽略sticker标记和纯语气词。',
      user: `请概括这段对话：\n\n${chunkText.substring(0, 800)}`,
      maxTokens: 200,
    });
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
