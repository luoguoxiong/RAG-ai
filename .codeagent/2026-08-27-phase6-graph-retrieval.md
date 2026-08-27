# Task Log — 2026-08-27 / 2026-08-28

## 任务：实施 production-grade-knowledge-retrieval-platform 第 6 步（Phase 6: Graph Retrieval）

### 状态
核心代码已在上一会话实现并提交，本会话完成端到端验证 + 对账逻辑修复。

### 执行内容
1. 启动 Neo4j 容器（docker compose up -d neo4j，镜像 neo4j:5，健康检查通过）
2. 数据库迁移（pnpm db:migrate，成功）
3. 复用上一会话 API（node v22，PID 72833）；重启 Worker（修复后代码，node v22）
4. 上传测试文档 /tmp/graph_sample.md（含引号实体 "OpenAI"/"微软"/"Anthropic"/"NVIDIA"/"Claude"）
5. /search/graph 冒烟测试通过：
   - seeds（实体链接）: OpenAI, 微软
   - paths（n-hop 遍历）: 5 条（1-hop 与 2-hop）
   - evidence（证据回表）: 1 条 chunk
   - PG: 13 entities / 11 relations；Neo4j: 13 nodes / 11 rels

### 修复
- src/application/reconcile.ts: repairIndexStatus 扫描条件增加 graph=pending
  （文档 §7.1：IndexStatus != ready 即重投；Neo4j 引入前索引的旧 chunk 此前永远停在
  graph=pending，现可自动补建图索引）

### 环境注意
- 默认 node v18.20.8 无法运行（undici 7 需要全局 File），需用 nvm node v20+/v22+
- 相关命令：`export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"`

### 验证结果
| 指标 | 值 |
| ---- | -- |
| index_status 全量 graph=ready | 6/6 |
| /search/graph 冒烟测试 | 通过 |
| tsc --noEmit | 通过 |
