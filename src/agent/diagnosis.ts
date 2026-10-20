import { and, desc, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.js";
import { withTenantTx } from "../db/index.js";
import { chunks } from "../db/schema/chunk.js";
import { retrievalLogs, type RetrievalLogRow } from "../db/schema/retrieval-log.js";
import {
  agentDiagnoses,
  agentDiagnosisCases,
  type DiagnosisSignals,
  type IssueSeverity,
  type IssueStage,
  type IssueStats,
} from "../db/schema/agent.js";
import { chatJson, hasLLM } from "./structured-llm.js";
import { renderDiagnosisReport } from "./report.js";

/**
 * 功能 1：线上 Badcase 错误分析（设计方案 §4 问题诊断机制）。
 *
 * 流程：规则先行（基于 retrieval_logs 的可观测信号分阶段定位）→
 * LLM 复核（仅对疑似生成类/证据类问题，拉取证据原文判定 grounding 与相关性）→
 * 聚合问题分布 → 渲染分析报告并落库。
 *
 * 诊断只给出「错在哪一步」与证据信号，不夸大为唯一根因：
 * 复合信号保留在 signals.triggered 中，避免单一互斥分类掩盖复合根因。
 */

export const ISSUE_STAGES = [
  "NO_EVIDENCE",
  "RETRIEVAL_RECALL",
  "RANKING",
  "WEAK_EVIDENCE",
  "NO_CITATION",
  "GENERATION_GROUNDING",
  "GENERATION_RELEVANCE",
  "SLOW_RETRIEVAL",
  "SLOW_GENERATION",
  "NO_CLEAR_ISSUE",
] as const;

export interface DiagnosisOptions {
  /** 回看窗口（天），默认取全局配置 */
  sinceDays?: number;
  /** 最大分析样本数，默认取全局配置 */
  limit?: number;
  /** 是否启用 LLM 复核（默认启用，未配置 API Key 时自动跳过） */
  useLLM?: boolean;
}

export interface DiagnosisCaseDraft {
  logId: string;
  query: string;
  stage: IssueStage;
  severity: IssueSeverity;
  rootCause: string;
  suggestion: string;
  signals: DiagnosisSignals;
}

export interface DiagnosisSummary {
  diagnosisId: string;
  status: "completed" | "failed";
  sampleCount: number;
  badcaseCount: number;
  healthScore: number | null;
  issueStats: IssueStats;
  report: string;
}

interface RuleOutcome {
  stage: IssueStage;
  severity: IssueSeverity;
  rootCause: string;
  suggestion: string;
  triggered: string[];
}

/**
 * 规则诊断（设计方案 §4.2）：基于日志可观测信号分阶段定位。
 * 阈值来自 config.agent（示例值，应结合业务基线与 SLA 调整）。
 */
export function ruleDiagnose(log: RetrievalLogRow): RuleOutcome {
  const thresholds = config.agent;
  const triggered: string[] = [];
  const evidenceCount = log.evidenceCount ?? 0;
  const citationCount = log.citationCount ?? 0;
  const topScore = log.topScore;
  const answer = (log.answer ?? "").trim();
  const slowRetrieval = (log.retrievalMs ?? 0) > thresholds.slowRetrievalMs;
  const slowGeneration = (log.generationMs ?? 0) > thresholds.slowGenerationMs;

  if (evidenceCount === 0) triggered.push("ZERO_EVIDENCE");
  if (topScore !== null && topScore !== undefined && topScore < thresholds.weakEvidenceScore) {
    triggered.push("WEAK_TOP_SCORE");
  }
  if (citationCount === 0 && evidenceCount > 0) triggered.push("NO_CITATION");
  if (log.recallAtK !== null && log.recallAtK !== undefined && log.recallAtK < thresholds.minRecallAtK) {
    triggered.push("LOW_RECALL");
  }
  if (
    log.recallAtK !== null && log.recallAtK !== undefined &&
    log.recallAtK >= thresholds.minRecallAtK &&
    log.ndcg !== null && log.ndcg !== undefined && log.ndcg < thresholds.minNdcg
  ) {
    triggered.push("LOW_NDCG");
  }
  if (slowRetrieval) triggered.push("SLOW_RETRIEVAL");
  if (slowGeneration) triggered.push("SLOW_GENERATION");
  if (answer.length === 0 && evidenceCount > 0) triggered.push("EMPTY_ANSWER");

  // 主阶段判定：按「检索 → 上下文/引用 → 生成 → 性能」优先级取第一个命中
  if (evidenceCount === 0) {
    return {
      stage: "NO_EVIDENCE",
      severity: "high",
      rootCause: "混合检索零召回，未命中任何证据",
      suggestion: "开启 Query Intelligence 改写查询；确认相关文档已摄入且索引完成",
      triggered,
    };
  }
  if (log.recallAtK !== null && log.recallAtK !== undefined && log.recallAtK < thresholds.minRecallAtK) {
    return {
      stage: "RETRIEVAL_RECALL",
      severity: "high",
      rootCause: `Recall@K=${log.recallAtK.toFixed(2)} 低于阈值 ${thresholds.minRecallAtK}，相关证据未进入召回窗口`,
      suggestion: "增大 Top-K 或开启/增加 Multi Query 变体；复查切片与 Embedding 质量",
      triggered,
    };
  }
  if (
    log.recallAtK !== null && log.recallAtK !== undefined &&
    log.ndcg !== null && log.ndcg !== undefined && log.ndcg < thresholds.minNdcg
  ) {
    return {
      stage: "RANKING",
      severity: "medium",
      rootCause: `召回达标（Recall@K=${log.recallAtK.toFixed(2)}）但 NDCG=${log.ndcg.toFixed(2)} 偏低，相关证据排名靠后`,
      suggestion: "确保 Reranker 开启；增大候选窗口依靠重排前置相关证据",
      triggered,
    };
  }
  if (topScore !== null && topScore !== undefined && topScore < thresholds.weakEvidenceScore) {
    return {
      stage: "WEAK_EVIDENCE",
      severity: "medium",
      rootCause: `Top 证据得分 ${topScore.toFixed(2)} 低于阈值 ${thresholds.weakEvidenceScore}，证据与问题匹配度弱`,
      suggestion: "开启查询改写；检查语料是否覆盖该主题",
      triggered,
    };
  }
  if (citationCount === 0 && evidenceCount > 0) {
    return {
      stage: "NO_CITATION",
      severity: "medium",
      rootCause: `存在 ${evidenceCount} 条证据但回答未携带引用`,
      suggestion: "检查上下文预算是否截断丢失证据；核对生成 Prompt 的引用约束",
      triggered,
    };
  }
  if (answer.length === 0) {
    return {
      stage: "GENERATION_RELEVANCE",
      severity: "high",
      rootCause: "有证据但回答为空",
      suggestion: "检查生成 Prompt、输出长度限制与模型调用是否失败",
      triggered,
    };
  }
  if (slowRetrieval) {
    return {
      stage: "SLOW_RETRIEVAL",
      severity: "low",
      rootCause: `检索耗时 ${log.retrievalMs}ms 超过阈值 ${thresholds.slowRetrievalMs}ms`,
      suggestion: "关闭重排或精简智能链路；检查外部检索依赖超时与缓存",
      triggered,
    };
  }
  if (slowGeneration) {
    return {
      stage: "SLOW_GENERATION",
      severity: "low",
      rootCause: `生成耗时 ${log.generationMs}ms 超过阈值 ${thresholds.slowGenerationMs}ms`,
      suggestion: "缩小 Top-K 与上下文预算；降低输出长度或更换更快模型",
      triggered,
    };
  }
  return {
    stage: "NO_CLEAR_ISSUE",
    severity: "none",
    rootCause: "可观测信号均在阈值内",
    suggestion: "无需处理",
    triggered,
  };
}

/** LLM 复核输出 Schema（服务端校验，不合规即回退规则结论） */
const llmReviewSchema = z.object({
  isGrounded: z.boolean(),
  isRelevant: z.boolean(),
  stage: z.enum(ISSUE_STAGES),
  rootCause: z.string(),
  suggestion: z.string(),
});

type LlmReview = z.infer<typeof llmReviewSchema>;

const GENERATION_STAGES: IssueStage[] = [
  "GENERATION_GROUNDING",
  "GENERATION_RELEVANCE",
  "NO_CITATION",
];

/** 拉取证据原文（截断），供 LLM 判定 grounding */
async function fetchEvidenceTexts(
  tenantId: string,
  chunkIds: string[],
): Promise<string[]> {
  const ids = chunkIds.slice(0, 6);
  if (ids.length === 0) return [];
  const rows = await withTenantTx(tenantId, (tx) =>
    tx
      .select({ id: chunks.id, content: chunks.content })
      .from(chunks)
      .where(inArray(chunks.id, ids)),
  );
  return rows.map((r) => (r.content ?? "").replace(/\s+/g, " ").slice(0, 500));
}

async function reviewWithLLM(
  query: string,
  answer: string,
  evidenceTexts: string[],
  draft: DiagnosisCaseDraft,
): Promise<LlmReview | null> {
  if (!hasLLM() || evidenceTexts.length === 0) return null;
  const evidence = evidenceTexts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  try {
    return await chatJson(
      llmReviewSchema,
      [
        {
          role: "system",
          content:
            "你是 RAG 系统的错误分析专家。根据用户问题、生成的回答与检索到的证据，定位问题阶段。只输出一个 JSON 对象，不要输出其他内容。",
        },
        {
          role: "user",
          content: [
            `【用户问题】${query}`,
            `【生成的回答】${answer || "（空）"}`,
            `【检索到的证据（按相关度排序，已截断）】\n${evidence}`,
            `【规则初判】阶段=${draft.stage}，根因=${draft.rootCause}`,
            [
              "请判断并输出 JSON：",
              '{"isGrounded": boolean, // 回答是否基本基于证据（false=存在编造）',
              ' "isRelevant": boolean, // 回答是否切题（false=答非所问或为空）',
              ` "stage": "..." , // 问题阶段，取值：${ISSUE_STAGES.join("/")}`,
              ' "rootCause": "一句话根因",',
              ' "suggestion": "一句话修复建议"}',
            ].join("\n"),
          ].join("\n\n"),
        },
      ],
      { maxTokens: 512 },
    );
  } catch {
    return null; // LLM 复核失败不阻塞诊断，回退规则结论
  }
}

/** 把 LLM 复核结论合并进规则诊断结果（LLM 仅在能给出明确结论时覆盖） */
function mergeReview(draft: DiagnosisCaseDraft, review: LlmReview | null): void {
  draft.signals.llmReviewed = review !== null;
  if (!review) return;
  const ruleIsGeneration = GENERATION_STAGES.includes(draft.stage);
  const llmSaysBad =
    !review.isGrounded || !review.isRelevant || review.stage !== "NO_CLEAR_ISSUE";
  // 规则仅凭引用/分数间接推断生成问题，LLM 可直接读证据与答案，结论更可靠：
  // 1) LLM 判定回答有据且切题 → 撤销间接推断的生成类问题
  if (!llmSaysBad && ruleIsGeneration) {
    draft.stage = "NO_CLEAR_ISSUE";
    draft.severity = "none";
    draft.rootCause = "LLM 复核：回答基于证据且切题，可观测信号均在阈值内";
    draft.suggestion = "无需处理";
    return;
  }
  // 2) LLM 定位到生成类问题（规则无法直接观测）→ 覆盖
  const llmIsGeneration = GENERATION_STAGES.includes(review.stage);
  if (llmSaysBad && (llmIsGeneration || ruleIsGeneration)) {
    if (review.stage !== draft.stage || llmIsGeneration) {
      draft.stage = review.stage;
      draft.severity = !review.isGrounded ? "high" : "medium";
    }
    if (review.rootCause) draft.rootCause = review.rootCause;
    if (review.suggestion) draft.suggestion = review.suggestion;
  }
}

/**
 * 运行一次 Badcase 错误分析。
 * 同步执行（与 /eval/runs 风格一致）：样本上限与 LLM 复核上限由配置约束预算。
 */
export async function runBadcaseDiagnosis(
  tenantId: string,
  opts: DiagnosisOptions = {},
): Promise<DiagnosisSummary> {
  const sinceDays = opts.sinceDays ?? config.agent.diagnosisSinceDays;
  const limit = opts.limit ?? config.agent.diagnosisSampleLimit;
  const useLLM = opts.useLLM ?? true;

  const [row] = await withTenantTx(tenantId, (tx) =>
    tx
      .insert(agentDiagnoses)
      .values({ tenantId, status: "diagnosing", sinceDays })
      .returning(),
  );
  const diagnosisId = row!.id;

  try {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const logs = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(retrievalLogs)
        .where(and(gte(retrievalLogs.createdAt, since)))
        .orderBy(desc(retrievalLogs.createdAt))
        .limit(limit),
    );

    // 1) 规则诊断
    const drafts: DiagnosisCaseDraft[] = logs.map((log) => {
      const rule = ruleDiagnose(log);
      return {
        logId: log.id,
        query: log.query,
        stage: rule.stage,
        severity: rule.severity,
        rootCause: rule.rootCause,
        suggestion: rule.suggestion,
        signals: {
          topScore: log.topScore,
          evidenceCount: log.evidenceCount,
          citationCount: log.citationCount,
          recallAtK: log.recallAtK,
          ndcg: log.ndcg,
          retrievalMs: log.retrievalMs,
          generationMs: log.generationMs,
          latencyMs: log.latencyMs,
          triggered: rule.triggered,
          ruleStage: rule.stage,
          llmReviewed: false,
          answer: (log.answer ?? "").slice(0, 800),
        },
      };
    });

    // 2) LLM 复核：仅对疑似生成类/证据类问题（规则无法直接观测证据与答案的关系）
    if (useLLM && hasLLM()) {
      const logById = new Map(logs.map((l) => [l.id, l]));
      const candidates = drafts
        .filter(
          (d) =>
            d.severity !== "none" &&
            (GENERATION_STAGES.includes(d.stage) || d.stage === "WEAK_EVIDENCE"),
        )
        .slice(0, config.agent.diagnosisLLMReviewLimit);
      for (const draft of candidates) {
        const evidenceTexts = await fetchEvidenceTexts(
          tenantId,
          logById.get(draft.logId)?.chunkIds ?? [],
        );
        const log = logById.get(draft.logId);
        const review = await reviewWithLLM(
          draft.query,
          (log?.answer ?? "").slice(0, 800),
          evidenceTexts,
          draft,
        );
        mergeReview(draft, review);
      }
    }

    // 3) 聚合 + 报告
    const issueStats: IssueStats = {};
    let badcaseCount = 0;
    for (const d of drafts) {
      if (d.stage !== "NO_CLEAR_ISSUE") badcaseCount++;
      issueStats[d.stage] = (issueStats[d.stage] ?? 0) + 1;
    }
    const healthScore =
      logs.length === 0 ? null : Number((1 - badcaseCount / logs.length).toFixed(4));

    const badcases = drafts
      .filter((d) => d.stage !== "NO_CLEAR_ISSUE")
      .sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2, none: 3 };
        return order[a.severity] - order[b.severity];
      });

    const report = renderDiagnosisReport({
      diagnosisId,
      sinceDays,
      sampleCount: logs.length,
      badcaseCount,
      healthScore: healthScore ?? 1,
      issueStats,
      cases: badcases,
      llmReviewed: hasLLM() && useLLM && drafts.some((d) => d.signals.llmReviewed),
    });

    await withTenantTx(tenantId, async (tx) => {
      if (drafts.length > 0) {
        await tx.insert(agentDiagnosisCases).values(
          drafts.map((d) => ({
            tenantId,
            diagnosisId,
            logId: d.logId,
            query: d.query,
            stage: d.stage,
            severity: d.severity,
            rootCause: d.rootCause,
            suggestion: d.suggestion,
            signals: d.signals,
          })),
        );
      }
      await tx
        .update(agentDiagnoses)
        .set({
          status: "completed",
          sampleCount: logs.length,
          badcaseCount,
          healthScore,
          issueStats,
          report,
          completedAt: new Date(),
        })
        .where(inArray(agentDiagnoses.id, [diagnosisId]));
    });

    return {
      diagnosisId,
      status: "completed",
      sampleCount: logs.length,
      badcaseCount,
      healthScore,
      issueStats,
      report,
    };
  } catch (err) {
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(agentDiagnoses)
        .set({ status: "failed", error: (err as Error).message, completedAt: new Date() })
        .where(inArray(agentDiagnoses.id, [diagnosisId])),
    ).catch(() => undefined);
    throw err;
  }
}
