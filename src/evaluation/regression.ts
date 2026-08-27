import type { EvalMetrics } from "../db/schema/eval.js";
import { EVAL_METRIC_KEYS, normalizeMetrics } from "./metrics.js";

/**
 * 回归测试与 CI gate（§22.1）：
 * 每次改 embedding / chunk / rerank / prompt 后重跑评估，
 * 与基线对比，指标显著回退则阻断合并。
 */

export interface RegressionCheck {
  /** 回退指标名（低于基线×(1-tolerance)） */
  regressedMetrics: string[];
  /** 各指标相对基线的差值（current - baseline） */
  deltas: Partial<Record<keyof EvalMetrics, number>>;
  /** 门禁是否通过：无回退指标即通过 */
  gatePassed: boolean;
}

export function checkRegression(
  current: Partial<EvalMetrics>,
  baseline: Partial<EvalMetrics> | null,
  tolerance: number,
): RegressionCheck {
  const cur = normalizeMetrics(current);
  const deltas: Partial<Record<keyof EvalMetrics, number>> = {};
  const regressedMetrics: string[] = [];

  for (const key of EVAL_METRIC_KEYS) {
    const base = baseline?.[key];
    deltas[key] = Number.isFinite(base) ? cur[key] - (base ?? 0) : 0;
    // 无基线时不判回归，建立基线
    if (base !== undefined && Number.isFinite(base)) {
      if (cur[key] < base * (1 - tolerance)) regressedMetrics.push(key);
    }
  }

  return {
    regressedMetrics,
    deltas,
    gatePassed: regressedMetrics.length === 0,
  };
}

const METRIC_LABELS: Record<keyof EvalMetrics, string> = {
  recallAtK: "Recall@K",
  hitRate: "Hit Rate",
  mrr: "MRR",
  ndcg: "NDCG",
  contextPrecision: "Context Precision",
  contextRecall: "Context Recall",
  faithfulness: "Faithfulness",
  answerRelevance: "Answer Relevance",
};

export interface ReportInput {
  runId: string;
  datasetName: string;
  indexVersion: string;
  embeddingVersion: string;
  topK: number;
  llmModel: string | null;
  reranker: string | null;
  metrics: Partial<EvalMetrics>;
  baseline: {
    runId: string;
    metrics: Partial<EvalMetrics>;
  } | null;
  check: RegressionCheck;
  /** 逐查询明细：[query, metrics, answer] */
  rows: {
    query: string;
    metrics: Partial<EvalMetrics>;
    answer: string;
  }[];
}

function fmt(n: number | undefined): string {
  return Number.isFinite(n) ? (n ?? 0).toFixed(4) : "-";
}

/** 渲染 Markdown 回归报告（与基线对比 + 逐查询明细） */
export function renderReport(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# Eval Report — ${input.datasetName}`);
  lines.push("");
  lines.push(
    `- run: \`${input.runId}\`  `,
    `- indexVersion: ${input.indexVersion} / embeddingVersion: ${input.embeddingVersion}  `,
    `- topK: ${input.topK} / llmModel: ${input.llmModel ?? "-"} / reranker: ${input.reranker ?? "-"}`,
  );
  lines.push("");

  const gate = input.check.gatePassed
    ? "**PASS** ✅（无显著回退）"
    : `**FAIL** ❌（回归指标：${input.check.regressedMetrics
        .map((m) => METRIC_LABELS[m as keyof EvalMetrics])
        .join("、")}）`;
  lines.push(`## Regression Gate\n${gate}`);
  lines.push("");

  lines.push("## 汇总指标");
  lines.push("");
  lines.push("| Metric | Current | Baseline | Δ |");
  lines.push("| --- | ---: | ---: | ---: |");
  const baselineLabel = input.baseline
    ? `\`${input.baseline.runId.slice(0, 8)}\``
    : "-";
  for (const key of EVAL_METRIC_KEYS) {
    const cur = input.metrics[key];
    const base = input.baseline?.metrics[key];
    const delta = input.check.deltas[key];
    const mark = delta !== undefined && delta < 0 ? "⬇" : delta && delta > 0 ? "⬆" : "";
    lines.push(
      `| ${METRIC_LABELS[key]} | ${fmt(cur)} | ${fmt(base)} | ${fmt(delta)}${mark} |`,
    );
  }
  lines.push("");

  lines.push("## 逐查询明细");
  lines.push("");
  lines.push("| Query | Recall@K | Hit Rate | MRR | NDCG | Faithfulness | Answer Rel. |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of input.rows) {
    const m = row.metrics;
    lines.push(
      `| ${row.query.replaceAll("|", "\\|")} | ${fmt(m.recallAtK)} | ${fmt(m.hitRate)} | ${fmt(m.mrr)} | ${fmt(m.ndcg)} | ${fmt(m.faithfulness)} | ${fmt(m.answerRelevance)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
