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
    /** 主键：实体 id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离（跨租户完全隔离） */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 规范名：LLM 抽取并去歧义后的展示名（如 "GraphRAG"） */
    canonicalName: text("canonical_name").notNull(),
    /** 规范化名：转小写 + 统一变体后的匹配键（唯一索引载体） */
    normalizedName: text("normalized_name").notNull(),
    /** 实体类型：person / organization / product / concept ... */
    type: text("type").notNull().default("unknown"),
    /** 别名集合：同一实体的其他写法（匹配时先查规范化名再查别名） */
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    /** 实体附加元数据（类型描述等） */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** 创建时间 */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** 最近更新时间 */
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
    /** 主键：引用记录 id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离 */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 提及的切片（切片删除时级联删引用） */
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => chunks.id, { onDelete: "cascade" }),
    /** 被提及的实体（实体删除时级联删引用） */
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    /** 溯源：该切片所属文档（删除文档时按它减去 MENTIONS 计数） */
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** 创建时间 */
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
    /** 主键：关系 id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离 */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 起始实体（删除时级联删关系） */
    fromEntityId: uuid("from_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    /** 目标实体（删除时级联删关系） */
    toEntityId: uuid("to_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    /** 关系类型：works_at / mentions / related_to ... */
    type: text("type").notNull(),
    /** 抽取置信度 [0,1]，LLM 给出；跨文档重复抽取可加权 */
    confidence: doublePrecision("confidence").notNull().default(1),
    /** 证据溯源：抽取该关系的切片（可空，级联删除） */
    sourceChunkId: uuid("source_chunk_id").references(() => chunks.id, {
      onDelete: "cascade",
    }),
    /** 证据溯源：所属文档（可空，级联删除） */
    sourceDocumentId: uuid("source_document_id").references(() => documents.id, {
      onDelete: "cascade",
    }),
    /** 证据溯源：所属文档版本（可空，级联删除） */
    documentVersionId: uuid("document_version_id").references(
      () => documentVersions.id,
      { onDelete: "cascade" },
    ),
    /** 创建时间 */
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
    /** 主键：社区 id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离 */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 社区编号（租户内连通分量检测后生成） */
    communityIndex: integer("community_index").notNull(),
    /** LLM 生成的社区摘要（Global Graph Search 使用） */
    summary: text("summary"),
    /** 成员实体数（便于展示与剪枝） */
    entityCount: integer("entity_count").notNull().default(0),
    /** 创建时间 */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** 最近更新时间（实体变动后摘要重建） */
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
    /** 主键：成员关系 id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离 */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 所属社区（社区删除时级联删成员） */
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    /** 社区内实体（实体删除时级联删成员） */
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    /** 创建时间 */
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