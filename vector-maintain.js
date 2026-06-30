/**
 * 向量维护脚本 —— Cron 定时触发
 * 
 * 用法：
 *   node vector-maintain.js
 * 或：
 *   0 4 * * * cd /opt/plutocael-backend && node vector-maintain.js >> /tmp/vector-maintain.log 2>&1
 */

require('dotenv').config();
const { initDB } = require('./db');
const { embedPost, embedChatChunks, forgettingCurveCleanup, buildMemoryEdges } = require('./vector-search');

async function runMaintenance() {
  console.log('[vector-maintain] Starting maintenance...');
  await initDB();
  console.log('[vector-maintain] Database initialized');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const apiBaseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';

  // 1. Embedding 新的对话 chunks
  console.log('[vector-maintain] [1/4] Embedding chat chunks...');
  await embedChatChunks(10, apiKey, apiBaseUrl);
  console.log('[vector-maintain] Chat chunks embedded');

  // 2. 重建关系图谱
  console.log('[vector-maintain] [2/4] Building memory edges...');
  buildMemoryEdges();
  console.log('[vector-maintain] Memory edges built');

  // 3. 遗忘曲线清理
  console.log('[vector-maintain] [3/4] Running forgetting curve cleanup...');
  forgettingCurveCleanup();
  console.log('[vector-maintain] Forgetting curve cleanup done');

  // 4. 记录完成
  const { queryOne } = require('./db');
  const stats = queryOne(`
    SELECT 
      (SELECT COUNT(*) FROM post_embeddings) as posts,
      (SELECT COUNT(*) FROM chat_chunk_embeddings) as chunks,
      (SELECT COUNT(*) FROM memory_edges) as edges
  `);
  console.log(`[vector-maintain] [4/4] Done! Posts:${stats?.posts || 0} Chunks:${stats?.chunks || 0} Edges:${stats?.edges || 0}`);
}

runMaintenance().catch(err => {
  console.error('[vector-maintain] Error:', err);
  process.exit(1);
});