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
    /** 主键：随机 uuid（不透明引用句柄，稳定标识靠 contentHash） */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离：切片归属的租户（RLS 策略字段） */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 归属文档（文档删除时级联删切片） */
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** 归属文档版本（版本内切片集合，幂等唯一索引载体） */
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    /** 父切片 id：child 指向其所属 parent；parent 本身为 null（两级结构） */
    parentId: uuid("parent_id"),
    /** 切片类型：parent（上下文单元）/ child（检索单元） */
    type: text("type").notNull().default("child"),
    /** 切片文本：parent=完整上下文，child=检索用最小语义片段 */
    content: text("content").notNull(),
    /** 稳定哈希：sha256(documentVersionId+kind+归一化内容)，幂等落库依据 */
    contentHash: text("content_hash").notNull(),
    /** 版本内全局递增序号，保证切片顺序唯一（依赖先清后插） */
    chunkIndex: integer("chunk_index").notNull().default(0),
    /** 附加元数据（如文档 title），随切片携带供检索上下文使用 */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** 创建时间（切片落库时间） */
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
  /** 主键 + 外键到 chunks：每个 chunk 一行派生索引状态（级联删除） */
  chunkId: uuid("chunk_id")
    .primaryKey()
    .references(() => chunks.id, { onDelete: "cascade" }),
  /** 租户隔离 */
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** 向量索引状态：pending → done / failed（写 Qdrant） */
  vector: text("vector").notNull().default("pending"),
  /** 关键词索引状态：pending → done / failed（写 OpenSearch） */
  keyword: text("keyword").notNull().default("pending"),
  /** 图索引状态：pending → ready / failed（写 Neo4j，独立容错） */
  graph: text("graph").notNull().default("pending"),
  /** 向量模型名（索引溯源，如 deterministic-hash / doubao-embedding） */
  embeddingModel: text("embedding_model"),
  /** 向量模型版本（模型升级后可据此触发重索引） */
  embeddingVersion: text("embedding_version"),
  /** 最近一次索引写入时间 */
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ChunkRow = typeof chunks.$inferSelect;
export type NewChunkRow = typeof chunks.$inferInsert;
export type IndexStatusRow = typeof indexStatus.$inferSelect;
export type NewIndexStatusRow = typeof indexStatus.$inferInsert;