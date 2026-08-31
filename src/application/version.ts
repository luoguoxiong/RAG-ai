import { and, count, eq, max } from "drizzle-orm";
import { withTenantTx, type Tx } from "../db/index.js";
import { datasetVersions, type DatasetVersionRow } from "../db/schema/version.js";
import { documents } from "../db/schema/document.js";

/**
 * 数据集版本应用层（知识库快照）。
 *
 * 产品语义（只增不改）：
 * - 版本只能创建，版本号在租户内递增（max+1），不能删除 / 改名 / 修改
 * - 版本内文档可追加（上传时显式指定 versionId），不可移除
 * - 版本有状态：active（激活）/ inactive。查询不传版本号时默认用激活版本
 * - 首个版本自动激活；激活切换通过 activateDatasetVersion 完成（状态变更，非内容修改）
 */

/** 租户内递增创建版本（max+1），冲突时（并发）依赖唯一索引兜底。首个版本自动激活。 */
export async function createDatasetVersion(
  tenantId: string,
  input: { name: string },
): Promise<DatasetVersionRow> {
  return withTenantTx(tenantId, async (tx) => {
    const [agg] = await tx
      .select({ max: max(datasetVersions.version) })
      .from(datasetVersions);
    const next = (agg?.max ?? 0) + 1;
    // 无任何版本时第一个自动激活，其余默认 inactive，由显式激活切换
    const status = next === 1 ? "active" : "inactive";
    const [row] = await tx
      .insert(datasetVersions)
      .values({ tenantId, name: input.name, version: next, status })
      .returning();
    if (!row) throw new Error("failed to create dataset version");
    return row;
  });
}

/** 激活指定版本：先全部置 inactive，再激活目标版本（同一事务，保证唯一激活）。 */
export async function activateDatasetVersion(
  tenantId: string,
  versionId: string,
): Promise<void> {
  await withTenantTx(tenantId, async (tx) => {
    const [target] = await tx
      .select({ id: datasetVersions.id })
      .from(datasetVersions)
      .where(
        and(
          eq(datasetVersions.id, versionId),
          eq(datasetVersions.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!target) throw new Error(`dataset version not found: ${versionId}`);
    await tx
      .update(datasetVersions)
      .set({ status: "inactive" })
      .where(eq(datasetVersions.tenantId, tenantId));
    await tx
      .update(datasetVersions)
      .set({ status: "active" })
      .where(eq(datasetVersions.id, versionId));
  });
}

/** 版本列表（含文档数） */
export async function listDatasetVersions(tenantId: string) {
  return withTenantTx(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: datasetVersions.id,
        name: datasetVersions.name,
        version: datasetVersions.version,
        status: datasetVersions.status,
        createdAt: datasetVersions.createdAt,
        documentCount: count(documents.id),
      })
      .from(datasetVersions)
      .leftJoin(documents, eq(documents.versionId, datasetVersions.id))
      .groupBy(datasetVersions.id)
      .orderBy(datasetVersions.version);
    return rows;
  });
}

/** 版本详情（含其下文档列表） */
export async function getDatasetVersion(tenantId: string, versionId: string) {
  return withTenantTx(tenantId, async (tx) => {
    const [version] = await tx
      .select()
      .from(datasetVersions)
      .where(
        and(
          eq(datasetVersions.id, versionId),
          eq(datasetVersions.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!version) return null;

    const docs = await tx
      .select({
        id: documents.id,
        sourceUri: documents.sourceUri,
        title: documents.title,
        status: documents.status,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(eq(documents.versionId, versionId))
      .orderBy(documents.createdAt);

    return { ...version, documents: docs };
  });
}

/**
 * 解析检索范围：校验版本存在且属于租户，返回其下文档 id 集合。
 * versionId 缺省时使用该租户的激活版本（active）。
 * 检索端用它把"版本"展开成"可检索的文档集合"。
 * 版本不存在 / 无激活版本时抛出异常（API 层转 400）。
 */
export async function resolveVersionDocumentIds(
  tenantId: string,
  versionId?: string,
): Promise<string[]> {
  return withTenantTx(tenantId, async (tx) => {
    // 按指定 id 或激活版本（缺省）定位版本；找不到则抛错（API 层转 400）
    const version = await findVersion(tx, tenantId, versionId);
    if (!version) {
      throw new Error(
        versionId
          ? `dataset version not found: ${versionId}`
          : "no active dataset version",
      );
    }

    // 展开版本下全部文档 id，作为检索 / 图遍历的过滤集合
    const rows = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.versionId, version.id));
    return rows.map((r) => r.id);
  });
}

/** 按 id（指定）或 status=active（缺省）查找版本，返回 null 表示未命中。 */
async function findVersion(
  tx: Tx,
  tenantId: string,
  versionId?: string,
) {
  const [row] = await tx
    .select()
    .from(datasetVersions)
    .where(
      and(
        eq(datasetVersions.tenantId, tenantId),
        versionId
          ? eq(datasetVersions.id, versionId)
          : eq(datasetVersions.status, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}
