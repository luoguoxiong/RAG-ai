// ============ 服务入口：Express + 双通道 SSE ============
// 1) 请求级 SSE：POST /api/chat —— Agent 回复流（start/status/delta/done/error）
// 2) 会话级 SSE：GET  /api/events —— 服务端主动推送（转人工排队/接入/人工消息/结束）
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleAgentMessage } from './agent.js';
import {
  addChannel,
  humanUserMessage,
  startHumanSession,
  endHumanSession,
  isHumanActive
} from './session.js';
import * as store from './store.js';
import {
  getMemoryView,
  deleteFact,
  forgetAll,
  cancelIdleSummary,
  summarizeSession
} from './memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no'
};

// 会话级 SSE 通道（EventSource）
app.get('/api/events', (req, res) => {
  const sessionId = String(req.query.sessionId || '');
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  res.writeHead(200, SSE_HEADERS);
  res.write('retry: 2000\n\n');
  const remove = addChannel(sessionId, res);
  req.on('close', remove);
});

// 聊天：请求级 SSE 流式返回 Agent 处理过程与回复
// userId：前端 localStorage 生成的长期记忆命名空间（可选，缺省则仅会话内记忆）
app.post('/api/chat', async (req, res) => {
  const { sessionId, message, userId } = req.body || {};
  if (!sessionId || !String(message || '').trim()) {
    res.status(400).json({ error: 'sessionId 与 message 必填' });
    return;
  }
  if (isHumanActive(sessionId)) {
    res.status(409).json({ error: 'session_in_human_mode', message: '当前会话已转人工，请直接与人工客服沟通' });
    return;
  }

  res.writeHead(200, SSE_HEADERS);
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('start', { ts: Date.now() });
  try {
    await handleAgentMessage({ sessionId, message: String(message).trim(), userId: userId ? String(userId) : '', send });
  } catch (err) {
    console.error('[chat] 处理异常:', err);
    send('error', { message: err?.message || '服务处理异常，请稍后重试' });
  }
  res.end();
});

// 历史对话查询（本地 JSON 持久化，后续可换存储库）
// human：当前人工会话状态（queued/active/ended），前端刷新后据此恢复人工模式
app.get('/api/history', (req, res) => {
  const sessionId = String(req.query.sessionId || '');
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  res.json({ sessionId, messages: store.getMessages(sessionId), human: store.getHumanState(sessionId) });
});

// 人工模式：用户发消息给 mock 客服
app.post('/api/human/message', (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!sessionId || !String(message || '').trim()) {
    res.status(400).json({ error: 'sessionId 与 message 必填' });
    return;
  }
  const ok = humanUserMessage(sessionId, String(message).trim());
  if (!ok) {
    res.status(409).json({ error: 'no_human_session', message: '当前没有进行中的人工会话' });
    return;
  }
  res.json({ ok: true });
});

// 结束人工会话（并触发该会话的长期记忆摘要）
app.post('/api/human/end', (req, res) => {
  const { sessionId, userId } = req.body || {};
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  endHumanSession(sessionId);
  if (userId) {
    cancelIdleSummary(sessionId);
    summarizeSession({ userId: String(userId), sessionId }).catch((err) =>
      console.warn('[memory] 会话摘要失败:', err?.message || err)
    );
  }
  res.json({ ok: true });
});

// （调试用）直接触发转人工
app.post('/api/human/transfer', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  startHumanSession(sessionId);
  res.json({ ok: true });
});

// ---------- 长期记忆管理 API ----------
// 查看记忆（"我的记忆"面板 / 调试）
app.get('/api/memory', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) {
    res.status(400).json({ error: 'userId 必填' });
    return;
  }
  res.json(getMemoryView(userId));
});

// 删除单条记忆
app.delete('/api/memory/:userId/facts/:factId', (req, res) => {
  const { userId, factId } = req.params;
  const ok = deleteFact(String(userId), String(factId));
  res.json({ ok });
});

// "忘记我"：清空该用户全部长期记忆（合规）
app.post('/api/memory/forget', (req, res) => {
  const { userId } = req.body || {};
  if (!userId) {
    res.status(400).json({ error: 'userId 必填' });
    return;
  }
  res.json({ ok: forgetAll(String(userId)) });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`[物流智能客服 demo] 已启动: http://localhost:${PORT}`);
});
