import {
  pgTable,
  text,
  uuid,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenant";

/**
 * 数据集版本（知识库快照）：
 * 版本 = 一个文档集合，每份文档独占归属某个版本（documents.versionId）。
 *
 * 约束（产品语义）：
 * - 版本只能创建，编号在租户内递增，不能删除 / 改名 / 修改
 * - 版本内文档可追加（继续上传文档归属到该版本），不可移除
 * - 版本有状态：active（激活）/ inactive；每租户最多一个激活版本（部分唯一索引兜底）
 * - 查询不指定版本时默认检索激活版本的文档集合
 */
export const datasetVersions = pgTable(
  "dataset_versions",
  {
    /** 主键：数据集版本 id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离 */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 版本名称，如 v1 / 生产快照（展示用） */
    name: text("name").notNull(),
    /** 租户内递增的版本号（创建时取 max+1），作为"只能递增"的载体 */
    version: integer("version").notNull(),
    /** 状态：active（当前生效版本）/ inactive；每租户最多一个 active */
    status: text("status").notNull().default("active"),
    /** 创建时间 */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqTenantVersion: uniqueIndex("dataset_versions_tenant_version_idx").on(
      t.tenantId,
      t.version,
    ),
    // 部分唯一索引：同一租户内 status='active' 的行最多一行（数据库层兜底）
    uniqActive: uniqueIndex("dataset_versions_tenant_active_idx")
      .on(t.tenantId)
      .where(sql`${t.status} = 'active'`),
  }),
);

export type DatasetVersionRow = typeof datasetVersions.$inferSelect;
export type NewDatasetVersionRow = typeof datasetVersions.$inferInsert;
