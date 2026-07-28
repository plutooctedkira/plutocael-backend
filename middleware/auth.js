// 访问口令：请求头 x-pluto-auth 必须等于 .env 里的 APP_PASSWORD
// 没配 APP_PASSWORD 时整个中间件是空操作，方便先上线代码、再开开关（不会把自己锁在外面）
const crypto = require('crypto');

const TOKEN = String(process.env.APP_PASSWORD || '').trim();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
// 先哈希再比较：长度统一，timingSafeEqual 不会抛，也不泄漏比较耗时
const equal = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// 不需要口令的路径：健康检查 + 校验口令本身
const OPEN = new Set(['/api/health', '/api/auth']);

const enabled = () => TOKEN.length > 0;
const check = (pwd) => enabled() && equal(pwd || '', TOKEN);

function auth(req, res, next) {
  if (!enabled()) return next();            // 未配置口令 = 不启用
  if (req.method === 'OPTIONS') return next(); // CORS 预检不带自定义头
  if (OPEN.has(req.path)) return next();
  if (equal(req.get('x-pluto-auth') || '', TOKEN)) return next();
  res.status(401).json({ error: '未授权：请在设置里重新输入访问口令' });
}

module.exports = { auth, check, enabled };
