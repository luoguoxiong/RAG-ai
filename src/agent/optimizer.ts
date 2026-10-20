import { eq } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.js";
import { withTenantTx } from "../db/index.js";
import { retrievalLogs } from "../db/schema/retrieval-log.js";
import {
  agentExperiments,
  agentTuningRuns,
  type IssueStage,
  type IssueStats,
  type RagTuningConfig,
} from "../db/schema/agent.js";
import { evalDatasets, type EvalMetrics } from "../db/schema/eval.js";
import { runEvaluation } from "../evaluation/runner.js";
import { checkRegression } from "../evaluation/regression.js";
import { EVAL_METRIC_KEYS } from "../evaluation/metrics.js";
import {
  clampConfig,
  computeUtility,
  configKey,
  diffConfig,
  generateCandidates,
  resolveBaselineConfig,
  type CandidatePlan,
} from "./config-space.js";
import { chatJson, hasLLM } from "./structured-llm.js";
import { STAGE_LABELS, renderTuningReport } from "./report.js";
import { ruleDiagnose } from "./diagnosis.js";

/**
 * 功能 2：RAG 参数自动调优（设计方案 §6/§7/§8）。
 *
 * 闭环：线上数据统计 → 规则诊断聚焦问题阶段 → 基线离线评测 →
 * 生成实验计划（LLM 提案 + 规则兜底，服务端钳制参数空间）→
 * 逐候选离线评测 → 硬约束门禁（无指标显著回退）→
 * 效用函数排序选优 → 输出优化方案与优化前后对比报告。
 *
 * 状态机（每步持久化，可恢复可追踪）：
 * diagnosing → planning → experimenting → comparing → completed / failed
 */

export interface TuningOptions {
  /** 固定评测集（可复现性的前提：评测集版本、模型版本在单轮任务内固定） */
  datasetId: string;
  /** 线上数据回看窗口（天） */
  sinceDays?: number;
  /** 实验预算（最多候选数） */
  maxExperiments?: number;
  /** 主优化指标（默认 recallAtK） */
  primaryMetric?: string;
  /** 是否允许 LLM 生成实验计划（默认允许，失败自动回退规则生成） */
  useLLMPlan?: boolean;
}

export interface TuningSummary {
  tuningRunId: string;
  status: "completed" | "failed";
  datasetId: string;
  hypothesis: string;
  totalExperiments: number;
  gatePassedCount: number;
  baseline: {
    config: RagTuningConfig;
    metrics: Partial<EvalMetrics>;
    utility: number;
    evalRunId: string | null;
  } | null;
  best: {
    config: RagTuningConfig;
    metrics: Partial<EvalMetrics>;
    utility: number;
    evalRunId: string | null;
  } | null;
  deltas: Partial<Record<keyof EvalMetrics, number>>;
  report: string;
}

/** LLM 实验计划 Schema（提案仅含变更字段，服务端钳制到合法空间） */
const planSchema = z.object({
  hypothesis: z.string(),
  experiments: z
    .array(
      z.object({
        name: z.string(),
        changes: z.record(z.unknown()),
        reason: z.string().default(""),
        expectedEffect: z.string().default(""),
      }),
    )
    .max(8),
});

/** 状态机推进（每步落库） */
async function setStatus(
  tenantId: string,
  runId: string,
  status: string,
): Promise<void> {
  await withTenantTx(tenantId, (tx) =>
    tx.update(agentTuningRuns).set({ status }).where(eq(agentTuningRuns.id, runId)),
  );
}

interface OnlineStats {
  sampleCount: number;
  issueStats: IssueStats;
  focusStages: IssueStage[];
  avgTopScore: number | null;
  avgRetrievalMs: number | null;
  avgGenerationMs: number | null;
}

/** 线上数据统计：复用诊断规则给近期检索日志做阶段标注，得到问题分布 */
async function collectOnlineStats(
  tenantId: string,
  sinceDays: number,
): Promise<OnlineStats> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const logs = await withTenantTx(tenantId, (tx) =>
    tx
      .select()
      .from(retrievalLogs)
      .where(eq(retrievalLogs.tenantId, tenantId))
      .orderBy(retrievalLogs.createdAt)
      .limit(2000),
  ).then((rows) => rows.filter((r) => r.createdAt >= since).slice(-500));

  const issueStats: IssueStats = {};
  for (const log of logs) {
    const { stage } = ruleDiagnose(log);
    issueStats[stage] = (issueStats[stage] ?? 0) + 1;
  }
  const focusStages = (Object.entries(issueStats) as [IssueStage, number][])
    .filter(([stage]) => stage !== "NO_CLEAR_ISSUE")
    .sort((a, b) => b[1] - a[1])
    .map(([stage]) => stage);

  const nums = (xs: (number | null | undefined)[]) =>
    xs.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const avg = (xs: number[]) =>
    xs.length === 0 ? null : Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4));

  return {
    sampleCount: logs.length,
    issueStats,
    focusStages,
    avgTopScore: avg(nums(logs.map((l) => l.topScore))),
    avgRetrievalMs: avg(nums(logs.map((l) => l.retrievalMs))),
    avgGenerationMs: avg(nums(logs.map((l) => l.generationMs))),
  };
}

function describeStats(stats: OnlineStats): string {
  const dist = (Object.entries(stats.issueStats) as [IssueStage, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([s, c]) => `${STAGE_LABELS[s]}:${c}`)
    .join("，");
  return [
    `样本 ${stats.sampleCount} 条（问题分布：${dist || "无明确问题"}）`,
    stats.avgTopScore !== null ? `平均 Top 证据得分 ${stats.avgTopScore}` : "",
    stats.avgRetrievalMs !== null ? `平均检索耗时 ${stats.avgRetrievalMs}ms` : "",
    stats.avgGenerationMs !== null ? `平均生成耗时 ${stats.avgGenerationMs}ms` : "",
  ]
    .filter(Boolean)
    .join("；");
}

function buildRuleHypothesis(
  stats: OnlineStats,
  primaryMetric: string,
): string {
  if (stats.focusStages.length === 0) {
    return `近 ${config.agent.diagnosisSinceDays} 天线上信号未发现明确问题，做中性参数探索验证主指标 ${primaryMetric} 是否有提升空间。`;
  }
  const top = stats.focusStages
    .slice(0, 3)
    .map((s) => STAGE_LABELS[s])
    .join("、");
  return `线上主要问题为 ${top}，假设通过针对性参数调整可改善主指标 ${primaryMetric}，且不引起其他指标显著回退。`;
}

/**
 * LLM 实验计划（设计方案 §6.2 输出示例）：
 * LLM 只提出假设与候选变更；所有 changes 经 clampConfig 钳制，
 * 与基线相同或重复的候选剔除，数量截断到预算。
 */
async function planWithLLM(
  baseline: RagTuningConfig,
  stats: OnlineStats,
  maxExperiments: number,
): Promise<{ hypothesis: string; candidates: CandidatePlan[] } | null> {
  if (!hasLLM()) return null;
  try {
    const plan = await chatJson(
      planSchema,
      [
        {
          role: "system",
          content:
            "你是 RAG 检索链路调优专家。基于线上问题分布提出参数实验计划。只输出一个 JSON 对象，不要输出其他内容。",
        },
        {
          role: "user",
          content: [
            `【当前基线配置】${JSON.stringify(baseline)}`,
            `【可调参数及范围】topK: 1-20 整数；useReranker: 布尔；intelligence: 布尔（Query Intelligence 改写/多查询/HyDE）；multiQueryCount: 1-5 整数`,
            `【线上数据】${describeStats(stats)}`,
            `【硬约束】候选相对基线任何评估指标回退超过 ${(config.evalBaselineTolerance * 100).toFixed(0)}% 即判失败；参数复杂度（成本代理）更高的候选必须有足够的质量提升才可能胜出。切片策略与 Embedding 模型不可调整（会触发重建索引）。`,
            `【要求】最多 ${maxExperiments} 个实验；每个实验相对基线只改 1-2 个参数，便于归因；changes 只包含要修改的字段；name 用英文短名（如 topk_10）。`,
            [
              "输出 JSON 格式：",
              '{"hypothesis": "一句话优化假设",',
              ' "experiments": [{"name": "...", "changes": {"topK": 10}, "reason": "中文原因", "expectedEffect": "recallAtK"}]}',
            ].join("\n"),
          ].join("\n\n"),
        },
      ],
      { maxTokens: 1024 },
    );

    const seen = new Set([configKey(baseline)]);
    const candidates: CandidatePlan[] = [];
    for (const e of plan.experiments) {
      const cfg = clampConfig(e.changes, baseline);
      if (!cfg) continue;
      const key = configKey(cfg);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        name: e.name.slice(0, 64) || `exp_${candidates.length + 1}`,
        config: cfg,
        changes: diffConfig(cfg, baseline),
        reason: e.reason || "LLM 提案",
        expectedEffect: e.expectedEffect || "",
      });
      if (candidates.length >= maxExperiments) break;
    }
    if (candidates.length === 0) return null;
    return { hypothesis: plan.hypothesis, candidates };
  } catch {
    return null; // LLM 计划失败 → 规则兜底，不阻塞调优
  }
}

/**
 * 运行一轮自动调优（同步执行；实验串行跑，避免打爆外部检索/LLM 依赖）。
 * 每个实验 = 一次固定评测集离线评估 + 硬约束门禁 + 效用打分。
 */
export async function runAutoTuning(
  tenantId: string,
  opts: TuningOptions,
): Promise<TuningSummary> {
  const primaryMetric = opts.primaryMetric ?? "recallAtK";
  if (!EVAL_METRIC_KEYS.includes(primaryMetric as keyof EvalMetrics)) {
    throw new Error(
      `invalid primaryMetric: ${primaryMetric}（可选：${EVAL_METRIC_KEYS.join(", ")}）`,
    );
  }
  const maxExperiments = Math.max(
    1,
    Math.min(opts.maxExperiments ?? config.agent.maxExperiments, 12),
  );
  const sinceDays = opts.sinceDays ?? config.agent.diagnosisSinceDays;
  const tolerance = config.evalBaselineTolerance;

  // 前置校验：评测集必须存在
  const [datasetRow] = await withTenantTx(tenantId, (tx) =>
    tx.select().from(evalDatasets).where(eq(evalDatasets.id, opts.datasetId)).limit(1),
  );
  if (!datasetRow) throw new Error(`eval dataset not found: ${opts.datasetId}`);

  const [runRow] = await withTenantTx(tenantId, (tx) =>
    tx
      .insert(agentTuningRuns)
      .values({
        tenantId,
        status: "diagnosing",
        datasetId: opts.datasetId,
        sinceDays,
        primaryMetric,
      })
      .returning(),
  );
  const runId = runRow!.id;

  try {
    // 1) 线上数据统计与问题聚焦
    const stats = await collectOnlineStats(tenantId, sinceDays);
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(agentTuningRuns)
        .set({ issueStats: stats.issueStats })
        .where(eq(agentTuningRuns.id, runId)),
    );
    await setStatus(tenantId, runId, "planning");

    // 2) 基线离线评测（同一评测集、同一轮次内固定，保证前后对比可复现）
    const baseline = resolveBaselineConfig();
    const baselineEval = await runEvaluation(tenantId, opts.datasetId, {
      topK: baseline.topK,
      rerankerEnabled: baseline.useReranker,
      intelligence: baseline.intelligence,
      multiQueryCount: baseline.multiQueryCount,
    });
    if (baselineEval.status !== "ready") {
      throw new Error("baseline evaluation failed");
    }
    const baselineUtility = computeUtility(baselineEval.metrics, baseline);
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(agentTuningRuns)
        .set({
          baselineConfig: baseline,
          baselineRunId: baselineEval.runId,
          baselineMetrics: baselineEval.metrics,
        })
        .where(eq(agentTuningRuns.id, runId)),
    );
    await setStatus(tenantId, runId, "experimenting");

    // 3) 实验计划：LLM 提案优先，失败回退规则候选
    const plan =
      (opts.useLLMPlan ?? true)
        ? await planWithLLM(baseline, stats, maxExperiments)
        : null;
    const hypothesis = plan?.hypothesis ?? buildRuleHypothesis(stats, primaryMetric);
    const candidates =
      plan?.candidates ?? generateCandidates(baseline, stats.focusStages, maxExperiments);

    await withTenantTx(tenantId, (tx) =>
      tx.update(agentTuningRuns).set({ hypothesis }).where(eq(agentTuningRuns.id, runId)),
    );
    if (candidates.length === 0) {
      throw new Error("no valid candidate generated（候选与基线重复或计划为空）");
    }

    // 4) 逐实验：离线评测 → 硬约束门禁 → 效用打分（串行，控制外部依赖压力）
    const experimentRows: {
      name: string;
      status: string;
      gatePassed: boolean | null;
      utility: number | null;
      reason: string;
      changes: Record<string, unknown>;
    }[] = [];
    let gatePassedCount = 0;

    for (const cand of candidates) {
      const [expRow] = await withTenantTx(tenantId, (tx) =>
        tx
          .insert(agentExperiments)
          .values({
            tenantId,
            tuningRunId: runId,
            name: cand.name,
            config: cand.config,
            changes: cand.changes,
            reason: cand.reason,
            expectedEffect: cand.expectedEffect,
            status: "running",
          })
          .returning(),
      );
      const expId = expRow!.id;
      try {
        const result = await runEvaluation(tenantId, opts.datasetId, {
          topK: cand.config.topK,
          rerankerEnabled: cand.config.useReranker,
          intelligence: cand.config.intelligence,
          multiQueryCount: cand.config.multiQueryCount,
        });
        if (result.status !== "ready") {
          throw new Error(result.report.slice(0, 200) || "evaluation failed");
        }
        // 硬约束：相对调优基线，任何指标回退超过 tolerance 即不通过（设计方案 §8.2）
        const gate = checkRegression(result.metrics, baselineEval.metrics, tolerance);
        const utility = gate.gatePassed
          ? computeUtility(result.metrics, cand.config)
          : null;
        if (gate.gatePassed) gatePassedCount++;

        await withTenantTx(tenantId, (tx) =>
          tx
            .update(agentExperiments)
            .set({
              status: "ready",
              evalRunId: result.runId,
              metrics: result.metrics,
              gatePassed: gate.gatePassed,
              regressedMetrics: gate.regressedMetrics,
              utility,
            })
            .where(eq(agentExperiments.id, expId)),
        );
        experimentRows.push({
          name: cand.name,
          status: "ready",
          gatePassed: gate.gatePassed,
          utility,
          reason: cand.reason,
          changes: cand.changes,
        });
      } catch (err) {
        const msg = (err as Error).message;
        await withTenantTx(tenantId, (tx) =>
          tx
            .update(agentExperiments)
            .set({ status: "failed", error: msg })
            .where(eq(agentExperiments.id, expId)),
        ).catch(() => undefined);
        experimentRows.push({
          name: cand.name,
          status: "failed",
          gatePassed: null,
          utility: null,
          reason: cand.reason,
          changes: cand.changes,
        });
      }
    }

    // 5) 对比与选优：门禁通过者中效用分最高者为推荐配置
    await setStatus(tenantId, runId, "comparing");
    const readyExps = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(agentExperiments)
        .where(eq(agentExperiments.tuningRunId, runId)),
    );
    const passed = readyExps
      .filter((e) => e.status === "ready" && e.gatePassed === true && e.utility !== null)
      .sort((a, b) => (b.utility ?? 0) - (a.utility ?? 0));
    const bestExp = passed[0];

    const num = (v: number | undefined | null): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    const bestMetrics: Partial<EvalMetrics> = bestExp?.metrics ?? {};
    const deltas = {} as Partial<Record<keyof EvalMetrics, number>>;
    for (const key of EVAL_METRIC_KEYS) {
      deltas[key] = Number((num(bestMetrics[key]) - num(baselineEval.metrics[key])).toFixed(4));
    }

    const best = bestExp
      ? {
          config: bestExp.config,
          metrics: bestMetrics,
          utility: bestExp.utility!,
          evalRunId: bestExp.evalRunId,
        }
      : null;

    const conclusion = best
      ? (deltas[primaryMetric as keyof EvalMetrics] ?? 0) > 0
        ? `推荐配置 ${bestExp!.name}：主指标 ${primaryMetric} 提升 ${deltas[primaryMetric as keyof EvalMetrics]}，无指标显著回退。`
        : `推荐配置 ${bestExp!.name}：主指标无提升但综合效用分更优，且无指标显著回退。`
      : "无候选通过硬约束门禁，维持基线配置。";

    const comparison = {
      baseline: {
        config: baseline,
        metrics: baselineEval.metrics,
        utility: baselineUtility,
        evalRunId: baselineEval.runId,
      },
      best,
      deltas,
      totalExperiments: candidates.length,
      gatePassedCount,
      conclusion,
    };
    const report = renderTuningReport({
      tuningRunId: runId,
      datasetName: datasetRow.name,
      hypothesis,
      primaryMetric,
      baselineConfig: baseline,
      baselineMetrics: baselineEval.metrics,
      baselineUtility,
      best,
      deltas,
      experiments: experimentRows,
      totalExperiments: candidates.length,
      gatePassedCount,
    });

    await withTenantTx(tenantId, (tx) =>
      tx
        .update(agentTuningRuns)
        .set({
          status: "completed",
          bestConfig: best?.config,
          bestRunId: best?.evalRunId ?? null,
          bestMetrics: best?.metrics,
          bestUtility: best?.utility,
          comparison,
          report,
          completedAt: new Date(),
        })
        .where(eq(agentTuningRuns.id, runId)),
    );

    return {
      tuningRunId: runId,
      status: "completed",
      datasetId: opts.datasetId,
      hypothesis,
      totalExperiments: candidates.length,
      gatePassedCount,
      baseline: {
        config: baseline,
        metrics: baselineEval.metrics,
        utility: baselineUtility,
        evalRunId: baselineEval.runId,
      },
      best,
      deltas,
      report,
    };
  } catch (err) {
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(agentTuningRuns)
        .set({ status: "failed", error: (err as Error).message, completedAt: new Date() })
        .where(eq(agentTuningRuns.id, runId)),
    ).catch(() => undefined);
    throw err;
  }
}
