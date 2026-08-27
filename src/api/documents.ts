import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { db, withTenantTx } from "../db/index.js";
import { documents } from "../db/schema/document.js";
import { jobs } from "../db/schema/job.js";
import { ingestDocument } from "../application/ingestion.js";
import { createJob } from "../application/job.js";
import { enqueueJob } from "../queue/index.js";

function tenantOf(headers: Record<string, unknown>): string {
  const t = headers["x-tenant-id"];
  if (typeof t !== "string" || t.length === 0) {
    throw new Error("missing x-tenant-id header");
  }
  return t;
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  // 上传文档：解析 → 建 Document/Version/Job → 入队，返回 202
  app.post("/documents", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const data = await req.file();
    if (!data) {
      return reply.code(400).send({ error: "file field is required" });
    }
    const content = await data.toBuffer();
    const result = await ingestDocument(tenantId, {
      fileName: data.filename,
      mimeType: data.mimetype,
      content,
    });
    await enqueueJob("index_document", result.jobId, {
      tenantId,
      documentId: result.documentId,
      versionId: result.versionId,
    });
    return reply.code(202).send(result);
  });

  // 列出文档
  app.get("/documents", async (req) => {
    const tenantId = tenantOf(req.headers);
    return withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(documents)
        .orderBy(desc(documents.createdAt)),
    );
  });

  // 文档状态
  app.get<{ Params: { id: string } }>("/documents/:id", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const doc = await withTenantTx(tenantId, (tx) =>
      tx.select().from(documents).where(eq(documents.id, req.params.id)).limit(1),
    );
    if (!doc[0]) return reply.code(404).send({ error: "not found" });
    const jobsList = await withTenantTx(tenantId, (tx) =>
      tx.select().from(jobs).where(eq(jobs.tenantId, tenantId)),
    );
    return { document: doc[0], jobs: jobsList };
  });

  // 删除文档：建 delete_document Job 并入队
  app.delete<{ Params: { id: string } }>(
    "/documents/:id",
    async (req, reply) => {
      const tenantId = tenantOf(req.headers);
      const jobId = await createJob(tenantId, "delete_document", {
        documentId: req.params.id,
      });
      await enqueueJob("delete_document", jobId, {
        tenantId,
        documentId: req.params.id,
      });
      return reply.code(202).send({ accepted: true, jobId });
    },
  );
}

// 供诊断使用
export { db };