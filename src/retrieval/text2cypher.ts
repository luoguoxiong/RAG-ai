import { config } from "../config.js";
import { createLLMProvider } from "../ai/llm.js";
import { getGraphStore } from "../indexing/graph.js";
import { DeterministicEntityExtractor } from "../ingestion/graph/extractor.js";
import { normalizeEntityName } from "../domain/entity/resolver.js";

/**
 * Text2Cypher（§17）：自然语言问题 -> Cypher Generator -> Validator ->
 * Neo4j 只读查询 -> Evidence。
 *
 * 适合聚合、统计、过滤、排序类查询（§17）。与 n-hop 遍历互补：
 * n-hop 从实体出发走图，Text2Cypher 从问题出发生成查询。
 *
 * 安全约束（§17）：只允许 MATCH / WHERE / WITH / RETURN / ORDER BY / LIMIT，
 * 禁止 CREATE / MERGE / SET / DELETE / DROP。
 */

/** 禁止的写操作关键字 */
const FORBIDDEN_KEYWORDS = [
  "CREATE",
  "MERGE",
  "SET",
  "DELETE",
  "DETACH",
  "DROP",
  "REMOVE",
  "FOREACH",
  "CALL",
  "YIELD",
  "UNWIND",
];

/** 校验 Cypher 只含只读子句，拦截写操作 */
export function validateReadOnlyCypher(cypher: string): { ok: boolean; reason?: string } {
  const upper = cypher.toUpperCase();
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`).test(upper)) {
      return { ok: false, reason: `forbidden keyword: ${kw}` };
    }
  }
  // 必须以 MATCH 或 OPTIONAL MATCH 开头（去掉前导空白和注释）
  const trimmed = upper.replace(/\/\/.*$/gm, "").trim();
  if (!trimmed.startsWith("MATCH") && !trimmed.startsWith("OPTIONAL")) {
    return { ok: false, reason: "must start with MATCH" };
  }
  // 必须包含 RETURN
  if (!/\bRETURN\b/.test(trimmed)) {
    return { ok: false, reason: "must contain RETURN" };
  }
  return { ok: true };
}

/** 向 Cypher 注入 tenantId 过滤（在第一个 MATCH 的 Entity 节点上追加） */
function injectTenantFilter(cypher: string, tenantId: string): string {
  // 简单策略：在 WHERE 子句中追加 tenantId 过滤；若无 WHERE 则添加
  const hasWhere = /\bWHERE\b/i.test(cypher);
  const tenantClause = `n.tenantId = $tenantId`;
  if (hasWhere) {
    // 在第一个 WHERE 后插入 AND
    return cypher.replace(/WHERE\s/i, `WHERE ${tenantClause} AND `);
  }
  // 在第一个 MATCH 之后、RETURN 之前插入 WHERE
  return cypher.replace(
    /(MATCH\s+.*?)(\s+RETURN)/is,
    `$1 WHERE ${tenantClause}$2`,
  );
}

export interface Text2CypherResult {
  query: string;
  cypher: string;
  validated: boolean;
  rows: Record<string, unknown>[];
  /** 文本化后的结果，可直接作为 Evidence.content */
  textResult: string;
}

const SCHEMA_DESCRIPTION = `图数据库 schema:
- (:Entity {tenantId, entityId, canonicalName, normalizedName, type, aliases})
- (:Entity)-[:REL {tenantId, type, confidence, sourceChunkId, sourceDocumentId}]->(:Entity)
所有节点和关系都有 tenantId 属性用于租户隔离。`;

/** LLM 生成 Cypher（有 API key 时），失败回退到确定性生成 */
async function generateCypher(query: string): Promise<string> {
  if (config.openai.apiKey) {
    const llm = createLLMProvider();
    const prompt = [
      "你是 Cypher 查询生成器。根据用户问题生成 Neo4j Cypher 只读查询。",
      SCHEMA_DESCRIPTION,
      "规则：",
      "1. 只能使用 MATCH / WHERE / WITH / RETURN / ORDER BY / LIMIT",
      "2. 禁止 CREATE / MERGE / SET / DELETE / DROP",
      `3. 必须用 $tenantId 参数做租户过滤：WHERE n.tenantId = $tenantId`,
      "4. 实体节点的 label 是 Entity，关系类型是 REL",
      "5. 只输出 Cypher 语句，不要输出任何其它文字",
      "",
      `问题：${query}`,
    ].join("\n");
    try {
      const reply = await llm.chat([{ role: "user", content: prompt }], {
        temperature: 0,
      });
      const cypher = reply.content
        .replace(/```cypher/gi, "")
        .replace(/```/g, "")
        .trim();
      if (cypher) return cypher;
    } catch {
      // fall through to deterministic
    }
  }
  return deterministicCypher();
}

/** 确定性回退：从查询中抽取引号实体，生成 MATCH 查询 */
function deterministicCypher(): string {
  return [
    "MATCH (n:Entity {tenantId: $tenantId})-[r:REL {tenantId: $tenantId}]-(m:Entity {tenantId: $tenantId})",
    "WHERE n.canonicalName IN $entityNames",
    "RETURN n.canonicalName AS from, r.type AS relation, m.canonicalName AS to",
    "LIMIT 50",
  ].join("\n");
}

/** 从查询中提取实体名，用于确定性回退 */
async function extractEntityNames(query: string): Promise<string[]> {
  const extractor = new DeterministicEntityExtractor();
  const graph = await extractor.extract(query);
  return [...new Set(graph.entities.map((e) => normalizeEntityName(e.name)).filter(Boolean))];
}

/** 将 Neo4j 查询结果文本化为 Evidence.content */
function rowsToText(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "（无结果）";
  const lines: string[] = [];
  for (const row of rows.slice(0, 50)) {
    const parts = Object.entries(row).map(([k, v]) => {
      if (v === null || v === undefined) return `${k}: null`;
      if (typeof v === "object") {
        const props = (v as { properties?: Record<string, unknown> }).properties ?? v;
        const name = (props as { canonicalName?: unknown }).canonicalName ?? JSON.stringify(v);
        return `${k}: ${name}`;
      }
      return `${k}: ${String(v)}`;
    });
    lines.push(parts.join(" | "));
  }
  return lines.join("\n");
}

/**
 * Text2Cypher 全流程：生成 -> 校验 -> 注入 tenantId -> 执行 -> 文本化。
 * Neo4j 不可用时降级返回空结果（§23.1 多级容错）。
 */
export async function text2Cypher(
  tenantId: string,
  query: string,
): Promise<Text2CypherResult> {
  // 1. 生成 Cypher
  const cypher = await generateCypher(query);

  // 2. 校验只读
  const validation = validateReadOnlyCypher(cypher);
  if (!validation.ok) {
    return {
      query,
      cypher,
      validated: false,
      rows: [],
      textResult: `Cypher 校验失败: ${validation.reason}`,
    };
  }

  // 3. 确保有 tenantId 过滤
  let finalCypher = cypher;
  if (!/\$tenantId/i.test(cypher)) {
    finalCypher = injectTenantFilter(cypher, tenantId);
  }

  // 4. 提取实体名参数（确定性回退路径需要）
  const entityNames = await extractEntityNames(query);

  // 5. 执行
  let rows: Record<string, unknown>[] = [];
  try {
    rows = await getGraphStore().runReadOnlyQuery(finalCypher, {
      tenantId,
      entityNames,
    });
  } catch (err) {
    return {
      query,
      cypher: finalCypher,
      validated: true,
      rows: [],
      textResult: `Neo4j 查询失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    query,
    cypher: finalCypher,
    validated: true,
    rows,
    textResult: rowsToText(rows),
  };
}
