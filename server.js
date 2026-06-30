require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDB } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'plutocael backend is running', db: 'sqlite' });
});

// API 路由（不再需要传supabase）
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/memories', require('./routes/memories'));
app.use('/api/search', require('./routes/search'));
app.use('/api/gateway', require('./routes/gateway'));
app.use('/api/mcp', require('./routes/mcp'));

const PORT = process.env.PORT || 3000;

// 先初始化数据库再启动服务器
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
