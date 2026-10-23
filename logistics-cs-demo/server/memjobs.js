// ============ 记忆异步任务队列（PostgreSQL -backed） ============
// 替换原先"进程内 setTimeout + Map"的 fire-and-forget 做法，解决三个生产问题：
//   1) 进程重启/崩溃 -> 待提取任务不再丢失（任务落库，重启后由 worker 继续消费）；
//   2) 去抖不依赖内存：同一 dedupe_key 只允许一个 pending 任务，窗口内新对话合并 payload 并推迟 run_at；
//   3) 失败可重试：指数退避 + 最大次数 -> dead（死信保留在表里便于排查）。
// 认领用 FOR UPDATE SKIP LOCKED，多实例部署时同一任务不会被重复消费。
import { pool } from './db.js';

const MAX_ATTEMPTS = 3; // 超过则置为 dead
const BASE_BACKOFF_MS = 5_000; // 退避基数：5s -> 10s
const REQUEUE_DELAY_MS = 3_000; // 同一用户正忙时，稍后重试
const DEFAULT_SCAN_MS = 3_000; // 扫描周期
const CLAIM_BATCH = 5; // 单轮最多认领任务数

/**
 * 入队（去抖合并）：
 * - 同一 dedupe_key 已存在 pending 任务时，合并 payload 并刷新 run_at（等价于重置去抖窗口）；
 * - delayMs 为延迟执行时间（去抖窗口 / 空闲等待窗口）。
 */
export async function enqueue({ kind, dedupeKey, userId, sessionId, payload = [], delayMs = 0 }) {
  const { rows } = await pool.query(
    `INSERT INTO memory_jobs (kind, dedupe_key, user_id, session_id, payload, run_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (dedupe_key) WHERE status = 'pending'
     DO UPDATE SET payload = memory_jobs.payload || EXCLUDED.payload,
                   run_at = EXCLUDED.run_at,
                   attempts = 0,
                   updated_ts = now()
     RETURNING id;`,
    [kind, dedupeKey, userId, sessionId ?? null, JSON.stringify(payload), Date.now() + delayMs]
  );
  return rows[0]?.id ?? null;
}

/** 取消某会话尚未执行的摘要任务（人工会话结束/服务关闭时调用） */
export async function cancelPending(kind, sessionId) {
  const { rowCount } = await pool.query(
    `DELETE FROM memory_jobs WHERE kind = $1 AND session_id = $2 AND status = 'pending';`,
    [kind, sessionId]
  );
  return rowCount > 0;
}

/** 认领到期任务：事务内 SKIP LOCKED 抢占，状态置 running */
async function claimDue(limit) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, kind, dedupe_key, user_id, session_id, payload, attempts
         FROM memory_jobs
        WHERE status = 'pending' AND run_at <= $1
        ORDER BY run_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED;`,
      [Date.now(), limit]
    );
    if (!rows.length) {
      await client.query('COMMIT');
      return [];
    }
    await client.query(
      `UPDATE memory_jobs SET status = 'running', updated_ts = now() WHERE id = ANY($1::bigint[]);`,
      [rows.map((r) => r.id)]
    );
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 同一用户的串行锁（会话级 advisory lock，任务执行期间持有）：
 * 保证同一用户的事实提取不会并发跑（否则 LLM 基于过期事实做冲突消解会写脏）。
 * 注意锁键带 "memjob:" 前缀，与 memstore.withUserLock 的 "用户键" 分属不同命名空间：
 * 若两者用同一个键，worker 持有会话锁后再去事务里申请同一键会把自己锁死。
 * 拿不到锁返回 null，由 worker 稍后重试该任务。
 */
const LOCK_KEY_SQL = `hashtextextended('memjob:' || $1::text, 0)`;

async function tryUserLock(userId) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT pg_try_advisory_lock(${LOCK_KEY_SQL}) AS got;`,
      [userId]
    );
    if (!rows[0]?.got) {
      client.release();
      return null;
    }
    return async () => {
      try {
        await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL});`, [userId]);
      } finally {
        client.release();
      }
    };
  } catch (err) {
    client.release();
    throw err;
  }
}

async function markDone(id) {
  await pool.query(`UPDATE memory_jobs SET status = 'done', updated_ts = now() WHERE id = $1;`, [id]);
}

async function markRetry(id, attempts, err) {
  const msg = String(err?.message || err).slice(0, 300);
  if (attempts >= MAX_ATTEMPTS) {
    await pool.query(
      `UPDATE memory_jobs SET status = 'dead', attempts = $2, last_error = $3, updated_ts = now() WHERE id = $1;`,
      [id, attempts, msg]
    );
    console.warn(`[memjobs] 任务 ${id} 重试 ${attempts} 次后失败，已置为 dead: ${msg}`);
    return;
  }
  const backoff = BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1));
  await pool.query(
    `UPDATE memory_jobs SET status = 'pending', attempts = $2, last_error = $3,
                            run_at = $4, updated_ts = now()
      WHERE id = $1;`,
    [id, attempts, msg, Date.now() + backoff]
  );
  console.warn(`[memjobs] 任务 ${id} 失败（第 ${attempts} 次），${backoff}ms 后重试: ${msg}`);
}

async function requeue(id) {
  await pool.query(
    `UPDATE memory_jobs SET status = 'pending', run_at = $2, updated_ts = now() WHERE id = $1;`,
    [id, Date.now() + REQUEUE_DELAY_MS]
  );
}

// 崩溃恢复：running 任务超过租约时间未更新，视为进程已死，重新放回队列
const LEASE_TIMEOUT_SQL = `updated_ts < now() - interval '5 minutes'`;

async function reclaimStale() {
  const { rowCount } = await pool.query(
    `UPDATE memory_jobs
        SET status = 'pending', run_at = $1, updated_ts = now()
      WHERE status = 'running' AND ${LEASE_TIMEOUT_SQL};`,
    [Date.now()]
  );
  if (rowCount) console.warn(`[memjobs] 回收 ${rowCount} 个卡住的 running 任务`);
  return rowCount;
}

// ---------- worker ----------
let timer = null;
let running = false;
let lastReclaim = 0;
const RECLAIM_INTERVAL_MS = 60_000; // 崩溃回收每分钟跑一次即可

/**
 * 启动后台 worker
 * @param {{ extract: (job) => Promise<void>, summary: (job) => Promise<void> }} handlers
 * @param {number} scanMs 扫描周期
 */
export function startWorker(handlers, scanMs = DEFAULT_SCAN_MS) {
  if (timer) return;
  const tick = async () => {
    if (running) return; // 上一轮未结束则跳过，避免堆积
    running = true;
    try {
      if (Date.now() - lastReclaim > RECLAIM_INTERVAL_MS) {
        lastReclaim = Date.now();
        await reclaimStale();
      }
      const jobs = await claimDue(CLAIM_BATCH);
      for (const job of jobs) {
        await runJob(handlers, job);
      }
    } catch (err) {
      console.warn('[memjobs] 扫描异常:', err?.message || err);
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => {
    tick().catch((err) => console.warn('[memjobs] worker 异常:', err?.message || err));
  }, scanMs);
  console.log(`[memjobs] 记忆任务 worker 已启动（扫描周期 ${scanMs}ms）`);
}

export function stopWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  console.log('[memjobs] 记忆任务 worker 已停止');
}

async function runJob(handlers, job) {
  const unlock = await tryUserLock(job.user_id);
  if (!unlock) {
    await requeue(job.id); // 同一用户有任务在执行，稍后再来
    return;
  }
  try {
    const handler = job.kind === 'summary' ? handlers.summary : handlers.extract;
    if (!handler) throw new Error(`未注册的任务处理器：${job.kind}`);
    await handler(job);
    await markDone(job.id);
  } catch (err) {
    await markRetry(job.id, (job.attempts || 0) + 1, err);
  } finally {
    await unlock().catch(() => {});
  }
}
