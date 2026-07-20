// 聊天记录管理：导出(.json/.md)、导入(.json)、服务器端备份与恢复
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { queryAll, queryOne, run, lastInsertId, initDB } = require('../db');

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

2. 识别并合并"重发/重新生成"的痕迹——这是重点：
   - 用户同一句话（或几乎相同的话）连续出现多次 = 用户在重发 → 只保留一次；
   - 同一条用户消息后面跟着多条 AI 回复，内容相近但措辞不同 = AI 被重新生成了多个版本 → 只保留最后一个版本，前面的版本全部丢弃；
   - 一段对话整体重复出现（用户+AI成对重复）→ 整组只保留一次；
   - AI 回复里混着思考过程（推理自白、"让我想想"、分析步骤、<thinking>之类的标记段），之后才是正式回复 → 思考过程丢弃，只保留正式回复。

3. 丢弃无效内容：系统提示、单独成行的时间戳、空白、纯符号、导出工具的页眉页脚。

4. 保留下来的消息一律用原文，不要改写、不要总结、不要翻译。

5. 某条消息带明确时间就输出 time 字段(YYYY-MM-DD HH:MM:SS)，没有就省略。

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

    // 目标会话：优先用前端传来的，否则最新会话，再没有就建一个
    let sid = Number(body.session_id) || 0;
    if (!sid) {
      const s = queryOne('SELECT id FROM sessions ORDER BY id DESC LIMIT 1');
      if (s) sid = s.id;
      else { run("INSERT INTO sessions (name) VALUES ('对话')"); sid = lastInsertId(); }
    }

    // 先试试是不是本应用导出的 json，是的话不用花 DeepSeek 的钱
    let directMsgs = null;
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j.sessions)) {
        directMsgs = j.sessions.flatMap(s => s.messages || [])
          .filter(m => (m.msg_type || 'text') === 'text')
          .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || ''), created_at: m.created_at || null }));
      }
    } catch (e) { /* 不是json，走DS清洗 */ }

    importJob = { status: 'running', totalChunks: 0, doneChunks: 0, imported: 0, skipped: 0, error: null, cancelRequested: false };
    res.json({ ok: true, started: true, session_id: sid });

    setImmediate(async () => {
      try {
        const existing = new Set(queryAll('SELECT content FROM messages WHERE session_id = ?', [sid]).map(r => String(r.content).trim()));
        const insert = (m) => {
          const c = String(m.content || '').trim();
          if (!c || existing.has(c)) { importJob.skipped++; return; }
          existing.add(c);
          run("INSERT INTO messages (session_id, role, content, created_at) VALUES (?,?,?, COALESCE(?, datetime('now','+8 hours')))",
            [sid, m.role === 'assistant' ? 'assistant' : 'user', c, m.created_at || m.time || null]);
          importJob.imported++;
        };
        if (directMsgs) {
          importJob.totalChunks = 1;
          for (const m of directMsgs) insert(m);
          importJob.doneChunks = 1;
        } else {
          // 切块（约2600字符一块）逐块交给 DeepSeek 解析+清洗
          const lines = text.split(/\r?\n/);
          const chunks = []; let cur = []; let len = 0;
          // 块切大一点(约3600字符)：让"一次重发+多个重生成版本"尽量落在同一块里，DS才看得到全貌去合并
          for (const l of lines) { cur.push(l); len += l.length + 1; if (len > 3600) { chunks.push(cur.join('\n')); cur = []; len = 0; } }
          if (cur.length) chunks.push(cur.join('\n'));
          importJob.totalChunks = chunks.length;
          const { bgComplete } = require('../services/bgLLM');
          for (const chunk of chunks) {
            if (importJob.cancelRequested) { importJob.status = 'cancelled'; console.log(`[import-smart] 已中断：导入${importJob.imported}条后停止`); return; }
            try {
              const out = await bgComplete({ system: IMPORT_PROMPT, user: chunk, maxTokens: 4000, timeoutMs: 120000 });
              const mm = out.match(/\[[\s\S]*\]/);
              if (mm) for (const item of JSON.parse(mm[0])) insert(item);
            } catch (e) { console.warn('[import-smart] 块处理失败:', e.message); }
            importJob.doneChunks++;
          }
        }
        run("UPDATE sessions SET updated_at = datetime('now','+8 hours') WHERE id = ?", [sid]);
        importJob.status = 'done';
        console.log(`[import-smart] 完成：导入${importJob.imported}条，跳过${importJob.skipped}条`);
      } catch (e) { importJob.status = 'error'; importJob.error = e.message; }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/import-status', (req, res) => { res.json(importJob || { status: 'idle' }); });

// 中断正在进行的导入（当前块处理完就停，已导入的保留）
router.post('/import-cancel', (req, res) => {
  if (importJob && importJob.status === 'running') { importJob.cancelRequested = true; return res.json({ ok: true, cancelling: true }); }
  res.json({ ok: true, cancelling: false });
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
