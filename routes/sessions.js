const express = require('express');
const router = express.Router();

module.exports = function(supabase) {
  // 获取所有会话
  router.get('/', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('sessions')
        .select('*')
        .order('updated_at', { ascending: false });
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 创建新会话
  router.post('/', async (req, res) => {
    try {
      const { name } = req.body;
      const { data, error } = await supabase
        .from('sessions')
        .insert({ name: name || '新对话' })
        .select()
        .single();
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取单个会话
  router.get('/:id', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('sessions')
        .select('*')
        .eq('id', req.params.id)
        .single();
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新会话
  router.put('/:id', async (req, res) => {
    try {
      const { name } = req.body;
      const { data, error } = await supabase
        .from('sessions')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 删除会话（messages会自动级联删除）
  router.delete('/:id', async (req, res) => {
    try {
      const { error } = await supabase
        .from('sessions')
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
