import { and, eq, lt, or, sql } from "drizzle-orm";
import { db, withTenantTx, type Tx } from "../db/index.js";
import { tenants } from "../db/schema/tenant.js";
import { chunks, indexStatus, type ChunkRow } from "../db/schema/chunk.js";
import { entities, communityMembers } from "../db/schema/entity.js";
import { jobs } from "../db/schema/job.js";
import { outbox } from "../db/schema/outbox.js";
import { markOutboxFailed } from "./outbox.js";
import { createHybridIndexWriter, type IndexWriter } from "../indexing/writer.js";
import { createGraphIndexWriter } from "../indexing/graph.js";
import { rebuildCommunities } from "../indexing/community.js";
import { enqueueJob } from "../queue/index.js";
import type { JobType } from "../domain/index.js";

const writer: IndexWriter = createHybridIndexWriter();
const graphWriter: IndexWriter = createGraphIndexWriter();

/**
 * 外部派生索引写入（向量 + 关键词 + 图）。
 *
 * 关键约束：本函数只做外部 I/O（embedding / Qdrant / OpenSearch / Neo4j / LLM），
 * 绝不打开 DB 事务、不占用连接池连接——外部调用可能很慢甚至挂起，
 * 若在事务内执行会把连接和行锁拖死（曾导致连接池耗尽 + index_status 互相等锁）。
 * 返回 graph 索引状态，由调用方在独立的短事务里落 index_status。
 */
async function writeDerivedIndexes(
  tenantId: string,
  chunk: ChunkRow,
): Promise<"ready" | "failed" | "pending"> {
  await writer.upsert(tenantId, chunk); // parent 无操作，仅 child 落向量/关键词

  // 图索引独立于向量/关键词：Neo4j 不可用时不影响前两者就绪（§23.1 多级容错）
  try {
    await graphWriter.upsert(tenantId, chunk);
    return "ready";
  } catch (err) {
    console.warn(
      `[reconcile] graph index failed for chunk ${chunk.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "failed";
  }
}

/** 外部派生索引清理（同 writeDerivedIndexes 约束：无 DB 事务） */
async function removeDerivedIndexes(
  tenantId: string,
  chunkId: string,
): Promise<void> {
  await writer.remove(tenantId, chunkId);
  try {
    await graphWriter.remove(tenantId, chunkId);
  } catch (err) {
    console.warn(
      `[reconcile] graph removal failed for chunk ${chunkId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** 短事务：幂等写 index_status（chunkId 主键，冲突则更新） */
async function upsertIndexStatus(
  tx: Tx,
  tenantId: string,
  chunkId: string,
  graphState: string,
): Promise<void> {
  await tx
    .insert(indexStatus)
    .values({
      chunkId,
      tenantId,
      vector: "ready",
      keyword: "ready",
      graph: graphState,
    })
    .onConflictDoUpdate({
      target: indexStatus.chunkId,
      set: {
        vector: "ready",
        keyword: "ready",
        graph: graphState,
        updatedAt: new Date(),
      },
    });
}

/** 短事务：标记 outbox 事件失败（指数退避重试），失败本身不占用长事务 */
async function markOutboxFailedShort(
  tenantId: string,
  id: string,
  error: string,
): Promise<void> {
  await withTenantTx(tenantId, async (tx) => {
    await markOutboxFailed(tx, id, error);
  });
}

/** 派发待处理的 Outbox 事件（幂等，§7.1） */
async function dispatchOutbox(): Promise<number> {
  const tenantIds = (await db.select({ id: tenants.id }).from(tenants)).map(
    (t) => t.id,
  );
  let dispatched = 0;

  for (const tenantId of tenantIds) {
    // 短事务 1（只读）：拉取待处理事件 + 关联 chunk，事务立即结束、释放连接。
    // 之后的外部索引调用在事务外执行，避免长时间占用连接池（曾导致池耗尽卡死）。
    const { events, chunksByAgg } = await withTenantTx(tenantId, async (tx) => {
      const events = await tx
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.status, "pending"),
            sql`${outbox.availableAt} <= now()`,
          ),
        )
        .orderBy(outbox.createdAt)
        .limit(200);

      const chunksByAgg = new Map<string, ChunkRow>();
      for (const e of events) {
        if (e.eventType !== "chunk.upserted") continue;
        const [chunk] = await tx
          .select()
          .from(chunks)
          .where(eq(chunks.id, e.aggregateId))
          .limit(1);
        if (chunk) chunksByAgg.set(e.aggregateId, chunk);
      }
      return { events, chunksByAgg };
    });

    for (const e of events) {
      try {
        // 外部 I/O（embedding / 向量 / 关键词 / 图 / LLM）：不持有 DB 连接
        let graphState: string | null = null;
        if (e.eventType === "chunk.upserted") {
          const chunk = chunksByAgg.get(e.aggregateId);
          if (chunk) {
            graphState = await writeDerivedIndexes(tenantId, chunk);
          }
          // chunk 不存在（事件与删除竞争）：无索引可写，仅标记 done
        } else if (e.eventType === "chunk.removed") {
          await removeDerivedIndexes(tenantId, e.aggregateId);
        }

        // 短事务 2（写）：落 index_status + 标记事件 done，事务立即提交
        await withTenantTx(tenantId, async (tx) => {
          if (graphState) {
            await upsertIndexStatus(tx, tenantId, e.aggregateId, graphState);
          }
          await tx
            .update(outbox)
            .set({ status: "done" })
            .where(eq(outbox.id, e.id));
        });
        dispatched++;
      } catch (err) {
        await markOutboxFailedShort(
          tenantId,
          e.id,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  return dispatched;
}

/** 对账：index_status 未就绪的 chunk 重新投递；孤儿 index_status 清理 */
async function repairIndexStatus(): Promise<number> {
  const tenantIds = (await db.select({ id: tenants.id }).from(tenants)).map(
    (t) => t.id,
  );
  let repaired = 0;

  for (const tenantId of tenantIds) {
    // 短事务 1（只读）：查未就绪的 index_status + 对应 chunk，立即提交释放连接
    const rows = await withTenantTx(tenantId, async (tx) => {
      // §7.1 对账循环驱动信号：任何一路 != ready 都重新投递（含旧数据遗留的
      // graph=pending，Neo4j 引入前索引的 chunk 在此补建图索引）
      const notReady = await tx
        .select({ chunkId: indexStatus.chunkId })
        .from(indexStatus)
        .where(
          or(
            eq(indexStatus.vector, "failed"),
            eq(indexStatus.keyword, "failed"),
            eq(indexStatus.graph, "failed"),
            eq(indexStatus.graph, "pending"),
          ),
        )
        .limit(200);

      const rows: { chunkId: string; chunk?: ChunkRow }[] = [];
      for (const r of notReady) {
        const [chunk] = await tx
          .select()
          .from(chunks)
          .where(eq(chunks.id, r.chunkId))
          .limit(1);
        rows.push(chunk ? { chunkId: r.chunkId, chunk } : { chunkId: r.chunkId });
      }
      return rows;
    });

    for (const r of rows) {
      try {
        if (!r.chunk) {
          // 孤儿 index_status（chunk 已删）：直接清掉，无需外部调用
          await withTenantTx(tenantId, (tx) =>
            tx.delete(indexStatus).where(eq(indexStatus.chunkId, r.chunkId)),
          );
        } else {
          // 外部重写派生索引（不持 DB 连接）→ 短事务落 index_status
          const graphState = await writeDerivedIndexes(tenantId, r.chunk);
          await withTenantTx(tenantId, (tx) =>
            upsertIndexStatus(tx, tenantId, r.chunkId, graphState),
          );
          repaired++;
        }
      } catch (err) {
        console.warn(
          `[reconcile] index repair failed for chunk ${r.chunkId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  return repaired;
}

/** 恢复卡在 processing 超过阈值的 Job（Worker 崩溃兜底） */
async function recoverStuckJobs(): Promise<number> {
  const tenantIds = (await db.select({ id: tenants.id }).from(tenants)).map(
    (t) => t.id,
  );
  const threshold = new Date(Date.now() - 10 * 60 * 1000);
  let recovered = 0;

  for (const tenantId of tenantIds) {
    // 事务内受 RLS 约束，只会扫到本租户的 jobs
    const stuck = await withTenantTx(tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.status, "processing"),
            lt(jobs.updatedAt, threshold),
          ),
        )
        .limit(100);
      for (const j of rows) {
        await tx
          .update(jobs)
          .set({ status: "pending", updatedAt: new Date() })
          .where(eq(jobs.id, j.id));
      }
      return rows;
    });

    for (const j of stuck) {
      await enqueueJob(j.type as JobType, j.id, {
        tenantId,
        documentId: j.payload.documentId as string | undefined,
        versionId: j.payload.versionId as string | undefined,
      });
      recovered++;
    }
  }

  return recovered;
}

/** 检查社区是否需要重建：entity 数量与 community_member 数量不一致 */
async function checkCommunityRebuild(
  tx: Tx,
): Promise<boolean> {
  const entityRows = await tx.select({ id: entities.id }).from(entities);
  const memberRows = await tx
    .select({ id: communityMembers.id })
    .from(communityMembers);
  return entityRows.length !== memberRows.length;
}

/** 社区重建（Phase 7）：实体/关系变化后重新检测连通分量 + 生成摘要 */
async function rebuildCommunitiesIfNeeded(): Promise<number> {
  const tenantIds = (await db.select({ id: tenants.id }).from(tenants)).map(
    (t) => t.id,
  );
  let rebuilt = 0;
  for (const tenantId of tenantIds) {
    const needRebuild = await withTenantTx(tenantId, (tx) =>
      checkCommunityRebuild(tx),
    );
    if (!needRebuild) continue;
    try {
      const stats = await rebuildCommunities(tenantId);
      console.log(
        `[reconcile] communities rebuilt for tenant ${tenantId}: ${stats.communities} communities, ${stats.entities} entities`,
      );
      rebuilt += stats.communities;
    } catch (err) {
      console.warn(
        `[reconcile] community rebuild failed for tenant ${tenantId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return rebuilt;
}

export interface ReconcileStats {
  outboxDispatched: number;
  indexRepaired: number;
  jobsRecovered: number;
  communitiesRebuilt: number;
}

/**
 * 一次完整对账循环（§7.1 Outbox + Reconciliation）。
 *
 * 作为系统的"兜底机制"周期性运行（Worker 进程 setInterval + 队列中的
 * reconciliation Job），逐租户执行四个步骤，修复任何消费路径上的遗漏：
 *
 * 1. dispatchOutbox      把积压的 outbox 事件落成派生索引（向量/关键词/图），
 *                        保证"先写库、后投递"链路中断后事件不会丢
 * 2. repairIndexStatus   重投未就绪（failed/pending）的 chunk，清理孤儿记录，
 *                        含旧数据补建图索引的场景
 * 3. recoverStuckJobs    把卡在 processing 超时的 Job 重置为 pending 并重新入队，
 *                        覆盖 Worker 崩溃导致的"僵尸 Job"
 * 4. rebuildCommunitiesIfNeeded 实体/关系变化后按需重建社区（图图谱摘要）
 *
 * 每一步都按租户隔离遍历；任一步失败由调用方（setInterval / Worker）捕获记录，
 * 不影响下一次对账继续执行。
 */
let reconcileRunning = false;

export async function runReconcile(): Promise<ReconcileStats | null> {
  // 防重入：上一轮未结束时直接跳过（返回 null），避免 setInterval 周期
  // （默认 5s）小于单轮耗时导致多个对账并发，长事务叠加重合曾引发连接池耗尽
  if (reconcileRunning) return null;
  reconcileRunning = true;
  try {
    // 1. 派发 Outbox：幂等落派生索引（核心）
    const outboxDispatched = await dispatchOutbox();

    // 2. 修复 index_status：重试失败索引 + 清理孤儿状态
    const indexRepaired = await repairIndexStatus();

    // 3. 恢复卡死 Job：重置为 pending 并重新入队
    const jobsRecovered = await recoverStuckJobs();

    // 4. 按需重建社区（图阶段功能）
    const communitiesRebuilt = await rebuildCommunitiesIfNeeded();

    // 汇总统计，供调用方打日志/观测
    return { outboxDispatched, indexRepaired, jobsRecovered, communitiesRebuilt };
  } finally {
    reconcileRunning = false;
  }
}