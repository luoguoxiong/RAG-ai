import { Client } from "@opensearch-project/opensearch";
import { config } from "../config.js";

/** index-per-tenant：与 Qdrant collection-per-tenant 对齐（§24.1 租户隔离） */
export function indexName(tenantId: string): string {
  return `tenant_${tenantId.replace(/-/g, "")}`;
}

export interface KeywordHit {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

const MAPPINGS = {
  properties: {
    chunkId: { type: "keyword" },
    documentId: { type: "keyword" },
    documentVersionId: { type: "keyword" },
    parentId: { type: "keyword" },
    title: { type: "text" },
    content: { type: "text" },
    chunkIndex: { type: "integer" },
  },
} as const;

/**
 * KeywordStore：派生的关键词索引（§4 派生索引、§25 OpenSearch / BM25）。
 * 仅存 child chunk 作为检索单元；content 走默认 BM25 匹配。
 */
export class KeywordStore {
  private readonly client: Client;

  constructor(opts: { url: string }) {
    this.client = new Client({ node: opts.url });
  }

  async ensureIndex(tenantId: string): Promise<void> {
    const name = indexName(tenantId);
    const exists = await this.client.indices.exists({ index: name });
    if (exists.body) return;
    await this.client.indices.create({
      index: name,
      body: { mappings: MAPPINGS },
    });
  }

  async upsert(
    tenantId: string,
    doc: { id: string; content: string; payload: Record<string, unknown> },
  ): Promise<void> {
    await this.ensureIndex(tenantId);
    await this.client.index({
      index: indexName(tenantId),
      id: doc.id,
      refresh: true,
      body: { content: doc.content, ...doc.payload },
    });
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.ensureIndex(tenantId);
    try {
      await this.client.delete({ index: indexName(tenantId), id });
    } catch (err) {
      // 幂等：文档不存在（如 parent 从未落索引）返回 404，视为已删除
      const status = (err as { statusCode?: number }).statusCode;
      if (status !== 404) throw err;
    }
  }

  async search(
    tenantId: string,
    query: string,
    topK: number,
    opts?: { documentIds?: string[] },
  ): Promise<KeywordHit[]> {
    await this.ensureIndex(tenantId);
    const body =
      opts?.documentIds && opts.documentIds.length > 0
        ? {
            size: topK,
            query: {
              bool: {
                must: [{ match: { content: query } }],
                filter: [{ terms: { documentId: opts.documentIds } }],
              },
            },
          }
        : { size: topK, query: { match: { content: query } } };
    const res = await this.client.search({
      index: indexName(tenantId),
      body,
    });
    const hits = res.body.hits.hits as Array<{
      _id?: string;
      _score?: number | null;
      _source?: Record<string, any>;
    }>;
    return hits.map((h) => ({
      id: String(h._id),
      score: h._score ?? 0,
      payload: (h._source ?? {}) as Record<string, unknown>,
    }));
  }
}

let _store: KeywordStore | undefined;

export function getKeywordStore(): KeywordStore {
  if (!_store) _store = new KeywordStore({ url: config.opensearchUrl });
  return _store;
}
