const express = require('express');
const router = express.Router();
const { queryAll, queryOne, run, lastInsertId } = require('../db');
const { embedPost } = require('../vector-search');

// 获取所有记忆（支持按分类筛选）
router.get('/', (req, res) => {
  try {
    const { category } = req.query;
    let sql = 'SELECT * FROM memories';
    let params = [];

    if (category) {
      sql += ' WHERE category = ?';
      params.push(category);
    }

    sql += ' ORDER BY importance DESC, updated_at DESC';
    const memories = queryAll(sql, params);
    res.json(memories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取所有分类
router.get('/categories', (req, res) => {
  try {
    const rows = queryAll('SELECT DISTINCT category FROM memories ORDER BY category');
    const categories = rows.map(r => r.category);
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 搜索记忆（关键词）
router.get('/search', (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);

    const memories = queryAll(
      'SELECT * FROM memories WHERE content LIKE ? ORDER BY importance DESC',
      [`%${q}%`]
    );
    res.json(memories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取单条记忆
router.get('/:id', (req, res) => {
  try {
    const memory = queryOne('SELECT * FROM memories WHERE id = ?', [req.params.id]);
    if (!memory) return res.status(404).json({ error: 'not found' });

    // 更新最后访问时间
    run("UPDATE memories SET last_accessed = datetime('now', '+8 hours') WHERE id = ?", [req.params.id]);

    res.json(memory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建记忆
router.post('/', (req, res) => {
  try {
    const { content, category, importance } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });

    run(
      'INSERT INTO memories (content, category, importance) VALUES (?, ?, ?)',
      [content, category || '生活', importance || 3]
    );

    const id = lastInsertId();

    // 异步触发 Embedding（不阻塞响应）
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const apiBaseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
    embedPost(id, content, apiKey, apiBaseUrl).catch(e => console.warn('Post embed failed:', e.message));

    const memory = queryOne('SELECT * FROM memories WHERE id = ?', [id]);
    res.json(memory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 更新记忆
router.put('/:id', (req, res) => {
  try {
    const { content, category, importance } = req.body;
    run(
      "UPDATE memories SET content = ?, category = ?, importance = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?",
      [content, category, importance, req.params.id]
    );

    const memory = queryOne('SELECT * FROM memories WHERE id = ?', [req.params.id]);
    if (!memory) return res.status(404).json({ error: 'not found' });
    res.json(memory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除记忆
router.delete('/:id', (req, res) => {
  try {
    run('DELETE FROM memories WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
