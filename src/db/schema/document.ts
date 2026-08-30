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
  /** 主键：文档 id */
  id: uuid("id").primaryKey().defaultRandom(),
  /** 租户隔离 */
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** 独占归属的数据集版本；版本不可删改，文档随版本存活 */
  versionId: uuid("version_id")
    .notNull()
    .references(() => datasetVersions.id, { onDelete: "restrict" }),
  /** 来源类型：file（上传）/ 后续可扩展 url 等 */
  sourceType: text("source_type").notNull(),
  /** 来源 URI：原始文件名（sourceType=file 时） */
  sourceUri: text("source_uri").notNull(),
  /** 解析提取的标题（可能为空，UI 回退显示 sourceUri） */
  title: text("title"),
  /** 状态：pending（受理）→ ready（切片完成）/ deleted（软删） */
  status: text("status").notNull().default("pending"),
  /** 当前生效的文档版本 id，切片完成时回填 */
  currentVersionId: uuid("current_version_id"),
  /** 创建时间 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** 最近更新时间 */
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const documentVersions = pgTable("document_versions", {
  /** 主键：文档版本 id（切片与幂等均以它为核心） */
  id: uuid("id").primaryKey().defaultRandom(),
  /** 租户隔离 */
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** 归属文档（文档删除时级联删版本） */
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  /** 版本号，首次为 1；内容变化时递增 */
  version: integer("version").notNull().default(1),
  /** sha256(归一化文本)，版本去重 / 幂等依据 */
  contentHash: text("content_hash").notNull(),
  /** 归一化后的纯文本（切片输入；Phase 1 暂存 PG，后续迁 S3） */
  rawContent: text("raw_content"),
  /** {language, title, ...}：language 决定 splitter 分发 */
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  /** 状态：pending（已存 rawContent 待切片）→ ready */
  status: text("status").notNull().default("pending"),
  /** 创建时间 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DocumentRow = typeof documents.$inferSelect;
export type NewDocumentRow = typeof documents.$inferInsert;
export type DocumentVersionRow = typeof documentVersions.$inferSelect;
export type NewDocumentVersionRow = typeof documentVersions.$inferInsert;