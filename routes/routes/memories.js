const express = require('express');
const router = express.Router();

module.exports = function(supabase) {
  // 获取所有记忆
  router.get('/', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('memories')
        .select('*')
        .order('timestamp', { ascending: false });
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 创建记忆
  router.post('/', async (req, res) => {
    try {
      const { session_id, summary, conversation_id, metadata } = req.body;
      const { data, error } = await supabase
        .from('memories')
        .insert({ session_id: session_id || 0, summary, conversation_id, metadata })
        .select()
        .single();
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新记忆
  router.put('/:id', async (req, res) => {
    try {
      const { summary, metadata } = req.body;
      const { data, error } = await supabase
        .from('memories')
        .update({ summary, metadata })
        .eq('id', req.params.id)
        .select()
        .single();
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 删除记忆
  router.delete('/:id', async (req, res) => {
    try {
      const { error } = await supabase
        .from('memories')
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
