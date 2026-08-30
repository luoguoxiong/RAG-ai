import {
  pgTable,
  text,
  uuid,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant";

export const outbox = pgTable(
  "outbox",
  {
    /** 主键：事件 id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离 */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 事件对象类型：chunk（当前唯一取值） */
    aggregateType: text("aggregate_type").notNull(),
    /** 事件对象 id：chunk.id（逻辑关联，无外键，消费时回查判空） */
    aggregateId: uuid("aggregate_id").notNull(),
    /** 事件类型：chunk.upserted（切片已写入）/ chunk.removed（切片已删除） */
    eventType: text("event_type").notNull(),
    /** 附加载荷（当前默认空，预留） */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** 状态：pending（待消费）→ done / failed（失败指数退避重试） */
    status: text("status").notNull().default("pending"),
    /** 消费失败重试次数 */
    attempts: integer("attempts").notNull().default(0),
    /** 最近一次失败的错误信息 */
    error: text("error"),
    /** 可投递时间：失败退避时延迟（availableAt = now + 2^attempts 秒） */
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** 创建时间（事件投递时间，与业务变更同事务） */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pendingIdx: index("outbox_pending_idx").on(t.status, t.availableAt),
  }),
);

export type OutboxRow = typeof outbox.$inferSelect;
export type NewOutboxRow = typeof outbox.$inferInsert;