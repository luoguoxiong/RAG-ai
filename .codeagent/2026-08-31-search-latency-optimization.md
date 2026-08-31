# 检索延迟优化（2026-08-31）

背景：/search 平均耗时 13.45s（检索 5.76s + 生成 7.69s，平均引用 4.0）。
根因：检索段多次串行 LLM 调用（变换 + LLM Reranker + embedding）；生成段上下文未截断、无 max_tokens 上限。

## 改动

### 1. Multi Query 每路去掉 LLM 重排，融合后统一重排一次
- `src/query/index.ts`：`retrieveEvidenceMulti` 增加 `query` 入参，各变体传 `useReranker: false`（仅按融合分召回，省 N-1 次 LLM 调用），RRF 融合后对最终 topK 统一做一次重排（复用 `getReranker`）。
- `transformAndRetrieve` 调用点同步传入原始 query。

### 2. 证据 ≤ 3 条时跳过 LLM 重排
- `src/retrieval/retriever.ts`：导出常量 `RERANK_MIN_EVIDENCE = 4`；`retrieveEvidence` 中 `evidence.length < 4` 时直接按融合分返回。

### 3. 生成段：上下文截断 + max_tokens 上限
- `src/application/query.ts`：`buildMessages` 增加截断（单条 1500 字符、总 8000 字符，超预算按相关度丢弃尾部证据）；`generateAnswer` 传 `maxTokens: 1024`。

## 后续实施：Embedding 批量 + Redis 结果缓存（同日追加）

### 4. Embedding 批量（multi-query 一次 API 请求）
- `src/retrieval/retriever.ts`：`Retriever.retrieve` / `VectorRetriever.retrieve` 增加第 5 参 `vector?: number[]`；`RetrieveOptions` 增加 `vector` 字段；`retrieveEvidence` 透传。
- `src/query/index.ts`：`retrieveEvidenceMulti` 先 `getEmbedding().embed(queries)` 批量嵌入一次，各变体复用对应向量。

### 5. Redis 结果缓存 (tenantId, query, topK) → citations
- `src/config.ts`：新增 `searchCacheTtlSeconds`（环境变量 `SEARCH_CACHE_TTL`，默认 600 秒，0 关闭）。
- 新增 `src/cache/search.ts`：键 = sha256(tenantId|topK|intelligence|query)，复用 `src/queue/index.ts` 的共享 ioredis 实例；Redis 异常静默降级为未命中/不写。
- `src/application/query.ts`：`SearchResult` 增加 `cached?: boolean`；`answerQuery` 读缓存命中直接返回（retrievalMs/generationMs=0），计算完成后写缓存；带 goldChunkIds 的评估请求不读不写缓存（保证指标语义）。

## 验证
- `npx tsc --noEmit` 通过。

## 预期效果
- 检索 5.76s → 约 2~3s（少 1~N 次 LLM 调用）
- 生成 7.69s → 约 4~5s（上下文缩小 + 输出受限）
- 总计 13.45s → 约 6~8s

## 后续可选（未实施）
- 流式输出（SSE 首包渲染）
- Multi Query embedding 批量合并
- Redis 结果缓存
