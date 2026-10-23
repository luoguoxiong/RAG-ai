// ============ 一次性迁移：data/memory.json -> PostgreSQL 记忆表 ============
// 用法：npm run migrate:memory
// 特性：
//   - 幂等：按 id / (user_id,type,key) 冲突更新，可重复执行；
//   - 同一 (type,key) 的多条 active 事实按 updatedAt 先后写入，最新的胜出（与线上冲突消解一致）；
//   - 不删除旧 JSON 文件，迁移验证通过后由人工清理。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, pool } from '../server/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '..', 'data', 'memory.json');

function loadJson() {
  if (!fs.existsSync(DATA_FILE)) return { users: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { users: {} };
  } catch (err) {
    throw new Error(`读取 ${DATA_FILE} 失败：${err.message}`);
  }
}

async function main() {
  const db = loadJson();
  const users = Object.entries(db.users || {});
  if (!users.length) {
    console.log('[migrate] memory.json 中没有用户数据，跳过');
    return;
  }

  await initDb();

  let factCount = 0;
  let summaryCount = 0;

  for (const [userId, user] of users) {
    const facts = [...(user.facts || [])].sort(
      (a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)
    );
    for (const f of facts) {
      const id = f.id || `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const row = [
        id,
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
      ];

      // 已存在同 id（重复迁移）-> 覆盖更新；否则按 (type,key) 的 active 唯一索引做"最新值胜出"
      const { rowCount } = await pool.query(`SELECT 1 FROM memory_facts WHERE id = $1;`, [id]);
      if (rowCount) {
        await pool.query(
          `UPDATE memory_facts SET type=$3, key=$4, value=$5::jsonb, confidence=$6, evidence=$7,
                  source=$8, hits=$9, status=$10, history=$11::jsonb, created_at=$12,
                  updated_at=$13, expires_at=$14, archived_at=$15
            WHERE id=$1 AND user_id=$2;`,
          row
        );
      } else {
        await pool.query(
          `INSERT INTO memory_facts (id, user_id, type, key, value, confidence, evidence, source,
                                     hits, status, history, created_at, updated_at, expires_at, archived_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)
           ON CONFLICT (user_id, type, key) WHERE status = 'active' DO UPDATE SET
             value = EXCLUDED.value, confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence,
             source = EXCLUDED.source, hits = EXCLUDED.hits, history = EXCLUDED.history,
             updated_at = EXCLUDED.updated_at, expires_at = EXCLUDED.expires_at;`,
          row
        );
      }
      factCount++;
    }

    // 摘要按 sessionId 去重，保留 ts 最新的一条
    const bySession = new Map();
    for (const s of user.summaries || []) {
      const prev = bySession.get(s.sessionId);
      if (!prev || (s.ts || 0) >= (prev.ts || 0)) bySession.set(s.sessionId, s);
    }
    for (const [sessionId, s] of bySession) {
      await pool.query(
        `INSERT INTO memory_summaries (id, user_id, session_id, summary, until_ts, ts)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, session_id) DO UPDATE
           SET summary = EXCLUDED.summary, until_ts = EXCLUDED.until_ts, ts = EXCLUDED.ts;`,
        [
          `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          userId,
          sessionId,
          String(s.summary || ''),
          s.untilTs ?? 0,
          s.ts ?? Date.now()
        ]
      );
      summaryCount++;
    }
  }

  console.log(`[migrate] 完成：${users.length} 个用户，${factCount} 条事实，${summaryCount} 条摘要`);
}

main()
  .catch((err) => {
    console.error('[migrate] 迁移失败:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
