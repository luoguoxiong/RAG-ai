import {
  pgTable,
  text,
  uuid,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant";
import { datasetVersions } from "./version";

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** 独占归属的数据集版本；版本不可删改，文档随版本存活 */
  versionId: uuid("version_id")
    .notNull()
    .references(() => datasetVersions.id, { onDelete: "restrict" }),
  sourceType: text("source_type").notNull(),
  sourceUri: text("source_uri").notNull(),
  title: text("title"),
  status: text("status").notNull().default("pending"),
  currentVersionId: uuid("current_version_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const documentVersions = pgTable("document_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  contentHash: text("content_hash").notNull(),
  rawContent: text("raw_content"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DocumentRow = typeof documents.$inferSelect;
export type NewDocumentRow = typeof documents.$inferInsert;
export type DocumentVersionRow = typeof documentVersions.$inferSelect;
export type NewDocumentVersionRow = typeof documentVersions.$inferInsert;