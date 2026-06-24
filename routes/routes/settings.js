const express = require('express');
const router = express.Router();

module.exports = function(supabase) {
  // 获取设置（只有一行）
  router.get('/', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('*')
        .limit(1)
        .single();
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新设置
  router.put('/:id', async (req, res) => {
    try {
      const updates = {};
      const allowed = [
        'system_prompt', 'temperature', 'max_context_rounds',
        'max_context_tokens', 'compress_threshold',
        'compress_keep_rounds', 'max_reply_tokens'
      ];
      for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
      }
      updates.updated_at = new Date().toISOString();

      const { data, error } = await supabase
        .from('settings')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .single();
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
