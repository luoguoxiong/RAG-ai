# learn-rag 项目方案

> 通用文档处理 + 双引擎混合检索 RAG 系统。支持**向量 RAG**（语义检索）和 **GraphRAG**（知识图谱检索）两种模式，Agent 层使用 `@aipack-ai/agent`，其余全部使用成熟库。

## 一、核心目标

- **文档类型不限**：Markdown、TXT、HTML、PDF、CSV、JSON、DOCX、纯文本粘贴
- **双检索引擎**：
  - **向量 RAG**：BM25 关键词 + 向量语义，EnsembleRetriever 自动 RRF 融合 → 适合事实问答、语义匹配
  - **GraphRAG**：LLM 抽取实体关系 → Neo4j 知识图谱 → 图遍历检索 → 适合多跳推理、关系查询
- **查询完善**：用户提问过短/口语化/指代不明时，LLM 自动改写为完整可检索的 query
- **自动路由**：系统根据问题类型自动选择检索引擎（或两路并行），用户无需选择
- **可溯源**：回答标注来源文档、页码、章节
- **流式输出**：SSE 推送检索阶段 + 生成 token

## 二、技术选型

| 层                | 选型                                                      | 说明                                        |
| ----------------- | --------------------------------------------------------- | ------------------------------------------- |
| 语言              | TypeScript + Node.js ≥18                                  | 与现有工程一致                              |
| Agent/LLM         | `@aipack-ai/agent`                                        | `createRuntime` + `streamFn`，复用现有模式  |
| 文档加载          | `@langchain/community/document_loaders`                   | PDF/Markdown/CSV/JSON/HTML 各有成熟 loader  |
| 文本切分          | `@langchain/textsplitter`                                 | RecursiveCharacterTextSplitter              |
| Embedding         | `@langchain/openai`                                       | OpenAIEmbeddings，支持自定义 baseURL        |
| 向量库            | `chromadb` + `@langchain/community/vectorstores/chroma`   | 嵌入式，零运维，磁盘持久化                  |
| BM25 检索         | `@langchain/community/retrievers/bm25`                    | BM25Retriever                               |
| 混合检索          | `@langchain/community/retrievers/ensemble`                | EnsembleRetriever，自动 RRF 融合            |
| **GraphRAG 图库** | **`neo4j-driver` + `@langchain/community/graphs/neo4j`**  | 成熟图数据库，Docker 一键启动               |
| **实体关系抽取**  | **LangChain.js `LLMGraphTransformer`**                    | LLM 自动抽取实体 + 关系，写入 Neo4j         |
| **图检索**        | **`@langchain/community/chains/graph_qa`**                | GraphCypherQAChain，自然语言 -> Cypher 查询 |
| 重排序            | `@langchain/community/document_compressors/cohere_rerank` | 可选                                        |
| **前端**          | **React + Vite**                                          | TypeScript、组件化、图谱可视化              |
| **后端 API**      | **Hono**                                                  | 轻量、TypeScript 原生、SSE 支持             |
| 参数校验          | `zod`                                                     | 请求体校验                                  |

## 三、系统架构

```
                         ┌─────────────────────────────────────┐
                         │             文档输入层              │
                         │  .md .txt .html .pdf .docx .csv .json │
                         └────────────────┬────────────────────┘
                                          │
                         ┌────────────────▼────────────────────┐
                         │     LangChain DocumentLoaders       │
                         │  按扩展名路由到对应 loader            │
                         └────────────────┬────────────────────┘
                                          │
                         ┌────────────────▼────────────────────┐
                         │  RecursiveCharacterTextSplitter     │
                         │  递归切分 + overlap + 元数据         │
                         └────────────────┬────────────────────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    │                     │                     │
                    ▼                     ▼                     ▼
          ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
          │   向量 RAG 索引  │  │  GraphRAG 索引   │  │   元数据索引     │
          │                  │  │                  │  │  (source/page)  │
          │ ┌─────────────┐ │  │ ┌─────────────┐ │  └─────────────────┘
          │ │ BM25 倒排   │ │  │ │ LLM 抽取    │ │
          │ │ (关键词)    │ │  │ │ 实体+关系   │ │
          │ └─────────────┘ │  │ └──────┬──────┘ │
          │ ┌─────────────┐ │  │        ▼        │
          │ │ Chroma 向量 │ │  │ ┌─────────────┐ │
          │ │ (HNSW+emb) │ │  │ │  Neo4j 图   │ │
          │ └─────────────┘ │  │ │  (节点+边)  │ │
          └─────────────────┘  │ └─────────────┘ │
                               └─────────────────┘
```

### 检索流程（查询完善 → 自动路由 → 双引擎检索）

```
用户提问（无需选择模式，可能很简短）
   │
   ├─ ① 查询完善（Query Enrichment）────────────────
   │  用 LLM 补全/改写 query（用户无感）
   │  ├─ 补全缺失信息：口语化 -> 规范表达
   │  │  "那个项目谁负责？" -> "XX项目的负责人是谁？"
   │  ├─ 消解指代：结合历史对话
   │  │  "它怎么用？" -> "React 18 的 useTransition 怎么用？"
   │  └─ 生成多角度变体（可选，扩大召回）
   │
   ├─ ② 问题自动分析（LLM 分类，用户无感）──────────
   │  ├─ 事实问答型？ ──> 向量 RAG 检索
   │  ├─ 关系推理型？ ──> GraphRAG 检索
   │  └─ 混合型？ ────> 两路并行 + 结果合并
   │
   ├─ ③ 向量 RAG 路径 ────────────────────────────────
   │  ├─ BM25Retriever ──> 关键词精确匹配 (top-N)
   │  ├─ Chroma 向量 ──> 语义相似 (top-N)
   │  └─ EnsembleRetriever ──> RRF 融合
   │
   ├─ ④ GraphRAG 路径 ────────────────────────────────
   │  ├─ 实体识别 ──> 从完善后的 query 中提取关键实体
   │  ├─ Cypher 生成 ──> LLM 生成图查询语句
   │  ├─ Neo4j 图遍历 ──> 返回相关子图
   │  └─ 子图序列化 ──> 转为文本上下文
   │
   ├─ ⑤ 结果合并 (如果双路并行)
   │
   ├─ ⑥ CohereRerank ──> 精排 (可选)
   │
   └─ 返回 top-K 上下文 + 元数据
```

### 生成流程

```
检索结果 (top-K 上下文)
   │
   ├─ Prompt 构造 (带编号引用 + 约束指令)
   │
   ├─ @aipack-ai/agent createRuntime + streamFn
   │
   └─ SSE 流式推送 delta + 引用溯源
```

## 四、文档处理详解

### 4.1 LangChain DocumentLoaders

| 文档类型 | Loader               | 来源                                                |
| -------- | -------------------- | --------------------------------------------------- |
| `.md`    | MarkdownLoader       | `@langchain/community/document_loaders/markdown`    |
| `.txt`   | TextLoader           | `@langchain/community/document_loaders/text`        |
| `.html`  | CheerioWebBaseLoader | `@langchain/community/document_loaders/web/cheerio` |
| `.pdf`   | PDFLoader            | `@langchain/community/document_loaders/fs/pdf`      |
| `.csv`   | CSVLoader            | `@langchain/community/document_loaders/fs/csv`      |
| `.json`  | JSONLoader           | `@langchain/community/document_loaders/fs/json`     |
| `.docx`  | DocxLoader           | `@langchain/community/document_loaders/fs/docx`     |
| 粘贴文本 | TextLoader           | 直接构造                                            |

Loader 注册表按文件扩展名路由，统一返回 `Document[]`（`{ pageContent, metadata }`）。

### 4.2 文本切分

使用 `RecursiveCharacterTextSplitter`：

```typescript
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 500,
  chunkOverlap: 50,
  separators: [
    '\n\n',
    '\n',
    '。',
    '！',
    '？',
    '；',
    '.',
    '!',
    '?',
    ';',
    ' ',
    '',
  ],
});
```

### 4.3 元数据

```typescript
interface ChunkMetadata {
  source: string;
  fileType: string;
  section?: string;
  page?: number;
  line?: number;
  timestamp: string;
}
```

### 4.4 文档增量更新（Indexing Sync）

知识库是动态的：文档会新增、修改、删除。如果每次改动都全量重建，浪费且低效。方案采用**文档级增量同步**。

#### 4.4.1 文档指纹（Manifest）

维护一份 `manifest.json`，记录每个已索引文档的指纹，实现**幂等 ingest**：

```json
{
  "faq.md": {
    "hash": "sha256:7f83b1...",
    "chunkCount": 12,
    "updatedAt": "2026-08-27T10:00:00Z"
  },
  "手册.pdf": {
    "hash": "sha256:9d2c4f...",
    "chunkCount": 35,
    "updatedAt": "2026-08-27T09:30:00Z"
  }
}
```

- **hash**：文件内容的 sha256，用于检测文档是否真的变了
- 同一文件重复上传：hash 相同 → 直接跳过，不重复索引
- 文件内容变化：hash 不同 → 触发增量更新

#### 4.4.2 三种索引的更新策略

| 索引             | 删除旧数据                                         | 写入新数据                           |
| ---------------- | -------------------------------------------------- | ------------------------------------ |
| **Chroma**       | `store.delete({ filter: { source: path } })`       | 重新切分 + embed + add               |
| **BM25**（内存） | 从内存 docs 中移除该 source 的旧 chunk             | 重新 add                             |
| **Neo4j**        | `MATCH (n) WHERE n.source = $path DETACH DELETE n` | 重新抽取实体关系 + addGraphDocuments |

所有 chunk 的元数据都携带 `source`，天然支持按文档定位和清理。

#### 4.4.3 ingest 流程（含增量）

```
POST /api/ingest { files: [{name, content}] }
   │
   ├─ 对每个文件：
   │  ├─ 计算内容 hash
   │  ├─ 查 manifest
   │  │  ├─ hash 相同 ──> 跳过（幂等，返回 skipped）
   │  │  ├─ hash 不同（已存在）──> 增量更新：
   │  │  │    ├─ 删除旧数据：Chroma delete + BM25 移除 + Neo4j 清理
   │  │  │    ├─ 重新索引：loader → splitter → embed → 双路写入
   │  │  │    └─ 更新 manifest
   │  │  └─ 不存在 ──> 全新索引：loader → splitter → 双路写入 → 记录 manifest
   │  └─ 返回 { added, updated, skipped }
```

#### 4.4.4 删除文档

```
POST /api/documents/delete { source: "faq.md" }
   │
   ├─ Chroma:   delete({ filter: { source } })
   ├─ BM25:     从内存 docs 移除
   ├─ Neo4j:    DETACH DELETE 该 source 的节点
   └─ Manifest: 移除条目
```

#### 4.4.5 批量与性能

- **批量更新优于逐条**：攒一批变更后统一重建 BM25 内存索引、批量 upsert Chroma（减少 HNSW 增量退化）
- **BM25 内存索引重启丢失**：启动时从 Chroma 全量拉取 chunks 重建，或从 manifest 记录恢复
- **定期全量重建（可选）**：数据量大或索引退化时，离线重建 + 热切换（参考 HNSW 增量构建退化问题）
- 单文档更新粒度足够（文档不大时整个文档重新索引，成本低）；如需 chunk 级精确更新，为每个 chunk 加内容 hash 后按 chunk 定位，可作为后续增强

## 五、向量 RAG 检索引擎

### 5.1 BM25Retriever（关键词精确匹配）

```typescript
import { BM25Retriever } from '@langchain/community/retrievers/bm25';

const bm25Retriever = BM25Retriever.fromDocuments(docs, { k: 20 });
```

### 5.2 Chroma 向量检索（语义相似）

```typescript
import { Chroma } from '@langchain/community/vectorstores/chroma';
import { OpenAIEmbeddings } from '@langchain/openai';

const vectorStore = await Chroma.fromDocuments(docs, embeddings, {
  collectionName: 'learn-rag',
  url: process.env.CHROMA_URL || undefined, // 留空则嵌入式
});
```

### 5.3 EnsembleRetriever（RRF 自动融合）

```typescript
import { EnsembleRetriever } from '@langchain/community/retrievers/ensemble';

const ensembleRetriever = new EnsembleRetriever({
  retrievers: [bm25Retriever, vectorRetriever],
  weights: [0.5, 0.5],
});
```

### 5.4 元数据过滤

```typescript
// Chroma 原生支持
const results = await vectorStore.similaritySearch(query, 20, {
  source: 'faq.md',
  fileType: 'markdown',
});
```

## 六、GraphRAG 检索引擎

### 6.1 为什么需要 GraphRAG

| 场景                                         | 向量 RAG             | GraphRAG             |
| -------------------------------------------- | -------------------- | -------------------- |
| "密码重置流程是什么？"                       | 擅长（语义匹配）     | 一般                 |
| "张三和李四分别负责哪些项目？"               | 擅长（关键词命中）   | 一般                 |
| "张三负责的项目的客户公司是谁投资的？"       | 不擅长（需多跳推理） | **擅长**             |
| "React 生态中和 Vue Router 对应的库是什么？" | 一般                 | **擅长**（关系推理） |
| "这个系统架构中 A 模块依赖 B 模块的原因？"   | 不擅长               | **擅长**             |

**核心差异**：向量 RAG 是"找相似的"，GraphRAG 是"找关联的"。多跳关系推理是向量检索的结构性盲区。

### 6.2 GraphRAG 索引流程

```
文档 chunks
   │
   ├─ LLMGraphTransformer（用 aipack LLM）
   │  ├─ 实体抽取：人名、组织、项目、技术、地点...
   │  ├─ 关系抽取：负责、属于、依赖、投资、位于...
   │  └─ 输出 (Entity, Relation, Entity) 三元组
   │
   ├─ 写入 Neo4j
   │  ├─ 节点：带类型 + 属性（source, chunk_id）
   │  └─ 边：带关系类型 + 属性
   │
   └─ 可选：社区检测 + 社区摘要
         ├─ Louvain/Leiden 算法聚类
         └─ LLM 为每个社区生成摘要（用于全局问答）
```

```typescript
import { Neo4jGraph } from '@langchain/community/graphs/neo4j';
import { LLMGraphTransformer } from '@langchain/community/llm_graph_transformer';

// 1. 连接 Neo4j
const graph = await Neo4jGraph.initialize({
  url: process.env.NEO4J_URL || 'bolt://localhost:7687',
  username: process.env.NEO4J_USER || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'password',
});

// 2. LLM 实体关系抽取（用 aipack 装配的 LLM）
const transformer = new LLMGraphTransformer({
  llm: wrappedLlm, // aipack model 适配为 LangChain LLM 接口
  allowedNodes: ['Person', 'Organization', 'Project', 'Technology', 'Location'],
  allowedRelationships: [
    'WORKS_AT',
    'RESPONSIBLE_FOR',
    'DEPENDS_ON',
    'INVESTED_BY',
    'LOCATED_IN',
  ],
});

// 3. 逐 chunk 抽取并写入图
for (const chunk of chunks) {
  const graphDocuments = await transformer.invoke(chunk);
  await graph.addGraphDocuments(graphDocuments, { baseEntityLabel: true });
}
```

### 6.3 GraphRAG 检索流程

**方式一：Cypher 查询（精确图检索）**

```typescript
import { GraphCypherQAChain } from '@langchain/community/chains/graph_qa/cypher';

const cypherChain = GraphCypherQAChain.fromLLM({
  llm: wrappedLlm,
  graph: graph,
  qaPrompt: QA_PROMPT,
});

// 用户问题 -> LLM 生成 Cypher -> Neo4j 执行 -> 结果转文本 -> LLM 生成回答
const result = await cypherChain.invoke({ query: question });
```

**方式二：实体匹配 + 子图扩展（语义图检索）**

```typescript
// 1. 从问题中识别实体
const entities = await extractEntities(question); // LLM 抽取

// 2. Neo4j 实体匹配 + N跳邻居
const cypher = `
  MATCH (n) WHERE n.name CONTAINS $entityName
  MATCH (n)-[r*1..3]-(m)
  RETURN n, r, m LIMIT 50
`;

// 3. 子图序列化为文本上下文
const context = serializeSubgraph(subgraph);
```

**方式三：社区摘要检索（全局问答，可选进阶）**

```
用户问题 -> 向量检索社区摘要 -> 取 top-K 社区 -> 拼接为上下文 -> LLM 生成
```

### 6.4 向量 RAG 与 GraphRAG 对比

| 维度     | 向量 RAG                     | GraphRAG                      |
| -------- | ---------------------------- | ----------------------------- |
| 索引方式 | chunk -> embedding -> 向量库 | chunk -> LLM 抽取 -> Neo4j 图 |
| 检索方式 | 语义相似度                   | 图遍历 / Cypher 查询          |
| 擅长     | 事实问答、概念匹配           | 多跳推理、关系查询            |
| 索引成本 | 低（API 调用 embedding）     | 高（LLM 抽取实体关系）        |
| 检索延迟 | 快（10~100ms）               | 中（Cypher 生成 + 图遍历）    |
| 数据要求 | 文本即可                     | 文本需包含实体关系信息        |
| 可解释性 | 中（来源溯源）               | 高（关系路径可视化）          |

## 七、查询完善（Query Enrichment）

用户提问往往简短、口语化、指代不明（"那个项目谁负责？""它怎么用？"）。直接拿去检索，BM25 匹配不到关键实体、向量检索语义模糊，效果很差。因此在路由前先做**查询完善**。

### 7.1 完善策略

| 策略               | 场景                       | 示例                                                  |
| ------------------ | -------------------------- | ----------------------------------------------------- |
| 补全缺失信息       | 口语化、省略主语           | "退款咋整？" -> "XX平台的退款流程是什么？"            |
| 消解指代           | 多轮对话中的"它/那个/这个" | "它怎么用？" -> "React 18 的 useTransition 怎么用？"  |
| 补充关键实体       | 专有名词被省略             | "那个架构的问题" -> "XX 系统的架构设计存在什么问题？" |
| 多角度变体（可选） | 扩大召回                   | 生成 2~3 个同义 query 分别检索再合并                  |

### 7.2 实现（aipack Runtime）

用独立的 `rewrite` Runtime（与 Answer Runtime 同构，不同 system prompt）：

```typescript
const REWRITE_SYSTEM_PROMPT = `你是查询完善专家。用户的问题可能很简短或指代不明。
请结合对话历史，把问题改写成完整、规范、可直接用于搜索的查询。

要求：
1. 补全缺失的实体、主语、上下文
2. 消解"它/那个/这个"等指代
3. 保持原意，不要编造不存在的信息
4. 只输出改写后的查询，不要解释

对话历史：
{history}

用户问题：{question}`;
```

### 7.3 判断是否需要完善

- 查询长度 < N 字符（如 15）→ 触发完善
- 包含指代词（它/那个/这个/他/她）→ 触发完善
- 多轮对话的后续提问 → 总是结合历史完善（补全上下文）
- 其他情况 → 原样使用，减少一次 LLM 调用（省延迟省成本）

### 7.4 完善后的 query 同时用于

1. 路由分类（② 问题自动分析）
2. 向量 RAG 检索（③）
3. GraphRAG 实体识别（④）

### 7.5 多轮对话的完整流程

```
用户: "React 18 有什么新特性？"
助手: "React 18 引入了 useTransition、Automatic Batching..."
用户: "那个性能的怎么用？"     ← 指代不明
   │
   ├─ 完善: "React 18 的 useTransition 性能优化怎么用？"
   ├─ 路由: vector
   └─ 检索 + 生成
```

### 7.6 SSE 事件（透传完善结果，仅展示）

```
event: query_enriched  data: { original: "那个性能的怎么用？", enriched: "React 18 的 useTransition 性能优化怎么用？" }
event: routing          data: { mode: "graph", reason: "检测到关系查询" }
```

## 八、检索路由（自动，用户无感）

用户不需要也不应该选择检索模式。系统通过 LLM 自动分析问题类型，路由到合适的引擎。

### 8.1 自动路由策略

```typescript
// 内部类型，不暴露给用户
type RetrievalMode = 'vector' | 'graph' | 'hybrid';

// LLM 分析问题类型，自动决定用哪个引擎
async function routeQuery(
  question: string,
  llm: Runtime,
): Promise<RetrievalMode> {
  // 用 aipack LLM 做单轮分类：
  //   "你是查询路由专家。分析用户问题，判断检索方式：
  //    - vector: 事实问答、概念解释、流程查询（"是什么""怎么做"）
  //    - graph:  关系推理、多跳查询、依赖分析（"谁...的...""为什么"）
  //    - hybrid: 两者兼需
  //    只返回 vector / graph / hybrid 之一"
  //
  // 兜底规则（LLM 不可用时）：
  //   含"关系/依赖/影响/谁...的..." -> graph
  //   含"是什么/怎么做/流程" -> vector
  //   默认 -> hybrid
}
```

### 8.2 路由结果透传（仅用于展示，不用于选择）

SSE 事件中携带路由结果，前端展示"本次使用了 XX 检索"，但用户无法干预：

```
event: routing    data: { mode: "graph", reason: "检测到关系查询" }
```

### 8.3 混合模式结果合并

```typescript
// 两路并行检索
const [vectorResults, graphResults] = await Promise.all([
  ensembleRetriever.invoke(question),
  graphRetriever.retrieve(question),
]);

// 合并 + 去重 + Rerank
const merged = dedup([...vectorResults, ...graphResults]);
const reranked = await rerank(merged, question, topK: 5);
```

## 九、生成层（aipack-ai/agent）

### 9.1 Agent 装配

```typescript
import {
  getBuiltinModel,
  adaptAiModel,
  createStreamFnFromAi,
  createRuntime,
  createMemorySessionStorage,
} from '@aipack-ai/agent';

const aiModel = getBuiltinModel('deepseek', 'deepseek-chat');
const model = adaptAiModel(aiModel);
const streamFn = createStreamFnFromAi(aiModel);

const runtime = createRuntime({
  model,
  streamFn,
  systemPrompt: ANSWER_SYSTEM_PROMPT,
  tools: [],
  sessionStorage: createMemorySessionStorage(),
  maxTurns: 1,
});
```

### 9.2 Prompt 模板

```text
你是一个严谨的问答助手。请仅基于以下参考内容回答用户问题。
如果参考内容中没有相关信息，请回答"根据已知信息无法回答"，不要编造。

【参考内容】
[1] 来源：产品手册.pdf / 第3页
    内容：密码重置流程：1. 点击登录页"忘记密码"...

[2] 来源：知识图谱 / 实体关系
    内容：张三 -[负责]-> 项目A；项目A -[客户]-> 公司B；公司B -[投资方]-> VC-C

【用户问题】
张三负责的项目的客户公司是谁投资的？
```

### 9.3 流式输出

```
event: query_enriched data: { original: "那个性能的怎么用？", enriched: "React 18 的 useTransition 性能优化怎么用？" }
event: routing         data: { mode: "graph", reason: "检测到关系查询" }  // 自动路由结果，仅展示
event: retrieval       data: { count: 5, sources: [...] }
event: answer_start
event: delta           data: { delta: "根据知识图谱..." }
event: done             data: { answer: "..." }
```

## 十、API 设计（Hono）

| Method | Path                    | 功能                                              | 请求体                                  |
| ------ | ----------------------- | ------------------------------------------------- | --------------------------------------- |
| POST   | `/api/ingest`           | 上传文档，自动解析->切分->双引擎索引（增量/幂等） | `{ files, texts }`                      |
| POST   | `/api/query`            | SSE 流式问答（自动路由检索引擎）                  | `{ question, filter? }`                 |
| GET    | `/api/stats`            | 索引统计（向量数、节点数、关系数）                | -                                       |
| GET    | `/api/documents`        | 已索引文档清单（manifest）                        | -                                       |
| POST   | `/api/documents/delete` | 删除指定文档（三索引 + manifest）                 | `{ source }`                            |
| GET    | `/api/graph`            | 知识图谱可视化数据（节点+边）                     | `?entity=xxx&depth=3`                   |
| POST   | `/api/clear`            | 清空知识库（向量 + 图 + manifest）                | `{ engine?: 'vector'\|'graph'\|'all' }` |
| GET    | `/api/config`           | 模型列表 + 就绪状态                               | -                                       |

## 十一、目录结构

```
learn-rag/
├── README.md
├── PLAN.md                        # 本文件
├── docker-compose.yml             # Neo4j + Chroma 一键启动
├── package.json                   # 后端依赖
├── tsconfig.json
├── .env.example
├── data/                          # 示例文档
│   ├── sample.md
│   ├── sample.csv
│   └── sample.json
│
├── src/                           # 后端
│   ├── index.ts                   # 入口：启动 Hono 服务
│   ├── config.ts                  # 环境配置 + aipack 模型装配
│   ├── types.ts                   # 共享类型定义
│   │
│   ├── loaders/                   # 文档加载器
│   │   └── registry.ts            #   按扩展名路由到 LangChain loader
│   │
│   ├── processing/                # 切分
│   │   └── splitter.ts            #   RecursiveCharacterTextSplitter 封装
│   │
│   ├── store/                     # 索引存储
│   │   ├── chroma-store.ts         #   Chroma 向量库（支持按 source 删除）
│   │   ├── bm25-store.ts           #   BM25Retriever（支持移除/重建）
│   │   ├── neo4j-graph.ts         #   Neo4j 图库连接 + 写入 + 按 source 清理
│   │   └── manifest.ts            #   文档指纹清单（hash/幂等/增量判断）
│   │
│   ├── retrieval/                 # 检索层
│   │   ├── query-rewrite.ts        #   查询完善（LLM 改写简短/指代 query）
│   │   ├── vector-rag.ts           #   向量 RAG（BM25 + Chroma + Ensemble）
│   │   ├── graph-rag.ts            #   GraphRAG（Cypher + 子图扩展）
│   │   ├── router.ts               #   检索路由（问题分类 -> 引擎选择）
│   │   └── reranker.ts             #   CohereRerank（可选）
│   │
│   ├── generation/                 # 生成层
│   │   ├── prompt.ts              #   Prompt 模板构造
│   │   └── agent.ts                #   aipack Runtime 装配（rewrite/router/answer）+ 流式调用
│   │
│   ├── pipeline.ts                 # RAG 管道：ingest + query 串联
│   │
│   └── server/                     # 后端 API
│       └── hono-server.ts          #   Hono 路由 + SSE
│
└── web/                           # 前端 React 应用
    ├── package.json               #   前端依赖（vite, react, react-dom）
    ├── vite.config.ts             #   Vite 配置（dev proxy -> Hono API）
    ├── tsconfig.json
    ├── index.html
    └── src/
        ├── main.tsx               #   入口
        ├── App.tsx                #   主布局 + 路由
        ├── components/
        │   ├── ChatPanel.tsx      #     聊天界面 + SSE 流式接收
        │   ├── SourceList.tsx     #     检索来源展示（带高亮）
        │   ├── RetrievalBadge.tsx #     检索引擎标识（展示自动路由结果）
        │   ├── DocUploader.tsx    #     文档上传 + 粘贴文本
        │   ├── StatsPanel.tsx     #     索引统计（向量数/节点数/关系数）
        │   └── GraphView.tsx     #     知识图谱可视化（react-force-graph / cytoscape）
        ├── hooks/
        │   ├── useSSE.ts          #     SSE 流式 hook
        │   └── useApi.ts          #     API 请求封装
        └── styles/
            └── global.css
```

## 十二、分阶段实施

| 阶段           | 内容                                                  | 产出                                 |
| -------------- | ----------------------------------------------------- | ------------------------------------ |
| **P1**         | 工程初始化 + 依赖安装 + 配置加载 + docker-compose     | 可运行的 TS 项目 + Neo4j/Chroma 容器 |
| **P2**         | Loader 注册表（md/txt/html/csv/json/pdf）             | 多格式文档 -> Document[]             |
| **P3**         | RecursiveCharacterTextSplitter 切分                   | 干净的 chunk + 元数据                |
| **P4**         | 向量 RAG 引擎（Chroma + BM25 + Ensemble）+ manifest   | 向量检索可用 + 增量/幂等 ingest      |
| **P5**         | GraphRAG 引擎（LLMGraphTransformer + Neo4j + Cypher） | 图检索可用（含按 source 清理）       |
| **P6**         | 查询完善 + 自动检索路由（LLM 分类，用户无感）         | 简短 query 自动补全 + 双引擎路由     |
| **P7**         | aipack Agent（rewrite/router/answer）+ Prompt + 流式  | 完整 RAG 管道                        |
| **P8**         | Hono API 服务 + React 前端（Vite）+ SSE + 图谱可视化  | 可交互的 Web 应用                    |
| **P9**（可选） | Rerank、社区摘要、图谱可视化                          | 增强能力                             |

## 十三、依赖清单

### 后端（根目录 package.json）

```json
{
  "dependencies": {
    "@aipack-ai/agent": "^0.0.2",
    "@langchain/core": "^0.3.x",
    "@langchain/community": "^0.3.x",
    "@langchain/openai": "^0.3.x",
    "@langchain/textsplitter": "^0.1.x",
    "chromadb": "^1.9.x",
    "neo4j-driver": "^5.x",
    "hono": "^4.x",
    "zod": "^3.x"
  },
  "devDependencies": {
    "@types/node": "^20.x",
    "tsx": "^4.x",
    "typescript": "^5.x"
  }
}
```

### 前端（web/package.json）

```json
{
  "dependencies": {
    "react": "^18.x",
    "react-dom": "^18.x",
    "react-force-graph-2d": "^1.x"
  },
  "devDependencies": {
    "@types/react": "^18.x",
    "@types/react-dom": "^18.x",
    "@vitejs/plugin-react": "^4.x",
    "vite": "^5.x",
    "typescript": "^5.x"
  }
}
```

## 十四、环境变量

```bash
# .env.example

# ── LLM (aipack-ai/agent) ──
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-chat
DEEPSEEK_API_KEY=

# ── Embedding ──
OPENAI_API_KEY=
OPENAI_BASE_URL=

# ── Chroma 向量库 ──
CHROMA_URL=                       # 留空则嵌入式启动

# ── Neo4j 图库 ──
NEO4J_URL=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=password

# ── 服务 ──
PORT=3000

# ── 可选：Rerank ──
COHERE_API_KEY=
```

## 十五、Docker Compose

```yaml
# docker-compose.yml
services:
  neo4j:
    image: neo4j:5
    ports:
      - '7687:7687' # Bolt
      - '7474:7474' # Web UI (http://localhost:7474)
    environment:
      NEO4J_AUTH: neo4j/password
    volumes:
      - neo4j_data:/data

  chroma:
    image: chromadb/chroma:latest
    ports:
      - '8000:8000'
    volumes:
      - chroma_data:/chroma/chroma

volumes:
  neo4j_data:
  chroma_data:
```

## 十六、关键设计决策

1. **双引擎架构**：向量 RAG 管"找相似的"，GraphRAG 管"找关联的"，互补覆盖不同问题类型
2. **不自研，全部用成熟库**：LangChain.js 管文档/检索，Chroma 管向量，Neo4j 管图，Hono 管后端，React 管前端
3. **Agent 层用 aipack**：`@aipack-ai/agent` 提供 `createRuntime` + `streamFn`
4. **GraphRAG 用 LLMGraphTransformer**：LLM 自动抽取实体关系，无需手工标注
5. **查询完善前置**：用户 query 过短/指代不明时先 LLM 改写，再进入路由和检索，保障检索质量
6. **检索路由全自动**：LLM 分析问题类型自动选择引擎，用户无感，不暴露模式选择
7. **增量同步**：manifest 内容 hash 实现幂等 ingest，文档级增删改同步到三索引（Chroma/BM25/Neo4j），避免全量重建
8. **Chroma 嵌入式起步**：无需额外服务；Neo4j 用 Docker 一键启动
9. **流式输出**：aipack `streamFn` 推送 delta，Hono SSE 转发
10. **图谱可视化**：`/api/graph` 返回节点边数据，前端 React 渲染关系图
