import { pgTable, text, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  /** 主键：租户 id，其他表通过 tenant_id 引用并做 RLS 隔离 */
  id: uuid("id").primaryKey().defaultRandom(),
  /** 租户名称（展示用） */
  name: text("name").notNull(),
  /** 套餐类型：free / pro 等，决定默认配额 */
  plan: text("plan").notNull().default("free"),
  /** 配额上限：最大文档数 / 切片数 / 每日 embedding 次数 / 每分钟查询数 */
  limits: jsonb("limits")
    .$type<{
      maxDocuments: number;
      maxChunks: number;
      maxEmbeddingsPerDay: number;
      maxQueriesPerMinute: number;
    }>()
    .notNull()
    .default({
      maxDocuments: 1000,
      maxChunks: 100_000,
      maxEmbeddingsPerDay: 1_000_000,
      maxQueriesPerMinute: 100,
    }),
  /** 租户状态：active（正常）/ 停用 */
  status: text("status").notNull().default("active"),
  /** 创建时间 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** 最近更新时间 */
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TenantRow = typeof tenants.$inferSelect;
export type NewTenantRow = typeof tenants.$inferInsert;