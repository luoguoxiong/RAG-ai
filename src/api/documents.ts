import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { db, withTenantTx } from "../db/index.js";
import { documents } from "../db/schema/document.js";
import { jobs } from "../db/schema/job.js";
import { ingestDocument } from "../application/ingestion.js";
import { resolveVersionDocumentIds } from "../application/version.js";
import { createJob } from "../application/job.js";
import { enqueueJob } from "../queue/index.js";

/**
 * 从请求头中取出租户 ID。
 * 所有文档操作都要求调用方携带 `x-tenant-id` 请求头，用于多租户隔离。
 * 缺失或为空时直接抛错（Fastify 会将其转为 500，业务上要求调用方必须传）。
 */
function tenantOf(headers: Record<string, unknown>): string {
  const t = headers["x-tenant-id"];
  if (typeof t !== "string" || t.length === 0) {
    throw new Error("missing x-tenant-id header");
  }
  return t;
}

/**
 * 文档相关的 HTTP 路由注册入口。
 *
 * 整体流程（写操作走异步队列，读操作直查数据库）：
 * - POST /documents       上传 → 落库 → 入队异步索引，立即返回 202
 * - GET  /documents       列表
 * - GET  /documents/:id   单个文档 + 关联 Job 状态
 * - DELETE /documents/:id 建删除 Job 入队，异步清理
 *
 * 所有查询都通过 withTenantTx 包裹，保证 tenantId 隔离。
 */
export async function documentRoutes(app: FastifyInstance): Promise<void> {
  // ── 上传文档 ──────────────────────────────────────────────
  // 链路：multipart 文件 → ingestDocument（解析→归一化→落 Document/Version/Job）
  //       → enqueueJob 投递到 BullMQ 队列 → Worker 异步执行真正索引，立即返回 202。
  // 采用"先落库再入队"而非同步索引，是为了让 API 快速响应、失败可重试（Outbox 兜底）。
  app.post("/documents", async (req, reply) => {
    // 1. 校验并解析租户
    const tenantId = tenantOf(req.headers);

    // 2. 读取 multipart 文件（字段名固定为 file），非文件请求返回 400
    const data = await req.file();
    if (!data) {
      return reply.code(400).send({ error: "file field is required" });
    }

    // 3. 读取归属版本（multipart 字段 versionId），必填：
    //    文档独占归属某个数据集版本，且版本不可删改
    const raw = data.fields.versionId as
      | { value?: unknown }
      | Array<{ value?: unknown }>
      | undefined;
    const rawValue = Array.isArray(raw) ? raw[0]?.value : raw?.value;
    const versionId =
      typeof rawValue === "string" && rawValue.length > 0 ? rawValue : undefined;
    if (!versionId) {
      return reply.code(400).send({ error: "versionId field is required" });
    }
    try {
      await resolveVersionDocumentIds(tenantId, versionId);
    } catch {
      return reply.code(400).send({ error: `dataset version not found: ${versionId}` });
    }

    // 4. 将上传流完整读入内存（大文件场景可优化为流式落盘，这里保持简单）
    const content = await data.toBuffer();

    // 5. 调用应用层入口：解析文件内容 → 归一化 → 事务内写入
    //    documents / document_versions / jobs 三张表，返回三者的 id
    const result = await ingestDocument(tenantId, {
      versionId,
      fileName: data.filename,
      mimeType: data.mimetype,
      content,
    });

    // 6. 把"索引该版本"的任务投递到 Redis 队列（index_document），
    //    Worker 收到后会创建 DocumentVersion + chunks 并触发派生索引。
    await enqueueJob("index_document", result.jobId, {
      tenantId,
      documentId: result.documentId,
      versionId: result.versionId,
    });

    // 7. 202 Accepted：任务已受理，真正的索引进度通过 GET /documents/:id 查询
    return reply.code(202).send(result);
  });

  // ── 文档列表：按创建时间倒序返回当前租户的全部文档 ──────────
  app.get("/documents", async (req) => {
    const tenantId = tenantOf(req.headers);
    return withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(documents)
        .orderBy(desc(documents.createdAt)),
    );
  });

  // ── 文档详情 + 关联任务状态 ────────────────────────────────
  // 用于前端轮询：上传后拿着 documentId 到这里看 Job 是否跑完/失败。
  app.get<{ Params: { id: string } }>("/documents/:id", async (req, reply) => {
    const tenantId = tenantOf(req.headers);

    // 1. 按主键查文档，不存在返回 404
    const doc = await withTenantTx(tenantId, (tx) =>
      tx.select().from(documents).where(eq(documents.id, req.params.id)).limit(1),
    );
    if (!doc[0]) return reply.code(404).send({ error: "not found" });

    // 2. 一并返回该租户的所有 Job（含 status / error，便于观察处理进度）
    const jobsList = await withTenantTx(tenantId, (tx) =>
      tx.select().from(jobs).where(eq(jobs.tenantId, tenantId)),
    );
    return { document: doc[0], jobs: jobsList };
  });

  // ── 删除文档：异步清理 ────────────────────────────────────
  // 与上传相同采用异步模式：先建 delete_document Job 并落库（保证可追溯/可重试），
  // 再投递到队列，由 Worker 负责删除文档及其版本、分块、派生索引，立即返回 202。
  app.delete<{ Params: { id: string } }>(
    "/documents/:id",
    async (req, reply) => {
      const tenantId = tenantOf(req.headers);

      // 1. 事务内写入一条 pending 状态的 delete_document Job，拿到 jobId
      const jobId = await createJob(tenantId, "delete_document", {
        documentId: req.params.id,
      });

      // 2. 入队，Worker 消费后执行真实删除
      await enqueueJob("delete_document", jobId, {
        tenantId,
        documentId: req.params.id,
      });

      // 3. 202 受理确认
      return reply.code(202).send({ accepted: true, jobId });
    },
  );
}

// 供诊断使用（暴露底层 db，便于调试时直接查询）
export { db };