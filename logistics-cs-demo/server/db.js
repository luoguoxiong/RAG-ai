// ============ PostgreSQL 连接层：连接池 + 建表 + 种子数据 ============
// 连接串优先读环境变量 DATABASE_URL，缺省连本机 logistics_cs 库
import 'dotenv/config';
import pg from 'pg';

export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://localhost:5432/logistics_cs';

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 10, // 连接池上限
  idleTimeoutMillis: 30_000
});

pool.on('error', (err) => {
  console.error('[db] 连接池异常:', err.message);
});

/**
 * 初始化表（幂等，可重复执行）：
 * - support_human  人工客服表
 * - chat_sessions  会话表（含人工会话状态）
 * - chat_messages  会话消息表
 * - memory_facts      长期记忆 L2 语义事实（跨会话用户画像）
 * - memory_summaries  长期记忆 L1 情景摘要（会话摘要）
 * - memory_jobs       记忆异步任务队列（提取 / 摘要），进程重启不丢
 * 时间戳约定：业务字段（ts/join_at/updated_at 等）存毫秒 BIGINT 与上层 Date.now() 对齐；
 * created_at 用 TIMESTAMPTZ 仅作库内审计。
 */
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_human (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      code       TEXT NOT NULL UNIQUE,
      status     TEXT NOT NULL DEFAULT 'online',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      session_id            TEXT PRIMARY KEY,
      human_status          TEXT,
      human_queue_position  INT,
      human_agent_id        INT REFERENCES support_human(id) ON DELETE SET NULL,
      human_join_at         BIGINT,
      human_updated_at      BIGINT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      name       TEXT,
      content    TEXT NOT NULL,
      ts         BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_facts (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      type        TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       JSONB NOT NULL,
      confidence  REAL NOT NULL DEFAULT 0.5,
      source      TEXT NOT NULL DEFAULT 'inferred',
      evidence    TEXT,
      hits        INT  NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'active',
      history     JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL,
      expires_at  BIGINT,
      archived_at BIGINT,
      created_ts  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- 同一用户同一 (type,key) 只允许一条 active 事实：冲突消解的唯一性由数据库保证
    CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_facts_active
      ON memory_facts (user_id, type, key) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_memory_facts_user
      ON memory_facts (user_id, status, updated_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_summaries (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      session_id TEXT NOT NULL,
      summary    TEXT NOT NULL,
      until_ts   BIGINT NOT NULL,
      ts         BIGINT NOT NULL,
      created_ts TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_summaries_session
      ON memory_summaries (user_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_user
      ON memory_summaries (user_id, ts DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_jobs (
      id         BIGSERIAL PRIMARY KEY,
      kind       TEXT NOT NULL,            -- extract | summary
      dedupe_key TEXT NOT NULL,            -- 去抖键：extract:<userId>:<sessionId>
      user_id    TEXT NOT NULL,
      session_id TEXT,
      payload    JSONB NOT NULL DEFAULT '[]'::jsonb,
      status     TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | dead
      run_at     BIGINT NOT NULL,
      attempts   INT NOT NULL DEFAULT 0,
      last_error TEXT,
      created_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_ts TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- 同一去抖键只允许一个 pending 任务：窗口内的多轮对话合并成一次 LLM 调用
    CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_jobs_pending
      ON memory_jobs (dedupe_key) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_memory_jobs_due
      ON memory_jobs (status, run_at);
  `);

  // 种子客服数据：demo 的 mock 客服（已存在则跳过）
  await pool.query(
    `INSERT INTO support_human (name, code, status)
     VALUES ($1, $2, 'online')
     ON CONFLICT (code) DO NOTHING;`,
    ['林晓', 'CS1024']
  );

  console.log('[db] PostgreSQL 初始化完成:', DATABASE_URL);
}

/** 首次提到 sessionId 时确保会话行存在（幂等） */
export async function ensureSession(sessionId) {
  await pool.query(
    `INSERT INTO chat_sessions (session_id) VALUES ($1)
     ON CONFLICT (session_id) DO NOTHING;`,
    [sessionId]
  );
}
