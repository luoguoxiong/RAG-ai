import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "../config.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "../ai/embedding.js";

/** collection-per-tenant：租户间强隔离（§24.1） */
export function collectionName(tenantId: string): string {
  return `tenant_${tenantId.replace(/-/g, "")}`;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface VectorHit {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export class VectorStore {
  private readonly client: QdrantClient;
  private readonly dims: number;
  /** 进程内已确认存在的 collection：省每次检索的 collectionExists HTTP 往返（§23.2） */
  private readonly readyCollections = new Set<string>();
  /** 并发去重：同一 collection 的初始化检查同时只发一次请求 */
  private readonly pendingEnsures = new Map<string, Promise<void>>();

  constructor(opts: { url: string; apiKey?: string; dims: number }) {
    this.client = new QdrantClient({
      url: opts.url,
      apiKey: opts.apiKey,
      checkCompatibility: false,
    });
    this.dims = opts.dims;
  }

  async ensureCollection(tenantId: string): Promise<void> {
    const name = collectionName(tenantId);
    if (this.readyCollections.has(name)) return;
    const inflight = this.pendingEnsures.get(name);
    if (inflight) return inflight;
    const task = (async () => {
      const exists = await this.client.collectionExists(name);
      if (!exists.exists) {
        await this.client.createCollection(name, {
          vectors: { size: this.dims, distance: "Cosine" },
        });
      }
      // 成功后才标记：失败留给下次调用重试
      this.readyCollections.add(name);
    })().finally(() => this.pendingEnsures.delete(name));
    this.pendingEnsures.set(name, task);
    return task;
  }

  async upsert(tenantId: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;
    await this.ensureCollection(tenantId);
    await this.client.upsert(collectionName(tenantId), { wait: true, points });
  }

  async delete(tenantId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureCollection(tenantId);
    await this.client.delete(collectionName(tenantId), { wait: true, points: ids });
  }

  async search(
    tenantId: string,
    vector: number[],
    topK: number,
    opts?: { documentIds?: string[] },
  ): Promise<VectorHit[]> {
    await this.ensureCollection(tenantId);
    const filter =
      opts?.documentIds && opts.documentIds.length > 0
        ? {
            must: [
              { key: "documentId", match: { any: opts.documentIds } as never },
            ],
          }
        : undefined;
    const res = await this.client.query(collectionName(tenantId), {
      query: vector,
      limit: topK,
      with_payload: true,
      filter,
    });
    return res.points.map((p) => ({
      id: String(p.id),
      score: p.score,
      payload: (p.payload ?? {}) as Record<string, unknown>,
    }));
  }
}

let _embedding: EmbeddingProvider | undefined;
let _store: VectorStore | undefined;

export function getEmbedding(): EmbeddingProvider {
  if (!_embedding) _embedding = createEmbeddingProvider();
  return _embedding;
}

export function getVectorStore(): VectorStore {
  if (!_store) {
    _store = new VectorStore({
      url: config.qdrantUrl,
      apiKey: config.qdrantApiKey,
      dims: getEmbedding().dimensions(),
    });
  }
  return _store;
}