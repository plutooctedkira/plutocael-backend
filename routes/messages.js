const express = require('express');
const router = express.Router();
const { queryAll, run } = require('../db');

// 哪些日期有聊天记录（日历视图用）：[{d:"2026-07-20", c:20}, ...]
router.get('/dates/all', (req, res) => {
  try {
    const rows = queryAll("SELECT date(created_at) as d, COUNT(*) as c FROM messages WHERE visible = 1 GROUP BY date(created_at) ORDER BY d");
    res.json({ dates: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 全局搜索聊天记录：?q=关键词 &type=image|link &date=YYYY-MM-DD（三者至少一个）
router.get('/search/all', (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const type = String(req.query.type || '');
    const date = String(req.query.date || '').trim();
    const where = ['m.visible = 1'];
    const params = [];
    if (q) { where.push('m.content LIKE ?'); params.push('%' + q + '%'); }
    if (type === 'image') where.push("m.msg_type = 'image'");
    if (type === 'link') where.push("(m.content LIKE '%http://%' OR m.content LIKE '%https://%')");
    if (date) { where.push('date(m.created_at) = ?'); params.push(date); }
    if (!q && !type && !date) return res.json({ items: [] });
    const items = queryAll(`
      SELECT m.id, m.session_id, m.role, m.msg_type, substr(m.content, 1, 140) as snippet, m.created_at, s.name as session_name
      FROM messages m LEFT JOIN sessions s ON s.id = m.session_id
      WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT 100
    `, params);
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 获取某个会话的所有消息
router.get('/session/:sessionId', (req, res) => {
  try {
    const data = queryAll("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC", [req.params.sessionId]);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 获取某个会话的可见消息
router.get('/session/:sessionId/visible', (req, res) => {
  try {
    const data = queryAll("SELECT * FROM messages WHERE session_id = ? AND visible = 1 ORDER BY id ASC", [req.params.sessionId]);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 添加消息
router.post('/', (req, res) => {
  try {
    const { session_id, role, content, reasoning_content } = req.body;
    run("INSERT INTO messages (session_id, role, content, reasoning_content) VALUES (?, ?, ?, ?)",
      [session_id, role, content, reasoning_content || null]);
    run("UPDATE sessions SET updated_at = datetime('now', '+8 hours') WHERE id = ?", [session_id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 标记消息为不可见
router.put('/:id/hide', (req, res) => {
  try {
    run("UPDATE messages SET visible = 0 WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 删除消息
router.delete('/:id', (req, res) => {
  try {
    run("DELETE FROM messages WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
