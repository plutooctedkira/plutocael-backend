const express = require('express');
const router = express.Router();
const { queryAll, run } = require('../db');

// 获取某个会话的所有消息
router.get('/session/:sessionId', (req, res) => {
  try {
    const data = queryAll("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC", [req.params.sessionId]);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 获取某个会话的可见消息
router.get('/session/:sessionId/visible', (req, res) => {
  try {
    const data = queryAll("SELECT * FROM messages WHERE session_id = ? AND visible = 1 ORDER BY created_at ASC", [req.params.sessionId]);
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
