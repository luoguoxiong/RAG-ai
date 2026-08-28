# learn-rag 整体工作流程图

> 多阶段构建的 RAG（检索增强生成）学习项目。
> 覆盖：文档摄入 → 向量检索 → 混合检索（向量+关键词）→ 知识图谱 → 查询智能 → 图检索 + 全局图检索。

## 架构总览

```
                    ┌─────────────────────────────────────────────────────┐
                    │                    客户端 (curl / Web)                │
                    │   x-tenant-id 请求头（多租户隔离）                      │
                    └───────┬──────────────────────────┬─────────────────┘
                            │ 上传文件                    │ 查询
                            ▼                           ▼
              ┌──────────────────────┐     ┌──────────────────────────────┐
              │  Fastify API (:3000) │     │   Fastify API (:3000)         │
              │  POST /documents     │     │  POST /search  /search/graph  │
              │  DELETE /documents   │     │  /search/cypher /search/global│
              └──────────┬───────────┘     └───────────────┬──────────────┘
                         │                                 │
                         ▼                                 ▼
              ┌──────────────────────┐     ┌──────────────────────────────┐
              │ ① 写入链路 (ingest)   │     │ ② 查询链路 (query)            │
              │ 见下方详细流程          │     │ 见下方详细流程                  │
              └──────────────────────┘     └──────────────────────────────┘
```

## ① 写入链路（文档 → 索引）

```
POST /documents (multipart)
      │
      ▼
┌─ ingestDocument ──────────────────────────────────────────────┐
│  1. 解析文件 (parserFor: pdf/docx/txt/md)                      │
│  2. 文本归一化 (normalize) + 内容哈希 (hashContent)              │
│  3. PostgreSQL 落库：Document + DocumentVersion + Job          │
└───────────────┬───────────────────────────────────────────────┘
                │ 返回 {jobId} (HTTP 202)
                ▼
      入队 Redis BullMQ ("rag-index" 队列)
                │
                ▼
┌─ Worker (pnpm worker) ────────────────────────────────────────┐
│  processVersion(versionId):                                   │
│    1. Parent-Child 切分 (splitter)                            │
│    2. chunk 幂等落库（parent=上下文 / child=检索单元）           │
│    3. 清理过期 chunk → 发 chunk.removed 事件                   │
│    4. 写 Outbox 事件 chunk.upserted（事务内）                   │
│    5. 标记 version/document = ready                           │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ Reconcile 对账循环 (每5s) ───────────────────────────────────┐
│  派发 Outbox 事件 → IndexWriter.upsert(chunk)：                │
│    ├─ 向量索引  → Qdrant (仅 child，Cosine)   ✓               │
│    ├─ 关键词索引 → OpenSearch (BM25)           ✓               │
│    └─ 图索引    → Neo4j (实体/关系，独立容错)    △ 失败不阻塞   │
│  写入 index_status (vector/keyword/graph) 供对账驱动           │
└───────────────────────────────────────────────────────────────┘
```

删除链路：`DELETE /documents/:id` → `delete_document` Job → 删 chunk + 发 `chunk.removed` → 从 Qdrant / OpenSearch / Neo4j 同步删除。

## ② 查询链路（问题 → 答案）

```
POST /search {"query": "..."}
      │
      ▼
┌─ answerQuery ─────────────────────────────────────────────────┐
│  Query Intelligence 开关 (QUERY_INTELLIGENCE_ENABLED)          │
│  ├─ 开启: runQueryIntelligence                                 │
│  │   Analyze(意图分析) → Route(路由) → Transform(变换) →        │
│  │   Retrieve(检索)                                            │
│  │   变换互斥：Rewrite(含糊) > MultiQuery(宽泛) >               │
│  │           HyDE(概念型) > Direct(直连)                       │
│  └─ 关闭: 直连 retrieveEvidence                                │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ retrieveEvidence (混合检索 §10) ─────────────────────────────┐
│  Vector(Embedding→Qdrant) ║ Keyword(BM25→OpenSearch) 并行     │
│              └──────┬──────┘                                  │
│                     ▼  RRF 融合 (Reciprocal Rank Fusion)       │
│                     ▼  assembleEvidence: 回表 PostgreSQL       │
│                          child命中 → 取 parent 内容作上下文     │
│                     ▼  Rerank 重排 (可选, LLM/Lexical)         │
│              ┌──────┴──────┐                                  │
│              ▼             ▼                                  │
│   Evidence[] + Parent 上下文                                 │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ generateAnswer ─────────────────────────────────────────────┐
│  1. Context Builder：证据序列化为带编号 [1][2] 的提示词          │
│  2. LLM 生成回答（OpenAI 兼容；无 KEY 时回退规则生成）            │
│  3. 组装 Citations（documentId/chunkId/score）                 │
│  返回 { answer, citations, evidenceCount, analysis, plan }    │
└───────────────────────────────────────────────────────────────┘
```

图检索（独立端点）：

```
POST /search/graph  →  实体链接(四层: 精确/归一化/别名/新建)
                     →  n-hop 子图遍历 (Neo4j, maxHops)
                     →  子图证据回表 → 图证据

POST /search/cypher  →  自然语言 → Cypher → 校验 → Neo4j 只读查询
POST /search/global  →  社区摘要检索 (Phase 7, 连通分量+LLM摘要)
```

## 五层存储职责

| 层 | 技术 | 角色 |
|---|---|---|
| 主数据 | PostgreSQL | 文档/分块/实体/Job/Outbox（RLS 租户隔离） |
| 队列 | Redis + BullMQ | 异步任务 + 定时对账 |
| 向量 | Qdrant | 语义检索（collection-per-tenant） |
| 关键词 | OpenSearch | BM25 关键词检索 |
| 图 | Neo4j | 实体关系 + n-hop 遍历 |

## 容错与对账

- **三路索引独立容错**：Neo4j 挂了只标记 `graph=failed`，不影响向量/关键词。
- **Reconcile 兜底**：`index_status` 任一路非 ready → 重新投递索引；卡死 Job 超 10 分钟 → 重置重入队；Outbox 失败 → 退避重试。
- **降级路径**：无 `OPENAI_API_KEY` → 哈希 Embedding + 规则 LLM；OpenSearch 挂了 → 纯向量。
