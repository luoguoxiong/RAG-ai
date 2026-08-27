# Production-Grade Knowledge Retrieval Platform

> 生产级 RAG / GraphRAG / Agentic Retrieval 架构方案\
> 技术方向：TypeScript + Node.js

## 1. 项目目标

构建一个可扩展的 **Knowledge Retrieval Platform（知识检索平台）**。

核心抽象：

``` text
Knowledge
    ↓
Index
    ↓
Retrieve
    ↓
Evidence
    ↓
Generate
```

未来可接入：

-   Document RAG
-   Vector Search
-   BM25 / Keyword Search
-   Graph Retrieval
-   SQL Retrieval
-   Code RAG
-   Web Search
-   API
-   Agent Tools
-   MCP

这些能力统一抽象为不同的：

``` text
Knowledge Source
Index
Retriever
```

------------------------------------------------------------------------

## 2. 核心设计目标

系统支持：

-   多文档、多租户
-   文档版本
-   增量更新、删除与重新索引
-   Vector Search
-   BM25 / Keyword Search
-   Hybrid Search
-   Graph Retrieval
-   Entity Resolution
-   Query Rewrite / Multi Query / HyDE
-   Query Router
-   RRF Fusion
-   Reranker
-   Citation
-   Evaluation
-   Observability
-   Agentic Retrieval

------------------------------------------------------------------------

## 3. 总体架构

``` text
                                    ┌──────────────────────┐
                                    │      Client / UI     │
                                    └──────────┬───────────┘
                                               │
                                               ▼
                                    ┌──────────────────────┐
                                    │      API Gateway     │
                                    │ Auth / Tenant        │
                                    │ Rate Limit / Session │
                                    └──────────┬───────────┘
                                               │
                         ┌─────────────────────┴─────────────────────┐
                         │                                           │
                         ▼                                           ▼
                INGESTION PIPELINE                          QUERY PIPELINE
                         │                                           │
                         ▼                                           ▼
                Document Registry                          Query Normalize
                         │                                           │
                         ▼                                           ▼
                 Document Version                           Query Analyzer
                         │                                           │
                         ▼                                           ▼
                 Parse / Normalize                     Query Transformation
                         │                              ┌──────┼──────┐
                         ▼                              ▼      ▼      ▼
                 Structure Extraction                Rewrite MultiQ  HyDE
                         │                                           │
                         ▼                                           ▼
                      Chunking                              Retrieval Router
                         │                           ┌────────┼────────┐
                         ▼                           ▼        ▼        ▼
                   Chunk Registry                  Vector   Keyword   Graph
                         │                           │        │        │
              ┌──────────┼──────────┐                └────────┼────────┘
              ▼          ▼          ▼                         ▼
          Embedding      FTS      Graph                   Evidence Layer
              │          │     Extraction                      │
              ▼          ▼          ▼                           ▼
          Vector DB   Search     Entity                       Fusion
                      Engine   Resolution                      │
                                   │                            ▼
                                   ▼                         Rerank
                                Neo4j                           │
                                                                ▼
                                                         Context Builder
                                                                │
                                                                ▼
                                                          LLM Generate
                                                                │
                                                                ▼
                                                            Citation
```

------------------------------------------------------------------------

## 4. 核心设计原则

### 4.1 PostgreSQL 是 Source of Truth

PostgreSQL 保存：

-   Document
-   DocumentVersion
-   Chunk
-   Entity Registry
-   Index Status
-   Job
-   Tenant
-   Metadata

其他存储属于派生索引：

``` text
PostgreSQL
    │
    ├── Vector Index
    ├── Keyword Index
    └── Graph Index
```

任何索引都必须可以从源数据重新构建。

### 4.2 索引必须可重建

支持：

-   Vector DB 损坏后重建
-   Neo4j 重建
-   Embedding Model 升级
-   Chunk 策略升级
-   全量重新索引

### 4.3 Document、Chunk、Entity 生命周期分离

``` text
Document
   │
   ▼
DocumentVersion
   │
   ▼
Chunk ─────────────► Entity
```

Entity 可以跨多个 Document 共享。

------------------------------------------------------------------------

## 5. 核心数据模型

### 5.1 Document

``` ts
export interface Document {
  id: string;
  tenantId: string;

  sourceType: "file" | "url" | "database" | "api";
  sourceUri: string;
  title?: string;

  status:
    | "pending"
    | "processing"
    | "ready"
    | "failed"
    | "deleted";

  currentVersionId?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### 5.2 DocumentVersion

``` ts
export interface DocumentVersion {
  id: string;
  tenantId: string;
  documentId: string;
  version: number;
  contentHash: string;
  rawContent?: string;
  metadata: Record<string, unknown>;

  status: "pending" | "processing" | "ready" | "failed";
  createdAt: Date;
}
```

版本模型支持：

-   增量更新
-   回滚
-   Diff
-   重新索引
-   Embedding 升级
-   Chunk 策略升级

### 5.3 Chunk

``` ts
export interface Chunk {
  id: string;
  tenantId: string;
  documentId: string;
  documentVersionId: string;

  parentId?: string;
  type: "parent" | "child";

  content: string;
  contentHash: string;
  chunkIndex: number;

  metadata: {
    title?: string;
    section?: string;
    page?: number;
    language?: string;
    [key: string]: unknown;
  };

  createdAt: Date;
}
```

推荐稳定 ID：

``` text
chunkId = hash(
  documentVersionId +
  normalizedContent
)
```

为什么不能含 `chunkIndex`：

-   `chunkIndex` 是数组位置索引。任何一次插入 / 删除 / 重切分，
    都会导致后续所有 chunk 的 ID 漂移，直接摧毁"稳定 ID"与"增量更新"。

更优方案（二选一）：

``` text
1. 内容哈希：hash(documentVersionId + normalizedContent)
   同一 document 内内容完全相同的 chunk 会碰撞，需去重合并，
   用 contentHash 判断是否已存在，命中则复用。

2. 结构定位哈希：hash(documentVersionId + sectionPath)
   用标题 / 章节路径而非数组索引，兼顾稳定性与可定位性。
```

推荐：用 `contentHash` 字段（Chunk 上已有）做增量 diff 判据，
用结构路径或内容哈希做稳定 ID，不要用 `chunkIndex`。

### 5.4 Tenant

``` ts
export interface Tenant {
  id: string;
  name: string;
  plan: "free" | "pro" | "enterprise";

  // 索引 / 检索配额
  limits: {
    maxDocuments: number;
    maxChunks: number;
    maxEmbeddingsPerDay: number;
    maxQueriesPerMinute: number;
  };

  status: "active" | "suspended" | "deleted";
  createdAt: Date;
}
```

### 5.5 Job / IndexJob

``` ts
export interface Job {
  id: string;
  tenantId: string;
  type:
    | "index_document"
    | "reindex_document"
    | "delete_document"
    | "embedding_upgrade"
    | "chunk_strategy_upgrade"
    | "reconciliation";

  status: "pending" | "processing" | "ready" | "failed";
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

`Job` 是异步任务的工作单元，`IndexStatus` 是更细粒度的结果状态，
二者配合：一个 `Job` 可能驱动多个 chunk 的 `IndexStatus` 变化。

------------------------------------------------------------------------

## 6. Parent-Child Retrieval

``` text
Parent Chunk
├── Child Chunk 1
├── Child Chunk 2
└── Child Chunk 3
```

查询流程：

``` text
Query
  ↓
Search Child Chunk
  ↓
Hit Child
  ↓
Find Parent
  ↓
Parent Context
  ↓
LLM
```

目标：

``` text
小 Chunk = 检索精准
大 Context = 上下文完整
```

------------------------------------------------------------------------

## 7. Index Registry

每个 Chunk 独立记录索引状态：

``` ts
export interface IndexStatus {
  chunkId: string;
  tenantId: string;

  vector: "pending" | "processing" | "ready" | "failed";
  keyword: "pending" | "processing" | "ready" | "failed";
  graph: "pending" | "processing" | "ready" | "failed";

  embeddingModel?: string;
  embeddingVersion?: string;
  updatedAt: Date;
}
```

这样某一路失败后可以单独重试。

### 7.1 索引一致性：Outbox + Reconciliation

PostgreSQL 是 Source of Truth，派生索引（Vector / Keyword / Graph）是
最终一致副本。多路写入必须保证"至少最终一致 + 可对账"：

``` text
PostgreSQL 事务内:
  1. 更新 Chunk / IndexStatus（source of truth）
  2. 写入 outbox 表（同一事务）

Worker:
  1. 读 outbox 事件
  2. 幂等写入派生索引（Qdrant / OpenSearch / Neo4j）
  3. 成功后标记 outbox 已消费 + IndexStatus = ready
```

关键机制：

``` text
1. Outbox Pattern
   业务变更与索引事件在同一 PG 事务提交，避免丢事件。

2. Idempotent Write
   索引写入按 chunkId 幂等（upsert / replace），
   重复消费同一条 outbox 事件不会产生脏数据。

3. Reconciliation Job（对账 / 兜底）
   定时扫描 IndexStatus != ready 的记录，重新投递事件；
   也可 diff PG 与派生索引的 ID 集合，补写缺失、清理多余。

4. Dead Letter Queue（死信）
   重试超限的事件进入 DLQ，人工排查，不阻塞主队列。
```

这样 IndexStatus 的 `pending/processing/ready/failed` 不只是状态标签，
而是对账循环的驱动信号。

------------------------------------------------------------------------

## 8. Ingestion Pipeline

``` text
Upload Document
        ↓
Create Document
        ↓
Create Document Version
        ↓
Create Index Job
        ↓
Message Queue
        ↓
Worker
        ↓
Load / Parse
        ↓
Normalize
        ↓
Structure Extraction
        ↓
Chunking
        ↓
Chunk Registry
   ┌────┼────┐
   ▼    ▼    ▼
Vector Keyword Graph
 Index  Index Extraction
                  ↓
           Entity Resolution
                  ↓
                Neo4j
```

API 使用异步任务：

``` text
POST /documents
      ↓
202 Accepted
      ↓
Job Queue
      ↓
Async Worker
```

------------------------------------------------------------------------

## 9. Index 抽象

``` ts
export interface Indexer<T> {
  index(items: T[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  rebuild?(): Promise<void>;
}
```

实现：

-   VectorIndexer
-   KeywordIndexer
-   GraphIndexer

------------------------------------------------------------------------

## 10. Hybrid Search

``` text
                Query
                  │
          ┌───────┴───────┐
          ▼               ▼
      Vector Search    Keyword Search
          │               │
         Top 50          Top 50
          └───────┬───────┘
                  ▼
                 RRF
                  │
                Top 30
                  │
                  ▼
               Reranker
                  │
                Top 5~10
```

RRF：

``` text
score = Σ 1 / (k + rank)
```

------------------------------------------------------------------------

## 11. Entity Resolution

Entity 模型：

``` ts
export interface Entity {
  id: string;
  tenantId: string;
  canonicalName: string;
  normalizedName: string;
  type: string;
  aliases: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
```

Resolution Pipeline：

``` text
LLM Entity Extraction
        ↓
Normalize
        ↓
Candidate Search
        ├── Exact Match
        ├── Alias Match
        ├── Normalized Match
        ├── Embedding Similarity
        └── LLM Judge
                ↓
            Merge / Create
```

原则：

``` text
Cheap First
↓
Exact Match
↓
Alias Match
↓
Similarity
↓
LLM
```

------------------------------------------------------------------------

## 12. Graph 数据模型与 Provenance

``` text
(:Document)
      │ HAS_VERSION
      ▼
(:DocumentVersion)
      │ HAS_CHUNK
      ▼
(:Chunk)
      │ MENTIONS
      ▼
(:Entity)
```

实体关系必须保存证据：

``` text
(Person)-[
  :RESPONSIBLE_FOR {
    id,
    confidence,
    sourceChunkId,
    sourceDocumentId,
    documentVersionId
  }
]->(Project)
```

Graph 删除不能直接按 Document `DETACH DELETE` 全图节点，而应：

``` text
Delete Document
↓
Delete Document Version
↓
Delete Chunks
↓
Delete Mention Relations
↓
Delete Relation Evidence
↓
Check Entity References
↓
Delete Orphan Entity
```

`Check Entity References` 的依据是显式的 **引用计数**：

``` text
每个 (:Chunk)-[:MENTIONS]->(:Entity) 对应一条计数，
删除 document 时先减去该 document 的 MENTIONS，
计数归零的 Entity 才允许删除；
被多个 document 共享的 Entity 计数 > 0，保留。
```

不要依赖 `DETACH DELETE` 或"重新扫描全图判断引用"这种 O(N) 方式，
用维护好的计数或关系枚举做到 O(1) 判定。

------------------------------------------------------------------------

## 13. Query Pipeline

``` text
Query
 ↓
1. Normalize
 ↓
2. Analyze
 ↓
3. Transform
 ↓
4. Retrieve
 ↓
5. Evidence
 ↓
6. Generate
```

复杂查询（`intent = multi_hop` / `comparison` / `aggregation`）不是
单次静态管线能完成的，需要迭代检索：

``` text
while (evidence 不足以回答问题 && 未达最大轮数) {
  plan = planner(question, accumulatedEvidence)
  subResults = retrieve(plan)
  accumulatedEvidence += subResults
}
answer = generate(question, accumulatedEvidence)
```

即上面 1~6 的单次管线是"简单查询快路径"，
`multi_hop` 走 agentic loop（见第 28 章 Phase 8）。

### QueryAnalysis

``` ts
export interface QueryAnalysis {
  intent:
    | "fact"
    | "relationship"
    | "multi_hop"
    | "aggregation"
    | "comparison"
    | "code"
    | "unknown";

  entities: string[];
  complexity: "simple" | "medium" | "complex";

  needsRewrite: boolean;
  needsMultiQuery: boolean;
  needsHyDE: boolean;

  suggestedSources: RetrievalSource[];
}
```

------------------------------------------------------------------------

## 14. Query Transformation

不是所有 Query 都需要改写：

``` text
Query
 ↓
Analyzer
 ├── Simple      → Direct
 ├── Ambiguous   → Rewrite
 ├── Broad       → Multi Query
 └── Conceptual  → HyDE
```

------------------------------------------------------------------------

## 15. Query Router

采用：

``` text
Query
  ↓
Rule Router
  ├── High Confidence → Direct Route
  └── Unknown         → LLM Router
```

不要让所有请求都调用 LLM Router。

``` ts
export interface RetrievalPlan {
  sources: RetrievalSource[];
  parallel: boolean;
  topK: number;
  useReranker: boolean;
  timeout: number;
}

export type RetrievalSource =
  | "vector"
  | "keyword"
  | "graph"
  | "sql";
```

------------------------------------------------------------------------

## 16. Retriever 抽象

``` ts
export interface RetrievalQuery {
  text: string;
  tenantId: string;
  embedding?: number[];
  analysis?: QueryAnalysis;
  plan?: RetrievalPlan;

  filters?: {
    documentIds?: string[];
    metadata?: Record<string, unknown>;
  };

  topK: number;
}
```

``` ts
export interface Retriever {
  search(
    query: RetrievalQuery
  ): Promise<RetrievalResult[]>;
}

export interface RetrievalResult {
  id: string;
  source: RetrievalSource;
  score?: number;
  payload: unknown;
  metadata: Record<string, unknown>;
}
```

实现：

-   VectorRetriever
-   KeywordRetriever
-   GraphRetriever
-   SQLRetriever
-   CodeRetriever
-   WebRetriever

------------------------------------------------------------------------

## 17. Graph Retrieval

默认流程：

``` text
Query
 ↓
Entity Linking
 ↓
Find Entity
 ↓
N-Hop Traversal
 ↓
Subgraph
 ↓
Evidence
```

优先使用结构化 Entity Linking + 图遍历。

Text2Cypher 适合：

-   聚合
-   统计
-   过滤
-   排序

流程：

``` text
Question
 ↓
Cypher Generator
 ↓
Cypher Validator
 ↓
Neo4j
 ↓
Evidence
```

只允许只读查询，例如：

``` text
MATCH
WHERE
WITH
RETURN
ORDER BY
LIMIT
```

禁止：

``` text
CREATE
MERGE
SET
DELETE
DROP
```

------------------------------------------------------------------------

## 18. Evidence Layer

这是整个系统最重要的统一抽象。

``` ts
export interface Evidence {
  id: string;

  type:
    | "chunk"
    | "graph_path"
    | "entity"
    | "relationship"
    | "sql_row"
    | "web_page";

  content: string;

  source: {
    type: string;
    documentId?: string;
    documentVersionId?: string;
    chunkId?: string;
    graphPath?: string[];
    query?: string;
  };

  scores: {
    retrieval?: number;
    fusion?: number;
    rerank?: number;
  };

  metadata: Record<string, unknown>;
}
```

统一 Pipeline：

``` text
Vector
Keyword
Graph
SQL
Web
   ↓
Evidence
   ↓
Fusion
   ↓
Rerank
   ↓
Context
```

------------------------------------------------------------------------

## 19. Reranker

``` ts
export interface Reranker {
  rerank(
    query: string,
    evidences: Evidence[]
  ): Promise<Evidence[]>;
}
```

Graph Path 与 Chunk 统一转换为 `Evidence.content` 后参与重排。

### 19.1 Reranker 选择与结构信息保留

| 方案 | 精度 | 成本 / 延迟 | 适用 |
| ---- | ---- | ----------- | ---- |
| Cross-Encoder（bge-reranker / Cohere Rerank） | 高 | 低（略高于 embedding） | 默认选择，chunk 级重排 |
| LLM Rerank（LLM 打分排序） | 最高 | 高（token 成本） | 少量候选精排，或需语义判断时 |

注意事项：

``` text
Graph Path → Evidence.content 文本化会丢失图的结构信息
（关系类型、方向、多跳路径）。

补救：
  1. 文本化时保留关系类型与方向，如
     "(Person:张三)-[:RESPONSIBLE_FOR]->(Project:X)"
  2. 重排时把 graph_path 的原始结构放进 Evidence.metadata，
     供 Context Builder 优先保留，不参与纯文本重排打分。
```

职责分离：Reranker 只做文本相关性排序；结构完整性由 Context Builder
的 Source Priority 兜底。

------------------------------------------------------------------------

## 20. Context Builder

不能简单：

``` ts
results.join("\n");
```

应该：

``` text
Evidence
↓
Deduplicate
↓
Diversity
↓
Token Budget
↓
Source Priority
↓
Context
```

``` ts
export interface ContextBudget {
  maxTokens: number;
  reservedForSystem: number;
  reservedForAnswer: number;
}
```

------------------------------------------------------------------------

## 21. Citation

Citation 由 Evidence 自动绑定。

Context：

``` text
[Evidence: ev_001]

useState 用于管理 React 组件状态。

Source:
react-guide.md
chunk_001
```

模型输出：

``` text
useState 用于管理组件状态 [ev_001]
```

系统映射：

``` ts
export interface Citation {
  evidenceId: string;
  documentId?: string;
  chunkId?: string;
  title?: string;
  sourceUri?: string;
}
```

### 21.1 Citation 校验（防幻觉引用）

LLM 可能输出不存在的 `[ev_xxx]`，或把引用 scope 张冠李戴。
映射之后必须加一层校验：

``` text
LLM 输出引用标记 → 解析 evidenceId → 校验
  ├── evidenceId 是否真实存在？        否 → 丢弃该引用
  ├── 引用内容与 evidence 是否相关？    低 → 二次校验 / 丢弃
  └── 无引用的断言 → 标记为"需复核 / 不可靠"
```

实现：

``` ts
export interface CitationVerifier {
  verify(
    answer: string,
    citations: Citation[],
    evidences: Evidence[]
  ): Promise<VerificationResult>;
}

export interface VerificationResult {
  validCitations: Citation[];
  invalidCitations: Citation[];   // 引用不存在的证据
  unsupportedClaims: string[];     // 无证据支撑的断言
  faithfulnessScore?: number;      // 与 Evaluation 的 Faithfulness 对齐
}
```

`Faithfulness` 指标与 Citation 校验共用同一套"断言 ↔ 证据"对齐逻辑。

------------------------------------------------------------------------

## 22. Evaluation

### Retrieval Metrics

-   Recall@K
-   MRR
-   Hit Rate
-   NDCG

### Generation Metrics

-   Context Precision
-   Context Recall
-   Faithfulness
-   Answer Relevance

### Graph Metrics

-   Entity Linking Accuracy
-   Entity Resolution Accuracy
-   Relation Accuracy
-   Path Accuracy

### 22.1 Eval Dataset 与回归闭环

指标本身没有价值，必须有一个可重复执行的评估闭环：

``` text
Eval Dataset（versioned，含 ground truth）
  ├── 查询集（query）
  ├── 黄金文档 / 黄金 chunk（retrieval ground truth）
  └── 参考答案 / 关键事实（generation ground truth）

Regression Pipeline
  Query → Retrieve → Generate → 指标打分 → 写报告 → 与基线对比
  ├── 每次改 embedding / chunk / rerank / prompt 都重跑
  └── 指标显著回退则阻断合并（CI gate）
```

Ground truth 构建方式：

-   Retrieval 标注：人工标注"哪些 chunk 是正确答案"，或从问答对反推
-   Generation 标注：人工写参考答案，或用 `Faithfulness` 自动评测

每个 Eval Dataset 绑定 `indexVersion + embeddingVersion`，
索引升级后必须重新生成 ground truth 或重建基线。

------------------------------------------------------------------------

## 23. Observability

每次 Query 生成：

``` text
traceId
tenantId
sessionId
```

记录：

``` text
Query
├── Analyze
├── Vector Search
├── Keyword Search
├── Graph Search
├── Fusion
├── Rerank
└── Generation
```

关键指标：

-   latency
-   topK
-   model
-   inputTokens
-   outputTokens
-   cost
-   retrieval plan

### 23.1 稳定性：降级 / 熔断 / SLA

| 能力 | 说明 |
| ---- | ---- |
| Timeout | 每个 Retriever 独立超时（见 RetrievalPlan.timeout），超时即降级 |
| Circuit Breaker | 派生索引连续失败到阈值则熔断，该路返回空并标记 unhealthy |
| Degrade | Graph 挂了走 Vector+Keyword；Reranker 挂了跳过重排 |
| Retry | 幂等操作用指数退避重试；LLM 调用重试 + fallback 模型 |
| Rate Limit | 按 tenant + 用户限流（见 Tenant.limits），超限返回 429 |
| SLA | 定义 P95 延迟 / 可用性 / 错误率目标，面板对齐 |

降级原则：

``` text
宁可返回"证据不足 / 降级结果"，也不要全链路失败。
每条 evidence 标注来源与 index 健康状态，供生成层与用户透明感知。
```

### 23.2 成本与预算

``` text
成本 = embedding + LLM 生成 + rerank + 索引存储

控制手段：
  1. 按 tenant.limits 限制每日 embedding / query 数
  2. 语义缓存命中则跳过 LLM（省生成成本）
  3. cheap-first：Rule Router 命中则不走 LLM Router
  4. 每次 query 记录 cost，按 tenant 聚合，超预算告警
```

Observability 里的 `cost` 字段随 trace 一起落库，是预算计费的依据。

------------------------------------------------------------------------

## 24. 多租户与缓存

所有核心数据必须包含：

``` text
tenantId
```

包括：

-   Document
-   DocumentVersion
-   Chunk
-   Entity
-   Vector Metadata
-   Graph Node
-   Cache Key
-   Trace

缓存 Key 必须包含：

``` text
tenantId
indexVersion
embeddingVersion
```

避免索引升级后读取旧缓存。

### 24.1 各存储的租户隔离实现

| 存储 | 隔离方式 |
| ---- | -------- |
| PostgreSQL | tenantId 列 + 行级安全策略（RLS），所有查询强制注入 tenantId 过滤 |
| Qdrant | collection-per-tenant（强隔离、易计费），或单 collection + tenantId payload filter（省资源、必须在 filter 强制） |
| OpenSearch | 每条文档带 tenantId 字段 + filter，或 index-per-tenant |
| Neo4j | 所有节点带 `tenantId` 属性；查询用 `tenantId` 过滤 |

关键约束：

``` text
Entity 是"租户内共享、租户间隔离"：
  - 同一 tenant 内可跨 document 共享 Entity
  - 不同 tenant 间的同名 Entity 必须是不同节点
```

### 24.2 缓存策略

| 层级 | 内容 | TTL | 失效触发 |
| ---- | ---- | --- | -------- |
| 语义缓存 | (query embedding → answer) | 短（分钟级） | 索引版本升级 |
| 检索缓存 | (query → topK evidence) | 中 | 文档更新 / 删除 |
| 嵌入缓存 | (contentHash → embedding) | 长（接近永久） | embedding 模型升级 |

缓存读路径必须校验 `tenantId + indexVersion + embeddingVersion`，
写路径在索引版本升级时主动失效或按 key 隔离。

### 24.3 权限与访问控制 / PII

``` text
权限分层：
  1. Tenant 级：租户间完全隔离（硬隔离）
  2. Document 级：文档 ACL（哪些用户 / 组可读）
  3. Row 级：PostgreSQL RLS + 派生索引 filter
  4. Query 级：检索前注入 permission filter，禁止跨权限检索
```

检索时必须把 `allowedDocumentIds` / `allowedMetadata` 作为强制 filter
注入每个 Retriever，避免越权返回。

``` text
PII / 敏感信息：
  - Ingest 阶段做 PII 检测与脱敏（mask / redact），脱敏后才进索引
  - 文档删除 / 租户删除触发派生索引级联清空（配合 §12 删除链路）
  - 日志 / trace 不落敏感原文，只落 hash / token 计数
```

------------------------------------------------------------------------

## 25. 推荐基础设施

``` text
PostgreSQL
    └── Source of Truth

Redis
    ├── Cache
    └── Queue

Qdrant
    └── Vector Search

OpenSearch
    └── Keyword / BM25

Neo4j
    └── Knowledge Graph

S3 / MinIO
    └── Original Documents
```

------------------------------------------------------------------------

## 26. TypeScript 项目目录

``` text
src/
├── domain/
│   ├── document/
│   ├── chunk/
│   ├── entity/
│   └── evidence/
│
├── application/
│   ├── ingestion/
│   └── query/
│
├── ingestion/
│   ├── loader/
│   ├── parser/
│   ├── normalizer/
│   ├── structure/
│   ├── splitter/
│   ├── embedding/
│   └── graph/
│
├── indexing/
│   ├── vector/
│   ├── keyword/
│   └── graph/
│
├── query/
│   ├── analyzer/
│   ├── rewrite/
│   ├── multi-query/
│   ├── hyde/
│   └── router/
│
├── retrieval/
│   ├── vector/
│   ├── keyword/
│   ├── graph/
│   ├── sql/
│   ├── code/
│   └── fusion/
│
├── ranking/
│   ├── rrf/
│   └── reranker/
│
├── generation/
│   ├── context-builder/
│   ├── citation/
│   └── answer-generator/
│
├── evaluation/
├── infrastructure/
│   ├── postgres/
│   ├── redis/
│   ├── qdrant/
│   ├── opensearch/
│   ├── neo4j/
│   ├── storage/
│   └── queue/
│
├── observability/
└── api/
```

------------------------------------------------------------------------

## 27. 推荐技术栈

``` text
Language        TypeScript
Runtime         Node.js
API             Fastify
Database        PostgreSQL
ORM             Drizzle
Cache           Redis
Queue           BullMQ
Vector DB       Qdrant
Keyword Search  OpenSearch
Graph           Neo4j
Object Storage  S3 / MinIO
Workflow        LangGraph
LLM             Provider Adapter
```

核心原则：

``` text
Domain
  ↓
Interfaces
  ├── LLM Provider
  ├── Embedding Provider
  ├── Vector DB
  ├── Keyword Search
  ├── Graph DB
  └── Queue
```

不要让业务 Domain 被 LangChain 或具体数据库 SDK 绑定。

Provider Adapter 最小接口：

``` ts
export interface LLMProvider {
  chat(messages: ChatMessage[], opts?: LLMOptions): Promise<ChatMessage>;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions(): number;
  model(): string;
}
```

所有 Domain 代码依赖这两个接口，不 import 任何具体 SDK。

------------------------------------------------------------------------

## 28. 实施路线

### Phase 1：Foundation

实现：

-   Document
-   DocumentVersion
-   Chunk
-   Tenant + 租户隔离（RLS）
-   Job / IndexJob + 队列
-   PostgreSQL
-   Upload
-   Parse
-   Normalize
-   Chunk
-   Delete
-   Outbox + Reconciliation（索引一致性骨架）

### Phase 2：Vector RAG

实现：

``` text
Document
↓
Chunk
↓
Embedding
↓
Vector Search
↓
Context
↓
LLM
↓
Citation
```

加入：

-   Qdrant
-   Parent-Child Retrieval
-   Context Builder

### Phase 3：Hybrid Search

加入：

-   Keyword Search
-   BM25
-   RRF
-   Reranker

### Phase 4：Evaluation

建立：

-   Eval Dataset
-   Retrieval Eval
-   Generation Eval
-   Regression Test

先确保能量化检索效果，再继续增加复杂能力。

### Phase 5：Query Intelligence

实现：

-   Query Analyzer
-   Rule Router
-   LLM Router
-   Query Rewrite
-   Multi Query
-   HyDE

### Phase 6：Graph Retrieval

顺序：

``` text
Entity Extraction
↓
Entity Normalization
↓
Entity Resolution
↓
Neo4j
↓
Entity Linking
↓
N-Hop Retrieval
↓
Graph Evidence
```

### Phase 7：Advanced GraphRAG

加入：

-   Text2Cypher
-   Community Detection
-   Community Summary
-   Global Graph Search

### Phase 8：Agentic Retrieval

``` text
Agent
 ↓
Query Planning
 ├── Vector Search
 ├── Graph Search
 ├── SQL
 ├── Web Search
 └── Tool Calling
        ↓
     Evidence
        ↓
     Synthesis
```

------------------------------------------------------------------------

## 29. 最终核心抽象

``` text
┌──────────────────────────────┐
│          Knowledge           │
│ Document / Chunk / Entity    │
└───────────────┬──────────────┘
                ▼
┌──────────────────────────────┐
│            Index             │
│ Vector / Keyword / Graph     │
│ SQL                          │
└───────────────┬──────────────┘
                ▼
┌──────────────────────────────┐
│           Retrieve           │
│ Query / Router / Retriever   │
└───────────────┬──────────────┘
                ▼
┌──────────────────────────────┐
│           Evidence           │
│ Chunk / Graph / SQL / Web    │
└───────────────┬──────────────┘
                ▼
┌──────────────────────────────┐
│          Generation          │
│ Rerank / Context / LLM       │
│ Citation                     │
└──────────────────────────────┘
```

------------------------------------------------------------------------

# 30. 最终结论

这个项目不应该只是一个 RAG Demo，而应该定位为：

# Knowledge Retrieval Platform

统一架构：

``` text
Knowledge
→ Index
→ Retrieve
→ Evidence
→ Generation
```

未来增加：

``` text
Vector RAG
Hybrid Search
Graph Retrieval
SQL Retrieval
Code Retrieval
Web Retrieval
Agent
MCP
```

都不需要推翻核心架构，只是增加新的 Knowledge Source、Index 或
Retriever。
