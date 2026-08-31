import {
  pgTable,
  text,
  uuid,
  integer,
  real,
  boolean,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant";

/**
 * 检索日志：记录每次通过 /search API 发起的检索请求及其性能指标。
 * 与 eval_runs（批量评估）不同，这里记录的是用户真实的检索行为。
 */
export const retrievalLogs = pgTable("retrieval_logs", {
  /** 主键 */
  id: uuid("id").primaryKey().defaultRandom(),
  /** 租户隔离 */
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** 用户原始查询文本 */
  query: text("query").notNull(),
  /** 检索 Top-K 设置 */
  topK: integer("top_k").notNull().default(6),
  /** 是否启用了 Query Intelligence */
  intelligence: boolean("intelligence").notNull().default(false),
  /** 召回的证据条数 */
  evidenceCount: integer("evidence_count").notNull().default(0),
  /** 引用来源数量 */
  citationCount: integer("citation_count").notNull().default(0),
  /** 最高引用得分（重排分或融合分） */
  topScore: real("top_score"),
  /** 检索质量指标：仅在请求提供了 gold chunk ids（ground truth）时计算 */
  recallAtK: real("recall_at_k"),
  hitRate: real("hit_rate"),
  mrr: real("mrr"),
  ndcg: real("ndcg"),
  /** 实际检索 query（Intelligence 开启时的变换查询） */
  effectiveQueries: jsonb("effective_queries").$type<string[]>().default([]),
  /** 召回的 chunk ID 集合 */
  chunkIds: jsonb("chunk_ids").$type<string[]>().default([]),
  /** 检索阶段耗时（毫秒） */
  retrievalMs: integer("retrieval_ms"),
  /** 生成阶段耗时（毫秒） */
  generationMs: integer("generation_ms"),
  /** 总耗时（毫秒） */
  latencyMs: integer("latency_ms"),
  /** 生成的回答文本 */
  answer: text("answer"),
  /** 创建时间 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type RetrievalLogRow = typeof retrievalLogs.$inferSelect;
export type NewRetrievalLogRow = typeof retrievalLogs.$inferInsert;
