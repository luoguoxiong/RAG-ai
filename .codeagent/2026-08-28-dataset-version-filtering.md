# Task Log — 2026-08-28

## 任务：数据集版本（知识库快照）+ 按版本过滤检索

### 需求（用户确认的语义）
- 版本 = 文档集合快照：每份文档独占归属一个版本（documents.versionId）
- 版本只能递增创建，不能删除 / 改名 / 修改；版本内文档可追加，不可移除
- 上传文档必须显式指定 versionId；检索必须指定版本（/search、/search/graph、/search/global 全部强制版本过滤）

### 改动清单
1. 新建 `src/db/schema/version.ts`：`dataset_versions` 表（id/tenantId/name/version 递增编号/status/createdAt），租户内 (tenant_id, version) 唯一
2. `src/db/schema/document.ts`：`documents` 加 `versionId` 外键（NOT NULL → dataset_versions.id，ON DELETE restrict）
3. `src/db/schema/index.ts`：导出 version schema
4. 迁移 `drizzle/0007_round_wild_pack.sql`（手工增强）：建表 → 存量文档回填默认版本（每个租户 version=1 'default'）→ 加列 → 回填 → SET NOT NULL → 约束/索引
5. `src/application/version.ts`（新增）：createDatasetVersion（max+1 递增）、listDatasetVersions（含文档数）、getDatasetVersion（含文档列表）、resolveVersionDocumentIds（校验归属 + 展开 documentIds）
6. `src/application/ingestion.ts`：IngestInput 加 versionId，事务内校验版本归属后写入 documents.versionId
7. `src/indexing/vector.ts`：`search(..., opts.documentIds)` → Qdrant filter `documentId in any`
8. `src/indexing/keyword.ts`：`search(..., opts.documentIds)` → OpenSearch bool filter terms
9. `src/retrieval/retriever.ts`：Retriever.retrieve / retrieveEvidence 加 documentIds 透传；assembleEvidence 回表后兜底过滤非版本文档 chunk
10. `src/query/index.ts`：runQueryIntelligence / transformAndRetrieve / retrieveEvidenceMulti 透传 documentIds
11. `src/application/query.ts`：answerQuery opts 加 documentIds
12. `src/indexing/graph.ts`：GraphStore.traverse 加 documentIds，Cypher 用 `all(r IN rels WHERE r.sourceDocumentId IN $docIds)` 过滤版本边界
13. `src/retrieval/graph.ts`：retrieveGraph 加 documentIds——实体链接 innerJoin mentions 过滤、traverse 过滤、证据回表过滤
14. `src/retrieval/global-graph.ts`：globalGraphSearch 加 documentIds——只保留成员实体在版本文档内有 mentions 的社区
15. `src/api/versions.ts`（新增）：POST/GET /versions、GET /versions/:id（无 DELETE/PUT，版本不可删改）
16. `src/api/search.ts`：/search、/search/graph、/search/global 必填 versionId，requireVersion 解析 documentIds 后透传
17. `src/api/documents.ts`：POST /documents multipart 读 versionId 字段，校验后传给 ingestDocument
18. `src/index.ts`：注册 versionRoutes
19. `src/db/index.ts`：setupRls 租户表清单加入 dataset_versions

### 验证
- `pnpm tsc --noEmit` 通过
- `pnpm drizzle-kit generate` 二次运行输出 "No schema changes"，0007 为最终迁移
- 迁移 SQL 对存量数据友好（自动回填默认版本）

### 边界 / 待确认
- DELETE /documents 仍可用（删除单篇文档），与"版本内文档不可移除"语义有张力：若需严格不可移除，应禁用或仅允许软删
- /search/cypher（调试端点）未强制版本；eval（evaluation/runner.ts）仍走全租户检索，未按版本过滤

## 追加：查询默认用激活版本（2026-08-28 同会话）

### 需求变更
- 查询不传 versionId 时，默认检索该租户**激活版本**（status=active）的文档集合
- 版本表已有递增 version / status / createdAt，无需新迁移

### 改动
- `src/application/version.ts`：
  - createDatasetVersion：首个版本自动 status=active，后续版本默认 inactive
  - 新增 activateDatasetVersion：同一事务内全部置 inactive → 目标置 active（保证唯一激活）
  - resolveVersionDocumentIds(tenantId, versionId?)：versionId 缺省 → 查 active 版本；无激活版本抛 "no active dataset version"
- `src/api/search.ts`：requireVersion 改为版本可选（有则用指定版本，无则用激活版本），错误透传 400
- `src/api/versions.ts`：新增 POST /versions/:id/activate

### 验证
- `pnpm tsc --noEmit` 通过
- 存量迁移回填的默认版本 status='active'，天然成为激活版本，无数据迁移负担

## 追加：激活版本唯一约束（数据库层兜底）

### 需求
- 激活版本最多只有一个 → 在数据库层用**部分唯一索引**兜底，不依赖应用层逻辑

### 改动
- `src/db/schema/version.ts`：`dataset_versions_tenant_active_idx` — `UNIQUE(tenant_id) WHERE status = 'active'`
- 迁移 `drizzle/0008_quick_nicolaos.sql`：CREATE UNIQUE INDEX ... WHERE status = 'active'
- 应用层 createDatasetVersion / activateDatasetVersion 顺序保证不触发冲突（先全置 inactive 再激活）

### 验证
- `pnpm drizzle-kit generate` 生成 0008；`pnpm tsc --noEmit` 通过

## 冒烟测试（2026-08-28 09:27-09:35）

### 环境
- 5 个容器健康（postgres/redis/qdrant/opensearch/neo4j）
- 修复迁移 0007：ON CONFLICT (tenant_id, version) 的 INSERT 依赖唯一索引仲裁，但索引在 INSERT 之后创建导致 42P10 → 将 CREATE UNIQUE INDEX 移到 INSERT 之前，迁移成功应用
- 旧 API/Worker（v18）停止，用 nvm v22.19.0 重启（undici 7 要求 Node ≥ 20）

### 结果
| 用例 | 结果 |
|------|------|
| 创建 v2 | version=2、status=inactive ✅ |
| 上传 smoke_v2.txt 到 v2 | ready，归属 v2 ✅ |
| 默认查询（active=v1） | 3 条 citations 全来自 v1，不含 v2 文档 ✅ |
| 指定 versionId=v2 | 命中 smoke_v2 ✅ |
| 激活 v2 | v1→inactive、v2→active，唯一 active ✅ |
| 默认查询（active=v2） | 命中 smoke_v2 ✅ |
| /search/graph 默认（active=v2）查 v1 实体 | seeds/paths/evidence 全空 ✅ |
| /search/graph 指定 versionId=v1 | seeds=2、paths=5、evidence 命中 graph_sample.md ✅ |

### 当前状态（测试后）
- 租户 00000000-0000-0000-0000-000000000001：v1=default(inactive, 3 文档)、v2=第二批(active, smoke_v2.txt)
