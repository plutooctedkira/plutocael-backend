const { queryAll, queryOne, run, getDB } = require('./db');

// ============================================================
// 内存 Embedding 表 / 函数初始化
// ============================================================
async function initVectorTables() {
  run(`
    CREATE TABLE IF NOT EXISTS post_embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER UNIQUE NOT NULL,
      embedding TEXT NOT NULL,
      updated_at DATETIME DEFAULT (datetime('now', '+8 hours'))
    )
  `);
  run(`
    CREATE TABLE IF NOT EXISTS chat_chunk_embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      msg_id_start INTEGER NOT NULL,
      msg_id_end INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      summary TEXT DEFAULT '',
      embedding TEXT NOT NULL,
      updated_at DATETIME DEFAULT (datetime('now', '+8 hours'))
    )
  `);
  run(`
    CREATE TABLE IF NOT EXISTS memory_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      weight REAL DEFAULT 0,
      UNIQUE(source_id, source_type, target_id, target_type)
    )
  `);
}

// ============================================================
// 向量生成 —— Anthropic 没有 embedding API，语义向量走 Voyage AI
// 配置 VOYAGE_API_KEY 时用真实语义向量，否则用本地字符哈希方案
// ============================================================
async function encodeText(text) {
  const voyageKey = process.env.VOYAGE_API_KEY;
  if (!voyageKey) {
    return localEncode(text);
  }
  try {
    const resp = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${voyageKey}`
      },
      body: JSON.stringify({
        model: process.env.VOYAGE_MODEL || 'voyage-3.5',
        input: text.substring(0, 8000)
      })
    });
    if (!resp.ok) {
      console.warn('[vector-search] Voyage API error', resp.status, ', falling back to local');
      return localEncode(text);
    }
    const data = await resp.json();
    if (data.data && data.data[0] && data.data[0].embedding) {
      return data.data[0].embedding;
    }
    return localEncode(text);
  } catch (e) {
    console.warn('[vector-search] Voyage request failed, local fallback:', e.message);
    return localEncode(text);
  }
}

// 简易本地 embedding（TF-IDF 风格的正交投影，维度固定 128）
function localEncode(text) {
  const dim = 128;
  const vec = new Array(dim).fill(0);
  const chars = text.split('');
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i].charCodeAt(0);
    vec[i % dim] += code / 65536;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm ? vec.map(v => v / norm) : vec.map(() => 1 / Math.sqrt(dim));
}

// ============================================================
// 向量持久化
// ============================================================
function vecToJson(vec) {
  return JSON.stringify(vec);
}

function jsonToVec(json) {
  return JSON.parse(json);
}

// ============================================================
// 余弦相似度
// ============================================================
function cosineSim(a, b) {
  // 本地向量（128维）和 Voyage 向量（1024维）不可比，直接返回 0
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

// ============================================================
// BM25 关键词匹配
// ============================================================
class SimpleBM25 {
  constructor(docs, k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.docs = docs;
    this.docTokens = docs.map(d => this.tokenize(d.text));
    this.avgdl = this.docTokens.reduce((s, t) => s + t.length, 0) / Math.max(this.docTokens.length, 1);
    this.N = docs.length;
    this.idf = {};
    const df = {};
    for (const tokens of this.docTokens) {
      const seen = new Set();
      for (const t of tokens) {
        if (!seen.has(t)) {
          seen.add(t);
          df[t] = (df[t] || 0) + 1;
        }
      }
    }
    for (const [t, freq] of Object.entries(df)) {
      this.idf[t] = Math.log((this.N - freq + 0.5) / (freq + 0.5) + 1);
    }
  }

  tokenize(text) {
    return text.split(/[\s,;.!?\u3000-\u303F\uFF00-\uFFEF，。！？、；：""''（）【】《》]+/).filter(w => w.length > 0);
  }

  score(query) {
    const qTokens = this.tokenize(query);
    return this.docTokens.map(docTokens => {
      let s = 0;
      const dl = docTokens.length;
      const tfMap = {};
      for (const t of docTokens) tfMap[t] = (tfMap[t] || 0) + 1;
      for (const qt of qTokens) {
        if (tfMap[qt] !== undefined) {
          const tf = tfMap[qt];
          const idf = this.idf[qt] || 0;
          s += idf * (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * dl / this.avgdl));
        }
      }
      return s;
    });
  }
}

// ============================================================
// Embedding 记忆帖子
// ============================================================
async function embedPost(postId, content) {
  const vec = await encodeText(content.substring(0, 500));
  run("INSERT OR REPLACE INTO post_embeddings (post_id, embedding) VALUES (?, ?)", [postId, vecToJson(vec)]);
}

// ============================================================
// Embedding 对话 Chunks（每 10 条一个 chunk）
// ============================================================
async function embedChatChunks(chunkSize = 10) {
  const sessions = queryAll("SELECT DISTINCT session_id FROM messages WHERE visible = 1 ORDER BY session_id");
  for (const { session_id } of sessions) {
    const msgs = queryAll("SELECT id, role, content, msg_type FROM messages WHERE session_id = ? AND visible = 1 ORDER BY id", [session_id]);
    for (let i = 0; i < msgs.length; i += chunkSize) {
      const chunk = msgs.slice(i, i + chunkSize);
      if (chunk.length === 0) continue;
      const msgIdStart = chunk[0].id;
      const msgIdEnd = chunk[chunk.length - 1].id;
      const exist = queryOne("SELECT id FROM chat_chunk_embeddings WHERE session_id = ? AND msg_id_start = ? AND msg_id_end = ?", [session_id, msgIdStart, msgIdEnd]);
      if (exist) continue;
      const chunkText = chunk.map(m => `[${m.role}] ${m.msg_type === 'image' ? '[图片]' : m.content}`).join('\n').substring(0, 800);
      const vec = await encodeText(chunkText);
      run("INSERT INTO chat_chunk_embeddings (session_id, msg_id_start, msg_id_end, chunk_text, embedding) VALUES (?, ?, ?, ?, ?)", [session_id, msgIdStart, msgIdEnd, chunkText, vecToJson(vec)]);
    }
  }
}

// ============================================================
// 混合搜索
// ============================================================
async function hybridSearch(query, limit = 8, includeChat = true) {
  const queryVec = await encodeText(query);
  const results = {};

  // 搜索 posts
  const postEmbs = queryAll("SELECT pe.post_id, pe.embedding, p.content FROM post_embeddings pe JOIN memories p ON p.id = pe.post_id");
  for (const pe of postEmbs) {
    const sim = cosineSim(queryVec, jsonToVec(pe.embedding));
    if (sim > 0.3) {
      results[`post_${pe.post_id}`] = {
        id: pe.post_id,
        type: 'post',
        content: pe.content,
        vecScore: sim,
        bm25Score: 0,
        score: sim * 0.7
      };
    }
  }

  // 搜索 chat chunks
  if (includeChat) {
    const chunks = queryAll("SELECT id, session_id, chunk_text, summary, embedding FROM chat_chunk_embeddings");
    for (const ch of chunks) {
      const sim = cosineSim(queryVec, jsonToVec(ch.embedding));
      if (sim > 0.3) {
        results[`chat_${ch.id}`] = {
          id: ch.session_id,
          chunkId: ch.id,
          type: 'chat',
          content: ch.summary || ch.chunk_text,
          vecScore: sim,
          bm25Score: 0,
          score: sim * 0.7
        };
      }
    }

    // BM25 关键词搜索
    const bm25Docs = chunks.map(c => ({ id: c.id, text: c.chunk_text }));
    const bm25 = new SimpleBM25(bm25Docs);
    const bm25Scores = bm25.score(query);
    const maxBM25 = Math.max(...bm25Scores, 1);
    for (let i = 0; i < bm25Docs.length; i++) {
      const normScore = bm25Scores[i] / maxBM25;
      if (normScore > 0.3) {
        const key = `chat_${bm25Docs[i].id}`;
        if (results[key]) {
          results[key].bm25Score = normScore;
          results[key].score = 0.7 * results[key].vecScore + 0.3 * normScore;
        } else {
          results[key] = {
            id: chunks[i].session_id,
            chunkId: chunks[i].id,
            type: 'chat',
            content: chunks[i].chunk_text,
            vecScore: 0,
            bm25Score: normScore,
            score: 0.3 * normScore
          };
        }
      }
    }
  }

  // 图谱一跳扩展：从前5个最强命中出发，沿关系边把关联记忆一并带出
  const topEntries = Object.values(results).sort((a, b) => b.score - a.score).slice(0, 5);
  for (const hit of topEntries) {
    const srcType = hit.type === 'post' ? 'post' : 'chat';
    const srcId = srcType === 'post' ? hit.id : hit.chunkId;
    if (!srcId) continue;
    const neighbors = queryAll(
      `SELECT target_id AS nid, target_type AS ntype, weight FROM memory_edges WHERE source_id = ? AND source_type = ?
       UNION SELECT source_id, source_type, weight FROM memory_edges WHERE target_id = ? AND target_type = ?
       ORDER BY weight DESC LIMIT 3`,
      [srcId, srcType, srcId, srcType]
    );
    for (const nb of neighbors) {
      const nkey = `${nb.ntype}_${nb.nid}`;
      if (results[nkey]) continue; // 已在结果里就不重复加
      if (nb.ntype === 'post') {
        const p = queryOne("SELECT id, content FROM memories WHERE id = ?", [nb.nid]);
        if (p) results[nkey] = { id: p.id, type: 'post', content: p.content, vecScore: 0, bm25Score: 0, score: nb.weight * 0.5, viaGraph: true };
      } else {
        const c = queryOne("SELECT id, session_id, summary, chunk_text FROM chat_chunk_embeddings WHERE id = ?", [nb.nid]);
        if (c) results[nkey] = { id: c.session_id, chunkId: c.id, type: 'chat', content: c.summary || c.chunk_text, vecScore: 0, bm25Score: 0, score: nb.weight * 0.5, viaGraph: true };
      }
    }
  }

  // 排序去重返回
  const sorted = Object.values(results).sort((a, b) => b.score - a.score).slice(0, limit);
  return sorted;
}

// ============================================================
// 遗忘曲线清理
// ============================================================
function forgettingCurveCleanup() {
  const now = new Date(new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
  const day7 = new Date(now - 7 * 24 * 3600 * 1000);
  const day14 = new Date(now - 14 * 24 * 3600 * 1000);
  const day30 = new Date(now - 30 * 24 * 3600 * 1000);

  const chunks = queryAll("SELECT id, session_id, updated_at FROM chat_chunk_embeddings ORDER BY updated_at");
  const grouped = {};
  for (const c of chunks) {
    const sessionId = c.session_id || 1;
    if (!grouped[sessionId]) grouped[sessionId] = [];
    grouped[sessionId].push(c);
  }

  for (const [sid, clist] of Object.entries(grouped)) {
    for (let i = 0; i < clist.length; i++) {
      const dt = new Date(clist[i].updated_at);
      if (dt >= day7) continue;
      if (dt >= day14) { if (i % 2 === 1) run("DELETE FROM chat_chunk_embeddings WHERE id = ?", [clist[i].id]); }
      else if (dt >= day30) { if (i % 4 !== 0) run("DELETE FROM chat_chunk_embeddings WHERE id = ?", [clist[i].id]); }
      else {
        const first2 = clist.slice(0, 2);
        const last2 = clist.slice(-2);
        const keep = new Set([...first2, ...last2].map(c => c.id));
        if (!keep.has(clist[i].id)) run("DELETE FROM chat_chunk_embeddings WHERE id = ?", [clist[i].id]);
      }
    }
  }
}

// ============================================================
// 关系图谱建边
// ============================================================
function buildMemoryEdges() {
  const entries = [];
  const posts = queryAll("SELECT pe.post_id as id, pe.embedding FROM post_embeddings pe");
  for (const p of posts) entries.push({ id: p.id, type: 'post', vec: jsonToVec(p.embedding) });
  const chunks = queryAll("SELECT id, embedding FROM chat_chunk_embeddings");
  for (const c of chunks) entries.push({ id: c.id, type: 'chat', vec: jsonToVec(c.embedding) });

  const THRESHOLD = 0.65;
  const TOP_K = 5;
  for (let i = 0; i < entries.length; i++) {
    const scores = [];
    for (let j = 0; j < entries.length; j++) {
      if (i === j) continue;
      scores.push({ j, sim: cosineSim(entries[i].vec, entries[j].vec) });
    }
    scores.sort((a, b) => b.sim - a.sim);
    for (let k = 0; k < Math.min(TOP_K, scores.length); k++) {
      const { j, sim } = scores[k];
      if (sim < THRESHOLD) break;
      run("INSERT OR IGNORE INTO memory_edges (source_id, source_type, target_id, target_type, weight) VALUES (?, ?, ?, ?, ?)", [entries[i].id, entries[i].type, entries[j].id, entries[j].type, sim]);
    }
  }
}

module.exports = { initVectorTables, encodeText, vecToJson, embedPost, embedChatChunks, hybridSearch, forgettingCurveCleanup, buildMemoryEdges };