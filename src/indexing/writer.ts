import type { ChunkRow } from "../db/schema/chunk.js";
import { getEmbedding, getVectorStore } from "./vector.js";
import { getKeywordStore } from "./keyword.js";

/**
 * IndexWriter：派生索引写入抽象（§9 Indexer、§4 派生索引）。
 *
 * 仅 child chunk 参与向量 / 关键词索引，parent chunk 只作为检索后的
 * 上下文材料（§6 Parent-Child Retrieval）。
 */
export interface IndexWriter {
  upsert(tenantId: string, chunk: ChunkRow): Promise<void>;
  remove(tenantId: string, chunkId: string): Promise<void>;
}

export function createVectorIndexWriter(): IndexWriter {
  const embedding = getEmbedding();
  const store = getVectorStore();

  return {
    async upsert(tenantId, chunk) {
      if (chunk.type !== "child") return;
      const [vector] = await embedding.embed([chunk.content]);
      if (!vector) throw new Error("embedding returned empty vector");
      await store.upsert(tenantId, [
        {
          id: chunk.id,
          vector,
          payload: {
            chunkId: chunk.id,
            parentId: chunk.parentId ?? null,
            documentId: chunk.documentId,
            documentVersionId: chunk.documentVersionId,
            title: (chunk.metadata as Record<string, unknown>).title ?? "",
            chunkIndex: chunk.chunkIndex,
          },
        },
      ]);
    },

    async remove(tenantId, chunkId) {
      await store.delete(tenantId, [chunkId]);
    },
  };
}

export function createKeywordIndexWriter(): IndexWriter {
  const store = getKeywordStore();

  return {
    async upsert(tenantId, chunk) {
      if (chunk.type !== "child") return;
      await store.upsert(tenantId, {
        id: chunk.id,
        content: chunk.content,
        payload: {
          chunkId: chunk.id,
          parentId: chunk.parentId ?? null,
          documentId: chunk.documentId,
          documentVersionId: chunk.documentVersionId,
          title: (chunk.metadata as Record<string, unknown>).title ?? "",
          chunkIndex: chunk.chunkIndex,
        },
      });
    },

    async remove(tenantId, chunkId) {
      await store.delete(tenantId, chunkId);
    },
  };
}

/** Hybrid 组合写入：向量 + 关键词（§7.1 多路派生索引幂等写入） */
export function createHybridIndexWriter(): IndexWriter {
  const vector = createVectorIndexWriter();
  const keyword = createKeywordIndexWriter();

  return {
    async upsert(tenantId, chunk) {
      await Promise.all([
        vector.upsert(tenantId, chunk),
        keyword.upsert(tenantId, chunk),
      ]);
    },

    async remove(tenantId, chunkId) {
      await Promise.all([
        vector.remove(tenantId, chunkId),
        keyword.remove(tenantId, chunkId),
      ]);
    },
  };
}
