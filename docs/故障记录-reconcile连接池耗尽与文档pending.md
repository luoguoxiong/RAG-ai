# 故障记录：Reconcile 连接池耗尽导致文档一直 pending

> 发生时间：2026-08-30
> 相关代码：[src/application/reconcile.ts](file:///Users/peroluo/Document/github/RAG-ai/src/application/reconcile.ts)、[src/db/index.ts](file:///Users/peroluo/Document/github/RAG-ai/src/db/index.ts)、[src/ai/embedding.ts](file:///Users/peroluo/Document/github/RAG-ai/src/ai/embedding.ts)、[src/ai/llm.ts](file:///Users/peroluo/Document/github/RAG-ai/src/ai/llm.ts)

## 1. 现象

- 文档列表（按 `created_at` 倒序）中**最新上传的文档始终是 `pending`**，状态永不流转到 `ready`。
- 该文档的 `index_document` Job 在数据库里是 `pending`，在 BullMQ 里却停在 **active**（带 lock，一直被续租）。
- 前端轮询（2s 间隔）永远刷不出来，看起来像"第一条一直是 padding"（pending）。

## 2. 根因：锁链 + 连接池耗尽（10 个连接全部被占死）

`pg_stat_activity` 实测证据：

| 连接数 | 状态 | 最后一条 SQL | 归属 |
| --- | --- | --- | --- |
| 5 | `idle in transaction` | `select ... from chunks` | Reconcile 在事务内等外部调用返回 |
| 5 | `active` + `Lock/transactionid` | `insert into index_status` | Reconcile 互相等锁 |

故障链路：

1. **长事务包外部 I/O**：[reconcile.ts](file:///Users/peroluo/Document/github/RAG-ai/src/application/reconcile.ts) 的 `dispatchOutbox` / `repairIndexStatus` 把向量 embedding、Qdrant、OpenSearch、Neo4j、**LLM 实体抽取**全部放在 `withTenantTx` 事务内执行。
2. **外部调用无超时**：[embedding.ts](file:///Users/peroluo/Document/github/RAG-ai/src/ai/embedding.ts) 和 [llm.ts](file:///Users/peroluo/Document/github/RAG-ai/src/ai/llm.ts) 的 `fetch` 未设超时，上游挂起时事务无限期开着、连接不释放。
3. **对账周期重叠**：`reconcileIntervalMs` 默认 5s，单轮耗时超过 5s 时多个 `runReconcile` 并发叠加，进一步占满连接。
4. **索引互相等锁**：多个并发事务写同一批 chunk 的 `index_status`（含 FK/唯一索引冲突），PG 默认 `lock_timeout = 0`，永久阻塞。
5. **池满后新 Job 吃瘪**：连接池默认 `max = 10` 被占满后，Worker 消费新 `index_document` Job 的第一步 `markJob("processing")` 就拿不到连接，永久挂起 → DB Job 停在 `pending`、文档停在 `pending`。`recoverStuckJobs` 只恢复 `status=processing` 的 Job，救不了卡在 markJob 之前的，所以对账兜底失效。

## 3. 解决方案（已实施）

### 3.1 Reconcile 短事务化（核心）

外部索引调用移出 DB 事务，改为三段式：

1. **短事务（只读）**：拉取 pending outbox 事件 + 关联 chunk，立即提交释放连接；
2. **事务外**：执行 embedding / 向量 / 关键词 / 图 / LLM 等外部 I/O；
3. **短事务（写）**：落 `index_status` + 标记 outbox done，立即提交。

> 注意：因 RLS 强制开启，外部调用期间不能裸查 DB，所以"短事务"拆成读写两个独立事务，而不是彻底无事务。

### 3.2 runReconcile 防重入锁

模块级 `reconcileRunning` 标志，上一轮未结束时直接返回 `null`，杜绝 5s 间隔下的并发叠加。

### 3.3 外部调用加超时

- embedding：`AbortSignal.timeout(30_000)`
- LLM chat：`AbortSignal.timeout(60_000)`

### 3.4 连接池兜底

[db/index.ts](file:///Users/peroluo/Document/github/RAG-ai/src/db/index.ts) 的 Pool 增加：

- `connectionTimeoutMillis: 10_000`：池满时快速失败而非无限等待；
- `options: "-c idle_in_transaction_session_timeout=60000"`：僵尸事务 60s 服务端自动断开。

### 3.5 现场清理

1. `pg_terminate_backend` 杀掉 10 个卡死连接（idle in transaction + Lock 等待）；
2. 重启 worker（`pnpm run worker`，需 Node 20+，Node 18 会因 undici `File is not defined` 起不来）。

## 4. 验证结果

- 卡住的 README.md 文档：`pending → ready`，Job `ready`，`current_version_id` 已回填；
- `pg_stat_activity`：无 idle-in-transaction、无等锁连接，连接池恢复正常；
- outbox 积压事件持续被消费（短事务化后外部调用不占连接）。

## 5. 后续建议

- 把 `reconcileIntervalMs` 与单轮耗时对齐，或改为串行定时器（前一轮完成后再排下一轮）；
- 生产环境设置 PG `lock_timeout`（如 30s）避免等锁死等；
- 考虑在外部调用侧加超时重试与熔断，避免单点挂起拖垮对账链路。
