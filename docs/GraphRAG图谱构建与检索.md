# GraphRAG 图谱构建与检索

> 覆盖：实体抽取 → 实体消解 → PG 落库 → Neo4j 投影 → 社区检测/摘要 → Entity Linking → N-Hop 遍历 → 全局图检索。
> 核心原则：**PostgreSQL 是 Source of Truth，Neo4j 是可重建的派生索引**；图索引与向量/关键词索引独立容错。

## 整体架构图

```
                    ┌─────────────────────────────────────────────────────┐
                    │                    客户端 (curl / Web)                │
                    │   x-tenant-id 请求头（多租户隔离）                      │
                    └───────┬──────────────────────────┬─────────────────┘
                            │ 上传文档                   │ 图检索查询
                            ▼                           ▼
              ┌──────────────────────┐     ┌──────────────────────────────┐
              │  Fastify API (:3000) │     │   Fastify API (:3000)         │
              │  POST /documents     │     │  POST /search/graph           │
              │  DELETE /documents   │     │  POST /search/global          │
              └──────────┬───────────┘     │  POST /search/cypher          │
                         │                 └───────────────┬──────────────┘
                         ▼                                 │
              ┌──────────────────────┐                     │
              │ ① 图谱构建链路        │                     │
              │ 见下方「构建链路」     │                     │
              └──────────┬───────────┘                     │
                         │                                 ▼
                         │              ┌──────────────────────────────────┐
                         ▼              │ ② 图检索链路                       │
              ┌──────────────────┐      │ Entity Linking → N-Hop → 回表     │
              │  PostgreSQL      │◄─────┤ Global Search → 社区摘要           │
              │ entities /       │ 回表 │ Text2Cypher → 只读 Cypher          │
              │ relations /      │      └──────────────────────────────────┘
              │ communities      │
              └───────┬──────────┘
                      │ 派生投影
                      ▼
              ┌──────────────────┐
              │  Neo4j           │
              │ Entity 节点      │
              │ REL 关系边       │
              └──────────────────┘
```

## ① 图谱构建链路（索引侧）

```
文档分块落库（child chunk, index_status=ready?）
      │
      ▼
┌─ Reconcile 对账循环 / Outbox 派发 ──────────────────────────────┐
│  writeDerivedIndexes(tenantId, chunk)                          │
│    ├─ 向量索引 → Qdrant        ✓                               │
│    ├─ 关键词索引 → OpenSearch   ✓                               │
│    └─ 图索引  → graphWriter.upsert(chunk)  △ 失败只标 failed    │
│       仅处理 child chunk（parent 跳过）；无实体则直接返回          │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ ① 实体抽取 extractor.extract(chunk.content) ──────────────────┐
│  OPENAI_API_KEY 存在？                                          │
│   ├─ 是 → LLMEntityExtractor                                   │
│  │      prompt：抽取 entities[] + relations[]（JSON，temperature=0）
│  │      ├─ 校验通过 → 返回 LLM 图谱                             │
│  │      └─ 解析失败/异常 → 回退确定性抽取                        │
│   └─ 否 → DeterministicEntityExtractor（正则启发式）             │
│          ├─ 引号短语 「…」 / "…"                                 │
│          ├─ 英文专名 [A-Z][a-z]+（如 OpenAI）                    │
│          ├─ 中文机构后缀（公司/大学/集团/研究院…）→ type=org      │
│          └─ 相邻实体两两连 RELATED_TO（保证连通，仅演示）          │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ ② 实体消解 resolveEntity（Cheap-First，逐实体） ──────────────┐
│  1) 精确匹配 (tenantId, normalizedName, type) → 命中复用         │
│  2) 归一化名匹配 (NFKC+lowercase, 跨 type) → 归并别名/升级 type  │
│  3) 别名匹配 (aliases jsonb @> [name], 同 type) → 复用           │
│  4) 全未命中 → 新建 Entity 行（canonicalName/normalizedName/    │
│     type/aliases）                                              │
│  同一实体跨 chunk、跨文档共享一个 ID（Entity 生命周期独立）        │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ ③ PG 落库（短事务，幂等重索引） ──────────────────────────────┐
│  1. 先删该 chunk 旧数据：                                      │
│     entity_mentions WHERE chunkId=..                            │
│     relations      WHERE sourceChunkId=..                       │
│  2. 写 entity_mentions（chunk→entity 引用，带 documentId）      │
│  3. 写 relations（from/to/type/confidence=1，带证据溯源：       │
│     sourceChunkId / sourceDocumentId / documentVersionId）      │
│     自环跳过；onConflictDoNothing 去重                          │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ ④ Neo4j 派生投影（事务外执行，绝不放 DB 事务内） ──────────────┐
│  1. deleteRelationsByChunk：删该 chunk 的旧 REL 边              │
│  2. upsertEntities：按 (tenantId, entityId) MERGE 节点          │
│     （canonicalName / normalizedName / type / aliases）         │
│  3. upsertRelations：MATCH 两端节点后 MERGE 关系边               │
│     （type / sourceChunkId / confidence / sourceDocumentId）    │
└───────────────────────────────────────────────────────────────┘
```

### 删除 / 清理链路（chunk 被移除或文档删除时）

```
graphWriter.remove(tenantId, chunkId)
      │
      ▼
┌─ PG（短事务）──────────────────────────────────────────────────┐
│  1. 取该 chunk 的 mentions → entityId 列表                      │
│  2. 删 relations(sourceChunkId=chunkId)                        │
│  3. 删 entity_mentions(chunkId=chunkId)                         │
│  4. 对每个实体查剩余引用计数（引用归零 → 删实体行 → 记 orphan）    │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ Neo4j（事务外）──────────────────────────────────────────────┐
│  1. deleteRelationsByChunk(tenantId, chunkId)                  │
│  2. deleteEntities(tenantId, orphanIds)  // DETACH DELETE      │
└───────────────────────────────────────────────────────────────┘
```

### 社区检测与摘要（Phase 7，Reconcile 中按需触发）

```
rebuildCommunities(tenantId)
      │
      ▼
┌─ detectCommunities（Union-Find 连通分量，应用层实现） ──────────┐
│  1. 读全量 entities + relations（租户内）                        │
│  2. union(fromId, toId) 合并连通分量                             │
│  3. 按 root 分组 → 过滤 < minSize 的小社区                        │
│  4. 组装 relationDescriptions（"A -[TYPE]-> B" 去重，限 50 条）  │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ summarizeCommunities ────────────────────────────────────────┐
│  OPENAI_API_KEY 存在？                                          │
│   ├─ 是 → LLM 逐社区生成中文摘要（temperature=0.3, 256 tokens）  │
│   └─ 否 / 失败 → 确定性摘要（实体列表 + 关系描述拼接）            │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ 持久化（短事务，全量替换） ───────────────────────────────────┐
│  1. DELETE communities WHERE tenantId=.. （级联删 members）     │
│  2. 逐社区 INSERT communities(summary, entityCount)             │
│  3. INSERT community_members(communityId, entityId)             │
│  供 /search/global 全局图检索匹配使用                            │
└───────────────────────────────────────────────────────────────┘
```

## ② 图检索链路（查询侧）

### 子图检索：/search/graph

```
POST /search/graph {"query": "...", "versionId": "<可选>", "maxHops": N}
      │
      ▼
┌─ Entity Linking（把自然语言 query 链接到种子节点） ─────────────┐
│  1. 复用 EntityExtractor 从 query 抽取实体名                    │
│  2. normalizeEntityName → findEntitiesByNames（Neo4j 匹配       │
│     normalizedName IN $names，限 50）                            │
│  3. 命中的实体作为种子（seeds）                                  │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ N-Hop 子图遍历 traverse(seedIds, maxHops, docIds) ───────────┐
│  Cypher: MATCH path=(seed)-[rels:REL *1..hops]-(other)         │
│  WHERE all(n IN nodes(path) WHERE n.tenantId=$tenantId)        │
│  【版本过滤】all(r IN rels WHERE r.sourceDocumentId IN $docIds) │
│    → 防止实体跨文档共享导致子图串出版本边界                      │
│  LIMIT 50                                                      │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ 路径文本化 pathFromRecord ────────────────────────────────────┐
│  (:Entity A)-[:TYPE1]->(:Entity B)-[:TYPE2]->(:Entity C)       │
│  → GraphPath{ entities[], relations[], length, path }          │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ 证据回表 PostgreSQL（子图实体 → chunk 证据） ─────────────────┐
│  1. 按 entityMentions 查子图实体关联的 chunkId                  │
│  2. 回表 chunks 取 parent 内容作上下文                          │
│  3. 组装 GraphEvidence{ chunkId, documentId, title, content }  │
│  结果并入 Evidence[] 参与下游 RRF 融合 / Rerank / 生成           │
└───────────────────────────────────────────────────────────────┘
```

### 全局图检索：/search/global

```
POST /search/global {"query": "..."}
      │
      ▼
┌─ 社区摘要检索 ────────────────────────────────────────────────┐
│  1. 读取租户内 communities（含 LLM 摘要）                       │
│  2. 摘要与 query 做匹配打分（规则/词项匹配）                     │
│  3. 命中的社区 → 取其成员实体 → 关联 chunk 证据                  │
│  适用于：需要跨文档全局视角、无明确单实体的查询                   │
└───────────────────────────────────────────────────────────────┘
```

### 自然语言查图：/search/cypher（Text2Cypher）

```
POST /search/cypher {"question": "..."}
      │
      ▼
┌─ Cypher 生成（LLM）───────────────────────────────────────────┐
│  Question → Cypher Generator → Cypher Validator                │
│  只允许只读子句：MATCH / WHERE / WITH / RETURN / ORDER BY / LIMIT
│  禁止：CREATE / MERGE / SET / DELETE / DROP                    │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ Neo4j 只读执行 runReadOnlyQuery ─────────────────────────────┐
│  注入 tenantId 参数 → 执行 → records 转普通对象                 │
│  结果转 Evidence（type=graph_path）                             │
└───────────────────────────────────────────────────────────────┘
```

## 数据模型

### PostgreSQL（Source of Truth）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `entities` | id, canonicalName, normalizedName, type, aliases(jsonb) | 实体主表，租户内唯一（name+type 唯一索引） |
| `entity_mentions` | chunkId, entityId, documentId | chunk→实体 引用（引用计数用于孤儿清理） |
| `relations` | fromEntityId, toEntityId, type, confidence, sourceChunkId, sourceDocumentId, documentVersionId | 关系边，带证据溯源；五元组唯一索引 |
| `communities` | tenantId, communityIndex, summary, entityCount | 社区 + LLM 摘要 |
| `community_members` | communityId, entityId | 社区成员 |

### Neo4j（派生索引，可重建）

- 节点：`(:Entity {tenantId, entityId, canonicalName, normalizedName, type, aliases})`
- 边：`(:Entity)-[:REL {tenantId, type, sourceChunkId, sourceDocumentId, confidence}]->(:Entity)`
- 查询强制 `tenantId` 过滤（多租户隔离）

## 设计要点

1. **PG 唯一事实来源**：Neo4j 损坏/清空后可由 Reconcile 重新投影重建。
2. **幂等可重建**：以 chunk 为单元，upsert 前先删旧 mentions/relations，重复执行结果一致。
3. **版本边界**：遍历时用边的 `sourceDocumentId` 过滤，实体虽跨文档共享，但子图不会串出版本。
4. **多级容错**：图索引失败只标 `graph=failed`，不阻塞向量/关键词就绪；Reconcile 对账会重试。
5. **外部 I/O 不进事务**：Neo4j 写入在短事务之外，避免长事务拖死连接池（见 [故障记录](file:///Users/peroluo/Document/github/RAG-ai/docs/故障记录-reconcile连接池耗尽与文档pending.md)）。
6. **无 Key 可运行**：无 `OPENAI_API_KEY` 时实体抽取/社区摘要均回退确定性实现，端到端可跑通。
