// ============ 会话级 SSE 通道总线：本地投递 + Redis pub/sub 跨进程桥接 ============
// 双通道 SSE 的"会话级"通道（用户 /api/events 与客服 /api/agent/events）原为进程内 Map，
// 多实例部署时"发布事件的进程"与"持有 SSE 连接的进程"可能不同——事件会丢。
// 本模块把通道注册留在本地（SSE 连接只能写在本进程），事件推送双写：
//   本地直写（同进程零延迟） + Redis PUBLISH（其他实例的订阅者写入它们持有的连接）。
// 同时承接"客服在线状态"注册表：原 isAgentOnline 只看本进程连接，
// 多实例下用户消息可能落在另一实例——改为 Redis 心跳注册（20s TTL / 10s 刷新）。
import { randomUUID } from 'node:crypto';
import { getRedis, getRedisSubscriber, isRedisMode } from './redis.js';

const CHANNEL_PREFIX = 'cs:bus:'; // pub/sub 频道前缀：cs:bus:session:<id> / cs:bus:agent:<id>
const PRESENCE_PREFIX = 'cs:presence:agent:'; // 客服在线心跳键：TTL 20s，每 10s 刷新
const PRESENCE_TTL_MS = 20_000;
const PRESENCE_HEARTBEAT_MS = 10_000;
const INSTANCE_ID = randomUUID(); // 进程实例 ID：订阅端据此跳过本进程发布的消息（防自回声重复投递）

const sessionChannels = new Map(); // sessionId -> Set<res>
const agentChannels = new Map(); // agentId -> Set<res>
const subscribed = new Set(); // 本进程已订阅的频道
let presenceTimer = null;

function write(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // 连接已断开，忽略
  }
}

function sessionChannel(sessionId) {
  return `${CHANNEL_PREFIX}session:${sessionId}`;
}
function agentChannel(agentId) {
  return `${CHANNEL_PREFIX}agent:${agentId}`;
}

async function ensureSubscribed(channel) {
  if (!isRedisMode() || subscribed.has(channel)) return;
  subscribed.add(channel);
  await getRedisSubscriber().subscribe(channel);
}

async function ensureUnsubscribed(channel) {
  if (!isRedisMode() || !subscribed.has(channel)) return;
  subscribed.delete(channel);
  await getRedisSubscriber().unsubscribe(channel);
}

/** 启动时调用：把 Redis 频道消息投递到本进程持有的 SSE 连接 */
export function initBus() {
  if (!isRedisMode()) return;
  const sub = getRedisSubscriber();
  sub.on('message', (channel, raw) => {
    if (!subscribed.has(channel)) return;
    // 协议：JSON 信封 { from: 实例ID, event, data }（JSON.stringify 转义换行，单行安全）
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.event !== 'string') return;
    if (msg.from === INSTANCE_ID) return; // 本进程已直写过，跳过自回声（否则同实例事件重复投递）
    const data = msg.data;
    if (channel.startsWith(`${CHANNEL_PREFIX}session:`)) {
      const sessionId = channel.slice(`${CHANNEL_PREFIX}session:`.length);
      for (const res of sessionChannels.get(sessionId) ?? []) write(res, msg.event, data);
    } else if (channel.startsWith(`${CHANNEL_PREFIX}agent:`)) {
      const agentId = Number(channel.slice(`${CHANNEL_PREFIX}agent:`.length));
      for (const res of agentChannels.get(agentId) ?? []) write(res, msg.event, data);
    }
  });
  sub.on('subscribe', (channel) => console.log(`[bus] 订阅: ${channel}`));
}

/**
 * 推送事件：本地直写 + 跨实例广播
 * @param {'session'|'agent'} scope 通道类型
 * @param {string|number} key sessionId / agentId
 */
export function pushEvent(scope, key, event, data) {
  const set = scope === 'session' ? sessionChannels.get(String(key)) : agentChannels.get(key);
  for (const res of set ?? []) write(res, event, data); // 本进程持有的连接同步直写（零延迟）
  if (isRedisMode()) {
    // 信封携带实例 ID：发布者自己也会收到这条 PUBLISH（它订阅着该频道），订阅端按 from 去重
    getRedis()
      .publish(
        scope === 'session' ? sessionChannel(key) : agentChannel(key),
        JSON.stringify({ from: INSTANCE_ID, event, data })
      )
      .catch((err) => console.warn('[bus] 发布失败:', err.message));
  }
}

/** 用户会话通道：EventSource 连接建立（返回移除函数） */
export function addChannel(sessionId, res) {
  if (!sessionChannels.has(sessionId)) sessionChannels.set(sessionId, new Set());
  const set = sessionChannels.get(sessionId);
  set.add(res);
  pushEvent('session', sessionId, 'connected', { sessionId, ts: Date.now() });
  void ensureSubscribed(sessionChannel(sessionId));
  return () => {
    set.delete(res);
    if (!set.size) {
      sessionChannels.delete(sessionId);
      void ensureUnsubscribed(sessionChannel(sessionId));
    }
  };
}

/** 客服工作台通道（返回移除函数；接入时立即注册在线心跳） */
export function addAgentChannel(agentId, res) {
  if (!agentChannels.has(agentId)) agentChannels.set(agentId, new Set());
  const set = agentChannels.get(agentId);
  set.add(res);
  res.write(`event: connected\ndata: ${JSON.stringify({ agentId, ts: Date.now() })}\n\n`);
  void ensureSubscribed(agentChannel(agentId));
  touchPresence(agentId);
  return () => {
    set.delete(res);
    if (!set.size) {
      agentChannels.delete(agentId);
      void ensureUnsubscribed(agentChannel(agentId));
      // 最后一个连接断开：立即摘除在线注册（不等 TTL 自然过期）
      if (isRedisMode()) getRedis().del(PRESENCE_PREFIX + agentId).catch(() => {});
    }
  };
}

function touchPresence(agentId) {
  if (!isRedisMode()) return;
  getRedis().set(PRESENCE_PREFIX + agentId, '1', 'PX', PRESENCE_TTL_MS).catch(() => {});
}

/** 客服在线心跳：多实例下任一实例持有连接即视为在线 */
export function startPresenceHeartbeat() {
  if (!isRedisMode() || presenceTimer) return;
  presenceTimer = setInterval(() => {
    for (const agentId of agentChannels.keys()) touchPresence(agentId);
  }, PRESENCE_HEARTBEAT_MS);
  presenceTimer.unref?.();
}

/** 客服是否在线（Redis 心跳为准，异常时回退本进程连接判断） */
export async function isAgentOnline(agentId) {
  if (isRedisMode()) {
    try {
      return (await getRedis().exists(PRESENCE_PREFIX + agentId)) === 1;
    } catch (err) {
      console.warn('[bus] 在线状态查询失败，回退本进程判断:', err.message);
    }
  }
  const set = agentChannels.get(agentId);
  return !!set && set.size > 0;
}

/** 优雅退出：清理心跳定时器 */
export function closeBus() {
  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }
}
