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
 * 初始化三张表（幂等，可重复执行）：
 * - support_human  人工客服表
 * - chat_sessions  会话表（含人工会话状态）
 * - chat_messages  会话消息表
 * 时间戳约定：业务字段（ts/join_at 等）存毫秒 BIGINT 与上层 Date.now() 对齐；
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
