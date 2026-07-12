const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { queryAll } = require('./db');

const DEFAULT_MCP_URL = process.env.MCP_URL || '';

// 启用的服务器列表（DB 优先，空表则回退 env MCP_URL）
function getServers() {
  try {
    const rows = queryAll("SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY id");
    if (rows.length > 0) return rows;
  } catch (e) { /* 表还没建好等情况 */ }
  return DEFAULT_MCP_URL ? [{ id: 0, name: '默认', url: DEFAULT_MCP_URL, enabled: 1 }] : [];
}

async function connectTo(url) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'plutocael-backend', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

// 聚合工具缓存（60秒）：tools 带来源服务器信息，routes 是 工具名→服务器URL 路由表
let cache = { ts: 0, tools: [], routes: {} };
const TTL = 60000;

function invalidateCache() { cache.ts = 0; }

// 聚合所有启用服务器的工具列表；同名工具先注册的优先
async function listTools(force = false) {
  if (!force && Date.now() - cache.ts < TTL) return cache.tools;
  const servers = getServers();
  const tools = [];
  const routes = {};
  const seen = new Set();
  for (const s of servers) {
    let client;
    try {
      client = await connectTo(s.url);
      const result = await client.listTools();
      await client.close();
      for (const t of (result && result.tools) || []) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        tools.push({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || {}, server: s.name, serverId: s.id });
        routes[t.name] = s.url;
      }
    } catch (err) {
      console.error(`MCP [${s.name}] listTools 失败:`, err.message);
      if (client) try { await client.close(); } catch (e) {}
    }
  }
  cache = { ts: Date.now(), tools, routes };
  return tools;
}

// 调用工具：按路由表找到所属服务器
async function callTool(toolName, args = {}) {
  if (!cache.routes[toolName] || Date.now() - cache.ts >= TTL) {
    await listTools(true).catch(() => {});
  }
  const url = cache.routes[toolName] || (getServers()[0] || {}).url;
  if (!url) return { success: false, error: '没有可用的 MCP 服务器' };
  let client;
  try {
    client = await connectTo(url);
    const result = await client.callTool({ name: toolName, arguments: args });
    await client.close();
    if (result && result.content) {
      const textBlock = result.content.find(b => b.type === 'text');
      if (textBlock) return { success: true, output: textBlock.text };
      return { success: true, output: JSON.stringify(result.content) };
    }
    return { success: true, output: '(无输出)' };
  } catch (err) {
    console.error('MCP callTool 失败:', err.message);
    if (client) try { await client.close(); } catch (e) {}
    return { success: false, error: err.message };
  }
}

// 测试某个服务器：返回工具名列表或错误
async function testServer(url) {
  let client;
  try {
    client = await connectTo(url);
    const result = await client.listTools();
    await client.close();
    return { ok: true, tools: ((result && result.tools) || []).map(t => t.name) };
  } catch (err) {
    if (client) try { await client.close(); } catch (e) {}
    return { ok: false, error: err.message };
  }
}

// ===== 兼容旧接口：记忆读写（依赖某个服务器提供 memory_* 工具）=====
function parseMemoryItems(output) {
  try {
    const parsed = JSON.parse(output);
    const box = parsed.data || {};
    const arr = Array.isArray(box) ? box : (box.data || []);
    return arr.map(item => ({
      id: item.memory.id,
      title: item.memory.title,
      content: item.memory.content,
      layer: item.memory.layer,
      importance: item.memory.importance,
      author: item.memory.author,
      created_at: item.memory.created_at,
      last_accessed: item.memory.last_accessed
    }));
  } catch (e) { return []; }
}

async function fetchMemories(limit = 20) {
  const r = await callTool('memory_list', { limit, sort_by: 'importance', sort_order: 'desc' });
  return r.success ? parseMemoryItems(r.output) : [];
}

async function searchMemories(query, limit = 10) {
  const r = await callTool('memory_search', { query, limit });
  return r.success ? parseMemoryItems(r.output) : [];
}

module.exports = { getServers, listTools, callTool, testServer, invalidateCache, fetchMemories, searchMemories };
