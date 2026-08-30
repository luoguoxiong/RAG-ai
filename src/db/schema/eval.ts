import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant";

/** 单个查询的评估指标（§22）：检索 4 项 + 生成 4 项，均归一化到 [0,1] */
export interface EvalMetrics {
  /** Top-K 召回率：在前 K 条召回结果中命中相关文档的比例，衡量检索的查全能力 */
  recallAtK: number;
  /** 命中率：查询的 Top-K 结果中是否至少包含一条相关文档（0/1），衡量检索是否命中 */
  hitRate: number;
  /** 平均倒数排名（MRR）：第一条相关文档位置的倒数，越靠前得分越高，衡量排序质量 */
  mrr: number;
  /** NDCG（归一化折损累计增益）：考虑相关度等级与位置的排名质量评分，越接近 1 越好 */
  ndcg: number;
  /** 上下文精确率：召回上下文中相关条目占比，衡量检索结果的噪声控制 */
  contextPrecision: number;
  /** 上下文召回率：相关上下文被召回到的比例，衡量检索对答案所需信息的覆盖度 */
  contextRecall: number;
  /** 忠实度：生成答案基于给定上下文的比例，衡量是否存在幻觉（无中生有） */
  faithfulness: number;
  /** 答案相关性：生成答案与用户问题意图的匹配程度，衡量回答是否切题 */
  answerRelevance: number;
}

/**
 * Eval Dataset（§22.1）：versioned 评估集，绑定 indexVersion + embeddingVersion。
 * 索引 / embedding 升级后必须重建基线，避免与旧 ground truth 错配。
 */
export const evalDatasets = pgTable("eval_datasets", {
  /** 主键：评估集 id */
  id: uuid("id").primaryKey().defaultRandom(),
  /** 租户隔离 */
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** 评估集名称（展示用） */
  name: text("name").notNull(),
  /** 评估集描述 */
  description: text("description"),
  /** 绑定的索引版本（索引升级后需重建基线） */
  indexVersion: text("index_version").notNull().default("1"),
  /** 绑定的 embedding 版本（模型升级后需重建基线） */
  embeddingVersion: text("embedding_version").notNull().default("1"),
  /** 创建时间 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const evalQueries = pgTable(
  "eval_queries",
  {
    /** 主键：评估查询 id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离 */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 所属评估集（评估集删除时级联删查询） */
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => evalDatasets.id, { onDelete: "cascade" }),
    /** 评估问题文本 */
    query: text("query").notNull(),
    // 检索 ground truth：黄金 chunk id 集合（retrieval ground truth）
    goldChunkIds: jsonb("gold_chunk_ids").$type<string[]>().notNull().default([]),
    // 生成 ground truth：参考答案与关键事实（generation ground truth）
    referenceAnswer: text("reference_answer"),
    keyFacts: jsonb("key_facts").$type<string[]>().notNull().default([]),
    /** 创建时间 */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqDatasetQuery: uniqueIndex("eval_queries_dataset_query_idx").on(
      t.datasetId,
      t.query,
    ),
  }),
);

export const evalRuns = pgTable("eval_runs", {
  /** 主键：评估运行 id */
  id: uuid("id").primaryKey().defaultRandom(),
  /** 租户隔离 */
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** 运行的评估集（评估集删除时级联删运行） */
  datasetId: uuid("dataset_id")
    .notNull()
    .references(() => evalDatasets.id, { onDelete: "cascade" }),
  /** 本次运行的索引版本 */
  indexVersion: text("index_version").notNull(),
  /** 本次运行的 embedding 版本 */
  embeddingVersion: text("embedding_version").notNull(),
  /** 本次运行的 embedding 模型名 */
  embeddingModel: text("embedding_model"),
  /** 检索 Top-K（默认 6） */
  topK: integer("top_k").notNull().default(6),
  /** 本次运行的生成 LLM 模型名 */
  llmModel: text("llm_model"),
  /** 本次运行的 Reranker 模型名 */
  reranker: text("reranker"),
  /** 状态：running → completed / failed */
  status: text("status").notNull().default("running"),
  /** 失败时的错误信息 */
  error: text("error"),
  // 汇总指标（所有查询的均值）
  metrics: jsonb("metrics").$type<Partial<EvalMetrics>>().notNull().default({}),
  /** 评估报告（markdown 文本） */
  report: text("report"),
  // 回归门禁（§22.1 CI gate）：与基线对比后得出
  baselineRunId: uuid("baseline_run_id"),
  /** 对比基线发生回归的指标名集合（如 ["recallAtK"]） */
  regressedMetrics: jsonb("regressed_metrics").$type<string[]>().notNull().default([]),
  /** 回归门禁是否通过：未配置基线为 null，对比后 true/false */
  gatePassed: boolean("gate_passed"),
  /** 创建时间 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const evalRunResults = pgTable(
  "eval_run_results",
  {
    /** 主键：单条查询评估结果 id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离 */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 所属运行（运行删除时级联删结果） */
    runId: uuid("run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    /** 对应评估查询（查询删除时级联删结果） */
    queryId: uuid("query_id")
      .notNull()
      .references(() => evalQueries.id, { onDelete: "cascade" }),
    /** 查询文本（快照，查询可后续修改不影响历史） */
    query: text("query").notNull(),
    /** 黄金 chunk id 集合（快照） */
    goldChunkIds: jsonb("gold_chunk_ids").$type<string[]>().notNull().default([]),
    /** 本次实际召回结果（快照，供回溯分析） */
    retrievedChunkIds: jsonb("retrieved_chunk_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** 单条查询的 8 项评估指标 */
    metrics: jsonb("metrics").$type<Partial<EvalMetrics>>().notNull().default({}),
    /** 本次生成的答案文本 */
    answer: text("answer"),
    /** 创建时间 */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    runIdx: index("eval_run_results_run_idx").on(t.runId),
  }),
);

export type EvalDatasetRow = typeof evalDatasets.$inferSelect;
export type NewEvalDatasetRow = typeof evalDatasets.$inferInsert;
export type EvalQueryRow = typeof evalQueries.$inferSelect;
export type NewEvalQueryRow = typeof evalQueries.$inferInsert;
export type EvalRunRow = typeof evalRuns.$inferSelect;
export type NewEvalRunRow = typeof evalRuns.$inferInsert;
export type EvalRunResultRow = typeof evalRunResults.$inferSelect;
export type NewEvalRunResultRow = typeof evalRunResults.$inferInsert;
