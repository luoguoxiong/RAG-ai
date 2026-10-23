// ============ Redis 接入：可选依赖（REDIS_URL 配置后启用） ============
// 生产化分层：
//   - 配置 REDIS_URL  -> 挂起槽位 / SSE 事件总线 / 限流 / 客服在线状态全部走 Redis，
//     进程变成无状态，可任意横向扩展（多实例共享状态、重启不丢挂起）
//   - 未配置          -> 各模块自动降级为进程内存实现（单机演示模式，行为与旧版一致）
import 'dotenv/config';
import Redis from 'ioredis';

export const REDIS_URL = process.env.REDIS_URL || '';

let client = null; // 普通命令连接
let subClient = null; // pub/sub 专用连接（进入订阅模式后不能复用普通连接）

export function isRedisMode() {
  return !!REDIS_URL;
}

/** 普通命令连接（懒创建，进程内单例） */
export function getRedis() {
  if (!REDIS_URL) return null;
  if (!client) {
    client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => Math.min(times * 500, 5000),
      // 连接失败不抛未捕获异常，由各调用方 try/catch 兜底
      enableOfflineQueue: true
    });
    client.on('error', (err) => console.error('[redis] 连接异常:', err.message));
  }
  return client;
}

/** pub/sub 订阅连接（懒创建，进程内单例；依赖普通连接先就绪） */
export function getRedisSubscriber() {
  if (!REDIS_URL) return null;
  if (!subClient) {
    subClient = getRedis().duplicate();
    subClient.on('error', (err) => console.error('[redis] 订阅连接异常:', err.message));
  }
  return subClient;
}

/** 优雅退出：释放连接（SIGTERM 时调用） */
export async function quitRedis() {
  const jobs = [client?.quit(), subClient?.quit()].filter(Boolean);
  client = null;
  subClient = null;
  await Promise.allSettled(jobs);
}
