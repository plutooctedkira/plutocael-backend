const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const MCP_URL = process.env.MCP_URL || 'https://mcp.plutocael.icu/mcp';

async function connectMCP() {
  const transport = new SSEClientTransport(new URL(MCP_URL));
  const client = new Client({ name: 'plutocael-backend', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

// 获取 MCP 服务器上所有可用工具列表
async function listTools() {
  let client;
  try {
    client = await connectMCP();
    const result = await client.listTools();
    await client.close();
    return (result && result.tools) ? result.tools.map(t => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || {} })) : [];
  } catch (err) {
    console.error('MCP listTools 失败:', err.message);
    if (client) try { await client.close(); } catch (e) {}
    return [];
  }
}

// 调用 MCP 工具
async function callTool(toolName, args = {}) {
  let client;
  try {
    client = await connectMCP();
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

async function fetchMemories(limit = 20) {
  let client;
  try {
    client = await connectMCP();
    const result = await client.callTool({
      name: 'memory_list',
      arguments: { limit, sort_by: 'importance', sort_order: 'desc' }
    });
    await client.close();
    if (result && result.content) {
      const textBlock = result.content.find(b => b.type === 'text');
      if (textBlock) {
        const parsed = JSON.parse(textBlock.text);
        if (parsed.success && parsed.data && parsed.data.data) {
          return parsed.data.data.map(item => ({
            title: item.memory.title,
            content: item.memory.content,
            layer: item.memory.layer,
            importance: item.memory.importance
          }));
        }
      }
    }
    return [];
  } catch (err) {
    console.error('MCP记忆读取失败:', err.message);
    if (client) try { await client.close(); } catch (e) {}
    return [];
  }
}

async function searchMemories(query, limit = 10) {
  let client;
  try {
    client = await connectMCP();
    const result = await client.callTool({
      name: 'memory_search',
      arguments: { query, limit }
    });
    await client.close();
    if (result && result.content) {
      const textBlock = result.content.find(b => b.type === 'text');
      if (textBlock) {
        const parsed = JSON.parse(textBlock.text);
        if (parsed.success && parsed.data) {
          return parsed.data.map(item => ({
            title: item.memory.title,
            content: item.memory.content,
            layer: item.memory.layer,
            importance: item.memory.importance
          }));
        }
      }
    }
    return [];
  } catch (err) {
    console.error('MCP记忆搜索失败:', err.message);
    if (client) try { await client.close(); } catch (e) {}
    return [];
  }
}

module.exports = { listTools, callTool, fetchMemories, searchMemories, MCP_URL };