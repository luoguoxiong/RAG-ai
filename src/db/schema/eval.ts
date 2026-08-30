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
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  indexVersion: text("index_version").notNull().default("1"),
  embeddingVersion: text("embedding_version").notNull().default("1"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const evalQueries = pgTable(
  "eval_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => evalDatasets.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    // 检索 ground truth：黄金 chunk id 集合（retrieval ground truth）
    goldChunkIds: jsonb("gold_chunk_ids").$type<string[]>().notNull().default([]),
    // 生成 ground truth：参考答案与关键事实（generation ground truth）
    referenceAnswer: text("reference_answer"),
    keyFacts: jsonb("key_facts").$type<string[]>().notNull().default([]),
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
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  datasetId: uuid("dataset_id")
    .notNull()
    .references(() => evalDatasets.id, { onDelete: "cascade" }),
  indexVersion: text("index_version").notNull(),
  embeddingVersion: text("embedding_version").notNull(),
  embeddingModel: text("embedding_model"),
  topK: integer("top_k").notNull().default(6),
  llmModel: text("llm_model"),
  reranker: text("reranker"),
  status: text("status").notNull().default("running"),
  error: text("error"),
  // 汇总指标（所有查询的均值）
  metrics: jsonb("metrics").$type<Partial<EvalMetrics>>().notNull().default({}),
  report: text("report"),
  // 回归门禁（§22.1 CI gate）：与基线对比后得出
  baselineRunId: uuid("baseline_run_id"),
  regressedMetrics: jsonb("regressed_metrics").$type<string[]>().notNull().default([]),
  gatePassed: boolean("gate_passed"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const evalRunResults = pgTable(
  "eval_run_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    queryId: uuid("query_id")
      .notNull()
      .references(() => evalQueries.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    goldChunkIds: jsonb("gold_chunk_ids").$type<string[]>().notNull().default([]),
    retrievedChunkIds: jsonb("retrieved_chunk_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    metrics: jsonb("metrics").$type<Partial<EvalMetrics>>().notNull().default({}),
    answer: text("answer"),
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
