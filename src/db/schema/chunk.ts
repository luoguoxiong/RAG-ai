import {
  pgTable,
  text,
  uuid,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant";
import { documents, documentVersions } from "./document";

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    type: text("type").notNull().default("child"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    chunkIndex: integer("chunk_index").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // 稳定 ID 依据：同一 documentVersion 内相同内容去重
    uniqVersionHash: uniqueIndex("chunks_version_hash_idx").on(
      t.documentVersionId,
      t.contentHash,
    ),
  }),
);

export const indexStatus = pgTable("index_status", {
  chunkId: uuid("chunk_id")
    .primaryKey()
    .references(() => chunks.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  vector: text("vector").notNull().default("pending"),
  keyword: text("keyword").notNull().default("pending"),
  graph: text("graph").notNull().default("pending"),
  embeddingModel: text("embedding_model"),
  embeddingVersion: text("embedding_version"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ChunkRow = typeof chunks.$inferSelect;
export type NewChunkRow = typeof chunks.$inferInsert;
export type IndexStatusRow = typeof indexStatus.$inferSelect;
export type NewIndexStatusRow = typeof indexStatus.$inferInsert;