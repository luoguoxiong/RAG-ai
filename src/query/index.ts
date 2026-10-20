import { config } from "../config.js";
import {
  hybridRecall,
  assembleEvidence,
  retrieveEvidence,
  RERANK_MIN_EVIDENCE,
  type Evidence,
} from "../retrieval/retriever.js";
import { getEmbedding } from "../indexing/vector.js";
import { reciprocalRankFusion } from "../ranking/rrf.js";
import { getReranker } from "../ranking/reranker.js";
import { type QueryAnalysis } from "./analyzer.js";
import { analyzeAndPlan, type RetrievalPlan } from "./router.js";
import { createQueryRewriter } from "./rewrite.js";
import { createMultiQueryGenerator } from "./multi-query.js";
import { createHydeGenerator } from "./hyde.js";

/**
 * Query Intelligence（§13-15，Phase 5）编排：
 * Analyze+Route（低置信合并为一次 LLM 调用，§23.2）→ Transform → Retrieve。
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

/**
 * 多查询检索（§10 + §23.2）：
 * 各变体并行召回（hybridRecall，仅向量+关键词+RRF，不回表不重排）
 * → 全局 RRF 融合出最终 topK → 统一回表一次 → 统一重排一次。
 * 原实现每变体各付一次回表事务（N 路 = N 事务 2N 次查询），现只在融合后回表一次。
 */
async function retrieveEvidenceMulti(
  tenantId: string,
  query: string,
  queries: string[],
  topK: number,
  useReranker: boolean,
  documentIds?: string[],
  timeoutMs?: number,
): Promise<Evidence[]> {
  // 向量批量嵌入：所有变体合并为一次 API 请求（§23.2），避免 N 路重复调用 embedding
  const vectors = await getEmbedding().embed(queries);
  // 各变体并行召回：useReranker 阶段性跳过（重排统一放在融合之后，全程只付一次 LLM）
  const recalls = await Promise.all(
    queries.map((q, i) =>
      hybridRecall(tenantId, q, topK, {
        documentIds,
        vector: vectors[i],
        timeoutMs,
      }),
    ),
  );

  // 全局 RRF：每个变体的融合排序作为一个 rank list，融合出最终 topK
  const rankLists = recalls.map((r) =>
    r.ids.map((id, i) => ({ source: "hybrid", id, rank: i + 1 })),
  );
  const fused = reciprocalRankFusion(rankLists).slice(0, topK);
  if (fused.length === 0) return [];

  // 统一回表一次：只为最终 topK 付回表开销（版本过滤兜底仍在 assembleEvidence 内）
  const evidence = await assembleEvidence(
    tenantId,
    fused.map((f) => f.id),
    documentIds,
  );
  if (evidence.length === 0) return [];
  // 回表可能过滤掉部分 chunk，按最终顺序重新编号
  evidence.forEach((e, i) => {
    e.id = `ev_${i + 1}`;
  });

  // 合并各变体得分与来源：分值取任一命中值，来源跨变体取并集
  const fusionScore = new Map(fused.map((f) => [f.id, f.score]));
  const sourcesByChunk = new Map<string, Set<Evidence["source"]>>();
  for (const r of recalls) {
    for (const [id, s] of r.sourceById) {
      let set = sourcesByChunk.get(id);
      if (!set) {
        set = new Set();
        sourcesByChunk.set(id, set);
      }
      set.add(s);
    }
  }
  for (const e of evidence) {
    for (const r of recalls) {
      if (e.vectorScore === undefined) {
        e.vectorScore = r.vectorScore.get(e.chunkId);
      }
      if (e.keywordScore === undefined) {
        e.keywordScore = r.keywordScore.get(e.chunkId);
      }
    }
    e.fusionScore = fusionScore.get(e.chunkId);
    const sources = sourcesByChunk.get(e.chunkId);
    e.source =
      !sources || sources.size !== 1 ? "hybrid" : ([...sources][0] ?? "hybrid");
    e.score = e.fusionScore ?? 0;
  }

  // 融合后统一重排一次：各变体检索阶段已跳过重排，故全程只付一次 LLM 调用
  if (useReranker && evidence.length >= RERANK_MIN_EVIDENCE) {
    const reranked = await getReranker().rerank(
      query,
      evidence.map((e) => ({ id: e.chunkId, content: e.content, score: e.score })),
    );
    const byChunk = new Map(evidence.map((e) => [e.chunkId, e]));
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

  return evidence;
}

/** Analyze + Route → Transform → Retrieve 全链路 */
export async function runQueryIntelligence(
  tenantId: string,
  query: string,
  topK?: number,
  documentIds?: string[],
  /** 可选覆盖：Multi Query 变体数（自优化 Agent 调参用），缺省用全局配置 */
  opts?: { multiQueryCount?: number },
): Promise<QueryIntelligenceResult> {
  const k = topK ?? config.defaultTopK;
  // 1) 分析 + 路由：规则高置信直连（零 LLM）；
  //    低置信时一次 LLM 同时产出 analysis + plan（原两次串行调用合并，§23.2）
  const { analysis, plan } = await analyzeAndPlan(query, k);
  // 3) 变换 + 检索：按分析结果选择 Rewrite / Multi Query / HyDE / Direct
  const { effectiveQueries, evidence } = await transformAndRetrieve(
    tenantId,
    query,
    analysis,
    plan,
    k,
    documentIds,
    opts?.multiQueryCount,
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
  multiQueryCount?: number,
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
        timeoutMs: plan.timeout,
      }),
    };
  }

  // Broad → Multi Query
  if (analysis.needsMultiQuery) {
    const queries = await createMultiQueryGenerator().expand(
      query,
      multiQueryCount ?? config.queryIntelligence.multiQueryCount,
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
        plan.timeout,
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
          timeoutMs: plan.timeout,
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
      timeoutMs: plan.timeout,
    }),
  };
}

/** 仅分析 + 路由（/search/analyze 调试端点用，不检索） */
export async function analyzeAndRoute(
  query: string,
  topK?: number,
): Promise<{ analysis: QueryAnalysis; plan: RetrievalPlan }> {
  return analyzeAndPlan(query, topK);
}
