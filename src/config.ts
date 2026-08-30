import { existsSync } from "node:fs";
import { resolve } from "node:path";

// tsx / node 默认不加载 .env，这里显式加载，使 .env 中的配置（含 API Key）生效。
// 依赖 Node 20.12+ 内置 process.loadEnvFile；文件缺失或解析失败时静默回退默认值。
try {
  const envFile = resolve(process.cwd(), ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
} catch {
  // ignore: 无 .env 时使用默认配置
}

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://rag:rag@localhost:5432/rag",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6380",
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
  // 火山方舟 Agent Plan（套餐）模式：开启「超额后付费」后，额度用尽会自动切换后付费，无需改配置
  // 注意：向量模型 doubao-embedding-vision 不支持 Auto 及控制台切换，必须在配置中显式指定模型名
  // 配置指南参考：https://docs.volcengine.com/docs/82379/2373738（Agent Plan 快速开始）
  embedding: {
    model: process.env.EMBEDDING_MODEL ?? "doubao-embedding-vision",
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 2048),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseUrl:
      process.env.OPENAI_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/plan/v3",
    model: process.env.LLM_MODEL ?? "doubao-seed-2.0-lite",
  },
  // 检索默认 topK
  defaultTopK: Number(process.env.DEFAULT_TOP_K ?? 6),
  // 图遍历默认最大跳数
  defaultMaxHops: Number(process.env.DEFAULT_MAX_HOPS ?? 2),
  // 社区检测（Phase 7）
  community: {
    minSize: Number(process.env.COMMUNITY_MIN_SIZE ?? 2),
  },
  // 每个 Retriever 独立超时（毫秒，RetrievalPlan.timeout，§23.1）
  retrieverTimeoutMs: Number(process.env.RETRIEVER_TIMEOUT_MS ?? 3000),
  // Query Intelligence（§13-15，Phase 5）
  queryIntelligence: {
    enabled: process.env.QUERY_INTELLIGENCE_ENABLED !== "false",
    multiQueryCount: Number(process.env.MULTI_QUERY_COUNT ?? 3),
  },
  // Evaluation（§22）：指标回退容忍度，低于基线×(1-tolerance) 视为回归（CI gate）
  evalBaselineTolerance: Number(process.env.EVAL_BASELINE_TOLERANCE ?? 0.1),
};