require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Supabase 连接
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'plutocael backend is running' });
});

// 测试数据库连接
app.get('/api/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*').limit(1);
    if (error) throw error;
    res.json({ connected: true, data });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});