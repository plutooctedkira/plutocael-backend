const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const MCP_URL = process.env.MCP_URL || 'https://mcp.plutocael.icu/mcp';

async function fetchMemories(limit = 20) {
  let client;
  try {
    const transport = new SSEClientTransport(new URL(MCP_URL));
    client = new Client({ name: 'plutocael-backend', version: '1.0.0' });
    await client.connect(transport);

    const result = await client.callTool({
      name: 'memory_list',
      arguments: { limit, sort_by: 'importance', sort_order: 'desc' }
    });

    await client.close();

    // 解析返回的记忆数据
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
    if (client) {
      try { await client.close(); } catch (e) {}
    }
    return [];
  }
}

async function searchMemories(query, limit = 10) {
  let client;
  try {
    const transport = new SSEClientTransport(new URL(MCP_URL));
    client = new Client({ name: 'plutocael-backend', version: '1.0.0' });
    await client.connect(transport);

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
    if (client) {
      try { await client.close(); } catch (e) {}
    }
    return [];
  }
}

module.exports = { fetchMemories, searchMemories };
