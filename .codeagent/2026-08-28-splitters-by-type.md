# 2026-08-28 splitters-by-type

## 任务
用户要求支持 docx / text / md / pdf 四种文档类型的切片（分类型切分，替代一刀切的 ParentChildSplitter）。

## 背景
- 原切分层所有文本统一走 `ParentChildSplitter`（段落聚合 + 字符硬切），对 md 结构、pdf 硬换行文本不友好。
- 解析层（parser.ts）已按类型分发，但切分层未跟上，存在断层。

## 决策
- 新增依赖：`pdf-parse` + `mammoth`（用户确认）。
- 切分器与 Parser 对称设计：`Splitter` 接口 + 按 `metadata.language` 分发的注册表 `splitterFor`。
- 所有 splitter 统一返回 parent/child 两级结构，兼容 `processVersion` 消费逻辑（零侵入）。
- pdf 文本需先"段落还原"（合并硬换行）再切，否则同一段落被切成碎片。
- **pdf-parse 版本坑**：默认安装 2.4.5（TypeScript 重写版，PDFParse 类 + pdfjs-dist 5.x，engines 要求 Node>=20.16），当前环境 Node v18 不兼容 → 降级固定 `pdf-parse@1.1.1`。
- pdf-parse 1.1.1 的 ESM 坑：主入口 `!module.parent` 判断会进入 debug 模式 → 走 `pdf-parse/lib/pdf-parse.js`，并自建 `src/types/pdf-parse.d.ts` 类型声明。

## 产出
- `src/ingestion/splitters.ts`：`Splitter` 接口、`MarkdownSplitter`（标题感知，代码块/表格整体保留）、`SentenceSplitter`（句子级切分，text/pdf/docx 兜底）、`splitterFor` 注册表。
- `src/ingestion/parser.ts`：新增 `PdfParser`（pdf-parse + restoreParagraphs 段落还原）、`DocxParser`（mammoth.extractRawText），并注册进 parsers 数组。
- `src/application/ingestion.ts`：`processVersion` 按 `metadata.language` 选切分器（替代全局 ParentChildSplitter）。
- `src/types/pdf-parse.d.ts`：lib 入口类型声明。

## 验证
- `tsc --noEmit` 通过。
- 冒烟测试（tsx）：text 句子级切分 ✓、md 标题感知（代码块/表格整体为 child）✓、`splitterFor` 分发（markdown→MarkdownSplitter，pdf/docx/undefined→SentenceSplitter）✓、pdf-parse/mammoth 动态导入 ✓、pdf/docx canParse ✓。
