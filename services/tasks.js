// 后端真实存在的 LLM 任务清单。设置页的"默认模型"和用量记账共用这一份，避免两处各写一遍
const TASKS = [
  { key: 'chat', label: '聊天', desc: '跟 Cael 对话的主力模型' },
  { key: 'compress', label: '上下文压缩', desc: '把变长的旧对话压成摘要，建议用便宜快的' },
  { key: 'summary', label: '分块摘要', desc: '给每段对话生成一句话，供记忆搜索用' },
  { key: 'memory', label: '自动记忆', desc: '判断每轮对话值不值得记进记忆库' },
  { key: 'import', label: '智能导入', desc: '解析清洗粘贴进来的聊天记录' },
  { key: 'agent', label: '工作台', desc: '改代码的编码 agent，建议用强模型' },
];

// 记账用的标签。聊天走真实 session_id（数字），其余任务用中文标签，用量页据此分开统计
const labelOf = (key) => (TASKS.find(t => t.key === key) || {}).label || '后台任务';

module.exports = { TASKS, labelOf };
