import {
  pgTable,
  text,
  uuid,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant";

export const jobs = pgTable("jobs", {
  /** 主键：Job id（与 BullMQ 队列共用同一个 id） */
  id: uuid("id").primaryKey().defaultRandom(),
  /** 租户隔离 */
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** 任务类型：index_document / reindex_document / delete_document */
  type: text("type").notNull(),
  /** 状态机：pending（入队前落库）→ processing（Worker 拉取）→ ready / failed */
  status: text("status").notNull().default("pending"),
  /** 任务载荷：{documentId, versionId} 等业务参数 */
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  /** 已尝试次数（重试计数） */
  attempts: integer("attempts").notNull().default(0),
  /** 最大重试次数（与 BullMQ attempts 对齐） */
  maxAttempts: integer("max_attempts").notNull().default(5),
  /** 失败时的错误信息 */
  error: text("error"),
  /** 创建时间（受理时间） */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** 最近状态变更时间（对账按它判断卡死阈值） */
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;