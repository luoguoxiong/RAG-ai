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
  recallAtK: number;
  hitRate: number;
  mrr: number;
  ndcg: number;
  contextPrecision: number;
  contextRecall: number;
  faithfulness: number;
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
