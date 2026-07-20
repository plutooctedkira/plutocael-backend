// 聊天记录管理：导出(.json/.md)、导入(.json)、服务器端备份与恢复
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { queryAll, run, lastInsertId, initDB } = require('../db');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'plutocael.db');
const BACKUP_DIR = path.join(ROOT, 'backups');

const nowStr = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

// 导出全部聊天记录：?format=json | md
router.get('/export', (req, res) => {
  try {
    const fmt = req.query.format === 'md' ? 'md' : 'json';
    const sessions = queryAll('SELECT * FROM sessions ORDER BY id');
    const data = sessions.map(s => ({
      name: s.name, created_at: s.created_at, updated_at: s.updated_at, summary: s.summary || null,
      messages: queryAll('SELECT role, content, msg_type, reasoning_content, tool_log, created_at FROM messages WHERE session_id = ? AND visible = 1 ORDER BY id', [s.id]),
    }));
    if (fmt === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="plutocael-chat.json"');
      return res.send(JSON.stringify({ app: 'plutocael', exported_at: nowStr(), sessions: data }, null, 1));
    }
    let md = `# Plutocael 聊天记录\n\n导出时间：${nowStr()}\n`;
    for (const s of data) {
      md += `\n---\n\n## ${s.name}（${s.created_at || ''}）\n\n`;
      for (const m of s.messages) {
        const who = m.role === 'user' ? 'Jasmine' : 'Cael';
        let text = m.content;
        if (m.msg_type === 'image') {
          try { const d = JSON.parse(m.content); text = (d.text ? d.text + ' ' : '') + '[图片]'; } catch (e) { text = '[图片]'; }
        }
        md += `**${who}**（${m.created_at || ''}）\n\n${text}\n\n`;
      }
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="plutocael-chat.md"');
    res.send(md);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 导入：仅支持本应用导出的 .json；会话以追加方式恢复，不覆盖现有
router.post('/import', (req, res) => {
  try {
    const body = req.body || {};
    const sessions = Array.isArray(body.sessions) ? body.sessions : null;
    if (!sessions) return res.status(400).json({ error: '文件格式不对：请选择之前从这里导出的 .json 文件' });
    let sCount = 0, mCount = 0;
    for (const s of sessions) {
      run("INSERT INTO sessions (name, created_at, updated_at, summary) VALUES (?, COALESCE(?, datetime('now','+8 hours')), COALESCE(?, datetime('now','+8 hours')), ?)",
        [String(s.name || '导入的对话') + '（导入）', s.created_at || null, s.updated_at || null, s.summary || null]);
      const sid = lastInsertId(); sCount++;
      for (const m of (s.messages || [])) {
        run("INSERT INTO messages (session_id, role, content, msg_type, reasoning_content, tool_log, created_at) VALUES (?,?,?,?,?,?, COALESCE(?, datetime('now','+8 hours')))",
          [sid, m.role === 'assistant' ? 'assistant' : 'user', String(m.content || ''), m.msg_type || 'text', m.reasoning_content || null, m.tool_log || null, m.created_at || null]);
        mCount++;
      }
    }
    res.json({ ok: true, sessions: sCount, messages: mCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 备份：把整个 SQLite 库快照到 backups/
router.post('/backup', (req, res) => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = nowStr().replace(/[: ]/g, '-');
    const name = `plutocael-${stamp}.db`;
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, name));
    res.json({ ok: true, file: name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/backups', (req, res) => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^plutocael-[\w.-]+\.db$/.test(f))
      .map(f => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { file: f, size: st.size, mtime: st.mtime }; })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ backups: files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 恢复：先把当前库自动快照一份(pre-restore)再覆盖，然后重新加载数据库
router.post('/restore', async (req, res) => {
  try {
    const file = path.basename(String((req.body || {}).file || ''));
    if (!/^plutocael-[\w.-]+\.db$/.test(file)) return res.status(400).json({ error: '备份文件名不合法' });
    const src = path.join(BACKUP_DIR, file);
    if (!fs.existsSync(src)) return res.status(404).json({ error: '备份不存在' });
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, `plutocael-pre-restore-${nowStr().replace(/[: ]/g, '-')}.db`));
    fs.copyFileSync(src, DB_PATH);
    await initDB(); // 重新从文件加载内存数据库
    res.json({ ok: true, restored: file });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
