import { pgTable, text, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"),
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
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TenantRow = typeof tenants.$inferSelect;
export type NewTenantRow = typeof tenants.$inferInsert;