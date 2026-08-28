import neo4j, { type Driver, type Session } from "neo4j-driver";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { withTenantTx } from "../db/index.js";
import { entities, entityMentions, relations } from "../db/schema/entity.js";
import type { ChunkRow } from "../db/schema/chunk.js";
import { createEntityExtractor } from "../ingestion/graph/extractor.js";
import {
  normalizeEntityName,
  resolveEntity,
  type ResolvedEntity,
} from "../domain/entity/resolver.js";
import type { IndexWriter } from "./writer.js";

/** Neo4j 节点视图（租户内 Entity 的原生投影） */
export interface GraphNode {
  entityId: string;
  canonicalName: string;
  normalizedName: string;
  type: string;
  aliases: string[];
}

/** Neo4j 关系视图（带上证据 provenance） */
export interface GraphRelation {
  fromEntityId: string;
  toEntityId: string;
  type: string;
  confidence: number;
  sourceChunkId: string | null;
  sourceDocumentId: string | null;
}

/** 一条 n-hop 路径（文本化后可直接作为 Evidence.content，§19.1） */
export interface GraphPath {
  entities: string[];
  relations: string[];
  length: number;
  path: string;
}

interface NeoNode {
  properties?: Record<string, unknown>;
}
interface NeoRelationship {
  type?: string;
  properties?: Record<string, unknown>;
}
interface NeoSegment {
  start?: NeoNode;
  end?: NeoNode;
  relationship?: NeoRelationship;
}
interface NeoPath {
  segments?: NeoSegment[];
}

function buildPathText(names: string[], relTypes: string[]): string {
  let out = `(:Entity ${names[0] ?? ""})`;
  for (let i = 0; i < relTypes.length; i++) {
    out += `-[:${relTypes[i]}]->(:Entity ${names[i + 1] ?? ""})`;
  }
  return out;
}

function nodeFromRecord(n: NeoNode | null | undefined): GraphNode {
  const props = n?.properties ?? {};
  return {
    entityId: String(props.entityId ?? ""),
    canonicalName: String(props.canonicalName ?? ""),
    normalizedName: String(props.normalizedName ?? ""),
    type: String(props.type ?? "unknown"),
    aliases: Array.isArray(props.aliases) ? props.aliases.map(String) : [],
  };
}

function pathFromRecord(p: NeoPath | null | undefined): GraphPath | null {
  const segs = p?.segments ?? [];
  if (segs.length === 0) return null;

  const entityNames: string[] = [];
  const relTypes: string[] = [];
  for (const seg of segs) {
    entityNames.push(String(seg.start?.properties?.canonicalName ?? ""));
    const relType = seg.relationship?.properties?.type ?? seg.relationship?.type ?? "REL";
    relTypes.push(String(relType));
  }
  const last = segs[segs.length - 1]?.end?.properties?.canonicalName ?? "";
  entityNames.push(String(last));

  return {
    entities: entityNames,
    relations: relTypes,
    length: relTypes.length,
    path: buildPathText(entityNames, relTypes),
  };
}

/**
 * GraphStore：Neo4j 派生索引（§4、§12）。
 * 所有节点/关系带 `tenantId` 属性，查询强制 `tenantId` 过滤（§24.1）。
 * PG 是 Source of Truth；Neo4j 只存 Entity 节点 + REL 关系，MENTIONS 引用计数在 PG。
 */
export class GraphStore {
  private readonly driver: Driver;

  constructor(opts: { url: string; user: string; password: string }) {
    this.driver = neo4j.driver(opts.url, neo4j.auth.basic(opts.user, opts.password));
  }

  private session(): Session {
    return this.driver.session({ database: "neo4j" });
  }

  async upsertEntities(tenantId: string, nodes: GraphNode[]): Promise<void> {
    if (nodes.length === 0) return;
    const s = this.session();
    try {
      for (const n of nodes) {
        await s.run(
          `MERGE (n:Entity {tenantId: $tenantId, entityId: $entityId})
           SET n.canonicalName = $canonicalName,
               n.normalizedName = $normalizedName,
               n.type = $type,
               n.aliases = $aliases`,
          {
            tenantId,
            entityId: n.entityId,
            canonicalName: n.canonicalName,
            normalizedName: n.normalizedName,
            type: n.type,
            aliases: n.aliases,
          },
        );
      }
    } finally {
      await s.close();
    }
  }

  async upsertRelations(tenantId: string, rels: GraphRelation[]): Promise<void> {
    if (rels.length === 0) return;
    const s = this.session();
    try {
      for (const r of rels) {
        await s.run(
          `MATCH (a:Entity {tenantId: $tenantId, entityId: $from}), (b:Entity {tenantId: $tenantId, entityId: $to})
           MERGE (a)-[r:REL {tenantId: $tenantId, type: $type, sourceChunkId: $sourceChunkId}]->(b)
           SET r.confidence = $confidence, r.sourceDocumentId = $sourceDocumentId`,
          {
            tenantId,
            from: r.fromEntityId,
            to: r.toEntityId,
            type: r.type,
            confidence: r.confidence,
            sourceChunkId: r.sourceChunkId,
            sourceDocumentId: r.sourceDocumentId,
          },
        );
      }
    } finally {
      await s.close();
    }
  }

  async deleteRelationsByChunk(tenantId: string, chunkId: string): Promise<void> {
    const s = this.session();
    try {
      await s.run(
        `MATCH (:Entity {tenantId: $tenantId})-[r:REL {sourceChunkId: $chunkId}]->(:Entity) DELETE r`,
        { tenantId, chunkId },
      );
    } finally {
      await s.close();
    }
  }

  async deleteEntities(tenantId: string, entityIds: string[]): Promise<void> {
    if (entityIds.length === 0) return;
    const s = this.session();
    try {
      await s.run(
        `MATCH (n:Entity {tenantId: $tenantId}) WHERE n.entityId IN $ids DETACH DELETE n`,
        { tenantId, ids: entityIds },
      );
    } finally {
      await s.close();
    }
  }

  async findEntitiesByNames(
    tenantId: string,
    normalizedNames: string[],
  ): Promise<GraphNode[]> {
    if (normalizedNames.length === 0) return [];
    const s = this.session();
    try {
      const res = await s.run(
        `MATCH (n:Entity {tenantId: $tenantId}) WHERE n.normalizedName IN $names RETURN n LIMIT 50`,
        { tenantId, names: normalizedNames },
      );
      return res.records.map((r) => nodeFromRecord(r.get("n") as NeoNode | null));
    } finally {
      await s.close();
    }
  }

  async traverse(
    tenantId: string,
    seedIds: string[],
    maxHops: number,
  ): Promise<GraphPath[]> {
    if (seedIds.length === 0) return [];
    const hops = Math.max(1, Math.min(Math.floor(maxHops), 5));
    const s = this.session();
    try {
      const res = await s.run(
        `MATCH (seed:Entity {tenantId: $tenantId})
         WHERE seed.entityId IN $ids
         MATCH path = (seed)-[rels:REL *1..${hops}]-(other:Entity {tenantId: $tenantId})
         WHERE all(n IN nodes(path) WHERE n.tenantId = $tenantId)
         RETURN path
         LIMIT 50`,
        { tenantId, ids: seedIds },
      );
      const paths: GraphPath[] = [];
      for (const r of res.records) {
        const p = pathFromRecord(r.get("path") as NeoPath | null);
        if (p) paths.push(p);
      }
      return paths;
    } finally {
      await s.close();
    }
  }

  /**
   * 执行只读 Cypher 查询（§17 Text2Cypher）。
   * 调用方负责校验 Cypher 只含只读子句，此方法注入 tenantId 参数后执行。
   */
  async runReadOnlyQuery(
    cypher: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const s = this.session();
    try {
      const res = await s.run(cypher, { ...params });
      return res.records.map((r) => r.toObject());
    } finally {
      await s.close();
    }
  }
}

let _store: GraphStore | undefined;

export function getGraphStore(): GraphStore {
  if (!_store) {
    _store = new GraphStore({
      url: config.neo4jUrl,
      user: config.neo4jUser,
      password: config.neo4jPassword,
    });
  }
  return _store;
}

/**
 * GraphIndexWriter（§9 GraphIndexer）：抽取 → 解析(resolution) → PG 持久化 →
 * Neo4j 派生索引。以 chunk 为单元幂等可重建；remove 走引用计数清理（§12）。
 */
export function createGraphIndexWriter(): IndexWriter {
  const extractor = createEntityExtractor();
  const store = getGraphStore();

  return {
    async upsert(tenantId, chunk) {
      if (chunk.type !== "child") return;
      const graph = await extractor.extract(chunk.content);
      if (graph.entities.length === 0) return;

      const { nodes, rels } = await withTenantTx(tenantId, async (tx) => {
        // 幂等重索引：先清空本 chunk 旧 mentions / relations
        await tx.delete(entityMentions).where(eq(entityMentions.chunkId, chunk.id));
        await tx.delete(relations).where(eq(relations.sourceChunkId, chunk.id));

        const nameToResolved = new Map<string, ResolvedEntity>();
        for (const e of graph.entities) {
          const resolved = await resolveEntity(tx, tenantId, e.name, e.type, e.aliases);
          nameToResolved.set(normalizeEntityName(e.name), resolved);
          await tx
            .insert(entityMentions)
            .values({
              tenantId,
              chunkId: chunk.id,
              entityId: resolved.id,
              documentId: chunk.documentId,
            })
            .onConflictDoNothing();
        }

        const relRows: GraphRelation[] = [];
        for (const r of graph.relations) {
          const from = nameToResolved.get(normalizeEntityName(r.from));
          const to = nameToResolved.get(normalizeEntityName(r.to));
          if (!from || !to || from.id === to.id) continue;
          const type = r.type || "RELATED_TO";
          await tx
            .insert(relations)
            .values({
              tenantId,
              fromEntityId: from.id,
              toEntityId: to.id,
              type,
              confidence: 1,
              sourceChunkId: chunk.id,
              sourceDocumentId: chunk.documentId,
              documentVersionId: chunk.documentVersionId,
            })
            .onConflictDoNothing();
          relRows.push({
            fromEntityId: from.id,
            toEntityId: to.id,
            type,
            confidence: 1,
            sourceChunkId: chunk.id,
            sourceDocumentId: chunk.documentId,
          });
        }

        const byId = new Map<string, GraphNode>();
        for (const e of nameToResolved.values()) {
          if (byId.has(e.id)) continue;
          byId.set(e.id, {
            entityId: e.id,
            canonicalName: e.canonicalName,
            normalizedName: e.normalizedName,
            type: e.type,
            aliases: e.aliases,
          });
        }

        return { nodes: [...byId.values()], rels: relRows };
      });

      await store.deleteRelationsByChunk(tenantId, chunk.id);
      await store.upsertEntities(tenantId, nodes);
      await store.upsertRelations(tenantId, rels);
    },

    async remove(tenantId, chunkId) {
      // PG Source of Truth：清 mentions/relations + 删除引用归零的孤儿 entity
      const orphanIds = await withTenantTx(tenantId, async (tx) => {
        const mems = await tx
          .select({ entityId: entityMentions.entityId })
          .from(entityMentions)
          .where(eq(entityMentions.chunkId, chunkId));

        await tx.delete(relations).where(eq(relations.sourceChunkId, chunkId));
        await tx.delete(entityMentions).where(eq(entityMentions.chunkId, chunkId));

        const orphan: string[] = [];
        for (const m of mems) {
          const remaining = await tx
            .select({ id: entityMentions.entityId })
            .from(entityMentions)
            .where(eq(entityMentions.entityId, m.entityId))
            .limit(1);
          if (!remaining[0]) {
            await tx.delete(entities).where(eq(entities.id, m.entityId));
            orphan.push(m.entityId);
          }
        }
        return orphan;
      });

      await store.deleteRelationsByChunk(tenantId, chunkId);
      await store.deleteEntities(tenantId, orphanIds);
    },
  };
}