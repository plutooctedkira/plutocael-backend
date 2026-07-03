const express = require('express');
const router = express.Router();
const { queryAll, queryOne, run, lastInsertId } = require('../db');

// 获取所有留言（新的在前）
router.get('/', (req, res) => {
  try {
    const data = queryAll("SELECT * FROM board_messages ORDER BY id DESC");
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 发留言
router.post('/', (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'content required' });
    run("INSERT INTO board_messages (content) VALUES (?)", [content.trim()]);
    const msg = queryOne("SELECT * FROM board_messages WHERE id = ?", [lastInsertId()]);
    res.json(msg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 删留言
router.delete('/:id', (req, res) => {
  try {
    run("DELETE FROM board_messages WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
