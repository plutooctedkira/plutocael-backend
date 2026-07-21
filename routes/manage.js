// 聊天记录管理：导出(.json/.md)、导入(.json)、服务器端备份与恢复
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { queryAll, queryOne, run, lastInsertId, initDB, save } = require('../db');

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

// ── 智能导入：任意 .md/.json 丢给 DeepSeek 后台清洗(去重/剔无效)后并入当前对话 ──
const IMPORT_PROMPT = `你是聊天记录清洗器。下面是一段聊天记录原文（可能是 markdown 或任意格式）。任务：

1. 识别对话双方：用户(Jasmine一方)标 role="user"，AI(Cael/助手一方)标 role="assistant"。

2. 过滤 thinking/reasoning：AI 的思考过程、推理自白、"让我想想"、分析步骤、<thinking>/<reasoning> 标记段、或整条只是思考没有正式回复的消息 → 全部丢弃，只保留 AI 对用户说的正式回复。

3. 回退产生的多版本回复只留最后一条：同一条用户消息后面跟着多条内容相近但措辞不同的 AI 回复（重新生成/重试的痕迹）→ 只保留最后一个版本，前面的版本全部丢弃。

4. 手误刷新的连续 user 消息：用户同一句话（或几乎相同）连续出现多次 = 重发 → 合并成一条，只保留最后一次。

5. 空消息丢掉：content 去掉空白后为空、或只有纯符号/表情标记的消息 → 丢弃。

6. 孤儿 tool_call / tool_result 丢掉：没有配对的工具调用块、工具返回块、函数调用 JSON 残片、[tool_call]/[tool_result] 之类的标记 → 全部丢弃（这些不是对话内容）。

7. 整段对话成对重复出现（用户+AI 一起重复）→ 整组只保留一次。

8. 丢弃其它无效内容：系统提示、单独成行的时间戳、导出工具的页眉页脚。

保留下来的消息一律用原文，不要改写、不要总结、不要翻译。某条消息带明确时间就输出 time 字段(YYYY-MM-DD HH:MM:SS)，没有就省略。

只输出 JSON 数组，不要输出任何其它文字：
[{"role":"user","content":"..."},{"role":"assistant","content":"...","time":"2026-07-01 12:00:00"}]
若这段全是无效内容，输出 []`;

let importJob = null; // {status, totalChunks, doneChunks, imported, skipped, error}

router.post('/import-smart', (req, res) => {
  try {
    const body = req.body || {};
    const text = String(body.content || '').slice(0, 2000000);
    if (!text.trim()) return res.status(400).json({ error: '文件是空的' });
    if (importJob && importJob.status === 'running') return res.status(409).json({ error: '已有导入任务在进行中，稍等一下' });

    // 先试试是不是本应用导出的 json，是的话不用花 DeepSeek 的钱
    let directMsgs = null;
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j.sessions)) {
        directMsgs = j.sessions.flatMap(s => s.messages || [])
          .filter(m => (m.msg_type || 'text') === 'text')
          .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || ''), time: m.created_at || null }));
      }
    } catch (e) { /* 不是json，走DS清洗 */ }

    // 清洗结果写入暂存区（先清空旧暂存），用户审阅后再上传到对话
    run("DELETE FROM import_staging");
    importJob = { status: 'running', totalChunks: 0, doneChunks: 0, imported: 0, skipped: 0, error: null, cancelRequested: false };
    res.json({ ok: true, started: true });

    setImmediate(async () => {
      try {
        let ord = 0;
        const seen = new Set();
        const stage = (m) => {
          const c = String(m.content || '').trim();
          if (!c || seen.has(c)) { importJob.skipped++; return; }
          seen.add(c);
          run("INSERT INTO import_staging (role, content, time, ord) VALUES (?,?,?,?)",
            [m.role === 'assistant' ? 'assistant' : 'user', c, m.time || m.created_at || null, ord++]);
          importJob.imported++;
        };
        if (directMsgs) {
          importJob.totalChunks = 1;
          for (const m of directMsgs) stage(m);
          importJob.doneChunks = 1;
        } else {
          // 切块（约3600字符）逐块交给 DeepSeek 解析+清洗：让重发+多版本重生成尽量落在同一块看到全貌
          const lines = text.split(/\r?\n/);
          const chunks = []; let cur = []; let len = 0;
          for (const l of lines) { cur.push(l); len += l.length + 1; if (len > 3600) { chunks.push(cur.join('\n')); cur = []; len = 0; } }
          if (cur.length) chunks.push(cur.join('\n'));
          importJob.totalChunks = chunks.length;
          const { bgComplete } = require('../services/bgLLM');
          for (const chunk of chunks) {
            if (importJob.cancelRequested) { importJob.status = 'cancelled'; console.log(`[import-smart] 已中断：暂存${importJob.imported}条后停止`); return; }
            try {
              const out = await bgComplete({ system: IMPORT_PROMPT, user: chunk, maxTokens: 4000, timeoutMs: 120000 });
              const mm = out.match(/\[[\s\S]*\]/);
              if (mm) for (const item of JSON.parse(mm[0])) stage(item);
            } catch (e) { console.warn('[import-smart] 块处理失败:', e.message); }
            importJob.doneChunks++;
          }
        }
        importJob.status = 'done';
        console.log(`[import-smart] 清洗完成：暂存${importJob.imported}条，跳过${importJob.skipped}条`);
      } catch (e) { importJob.status = 'error'; importJob.error = e.message; }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/import-status', (req, res) => { res.json(importJob || { status: 'idle' }); });

// 中断正在进行的导入（当前块处理完就停，已暂存的保留）
router.post('/import-cancel', (req, res) => {
  if (importJob && importJob.status === 'running') { importJob.cancelRequested = true; return res.json({ ok: true, cancelling: true }); }
  res.json({ ok: true, cancelling: false });
});

// ── 暂存审阅区：清洗结果先落这里，用户可改删，再选择上传到对话 / 备份 ──
router.get('/staging', (req, res) => {
  try { res.json({ items: queryAll("SELECT id, role, content, time FROM import_staging ORDER BY ord, id") }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/staging/:id', (req, res) => {
  try {
    const b = req.body || {};
    const fields = [], vals = [];
    if (b.content !== undefined) { fields.push('content = ?'); vals.push(String(b.content)); }
    if (b.role !== undefined) { fields.push('role = ?'); vals.push(b.role === 'assistant' ? 'assistant' : 'user'); }
    if (!fields.length) return res.status(400).json({ error: '没有可改的字段' });
    vals.push(req.params.id);
    run(`UPDATE import_staging SET ${fields.join(', ')} WHERE id = ?`, vals);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/staging/:id', (req, res) => {
  try { run("DELETE FROM import_staging WHERE id = ?", [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/staging/clear', (req, res) => {
  try { run("DELETE FROM import_staging"); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// 上传到当前对话：把暂存区全部插入目标会话（与已有消息去重），然后清空暂存
router.post('/staging/commit', (req, res) => {
  try {
    let sid = Number((req.body || {}).session_id) || 0;
    if (!sid) {
      const s = queryOne('SELECT id FROM sessions ORDER BY id DESC LIMIT 1');
      if (s) sid = s.id; else { run("INSERT INTO sessions (name) VALUES ('对话')"); sid = lastInsertId(); }
    }
    const rows = queryAll("SELECT role, content, time FROM import_staging ORDER BY ord, id");
    const existing = new Set(queryAll('SELECT content FROM messages WHERE session_id = ?', [sid]).map(r => String(r.content).trim()));
    let imported = 0, skipped = 0;
    for (const m of rows) {
      const c = String(m.content || '').trim();
      if (!c || existing.has(c)) { skipped++; continue; }
      existing.add(c);
      run("INSERT INTO messages (session_id, role, content, created_at) VALUES (?,?,?, COALESCE(?, datetime('now','+8 hours')))",
        [sid, m.role === 'assistant' ? 'assistant' : 'user', c, m.time || null]);
      imported++;
    }
    run("UPDATE sessions SET updated_at = datetime('now','+8 hours') WHERE id = ?", [sid]);
    run("DELETE FROM import_staging");
    res.json({ ok: true, imported, skipped, session_id: sid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 备份：把暂存区导出成 json/md 文件下载（不进对话）
router.get('/staging/export', (req, res) => {
  try {
    const fmt = req.query.format === 'md' ? 'md' : 'json';
    const rows = queryAll("SELECT role, content, time FROM import_staging ORDER BY ord, id");
    if (fmt === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="plutocael-staging.json"');
      return res.send(JSON.stringify({ app: 'plutocael', staged_at: nowStr(), messages: rows }, null, 1));
    }
    let md = `# Plutocael 暂存对话\n\n导出时间：${nowStr()}\n\n`;
    for (const m of rows) md += `**${m.role === 'user' ? 'Jasmine' : 'Cael'}**${m.time ? `（${m.time}）` : ''}\n\n${m.content}\n\n`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="plutocael-staging.md"');
    res.send(md);
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

// 本地备份：把当前数据库文件直接下载到用户设备
router.get('/backup/download', (req, res) => {
  try {
    try { save(); } catch (e) {} // 确保磁盘文件是最新的内存状态
    const name = `plutocael-${nowStr().replace(/[: ]/g, '-')}.db`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(fs.readFileSync(DB_PATH));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 删除某个云端备份
router.delete('/backups/:file', (req, res) => {
  try {
    const file = path.basename(String(req.params.file || ''));
    if (!/^plutocael-[\w.-]+\.db$/.test(file)) return res.status(400).json({ error: '文件名不合法' });
    const p = path.join(BACKUP_DIR, file);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 从本地上传的 .db 文件恢复：body {data: base64}
router.post('/restore-upload', async (req, res) => {
  try {
    const b64 = String((req.body || {}).data || '');
    if (!b64) return res.status(400).json({ error: '没有收到文件内容' });
    const buf = Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64');
    // 校验是 SQLite 文件（前16字节固定为 "SQLite format 3\0"）
    if (buf.slice(0, 15).toString('utf8') !== 'SQLite format 3') {
      return res.status(400).json({ error: '这不是有效的 Plutocael 备份文件(.db)' });
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, `plutocael-pre-restore-${nowStr().replace(/[: ]/g, '-')}.db`));
    fs.writeFileSync(DB_PATH, buf);
    await initDB();
    res.json({ ok: true });
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
