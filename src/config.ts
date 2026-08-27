export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://rag:rag@localhost:5432/rag",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  // 每轮 Reconciliation 扫描间隔（毫秒）
  reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS ?? 5_000),
  // Outbox 事件重试退避基数（毫秒）
  outboxRetryBaseMs: Number(process.env.OUTBOX_RETRY_BASE_MS ?? 1_000),
  // Qdrant（Vector Search，Phase 2）
  qdrantUrl: process.env.QDRANT_URL ?? "http://localhost:6333",
  qdrantApiKey: process.env.QDRANT_API_KEY ?? undefined,
  // OpenSearch（Keyword Search / BM25，Phase 3）
  opensearchUrl: process.env.OPENSEARCH_URL ?? "http://localhost:9200",
  // Neo4j（Knowledge Graph，Phase 6）
  neo4jUrl: process.env.NEO4J_URL ?? "bolt://localhost:7687",
  neo4jUser: process.env.NEO4J_USER ?? "neo4j",
  neo4jPassword: process.env.NEO4J_PASSWORD ?? "ragrag1234",
  // Embedding / LLM Provider（OpenAI 兼容；未配置 key 时回退到确定性实现）
  embedding: {
    model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 384),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.LLM_MODEL ?? "gpt-4o-mini",
  },
  // 检索默认 topK
  defaultTopK: Number(process.env.DEFAULT_TOP_K ?? 6),
  // 图遍历默认最大跳数
  defaultMaxHops: Number(process.env.DEFAULT_MAX_HOPS ?? 2),
};