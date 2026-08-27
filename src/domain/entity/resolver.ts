import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/index.js";
import { entities, type EntityRow } from "../../db/schema/entity.js";

/** 实体名归一化：trim + lowercase + NFKC（全角/兼容字符折叠） */
export function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().normalize("NFKC");
}

export interface ResolvedEntity {
  id: string;
  canonicalName: string;
  normalizedName: string;
  type: string;
  aliases: string[];
  created: boolean;
}

function unionAliases(...sets: (string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const set of sets) {
    for (const a of set ?? []) {
      const key = a.trim().toLowerCase();
      if (key) seen.add(a.trim());
    }
  }
  return [...seen];
}

function toResolved(e: EntityRow, created: boolean): ResolvedEntity {
  return {
    id: e.id,
    canonicalName: e.canonicalName,
    normalizedName: e.normalizedName,
    type: e.type,
    aliases: e.aliases,
    created,
  };
}

/**
 * Entity Resolution（§11 Cheap-First）：
 *   精确匹配(name+type) → 归一化名匹配 → 别名匹配 → 新建。
 * 嵌入相似度 / LLM Judge 留待后续阶段（需要真实 embedding/语义判断）。
 */
export async function resolveEntity(
  tx: Tx,
  tenantId: string,
  name: string,
  type: string,
  aliases: string[] = [],
): Promise<ResolvedEntity> {
  const norm = normalizeEntityName(name);
  const safeType = type || "unknown";

  // 1) 精确匹配 (tenantId, normalizedName, type)
  const exact = await tx
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.tenantId, tenantId),
        eq(entities.normalizedName, norm),
        eq(entities.type, safeType),
      ),
    )
    .limit(1);
  if (exact[0]) return toResolved(exact[0], false);

  // 2) 归一化名匹配（跨 type）→ 归并别名，必要时升级 type
  const normMatch = await tx
    .select()
    .from(entities)
    .where(
      and(eq(entities.tenantId, tenantId), eq(entities.normalizedName, norm)),
    )
    .limit(1);
  if (normMatch[0]) {
    const e = normMatch[0];
    const mergedAliases = unionAliases(e.aliases, aliases, [name]);
    const mergedType =
      e.type === "unknown" && safeType !== "unknown" ? safeType : e.type;
    await tx
      .update(entities)
      .set({ aliases: mergedAliases, type: mergedType, updatedAt: new Date() })
      .where(eq(entities.id, e.id));
    return {
      id: e.id,
      canonicalName: e.canonicalName,
      normalizedName: e.normalizedName,
      type: mergedType,
      aliases: mergedAliases,
      created: false,
    };
  }

  // 3) 别名匹配（jsonb containment + 同 type）
  const aliasMatch = await tx
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.tenantId, tenantId),
        eq(entities.type, safeType),
        sql`${entities.aliases} @> ${JSON.stringify([name])}::jsonb`,
      ),
    )
    .limit(1);
  if (aliasMatch[0]) return toResolved(aliasMatch[0], false);

  // 4) 新建
  const [created] = await tx
    .insert(entities)
    .values({
      tenantId,
      canonicalName: name,
      normalizedName: norm,
      type: safeType,
      aliases: unionAliases(aliases),
    })
    .returning();
  if (!created) throw new Error("failed to create entity");
  return toResolved(created, true);
}