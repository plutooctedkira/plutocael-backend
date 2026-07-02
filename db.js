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

  // 迁移：settings 表的 API 配置列（chat.js 依赖这三列，新库需要补上）
  for (const col of ['api_base_url TEXT', 'api_key TEXT', 'model TEXT', 'enable_thinking INTEGER DEFAULT 0']) {
    try { db.run(`ALTER TABLE settings ADD COLUMN ${col}`); } catch (e) { /* 列已存在 */ }
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
function run(sql, params = []) {
  db.run(sql, params);
  save();
}

// 获取最后插入的ID
function lastInsertId() {
  const result = db.exec("SELECT last_insert_rowid()");
  return result[0].values[0][0];
}

module.exports = { initDB, getDB, save, queryAll, queryOne, run, lastInsertId };
