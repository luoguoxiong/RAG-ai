// ============ 长期记忆持久层（PostgreSQL） ============
// 由本地 JSON（data/memory.json）迁移至 PostgreSQL，与 store.js 保持同一底座：
//   - memory_facts       L2 语义事实（跨会话用户画像）
//   - memory_summaries   L1 情景摘要（会话摘要）
// 只提供数据原语，提取/合并/衰减等策略见 memory.js。
//
// 并发模型（P0 生产化重点）：
//   1) 所有"读-改-写"都走 withUserLock：单事务 + pg_advisory_xact_lock(user_id) 串行化同一用户，
//      避免多实例/多请求并发提取时互相覆盖；
//   2) 事务内只做内存态修改，提交前按 id 做 diff，精确落盘 INSERT/UPDATE/DELETE，
//      不再整文件重写；
//   3) bumpFact 等高频计数用原子 SQL 更新，不进入 read-modify-write 路径。
import { pool } from './db.js';

const MAX_FACTS_PER_USER = 100; // 每用户 active 事实上限，超出按 updatedAt 淘汰最旧
const MAX_SUMMARIES_PER_USER = 20; // 每用户会话摘要上限，超出按时间淘汰

const FACT_FIELDS = `id, user_id, type, key, value, confidence, evidence, source, hits, status,
                     history, created_at, updated_at, expires_at, archived_at`;

// ---------- 行 <-> 对象映射 ----------
// PG 的 BIGINT 经 pg 驱动返回字符串，统一转 Number，避免上层出现字符串时间戳
function num(v) {
  return v === null || v === undefined ? null : Number(v);
}

function rowToFact(r) {
  return {
    id: r.id,
    type: r.type,
    key: r.key,
    value: r.value,
    confidence: num(r.confidence),
    evidence: r.evidence,
    source: r.source,
    hits: num(r.hits) || 0,
    status: r.status,
    history: r.history || [],
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    expiresAt: num(r.expires_at),
    archivedAt: num(r.archived_at)
  };
}

function rowToSummary(r) {
  return {
    id: r.id,
    userId: r.user_id,
    sessionId: r.session_id,
    summary: r.summary,
    untilTs: num(r.until_ts),
    ts: num(r.ts)
  };
}

// 变更检测签名：只比较会被策略层改动的字段
function sigFact(f) {
  return JSON.stringify([
    f.type,
    f.key,
    f.value ?? null,
    f.confidence ?? null,
    f.evidence ?? null,
    f.source ?? null,
    f.hits ?? 0,
    f.status ?? 'active',
    f.history ?? [],
    f.expiresAt ?? null,
    f.archivedAt ?? null
  ]);
}
function sigSummary(s) {
  return JSON.stringify([s.sessionId, s.summary, s.untilTs ?? 0, s.ts ?? 0]);
}

// ---------- 事务式读写 ----------
/**
 * 在同一用户维度的串行锁下修改记忆：
 * fn(user) 内直接改 user.facts / user.summaries；返回 false 表示无变更（回滚不落盘）。
 * 返回值为 fn 的返回值。整个过程在一个事务内完成，崩溃/异常自动回滚。
 */
export async function withUserLock(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 会话级事务锁：同一 userId 的并发修改排队执行（新用户无行也能锁住，用哈希作锁键）
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0));`, [userId]);

    const fRes = await client.query(
      `SELECT ${FACT_FIELDS} FROM memory_facts WHERE user_id = $1 ORDER BY created_at ASC, id ASC;`,
      [userId]
    );
    const sRes = await client.query(
      `SELECT id, user_id, session_id, summary, until_ts, ts
       FROM memory_summaries WHERE user_id = $1 ORDER BY ts ASC, id ASC;`,
      [userId]
    );

    const user = {
      userId,
      createdAt: fRes.rows[0] ? num(fRes.rows[0].created_at) : Date.now(),
      updatedAt: Date.now(),
      facts: fRes.rows.map(rowToFact),
      summaries: sRes.rows.map(rowToSummary)
    };

    const result = await fn(user);
    if (result === false) {
      await client.query('ROLLBACK');
      return false;
    }

    enforceCapacity(user);
    await persistDiff(client, userId, fRes.rows, sRes.rows, user);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// 按 id diff 落盘：新增 INSERT、变化 UPDATE、消失 DELETE（策略层通常为软删，DELETE 仅兜底）
async function persistDiff(client, userId, factRows, summaryRows, user) {
  const factSnap = new Map(factRows.map((r) => [r.id, sigFact(rowToFact(r))]));
  const sumSnap = new Map(summaryRows.map((r) => [r.id, sigSummary(rowToSummary(r))]));

  for (const f of user.facts) {
    const sig = sigFact(f);
    if (!factSnap.has(f.id)) {
      await client.query(
        `INSERT INTO memory_facts (id, user_id, type, key, value, confidence, evidence, source,
                                   hits, status, history, created_at, updated_at, expires_at, archived_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15);`,
        [
          f.id,
          userId,
          f.type,
          f.key,
          JSON.stringify(f.value ?? null),
          f.confidence ?? 0.5,
          f.evidence ?? null,
          f.source ?? 'inferred',
          f.hits ?? 0,
          f.status ?? 'active',
          JSON.stringify(f.history ?? []),
          f.createdAt ?? Date.now(),
          f.updatedAt ?? Date.now(),
          f.expiresAt ?? null,
          f.archivedAt ?? null
        ]
      );
    } else if (factSnap.get(f.id) !== sig) {
      await client.query(
        `UPDATE memory_facts SET
           type = $3, key = $4, value = $5::jsonb, confidence = $6, evidence = $7, source = $8,
           hits = $9, status = $10, history = $11::jsonb, created_at = $12, updated_at = $13,
           expires_at = $14, archived_at = $15
         WHERE id = $1 AND user_id = $2;`,
        [
          f.id,
          userId,
          f.type,
          f.key,
          JSON.stringify(f.value ?? null),
          f.confidence ?? 0.5,
          f.evidence ?? null,
          f.source ?? 'inferred',
          f.hits ?? 0,
          f.status ?? 'active',
          JSON.stringify(f.history ?? []),
          f.createdAt ?? Date.now(),
          f.updatedAt ?? Date.now(),
          f.expiresAt ?? null,
          f.archivedAt ?? null
        ]
      );
    }
  }
  for (const id of factSnap.keys()) {
    if (!user.facts.some((f) => f.id === id)) {
      await client.query(`DELETE FROM memory_facts WHERE id = $1 AND user_id = $2;`, [id, userId]);
    }
  }

  for (const s of user.summaries) {
    const sig = sigSummary(s);
    if (!sumSnap.has(s.id)) {
      await client.query(
        `INSERT INTO memory_summaries (id, user_id, session_id, summary, until_ts, ts)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, session_id) DO UPDATE
           SET summary = EXCLUDED.summary, until_ts = EXCLUDED.until_ts, ts = EXCLUDED.ts;`,
        [s.id, userId, s.sessionId, s.summary, s.untilTs ?? 0, s.ts ?? Date.now()]
      );
    } else if (sumSnap.get(s.id) !== sig) {
      await client.query(
        `UPDATE memory_summaries SET session_id = $3, summary = $4, until_ts = $5, ts = $6
         WHERE id = $1 AND user_id = $2;`,
        [s.id, userId, s.sessionId, s.summary, s.untilTs ?? 0, s.ts ?? Date.now()]
      );
    }
  }
  for (const id of sumSnap.keys()) {
    if (!user.summaries.some((s) => s.id === id)) {
      await client.query(`DELETE FROM memory_summaries WHERE id = $1 AND user_id = $2;`, [id, userId]);
    }
  }
}

// ---------- 原语 ----------
/** 读用户记忆（不存在返回 null）；始终返回 DB 的独立副本，外部改动不影响库内数据 */
export async function readUser(userId) {
  const [facts, summaries] = await Promise.all([listFacts(userId, null), getSummaries(userId)]);
  if (!facts.length && !summaries.length) return null;
  return {
    userId,
    createdAt: facts[0]?.createdAt ?? Date.now(),
    updatedAt: facts.reduce((m, f) => Math.max(m, f.updatedAt || 0), 0) || Date.now(),
    facts,
    summaries
  };
}

/** 事务式修改：fn(user) 内直接改 user 对象，返回 false 表示未变更不落盘 */
export function mutateUser(userId, fn) {
  return withUserLock(userId, fn);
}

export async function listFacts(userId, status = 'active') {
  const { rows } = await pool.query(
    `SELECT ${FACT_FIELDS} FROM memory_facts
     WHERE user_id = $1 ${status ? 'AND status = $2' : ''}
     ORDER BY updated_at DESC, id ASC;`,
    status ? [userId, status] : [userId]
  );
  return rows.map(rowToFact);
}

export async function getSummaries(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, session_id, summary, until_ts, ts
     FROM memory_summaries WHERE user_id = $1 ORDER BY ts ASC, id ASC;`,
    [userId]
  );
  return rows.map(rowToSummary);
}

/** 新增/更新一条事实（fact 由调用方构造完整对象，含 id） */
export async function putFact(userId, fact) {
  return withUserLock(userId, (user) => {
    const idx = user.facts.findIndex((f) => f.id === fact.id);
    if (idx >= 0) user.facts[idx] = { ...fact };
    else user.facts.push({ ...fact });
  });
}

/** 命中记忆：hits+1、confidence 微升并刷新 updatedAt（原子 SQL，不走 read-modify-write） */
export async function bumpFact(userId, factId) {
  const { rowCount } = await pool.query(
    `UPDATE memory_facts
        SET hits = hits + 1,
            confidence = LEAST(1, COALESCE(confidence, 0.5) + 0.05),
            updated_at = $3
      WHERE id = $1 AND user_id = $2;`,
    [factId, userId, Date.now()]
  );
  return rowCount > 0;
}

/** 软删除：status 置为 archived/superseded，保留记录可回溯 */
export async function archiveFact(userId, factId, status = 'archived') {
  const { rowCount } = await pool.query(
    `UPDATE memory_facts SET status = $3, archived_at = $4 WHERE id = $1 AND user_id = $2;`,
    [factId, userId, status, Date.now()]
  );
  return rowCount > 0;
}

export async function deleteFactPhysical(userId, factId) {
  const { rowCount } = await pool.query(
    `DELETE FROM memory_facts WHERE id = $1 AND user_id = $2;`,
    [factId, userId]
  );
  return rowCount > 0;
}

/** 追加/更新会话摘要，并滚动裁剪到容量上限 */
export async function appendSummary(userId, summary) {
  const id = summary.id || `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO memory_summaries (id, user_id, session_id, summary, until_ts, ts)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, session_id) DO UPDATE
       SET summary = EXCLUDED.summary, until_ts = EXCLUDED.until_ts, ts = EXCLUDED.ts;`,
    [id, userId, summary.sessionId, String(summary.summary || ''), summary.untilTs ?? 0, summary.ts ?? Date.now()]
  );
  await pool.query(
    `DELETE FROM memory_summaries
      WHERE user_id = $1
        AND id NOT IN (
          SELECT id FROM memory_summaries WHERE user_id = $1 ORDER BY ts DESC LIMIT $2
        );`,
    [userId, MAX_SUMMARIES_PER_USER]
  );
  return id;
}

/** "忘记我"：清空该用户全部记忆（合规）——事实、摘要与未完成任务一并清除 */
export async function forgetUser(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0));`, [userId]);
    await client.query(`DELETE FROM memory_facts WHERE user_id = $1;`, [userId]);
    await client.query(`DELETE FROM memory_summaries WHERE user_id = $1;`, [userId]);
    await client.query(`DELETE FROM memory_jobs WHERE user_id = $1;`, [userId]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// 容量上限：active 事实超过 MAX 时按 updatedAt 淘汰最旧的（score 排序由策略层负责，
// 这里只保证库不无限膨胀；淘汰即归档，可回溯）
function enforceCapacity(user) {
  const active = user.facts.filter((f) => f.status === 'active');
  if (active.length <= MAX_FACTS_PER_USER) return;
  const now = Date.now();
  active
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
    .slice(0, active.length - MAX_FACTS_PER_USER)
    .forEach((f) => {
      f.status = 'archived';
      f.archivedAt = now;
    });
}
