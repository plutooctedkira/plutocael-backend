const { queryAll, queryOne, run } = require('./db');

// 记录每次 API 调用的 token 用量和花费
function logUsage(sessionId, model, usage) {
  if (!usage) return;
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;

  // 从 pricing_config 获取当前定价
  const pricing = queryOne("SELECT * FROM pricing_config WHERE model = ? AND is_current = 1", [model])
    || queryOne("SELECT * FROM pricing_config WHERE is_current = 1")
    || { input_price: 3.0, output_price: 15.0, cache_read_price: 0.3, cache_write_price: 3.75 };

  const inputCost = (inputTokens / 1_000_000) * pricing.input_price;
  const outputCost = (outputTokens / 1_000_000) * pricing.output_price;
  const cacheReadCost = (cacheRead / 1_000_000) * (pricing.cache_read_price || 0.3);
  const cacheWriteCost = (cacheWrite / 1_000_000) * (pricing.cache_write_price || 3.75);
  const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;

  run(
    `INSERT INTO gateway_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [String(sessionId || ''), model, inputTokens, outputTokens, cacheRead, cacheWrite, totalCost]
  );
}

// 获取用量统计
function getStats(period = 'today') {
  const dateFilter = period === 'today'
    ? "date(created_at) = date('now', '+8 hours')"
    : period === 'month'
      ? "strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', '+8 hours')"
      : "1=1";

  const summary = queryOne(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(cache_write_tokens), 0) as total_cache_write,
      ROUND(COALESCE(SUM(cost_usd), 0), 4) as total_cost,
      COUNT(*) as request_count
    FROM gateway_usage WHERE ${dateFilter}
  `);

  const byModel = queryAll(`
    SELECT model,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      ROUND(COALESCE(SUM(cost_usd), 0), 4) as cost
    FROM gateway_usage WHERE ${dateFilter}
    GROUP BY model
    ORDER BY cost DESC
  `);

  return { summary, byModel };
}

// 获取当前定价配置
function getCurrentPricing() {
  return queryAll("SELECT * FROM pricing_config WHERE is_current = 1 ORDER BY id");
}

module.exports = { logUsage, getStats, getCurrentPricing };