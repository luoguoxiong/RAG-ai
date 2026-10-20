import { desc, eq } from "drizzle-orm";
import { config } from "../config.js";
import { withTenantTx } from "../db/index.js";
import {
  agentAssessments,
  type DimensionScores,
  type IssueSeverity,
  type IssueStage,
  type IssueStats,
  type WeakQuery,
} from "../db/schema/agent.js";
import {
  evalDatasets,
  evalRunResults,
  evalRuns,
  type EvalMetrics,
} from "../db/schema/eval.js";
import { runEvaluation } from "../evaluation/runner.js";
import { METRIC_LABELS } from "../evaluation/regression.js";
import { gradeOf, renderAssessmentReport } from "./report.js";

/**
 * 功能 3：评估集整体质量测评。
 *
 * 对整个评估集做一次完整评测（或复用历史 eval run），输出：
 * - 综合评分与质量等级（A 优秀 / B 良好 / C 待改进 / D 较差）
 * - 三维度质量评估：检索质量 / 上下文质量 / 生成质量
 * - 问题清单：样本级错误归因（错在哪一步）+ 薄弱查询排行
 *
 * 评分权重与达标线均为示例值，应结合业务目标调整；
 * 综合评分只用于横向比较与追踪趋势，发布决策仍以调优门禁为准。
 */

/** 综合评分权重（示例）：生成质量权重最高——检索与上下文最终服务于答案质量 */
const DIMENSION_WEIGHTS = {
  retrieval: 0.35,
  context: 0.25,
  generation: 0.4,
} as const;

/** 维度达标线（≥ 视为优势维度）与预警线（< 视为严重短板） */
const DIMENSION_GOOD = 0.75;
const DIMENSION_WARN = 0.6;

const DIMENSION_META: {
  key: keyof typeof DIMENSION_WEIGHTS;
  label: string;
  metrics: (keyof EvalMetrics)[];
}[] = [
  {
    key: "retrieval",
    label: "检索质量",
    metrics: ["recallAtK", "hitRate", "mrr", "ndcg"],
  },
  {
    key: "context",
    label: "上下文质量",
    metrics: ["contextPrecision", "contextRecall"],
  },
  {
    key: "generation",
    label: "生成质量",
    metrics: ["faithfulness", "answerRelevance"],
  },
];

/** 样本级问题判定规则（阈值来自 config.agent，均为示例值） */
interface MetricRule {
  metric: keyof EvalMetrics;
  threshold: number;
  stage: IssueStage;
  severity: IssueSeverity;
}

const QUERY_RULES: MetricRule[] = [
  {
    metric: "recallAtK",
    threshold: config.agent.minRecallAtK,
    stage: "RETRIEVAL_RECALL",
    severity: "high",
  },
  {
    metric: "ndcg",
    threshold: config.agent.minNdcg,
    stage: "RANKING",
    severity: "medium",
  },
  {
    metric: "faithfulness",
    threshold: config.agent.minFaithfulness,
    stage: "GENERATION_GROUNDING",
    severity: "high",
  },
  {
    metric: "answerRelevance",
    threshold: config.agent.minAnswerRelevance,
    stage: "GENERATION_RELEVANCE",
    severity: "medium",
  },
];

/** 多信号并存时的主问题优先级：检索 → 排序 → 生成 */
const STAGE_PRIORITY: IssueStage[] = [
  "RETRIEVAL_RECALL",
  "RANKING",
  "GENERATION_GROUNDING",
  "GENERATION_RELEVANCE",
];

function avgOf(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 维度得分：组成指标的均值；指标缺失时跳过，全缺返回 null */
function dimensionScore(
  metrics: Partial<EvalMetrics>,
  keys: (keyof EvalMetrics)[],
): number | null {
  const values = keys
    .map((k) => metrics[k])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return values.length > 0 ? Number(avgOf(values).toFixed(4)) : null;
}

/** 综合评分：维度加权；缺失维度的权重按剩余维度归一化 */
export function computeOverallScore(dims: DimensionScores): number | null {
  let weighted = 0;
  let weightSum = 0;
  for (const meta of DIMENSION_META) {
    const v = dims[meta.key];
    if (typeof v === "number" && Number.isFinite(v)) {
      weighted += v * DIMENSION_WEIGHTS[meta.key];
      weightSum += DIMENSION_WEIGHTS[meta.key];
    }
  }
  return weightSum > 0 ? Number((weighted / weightSum).toFixed(4)) : null;
}

/** 样本级归因：返回触发的全部规则（一条查询可命中多个问题信号） */
function classifyQueryIssues(
  metrics: Partial<EvalMetrics>,
): { triggered: MetricRule[]; primary: MetricRule | null } {
  const triggered = QUERY_RULES.filter((r) => {
    const v = metrics[r.metric];
    return typeof v === "number" && Number.isFinite(v) && v < r.threshold;
  });
  const primary =
    STAGE_PRIORITY.map((stage) =>
      triggered.find((r) => r.stage === stage),
    ).find((r): r is MetricRule => r !== undefined) ?? triggered[0] ?? null;
  return { triggered, primary };
}

/** 单条查询综合得分（与整体评分同一套维度权重，保证口径一致） */
function queryOverallScore(metrics: Partial<EvalMetrics>): number {
  const dims: DimensionScores = {
    retrieval: dimensionScore(metrics, DIMENSION_META[0]!.metrics),
    context: dimensionScore(metrics, DIMENSION_META[1]!.metrics),
    generation: dimensionScore(metrics, DIMENSION_META[2]!.metrics),
  };
  return computeOverallScore(dims) ?? 0;
}

export interface AssessmentOptions {
  /** 评估集 id（与 evalRunId 二选一；提供时执行一次全新的整体评测） */
  datasetId?: string;
  /** 复用历史评测运行（不重新消耗模型调用，适合对既有结果做质量分析） */
  evalRunId?: string;
  /** 全新评测时的检索 Top-K（默认 config.defaultTopK） */
  topK?: number;
}

export interface AssessmentSummary {
  assessmentId: string;
  status: "completed" | "failed";
  datasetId: string;
  datasetName: string;
  evalRunId: string;
  topK: number;
  queryCount: number;
  overallScore: number | null;
  grade: string | null;
  gradeLabel: string | null;
  dimensionScores: DimensionScores;
  metricScores: Partial<EvalMetrics>;
  problemStats: IssueStats;
  weakQueries: WeakQuery[];
  strengths: string;
  weaknesses: string;
  report: string;
}

/**
 * 运行一次评估集整体质量测评。
 * 同步执行（与 /eval/runs 风格一致）：全新评测会跑完整链路（检索→生成→打分）。
 */
export async function assessDataset(
  tenantId: string,
  opts: AssessmentOptions,
): Promise<AssessmentSummary> {
  if (!opts.datasetId && !opts.evalRunId) {
    throw new Error("datasetId 或 evalRunId 必须提供其一");
  }

  // 1) 解析评测来源：复用历史 run 或执行全新整体评测
  let datasetId: string;
  let evalRunId: string;
  let metrics: Partial<EvalMetrics>;
  let topK: number;
  let datasetName: string;

  if (opts.evalRunId) {
    const [runRow] = await withTenantTx(tenantId, (tx) =>
      tx.select().from(evalRuns).where(eq(evalRuns.id, opts.evalRunId!)).limit(1),
    );
    if (!runRow) throw new Error(`eval run not found: ${opts.evalRunId}`);
    if (runRow.status !== "ready") {
      throw new Error(`eval run ${opts.evalRunId} 未完成（status=${runRow.status}），无法复用`);
    }
    datasetId = runRow.datasetId;
    evalRunId = runRow.id;
    metrics = runRow.metrics;
    topK = runRow.topK;
    const [datasetRow] = await withTenantTx(tenantId, (tx) =>
      tx.select().from(evalDatasets).where(eq(evalDatasets.id, datasetId)).limit(1),
    );
    if (!datasetRow) throw new Error(`eval dataset not found: ${datasetId}`);
    datasetName = datasetRow.name;
  } else {
    const [datasetRow] = await withTenantTx(tenantId, (tx) =>
      tx.select().from(evalDatasets).where(eq(evalDatasets.id, opts.datasetId!)).limit(1),
    );
    if (!datasetRow) throw new Error(`eval dataset not found: ${opts.datasetId}`);
    datasetName = datasetRow.name;
    topK = opts.topK ?? config.defaultTopK;
    const result = await runEvaluation(tenantId, opts.datasetId!, { topK });
    if (result.status !== "ready") throw new Error("evaluation failed");
    datasetId = result.datasetId;
    evalRunId = result.runId;
    metrics = result.metrics;
  }

  // 2) 落测评任务行（评测可能较慢，此后才可被列表观察到）
  const [row] = await withTenantTx(tenantId, (tx) =>
    tx
      .insert(agentAssessments)
      .values({ tenantId, datasetId, evalRunId, topK, status: "running" })
      .returning(),
  );
  const assessmentId = row!.id;

  try {
    // 3) 样本级归因：逐查询分类问题阶段
    const results = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(evalRunResults)
        .where(eq(evalRunResults.runId, evalRunId)),
    );
    const problemStats: IssueStats = {};
    const weakQueries: WeakQuery[] = [];
    for (const r of results) {
      const { triggered, primary } = classifyQueryIssues(r.metrics);
      if (triggered.length === 0 || !primary) continue;
      for (const rule of triggered) {
        problemStats[rule.stage] = (problemStats[rule.stage] ?? 0) + 1;
      }
      const v = r.metrics[primary.metric];
      const worstValue = typeof v === "number" ? v : 0;
      weakQueries.push({
        query: r.query,
        stage: primary.stage,
        severity: primary.severity,
        worstMetric: METRIC_LABELS[primary.metric],
        worstValue,
        worstThreshold: primary.threshold,
        overall: queryOverallScore(r.metrics),
      });
    }
    weakQueries.sort((a, b) => a.overall - b.overall);

    // 4) 维度得分 + 综合评分 + 等级
    const dimensionScores: DimensionScores = {
      retrieval: dimensionScore(metrics, DIMENSION_META[0]!.metrics),
      context: dimensionScore(metrics, DIMENSION_META[1]!.metrics),
      generation: dimensionScore(metrics, DIMENSION_META[2]!.metrics),
    };
    const overallScore = computeOverallScore(dimensionScores);
    const gradeInfo = overallScore !== null ? gradeOf(overallScore) : null;

    // 5) 整体质量评估文案：优势与薄弱维度
    const fmt = (v: number | null): string =>
      v === null ? "无数据" : v.toFixed(3);
    const strongParts: string[] = [];
    const weakParts: string[] = [];
    for (const meta of DIMENSION_META) {
      const v = dimensionScores[meta.key];
      if (v === null) continue;
      if (v >= DIMENSION_GOOD) {
        strongParts.push(`${meta.label} ${fmt(v)}`);
      } else if (v < DIMENSION_WARN) {
        weakParts.push(`${meta.label} ${fmt(v)}（低于预警线 ${DIMENSION_WARN}，严重短板）`);
      } else {
        weakParts.push(`${meta.label} ${fmt(v)}（未达达标线 ${DIMENSION_GOOD}）`);
      }
    }
    const strengths =
      strongParts.length > 0 ? strongParts.join("；") : "各维度均未达达标线";
    const weaknesses =
      weakParts.length > 0 ? weakParts.join("；") : "各维度均达标";

    // 6) 渲染报告
    const report = renderAssessmentReport({
      assessmentId,
      datasetName,
      evalRunId,
      topK,
      queryCount: results.length,
      overallScore,
      grade: gradeInfo?.grade ?? "-",
      gradeLabel: gradeInfo?.label ?? "-",
      dimensions: DIMENSION_META.map((meta) => ({
        label: meta.label,
        metrics: meta.metrics,
        score: dimensionScores[meta.key],
      })),
      metrics,
      metricThresholds: {
        recallAtK: config.agent.minRecallAtK,
        ndcg: config.agent.minNdcg,
        faithfulness: config.agent.minFaithfulness,
        answerRelevance: config.agent.minAnswerRelevance,
      },
      problemStats,
      problemQueryCount: weakQueries.length,
      weakQueries,
      strengths,
      weaknesses,
    });

    await withTenantTx(tenantId, (tx) =>
      tx
        .update(agentAssessments)
        .set({
          status: "completed",
          queryCount: results.length,
          overallScore,
          grade: gradeInfo?.grade ?? null,
          dimensionScores,
          metricScores: metrics,
          problemStats,
          weakQueries: weakQueries.slice(0, 50),
          strengths,
          weaknesses,
          report,
          completedAt: new Date(),
        })
        .where(eq(agentAssessments.id, assessmentId)),
    );

    return {
      assessmentId,
      status: "completed",
      datasetId,
      datasetName,
      evalRunId,
      topK,
      queryCount: results.length,
      overallScore,
      grade: gradeInfo?.grade ?? null,
      gradeLabel: gradeInfo?.label ?? null,
      dimensionScores,
      metricScores: metrics,
      problemStats,
      weakQueries,
      strengths,
      weaknesses,
      report,
    };
  } catch (err) {
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(agentAssessments)
        .set({ status: "failed", error: (err as Error).message, completedAt: new Date() })
        .where(eq(agentAssessments.id, assessmentId)),
    ).catch(() => undefined);
    throw err;
  }
}

/** 最近一次测评（供 API 展示对照） */
export async function getLatestAssessment(
  tenantId: string,
  datasetId: string,
) {
  const [row] = await withTenantTx(tenantId, (tx) =>
    tx
      .select()
      .from(agentAssessments)
      .where(eq(agentAssessments.datasetId, datasetId))
      .orderBy(desc(agentAssessments.createdAt))
      .limit(1),
  );
  return row ?? null;
}
