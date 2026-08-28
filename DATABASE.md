# 数据库表结构设计文档

> 对应代码：[src/db/schema/](file:///Users/kye/Documents/ai/learn-rag/src/db/schema/)、[src/db/index.ts](file:///Users/kye/Documents/ai/learn-rag/src/db/index.ts)（RLS）
> 迁移文件：[drizzle/](file:///Users/kye/Documents/ai/learn-rag/drizzle)

## 1. 总览

PostgreSQL 是系统的 **Source of Truth**（原始内容、chunk、实体图谱、评估数据都落 PG；向量/关键词/图索引是派生的，可随时从 PG 重建）。

共 17 张表，按域分为 6 组：

| 域 | 表 | 用途 |
|----|----|------|
| 租户 | `tenants` | 租户根，配额/套餐 |
| 文档 | `documents`、`document_versions` | 文档与版本（原始内容存 PG） |
| 切片 | `chunks`、`index_status` | Parent/Child 两级 chunk + 派生索引状态 |
| 实体图谱 | `entities`、`entity_mentions`、`relations`、`communities`、`community_members` | 实体注册、mention、关系、社区 |
| 任务 | `jobs` | 异步任务（文档处理） |
| Outbox | `outbox` | 变更事件（驱动派生索引重建） |
| 评估 | `eval_datasets`、`eval_queries`、`eval_runs`、`eval_run_results` | RAG 评估数据集与运行结果 |

### 公共约定

- **主键**：所有表 `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`。
- **租户外键**：除 `tenants` 外所有表都带 `tenant_id`，级联删除。
- **时间戳**：`created_at`（+ 部分表 `updated_at`），`timestamp with time zone`。
- **status 枚举**：均用 `text` 存储，未建 PG enum，便于迁移演进。

## 2. 租户隔离（RLS）

[src/db/index.ts](file:///Users/kye/Documents/ai/learn-rag/src/db/index.ts#L23-L68)

- 所有 tenant-scoped 表启用并 **FORCE** Row-Level Security；`tenants` 表本身不套 RLS（它是租户根，跨租户对账需枚举）。
- 应用通过 `withTenantTx` 在事务内执行 `SELECT set_config('app.tenant_id', ..., true)`（等价 `SET LOCAL`），事务结束自动还原，避免连接池复用时租户绑定泄漏。
- RLS 策略条件：`tenant_id = current_setting('app.tenant_id', true)::uuid`。查询即使漏写 `WHERE tenant_id = ...`，数据库层也会静默隔离（defense in depth）。
- 新增表需同步维护 `setupRls` 中的表清单。

## 3. 表结构

### 3.1 tenants — 租户

字段：`id`（PK）、`name`、`plan`（默认 `free`）、`limits`（jsonb：maxDocuments/maxChunks/maxEmbeddingsPerDay/maxQueriesPerMinute）、`status`（默认 `active`）、`created_at`、`updated_at`。

### 3.2 documents — 文档

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| tenant_id | uuid FK→tenants | 级联删除 |
| source_type | text | 来源类型 |
| source_uri | text | 来源地址 |
| title | text | 标题（可为空） |
| status | text | 默认 `pending` → `ready` |
| current_version_id | uuid | 当前生效版本 id |
| created_at / updated_at | timestamptz | |

**设计**：文档是多版本的，`current_version_id` 指向当前生效版本；版本表可追溯历史。

### 3.3 document_versions — 文档版本

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| tenant_id | uuid FK→tenants | |
| document_id | uuid FK→documents | 级联删除 |
| version | integer | 版本号，默认 1 |
| content_hash | text | 内容哈希（判重/幂等） |
| raw_content | text | **原始内容落 PG**（临时方案，后续迁 S3/MinIO） |
| metadata | jsonb | 解析器写入的元数据（fileName/mimeType/language/numpages 等），language 用于选择切分器 |
| status | text | 默认 `pending` → `ready` |
| created_at | timestamptz | |

### 3.4 chunks — 切片（Parent/Child 两级）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| tenant_id | uuid FK→tenants | |
| document_id | uuid FK→documents | |
| document_version_id | uuid FK→document_versions | |
| parent_id | uuid | 所属 parent（child 有值，parent 为 null） |
| type | text | `parent` / `child`，默认 child |
| content | text | 切片内容 |
| content_hash | text | 稳定哈希（幂等去重依据） |
| chunk_index | integer | 版本内顺序 |
| metadata | jsonb | 如 `{ title }` |
| created_at | timestamptz | |

唯一索引：`chunks_version_hash_idx` on `(document_version_id, content_hash)` — 同一版本内相同内容去重，保证重跑安全。

**设计**：child 是检索单元（落向量/关键词索引），parent 是上下文单元（只存库，命中 child 后回填 parent 喂 LLM）。

### 3.5 index_status — 派生索引状态

| 字段 | 类型 | 说明 |
|------|------|------|
| chunk_id | uuid PK FK→chunks | 级联删除 |
| tenant_id | uuid FK→tenants | |
| vector / keyword / graph | text | 各索引状态，默认 `pending`（`pending`/`done`/`failed`） |
| embedding_model / embedding_version | text | 向量化模型与版本 |
| updated_at | timestamptz | |

**设计**：chunk 粒度追踪派生索引写入状态，Reconciliation 据此重试失败项；graph 失败不阻塞 vector/keyword。

### 3.6 entities — 实体注册表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| tenant_id | uuid FK→tenants | |
| canonical_name | text | 规范名（展示用） |
| normalized_name | text | 规范化名（匹配用） |
| type | text | 实体类型，默认 `unknown` |
| aliases | jsonb | 别名数组 |
| metadata | jsonb | |
| created_at / updated_at | timestamptz | |

唯一索引：`entities_tenant_norm_type_idx` on `(tenant_id, normalized_name, type)`。

**设计**：同租户内可跨文档共享实体；跨租户完全隔离。实体解析四层级：精确匹配 → 规范化 → 别名 → 新建。

### 3.7 entity_mentions — 实体提及

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| tenant_id | uuid FK→tenants | |
| chunk_id | uuid FK→chunks | 级联删除 |
| entity_id | uuid FK→entities | 级联删除 |
| document_id | uuid FK→documents | |
| created_at | timestamptz | |

唯一索引 `entity_mentions_chunk_entity_idx` on `(chunk_id, entity_id)`；普通索引 `entity_mentions_entity_idx` on `entity_id`。

**设计**：等价于图 `(:Chunk)-[:MENTIONS]->(:Entity)` 的引用记录，删除文档时先减引用、计数归零的实体才删除。

### 3.8 relations — 实体关系

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| tenant_id | uuid FK→tenants | |
| from_entity_id / to_entity_id | uuid FK→entities | |
| type | text | 关系类型 |
| confidence | double precision | 置信度，默认 1 |
| source_chunk_id | uuid FK→chunks | 证据：来源切片 |
| source_document_id | uuid FK→documents | 证据：来源文档 |
| document_version_id | uuid FK→document_versions | 证据：来源版本 |
| created_at | timestamptz | |

唯一索引 `relations_uniq_idx` on `(tenant_id, from_entity_id, to_entity_id, type, source_chunk_id)`；`from_idx` / `to_idx` 索引。

**设计**：证据字段随边保存，删除可溯源、可级联。

### 3.9 communities / community_members — 社区（Phase 7）

- `communities`：`id`、`tenant_id`、`community_index`、`summary`（LLM 生成的社区摘要，供 Global Graph Search）、`entity_count`、`created_at`、`updated_at`。索引：`communities_tenant_idx`。
- `community_members`：`id`、`tenant_id`、`community_id`（FK）、`entity_id`（FK）、`created_at`。唯一索引 `(community_id, entity_id)`，普通索引 `entity_idx`。

**设计**：连通分量检测后的实体聚类，摘要支撑全局图检索。

### 3.10 jobs — 异步任务

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| tenant_id | uuid FK→tenants | |
| type | text | 任务类型（如 index_document / reindex_document） |
| status | text | 默认 `pending` |
| payload | jsonb | 任务参数 |
| attempts / max_attempts | integer | 重试次数，默认上限 5 |
| error | text | 最近错误 |
| created_at / updated_at | timestamptz | |

### 3.11 outbox — 变更事件表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| tenant_id | uuid FK→tenants | |
| aggregate_type | text | 聚合类型（如 `chunk`） |
| aggregate_id | uuid | 聚合 id |
| event_type | text | `chunk.upserted` / `chunk.removed` |
| payload | jsonb | |
| status | text | 默认 `pending` → `done` / `failed` |
| attempts | integer | 重试次数 |
| error | text | |
| available_at | timestamptz | 可投递时间（指数退避） |
| created_at | timestamptz | |

索引：`outbox_pending_idx` on `(status, available_at)` — 供 dispatcher 捞取待处理事件。

**设计**：事件与业务变更同事务写入（Transactional Outbox），Reconciliation 消费后异步写派生索引，失败按 `2^attempts` 秒指数退避重试。

### 3.12 评估域（eval_*）

**eval_datasets**：`id`、`tenant_id`、`name`、`description`、`index_version`、`embedding_version`、`created_at`。版本化评估集，索引/embedding 升级后必须重建基线。

**eval_queries**：`id`、`tenant_id`、`dataset_id`（FK）、`query`、`gold_chunk_ids`（jsonb，检索 ground truth）、`reference_answer`、`key_facts`（jsonb，生成 ground truth）、`created_at`。唯一索引 `(dataset_id, query)`。

**eval_runs**：`id`、`tenant_id`、`dataset_id`、`index_version`、`embedding_version`、`embedding_model`、`top_k`（默认 6）、`llm_model`、`reranker`、`status`（默认 `running`）、`error`、`metrics`（jsonb，汇总指标）、`report`、`baseline_run_id`（回归基线）、`regressed_metrics`（jsonb，回退指标列表）、`gate_passed`（boolean，回归门禁）、`created_at`。

**eval_run_results**：`id`、`tenant_id`、`run_id`（FK）、`query_id`（FK）、`query`、`gold_chunk_ids`、`retrieved_chunk_ids`（jsonb）、`metrics`（jsonb，检索 4 项 + 生成 4 项，归一化 [0,1]）、`answer`、`created_at`。索引：`eval_run_results_run_idx` on `run_id`。

## 4. 表关系图

```
tenants 1 ── * documents 1 ── * document_versions 1 ── * chunks 1 ── 1 index_status
                  │                                       │
                  │                                       ├── (parent_id self-ref, child → parent)
                  └── * entities（跨文档共享） 1 ── * entity_mentions（chunk 提及）
                         │
                         1 ── * relations（实体间关系，带证据字段）
                         │
                         1 ── * community_members * ── 1 communities

documents 1 ── * jobs（异步任务）
tenants  1 ── * outbox（事件）
tenants  1 ── * eval_datasets 1 ── * eval_queries
                         1 ── * eval_runs 1 ── * eval_run_results（每 query 一行结果）
```

所有外键均为 `ON DELETE CASCADE`，删除文档/租户时逐级清理。

## 5. 设计要点

1. **PG 是 Source of Truth**：向量（Qdrant）/关键词（OpenSearch）/图（Neo4j）均为派生索引，可随时从 chunks/entities/relations 重建。
2. **RLS 兜底隔离**：所有租户表强制行级安全，应用层漏过滤也不会跨租户泄漏。
3. **两级切片**：child 检索、parent 上下文，`parent_id` 自引用关联。
4. **稳定哈希幂等**：`(document_version_id, content_hash)` 唯一，重复处理安全。
5. **Transactional Outbox**：事件与业务同事务写入，异步投递 + 指数退避重试。
6. **索引状态可对账**：`index_status` 逐 chunk 追踪派生索引，失败不阻塞其他索引。
