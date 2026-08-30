# learn-rag

> 生产级 RAG / GraphRAG / Agentic Retrieval 知识检索平台
> 技术栈：TypeScript + Node.js + Fastify + PostgreSQL + Redis + Qdrant + OpenSearch + Neo4j

一个分阶段构建的 RAG 学习与参考项目，覆盖从文档摄入到图谱检索、从混合检索到查询智能、从评估回归到引用生成的完整链路。所有外部依赖（LLM / Embedding / 向量库等）均通过 Provider Adapter 抽象，未配置 API Key 时回退到确定性实现，**开箱即用、零成本跑通**。

## 核心能力

- **文档摄入**：PDF / DOCX / TXT / Markdown 解析 → 归一化 → Parent-Child 分块 → 幂等落库
- **多租户隔离**：PostgreSQL 行级安全（RLS），请求头 `x-tenant-id` 强制校验
- **数据集版本**：版本 = 文档集合快照（只增不改），上传必须归属版本，检索按版本过滤
- **向量检索**：Qdrant（Cosine），Parent-Child Retrieval（child 检索 / parent 回上下文）
- **混合检索**：向量 + 关键词（OpenSearch BM25）+ RRF 融合 + Reranker 重排
- **查询智能**：Query Analyzer（意图分析）→ Router（规则 / LLM 路由）→ Transform（Rewrite / MultiQuery / HyDE）
- **图检索**：实体抽取 → 实体消解 → Neo4j → Entity Linking → N-Hop 子图遍历
- **进阶 GraphRAG**：Text2Cypher（自然语言→Cypher）、社区检测、社区摘要全局检索
- **引用生成**：带 `[1][2]` 编号的引用回链到具体 chunk
- **评估体系**：Eval Dataset（ground truth）+ Retrieve/Generate 指标 + 回归报告（CI gate）
- **一致性骨架**：Outbox 事件 + Reconciliation 对账循环，派生索引可自愈重建

## 技术栈

| 层 | 选型 |
| --- | --- |
| 语言 / 运行时 | TypeScript / Node.js |
| API | Fastify |
| 主库（Source of Truth） | PostgreSQL + Drizzle ORM |
| 缓存 / 队列 | Redis + BullMQ |
| 向量库 | Qdrant |
| 关键词检索 | OpenSearch（BM25） |
| 知识图谱 | Neo4j |
| LLM / Embedding | OpenAI 兼容（无 Key 时确定性回退） |

核心原则：**Domain 不被任何具体 SDK 绑定**，所有外部能力依赖 `LLMProvider` / `EmbeddingProvider` / `VectorDB` 等接口。

## 总体架构

```
                  ┌──────────────┐
                  │ Client / UI │  x-tenant-id
                  └──────┬───────┘
                         ▼
                ┌────────────────┐
                │  API Gateway   │  Fastify :3000
                └────────┬───────┘
            ┌─────────────┴──────────────┐
            ▼                            ▼
     INGESTION PIPELINE           QUERY PIPELINE
   (POST /documents → 异步)       (POST /search → 同步)
            │                            │
            ▼                            ▼
     Parse / Normalize            Query Intelligence
            │                   (Analyze→Route→Transform)
            ▼                            │
        Chunking                         ▼
            │                     Retrieval Router
            ▼                   ┌───────┼───────┐
   ┌─────────┴─────────┐       ▼       ▼       ▼
   │  Reconcile 对账    │    Vector  Keyword  Graph
   │  (Outbox → 派生索引)│    (Qdrant)(OpenSearch)(Neo4j)
   └─────────────────────┘       │       │       │
                                 └───────┼───────┘
                                         ▼
                                      Fusion
                                      (RRF)
                                         │
                                         ▼
                                     Reranker
                                         │
                                         ▼
                                 Context Builder
                                         │
                                         ▼
                                   LLM Generate
                                         │
                                         ▼
                                     Citation
```

写入链路采用「先落库 + 入队，立即返回 202」的异步模式；读取链路同步完成检索→重排→生成。详细的写入 / 查询流程见 [docs/工作流文档.md](file:///Users/peroluo/Document/github/RAG-ai/docs/工作流文档.md)。

## 快速开始

### 1. 启动基础设施

```bash
docker compose up -d
```

启动 PostgreSQL、Redis、Qdrant、OpenSearch、Neo4j（均含健康检查）。

### 2. 配置环境变量

```bash
cp .env.example .env
```

默认无需 OpenAI Key 即可运行（Embedding / LLM 回退到确定性实现）。接入真实模型时填入 `OPENAI_API_KEY` 即可。

### 3. 安装依赖

```bash
pnpm install
```

### 4. 初始化数据库

```bash
pnpm db:push      # 将 schema 同步到 PostgreSQL
```

### 5. 启动服务

```bash
pnpm dev          # API 进程（:3000），含 demo 租户自举
pnpm worker       # 另开终端：后台 Worker，消费队列 + 定时对账
```

启动后会自动创建一个 demo 租户：`00000000-0000-0000-0000-000000000001`。

## 使用示例

### 上传文档与检索

```bash
# 1. 创建数据集版本
curl -X POST http://localhost:3000/versions \
  -H "x-tenant-id: 00000000-0000-0000-0000-000000000001" \
  -H "content-type: application/json" \
  -d '{"name":"v1"}'

# 2. 上传文档到该版本（必填 versionId）
curl -X POST http://localhost:3000/documents \
  -H "x-tenant-id: 00000000-0000-0000-0000-000000000001" \
  -F "versionId=<上一步返回的 id>" \
  -F "file=@./your-doc.txt"

# 3. 检索（不传 versionId 则查激活版本）
curl -X POST http://localhost:3000/search \
  -H "x-tenant-id: 00000000-0000-0000-0000-000000000001" \
  -H "content-type: application/json" \
  -d '{"query":"你的问题"}'
```

## API 参考

所有接口均需 `x-tenant-id` 请求头。写入操作返回 `202 Accepted`，索引进度通过 `GET /documents/:id` 轮询。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/documents` | 上传文档（multipart，必填 `versionId`），落库后入队异步索引 |
| GET | `/documents` | 文档列表 |
| GET | `/documents/:id` | 文档详情 + 关联 Job 状态 |
| DELETE | `/documents/:id` | 删除文档（异步清理派生索引） |
| POST | `/versions` | 创建数据集版本 |
| GET | `/versions` | 版本列表（含文档数） |
| GET | `/versions/:id` | 版本详情 + 其下文档列表 |
| POST | `/versions/:id/activate` | 激活版本（切换默认检索范围） |
| POST | `/search` | 主检索：Query Intelligence → 混合检索 → 生成 → 引用 |
| POST | `/search/analyze` | 仅分析 + 路由，不检索（调试用） |
| POST | `/search/graph` | 图检索：实体链接 + N-Hop 子图遍历 |
| POST | `/search/cypher` | Text2Cypher：自然语言 → Cypher → Neo4j 只读查询 |
| POST | `/search/global` | 全局图检索：社区摘要检索 |
| POST | `/eval/datasets` | 创建评估数据集（含 ground truth 查询集） |
| GET | `/eval/datasets` | 评估数据集列表 |
| POST | `/eval/runs` | 运行评估（Retrieve → Generate → 打分） |
| GET | `/eval/runs` | 评估运行记录列表 |
| GET | `/eval/runs/:id` | 运行详情（逐查询结果） |
| GET | `/eval/runs/:id/report` | 回归报告（Markdown） |
| GET | `/health` | 健康检查 |

## 配置项

完整配置见 [.env.example](file:///Users/peroluo/Document/github/RAG-ai/.env.example)，关键项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://rag:rag@localhost:5432/rag` | PostgreSQL 连接串 |
| `REDIS_URL` | `redis://localhost:6379` | Redis 连接串（队列 + 缓存） |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | API 监听 |
| `QDRANT_URL` | `http://localhost:6333` | 向量库 |
| `OPENSEARCH_URL` | `http://localhost:9200` | 关键词检索 |
| `NEO4J_URL` / `NEO4J_USER` / `NEO4J_PASSWORD` | `bolt://localhost:7687` / `neo4j` / `ragrag1234` | 图谱 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `LLM_MODEL` | - / 官方 / `gpt-4o-mini` | LLM Provider |
| `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` | `text-embedding-3-small` / `384` | Embedding Provider |
| `QUERY_INTELLIGENCE_ENABLED` | `true` | 查询智能总开关 |
| `DEFAULT_TOP_K` / `DEFAULT_MAX_HOPS` | `6` / `2` | 检索默认参数 |
| `RETRIEVER_TIMEOUT_MS` | `3000` | 单 Retriever 超时 |
| `EVAL_BASELINE_TOLERANCE` | `0.1` | 回归容忍度（CI gate） |

## npm 脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发模式启动 API（watch） |
| `pnpm start` | 启动 API |
| `pnpm worker` | 启动后台 Worker（消费队列 + 定时对账） |
| `pnpm reconcile` | 手动跑一轮 Reconciliation 对账 |
| `pnpm eval:run` | 运行评估 |
| `pnpm build` | TypeScript 编译 |
| `pnpm db:generate` | 生成 Drizzle 迁移 |
| `pnpm db:migrate` | 执行迁移 |
| `pnpm db:push` | 推送 schema 到数据库 |

## 项目结构

```
src/
├── index.ts              # API 进程入口（Fastify 装配 + demo 租户自举）
├── worker.ts             # 后台 Worker（队列消费 + 对账循环）
├── reconcile.ts          # 手动对账入口
├── eval-run.ts           # 评估运行入口
├── config.ts             # 统一配置（环境变量映射）
├── api/                  # HTTP 路由（documents / search / versions / eval）
├── application/          # 应用层（用例编排：ingestion / query / job / reconcile / outbox / version）
├── domain/               # 领域层（实体解析等核心领域逻辑）
├── ingestion/            # 摄入管线（parser / normalizer / splitter / parent-child / graph 抽取）
├── indexing/             # 派生索引写入（vector / keyword / graph / community）
├── retrieval/            # 检索器（retriever / graph / text2cypher / global-graph）
├── ranking/              # 排序（rrf 融合 / reranker）
├── query/                # 查询智能（analyzer / router / rewrite / multi-query / hyde）
├── evaluation/           # 评估（runner / judge / metrics / regression）
├── ai/                   # Provider Adapter（llm / embedding，含确定性回退）
├── db/                   # 数据层（schema：document/chunk/entity/job/outbox/tenant/version/eval）
├── queue/                # BullMQ 队列
└── lib/                  # 工具（hash 等）
```

完整的设计版目录结构见 [production-grade-knowledge-retrieval-platform.md](file:///Users/peroluo/Document/github/RAG-ai/production-grade-knowledge-retrieval-platform.md)（§26）。

## 核心设计原则

1. **PostgreSQL 是 Source of Truth**：Document / Chunk / Entity / Job 等以 PG 为准，Qdrant / OpenSearch / Neo4j 均为可重建的派生索引。
2. **索引必须可重建**：支持向量库损坏重建、Embedding 模型升级、Chunk 策略升级后的全量重索引。
3. **Document / Chunk / Entity 生命周期分离**：Entity 可跨多文档共享；版本支持增量、回滚、Diff。
4. **写异步、读同步**：写操作「先落库 + 入队」立即返回 202，读取链路同步完成全流程。
5. **Outbox + Reconciliation 兜底**：任何消费失败最终由对账循环自愈，派生索引与源数据最终一致。
6. **Provider Adapter**：Domain 依赖 `LLMProvider` / `EmbeddingProvider` 等接口，不 import 具体厂商 SDK。

## 实施路线（8 阶段）

| Phase | 内容 | 状态 |
| --- | --- | --- |
| 1. Foundation | Document / Version / Chunk / Tenant(RLS) / Job / 队列 / Upload / Parse / Outbox + Reconcile | ✅ |
| 2. Vector RAG | Qdrant / Parent-Child / Context Builder / 引用 | ✅ |
| 3. Hybrid Search | 关键词检索 / BM25 / RRF / Reranker | ✅ |
| 4. Evaluation | Eval Dataset / 检索评估 / 生成评估 / 回归测试 | ✅ |
| 5. Query Intelligence | Analyzer / 规则+LLM Router / Rewrite / MultiQuery / HyDE | ✅ |
| 6. Graph Retrieval | 实体抽取/消解 / Neo4j / Entity Linking / N-Hop | ✅ |
| 7. Advanced GraphRAG | Text2Cypher / 社区检测 / 社区摘要 / 全局图检索 | ✅ |
| 8. Agentic Retrieval | Agent / Query Planning / Tool Calling / 综合 | 🚧 |

> 阶段定义详见设计文档 [§28](file:///Users/peroluo/Document/github/RAG-ai/production-grade-knowledge-retrieval-platform.md)。

## 进阶文档

- [设计总纲：生产级知识检索平台](file:///Users/peroluo/Document/github/RAG-ai/production-grade-knowledge-retrieval-platform.md)
- [整体工作流文档](file:///Users/peroluo/Document/github/RAG-ai/docs/工作流文档.md)
- [数据库说明](file:///Users/peroluo/Document/github/RAG-ai/docs/数据库说明.md)
- [切片设计文档](file:///Users/peroluo/Document/github/RAG-ai/docs/切片设计文档.md)
- [Reconcile 对账循环说明](file:///Users/peroluo/Document/github/RAG-ai/docs/Reconcile对账循环说明.md)

## License

MIT
