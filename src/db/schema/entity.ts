import {
  doublePrecision,
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
import { documents, documentVersions } from "./document";
import { chunks } from "./chunk";

/**
 * Entity Registry（§11 / §4.1）：PostgreSQL 是 Source of Truth。
 * 同一 tenant 内可跨 document 共享 Entity；跨 tenant 完全隔离（§24.1）。
 */
export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    canonicalName: text("canonical_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    type: text("type").notNull().default("unknown"),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // 同一租户内（规范化名 + 类型）唯一，Resolve 的 cheap-first 精确匹配依据
    uniqTenantNormType: uniqueIndex("entities_tenant_norm_type_idx").on(
      t.tenantId,
      t.normalizedName,
      t.type,
    ),
  }),
);

/**
 * (:Chunk)-[:MENTIONS]->(:Entity) 的引用记录（§12）。
 * 删除 document 时先减去该 document 的 MENTIONS，计数归零的 Entity 才删除。
 */
export const entityMentions = pgTable(
  "entity_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => chunks.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqChunkEntity: uniqueIndex("entity_mentions_chunk_entity_idx").on(
      t.chunkId,
      t.entityId,
    ),
    entityIdx: index("entity_mentions_entity_idx").on(t.entityId),
  }),
);

/**
 * 实体间关系（§12）：证据字段（sourceChunkId / sourceDocumentId / documentVersionId）
 * 随边保存，删除可溯源、可级联。
 */
export const relations = pgTable(
  "relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fromEntityId: uuid("from_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    toEntityId: uuid("to_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    confidence: doublePrecision("confidence").notNull().default(1),
    sourceChunkId: uuid("source_chunk_id").references(() => chunks.id, {
      onDelete: "cascade",
    }),
    sourceDocumentId: uuid("source_document_id").references(() => documents.id, {
      onDelete: "cascade",
    }),
    documentVersionId: uuid("document_version_id").references(
      () => documentVersions.id,
      { onDelete: "cascade" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqRelation: uniqueIndex("relations_uniq_idx").on(
      t.tenantId,
      t.fromEntityId,
      t.toEntityId,
      t.type,
      t.sourceChunkId,
    ),
    fromIdx: index("relations_from_idx").on(t.fromEntityId),
    toIdx: index("relations_to_idx").on(t.toEntityId),
  }),
);

export type EntityRow = typeof entities.$inferSelect;
export type NewEntityRow = typeof entities.$inferInsert;
export type EntityMentionRow = typeof entityMentions.$inferSelect;
export type NewEntityMentionRow = typeof entityMentions.$inferInsert;
export type RelationRow = typeof relations.$inferSelect;
export type NewRelationRow = typeof relations.$inferInsert;

/**
 * 社区（Phase 7 Advanced GraphRAG）：连通分量检测后的实体聚类。
 * 每个社区有 LLM 生成的摘要，供 Global Graph Search 使用。
 */
export const communities = pgTable(
  "communities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    communityIndex: integer("community_index").notNull(),
    summary: text("summary"),
    entityCount: integer("entity_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("communities_tenant_idx").on(t.tenantId),
  }),
);

export const communityMembers = pgTable(
  "community_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqCommunityEntity: uniqueIndex("community_members_comm_entity_idx").on(
      t.communityId,
      t.entityId,
    ),
    entityIdx: index("community_members_entity_idx").on(t.entityId),
  }),
);

export type CommunityRow = typeof communities.$inferSelect;
export type NewCommunityRow = typeof communities.$inferInsert;
export type CommunityMemberRow = typeof communityMembers.$inferSelect;
export type NewCommunityMemberRow = typeof communityMembers.$inferInsert;