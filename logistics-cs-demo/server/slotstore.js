// ============ 待补参槽位存储：Redis 原子操作 + 内存降级 ============
// 原版为进程内 Map（agent.js pendingSlots），多进程/重启即失效。本模块把它外置：
//   Redis 模式：SET key payload PX ttl —— TTL 由 Redis 原生保证（不再需要进程内 sweeper）；
//              GETDEL 原子取出 —— 多进程/并发重复提交只有一个成功，天然幂等；
//   内存模式：Map + 过期时间惰性清理（单机演示模式，语义对齐旧版）。
// 容量保护：每进程维护"挂起创建登记"（轻量 ledger），超过上限拒绝新挂起，
// 防御异常客户端/故障场景把存储打爆——这是限流之外的最后一道闸。
import { getRedis, isRedisMode } from './redis.js';

const PREFIX = 'cs:pending:'; // 挂起槽位键前缀（多实例共享）
export const PENDING_SLOTS_TTL = 10 * 60 * 1000; // 槽位挂起有效期：超时后需重新提问（与旧版一致）
const MAX_PENDING_SLOTS = Number(process.env.MAX_PENDING_SLOTS) || 10000;

// 内存驱动：sessionId -> { data, expireAt }
const memory = new Map();
// 每进程挂起登记：sessionId -> createdAt（容量保护用；上限与 TTL 同数量级，内存占用可忽略）
const ledger = new Map();

function pruneLedger(now = Date.now()) {
  if (ledger.size < MAX_PENDING_SLOTS) return;
  for (const [k, ts] of ledger) {
    if (now - ts > PENDING_SLOTS_TTL) ledger.delete(k);
  }
}

/**
 * 登记一个挂起（同一 sessionId 覆盖旧值，语义与旧版 Map.set 一致）
 * @returns false 表示达到每进程容量上限（挂起被拒绝）
 */
export async function putPending(sessionId, payload, { ttlMs = PENDING_SLOTS_TTL } = {}) {
  pruneLedger();
  if (ledger.size >= MAX_PENDING_SLOTS && !ledger.has(sessionId)) return false;
  ledger.set(sessionId, Date.now());

  const data = JSON.stringify(payload);
  if (isRedisMode()) {
    await getRedis().set(PREFIX + sessionId, data, 'PX', ttlMs);
  } else {
    memory.set(sessionId, { data, expireAt: Date.now() + ttlMs });
  }
  return true;
}

/** 只读探测（hasPendingSlots 用），不取出 */
export async function getPending(sessionId) {
  if (isRedisMode()) {
    const raw = await getRedis().get(PREFIX + sessionId);
    return raw ? JSON.parse(raw) : null;
  }
  const e = memory.get(sessionId);
  if (!e) return null;
  if (Date.now() > e.expireAt) {
    memory.delete(sessionId);
    return null;
  }
  return JSON.parse(e.data);
}

/** 原子取出（取出即删除，防并发/跨进程重复提交）。不存在返回 null */
export async function takePending(sessionId) {
  if (isRedisMode()) {
    const raw = await getRedis().getdel(PREFIX + sessionId); // Redis >= 6.2
    return raw ? JSON.parse(raw) : null;
  }
  const p = await getPending(sessionId);
  if (p) memory.delete(sessionId);
  return p;
}

/** 主动作废（用户新消息进来时丢弃遗留弹窗 / 提交超时清理） */
export async function delPending(sessionId) {
  ledger.delete(sessionId);
  if (isRedisMode()) {
    await getRedis().del(PREFIX + sessionId);
  } else {
    memory.delete(sessionId);
  }
}
