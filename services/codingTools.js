// agent 的工具：读/写/改文件 + 列目录 + 跑命令
// 路径限制在 AGENT_ROOTS 指定的仓库目录里（编码 agent 的常规做法，防止手滑写到 /etc）
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// 多个目录用英文逗号分隔（不用冒号，否则 Windows 盘符 C: 会被切开）
const ROOTS = String(process.env.AGENT_ROOTS || '/opt/plutocael-backend')
  .split(',').map(s => s.trim()).filter(Boolean).map(p => path.resolve(p));

// VPS 上用 bash；本地 Windows 没有 /bin/bash 就交给系统默认 shell
const SHELL = fs.existsSync('/bin/bash') ? '/bin/bash' : undefined;

const MAX_OUT = 30000; // 单个工具返回给模型的上限，防止一次读爆上下文

// 相对路径按第一个 root 解析；解析完必须仍落在某个 root 内
function safePath(p) {
  if (!p) throw new Error('缺少 path 参数');
  const abs = path.resolve(ROOTS[0], String(p));
  const ok = ROOTS.some(r => abs === r || abs.startsWith(r + path.sep));
  if (!ok) throw new Error(`路径超出允许范围：${abs}\n只能操作：${ROOTS.join('、')}`);
  return abs;
}

const clip = (s) => {
  s = String(s);
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…（已截断，共 ${s.length} 字符）` : s;
};

const impl = {
  list_dir({ path: p = '.' }) {
    const abs = safePath(p);
    const items = fs.readdirSync(abs, { withFileTypes: true })
      .filter(d => !['node_modules', '.git', 'dist'].includes(d.name))
      .map(d => (d.isDirectory() ? d.name + '/' : d.name));
    return clip(`${abs}\n` + (items.join('\n') || '(空目录)'));
  },

  read_file({ path: p, offset, limit }) {
    const abs = safePath(p);
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const start = Math.max(0, (offset || 1) - 1);
    const end = limit ? start + limit : lines.length;
    const body = lines.slice(start, end)
      .map((l, i) => `${String(start + i + 1).padStart(5)}\t${l}`).join('\n');
    return clip(body || '(空文件)');
  },

  write_file({ path: p, content }) {
    const abs = safePath(p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(content ?? ''), 'utf8');
    return `已写入 ${abs}（${String(content ?? '').length} 字符）`;
  },

  edit_file({ path: p, old_string, new_string, replace_all }) {
    const abs = safePath(p);
    const src = fs.readFileSync(abs, 'utf8');
    if (!old_string) throw new Error('old_string 不能为空');
    const n = src.split(old_string).length - 1;
    if (n === 0) throw new Error(`没找到要替换的内容（old_string 必须和文件里的一模一样，包括缩进）`);
    if (n > 1 && !replace_all) throw new Error(`old_string 匹配到 ${n} 处，请加长上下文使其唯一，或传 replace_all: true`);
    fs.writeFileSync(abs, replace_all ? src.split(old_string).join(new_string ?? '') : src.replace(old_string, new_string ?? ''), 'utf8');
    return `已修改 ${abs}（替换 ${replace_all ? n : 1} 处）`;
  },

  bash({ command, cwd, timeout_ms }) {
    const dir = cwd ? safePath(cwd) : ROOTS[0];
    return new Promise((resolve) => {
      exec(command, { cwd: dir, timeout: Math.min(timeout_ms || 120000, 300000), maxBuffer: 20 * 1024 * 1024, ...(SHELL ? { shell: SHELL } : {}) },
        (err, stdout, stderr) => {
          const out = [stdout, stderr].filter(Boolean).join('\n').trim();
          if (err && err.killed) return resolve(clip(`命令超时被终止\n${out}`));
          resolve(clip(out ? `${out}${err ? `\n(退出码 ${err.code})` : ''}` : (err ? `退出码 ${err.code}` : '(无输出)')));
        });
    });
  },
};

// 给模型看的工具声明
const TOOLS = [
  { name: 'list_dir', description: '列出目录内容（自动跳过 node_modules/.git/dist）', input_schema: { type: 'object', properties: { path: { type: 'string', description: '目录路径，相对或绝对，默认当前仓库根' } } } },
  { name: 'read_file', description: '读文件，返回带行号的内容', input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', description: '起始行号(从1开始)' }, limit: { type: 'integer', description: '读多少行' } }, required: ['path'] } },
  { name: 'write_file', description: '写文件（整个覆盖，父目录会自动创建）。改已有文件优先用 edit_file', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: '精确替换文件里的一段文本。old_string 必须和文件内容逐字符一致（含缩进），且默认必须唯一', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'bash', description: '在仓库目录里执行 shell 命令（grep/git/npm/pm2 等都走这个）。默认超时 120 秒', input_schema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string', description: '工作目录，默认第一个仓库根' }, timeout_ms: { type: 'integer' } }, required: ['command'] } },
];

async function runTool(name, input) {
  const fn = impl[name];
  if (!fn) return { ok: false, output: `未知工具：${name}` };
  try { return { ok: true, output: String(await fn(input || {})) }; }
  catch (e) { return { ok: false, output: `执行失败：${e.message}` }; }
}

module.exports = { TOOLS, runTool, ROOTS };
