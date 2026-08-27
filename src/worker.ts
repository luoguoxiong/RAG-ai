import { Worker } from "bullmq";
import { redis } from "./queue/index.js";
import { processVersion, deleteDocument } from "./application/ingestion.js";
import { runReconcile } from "./application/reconcile.js";
import { markJob } from "./application/job.js";
import { config } from "./config.js";
import type { JobType } from "./domain/index.js";

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

    if (type === "reconciliation") {
      const stats = await runReconcile();
      console.log("[reconcile]", stats);
      return;
    }

    const tenantId = data.tenantId;
    await markJob(tenantId, jobId, "processing");

    try {
      switch (type) {
        case "index_document":
        case "reindex_document": {
          if (!data.versionId) throw new Error("versionId missing");
          await processVersion(data.versionId, tenantId);
          break;
        }
        case "delete_document": {
          if (!data.documentId) throw new Error("documentId missing");
          await deleteDocument(data.documentId, tenantId);
          break;
        }
        default:
          throw new Error(`unknown job type: ${type}`);
      }
      await markJob(tenantId, jobId, "ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markJob(tenantId, jobId, "failed", msg);
      throw err;
    }
  },
  { connection: redis, concurrency: 4 },
);

worker.on("completed", (job) => {
  console.log(`[worker] completed ${job.name} ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] failed ${job?.name} ${job?.id}: ${err.message}`);
});

// Reconciliation 对账循环：定时派发 Outbox、修复 index_status、恢复卡死 Job
setInterval(() => {
  runReconcile().catch((err) => {
    console.error("[reconcile] error:", err);
  });
}, config.reconcileIntervalMs);

console.log("[worker] started");