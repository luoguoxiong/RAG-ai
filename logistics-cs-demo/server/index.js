// ============ 服务入口：Express + 双通道 SSE ============
// 1) 请求级 SSE：POST /api/chat —— Agent 回复流（start/status/delta/done/error）
// 2) 会话级 SSE：GET  /api/events —— 服务端主动推送（转人工排队/接入/人工消息/结束）
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, pool } from './db.js';
import { initCheckpointer, startCheckpointSweeper } from './graph.js';
import { handleAgentMessage, handleSlotSubmit, hasPendingSlots, getCityOptions } from './agent.js';
import { rateLimit } from './ratelimit.js';
import { addChannel, addAgentChannel, initBus, startPresenceHeartbeat, closeBus } from './bus.js';
import { isRedisMode, quitRedis } from './redis.js';
import { claim, complete, fail, makeResultRecorder, replayResult } from './idempotency.js';
import {
  humanUserMessage,
  startHumanSession,
  endHumanSession,
  isHumanActive,
  agentReply
} from './session.js';
import * as store from './store.js';
import {
  getMemoryView,
  deleteFact,
  forgetAll,
  cancelIdleSummary,
  summarizeSession,
  startMemoryWorker,
  stopMemoryWorker
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
// msgId：前端生成的消息幂等键（可选）——服务端 SETNX 认领，同 id 重复请求
//        正在执行时 409 快速失败，已完成时直接重放第一次的结果（不重复跑 LLM/落库）
// 入口限流：单 IP 每分钟请求数上限（跨实例共享窗口；RATE_LIMIT_PER_MIN=0 关闭）
app.post('/api/chat', rateLimit({ name: 'chat' }), async (req, res) => {
  const { sessionId, message, userId, msgId } = req.body || {};
  if (!sessionId || !String(message || '').trim()) {
    res.status(400).json({ error: 'sessionId 与 message 必填' });
    return;
  }
  if (await isHumanActive(sessionId)) {
    res.status(409).json({ error: 'session_in_human_mode', message: '当前会话已转人工，请直接与人工客服沟通' });
    return;
  }

  // 服务端幂等：进入 SSE 前判重（业务拒绝可直接返回 JSON 状态码）
  const claimRes = await claim(msgId);
  if (claimRes.status === 'processing') {
    res.status(409).json({ error: 'duplicate_request', message: '该消息正在处理中，请勿重复提交' });
    return;
  }
  if (claimRes.status === 'replay') {
    replayResult(res, claimRes.result); // 幂等窗口内的重复请求：重放第一次的结果
    return;
  }

  res.writeHead(200, SSE_HEADERS);
  const recorder = makeResultRecorder(
    (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  );
  recorder.send('start', { ts: Date.now() });
  try {
    await handleAgentMessage({ sessionId, message: String(message).trim(), userId: userId ? String(userId) : '', send: recorder.send });
    await complete(msgId, { events: recorder.events }); // 成功：结果回写，供同 id 重复请求重放
  } catch (err) {
    console.error('[chat] 处理异常:', err);
    void fail(msgId); // 失败：释放幂等占位，允许客户端用同一 msgId 重试
    recorder.send('error', { message: err?.message || '服务处理异常，请稍后重试' });
  }
  res.end();
});

// 意图识别槽位补全：LLM 识别意图但缺城市参数时挂起，前端弹窗选地址后提交至此恢复执行
// 挂起校验放在进入 SSE 前，业务拒绝可直接返回 JSON 状态码（挂起状态在 Redis/内存存储中，任意实例可校验）
// msgId：与 /api/chat 同源幂等键——同 id 重复提交（网络重试/多端登录）直接重放或快速失败
app.post('/api/chat/slots', rateLimit({ name: 'slots' }), async (req, res) => {
  const { sessionId, intent, slots, userId, msgId } = req.body || {};
  if (!sessionId || !intent) {
    res.status(400).json({ error: 'sessionId 与 intent 必填' });
    return;
  }
  if (!(await hasPendingSlots(sessionId, intent))) {
    res.status(409).json({ error: 'no_pending_slots', message: '没有待补充的查询，请重新描述您的需求' });
    return;
  }

  // 服务端幂等：进入 SSE 前判重（注意 hasPendingSlots 已校验，重复提交会先命中 here）
  const claimRes = await claim(msgId);
  if (claimRes.status === 'processing') {
    res.status(409).json({ error: 'duplicate_request', message: '该提交正在处理中，请勿重复提交' });
    return;
  }
  if (claimRes.status === 'replay') {
    replayResult(res, claimRes.result);
    return;
  }

  res.writeHead(200, SSE_HEADERS);
  const recorder = makeResultRecorder(
    (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  );
  recorder.send('start', { ts: Date.now() });
  try {
    await handleSlotSubmit({ sessionId, intent, slots: slots || {}, userId: userId ? String(userId) : '', send: recorder.send });
    await complete(msgId, { events: recorder.events });
  } catch (err) {
    console.error('[slots] 处理异常:', err);
    void fail(msgId);
    recorder.send('error', { message: err?.message || '服务处理异常，请稍后重试' });
  }
  res.end();
});

// 地址选择弹窗下拉数据源（与 Mock 数据单一来源）
app.get('/api/cities', (req, res) => {
  res.json(getCityOptions());
});

// 历史对话查询（PostgreSQL 持久化）
// human：当前人工会话状态（queued/active/ended），前端刷新后据此恢复人工模式
app.get('/api/history', async (req, res) => {
  const sessionId = String(req.query.sessionId || '');
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  try {
    const [messages, human] = await Promise.all([
      store.getMessages(sessionId),
      store.getHumanState(sessionId)
    ]);
    res.json({ sessionId, messages, human });
  } catch (err) {
    console.error('[history] 查询异常:', err);
    res.status(500).json({ error: '历史记录查询失败' });
  }
});

// 人工模式：用户发消息给 mock 客服
app.post('/api/human/message', async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!sessionId || !String(message || '').trim()) {
    res.status(400).json({ error: 'sessionId 与 message 必填' });
    return;
  }
  const ok = await humanUserMessage(sessionId, String(message).trim());
  if (!ok) {
    res.status(409).json({ error: 'no_human_session', message: '当前没有进行中的人工会话' });
    return;
  }
  res.json({ ok: true });
});

// 结束人工会话（并触发该会话的长期记忆摘要）
app.post('/api/human/end', async (req, res) => {
  const { sessionId, userId } = req.body || {};
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  await endHumanSession(sessionId);
  if (userId) {
    await cancelIdleSummary(sessionId).catch(() => {});
    summarizeSession({ userId: String(userId), sessionId }).catch((err) =>
      console.warn('[memory] 会话摘要失败:', err?.message || err)
    );
  }
  res.json({ ok: true });
});

// （调试用）直接触发转人工
app.post('/api/human/transfer', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  await startHumanSession(sessionId);
  res.json({ ok: true });
});

// ---------- 客服工作台 API ----------
// 客服列表（support_human 表）
app.get('/api/humans', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, code, status FROM support_human ORDER BY id;`
    );
    res.json({ humans: rows });
  } catch (err) {
    console.error('[humans] 查询异常:', err);
    res.status(500).json({ error: '客服列表查询失败' });
  }
});

// 客服上/下岗（online=可接单 / offline=不接单）
app.post('/api/humans/status', async (req, res) => {
  const { agentId, status } = req.body || {};
  if (!agentId || !['online', 'offline'].includes(status)) {
    res.status(400).json({ error: 'agentId 与 status(online|offline) 必填' });
    return;
  }
  try {
    const { rowCount } = await pool.query(
      `UPDATE support_human SET status = $2 WHERE id = $1;`,
      [agentId, status]
    );
    res.json({ ok: rowCount > 0 });
  } catch (err) {
    console.error('[humans] 状态更新异常:', err);
    res.status(500).json({ error: '状态更新失败' });
  }
});

// 客服工作台长连接：新会话分配 / 用户新消息 / 会话结束
app.get('/api/agent/events', (req, res) => {
  const agentId = Number(req.query.agentId || 0);
  if (!agentId) {
    res.status(400).json({ error: 'agentId 必填' });
    return;
  }
  res.writeHead(200, SSE_HEADERS);
  res.write('retry: 2000\n\n');
  const remove = addAgentChannel(agentId, res);
  req.on('close', remove);
});

// 我（客服）名下进行中的人工会话列表
app.get('/api/agent/sessions', async (req, res) => {
  const agentId = Number(req.query.agentId || 0);
  if (!agentId) {
    res.status(400).json({ error: 'agentId 必填' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT s.session_id,
              s.human_join_at     AS join_at,
              s.human_updated_at  AS updated_at,
              (SELECT m.content FROM chat_messages m
                WHERE m.session_id = s.session_id ORDER BY m.id DESC LIMIT 1) AS last_message
       FROM chat_sessions s
       WHERE s.human_status = 'active' AND s.human_agent_id = $1
       ORDER BY s.human_updated_at DESC;`,
      [agentId]
    );
    res.json({ sessions: rows });
  } catch (err) {
    console.error('[agent/sessions] 查询异常:', err);
    res.status(500).json({ error: '会话列表查询失败' });
  }
});

// 客服回复用户：入库 + 经用户 SSE 实时送达
app.post('/api/agent/message', async (req, res) => {
  const { agentId, sessionId, text } = req.body || {};
  if (!agentId || !sessionId || !String(text || '').trim()) {
    res.status(400).json({ error: 'agentId、sessionId 与 text 必填' });
    return;
  }
  try {
    const r = await agentReply({ agentId: Number(agentId), sessionId, text: String(text).trim() });
    if (!r.ok) {
      res.status(409).json({ error: r.error });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[agent/message] 处理异常:', err);
    res.status(500).json({ error: '消息发送失败' });
  }
});

// 客服侧结束会话
app.post('/api/agent/end', async (req, res) => {
  const { agentId, sessionId } = req.body || {};
  if (!agentId || !sessionId) {
    res.status(400).json({ error: 'agentId 与 sessionId 必填' });
    return;
  }
  const saved = await store.getHumanState(sessionId);
  if (saved?.status === 'active' && saved?.agent?.id === Number(agentId)) {
    await endHumanSession(sessionId);
  }
  res.json({ ok: true });
});

// ---------- 长期记忆管理 API ----------
// 查看记忆（"我的记忆"面板 / 调试）
app.get('/api/memory', async (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) {
    res.status(400).json({ error: 'userId 必填' });
    return;
  }
  try {
    res.json(await getMemoryView(userId));
  } catch (err) {
    console.error('[memory] 查询异常:', err);
    res.status(500).json({ error: '记忆查询失败' });
  }
});

// 删除单条记忆
app.delete('/api/memory/:userId/facts/:factId', async (req, res) => {
  const { userId, factId } = req.params;
  try {
    res.json({ ok: await deleteFact(String(userId), String(factId)) });
  } catch (err) {
    console.error('[memory] 删除异常:', err);
    res.status(500).json({ error: '记忆删除失败' });
  }
});

// "忘记我"：清空该用户全部长期记忆（合规）
app.post('/api/memory/forget', async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) {
    res.status(400).json({ error: 'userId 必填' });
    return;
  }
  try {
    res.json({ ok: await forgetAll(String(userId)) });
  } catch (err) {
    console.error('[memory] 清空异常:', err);
    res.status(500).json({ error: '记忆清空失败' });
  }
});

const PORT = Number(process.env.PORT) || 3000;

// 启动顺序：PG 建表 -> checkpoint 表迁移（PostgresSaver.setup）-> 后台任务（记忆 worker /
// 挂起检查点兜底清理）-> SSE 总线/客服在线心跳 -> 监听端口
initDb()
  .then(() => initCheckpointer())
  .then(() => {
    startCheckpointSweeper();
    startMemoryWorker();
    initBus();
    startPresenceHeartbeat();
    console.log(`[server] 状态后端: ${isRedisMode() ? 'Redis（多实例就绪）' : '进程内存（单机模式，配置 REDIS_URL 可横向扩展）'}`);
    app.listen(PORT, () => {
      console.log(`[物流智能客服 demo] 已启动: http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[db] PostgreSQL 初始化失败，服务未启动:', err.message);
    process.exit(1);
  });

// 优雅退出：停掉 worker / 总线心跳 / Redis 连接并释放连接池，避免任务在滚动发布时被硬杀
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[server] 收到 ${signal}，正在关闭...`);
    stopMemoryWorker();
    closeBus();
    pool
      .end()
      .catch(() => {})
      .finally(() => quitRedis().finally(() => process.exit(0)));
  });
}
