/**
 * Retriever 层（§16）：统一检索入口。
 *
 * 流程：VectorRetriever（向量路）与 KeywordRetriever（关键词路）并行检索
 * → RRF 融合（rrf.ts）去量纲合并 → 回表 parent content 组装 Evidence
 * → Reranker 重排（reranker.ts，可选）。
 *
 * 容错（§23.1）：关键词索引不可用时降级为纯向量路；
 * 版本过滤在回表阶段兜底（assembleEvidence 内二次校验）。
 */
import { inArray } from "drizzle-orm";
import { config } from "../config.js";
import { withTenantTx } from "../db/index.js";
import { chunks, type ChunkRow } from "../db/schema/chunk.js";
import { getEmbedding, getVectorStore } from "../indexing/vector.js";
import { getKeywordStore, type KeywordHit } from "../indexing/keyword.js";
import { reciprocalRankFusion } from "../ranking/rrf.js";
import { getReranker } from "../ranking/reranker.js";

/**
 * Retriever 抽象（§16）：Query Pipeline 只依赖接口，不绑定具体索引实现。
 * documentIds 用于版本过滤：限定只在这些文档的 chunk 内检索。
 * vector 为预嵌入的查询向量：multi-query 批量路径复用一次 API 请求的结果（§23.2）。
 */
export interface Retriever {
  retrieve(
    tenantId: string,
    query: string,
    topK: number,
    documentIds?: string[],
    vector?: number[],
  ): Promise<RetrievalHit[]>;
}

/** 归一化命中的证据：id 即 chunkId，统一检索来源的相对排序 */
export interface RetrievalHit {
  id: string;
  score: number;
  source: "vector" | "keyword";
}

/** 向量路检索：query 嵌入 -> Qdrant 相似度检索 -> 归一化为 RetrievalHit */
export class VectorRetriever implements Retriever {
  async retrieve(
    tenantId: string,
    query: string,
    topK: number,
    documentIds?: string[],
    vector?: number[],
  ): Promise<RetrievalHit[]> {
    // query 向量化；无向量（如空文本）时直接返回空。
    // 传入 vector 时复用调用方批量嵌入的结果，省去本路重复调用 API（§23.2）
    const v = vector ?? (await getEmbedding().embed([query]))[0];
    if (!v || v.length === 0) return [];
    const hits = await getVectorStore().search(tenantId, v, topK, {
      documentIds,
    });
    return hits.map((h) => ({
      id: String(h.payload.chunkId ?? h.id),
      score: h.score,
      source: "vector" as const,
    }));
  }
}

/** 关键词路检索：OpenSearch BM25 检索；索引不可用时降级为空结果 */
export class KeywordRetriever implements Retriever {
  async retrieve(
    tenantId: string,
    query: string,
    topK: number,
    documentIds?: string[],
  ): Promise<RetrievalHit[]> {
    let hits: KeywordHit[];
    try {
      hits = await getKeywordStore().search(tenantId, query, topK, {
        documentIds,
      });
    } catch {
      // 降级：关键词索引不可用时返回空，仅靠向量路（§23.1）
      hits = [];
    }
    return hits.map((h) => ({
      id: String(h.payload.chunkId ?? h.id),
      score: h.score,
      source: "keyword" as const,
    }));
  }
}

/** 检索命中的证据：child 为检索单元，parent 内容作为 LLM 上下文（§6、§18）。 */
export interface Evidence {
  id: string;
  chunkId: string;
  parentId: string | null;
  documentId: string;
  title: string;
  content: string;
  /** 最终分数：重排后为重排分，未重排时为融合分 */
  score: number;
  source: "vector" | "keyword" | "hybrid";
  vectorScore?: number;
  keywordScore?: number;
  fusionScore?: number;
  rerankScore?: number;
}

/** 证据数低于该阈值时跳过 LLM 重排：融合分排序已足够可信，省一次 LLM 调用（§23.2） */
export const RERANK_MIN_EVIDENCE = 4;

/**
 * 竞速超时（§23.1，落地 RetrievalPlan.timeout）：到点未完成则返回 onTimeout 的降级值，
 * 真正的基础设施错误照常抛出（不掩盖故障，只解决"无限等待"）。
 * 注意：仅"停止等待"，底层 HTTP 请求不会被中断，避免引入 AbortController 级联复杂度。
 */
function raceTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => T,
  label: string,
): Promise<T> {
  if (ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[retriever] ${label} 超过 ${ms}ms 未返回，降级为空结果`);
      resolve(onTimeout());
    }, ms);
  });
  // 竞速已由超时胜出后，原 promise 的失败不再有人接：提前挂接空 catch 避免 unhandled rejection
  p.catch(() => {});
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** 召回段结果：融合排序的 chunkId 与各路得分/来源标注，回表由调用方决定时机 */
export interface HybridRecall {
  /** 融合后的 chunkId（按融合分降序，已截取 topK） */
  ids: string[];
  vectorScore: Map<string, number>;
  keywordScore: Map<string, number>;
  fusionScore: Map<string, number>;
  sourceById: Map<string, "vector" | "keyword" | "hybrid">;
}

/**
 * 召回段（§10 前半）：Vector + Keyword 并行检索（各路受超时降级约束，§23.1）
 * → RRF 融合取 topK。不回表：回表时机由调用方决定
 * （单查询立即回表一次；multi-query 在全局 RRF 融合后统一回表一次，§23.2）。
 */
export async function hybridRecall(
  tenantId: string,
  query: string,
  topK: number,
  opts: {
    documentIds?: string[];
    vector?: number[];
    timeoutMs?: number;
  } = {},
): Promise<HybridRecall> {
  const timeoutMs = opts.timeoutMs ?? config.retrieverTimeoutMs;

  // 并行执行两路检索：向量（语义）检索 + 关键词（BM25）检索，各取 topK 条
  const [vectorHits, keywordHits] = await Promise.all([
    raceTimeout(
      new VectorRetriever().retrieve(
        tenantId,
        query,
        topK,
        opts.documentIds,
        opts.vector,
      ),
      timeoutMs,
      () => [] as RetrievalHit[],
      "vector",
    ),
    raceTimeout(
      new KeywordRetriever().retrieve(tenantId, query, topK, opts.documentIds),
      timeoutMs,
      () => [] as RetrievalHit[],
      "keyword",
    ),
  ]);

  const vectorScore = new Map(vectorHits.map((h) => [h.id, h.score]));
  const keywordScore = new Map(keywordHits.map((h) => [h.id, h.score]));

  // RRF 融合：将两路各自的排序位置折算为融合分，取 topK
  const fused = reciprocalRankFusion([
    vectorHits.map((h, i) => ({ source: "vector", id: h.id, rank: i + 1 })),
    keywordHits.map((h, i) => ({ source: "keyword", id: h.id, rank: i + 1 })),
  ]).slice(0, topK);

  const fusionScore = new Map(fused.map((f) => [f.id, f.score]));
  const sourceById = new Map(
    fused.map((f) => [
      f.id,
      (f.sources.length > 1
        ? "hybrid"
        : (f.sources[0] ?? "hybrid")) as "vector" | "keyword" | "hybrid",
    ]),
  );

  return {
    ids: fused.map((f) => f.id),
    vectorScore,
    keywordScore,
    fusionScore,
    sourceById,
  };
}

/** 回表 parent content + 文档元数据，按 childIds 顺序组装证据片段 */
export async function assembleEvidence(
  tenantId: string,
  childIds: string[],
  documentIds?: string[],
): Promise<Evidence[]> {
  return withTenantTx(tenantId, async (tx) => {
    const childRows = await tx
      .select()
      .from(chunks)
      .where(inArray(chunks.id, childIds));
    const childById = new Map(childRows.map((c) => [c.id, c]));

    const parentIds = childRows
      .map((c) => c.parentId)
      .filter((p): p is string => p !== null);
    const parentById = new Map<string, ChunkRow>();
    if (parentIds.length > 0) {
      const parentRows = await tx
        .select()
        .from(chunks)
        .where(inArray(chunks.id, parentIds));
      for (const p of parentRows) parentById.set(p.id, p);
    }

    return childIds
      .map((id, i): Evidence | null => {
        const child = childById.get(id);
        if (!child) return null;
        // 版本过滤兜底：即使索引侧漏过滤，回表后也丢弃非版本文档的 chunk
        if (documentIds && !documentIds.includes(child.documentId)) return null;
        const parent = child.parentId ? parentById.get(child.parentId) : undefined;
        const title =
          typeof child.metadata.title === "string" ? child.metadata.title : "";
        return {
          id: `ev_${i + 1}`,
          chunkId: child.id,
          parentId: child.parentId ?? null,
          documentId: child.documentId,
          title,
          content: parent?.content ?? child.content,
          score: 0,
          source: "hybrid",
        };
      })
      .filter((e): e is Evidence => e !== null);
  });
}

/**
 * Hybrid 检索（§10）：Vector + Keyword 并行检索 → RRF 融合 → 回表 Evidence →
 * Rerank 重排（§19）。关键词路故障时降级为纯向量。
 * opts.useReranker=false 时跳过重排，按融合分排序返回（§23.1 降级路径，
 * 由 RetrievalPlan.useReranker 驱动，§15）。
 */
export interface RetrieveOptions {
  useReranker?: boolean;
  /** 版本过滤：限定只在这些文档的 chunk 内检索 */
  documentIds?: string[];
  /** 预嵌入的查询向量：multi-query 批量路径复用一次 API 请求的向量（§23.2） */
  vector?: number[];
  /** 单路检索超时（毫秒）：来自 RetrievalPlan.timeout，缺省用全局配置 */
  timeoutMs?: number;
}

/**
 * 检索证据（§10 主入口）：对 query 做混合检索并返回按相关度排序的证据列表。
 *
 * 流程：
 * 1. 并行执行 Vector（向量）与 Keyword（关键词）两路检索，各取 topK 条；
 * 2. 对两路结果做 RRF（Reciprocal Rank Fusion）融合，按融合分截取 topK；
 * 3. 根据融合出的 chunkId 回表 PostgreSQL 组装完整 Evidence（含原文、标题、父子块等）；
 * 4. 合并各路得分（vectorScore / keywordScore / fusionScore）并标注来源 source
 *    （仅向量→"vector"，仅关键词→"keyword"，双路命中→"hybrid"）；
 * 5. 默认用 Reranker 重排（§19）；opts.useReranker=false 时跳过重排，
 *    直接按融合分排序返回（§23.1 降级路径，由 RetrievalPlan.useReranker 驱动，§15）。
 *
 * @param tenantId 租户 ID，用于多租户隔离
 * @param query    用户查询文本
 * @param topK     返回的证据条数上限
 * @param opts     检索选项，如关闭重排、限定文档范围
 * @returns 按相关度排序的 Evidence 数组
 */
export async function retrieveEvidence(
  tenantId: string,
  query: string,
  topK: number,
  opts: RetrieveOptions = {},
): Promise<Evidence[]> {
  const { documentIds } = opts;

  // 1-2. 召回段：并行两路检索（各路受超时降级约束，§23.1）→ RRF 融合取 topK
  const recall = await hybridRecall(tenantId, query, topK, {
    documentIds: opts.documentIds,
    vector: opts.vector,
    timeoutMs: opts.timeoutMs,
  });

  // 没有命中直接返回空
  if (recall.ids.length === 0) return [];

  // 3. 按融合出的 chunkId 回表数据库，组装完整 Evidence（原文、标题、父子块等）
  const evidence = await assembleEvidence(tenantId, recall.ids, documentIds);

  // 4. 合并各路得分与来源，默认以融合分作为排序依据
  for (const e of evidence) {
    e.vectorScore = recall.vectorScore.get(e.chunkId);
    e.keywordScore = recall.keywordScore.get(e.chunkId);
    e.fusionScore = recall.fusionScore.get(e.chunkId);
    e.source = (recall.sourceById.get(e.chunkId) ??
      "hybrid") as Evidence["source"];
    e.score = e.fusionScore ?? 0;
  }

  // 关闭重排的降级路径：直接按融合分排序返回
  if (opts.useReranker === false) {
    return evidence;
  }

  // 证据过少时跳过重排：2~3 条证据按融合分排序已足够可信，避免多付一次 LLM 调用
  if (evidence.length < RERANK_MIN_EVIDENCE) {
    return evidence;
  }

  // 5. Rerank 重排：以融合分为输入，交给 Reranker 重新打分排序
  const reranked = await getReranker().rerank(
    query,
    evidence.map((e) => ({
      id: e.chunkId,
      content: e.content,
      score: e.fusionScore ?? e.score,
    })),
  );

  // 按重排后的顺序重建 Evidence，覆盖 score / rerankScore / 证据 id
  const byChunk = new Map(evidence.map((e) => [e.chunkId, e]));
  const ordered: Evidence[] = [];
  for (const r of reranked) {
    const e = byChunk.get(r.id);
    if (!e) continue;
    e.rerankScore = r.score;
    e.score = r.score;
    e.id = `ev_${ordered.length + 1}`;
    ordered.push(e);
  }

  return ordered;
}
