// 待办：首页的 Todo / Done List。同一张表，done 决定落在哪个板块
const router = require('express').Router();
const { queryAll, queryOne, run, lastInsertId, save } = require('../db');

// 全部待办，未完成在前，各自按时间倒序
router.get('/', (req, res) => {
  try {
    const items = queryAll(`
      SELECT id, content, done, done_at, created_at FROM todos
      ORDER BY done ASC, COALESCE(done_at, created_at) DESC
    `);
    res.json({ items: items.map(t => ({ ...t, done: !!t.done })) });
  } catch (e) { res.status(500).json({ error: e.message, items: [] }); }
});

router.post('/', (req, res) => {
  try {
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: '内容不能为空' });
    run('INSERT INTO todos (content) VALUES (?)', [content.slice(0, 500)]);
    const id = lastInsertId();
    save();
    res.json({ ...queryOne('SELECT id, content, done, done_at, created_at FROM todos WHERE id = ?', [id]), done: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 勾选/取消勾选，或改内容
router.patch('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const cur = queryOne('SELECT id FROM todos WHERE id = ?', [id]);
    if (!cur) return res.status(404).json({ error: '没有这条待办' });
    if (req.body.done !== undefined) {
      const done = req.body.done ? 1 : 0;
      // 勾上才记完成时间，取消勾选就抹掉，Done List 才好按完成时间排
      run(`UPDATE todos SET done = ?, done_at = ${done ? "datetime('now', '+8 hours')" : 'NULL'} WHERE id = ?`, [done, id]);
    }
    if (typeof req.body.content === 'string' && req.body.content.trim()) {
      run('UPDATE todos SET content = ? WHERE id = ?', [req.body.content.trim().slice(0, 500), id]);
    }
    save();
    const t = queryOne('SELECT id, content, done, done_at, created_at FROM todos WHERE id = ?', [id]);
    res.json({ ...t, done: !!t.done });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    run('DELETE FROM todos WHERE id = ?', [Number(req.params.id)]);
    save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
