# 2026-08-28 database-schema-doc

## 任务
用户要求整理一份专门说明表结构的文档。

## 决策
- 遵循 WORKFLOW.md / SPLITTING.md 先例，文档新建到项目根目录 `DATABASE.md`。
- 内容基于实际代码核对：src/db/schema/ 下 8 个 schema 文件、src/db/index.ts（RLS）、drizzle/ 迁移文件。

## 产出
- `DATABASE.md`：数据库表结构设计文档，覆盖 17 张表（tenants / documents / document_versions / chunks / index_status / entities / entity_mentions / relations / communities / community_members / jobs / outbox / eval_datasets / eval_queries / eval_runs / eval_run_results）、RLS 租户隔离机制、各表字段说明、索引、表关系图与设计要点。

## 验证
- 文档内容与 schema 代码及迁移 SQL 逐条核对，无虚构细节。
