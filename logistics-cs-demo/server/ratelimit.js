// ============ 入口限流：固定窗口（Redis / 内存双实现） ============
// 防御性兜底的第一道闸：单 IP 每分钟请求数上限，超限 429。
//   Redis 模式：INCR + PEXPIRE，窗口计数跨多实例共享（LB 后全局限流）；
//   内存模式：进程内窗口 Map（单机演示模式）。
// 限流器自身故障时放行并告警——可用性优先，限流是保护措施而不是单点。
import { getRedis, isRedisMode } from './redis.js';

export const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 60); // 0 = 关闭
const WINDOW_MS = 60_000;

// 内存驱动：key -> { count, expireAt }
const windows = new Map();
const WINDOWS_HARD_CAP = 50_000; // 防御：窗口条目硬上限，防 IP 伪造刷爆内存

function reject(res) {
  res.status(429).json({ error: 'rate_limited', message: '您请求的频率有点快，请稍后再试' });
}

/**
 * @param {object} opts
 * @param {string} opts.name   路由名（限流键维度，如 chat / slots）
 * @param {number} [opts.max]  每窗口上限，缺省 RATE_LIMIT_PER_MIN（0 关闭）
 */
export function rateLimit({ name, max = RATE_LIMIT_PER_MIN } = {}) {
  return async (req, res, next) => {
    if (!max) return next();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `cs:rl:${name}:${ip}`;
    try {
      if (isRedisMode()) {
        const redis = getRedis();
        const count = await redis.incr(key);
        if (count === 1) await redis.pexpire(key, WINDOW_MS);
        if (count > max) return reject(res);
      } else {
        const now = Date.now();
        let w = windows.get(key);
        if (!w || now > w.expireAt) {
          w = { count: 0, expireAt: now + WINDOW_MS };
          if (windows.size >= WINDOWS_HARD_CAP) {
            for (const [k, v] of windows) if (now > v.expireAt) windows.delete(k);
          }
          windows.set(key, w);
        }
        w.count += 1;
        if (w.count > max) return reject(res);
      }
      next();
    } catch (err) {
      console.error('[ratelimit] 限流器异常（放行）:', err.message);
      next();
    }
  };
}
