# 切片（Chunking）设计文档

> 对应代码：[src/ingestion/splitters.ts](file:///Users/kye/Documents/ai/learn-rag/src/ingestion/splitters.ts)、[src/ingestion/parser.ts](file:///Users/kye/Documents/ai/learn-rag/src/ingestion/parser.ts)、[src/application/ingestion.ts](file:///Users/kye/Documents/ai/learn-rag/src/application/ingestion.ts)

## 1. 设计目标

切片环节要同时满足三个目标：

1. **检索精准**：小块做向量/关键词召回，命中率高。
2. **上下文完整**：命中后需要把整段上下文喂给 LLM，避免只见树木不见森林。
3. **语义完整**：不做字符级硬切（会把一句话、一段代码拆碎，破坏语义）。

因此采用 **Parent/Child 两级切片**（Parent-Child Retrieval 模式），并按文档类型分发不同的切分策略。

## 2. 核心概念：Parent / Child 两级

| 层级 | 目标大小 | 职责 | 是否进检索索引 |
|------|---------|------|--------------|
| **child** | ~400 字符 | 检索单元，向量/关键词索引的最小粒度 | ✅ 是 |
| **parent** | ~2000 字符 | 上下文单元，命中 child 后用其所属 parent 回填上下文喂 LLM | ❌ 否（仅存库） |

- child 只存检索所需的最小语义片段；
- parent 由相邻 child 贪心聚合而成，保证上下文完整；
- 检索命中 child → 回表其 `parentId` → 用 parent 内容作为 LLM 上下文（见 [retriever.ts](file:///Users/kye/Documents/ai/learn-rag/src/retrieval/retriever.ts) 的 `assembleEvidence`）。

## 3. 架构：与 Parser 对称的分发设计

切分层与解析层对称：解析按文件类型分发（parser.ts），切分也按文档类型分发。

```
文档 → Parser（按类型） → ParsedDocument{ text, language, ... }
                          ↓
              splitterFor(language) → Splitter
                          ↓
              ParentChildChunk[]（parent + children）
```

- [Splitter 接口](file:///Users/kye/Documents/ai/learn-rag/src/ingestion/splitters.ts#L8-L13)：`supports(language?)` 判断是否适用，`split(text)` 返回 parent/child 两级结构。
- 分发依据是解析器写入的 `metadata.language`（如 markdown / pdf / docx）。
- 所有切分器统一返回 `ParentChildChunk[]`，下游 `processVersion` 的哈希、落库逻辑完全不变（零侵入）。
- 注册表 [splitters](file:///Users/kye/Documents/ai/learn-rag/src/ingestion/splitters.ts#L196-L201)：MarkdownSplitter 在前（专用优先），SentenceSplitter 在后兜底（`supports()` 恒为 true）。

## 4. 通用切分器：SentenceSplitter（text / pdf / docx）

[代码](file:///Users/kye/Documents/ai/learn-rag/src/ingestion/splitters.ts#L63-L76)

```
splitSentences（分句）
   → toChildren（句子 → child，超长句独立成块）
      → toGroups（child → parent/child 组）
```

### 4.1 分句：splitSentences

按中英文句号/问号/感叹号/分号切分，lookbehind 正则保留分隔符在句尾：

```ts
text.split(/(?<=[。！？；.!?;])\s*/)
```

句子保持完整，**不做字符级硬切**，避免语义碎片化。

### 4.2 句子聚合为 child：toChildren

- 逐句累积，加入下句会超 `CHILD_MAX`（400 字符）时闭合当前 child；
- 单句超长时该句独立成块（不硬拆句子）。

### 4.3 child 聚合成 parent：toGroups

- 逐 child 累积，`parent.length + child.length + 2 > PARENT_MAX`（2000）时闭合当前组；
- `+2` 是 `"\n\n"` 分隔符的长度，parent 组内 child 以空行连接。

## 5. Markdown 专用切分器：MarkdownSplitter（结构感知）

[代码](file:///Users/kye/Documents/ai/learn-rag/src/ingestion/splitters.ts#L151-L193)

Markdown 有标题层级，直接按句子切会丢失"这段属于哪一节"的信息。因此 MarkdownSplitter 增加结构感知：

### 5.1 按标题分节：splitByHeadings

- 按 ATX 标题（`#` ~ `######`）把文档切成分节；
- 标题作为节的**语义锚点**。

### 5.2 节内拆块：splitBlocks

节内容按行拆成三种块：

| 块类型 | 处理方式 |
|--------|---------|
| 围栏代码块（```` ``` ````） | **整体保留**为一个块，不拆散（拆开会破坏代码语义） |
| 表格块（连续 `|` 行） | **整体保留**为一个块 |
| 普通段落（直到空行） | 保留内部换行，后续再按句子细分 |

### 5.3 块 → child

- 代码块 / 表格：**整体作为一个 child**（可能超长，但拆开结构就坏了）；
- 普通段落：走 `splitSentences` + `toChildren` 按句子聚合。

### 5.4 带标题前缀的 parent 聚合

- parent 以 `# 标题` 作为前缀，检索命中后可定位"来自哪一节"；
- parent 超长时按 child 分片闭合，**每个分片仍带标题前缀**（保证上下文可定位）。

## 6. 关键参数

| 常量 | 值 | 含义 |
|------|-----|------|
| `CHILD_MAX` | 400 | child 目标字符数，控制向量召回粒度 |
| `PARENT_MAX` | 2000 | parent 目标字符数，超过则另起一组 |
| 分隔符 | `"\n\n"` | parent 组内 child 的连接符（长度 +2 计入上限判断） |

## 7. 消费链路：processVersion

[代码](file:///Users/kye/Documents/ai/learn-rag/src/application/ingestion.ts#L148-L268)

```
normalize(原文) → 取 language → splitterFor(language)
  → splitter.split(text) → ParentChildChunk[]
  → 预计算 contentHash（kind 区分 parent/child，避免同内容哈希碰撞）
  → 清理过期 chunk（先清 index_status 再删 chunk）
  → 幂等落库（chunks 表：parent 先插、child 后插并回填 parentId；chunkIndex 全局递增）
  → 投递 chunk.upserted 到 Outbox → Reconciliation 异步写派生索引
```

幂等性：chunk 主键由 `(documentVersionId, contentHash)` 稳定哈希推导 + `onConflictDoNothing` 去重，同一版本重复处理只会得到同一批 chunk，可安全重跑。

存储结构见 [chunk.ts](file:///Users/kye/Documents/ai/learn-rag/src/db/schema/chunk.ts#L13-L43)：

- `type` 区分 `parent` / `child`；
- `parentId` 指向所属 parent（child 有值，parent 为 null）；
- `chunkIndex` 保证版本内顺序唯一。

## 8. 检索侧如何使用两级结构

[assembleEvidence](file:///Users/kye/Documents/ai/learn-rag/src/retrieval/retriever.ts#L71-L114)：

1. 按命中的 childId 回表 child 行；
2. 收集 child 的 `parentId`，批量回表 parent 行；
3. 组装 Evidence 时，`content` 取 **parent 内容**（parent 缺失时退回 child 内容），作为 LLM 上下文；`chunkId` 仍指向 child（保持引用精确）。

这样做到：**用 child 召回（精准），用 parent 作答（完整）**。

## 9. 演进历史

| 阶段 | 实现 | 说明 |
|------|------|------|
| Phase 1 | `ParagraphSplitter`（[splitter.ts](file:///Users/kye/Documents/ai/learn-rag/src/ingestion/splitter.ts)） | 段落聚合到 1000 字符 + 200 overlap，单段超长字符硬切，一刀切策略 |
| Phase 2 | `ParentChildSplitter`（[parent-child.ts](file:///Users/kye/Documents/ai/learn-rag/src/ingestion/parent-child.ts)） | child 400 / overlap 80 / parent 2000，两级结构 |
| Phase 3+ | `splitters.ts` 分类型切分 | 按 `metadata.language` 分发：Markdown 标题感知 + 代码块/表格整体保留；text/pdf/docx 句子级切分 |

## 10. 设计要点总结

1. **两级结构**：child 召回精准，parent 上下文完整，二者兼顾。
2. **分类型分发**：与 Parser 对称，Markdown 结构感知，其余句子级切分。
3. **句子完整性**：不做字符级硬切；代码块/表格整体保留为 child。
4. **标题语义锚点**：Markdown 的 parent 带标题前缀，命中可定位章节。
5. **幂等落库**：稳定 contentHash + 唯一索引，重复处理安全。
6. **解析前提**：PDF 解析先做段落还原（合并硬换行），否则切分会把同一段落切成碎片。
