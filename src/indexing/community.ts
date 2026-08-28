import { eq } from "drizzle-orm";
import { withTenantTx } from "../db/index.js";
import {
  entities,
  relations,
  communities,
  communityMembers,
} from "../db/schema/entity.js";
import { createLLMProvider } from "../ai/llm.js";
import { config } from "../config.js";

// ---- Union-Find（连通分量检测） ----

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    let curr = x;
    while (this.parent.get(curr) !== root) {
      const next = this.parent.get(curr)!;
      this.parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export interface DetectedCommunity {
  communityIndex: number;
  entityIds: string[];
  entityNames: string[];
  relationDescriptions: string[];
}

/**
 * CommunityDetector（Phase 7）：从 PG entities + relations 读取全量图，
 * 用 Union-Find 做连通分量检测，产出社区分组。
 *
 * 不依赖 Neo4j GDS 插件，在应用层完成 O(N+M) 检测。
 * 社区是租户内共享、租户间隔离的（§24.1）。
 */
export async function detectCommunities(
  tenantId: string,
  minSize = 2,
): Promise<DetectedCommunity[]> {
  return withTenantTx(tenantId, async (tx) => {
    const entityRows = await tx
      .select({ id: entities.id, name: entities.canonicalName })
      .from(entities);
    const relRows = await tx
      .select({
        fromId: relations.fromEntityId,
        toId: relations.toEntityId,
        type: relations.type,
      })
      .from(relations);

    const uf = new UnionFind();
    const nameById = new Map<string, string>();
    for (const e of entityRows) {
      nameById.set(e.id, e.name);
      uf.find(e.id); // ensure exists
    }
    for (const r of relRows) {
      uf.union(r.fromId, r.toId);
    }

    // group by root
    const groups = new Map<string, string[]>();
    for (const e of entityRows) {
      const root = uf.find(e.id);
      const arr = groups.get(root);
      if (arr) arr.push(e.id);
      else groups.set(root, [e.id]);
    }

    // relation descriptions per community
    const relsByEntity = new Map<string, { type: string; other: string }[]>();
    for (const r of relRows) {
      const fromName = nameById.get(r.fromId) ?? "?";
      const toName = nameById.get(r.toId) ?? "?";
      const fl = relsByEntity.get(r.fromId);
      if (fl) fl.push({ type: r.type, other: toName });
      else relsByEntity.set(r.fromId, [{ type: r.type, other: toName }]);
      const tl = relsByEntity.get(r.toId);
      if (tl) tl.push({ type: r.type, other: fromName });
      else relsByEntity.set(r.toId, [{ type: r.type, other: fromName }]);
    }

    let idx = 0;
    const result: DetectedCommunity[] = [];
    for (const ids of groups.values()) {
      if (ids.length < minSize) continue;
      const names = ids.map((id) => nameById.get(id) ?? "?");
      const relDescs = new Set<string>();
      for (const id of ids) {
        for (const r of relsByEntity.get(id) ?? []) {
          relDescs.add(`${nameById.get(id) ?? "?"} -[${r.type}]-> ${r.other}`);
        }
      }
      result.push({
        communityIndex: idx++,
        entityIds: ids,
        entityNames: names,
        relationDescriptions: [...relDescs].slice(0, 50),
      });
    }
    return result;
  });
}

// ---- Community Summarizer ----

function deterministicSummary(c: DetectedCommunity): string {
  const names = c.entityNames.join("、");
  const rels = c.relationDescriptions.slice(0, 10).join("; ");
  return `社区 ${c.communityIndex}（${c.entityIds.length} 个实体）：${names}。关系：${rels}`;
}

/**
 * 为每个社区生成摘要（LLM 优先，无 API key 时确定性回退）。
 * 摘要供 Global Graph Search 的检索匹配使用。
 */
export async function summarizeCommunities(
  detected: DetectedCommunity[],
): Promise<{ index: number; summary: string }[]> {
  const llm = config.openai.apiKey ? createLLMProvider() : null;

  if (!llm) {
    return detected.map((c) => ({
      index: c.communityIndex,
      summary: deterministicSummary(c),
    }));
  }

  const results: { index: number; summary: string }[] = [];
  for (const c of detected) {
    const prompt = [
      "你是知识图谱社区摘要生成器。根据以下实体与关系，生成一段简洁的中文摘要，",
      "概括这个社区的主题和核心关系。不要输出多余文字。",
      "",
      `实体：${c.entityNames.join("、")}`,
      `关系：${c.relationDescriptions.join("\n")}`,
    ].join("\n");
    try {
      const reply = await llm.chat([{ role: "user", content: prompt }], {
        temperature: 0.3,
        maxTokens: 256,
      });
      results.push({ index: c.communityIndex, summary: reply.content.trim() });
    } catch {
      results.push({ index: c.communityIndex, summary: deterministicSummary(c) });
    }
  }
  return results;
}

// ---- 持久化 ----

/**
 * 重建社区：检测 -> 摘要 -> 写入 PG（全量替换旧社区）。
 * 在 Reconcile 循环中由 needsRebuild 判定触发（§7.1 对账）。
 */
export async function rebuildCommunities(
  tenantId: string,
): Promise<{ communities: number; entities: number }> {
  const detected = await detectCommunities(tenantId, config.community.minSize);
  if (detected.length === 0) {
    return { communities: 0, entities: 0 };
  }

  const summaries = await summarizeCommunities(detected);

  await withTenantTx(tenantId, async (tx) => {
    // 全量替换：先删旧社区（级联删除 members），再插入新社区
    await tx.delete(communities).where(eq(communities.tenantId, tenantId));

    for (let i = 0; i < detected.length; i++) {
      const c = detected[i]!;
      const s = summaries[i];
      const [row] = await tx
        .insert(communities)
        .values({
          tenantId,
          communityIndex: c.communityIndex,
          summary: s?.summary ?? deterministicSummary(c),
          entityCount: c.entityIds.length,
        })
        .returning({ id: communities.id });

      if (!row) continue;
      for (const entityId of c.entityIds) {
        await tx
          .insert(communityMembers)
          .values({ tenantId, communityId: row.id, entityId })
          .onConflictDoNothing();
      }
    }
  });

  return {
    communities: detected.length,
    entities: detected.reduce((n, c) => n + c.entityIds.length, 0),
  };
}
