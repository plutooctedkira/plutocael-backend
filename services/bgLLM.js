// 后台任务 LLM 统一调用层：同时支持 Anthropic 和 OpenAI 两种接口格式
// 便宜渠道可能是 new-api 代理(Anthropic格式)也可能是 DeepSeek 官方(OpenAI格式)，
// 首次调用自动探测哪种格式能通，之后缓存结果直连
const { getBackgroundApiConfig } = require('../db');

const formatCache = new Map(); // `${root}|${model}` -> 'anthropic' | 'openai'

const baseRoot = (url) => String(url || '')
  .replace(/\/v1\/(messages|chat\/completions)\/?$/, '')
  .replace(/\/$/, '');

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

async function callAnthropic(root, key, model, system, user, maxTokens, timeoutMs) {
  const resp = await fetchWithTimeout(`${root}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  }, timeoutMs);
  const body = await resp.text();
  if (!resp.ok) return { ok: false, status: resp.status, body };
  const data = JSON.parse(body);
  return { ok: true, text: (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim() };
}

async function callOpenAI(root, key, model, system, user, maxTokens, timeoutMs) {
  const url = root.endsWith('/v1') ? `${root}/chat/completions` : `${root}/v1/chat/completions`;
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  }, timeoutMs);
  const body = await resp.text();
  if (!resp.ok) return { ok: false, status: resp.status, body };
  const data = JSON.parse(body);
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  return { ok: true, text: String((msg && msg.content) || '').trim() };
}

// 用指定配置调一次（test-api 等需要临时配置的场景用）
async function completeWith(cfg, { system, user, maxTokens = 500, timeoutMs = 30000 }) {
  const root = baseRoot(cfg.url || cfg.base);
  const key = cfg.key;
  const model = cfg.model;
  if (!root || !key) throw new Error('后台任务 API 未配置');
  const cacheKey = `${root}|${model}`;
  const order = formatCache.get(cacheKey) === 'openai'
    ? ['openai', 'anthropic'] : ['anthropic', 'openai'];
  let lastErr = null;
  for (const fmt of order) {
    try {
      const r = fmt === 'anthropic'
        ? await callAnthropic(root, key, model, system, user, maxTokens, timeoutMs)
        : await callOpenAI(root, key, model, system, user, maxTokens, timeoutMs);
      if (r.ok) { formatCache.set(cacheKey, fmt); return r.text; }
      let msg = r.body.slice(0, 300);
      try { const j = JSON.parse(r.body); msg = (j.error && (j.error.message || j.error.code)) || msg; } catch (e) {}
      lastErr = Object.assign(new Error(msg || `HTTP ${r.status}`), { status: r.status });
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('后台 LLM 调用失败');
}

// 用便宜渠道配置调一次（后台任务默认入口）
async function bgComplete(opts) {
  return completeWith(getBackgroundApiConfig(), opts);
}

module.exports = { bgComplete, completeWith };
