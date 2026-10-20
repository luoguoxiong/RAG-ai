/**
 * RAG 自优化与问题分析 Agent 路由族。
 *
 * 功能 1（Badcase 错误分析）：
 * - POST /agent/diagnosis           运行一次线上 Badcase 分阶段错误分析，返回汇总 + 分析报告
 * - GET  /agent/diagnosis           诊断任务列表
 * - GET  /agent/diagnosis/:id       任务详情 + 样本级结论（错在哪一步）
 * - GET  /agent/diagnosis/:id/report 分析报告（markdown）
 *
 * 功能 2（参数自动调优）：
 * - POST /agent/tuning              运行一轮自动调优：线上数据 → 实验计划 → 离线评测 → 门禁 → 前后对比
 * - GET  /agent/tuning              调优任务列表
 * - GET  /agent/tuning/:id          任务详情 + 实验记录与对比
 * - GET  /agent/tuning/:id/report   调优报告（markdown，含优化方案与前后数据对比）
 *
 * 功能 3（评估集整体质量测评）：
 * - POST /agent/assessment          整体测评：完整评测集 → 综合评分 + 分维度质量评估 + 问题清单
 * - GET  /agent/assessment          测评任务列表
 * - GET  /agent/assessment/:id      测评详情（维度得分 / 薄弱查询 / 问题分布）
 * - GET  /agent/assessment/:id/report 测评报告（markdown）
 *
 * 所有路由均要求 x-tenant-id 请求头做租户隔离（§24.1）。
 * 分析/调优/测评为同步执行（与 /eval/runs 风格一致），预算由 config.agent 控制。
 */
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { withTenantTx } from "../db/index.js";
import {
  agentAssessments,
  agentDiagnoses,
  agentDiagnosisCases,
  agentExperiments,
  agentTuningRuns,
} from "../db/schema/agent.js";
import { runBadcaseDiagnosis } from "../agent/diagnosis.js";
import { runAutoTuning } from "../agent/optimizer.js";
import { assessDataset } from "../agent/assessment.js";

/** 从请求头读取租户 ID，缺失或为空直接抛错拒绝 */
function tenantOf(headers: Record<string, unknown>): string {
  const t = headers["x-tenant-id"];
  if (typeof t !== "string" || t.length === 0) {
    throw new Error("missing x-tenant-id header");
  }
  return t;
}

interface DiagnosisBody {
  /** 回看窗口（天），默认取 config.agent.diagnosisSinceDays */
  sinceDays?: number;
  /** 最大分析样本数，默认取 config.agent.diagnosisSampleLimit */
  limit?: number;
  /** 关闭 LLM 复核（默认开启，未配置 API Key 时自动跳过） */
  useLLM?: boolean;
}

interface TuningBody {
  /** 固定评测集 id（必填：调优结论基于该评测集的离线评测） */
  datasetId?: string;
  sinceDays?: number;
  maxExperiments?: number;
  primaryMetric?: string;
  useLLMPlan?: boolean;
}

interface AssessmentBody {
  /** 评估集 id（与 evalRunId 二选一；提供时执行一次全新整体评测） */
  datasetId?: string;
  /** 复用历史评测运行（不重新消耗模型调用） */
  evalRunId?: string;
  /** 全新评测时的检索 Top-K */
  topK?: number;
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // ---------- 功能 1：Badcase 错误分析 ----------
  app.post<{ Body: DiagnosisBody }>("/agent/diagnosis", async (req) => {
    const tenantId = tenantOf(req.headers);
    const b = req.body ?? {};
    return runBadcaseDiagnosis(tenantId, {
      sinceDays:
        typeof b.sinceDays === "number" && b.sinceDays > 0
          ? b.sinceDays
          : undefined,
      limit:
        typeof b.limit === "number" && b.limit > 0 ? b.limit : undefined,
      useLLM: typeof b.useLLM === "boolean" ? b.useLLM : undefined,
    });
  });

  app.get("/agent/diagnosis", async (req) => {
    const tenantId = tenantOf(req.headers);
    return withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(agentDiagnoses)
        .orderBy(desc(agentDiagnoses.createdAt))
        .limit(50),
    );
  });

  app.get<{ Params: { id: string } }>("/agent/diagnosis/:id", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const [row] = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(agentDiagnoses)
        .where(eq(agentDiagnoses.id, req.params.id))
        .limit(1),
    );
    if (!row) return reply.code(404).send({ error: "diagnosis not found" });
    const cases = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(agentDiagnosisCases)
        .where(eq(agentDiagnosisCases.diagnosisId, req.params.id)),
    );
    return { diagnosis: row, cases };
  });

  app.get<{ Params: { id: string } }>(
    "/agent/diagnosis/:id/report",
    async (req, reply) => {
      const tenantId = tenantOf(req.headers);
      const [row] = await withTenantTx(tenantId, (tx) =>
        tx
          .select({ report: agentDiagnoses.report })
          .from(agentDiagnoses)
          .where(eq(agentDiagnoses.id, req.params.id))
          .limit(1),
      );
      if (!row) return reply.code(404).send({ error: "diagnosis not found" });
      reply.type("text/markdown");
      return row.report ?? "";
    },
  );

  // ---------- 功能 2：参数自动调优 ----------
  app.post<{ Body: TuningBody }>("/agent/tuning", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const b = req.body ?? {};
    if (typeof b.datasetId !== "string" || b.datasetId.length === 0) {
      return reply.code(400).send({ error: "datasetId is required（调优基于固定评测集离线评测）" });
    }
    return runAutoTuning(tenantId, {
      datasetId: b.datasetId,
      sinceDays:
        typeof b.sinceDays === "number" && b.sinceDays > 0
          ? b.sinceDays
          : undefined,
      maxExperiments:
        typeof b.maxExperiments === "number" && b.maxExperiments > 0
          ? b.maxExperiments
          : undefined,
      primaryMetric: b.primaryMetric,
      useLLMPlan: typeof b.useLLMPlan === "boolean" ? b.useLLMPlan : undefined,
    });
  });

  app.get("/agent/tuning", async (req) => {
    const tenantId = tenantOf(req.headers);
    return withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(agentTuningRuns)
        .orderBy(desc(agentTuningRuns.createdAt))
        .limit(50),
    );
  });

  app.get<{ Params: { id: string } }>("/agent/tuning/:id", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const [row] = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(agentTuningRuns)
        .where(eq(agentTuningRuns.id, req.params.id))
        .limit(1),
    );
    if (!row) return reply.code(404).send({ error: "tuning run not found" });
    const experiments = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(agentExperiments)
        .where(eq(agentExperiments.tuningRunId, req.params.id)),
    );
    return { tuningRun: row, experiments };
  });

  app.get<{ Params: { id: string } }>(
    "/agent/tuning/:id/report",
    async (req, reply) => {
      const tenantId = tenantOf(req.headers);
      const [row] = await withTenantTx(tenantId, (tx) =>
        tx
          .select({ report: agentTuningRuns.report })
          .from(agentTuningRuns)
          .where(eq(agentTuningRuns.id, req.params.id))
          .limit(1),
      );
      if (!row) return reply.code(404).send({ error: "tuning run not found" });
      reply.type("text/markdown");
      return row.report ?? "";
    },
  );

  // ---------- 功能 3：评估集整体质量测评 ----------
  app.post<{ Body: AssessmentBody }>("/agent/assessment", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const b = req.body ?? {};
    if (
      (typeof b.datasetId !== "string" || b.datasetId.length === 0) &&
      (typeof b.evalRunId !== "string" || b.evalRunId.length === 0)
    ) {
      return reply.code(400).send({
        error: "datasetId 或 evalRunId 必须提供其一",
      });
    }
    return assessDataset(tenantId, {
      datasetId:
        typeof b.datasetId === "string" && b.datasetId.length > 0
          ? b.datasetId
          : undefined,
      evalRunId:
        typeof b.evalRunId === "string" && b.evalRunId.length > 0
          ? b.evalRunId
          : undefined,
      topK: typeof b.topK === "number" && b.topK > 0 ? b.topK : undefined,
    });
  });

  app.get("/agent/assessment", async (req) => {
    const tenantId = tenantOf(req.headers);
    return withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(agentAssessments)
        .orderBy(desc(agentAssessments.createdAt))
        .limit(50),
    );
  });

  app.get<{ Params: { id: string } }>(
    "/agent/assessment/:id",
    async (req, reply) => {
      const tenantId = tenantOf(req.headers);
      const [row] = await withTenantTx(tenantId, (tx) =>
        tx
          .select()
          .from(agentAssessments)
          .where(eq(agentAssessments.id, req.params.id))
          .limit(1),
      );
      if (!row) return reply.code(404).send({ error: "assessment not found" });
      return row;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/agent/assessment/:id/report",
    async (req, reply) => {
      const tenantId = tenantOf(req.headers);
      const [row] = await withTenantTx(tenantId, (tx) =>
        tx
          .select({ report: agentAssessments.report })
          .from(agentAssessments)
          .where(eq(agentAssessments.id, req.params.id))
          .limit(1),
      );
      if (!row) return reply.code(404).send({ error: "assessment not found" });
      reply.type("text/markdown");
      return row.report ?? "";
    },
  );
}
