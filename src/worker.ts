/**
 * 后台 Worker 进程：消费 rag-index 队列中的 Job，执行真正的文档处理。
 *
 * 与 API 进程解耦独立运行：API 只负责受理（落库 + 入队）并立即返回 202，
 * 这里异步完成 解析分块 / 派生索引 / 文档删除 等重活。
 *
 * 队列中会出现两类任务：
 * - 业务 Job（index_document / reindex_document / delete_document）：更新 DB 中的 Job 状态
 * - 系统 Job（reconciliation）：对账，不关联具体 Job，不写 Job 状态
 */
import { Worker } from "bullmq";
import { redis } from "./queue/index.js";
import { processVersion, deleteDocument } from "./application/ingestion.js";
import { runReconcile } from "./application/reconcile.js";
import { markJob } from "./application/job.js";
import { config } from "./config.js";
import type { JobType } from "./domain/index.js";

/** 入队时携带的任务载荷：租户 + 业务实体的 id */
interface JobData {
  tenantId: string;
  documentId?: string;
  versionId?: string;
}

const worker = new Worker<JobData>(
  "rag-index",
  async (job) => {
    const type = job.name as JobType;
    const data = job.data;
    const jobId = job.id as string;

    // ── 系统对账任务：不落 Job 状态，直接跑一轮 reconcile 即返回 ──
    if (type === "reconciliation") {
      const stats = await runReconcile();
      console.log("[reconcile]", stats);
      return;
    }

    // 业务任务：先置为 processing，失败/成功统一在下面收尾
    const tenantId = data.tenantId;
    await markJob(tenantId, jobId, "processing");

    try {
      // ── 按 Job 类型分发到对应的应用层处理函数 ──
      switch (type) {
        // 索引（首次 / 重建）：以 versionId 为粒度做分块 + 幂等落库 + 派生索引事件
        case "index_document":
        case "reindex_document": {
          if (!data.versionId) throw new Error("versionId missing");
          await processVersion(data.versionId, tenantId);
          break;
        }
        // 删除：清理分块、版本、派生索引
        case "delete_document": {
          if (!data.documentId) throw new Error("documentId missing");
          await deleteDocument(data.documentId, tenantId);
          break;
        }
        default:
          throw new Error(`unknown job type: ${type}`);
      }
      // 处理成功 → Job 标记 ready
      await markJob(tenantId, jobId, "ready");
    } catch (err) {
      // 处理失败 → Job 标记 failed 并记录错误信息；
      // 重新抛错让 BullMQ 按重试策略再次派发（可重试的语义由 DB 的 Job 状态兜底）
      const msg = err instanceof Error ? err.message : String(err);
      await markJob(tenantId, jobId, "failed", msg);
      throw err;
    }
  },
  // concurrency=4：单进程并发处理 4 个 Job，连接复用同一个 Redis
  { connection: redis, concurrency: 4 },
);

// 成功回调：仅打日志，真正状态已在处理函数内写库
worker.on("completed", (job) => {
  console.log(`[worker] completed ${job.name} ${job.id}`);
});

// 失败回调：记录最终失败（处理函数已把 DB Job 标记 failed，这里做观测/告警）
worker.on("failed", (job, err) => {
  console.error(`[worker] failed ${job?.name} ${job?.id}: ${err.message}`);
});

// Reconciliation 对账循环：定时派发 Outbox、修复 index_status、恢复卡死 Job。
// 不依赖队列触发，周期性兜底，保证任何一次消费失败最终都能被修复。
setInterval(() => {
  runReconcile().catch((err) => {
    console.error("[reconcile] error:", err);
  });
}, config.reconcileIntervalMs);

console.log("[worker] started");