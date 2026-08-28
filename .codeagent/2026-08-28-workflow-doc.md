# 2026-08-28 workflow-doc

## 任务
用户要求把「整体工作流程图」生成文档到根目录。

## 决策
- 用户选择新建 `WORKFLOW.md`（不动 README.md，README 保持一行标题）。

## 产出
- `WORKFLOW.md`：包含架构总览、写入链路、查询链路、五层存储职责、容错与对账的 ASCII 流程图。
- 内容基于实际代码核对：src/api/documents.ts、src/api/search.ts、src/application/ingestion.ts、src/application/reconcile.ts、src/application/query.ts、src/query/index.ts、src/retrieval/retriever.ts、src/worker.ts。
