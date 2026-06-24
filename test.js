// 调试版测试脚本

const BASE = 'http://localhost:3000/api';

async function test() {
  // 直接用已有的session id 2发消息
  console.log('>>> 发送消息...');
  const chatRes = await fetch(BASE + '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: 2,
      content: '你好'
    })
  });

  // 不用json解析，直接打印原始文本
  const raw = await chatRes.text();
  console.log('状态码:', chatRes.status);
  console.log('原始返回:', raw);
}

test().catch(err => console.error('出错了:', err));
