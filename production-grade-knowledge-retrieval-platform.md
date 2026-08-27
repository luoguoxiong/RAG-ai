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
  normalizedContent +
  chunkIndex
)
```

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

------------------------------------------------------------------------

## 28. 实施路线

### Phase 1：Foundation

实现：

-   Document
-   DocumentVersion
-   Chunk
-   PostgreSQL
-   Upload
-   Parse
-   Normalize
-   Chunk
-   Delete

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
