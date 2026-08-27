import type { EvalMetrics } from "../db/schema/eval.js";

/**
 * 评估指标（§22）：
 * - Retrieval: Recall@K / Hit Rate / MRR / NDCG
 * - Generation: Context Precision / Context Recall / Faithfulness / Answer Relevance
 * 全部为纯函数，归一化到 [0,1]。
 */

/** 中英混排分词：连续中文字符或 [a-z0-9] 词元 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter(Boolean);
}

/** 按标点切分断言句（Faithfulness 用） */
export function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?.]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface RetrievalMetrics {
  recallAtK: number;
  hitRate: number;
  mrr: number;
  ndcg: number;
}

/** Recall@K：黄金 chunk 被召回到 topK 的比例 */
export function recallAtK(gold: string[], retrieved: string[], k: number): number {
  if (gold.length === 0) return 0;
  const top = retrieved.slice(0, k);
  const hit = gold.filter((g) => top.includes(g)).length;
  return hit / gold.length;
}

/** Hit Rate：topK 内是否命中任一黄金 chunk */
export function hitRate(gold: string[], retrieved: string[], k: number): number {
  if (gold.length === 0) return 0;
  const top = retrieved.slice(0, k);
  return top.some((r) => gold.includes(r)) ? 1 : 0;
}

/** MRR：首个黄金 chunk 在检索结果中的倒数排名 */
export function mrr(gold: string[], retrieved: string[]): number {
  if (gold.length === 0) return 0;
  for (let i = 0; i < retrieved.length; i++) {
    if (gold.includes(retrieved[i]!)) return 1 / (i + 1);
  }
  return 0;
}

/** NDCG@K：二值相关性的归一化折损累计增益 */
export function ndcg(gold: string[], retrieved: string[], k: number): number {
  if (gold.length === 0) return 0;
  const top = retrieved.slice(0, k);
  const dcg = top.reduce(
    (acc, id, i) => (gold.includes(id) ? acc + 1 / Math.log2(i + 2) : acc),
    0,
  );
  const idcg = Array.from(
    { length: Math.min(k, gold.length) },
    (_, i) => 1 / Math.log2(i + 2),
  ).reduce((a, b) => a + b, 0);
  return idcg > 0 ? dcg / idcg : 0;
}

/** 检索四项指标合并求值（顺序 = 重排后的最终顺序） */
export function evaluateRetrieval(
  gold: string[],
  retrieved: string[],
  topK: number,
): RetrievalMetrics {
  return {
    recallAtK: recallAtK(gold, retrieved, topK),
    hitRate: hitRate(gold, retrieved, topK),
    mrr: mrr(gold, retrieved),
    ndcg: ndcg(gold, retrieved, topK),
  };
}

/** Context Precision：相关证据越靠前越高（RAGAS avg_precision 的二值简化） */
export function contextPrecision(gold: string[], retrieved: string[]): number {
  if (gold.length === 0) return 0;
  let sum = 0;
  let relevant = 0;
  for (let i = 0; i < retrieved.length; i++) {
    if (gold.includes(retrieved[i]!)) {
      relevant++;
      sum += relevant / (i + 1);
    }
  }
  return relevant > 0 ? sum / relevant : 0;
}

/** Context Recall：上下文覆盖黄金 chunk 的比例 */
export function contextRecall(gold: string[], retrieved: string[]): number {
  if (gold.length === 0) return 0;
  const hit = gold.filter((g) => retrieved.includes(g)).length;
  return hit / gold.length;
}

export const EVAL_METRIC_KEYS: (keyof EvalMetrics)[] = [
  "recallAtK",
  "hitRate",
  "mrr",
  "ndcg",
  "contextPrecision",
  "contextRecall",
  "faithfulness",
  "answerRelevance",
];

/** 合并一份（可能 Partial 的）指标，缺省项补 0 */
export function normalizeMetrics(
  m: Partial<EvalMetrics> | undefined,
): EvalMetrics {
  const out = {} as EvalMetrics;
  for (const key of EVAL_METRIC_KEYS) out[key] = m?.[key] ?? 0;
  return out;
}

/** 多查询平均汇总 */
export function averageMetrics(
  results: { metrics: Partial<EvalMetrics> }[],
): EvalMetrics {
  if (results.length === 0) return normalizeMetrics({});
  const out = {} as EvalMetrics;
  for (const key of EVAL_METRIC_KEYS) {
    out[key] =
      results.reduce((acc, r) => acc + (r.metrics[key] ?? 0), 0) /
      results.length;
  }
  return out;
}
