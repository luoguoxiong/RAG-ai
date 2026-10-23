// ============ 人工客服会话管理（mock）+ 会话级事件推送 ============
// 每个浏览器会话通过 GET /api/events?sessionId=xxx 建立一条长连接 EventSource，
// 服务端通过该通道推送：转人工排队、人工接入、人工消息、输入中、会话结束等事件。
// SSE 通道注册与跨实例投递已外置到 bus.js（本地直写 + Redis pub/sub 桥接；
// 未配置 REDIS_URL 时等价于原进程内 Map 实现），本模块只保留业务语义。
import * as store from './store.js';
import { pool } from './db.js';
import { pushEvent, isAgentOnline } from './bus.js';

export { addChannel, addAgentChannel } from './bus.js';

const humanSessions = new Map(); // sessionId -> human session（进程内缓存，回源见 getSession）

function push(sessionId, event, data) {
  pushEvent('session', sessionId, event, data);
}

function pushAgentEvent(agentId, event, data) {
  pushEvent('agent', agentId, event, data);
}

// 供外部模块（如长期记忆系统）经会话级通道推送事件；无在线通道时静默忽略
export function pushSessionEvent(sessionId, event, data) {
  push(sessionId, event, data);
}

// ---------- 人工会话状态持久化与恢复 ----------
// 状态每次变更都写入 PostgreSQL（chat_sessions.human_* 字段），
// 服务重启后内存 Map 为空，首次访问时从持久层恢复：
// - active：直接恢复，人工消息可继续收发
// - queued：按 joinAt 续排接入定时器；已过期的立即补上接入
const JOIN_DELAY_MS = 4000; // 排队后多久 mock 客服接入
const HUMAN_STATE_TTL_MS = 24 * 60 * 60 * 1000; // 超过 24h 的残留人工状态视为已结束
const HUMAN_CACHE_TTL_MS = 2000; // 缓存回源间隔：多实例部署下防跨进程脏读（其他实例改了状态本进程及时看见）

const FALLBACK_AGENT = { name: '林晓', code: 'CS1024' }; // 客服表为空时的兜底

// 从 support_human 客服表取一位在线客服
async function pickAgent() {
  const { rows } = await pool.query(
    `SELECT id, name, code FROM support_human WHERE status = 'online' ORDER BY id LIMIT 1;`
  );
  return rows[0] ? { id: rows[0].id, name: rows[0].name, code: rows[0].code } : { ...FALLBACK_AGENT };
}

async function persistHuman(s) {
  await store.setHumanState(s.sessionId, {
    status: s.status,
    queuePosition: s.queuePosition ?? null,
    agent: s.agent || null,
    joinAt: s.joinAt ?? null
  });
}

// 从持久层取人工会话（缓存过期或缺失时自动恢复）
// 多实例语义：缓存 2s 内可信；过期后强制回源 PG，防止另一实例已改变状态（如已接入/已结束）而本进程拿着旧值
async function getSession(sessionId) {
  const cached = humanSessions.get(sessionId);
  if (cached && Date.now() - cached.fetchedAt < HUMAN_CACHE_TTL_MS) return cached;

  const saved = await store.getHumanState(sessionId);
  if (!saved || saved.status === 'ended') {
    humanSessions.delete(sessionId);
    return null;
  }
  if (saved.updatedAt && Date.now() - saved.updatedAt > HUMAN_STATE_TTL_MS) {
    await store.setHumanState(sessionId, { status: 'ended' }); // 残留状态过期清理
    humanSessions.delete(sessionId);
    return null;
  }

  let s;
  if (cached && cached.status === saved.status) {
    // 状态未变：仅刷新易变字段，不重建定时器
    Object.assign(cached, {
      queuePosition: saved.queuePosition ?? 1,
      agent: saved.agent || cached.agent,
      joinAt: saved.joinAt ?? cached.joinAt,
      fetchedAt: Date.now()
    });
    s = cached;
  } else {
    s = {
      sessionId,
      status: saved.status,
      queuePosition: saved.queuePosition ?? 1,
      agent: saved.agent || null,
      joinAt: saved.joinAt ?? null,
      fetchedAt: Date.now(),
      timers: [] // 定时器不持久化，恢复后按需重建
    };
    humanSessions.set(sessionId, s);
    if (s.status === 'queued' && s.joinAt) {
      if (Date.now() >= s.joinAt) activate(s, true).catch(() => {});
      else s.timers.push(setTimeout(() => activate(s).catch(() => {}), Math.max(0, s.joinAt - Date.now())));
    }
  }
  return s;
}

// ---------- 人工客服（排队 -> 客服接入 -> 真人回复） ----------

// 客服接入：推送接入事件 + 通知客服工作台有新会话（immediate=true 用于重启后补推）
// 多实例安全：CAS 抢占（仅 queued -> active），保证只有一个实例执行接入流程，
// 避免多个实例同时定时到点 / 同时恢复时重复推送欢迎语与分配事件
async function activate(s, immediate = false) {
  const agent = await pickAgent(); // 从 support_human 客服表取在线客服
  const won = await store.activateHumanQueued(s.sessionId, agent, s.joinAt);
  if (!won) {
    // 已被其他实例接入：仅刷新本地缓存，不重复推送
    const saved = await store.getHumanState(s.sessionId).catch(() => null);
    s.status = 'active';
    s.agent = saved?.agent || s.agent;
    s.fetchedAt = Date.now();
    return;
  }
  s.status = 'active';
  s.agent = agent;
  s.fetchedAt = Date.now();
  push(s.sessionId, 'human_joined', { agent: s.agent });
  if (s.agent.id) {
    pushAgentEvent(s.agent.id, 'session_assigned', { sessionId: s.sessionId, agent: s.agent });
  }
  const pushGreeting = async () => {
    const greeting = `您好，我是人工客服${s.agent.name}（工号 ${s.agent.code}），很高兴为您服务。请描述一下您遇到的问题，我会尽力帮您处理。`;
    await store.appendMessage(s.sessionId, { role: 'human_agent', name: s.agent.name, content: greeting });
    push(s.sessionId, 'human_message', { from: 'agent', text: greeting });
  };
  if (immediate) await pushGreeting();
  else s.timers.push(setTimeout(() => pushGreeting().catch(() => {}), 900));
}

// 发起转人工：推送排队事件，4 秒后 mock 客服接入
export async function startHumanSession(sessionId) {
  const prev = await getSession(sessionId);
  if (prev && prev.status !== 'ended') return prev;

  const s = {
    sessionId,
    status: 'queued',
    queuePosition: 1 + Math.floor(Math.random() * 2),
    agent: null,
    joinAt: Date.now() + JOIN_DELAY_MS,
    fetchedAt: Date.now(),
    timers: []
  };
  humanSessions.set(sessionId, s);
  await persistHuman(s);
  await store.appendMessage(sessionId, { role: 'system', content: '会话已转接人工客服，排队中' });
  push(sessionId, 'transfer', { queuePosition: s.queuePosition, estimatedWaitMin: 2 });

  s.timers.push(setTimeout(() => activate(s).catch(() => {}), JOIN_DELAY_MS));
  return s;
}

// 用户在人工模式下发消息：全部走真人回复
// - 客服工作台在线 -> 实时推送给客服，等待客服手动回复（agentReply）
// - 客服工作台离线 -> 消息入库并告知用户（仅提示一次，不会自动应答）
export async function humanUserMessage(sessionId, text) {
  const s = await getSession(sessionId);
  if (!s || s.status === 'ended') return false;
  await store.appendMessage(sessionId, { role: 'user', content: text });
  if (s.status !== 'active') {
    const notice = '客服正在接入中，您的消息已记录，接入后会第一时间回复您。';
    await store.appendMessage(sessionId, { role: 'system', content: notice });
    push(sessionId, 'human_message', { from: 'system', text: notice });
    return true;
  }
  const agentId = s.agent?.id;
  if (agentId && (await isAgentOnline(agentId))) {
    // 真人模式：推送到客服工作台，由客服手动回复（agentReply）
    pushAgentEvent(agentId, 'user_message', { sessionId, text, agent: s.agent });
    return true;
  }
  // 客服离线：消息照常入库，告知用户已记录（同一会话只提示一次）
  if (!s.offlineNotified) {
    s.offlineNotified = true;
    const notice = '客服暂时离开，您的消息已记录，客服回到工作台后会第一时间回复您。';
    await store.appendMessage(sessionId, { role: 'system', content: notice });
    push(sessionId, 'human_message', { from: 'system', text: notice });
  }
  return true;
}

// 客服工作台回复用户：消息入库 + 经用户会话级 SSE 实时送达
export async function agentReply({ agentId, sessionId, text }) {
  const s = await getSession(sessionId);
  if (!s || s.status !== 'active') return { ok: false, error: '会话已结束或不存在' };
  if (!s.agent || s.agent.id !== Number(agentId)) return { ok: false, error: '该会话未分配给当前客服' };
  await store.appendMessage(sessionId, { role: 'human_agent', name: s.agent.name, content: text });
  push(sessionId, 'human_typing', { typing: false });
  push(sessionId, 'human_message', { from: 'agent', text, name: s.agent.name });
  return { ok: true };
}

// 结束人工会话（用户点击或兜底）
export async function endHumanSession(sessionId) {
  const s = await getSession(sessionId);
  if (!s) {
    // 重启后内存无该会话时，也确保持久化状态被标记为结束
    const saved = await store.getHumanState(sessionId);
    if (saved && saved.status !== 'ended') await store.setHumanState(sessionId, { status: 'ended' });
    return;
  }
  for (const t of s.timers) clearTimeout(t);
  s.timers = [];
  s.status = 'ended';
  await persistHuman(s);
  await store.appendMessage(sessionId, { role: 'system', content: '人工会话已结束，已切回智能客服模式' });
  push(sessionId, 'human_ended', {});
  if (s.agent?.id) pushAgentEvent(s.agent.id, 'session_ended', { sessionId });
}

export async function isHumanActive(sessionId) {
  const s = await getSession(sessionId);
  return !!s && s.status !== 'ended';
}
