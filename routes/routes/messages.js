const express = require('express');
const router = express.Router();

module.exports = function(supabase) {
  // 获取某个会话的所有消息
  router.get('/session/:sessionId', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('session_id', req.params.sessionId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取某个会话的可见消息（用于上下文组装）
  router.get('/session/:sessionId/visible', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('session_id', req.params.sessionId)
        .eq('visible', true)
        .order('created_at', { ascending: true });
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 添加消息
  router.post('/', async (req, res) => {
    try {
      const { session_id, role, content, reasoning_content } = req.body;
      const { data, error } = await supabase
        .from('messages')
        .insert({ session_id, role, content, reasoning_content })
        .select()
        .single();
      if (error) throw error;

      // 更新会话的 updated_at
      await supabase
        .from('sessions')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', session_id);

      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 标记消息为不可见（压缩后用）
  router.put('/:id/hide', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('messages')
        .update({ visible: false })
        .eq('id', req.params.id)
        .select()
        .single();
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 删除消息
  router.delete('/:id', async (req, res) => {
    try {
      const { error } = await supabase
        .from('messages')
        .delete()
        .eq('id', req.params.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
