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

// API 路由
app.use('/api/sessions', require('./routes/sessions')(supabase));
app.use('/api/messages', require('./routes/messages')(supabase));
app.use('/api/memories', require('./routes/memories')(supabase));
app.use('/api/settings', require('./routes/settings')(supabase));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
