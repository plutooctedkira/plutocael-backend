// Ombre Brain Dashboard 代理层：替前端管理登录态，隐藏密码，统一数据格式
// 前端 → 本后端 → OB Dashboard API（ob.plutocael.icu）

const DASHBOARD_URL = String(
  process.env.OMBRE_DASHBOARD_URL || process.env.OMBRE_BRAIN_URL || ''
).replace(/\/$/, '');
const DASHBOARD_PASSWORD = process.env.OMBRE_DASHBOARD_PASSWORD || '';
const REQUEST_TIMEOUT_MS = Number(process.env.OMBRE_DASHBOARD_TIMEOUT_MS || 8000);

// ── 会话状态 ──
let sessionCookie = '';
let loginPromise = null;

function configured() {
  return Boolean(DASHBOARD_URL);
}

function captureCookies(headers) {
  // Node 18.14+ 的 fetch headers 有 getSetCookie()；老版本回退取单值
  let values = [];
  if (typeof headers.getSetCookie === 'function') values = headers.getSetCookie();
  else { const v = headers.get('set-cookie'); if (v) values = [v]; }
  if (!values.length) return;
  sessionCookie = values.map(v => String(v).split(';')[0]).join('; ');
}

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally { clearTimeout(timer); }
}

async function login() {
  if (!configured()) {
    throw Object.assign(new Error('Ombre Dashboard URL is not configured'), { code: 'OMBRE_NOT_CONFIGURED' });
  }
  if (!DASHBOARD_PASSWORD) {
    throw Object.assign(new Error('Ombre Dashboard password is not configured'), { code: 'OMBRE_AUTH_NOT_CONFIGURED' });
  }
  const response = await fetchWithTimeout(`${DASHBOARD_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DASHBOARD_PASSWORD }),
  });
  if (response.status >= 400) {
    throw Object.assign(new Error('Ombre Dashboard login failed'), { code: 'OMBRE_AUTH_FAILED', status: response.status });
  }
  captureCookies(response.headers);
  if (!sessionCookie) {
    throw Object.assign(new Error('Ombre Dashboard did not return a session cookie'), { code: 'OMBRE_AUTH_FAILED' });
  }
  return sessionCookie;
}

// 并发去重：同时多个请求发现没登录时共用同一个登录 Promise
async function ensureLoggedIn() {
  if (sessionCookie) return sessionCookie;
  if (!loginPromise) {
    loginPromise = login().finally(() => { loginPromise = null; });
  }
  return loginPromise;
}

// 核心代理：401 时自动重登再试一次，前端永远不用管会话过期
async function dashboardRequest(path, options = {}, retried = false) {
  if (!configured()) {
    throw Object.assign(new Error('Ombre Dashboard is not configured'), { code: 'OMBRE_NOT_CONFIGURED' });
  }
  await ensureLoggedIn().catch(err => { if (err.code !== 'OMBRE_AUTH_NOT_CONFIGURED') throw err; });
  const headers = { ...(options.headers || {}) };
  const cookieAtRequest = sessionCookie;
  if (cookieAtRequest) headers.Cookie = cookieAtRequest;

  const response = await fetchWithTimeout(`${DASHBOARD_URL}${path}`, {
    method: options.method || 'GET',
    body: options.data !== undefined ? JSON.stringify(options.data) : undefined,
    headers: options.data !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
  });
  captureCookies(response.headers);

  if (response.status === 401 && !retried) {
    if (!sessionCookie || sessionCookie === cookieAtRequest) {
      sessionCookie = '';
      await ensureLoggedIn();
    }
    return dashboardRequest(path, options, true);
  }
  if (response.status >= 400) {
    const error = new Error(`Ombre Dashboard returned HTTP ${response.status}`);
    error.code = response.status === 401 ? 'OMBRE_AUTH_FAILED' : 'OMBRE_UPSTREAM_ERROR';
    error.status = response.status;
    throw error;
  }
  return response.json();
}

// ── 数据整理：兼容 OB 不同版本的字段名，输出统一结构 ──
function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}
function numberValue(...values) {
  const match = values.find(v => v !== undefined && v !== null && v !== '');
  const n = Number(match);
  return Number.isFinite(n) ? n : null;
}
function booleanValue(value) {
  if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase());
  return Boolean(value);
}

function normalizeBucket(bucket = {}) {
  const meta = bucket.meta || bucket.metadata || {};
  const content = String(bucket.content || bucket.text || bucket.body || '');
  const preview = String(bucket.content_preview || bucket.contentPreview || bucket.preview || content);
  return {
    id: String(bucket.id || bucket.bucket_id || bucket.name || ''),
    name: String(bucket.name || bucket.title || meta.name || bucket.id || ''),
    content,
    contentPreview: preview.replace(/\s+/g, ' ').trim().slice(0, 180),
    type: String(bucket.type || meta.type || 'dynamic'),
    domains: arrayValue(bucket.domains || bucket.domain || meta.domain),
    tags: arrayValue(bucket.tags || meta.tags),
    importance: numberValue(bucket.importance, meta.importance) ?? 5,
    valence: numberValue(bucket.valence, meta.valence),
    arousal: numberValue(bucket.arousal, meta.arousal),
    pinned: booleanValue(bucket.pinned ?? meta.pinned),
    resolved: booleanValue(bucket.resolved ?? meta.resolved),
    digested: booleanValue(bucket.digested ?? meta.digested),
    activationCount: numberValue(bucket.activation_count, meta.activation_count) ?? 0,
    createdAt: bucket.created_at || bucket.created || meta.created || null,
    lastActiveAt: bucket.last_active_at || bucket.last_active || meta.last_active
      || bucket.created_at || meta.created || null,
  };
}

function mapDashboardError(error) {
  const known = ['OMBRE_NOT_CONFIGURED', 'OMBRE_AUTH_NOT_CONFIGURED', 'OMBRE_AUTH_FAILED'];
  if (known.includes(error.code)) {
    return {
      status: error.code === 'OMBRE_NOT_CONFIGURED' ? 503 : 502,
      error: error.code.toLowerCase(),
      message: 'Ombre Brain 暂时无法连接',
    };
  }
  return { status: 503, error: 'ombre_unavailable', message: 'Ombre Brain 暂时没有回应' };
}

module.exports = { configured, dashboardRequest, normalizeBucket, mapDashboardError };
