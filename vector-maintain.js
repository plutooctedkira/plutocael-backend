/**
 * 向量维护脚本 —— Cron 定时触发
 * 
 * 用法：
 *   node vector-maintain.js
 * 或：
 *   0 4 * * * cd /opt/plutocael-backend && node vector-maintain.js >> /tmp/vector-maintain.log 2>&1
 */

require('dotenv').config();

// 与 server.js 一致：配置了 PROXY_URL 时外网请求走代理
if (process.env.PROXY_URL) {
  const { setGlobalDispatcher, ProxyAgent } = require('undici');
  setGlobalDispatcher(new ProxyAgent(process.env.PROXY_URL));
}

const { initDB } = require('./db');
const { embedPost, embedChatChunks, forgettingCurveCleanup, buildMemoryEdges } = require('./vector-search');

async function runMaintenance() {
  console.log('[vector-maintain] Starting maintenance...');
  await initDB();
  console.log('[vector-maintain] Database initialized');

  // 1. Embedding 新的对话 chunks
  console.log('[vector-maintain] [1/5] Embedding chat chunks...');
  await embedChatChunks(10);
  console.log('[vector-maintain] Chat chunks embedded');

  // 2. 给新 chunk 生成 LLM 摘要并用摘要重新 embed
  console.log('[vector-maintain] [2/5] Summarizing new chunks...');
  const { summarizeAndReembed } = require('./chunk-summarizer');
  const sum = await summarizeAndReembed(20);
  console.log(`[vector-maintain] Summarized ${sum.summarized}/${sum.total} chunks`);

  // 3. 重建关系图谱
  console.log('[vector-maintain] [3/5] Building memory edges...');
  buildMemoryEdges();
  console.log('[vector-maintain] Memory edges built');

  // 4. 遗忘曲线清理
  console.log('[vector-maintain] [4/5] Running forgetting curve cleanup...');
  forgettingCurveCleanup();
  console.log('[vector-maintain] Forgetting curve cleanup done');

  // 5. 记录完成
  const { queryOne } = require('./db');
  const stats = queryOne(`
    SELECT
      (SELECT COUNT(*) FROM post_embeddings) as posts,
      (SELECT COUNT(*) FROM chat_chunk_embeddings) as chunks,
      (SELECT COUNT(*) FROM memory_edges) as edges
  `);
  console.log(`[vector-maintain] [5/5] Done! Posts:${stats?.posts || 0} Chunks:${stats?.chunks || 0} Edges:${stats?.edges || 0}`);
}

runMaintenance().catch(err => {
  console.error('[vector-maintain] Error:', err);
  process.exit(1);
});