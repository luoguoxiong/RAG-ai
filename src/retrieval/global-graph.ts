import { and, eq, inArray } from "drizzle-orm";
import { withTenantTx } from "../db/index.js";
import { communities, communityMembers, entities, entityMentions } from "../db/schema/entity.js";
import { config } from "../config.js";

/**
 * Global Graph Search（Phase 7 Advanced GraphRAG）：
 * 基于社区摘要的全局检索。与 n-hop（从实体出发走图）互补，
 * Global Search 从社区摘要出发，适合"宏观概览/全局关系"类查询。
 *
 * 流程（GraphRAG Map-Reduce 简化版）：
 *   Query -> 匹配社区摘要 -> Top-K 社区 -> 社区摘要 + 成员实体作为 Evidence
 *
 * 匹配策略：keyword overlap（cheap-first，§23.2），
 * 有 API key 时可升级为 LLM 评分（当前实现用 overlap，保持无依赖可跑通）。
 */

export interface GlobalGraphResult {
  query: string;
  communities: GlobalGraphCommunity[];
}

export interface GlobalGraphCommunity {
  communityId: string;
  communityIndex: number;
  summary: string;
  entityCount: number;
  entityNames: string[];
  score: number;
}

/** 简单关键词重叠评分（cheap-first，无 LLM 依赖） */
function scoreSummary(query: string, summary: string): number {
  const qTerms = query
    .toLowerCase()
    .split(/[\s,，。？?"'「」『』、（）()]+/)
    .filter((t) => t.length >= 2);
  if (qTerms.length === 0) return 0;
  const sLower = summary.toLowerCase();
  let hits = 0;
  for (const t of qTerms) {
    if (sLower.includes(t)) hits++;
  }
  return hits / qTerms.length;
}

/**
 * 全局图检索：读取所有社区摘要 -> 关键词评分 -> Top-K 返回。
 * 社区数据在 PG（Source of Truth），无需 Neo4j 参与。
 */
export async function globalGraphSearch(
  tenantId: string,
  query: string,
  topK?: number,
  documentIds?: string[],
): Promise<GlobalGraphResult> {
  const k = topK ?? config.defaultTopK;

  const allCommunities = await withTenantTx(tenantId, async (tx) => {
    const comms = await tx.select().from(communities);
    const result: {
      id: string;
      index: number;
      summary: string | null;
      entityCount: number;
      entityIds: string[];
    }[] = [];

    for (const c of comms) {
      const members = await tx
        .select({ entityId: communityMembers.entityId })
        .from(communityMembers)
        .where(eq(communityMembers.communityId, c.id));
      result.push({
        id: c.id,
        index: c.communityIndex,
        summary: c.summary,
        entityCount: c.entityCount,
        entityIds: members.map((m) => m.entityId),
      });
    }

    // 版本过滤：社区按租户构建、实体跨文档共享，只有"成员实体在该版本文档集内有
    // mentions"的社区才算该版本的社区。先收集全部成员实体，一次查询有效提及集合
    const allEntityIds = [...new Set(result.flatMap((c) => c.entityIds))];
    let scopedEntityIds = new Set<string>();
    if (allEntityIds.length > 0) {
      const mentions =
        documentIds && documentIds.length > 0
          ? await tx
              .select({ entityId: entityMentions.entityId })
              .from(entityMentions)
              .where(
                and(
                  inArray(entityMentions.entityId, allEntityIds),
                  inArray(entityMentions.documentId, documentIds),
                ),
              )
          : await tx
              .select({ entityId: entityMentions.entityId })
              .from(entityMentions)
              .where(inArray(entityMentions.entityId, allEntityIds));
      scopedEntityIds = new Set(mentions.map((m) => m.entityId));
    }

    return result
      .map((c) => ({
        ...c,
        // 只保留版本内实际被提及的成员实体
        entityIds: c.entityIds.filter((id) => scopedEntityIds.has(id)),
      }))
      .filter((c) => c.entityIds.length > 0);
  });

  // Score and rank
  const scored = allCommunities
    .map((c) => ({
      ...c,
      score: scoreSummary(query, c.summary ?? ""),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  // Fetch entity names for top communities
  const topCommunities: GlobalGraphCommunity[] = [];
  for (const c of scored) {
    let entityNames: string[] = [];
    if (c.entityIds.length > 0) {
      const entityRows = await withTenantTx(tenantId, async (tx) => {
        return tx
          .select({ name: entities.canonicalName })
          .from(entities)
          .where(inArray(entities.id, c.entityIds));
      });
      entityNames = entityRows.map((r) => r.name);
    }
    topCommunities.push({
      communityId: c.id,
      communityIndex: c.index,
      summary: c.summary ?? "",
      entityCount: c.entityCount,
      entityNames,
      score: c.score,
    });
  }

  return { query, communities: topCommunities };
}
