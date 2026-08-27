import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { withTenantTx } from "../db/index.js";
import {
  evalDatasets,
  evalQueries,
  evalRunResults,
  evalRuns,
} from "../db/schema/eval.js";
import { runEvaluation } from "../evaluation/runner.js";

function tenantOf(headers: Record<string, unknown>): string {
  const t = headers["x-tenant-id"];
  if (typeof t !== "string" || t.length === 0) {
    throw new Error("missing x-tenant-id header");
  }
  return t;
}

interface EvalQueryInput {
  query: string;
  goldChunkIds?: string[];
  referenceAnswer?: string;
  keyFacts?: string[];
}

interface CreateDatasetBody {
  name?: string;
  description?: string;
  indexVersion?: string;
  embeddingVersion?: string;
  queries?: EvalQueryInput[];
}

/**
 * Evaluation API（§22）：数据集管理 + 运行评估 + 回归报告。
 * 与 /search 共用 x-tenant-id 租户隔离。
 */
export async function evalRoutes(app: FastifyInstance): Promise<void> {
  // 创建 Eval Dataset（含 ground truth 查询集）
  app.post<{ Body: CreateDatasetBody }>("/eval/datasets", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const body = req.body ?? {};
    if (
      typeof body.name !== "string" ||
      !body.name ||
      !Array.isArray(body.queries) ||
      body.queries.length === 0
    ) {
      return reply
        .code(400)
        .send({ error: "name and non-empty queries are required" });
    }
    return withTenantTx(tenantId, async (tx) => {
      const [dataset] = await tx
        .insert(evalDatasets)
        .values({
          tenantId,
          name: body.name!,
          description: body.description,
          indexVersion: body.indexVersion ?? "1",
          embeddingVersion: body.embeddingVersion ?? "1",
        })
        .returning();
      const queries = await tx
        .insert(evalQueries)
        .values(
          body.queries!.map((q) => ({
            tenantId,
            datasetId: dataset!.id,
            query: q.query,
            goldChunkIds: q.goldChunkIds ?? [],
            referenceAnswer: q.referenceAnswer,
            keyFacts: q.keyFacts ?? [],
          })),
        )
        .returning();
      return { dataset: dataset!, queries };
    });
  });

  // 列出 Eval Dataset
  app.get("/eval/datasets", async (req) => {
    const tenantId = tenantOf(req.headers);
    return withTenantTx(tenantId, (tx) =>
      tx.select().from(evalDatasets).orderBy(desc(evalDatasets.createdAt)),
    );
  });

  // 运行评估（同步执行：Retrieve → Generate → 打分 → 报告）
  app.post<{ Body: { datasetId?: string; topK?: number } }>(
    "/eval/runs",
    async (req, reply) => {
      const tenantId = tenantOf(req.headers);
      const datasetId =
        typeof req.body?.datasetId === "string" ? req.body.datasetId : "";
      if (!datasetId) {
        return reply.code(400).send({ error: "datasetId is required" });
      }
      const topK =
        typeof req.body?.topK === "number" && req.body.topK > 0
          ? req.body.topK
          : undefined;
      return runEvaluation(tenantId, datasetId, { topK });
    },
  );

  // 列出运行记录
  app.get("/eval/runs", async (req) => {
    const tenantId = tenantOf(req.headers);
    return withTenantTx(tenantId, (tx) =>
      tx.select().from(evalRuns).orderBy(desc(evalRuns.createdAt)),
    );
  });

  // 运行详情（含逐查询结果）
  app.get<{ Params: { id: string } }>("/eval/runs/:id", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const [run] = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(evalRuns)
        .where(eq(evalRuns.id, req.params.id))
        .limit(1),
    );
    if (!run) return reply.code(404).send({ error: "run not found" });
    const results = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(evalRunResults)
        .where(eq(evalRunResults.runId, run.id))
        .orderBy(evalRunResults.createdAt),
    );
    return { run, results };
  });

  // 回归报告（Markdown）
  app.get<{ Params: { id: string } }>(
    "/eval/runs/:id/report",
    async (req, reply) => {
      const tenantId = tenantOf(req.headers);
      const [run] = await withTenantTx(tenantId, (tx) =>
        tx
          .select()
          .from(evalRuns)
          .where(eq(evalRuns.id, req.params.id))
          .limit(1),
      );
      if (!run) return reply.code(404).send({ error: "run not found" });
      return reply.type("text/markdown").send(run.report ?? "(report not ready)");
    },
  );
}
