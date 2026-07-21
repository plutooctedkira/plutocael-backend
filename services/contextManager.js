// 滚动上下文管理：summary → frozen → active 三区
// 目的：请求前缀（system→summary→frozen）在多轮之间保持不变，吃满 prompt cache；同时限制历史体积
// - active：当前阶段新对话（id > frozen_end_id）
// - frozen：上一阶段对话原文，轮换前不变（id 在 [frozen_start_id, frozen_end_id]）
// - summary：更早阶段的摘要块（若干个，按上限裁剪）
// 消息全部保留在 messages 表（聊天界面照常显示），这里只决定"发给模型的是哪些"

const { queryAll, queryOne, run, lastInsertId } = require('../db');

// 异步为一个 frozen 块生成摘要，完成后置 status='ready'（等下次轮换时晋升为 committed）
function summarizeFrozen(session_id, startId, endId, summaryId) {
  setImmediate(async () => {
    try {
      const rows = queryAll(
        "SELECT role, content, msg_type FROM messages WHERE session_id=? AND id>=? AND id<=? AND visible=1 ORDER BY id",
        [session_id, startId, endId]
      );
      if (!rows.length) { run("DELETE FROM context_summaries WHERE id=?", [summaryId]); return; }
      const text = rows.map(m => `[${m.role === 'user' ? 'Jasmine' : 'Cael'}]: ${m.msg_type === 'image' ? '[图片]' : m.content}`).join('\n');
      const { bgComplete } = require('./bgLLM');
      const out = await bgComplete({
        system: '你是对话摘要助手。用第三人称把下面这段对话压缩成一段要点摘要（200-400字）。必须保留所有日期/时间/约定/数字/人名/地点/承诺/待办；禁止用"聊到了""讨论了"这类空话替代具体内容。只输出摘要正文。',
        user: text, maxTokens: 900, timeoutMs: 90000,
      });
      if (out && out.trim()) { run("UPDATE context_summaries SET content=?, status='ready' WHERE id=?", [out.trim(), summaryId]); console.log(`[ctx] 摘要完成 session=${session_id} frozen=${startId}-${endId}`); }
      else run("DELETE FROM context_summaries WHERE id=?", [summaryId]);
    } catch (e) { console.warn('[ctx] 摘要失败:', e.message); }
  });
}

// 轮换检查：active 里完成的对话轮次（assistant 条数）达阈值时轮换一次
// 只冻结到最后一条 assistant（不拆开正在进行的 user/assistant 对），返回是否发生轮换
function maybeRotate(session_id, settings) {
  const threshold = Math.max(2, settings.ctx_active_rounds || 8);
  const keep = Math.max(1, settings.ctx_summary_keep || 3);
  const sess = queryOne("SELECT frozen_start_id, frozen_end_id FROM sessions WHERE id=?", [session_id]) || {};
  const fEnd = sess.frozen_end_id || 0;
  const active = queryAll("SELECT id, role FROM messages WHERE session_id=? AND id>? AND visible=1 ORDER BY id", [session_id, fEnd]);
  const assistantIds = active.filter(m => m.role === 'assistant').map(m => m.id);
  if (assistantIds.length < threshold) return false;

  const firstId = active[0].id;
  const freezeEnd = assistantIds[assistantIds.length - 1]; // 冻结到最后一条完成的 assistant，之后的（正在进行的 user）留在 active

  // 1) 晋升上一个 frozen 的摘要：ready → committed（按生成顺序给 ord）
  if (fEnd > 0) {
    const ready = queryAll("SELECT id FROM context_summaries WHERE session_id=? AND status='ready' ORDER BY id", [session_id]);
    let maxOrd = (queryOne("SELECT MAX(ord) mo FROM context_summaries WHERE session_id=? AND status='committed'", [session_id]) || {}).mo || 0;
    for (const r of ready) { maxOrd++; run("UPDATE context_summaries SET status='committed', ord=? WHERE id=?", [maxOrd, r.id]); }
    // 2) 裁掉最旧的 committed，只留 keep 块
    const committed = queryAll("SELECT id FROM context_summaries WHERE session_id=? AND status='committed' ORDER BY ord", [session_id]);
    if (committed.length > keep) {
      const drop = committed.slice(0, committed.length - keep).map(r => r.id);
      run(`DELETE FROM context_summaries WHERE id IN (${drop.map(() => '?').join(',')})`, drop);
    }
  }

  // 3) 新 frozen = 刚才的 active（到最后一条 assistant 为止）
  run("UPDATE sessions SET frozen_start_id=?, frozen_end_id=? WHERE id=?", [firstId, freezeEnd, session_id]);
  console.log(`[ctx] 轮换 session=${session_id}：新 frozen=${firstId}-${freezeEnd}，active轮次=${assistantIds.length}`);

  // 4) 为新 frozen 启动异步摘要（pending）
  run("INSERT INTO context_summaries (session_id, frozen_end_id, content, status, ord) VALUES (?,?,?, 'pending', 0)", [session_id, freezeEnd, '']);
  summarizeFrozen(session_id, firstId, freezeEnd, lastInsertId());
  return true;
}

// 返回本次请求要用的三区：{ summaries: [文本...], frozenRows: [...], activeRows: [...] }
// 每行含 { role, content, msg_type, created_at }
function getContextParts(session_id, settings) {
  maybeRotate(session_id, settings);
  const sess = queryOne("SELECT frozen_start_id, frozen_end_id FROM sessions WHERE id=?", [session_id]) || {};
  const fStart = sess.frozen_start_id || 0;
  const fEnd = sess.frozen_end_id || 0;
  const summaries = queryAll("SELECT content FROM context_summaries WHERE session_id=? AND status='committed' ORDER BY ord", [session_id]).map(r => r.content).filter(Boolean);
  const frozenRows = fEnd > 0
    ? queryAll("SELECT role, content, msg_type, created_at FROM messages WHERE session_id=? AND id>=? AND id<=? AND visible=1 ORDER BY id", [session_id, fStart, fEnd])
    : [];
  const activeRows = queryAll("SELECT role, content, msg_type, created_at FROM messages WHERE session_id=? AND id>? AND visible=1 ORDER BY id", [session_id, fEnd]);
  return { summaries, frozenRows, activeRows };
}

module.exports = { getContextParts };
