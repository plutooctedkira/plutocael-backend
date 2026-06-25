const express = require('express');
const router = express.Router();
const { queryAll, queryOne, run, lastInsertId } = require('../db');

// 获取所有会话
router.get('/', (req, res) => {
  try {
    const data = queryAll("SELECT * FROM sessions ORDER BY updated_at DESC");
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 创建新会话
router.post('/', (req, res) => {
  try {
    const name = req.body.name || '新对话';
    run("INSERT INTO sessions (name) VALUES (?)", [name]);
    const id = lastInsertId();
    const session = queryOne("SELECT * FROM sessions WHERE id = ?", [id]);
    res.json(session);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 获取单个会话
router.get('/:id', (req, res) => {
  try {
    const data = queryOne("SELECT * FROM sessions WHERE id = ?", [req.params.id]);
    if (!data) return res.status(404).json({ error: '会话不存在' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 更新会话
router.put('/:id', (req, res) => {
  try {
    const { name } = req.body;
    run("UPDATE sessions SET name = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?", [name, req.params.id]);
    const data = queryOne("SELECT * FROM sessions WHERE id = ?", [req.params.id]);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 删除会话（级联删除消息）
router.delete('/:id', (req, res) => {
  try {
    run("DELETE FROM messages WHERE session_id = ?", [req.params.id]);
    run("DELETE FROM sessions WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
