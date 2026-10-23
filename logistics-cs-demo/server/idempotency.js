// ============ 服务端幂等键：消息级去重（Redis SETNX + TTL / 内存降级） ============
// 前端 busy 锁只能挡住同一页面的连点，挡不住网络层重试、页面双开、多端登录的重复请求。
// 本模块以客户端生成的 msgId 为幂等键做真正的服务端幂等：
//   1) 认领：SET key __processing__ NX PX ttl —— 同 id 并发/重复请求只有一个真正执行，
//      其余在请求进入 SSE 前直接 409 快速失败（不占并发闸、不触发 LLM）；
//   2) 回写：执行完成后把可重放结果覆盖写回同 key 并重置 TTL ——
//      TTL 内的同 id 重复请求直接重放第一次的结果（SSE 事件序列），不再重复落库/记忆提取；
//   3) 释放：执行失败删除占位 —— 客户端可携带同一 msgId 重试（幂等键只对"成功"记忆）。
// 与 ratelimit/slotstore 同一分层哲学：Redis 模式多实例共享（任意实例可判重/重放），
// 未配置 REDIS_URL 降级为进程内存 Map（单机演示模式，语义一致）；依赖故障时放行——
// 幂等是保护措施而不是单点，不能因为判重器挂了把正常请求也挡在门外。
import { getRedis, isRedisMode } from './redis.js';

const PREFIX = 'cs:idem:'; // 幂等键前缀（多实例共享）
const PROCESSING = '__processing__'; // 占位值：已认领但尚未完成
export const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000; // 幂等窗口：与挂起槽位 TTL 对齐
const MAX_MSG_ID_LEN = 64; // 防御：异常超长 id 直接跳过判重

// 内存驱动：msgId -> { state: 'processing' | 'done', result, expireAt }
const memory = new Map();

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_MSG_ID_LEN;
}

/**
 * 认领幂等键（请求入口处调用，进入 SSE 之前）
 * @returns {status:'first'}    首次请求，可以执行
 *          {status:'processing'} 同 id 请求正在执行，应返回 409
 *          {status:'replay', result} 已有完成结果，直接重放
 */
export async function claim(msgId, { ttlMs = IDEMPOTENCY_TTL_MS } = {}) {
  if (!validId(msgId)) return { status: 'first' };
  try {
    if (isRedisMode()) {
      const redis = getRedis();
      const ok = await redis.set(PREFIX + msgId, PROCESSING, 'PX', ttlMs, 'NX');
      if (ok) return { status: 'first' };
      // 认领失败：查同 key 是否已有完成结果可重放（GET 与 SETNX 间首请求可能刚好完成）
      const raw = await redis.get(PREFIX + msgId);
      if (raw && raw !== PROCESSING) {
        try {
          return { status: 'replay', result: JSON.parse(raw) };
        } catch {
          return { status: 'processing' }; // 脏数据按"处理中"兜底
        }
      }
      return { status: 'processing' };
    }

    // 内存模式
    const now = Date.now();
    const e = memory.get(msgId);
    if (!e || now > e.expireAt) {
      memory.set(msgId, { state: 'processing', expireAt: now + ttlMs });
      return { status: 'first' };
    }
    if (e.state === 'done') return { status: 'replay', result: e.result };
    return { status: 'processing' };
  } catch (err) {
    console.error('[idempotency] 认领异常（放行）:', err.message);
    return { status: 'first' }; // 判重器故障：可用性优先，退化为无幂等
  }
}

/** 执行成功：把可重放结果覆盖写回（重置 TTL，从"完成时刻"起算幂等窗口） */
export async function complete(msgId, result, { ttlMs = IDEMPOTENCY_TTL_MS } = {}) {
  if (!validId(msgId)) return;
  try {
    if (isRedisMode()) {
      await getRedis().set(PREFIX + msgId, JSON.stringify(result), 'PX', ttlMs);
    } else {
      memory.set(msgId, { state: 'done', result, expireAt: Date.now() + ttlMs });
    }
  } catch (err) {
    console.error('[idempotency] 结果回写失败:', err.message);
  }
}

/** 执行失败/路由前置校验拒绝：释放占位，允许客户端携带同一 msgId 重试 */
export async function fail(msgId) {
  if (!validId(msgId)) return;
  try {
    if (isRedisMode()) {
      await getRedis().del(PREFIX + msgId);
    } else {
      memory.delete(msgId);
    }
  } catch (err) {
    console.error('[idempotency] 占位释放失败:', err.message);
  }
}

/**
 * 记录 SSE 事件流为可重放结果：delta 事件向后合并（整段文本一条事件），
 * 其余事件（status / ask_location / memory_used / done / error）原样保留顺序。
 * 重放时前端零改动——按同一协议原样推一遍即可恢复最终界面状态。
 */
export function makeResultRecorder(send) {
  const events = [];
  return {
    events,
    send(event, data) {
      const last = events[events.length - 1];
      if (event === 'delta' && last?.event === 'delta') {
        last.data.text += data.text; // 流式增量合并，结果体积从几百条压缩到一条
      } else {
        events.push({ event, data: { ...data } });
      }
      send(event, data); // 真实推流照常进行，记录只是旁路
    }
  };
}

/** 把记录的结果重放为 SSE 响应（重复请求"直接返回第一次结果"） */
export function replayResult(res, result, { recorderFactory = makeResultRecorder } = {}) {
  const events = Array.isArray(result?.events) ? result.events : [];
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  write('start', { ts: Date.now(), replay: true }); // 前端可据此提示"响应重复请求，已返回第一次结果"
  for (const e of events) write(e.event, e.data);
  res.end();
}
