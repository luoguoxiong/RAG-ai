# Reconcile 对账循环说明

> 对账循环是系统的兜底机制，周期性扫描并修复所有消费路径上的遗漏，保证数据最终一致。

## 1. 为什么需要对账

业务链路是「先写库 → 落 Outbox 事件 → 消费事件写派生索引」。这条链路上任何一环中断（Worker 崩溃、Qdrant/OpenSearch/Neo4j 暂时不可用、消息丢失），都会造成数据不一致。对账循环就是周期性兜底，修复任何消费路径上的遗漏。

整体设计思路：**先写库、后投递、定期对账兜底** —— 对账循环是最后一道保险，即使正常消费链路全部中断，数据最终也会在每 5 秒的循环里被修复收敛。

## 2. 触发方式：双重驱动

对账不依赖单一触发源，而是双保险：

1. **定时器驱动（主）**：Worker 进程内 `setInterval` 每 `reconcileIntervalMs` 跑一轮，默认 5000ms，可用环境变量 `RECONCILE_INTERVAL_MS` 覆盖。
2. **队列驱动（辅）**：BullMQ 队列中存在 `reconciliation` 类型的系统 Job，Worker 消费到它时也直接跑一轮 `runReconcile`，不关联具体业务 Job、不写 Job 状态。

定时器执行失败会被 `.catch` 兜住并打日志，不影响下一轮继续执行。

## 3. 整体流程

一轮 `runReconcile` 顺序执行四个步骤：

```
1. dispatchOutbox              派发积压的 Outbox 事件，落成派生索引
2. repairIndexStatus           重试未就绪（failed/pending）的索引，清理孤儿记录
3. recoverStuckJobs            恢复卡在 processing 超时的 Job（Worker 崩溃兜底）
4. rebuildCommunitiesIfNeeded  实体/关系变化后按需重建社区（图图谱摘要）
```

每一步都按租户隔离遍历；任一步失败由调用方（setInterval / Worker）捕获记录，不影响下一次对账继续执行。

## 4. 步骤详解

### 4.1 dispatchOutbox —— 派发积压事件（核心）

- 遍历所有租户，在 `withTenantTx` 事务内执行（受 RLS 隔离，只看本租户数据）。
- 取出 `status = pending` 且 `availableAt <= now()` 的事件，按创建时间排序，**每轮最多 200 条**（防止单轮耗时过长）。
- 按事件类型分发：
  - `chunk.upserted` → `applyChunkUpserted`：
    - 先查 chunk 是否还存在（处理「事件与删除竞争」），存在才继续。
    - 写向量 + 关键词索引（仅 child 落索引）。
    - **单独 try/catch 写图索引**：Neo4j 不可用时只标 `graph=failed`，不影响向量/关键词就绪（多级容错）。
    - 幂等 upsert `index_status`（`onConflictDoUpdate`）。
  - `chunk.removed` → `applyChunkRemoved`：从派生索引删除 + 删除 `index_status`。
- 成功 → 事件标 `done`；失败 → `markOutboxFailed`：`attempts+1`，`availableAt` 延迟 `2^attempts` 秒（**指数退避**），下一轮再试。

### 4.2 repairIndexStatus —— 修复索引状态

- 扫描 `index_status` 中任意一路 **≠ ready** 的记录（`vector/keyword = failed` 或 `graph = failed/pending`），每轮最多 200 条。
- chunk 已被删除 → 删除这条孤儿 `index_status`。
- chunk 还在 → 直接重调 `applyChunkUpserted` 重投。

条件中特意包含 `graph = pending`：**在引入 Neo4j 之前就索引过的旧 chunk，其 `graph` 状态为 pending，对账循环会在这里为其补建图索引** —— 这是向后兼容的关键。

### 4.3 recoverStuckJobs —— 恢复卡死 Job

- 找出 `status = processing` 且 `updatedAt` 超过 10 分钟未更新的 Job（Worker 崩溃会留下这种僵尸状态）。
- 重置为 `pending`，再调用 `enqueueJob` 重新入队（BullMQ 配置 `attempts: 5` + 指数退避）。
- 被卡住的文档最终会重新进入处理流程。

### 4.4 rebuildCommunitiesIfNeeded —— 按需重建社区

- 对比 `entities` 数量与 `community_members` 数量是否一致；不一致说明实体/关系有变化，触发社区重建（连通分量检测 + 摘要生成）。
- 重建失败仅告警，不影响其他步骤。

## 5. 容错设计总结

| 层级 | 机制 |
| --- | --- |
| 事件级 | Outbox 指数退避重试（`2^attempts` 秒），失败不丢 |
| 索引级 | 图索引失败只标 `graph=failed`，不阻塞向量/关键词；对账下一轮自动重试 |
| Job 级 | 卡死超时自动重置并重新入队，覆盖 Worker 崩溃场景 |
| 循环级 | 四个步骤互相独立，任一步抛错被调用方捕获，下一轮照常执行 |
| 幂等 | `index_status` 用 `onConflictDoUpdate`、Outbox 只在 `pending` 时处理，重复投递安全 |

## 6. 相关代码位置

| 文件 | 说明 |
| --- | --- |
| `src/application/reconcile.ts` | 对账核心实现（`runReconcile` 及四个步骤） |
| `src/application/outbox.ts` | Outbox 事件写入与失败退避（`emitOutbox` / `markOutboxFailed`） |
| `src/worker.ts` | 定时器触发 + `reconciliation` 系统 Job 消费 |
| `src/config.ts` | `reconcileIntervalMs` 配置（默认 5000ms） |
| `src/queue/index.ts` | `enqueueJob`（attempts: 5 + 指数退避） |
| `src/indexing/writer.ts` | 混合索引写入（向量 + 关键词） |
| `src/indexing/graph.ts` | 图索引写入（Neo4j，独立容错） |
| `src/indexing/community.ts` | 社区重建 |
