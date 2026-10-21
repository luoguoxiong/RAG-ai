// ============ PostgreSQL 持久层：会话 / 消息 / 人工客服状态 ============
// 由本地 JSON（data/history.json）迁移至 PostgreSQL：
//   - chat_sessions：会话行 + 人工会话状态（human_status 等字段）
//   - chat_messages：会话消息（role/content/ts）
//   - support_human：客服表（人工接入时从这里取客服）
// 导出接口与原 JSON 版一致，仅由同步改为 async，上层调用点补 await 即可。
import { pool, ensureSession } from './db.js';

const MAX_MESSAGES_PER_SESSION = 200; // 每个会话最多保留的消息条数

/**
 * 拉取会话全部消息（按写入顺序）
 * 返回 [{ id, role, name, content, ts }]
 */
export async function getMessages(sessionId) {
  const { rows } = await pool.query(
    `SELECT id, role, name, content, ts
     FROM chat_messages
     WHERE session_id = $1
     ORDER BY id ASC;`,
    [sessionId]
  );
  return rows;
}

/**
 * 追加一条消息：{ role, content, name?, ts? }
 * role: 'user' | 'assistant' | 'human_agent' | 'system'
 * 超出保留上限时删除最早的消息。
 */
export async function appendMessage(sessionId, msg) {
  await ensureSession(sessionId);
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (session_id, role, name, content, ts)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, role, name, content, ts;`,
    [sessionId, msg.role, msg.name ?? null, String(msg.content), msg.ts ?? Date.now()]
  );
  // 会话行 updated_at 刷新 + 消息滚动截断
  await pool.query(`UPDATE chat_sessions SET updated_at = now() WHERE session_id = $1;`, [sessionId]);
  await pool.query(
    `DELETE FROM chat_messages
     WHERE session_id = $1
       AND id NOT IN (
         SELECT id FROM chat_messages WHERE session_id = $1 ORDER BY id DESC LIMIT $2
       );`,
    [sessionId, MAX_MESSAGES_PER_SESSION]
  );
  return rows[0];
}

// ---------- 人工客服会话状态持久化 ----------
// 人工会话（排队中/已接入）状态落在 chat_sessions 的 human_* 字段，服务重启后可恢复。
// 形如 { status: 'queued'|'active'|'ended', queuePosition, agent, joinAt, updatedAt }

export async function getHumanState(sessionId) {
  const { rows } = await pool.query(
    `SELECT s.human_status, s.human_queue_position, s.human_join_at, s.human_updated_at,
            a.id AS agent_id, a.name AS agent_name, a.code AS agent_code
     FROM chat_sessions s
     LEFT JOIN support_human a ON a.id = s.human_agent_id
     WHERE s.session_id = $1;`,
    [sessionId]
  );
  const s = rows[0];
  if (!s || !s.human_status) return null;
  return {
    status: s.human_status,
    queuePosition: s.human_queue_position ?? null,
    agent: s.agent_id ? { id: s.agent_id, name: s.agent_name, code: s.agent_code } : null,
    joinAt: s.human_join_at ?? null,
    updatedAt: s.human_updated_at ?? null
  };
}

export async function setHumanState(sessionId, human) {
  await ensureSession(sessionId);
  // agent 兼容两种形态：{ id } / { name, code }，统一解析为客服 id
  let agentId = null;
  if (human.agent) {
    if (human.agent.id) {
      agentId = human.agent.id;
    } else {
      const { rows } = await pool.query(
        `SELECT id FROM support_human WHERE code = $1;`,
        [human.agent.code]
      );
      agentId = rows[0]?.id ?? null;
    }
  }
  const { rows } = await pool.query(
    `UPDATE chat_sessions SET
       human_status = $2,
       human_queue_position = $3,
       human_agent_id = $4,
       human_join_at = $5,
       human_updated_at = $6
     WHERE session_id = $1
     RETURNING human_status, human_queue_position, human_agent_id, human_join_at, human_updated_at;`,
    [
      sessionId,
      human.status ?? null,
      human.queuePosition ?? null,
      agentId,
      human.joinAt ?? null,
      Date.now()
    ]
  );
  const s = rows[0];
  return {
    status: s.human_status,
    queuePosition: s.human_queue_position,
    agent: human.agent ?? null,
    joinAt: s.human_join_at,
    updatedAt: s.human_updated_at
  };
}
