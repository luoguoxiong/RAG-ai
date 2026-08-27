import { config } from "../config.js";
import { retrieveEvidence, type Evidence } from "../retrieval/retriever.js";
import { reciprocalRankFusion } from "../ranking/rrf.js";
import { analyzeQuery, type QueryAnalysis } from "./analyzer.js";
import { routeQuery, type RetrievalPlan } from "./router.js";
import { createQueryRewriter } from "./rewrite.js";
import { createMultiQueryGenerator } from "./multi-query.js";
import { createHydeGenerator } from "./hyde.js";

/**
 * Query Intelligence（§13-15，Phase 5）编排：
 * Analyze → Route → Transform → Retrieve。
 *
 * 变换互斥，优先级（§14）：Rewrite（含糊）> Multi Query（宽泛）>
 * HyDE（概念型）> Direct（简单直连）。
 */

export interface QueryIntelligenceResult {
  analysis: QueryAnalysis;
  plan: RetrievalPlan;
  /** 实际用于检索的文本：direct/rewrite/hyde 为 1 个，multi-query 为 N 个 */
  effectiveQueries: string[];
  evidence: Evidence[];
}

/** 多查询检索：每条变体独立混合检索，按 RRF 融合去重（§10） */
async function retrieveEvidenceMulti(
  tenantId: string,
  queries: string[],
  topK: number,
  useReranker: boolean,
): Promise<Evidence[]> {
  const results = await Promise.all(
    queries.map((q) =>
      retrieveEvidence(tenantId, q, topK, { useReranker }),
    ),
  );
  const rankLists = results.map((evs) =>
    evs.map((e, i) => ({ source: "hybrid", id: e.chunkId, rank: i + 1 })),
  );
  const fused = reciprocalRankFusion(rankLists).slice(0, topK);

  const evByChunk = new Map<string, Evidence>();
  for (const evs of results) {
    for (const e of evs) {
      if (!evByChunk.has(e.chunkId)) evByChunk.set(e.chunkId, e);
    }
  }

  const ordered: Evidence[] = [];
  for (const f of fused) {
    const e = evByChunk.get(f.id);
    if (!e) continue;
    ordered.push({
      ...e,
      id: `ev_${ordered.length + 1}`,
      score: f.score,
      fusionScore: f.score,
      source: "hybrid",
    });
  }
  return ordered;
}

/** Analyze → Route → Transform → Retrieve 全链路 */
export async function runQueryIntelligence(
  tenantId: string,
  query: string,
  topK?: number,
): Promise<QueryIntelligenceResult> {
  const k = topK ?? config.defaultTopK;
  const analysis = await analyzeQuery(query);
  const plan = await routeQuery(query, analysis, k);
  const { effectiveQueries, evidence } = await transformAndRetrieve(
    tenantId,
    query,
    analysis,
    plan,
    k,
  );
  return { analysis, plan, effectiveQueries, evidence };
}

/** 变换 + 检索：按分析结果选择一种变换，其余走直连 */
export async function transformAndRetrieve(
  tenantId: string,
  query: string,
  analysis: QueryAnalysis,
  plan: RetrievalPlan,
  topK: number,
): Promise<{ effectiveQueries: string[]; evidence: Evidence[] }> {
  const useReranker = plan.useReranker;

  // Ambiguous → Rewrite
  if (analysis.needsRewrite) {
    const rewritten = await createQueryRewriter().rewrite(query);
    const q = rewritten.trim() || query;
    return {
      effectiveQueries: [q],
      evidence: await retrieveEvidence(tenantId, q, topK, { useReranker }),
    };
  }

  // Broad → Multi Query
  if (analysis.needsMultiQuery) {
    const queries = await createMultiQueryGenerator().expand(
      query,
      config.queryIntelligence.multiQueryCount,
    );
    const effective = queries.length > 1 ? queries : [query];
    return {
      effectiveQueries: effective,
      evidence: await retrieveEvidenceMulti(tenantId, effective, topK, useReranker),
    };
  }

  // Conceptual → HyDE
  if (analysis.needsHyDE) {
    const hypo = await createHydeGenerator().generate(query);
    if (hypo) {
      return {
        effectiveQueries: [hypo],
        evidence: await retrieveEvidence(tenantId, hypo, topK, { useReranker }),
      };
    }
  }

  // Simple → Direct
  return {
    effectiveQueries: [query],
    evidence: await retrieveEvidence(tenantId, query, topK, { useReranker }),
  };
}

/** 仅分析 + 路由（/search/analyze 调试端点用，不检索） */
export async function analyzeAndRoute(
  query: string,
  topK?: number,
): Promise<{ analysis: QueryAnalysis; plan: RetrievalPlan }> {
  const analysis = await analyzeQuery(query);
  const plan = await routeQuery(query, analysis, topK);
  return { analysis, plan };
}
