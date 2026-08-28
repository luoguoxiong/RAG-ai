# 2026-08-28 splitting-doc

## 任务
用户要求生成一份文档，说明切片（Chunking）是如何设计的。

## 决策
- 遵循 WORKFLOW.md 先例，设计文档新建到项目根目录 `SPLITTING.md`（不动 README）。
- 内容基于实际代码核对：src/ingestion/splitters.ts、src/ingestion/splitter.ts、src/ingestion/parent-child.ts、src/ingestion/parser.ts、src/application/ingestion.ts、src/retrieval/retriever.ts、src/db/schema/chunk.ts。

## 产出
- `SPLITTING.md`：切片设计文档，覆盖 Parent/Child 两级结构、Splitter 接口与分发（与 Parser 对称）、SentenceSplitter（分句→child→parent）、MarkdownSplitter（标题分节 + 代码块/表格整体保留 + 标题前缀 parent）、关键参数（CHILD_MAX=400 / PARENT_MAX=2000）、processVersion 消费链路与幂等落库、检索侧 parent 回填上下文、演进历史（ParagraphSplitter → ParentChildSplitter → splitters.ts）。

## 验证
- 文档内容与当前代码逐条核对，无虚构细节。
