// 日记：从 OB 的 letter_read 工具拉信件，解析成 [{id,author,date,title,content}]
const router = require('express').Router();
const { callTool } = require('../mcp-client');

router.get('/', async (req, res) => {
  try {
    const args = req.query.q ? { query: String(req.query.q).slice(0, 160) } : {};
    const r = await callTool('letter_read', args);
    if (!r || !r.success) return res.status(502).json({ error: (r && r.error) || 'letter_read 调用失败', entries: [] });
    const text = String(r.output || '');
    const entries = [];
    let cur = null;
    for (const line of text.split('\n')) {
      // 头行：[hexid] 作者 · 2026-07-24 · 标题
      const m = line.match(/^\[([0-9a-fA-F]+)\]\s*(.+?)\s*·\s*(\d{4}-\d{2}-\d{2})\s*·\s*(.+)$/);
      if (m) {
        if (cur) entries.push(cur);
        cur = { id: m[1], author: m[2].trim(), date: m[3], title: m[4].trim(), content: '' };
      } else if (cur) {
        if (line.trim() === '=== 信件 ===' || line.trim() === '') { cur.content += cur.content ? '\n' : ''; continue; }
        cur.content += (cur.content && !cur.content.endsWith('\n') ? '\n' : '') + line;
      }
    }
    if (cur) entries.push(cur);
    entries.forEach(e => { e.content = e.content.trim(); });
    // 新的在前
    entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message, entries: [] }); }
});

module.exports = router;
