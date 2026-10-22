// ============ 通用小工具：消息文本 / 截断 / 固定文案模拟流式 ============

// 取消息 content 的纯文本（string 或 content block 数组）
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
  }
  return '';
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function splitChunks(text) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const n = 1 + Math.floor(Math.random() * 3);
    chunks.push(text.slice(i, i + n));
    i += n;
  }
  return chunks;
}

// 固定文案的模拟流式输出（不经过 LLM 的快速路径用，如明确转人工）
export async function streamFixed(send, text) {
  for (const chunk of splitChunks(text)) {
    send('delta', { text: chunk });
    await delay(15);
  }
}
