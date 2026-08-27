import { inArray } from "drizzle-orm";
import { withTenantTx } from "../db/index.js";
import { chunks, type ChunkRow } from "../db/schema/chunk.js";
import { getEmbedding, getVectorStore } from "../indexing/vector.js";
import { getKeywordStore, type KeywordHit } from "../indexing/keyword.js";
import { reciprocalRankFusion } from "../ranking/rrf.js";
import { getReranker } from "../ranking/reranker.js";

/**
 * Retriever 抽象（§16）：Query Pipeline 只依赖接口，不绑定具体索引实现。
 */
export interface Retriever {
  retrieve(tenantId: string, query: string, topK: number): Promise<RetrievalHit[]>;
}

/** 归一化命中的证据：id 即 chunkId，统一检索来源的相对排序 */
export interface RetrievalHit {
  id: string;
  score: number;
  source: "vector" | "keyword";
}

export class VectorRetriever implements Retriever {
  async retrieve(tenantId: string, query: string, topK: number): Promise<RetrievalHit[]> {
    const [vector] = await getEmbedding().embed([query]);
    if (!vector) return [];
    const hits = await getVectorStore().search(tenantId, vector, topK);
    return hits.map((h) => ({
      id: String(h.payload.chunkId ?? h.id),
      score: h.score,
      source: "vector" as const,
    }));
  }
}

export class KeywordRetriever implements Retriever {
  async retrieve(tenantId: string, query: string, topK: number): Promise<RetrievalHit[]> {
    let hits: KeywordHit[];
    try {
      hits = await getKeywordStore().search(tenantId, query, topK);
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

/** 回表 parent content + 文档元数据，按 childIds 顺序组装证据片段 */
async function assembleEvidence(
  tenantId: string,
  childIds: string[],
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
}

export async function retrieveEvidence(
  tenantId: string,
  query: string,
  topK: number,
  opts: RetrieveOptions = {},
): Promise<Evidence[]> {
  const [vectorHits, keywordHits] = await Promise.all([
    new VectorRetriever().retrieve(tenantId, query, topK),
    new KeywordRetriever().retrieve(tenantId, query, topK),
  ]);

  const vectorScore = new Map(vectorHits.map((h) => [h.id, h.score]));
  const keywordScore = new Map(keywordHits.map((h) => [h.id, h.score]));

  const fused = reciprocalRankFusion([
    vectorHits.map((h, i) => ({ source: "vector", id: h.id, rank: i + 1 })),
    keywordHits.map((h, i) => ({ source: "keyword", id: h.id, rank: i + 1 })),
  ]).slice(0, topK);

  if (fused.length === 0) return [];

  const fusionScore = new Map(fused.map((f) => [f.id, f.score]));
  const sourceById = new Map(
    fused.map((f) => [
      f.id,
      f.sources.length > 1 ? "hybrid" : (f.sources[0] ?? "hybrid"),
    ]),
  );

  const evidence = await assembleEvidence(
    tenantId,
    fused.map((f) => f.id),
  );

  for (const e of evidence) {
    e.vectorScore = vectorScore.get(e.chunkId);
    e.keywordScore = keywordScore.get(e.chunkId);
    e.fusionScore = fusionScore.get(e.chunkId);
    e.source = (sourceById.get(e.chunkId) ??
      "hybrid") as Evidence["source"];
    e.score = e.fusionScore ?? 0;
  }

  if (opts.useReranker === false) {
    return evidence;
  }

  const reranked = await getReranker().rerank(
    query,
    evidence.map((e) => ({
      id: e.chunkId,
      content: e.content,
      score: e.fusionScore ?? e.score,
    })),
  );

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
