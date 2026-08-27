import { inArray } from "drizzle-orm";
import { config } from "../config.js";
import { withTenantTx } from "../db/index.js";
import { chunks } from "../db/schema/chunk.js";
import { entities, entityMentions } from "../db/schema/entity.js";
import { DeterministicEntityExtractor } from "../ingestion/graph/extractor.js";
import { normalizeEntityName } from "../domain/entity/resolver.js";
import { getGraphStore, type GraphPath } from "../indexing/graph.js";

/** 查询实体 → 图谱节点 的链接结果（§11 Entity Linking） */
export interface LinkedEntity {
  entityId: string;
  canonicalName: string;
  type: string;
}

/** 由图谱子图实体回表得到的证据片段（§18 Evidence） */
export interface GraphEvidence {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
}

export interface GraphRetrievalResult {
  query: string;
  seeds: LinkedEntity[];
  paths: GraphPath[];
  evidence: GraphEvidence[];
}

/**
 * GraphRetriever（§12 n-hop 检索）：
 * 查询实体提取 → 实体链接（PG Source of Truth）→ Neo4j n-hop 遍历 →
 * 子图实体回表证据 chunk。
 *
 * PG 负责「链接 + 证据」这类需要一致性的查询，Neo4j 只承担图遍历，
 * 二者都以 `tenantId` 隔离（§24.1）。Neo4j 不可用时降级为无子图路径，
 * 但仍返回链接到的实体及其证据（多级容错，§23.1）。
 */
export async function retrieveGraph(
  tenantId: string,
  query: string,
  maxHops: number = config.defaultMaxHops,
): Promise<GraphRetrievalResult> {
  // 查询侧实体抽取：确定性启发式（快、无外部 LLM 依赖），与索引侧规则对齐
  const extracted = await new DeterministicEntityExtractor().extract(query);
  const normNames = [
    ...new Set(extracted.entities.map((e) => normalizeEntityName(e.name)).filter(Boolean)),
  ];

  // 1) Entity Linking：在 PG entities 中按规范化名命中，得到 seed 节点
  const seeds = await withTenantTx(tenantId, async (tx): Promise<LinkedEntity[]> => {
    if (normNames.length === 0) return [];
    const rows = await tx
      .select()
      .from(entities)
      .where(inArray(entities.normalizedName, normNames))
      .limit(50);
    return rows.map((e) => ({
      entityId: e.id,
      canonicalName: e.canonicalName,
      type: e.type,
    }));
  });

  // 2) n-hop 遍历：以 seed 为起点，最多 maxHops 跳（Neo4j 派生索引）
  let paths: GraphPath[] = [];
  try {
    paths = await getGraphStore().traverse(
      tenantId,
      seeds.map((s) => s.entityId),
      maxHops,
    );
  } catch (err) {
    console.warn(
      `[graph-retrieve] Neo4j 遍历失败，降级为无子图路径: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    paths = [];
  }

  // 3) 收集子图涉及的实体名（seed + 路径节点）→ 解析 id → 回表证据 chunk
  const involvedNames = new Set<string>();
  for (const s of seeds) involvedNames.add(normalizeEntityName(s.canonicalName));
  for (const p of paths) {
    for (const n of p.entities) involvedNames.add(normalizeEntityName(n));
  }
  const involvedNorm = [...involvedNames].filter(Boolean);

  const evidence = await withTenantTx(tenantId, async (tx): Promise<GraphEvidence[]> => {
    const entityIds = new Set<string>(seeds.map((s) => s.entityId));
    if (involvedNorm.length > 0) {
      const rows = await tx
        .select({ id: entities.id })
        .from(entities)
        .where(inArray(entities.normalizedName, involvedNorm))
        .limit(200);
      for (const r of rows) entityIds.add(r.id);
    }
    if (entityIds.size === 0) return [];

    const ids = [...entityIds];
    const mentions = await tx
      .select({ chunkId: entityMentions.chunkId })
      .from(entityMentions)
      .where(inArray(entityMentions.entityId, ids))
      .limit(200);
    const chunkIds = [...new Set(mentions.map((m) => m.chunkId))];
    if (chunkIds.length === 0) return [];

    const rows = await tx
      .select()
      .from(chunks)
      .where(inArray(chunks.id, chunkIds));
    return rows
      .filter((c) => c.type === "child")
      .map((c) => ({
        chunkId: c.id,
        documentId: c.documentId,
        title: typeof c.metadata.title === "string" ? c.metadata.title : "",
        content: c.content,
      }));
  });

  return { query, seeds, paths, evidence };
}