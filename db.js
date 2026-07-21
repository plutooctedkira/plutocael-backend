const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'plutocael.db');

let db = null;

async function initDB() {
  const SQL = await initSqlJs();

  // 如果已有数据库文件就加载，否则新建
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // 建表
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT DEFAULT '新对话',
      created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
      updated_at DATETIME DEFAULT (datetime('now', '+8 hours'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      visible INTEGER DEFAULT 1,
      reasoning_content TEXT,
      created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      system_prompt TEXT,
      temperature REAL DEFAULT 1,
      max_context_rounds INTEGER DEFAULT 10,
      max_context_tokens INTEGER DEFAULT 8000,
      compress_threshold INTEGER DEFAULT 4000,
      compress_keep_rounds INTEGER DEFAULT 5,
      max_reply_tokens INTEGER DEFAULT 2000,
      updated_at DATETIME DEFAULT (datetime('now', '+8 hours'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT DEFAULT '生活',
      importance INTEGER DEFAULT 3 CHECK(importance >= 1 AND importance <= 5),
      last_accessed DATETIME,
      created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
      updated_at DATETIME DEFAULT (datetime('now', '+8 hours'))
    )
  `);

  // 迁移：为 sessions 表添加 summary 列（如果不存在）
  try {
    db.run("ALTER TABLE sessions ADD COLUMN summary TEXT DEFAULT NULL");
  } catch (e) { /* 列已存在 */ }
  // 迁移：滚动上下文管理的 frozen 边界（frozen_end_id=0 表示还没冻结）
  for (const col of ['frozen_start_id INTEGER DEFAULT 0', 'frozen_end_id INTEGER DEFAULT 0']) {
    try { db.run(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch (e) { /* 列已存在 */ }
  }

  // 迁移：settings 表的 API 配置列（chat.js 依赖这三列，新库需要补上）
  // cheap_* 是便宜渠道：摘要压缩等后台任务用，省主力额度，不填则回退用主力
  for (const col of ['api_base_url TEXT', 'api_key TEXT', 'model TEXT', 'enable_thinking INTEGER DEFAULT 0', 'enable_mcp INTEGER DEFAULT 1',
    'cheap_api_base_url TEXT', 'cheap_api_key TEXT', 'cheap_model TEXT',
    'appearance TEXT', 'wallpaper TEXT', 'avatar_user TEXT', 'avatar_ai TEXT',
    'use_history INTEGER DEFAULT 1', 'time_hint INTEGER DEFAULT 1', 'date_mark INTEGER DEFAULT 1',
    'ctx_manage INTEGER DEFAULT 1', 'ctx_active_rounds INTEGER DEFAULT 8', 'ctx_summary_keep INTEGER DEFAULT 3']) {
    try { db.run(`ALTER TABLE settings ADD COLUMN ${col}`); } catch (e) { /* 列已存在 */ }
  }

  // 迁移：messages 表的工具调用日志列
  try { db.run("ALTER TABLE messages ADD COLUMN tool_log TEXT DEFAULT NULL"); } catch (e) { /* 列已存在 */ }

  // 迁移：messages 表的消息类型列（text/image）
  try { db.run("ALTER TABLE messages ADD COLUMN msg_type TEXT DEFAULT 'text'"); } catch (e) { /* 列已存在 */ }

  // 留言板
  db.run(`
    CREATE TABLE IF NOT EXISTS board_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
    )
  `);

  // 滚动上下文的摘要块：pending(生成中)/ready(完成待晋升)/committed(已注入请求)
  db.run(`
    CREATE TABLE IF NOT EXISTS context_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      frozen_end_id INTEGER DEFAULT 0,
      content TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      ord INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
    )
  `);

  // 导入暂存区：智能导入清洗后的结果先落这里，用户在前端审阅/改删后再上传到对话
  db.run(`
    CREATE TABLE IF NOT EXISTS import_staging (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      time TEXT,
      ord INTEGER DEFAULT 0
    )
  `);

  // MCP 服务器列表（可在前端增删启停，聊天聚合所有启用服务器的工具）
  db.run(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
    )
  `);
  // 种子：把环境变量里的内置记忆服务器登记为第一个（用户可自行禁用/删除）
  const mcpCount = db.exec("SELECT COUNT(*) FROM mcp_servers")[0].values[0][0];
  if (mcpCount === 0 && process.env.MCP_URL) {
    db.run("INSERT INTO mcp_servers (name, url) VALUES (?, ?)", ['内置记忆库', process.env.MCP_URL]);
  }

  // 初始化向量搜索表
  try {
    const { initVectorTables } = require('./vector-search');
    await initVectorTables();
  } catch (e) { console.warn('Vector table init skipped:', e.message); }

  // API 网关表
  db.run(`
    CREATE TABLE IF NOT EXISTS gateway_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT DEFAULT '',
      model TEXT DEFAULT '',
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS pricing_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      input_price REAL NOT NULL,
      output_price REAL NOT NULL,
      cache_read_price REAL DEFAULT 0,
      cache_write_price REAL DEFAULT 0,
      is_current INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
    )
  `);

  // 确保 pricing_config 有默认数据
  const pr = db.exec("SELECT COUNT(*) as count FROM pricing_config");
  if (pr[0].values[0][0] === 0) {
    db.run("INSERT INTO pricing_config (name, model, input_price, output_price, cache_read_price, cache_write_price, is_current) VALUES (?, ?, ?, ?, ?, ?, 1)", [
      'Claude Sonnet 4.6', 'claude-sonnet-4-6', 3.0, 15.0, 0.3, 3.75
    ]);
    db.run("INSERT INTO pricing_config (name, model, input_price, output_price, cache_read_price, cache_write_price, is_current) VALUES (?, ?, ?, ?, ?, ?, 0)", [
      'Claude Opus 4.6', 'claude-opus-4-6', 5.0, 25.0, 0.5, 6.25
    ]);
  }

  // 迁移：修正旧数据里 Opus 4.6 配错的定价（实际为 $5/$25，不是 $15/$75）
  db.run("UPDATE pricing_config SET name = 'Claude Opus 4.6', input_price = 5.0, output_price = 25.0, cache_read_price = 0.5, cache_write_price = 6.25 WHERE model = 'claude-opus-4-6' AND input_price = 15.0");

  // 确保settings表有一行默认数据
  const row = db.exec("SELECT COUNT(*) as count FROM settings");
  if (row[0].values[0][0] === 0) {
    db.run("INSERT INTO settings DEFAULT VALUES");
  }

  save();
  console.log('SQLite 数据库已初始化:', DB_PATH);
  return db;
}

function getDB() {
  return db;
}

function save() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

// 查询辅助函数：返回对象数组
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// 查询单行
function queryOne(sql, params = []) {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

// 执行写操作并保存
// 注意：save() 里的 db.export() 会重开连接、清掉 last_insert_rowid，
// 所以必须在 save() 之前把 rowid 抓出来存好
let _lastInsertId = 0;
function run(sql, params = []) {
  db.run(sql, params);
  try {
    const r = db.exec("SELECT last_insert_rowid()");
    const id = r[0] && r[0].values[0][0];
    if (id) _lastInsertId = id;
  } catch (e) { /* 非INSERT语句忽略 */ }
  save();
}

// 获取最后插入的ID
function lastInsertId() {
  return _lastInsertId;
}

// 后台任务（摘要/压缩）的 API 配置：便宜渠道优先，回退主力，再回退 env
function getBackgroundApiConfig() {
  const s = queryOne("SELECT api_base_url, api_key, model, cheap_api_base_url, cheap_api_key, cheap_model FROM settings LIMIT 1") || {};
  const base = s.cheap_api_base_url || s.api_base_url || process.env.CHEAP_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const key = s.cheap_api_key || s.api_key || process.env.CHEAP_API_KEY || process.env.ANTHROPIC_API_KEY;
  // 便宜渠道没配模型时回退主力模型：第三方代理的模型名带渠道前缀，裸模型名会503
  const model = s.cheap_model || process.env.CHEAP_MODEL || process.env.SUMMARY_MODEL || s.model || 'claude-sonnet-4-6';
  return { url: base.replace(/\/v1\/messages\/?$/, '') + '/v1/messages', key, model };
}

module.exports = { initDB, getDB, save, queryAll, queryOne, run, lastInsertId, getBackgroundApiConfig };
