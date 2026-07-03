# VPS 部署/更新指南

## 后端更新（在 VPS 上执行）

```bash
cd /path/to/plutocael-backend     # 进入后端目录
git pull                          # 拉取最新代码
npm install                       # 安装新依赖（本次新增了 undici）
# 重启服务（按你的进程管理方式选一种）：
# pm2 restart plutocael           # 用 pm2 的话
# 或者手动：先杀旧进程再 npm start
```

数据库迁移全部自动执行（启动时 ALTER TABLE），不需要手动操作。

## 前端更新

```bash
cd /path/to/plutocael-frontend
git pull
npm install
npm run build                     # 产物在 dist/
# 把 dist/ 部署到你的静态服务器路径（nginx root 或托管平台）
```

`.env.production` 已配置 `VITE_API_BASE=https://api.plutocael.icu/api`，
构建产物自动指向线上后端。

## 环境变量（后端 .env）

| 变量 | 必填 | 说明 |
|---|---|---|
| ANTHROPIC_API_KEY | 是 | 聊天 API Key（也可在前端设置面板填） |
| ANTHROPIC_BASE_URL | 否 | API 中转地址，默认官方 |
| CLAUDE_MODEL | 否 | 默认模型 |
| VOYAGE_API_KEY | 否 | 配置后语义搜索用真实向量（voyageai.com） |
| VOYAGE_MODEL | 否 | 默认 voyage-3.5 |
| SUMMARY_MODEL | 否 | chunk 摘要用的模型，默认 claude-sonnet-4-6 |
| PROXY_URL | 否 | 本地代理（如 Clash http://127.0.0.1:7890），VPS 上一般不需要 |
| MCP_URL | 否 | MCP 服务器地址，默认 https://mcp.plutocael.icu/mcp |
| PORT | 否 | 默认 3000 |

## 定时维护（crontab）

```cron
# 每天凌晨4点（北京时间）：向量维护五步（embed→摘要→图谱→遗忘曲线）
0 20 * * * cd /path/to/plutocael-backend && node vector-maintain.js >> /tmp/vector-maintain.log 2>&1

# 每天备份数据库
0 21 * * * cp /path/to/plutocael-backend/plutocael.db /path/to/backups/plutocael_$(date +\%Y\%m\%d).db
```

## 待办清单

- [ ] DNS 加 A 记录：`mcp.plutocael.icu` → MCP 服务器 IP（不加的话聊天里的 MCP 工具不生效，其他功能不受影响）
- [ ] 注册 Voyage AI 拿 key 填进 .env（不填则搜索用本地降级方案）
- [ ] 配置 crontab 定时维护
