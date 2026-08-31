import { config } from "../config.js";
import {
  retrieveEvidence,
  RERANK_MIN_EVIDENCE,
  type Evidence,
} from "../retrieval/retriever.js";
import { getEmbedding } from "../indexing/vector.js";
import { reciprocalRankFusion } from "../ranking/rrf.js";
import { getReranker } from "../ranking/reranker.js";
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

/** 多查询检索：每条变体独立混合检索（仅召回不重排），RRF 融合后统一重排一次（§10） */
async function retrieveEvidenceMulti(
  tenantId: string,
  query: string,
  queries: string[],
  topK: number,
  useReranker: boolean,
  documentIds?: string[],
): Promise<Evidence[]> {
  // 各变体只按融合分召回（useReranker=false 跳过每路 LLM 重排，省 N-1 次调用），
  // 重排统一放在 RRF 融合之后做一次；
  // 向量批量嵌入：所有变体合并为一次 API 请求（§23.2），避免 N 路重复调用 embedding
  const vectors = await getEmbedding().embed(queries);
  const results = await Promise.all(
    queries.map((q, i) =>
      retrieveEvidence(tenantId, q, topK, {
        useReranker: false,
        documentIds,
        vector: vectors[i],
      }),
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

  // 融合后统一重排一次：各变体检索阶段已跳过重排，故全程只付一次 LLM 调用
  if (useReranker && ordered.length >= RERANK_MIN_EVIDENCE) {
    const reranked = await getReranker().rerank(
      query,
      ordered.map((e) => ({ id: e.chunkId, content: e.content, score: e.score })),
    );
    const byChunk = new Map(ordered.map((e) => [e.chunkId, e]));
    const reordered: Evidence[] = [];
    for (const r of reranked) {
      const e = byChunk.get(r.id);
      if (!e) continue;
      e.rerankScore = r.score;
      e.score = r.score;
      e.id = `ev_${reordered.length + 1}`;
      reordered.push(e);
    }
    return reordered;
  }

  return ordered;
}

/** Analyze → Route → Transform → Retrieve 全链路 */
export async function runQueryIntelligence(
  tenantId: string,
  query: string,
  topK?: number,
  documentIds?: string[],
): Promise<QueryIntelligenceResult> {
  const k = topK ?? config.defaultTopK;
  // 1) 分析：规则优先，低置信且有 API key 时升级 LLM 分析
  const analysis = await analyzeQuery(query);
  // 2) 路由：高置信直连规则路由，低置信走 LLM 路由
  const plan = await routeQuery(query, analysis, k);
  // 3) 变换 + 检索：按分析结果选择 Rewrite / Multi Query / HyDE / Direct
  const { effectiveQueries, evidence } = await transformAndRetrieve(
    tenantId,
    query,
    analysis,
    plan,
    k,
    documentIds,
  );
  // 附带 analysis/plan/effectiveQueries 供可观测性（§23）
  return { analysis, plan, effectiveQueries, evidence };
}

/** 变换 + 检索：按分析结果选择一种变换，其余走直连 */
export async function transformAndRetrieve(
  tenantId: string,
  query: string,
  analysis: QueryAnalysis,
  plan: RetrievalPlan,
  topK: number,
  documentIds?: string[],
): Promise<{ effectiveQueries: string[]; evidence: Evidence[] }> {
  const useReranker = plan.useReranker;

  // Ambiguous → Rewrite
  if (analysis.needsRewrite) {
    const rewritten = await createQueryRewriter().rewrite(query);
    const q = rewritten.trim() || query;
    return {
      effectiveQueries: [q],
      evidence: await retrieveEvidence(tenantId, q, topK, {
        useReranker,
        documentIds,
      }),
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
      evidence: await retrieveEvidenceMulti(
        tenantId,
        query,
        effective,
        topK,
        useReranker,
        documentIds,
      ),
    };
  }

  // Conceptual → HyDE
  if (analysis.needsHyDE) {
    const hypo = await createHydeGenerator().generate(query);
    if (hypo) {
      return {
        effectiveQueries: [hypo],
        evidence: await retrieveEvidence(tenantId, hypo, topK, {
          useReranker,
          documentIds,
        }),
      };
    }
  }

  // Simple → Direct
  return {
    effectiveQueries: [query],
    evidence: await retrieveEvidence(tenantId, query, topK, {
      useReranker,
      documentIds,
    }),
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
