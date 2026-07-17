const router = require('express').Router();
const {
  configured,
  dashboardRequest,
  normalizeBucket,
  mapDashboardError,
} = require('../services/ombreDashboard');

function sendError(res, error) {
  console.error('[Ombre Dashboard]', error.code || error.message);
  const mapped = mapDashboardError(error);
  res.status(mapped.status).json({ error: mapped.error, message: mapped.message });
}

// 状态检查：Ombre Brain 在不在线 + 记忆总量
router.get('/status', async (req, res) => {
  if (!configured()) {
    return res.status(503).json({ available: false, error: 'ombre_not_configured' });
  }
  try {
    const data = await dashboardRequest('/api/status');
    const buckets = data.buckets || {};
    res.json({
      available: true,
      version: data.version || null,
      total: Number(buckets.total ?? data.total ?? 0),
      permanent: Number(buckets.permanent ?? 0),
      dynamic: Number(buckets.dynamic ?? 0),
      archived: Number(buckets.archive ?? buckets.archived ?? 0),
    });
  } catch (error) { sendError(res, error); }
});

// 记忆列表：支持 ?type=dynamic/permanent/archived 和 ?state=pinned/resolved 筛选
router.get('/buckets', async (req, res) => {
  try {
    const data = await dashboardRequest('/api/buckets');
    let items = (Array.isArray(data) ? data : data.buckets || data.items || [])
      .map(item => normalizeBucket(item));
    const type = String(req.query.type || '').toLowerCase();
    const state = String(req.query.state || '').toLowerCase();
    if (type) items = items.filter(item => item.type.toLowerCase() === type);
    if (state === 'pinned') items = items.filter(item => item.pinned);
    if (state === 'resolved') items = items.filter(item => item.resolved);
    items.sort((a, b) => new Date(b.lastActiveAt || 0) - new Date(a.lastActiveAt || 0));
    res.json({ items, total: items.length });
  } catch (error) { sendError(res, error); }
});

// 搜索记忆
router.get('/search', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 160);
  if (!query) return res.json({ items: [], total: 0 });
  try {
    const data = await dashboardRequest(`/api/search?q=${encodeURIComponent(query)}`);
    const raw = Array.isArray(data) ? data : data.results || data.items || data.buckets || [];
    const items = raw.map(item => normalizeBucket(item));
    res.json({ items, total: items.length, query });
  } catch (error) { sendError(res, error); }
});

// 单条记忆完整内容
router.get('/buckets/:id', async (req, res) => {
  try {
    const data = await dashboardRequest(`/api/bucket/${encodeURIComponent(req.params.id)}`);
    res.json(normalizeBucket(data.bucket || data));
  } catch (error) { sendError(res, error); }
});

// 管理：修改单条记忆（钉选/已解决/重要度），白名单透传给 OB
router.patch('/buckets/:id', async (req, res) => {
  const fields = {};
  for (const k of ['pinned', 'resolved', 'importance']) {
    if (req.body[k] !== undefined) fields[k] = req.body[k];
  }
  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'no_fields', message: '没有可修改的字段' });
  }
  try {
    const data = await dashboardRequest(`/api/bucket/${encodeURIComponent(req.params.id)}`, {
      method: 'PATCH', data: fields,
    });
    res.json(normalizeBucket(data.bucket || data));
  } catch (error) { sendError(res, error); }
});

// Breath Lab 调试：查询词的记忆检索打分明细
router.get('/breath-debug', async (req, res) => {
  const params = new URLSearchParams();
  params.set('q', String(req.query.q || '').trim().slice(0, 160));
  if (req.query.valence !== undefined && req.query.valence !== '') params.set('valence', String(req.query.valence));
  if (req.query.arousal !== undefined && req.query.arousal !== '') params.set('arousal', String(req.query.arousal));
  try {
    const data = await dashboardRequest(`/api/breath-debug?${params.toString()}`);
    res.json(data);
  } catch (error) { sendError(res, error); }
});

module.exports = router;
