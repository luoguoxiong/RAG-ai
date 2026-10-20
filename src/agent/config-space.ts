import { z } from "zod";
import { config } from "../config.js";
import type { EvalMetrics } from "../db/schema/eval.js";
import type {
  IssueStage,
  RagTuningConfig,
} from "../db/schema/agent.js";

/**
 * 参数搜索空间（设计方案 §3/§6）：
 * - LLM 只负责「提案」，此处负责校验与钳制——Agent 不能任意配置生产参数。
 * - 第一版只开放低风险参数（topK / reranker / Query Intelligence / Multi Query 变体数）；
 *   切片策略与 Embedding 模型会触发大规模重建索引，明确排除在外。
 */

export const ragTuningConfigSchema = z.object({
  topK: z.number().int().min(1).max(20),
  useReranker: z.boolean(),
  intelligence: z.boolean(),
  multiQueryCount: z.number().int().min(1).max(5),
});

/** 当前生产基线配置（从全局配置推导，作为调优对照组） */
export function resolveBaselineConfig(): RagTuningConfig {
  return {
    topK: config.defaultTopK,
    useReranker: true,
    intelligence: config.queryIntelligence.enabled,
    multiQueryCount: config.queryIntelligence.multiQueryCount,
  };
}

/**
 * 把不可信输入（LLM 提案 / API 请求）钳制到合法配置空间：
 * 逐字段校验，非法字段回退基线值。返回 null 表示整体结构不可修复。
 */
export function clampConfig(
  raw: unknown,
  baseline: RagTuningConfig,
): RagTuningConfig | null {
  if (raw === null || typeof raw !== "object") return null;
  const parsed = ragTuningConfigSchema.partial().safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const clampInt = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
  };
  return {
    topK:
      p.topK !== undefined
        ? clampInt(p.topK, 1, 20, baseline.topK)
        : baseline.topK,
    useReranker:
      typeof p.useReranker === "boolean"
        ? p.useReranker
        : baseline.useReranker,
    intelligence:
      typeof p.intelligence === "boolean"
        ? p.intelligence
        : baseline.intelligence,
    multiQueryCount:
      p.multiQueryCount !== undefined
        ? clampInt(p.multiQueryCount, 1, 5, baseline.multiQueryCount)
        : baseline.multiQueryCount,
  };
}

/** 配置指纹（去重用） */
export function configKey(cfg: RagTuningConfig): string {
  return `${cfg.topK}|${cfg.useReranker}|${cfg.intelligence}|${cfg.multiQueryCount}`;
}

/** 相对基线的差异字段（报告展示用） */
export function diffConfig(
  cfg: RagTuningConfig,
  baseline: RagTuningConfig,
): Partial<RagTuningConfig> {
  const diff: Partial<RagTuningConfig> = {};
  if (cfg.topK !== baseline.topK) diff.topK = cfg.topK;
  if (cfg.useReranker !== baseline.useReranker) diff.useReranker = cfg.useReranker;
  if (cfg.intelligence !== baseline.intelligence) diff.intelligence = cfg.intelligence;
  if (cfg.multiQueryCount !== baseline.multiQueryCount) {
    diff.multiQueryCount = cfg.multiQueryCount;
  }
  return diff;
}

/**
 * 成本代理 [0,1]：评测不度量真实延迟/费用，用参数复杂度近似
 * （multi-query 变体数 + reranker 额外 LLM 调用 + 更大候选池 + 智能链路）。
 */
export function estimateCostProxy(cfg: RagTuningConfig): number {
  const c =
    (cfg.multiQueryCount - 1) * 0.15 + // 每多一个变体多一次召回与一次批量嵌入份额
    (cfg.useReranker ? 0.25 : 0) + // 重排额外一次 LLM 调用
    (cfg.intelligence ? 0.15 : 0) + // 分析/改写路径的额外调用
    (cfg.topK - config.defaultTopK) * 0.02; // 更大窗口的回表与上下文开销
  return Math.min(1, Math.max(0, c));
}

/**
 * 效用函数（设计方案 §8.2 示例）：
 * J = 0.4·Q + 0.3·R + 0.2·F - 0.1·C
 * Q=答案相关性，R=检索质量（Recall/NDCG 均值），F=忠实度，C=成本代理。
 * 仅用于门禁通过者之间的排序；安全与最低质量由硬约束（回归门禁）保证。
 */
export function computeUtility(
  metrics: Partial<EvalMetrics>,
  cfg: RagTuningConfig,
): number {
  const num = (v: number | undefined): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const q = num(metrics.answerRelevance);
  const r = (num(metrics.recallAtK) + num(metrics.ndcg)) / 2;
  const f = num(metrics.faithfulness);
  const c = estimateCostProxy(cfg);
  return Number((0.4 * q + 0.3 * r + 0.2 * f - 0.1 * c).toFixed(4));
}

export interface CandidatePlan {
  name: string;
  config: RagTuningConfig;
  changes: Partial<RagTuningConfig>;
  reason: string;
  expectedEffect: string;
}

/**
 * 规则候选生成器（LLM 不可用时的确定性兜底）：
 * 按线上问题分布选择优化方向，围绕基线每次只动 1~2 个维度，便于归因。
 */
export function generateCandidates(
  baseline: RagTuningConfig,
  focusStages: IssueStage[],
  maxExperiments: number,
): CandidatePlan[] {
  const counts = new Map<IssueStage, number>();
  for (const s of focusStages) counts.set(s, (counts.get(s) ?? 0) + 1);
  const dominant = (stages: IssueStage[]): boolean =>
    stages.some((s) => (counts.get(s) ?? 0) > 0);
  const recallHeavy = dominant(["RETRIEVAL_RECALL", "NO_EVIDENCE", "WEAK_EVIDENCE"]);
  const rankingHeavy = dominant(["RANKING"]);
  const generationHeavy = dominant([
    "GENERATION_GROUNDING",
    "GENERATION_RELEVANCE",
    "NO_CITATION",
  ]);
  const latencyHeavy = dominant(["SLOW_RETRIEVAL", "SLOW_GENERATION"]);

  const plans: { name: string; config: RagTuningConfig; reason: string; expectedEffect: string }[] = [];

  // 召回不足：扩大召回窗口 + 开启多查询改写
  if (recallHeavy) {
    for (const k of [baseline.topK + 2, baseline.topK + 4]) {
      const topK = Math.min(20, k);
      plans.push({
        name: `topk_${topK}`,
        config: { ...baseline, topK },
        reason: "线上召回类问题占比高，扩大召回窗口提高证据覆盖率",
        expectedEffect: "recallAtK",
      });
    }
    if (!baseline.intelligence) {
      plans.push({
        name: `iq_mq${baseline.multiQueryCount}`,
        config: { ...baseline, intelligence: true },
        reason: "召回不足且智能链路关闭，开启改写/多查询提升宽泛问句覆盖",
        expectedEffect: "recallAtK",
      });
    } else if (baseline.multiQueryCount < 5) {
      const mq = Math.min(5, baseline.multiQueryCount + 1);
      plans.push({
        name: `multiquery_${mq}`,
        config: { ...baseline, multiQueryCount: mq },
        reason: "多查询变体不足，增加变体数覆盖更多表述",
        expectedEffect: "recallAtK",
      });
    }
  }

  // 排序问题：确保重排开启
  if (rankingHeavy && !baseline.useReranker) {
    plans.push({
      name: "rerank_on",
      config: { ...baseline, useReranker: true },
      reason: "召回达标但排序质量差，开启 Reranker 重排",
      expectedEffect: "ndcg",
    });
  }

  // 生成问题：缩小候选池降噪
  if (generationHeavy && baseline.topK > 3) {
    const topK = Math.max(3, baseline.topK - 2);
    plans.push({
      name: `topk_${topK}_denoise`,
      config: { ...baseline, topK },
      reason: "生成忠实度类问题占比高，缩小上下文候选池降低噪声",
      expectedEffect: "faithfulness",
    });
  }

  // 性能问题：精简链路
  if (latencyHeavy) {
    plans.push({
      name: "lean_pipeline",
      config: { ...baseline, intelligence: false, multiQueryCount: 1 },
      reason: "延迟超标，关闭查询智能链路减少模型调用",
      expectedEffect: "latency",
    });
    if (baseline.useReranker) {
      plans.push({
        name: "rerank_off",
        config: { ...baseline, useReranker: false },
        reason: "延迟超标，关闭重排（以融合分排序）",
        expectedEffect: "latency",
      });
    }
  }

  // 无明确信号：做一组中性的窗口探索，保证任务总有候选
  if (plans.length === 0) {
    const upK = Math.min(20, baseline.topK + 2);
    plans.push(
      {
        name: `topk_${upK}`,
        config: { ...baseline, topK: upK },
        reason: "无明确问题信号，探索更大召回窗口",
        expectedEffect: "recallAtK",
      },
      {
        name: "baseline_plus_iq",
        config: { ...baseline, intelligence: true },
        reason: "无明确问题信号，探索开启查询智能链路",
        expectedEffect: "recallAtK",
      },
    );
  }

  // 去重（含与基线重复的候选剔除）→ 截断到预算
  const seen = new Set([configKey(baseline)]);
  const candidates: CandidatePlan[] = [];
  for (const p of plans) {
    const key = configKey(p.config);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ ...p, changes: diffConfig(p.config, baseline) });
    if (candidates.length >= maxExperiments) break;
  }
  return candidates;
}
