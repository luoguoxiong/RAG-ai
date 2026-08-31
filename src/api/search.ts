/**
 * 检索相关 API 路由（REST 层）。
 *
 * 路由族：
 * - POST /search          混合检索 + RAG 问答（Web 前端 ChatPage 调用）
 * - POST /search/analyze  Query Intelligence 分析 + 路由（调试端点，不检索）
 * - POST /search/graph    n-hop 图检索：实体链接 + 子图遍历 + 证据回表
 * - POST /search/cypher   Text2Cypher：自然语言 -> Cypher -> Neo4j 只读查询
 * - POST /search/global   Global Graph Search：社区摘要检索
 *
 * 所有路由均要求 x-tenant-id 请求头做租户隔离（§24.1）；
 * 可选 versionId 做版本过滤（检索范围限定在该版本文档集内，缺省用激活版本）。
 */
import type { FastifyInstance } from "fastify";
import { answerQuery } from "../application/query.js";
import { resolveVersionDocumentIds } from "../application/version.js";
import { retrieveGraph } from "../retrieval/graph.js";
import { text2Cypher } from "../retrieval/text2cypher.js";
import { globalGraphSearch } from "../retrieval/global-graph.js";
import { analyzeAndRoute } from "../query/index.js";

/** 从请求头读取租户 ID，缺失或为空直接抛错拒绝 */
function tenantOf(headers: Record<string, unknown>): string {
  const t = headers["x-tenant-id"];
  if (typeof t !== "string" || t.length === 0) {
    throw new Error("missing x-tenant-id header");
  }
  return t;
}

/** 检索请求体（各路由按需取用其中的字段） */
interface SearchBody {
  /** 用户原始查询文本（必填） */
  query?: string;
  /** 召回条数上限，默认取 config.defaultTopK */
  topK?: number;
  /** n-hop 图检索的最大跳数（1~5），仅 /search/graph 使用 */
  maxHops?: number;
  /** 关闭 Query Intelligence（Phase 5），走直连混合检索 */
  intelligence?: boolean;
  /** 数据集版本：检索只在该版本包含的文档集合内召回；不传则用激活版本 */
  versionId?: string;
}

/**
 * 版本过滤前置：把"版本"展开成其下 documentIds 集合（检索过滤条件）。
 * versionId 缺省时使用该租户的激活版本（active）。
 * 返回 null 表示版本非法（已写入 400 响应），调用方应直接 return。
 */
async function requireVersion(
  tenantId: string,
  body: SearchBody,
  reply: { code: (n: number) => { send: (o: unknown) => unknown } },
): Promise<string[] | null> {
  const versionId = body?.versionId;
  try {
    return await resolveVersionDocumentIds(tenantId, versionId);
  } catch (err) {
    // 版本不存在 / 不属于该租户 / 参数非法 → 统一 400，附可读错误信息
    const msg =
      err instanceof Error ? err.message : `invalid versionId: ${String(versionId)}`;
    reply.code(400).send({ error: msg });
    return null;
  }
}

/**
 * 注册检索路由族。
 * 每个 handler 统一流程：校验租户头 → 校验 query 非空 → 解析版本过滤
 * → 归一化 topK/maxHops 参数 → 分发到应用层 / 检索层实现。
 */
export async function searchRoutes(app: FastifyInstance): Promise<void> {
  // 混合检索 + RAG 问答：Query Intelligence 开启时走智能链路，
  // 关闭时（intelligence=false）走直连混合检索（§13-15）
  app.post<{ Body: SearchBody }>("/search", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }
    // 版本过滤前置：展开 versionId -> documentIds 集合，非法则 400
    const documentIds = await requireVersion(tenantId, req.body ?? {}, reply);
    if (documentIds === null) return;
    const topK =
      typeof req.body?.topK === "number" && req.body.topK > 0
        ? req.body.topK
        : undefined;
    return answerQuery(tenantId, query, topK, {
      intelligence: req.body?.intelligence,
      documentIds,
    });
  });

  // Query Intelligence 调试端点（§13-15）：只做分析 + 路由，不检索
  app.post<{ Body: SearchBody }>("/search/analyze", async (req, reply) => {
    // 仅需 query 与 topK，无需租户/版本（分析不涉及数据访问）
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }
    const topK =
      typeof req.body?.topK === "number" && req.body.topK > 0
        ? req.body.topK
        : undefined;
    // 返回 { analysis, plan } 供前端/调试观察路由决策
    return analyzeAndRoute(query, topK);
  });

  // 图检索（§12 n-hop）：实体链接 + 子图遍历 + 子图证据回表
  app.post<{ Body: SearchBody }>("/search/graph", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }
    const documentIds = await requireVersion(tenantId, req.body ?? {}, reply);
    if (documentIds === null) return;
    // 跳数限制 1~5：防止跨度过大的子图导致遍历爆炸
    const maxHops =
      typeof req.body?.maxHops === "number" &&
      req.body.maxHops > 0 &&
      req.body.maxHops <= 5
        ? req.body.maxHops
        : undefined;
    return retrieveGraph(tenantId, query, maxHops, documentIds);
  });

  // Text2Cypher（§17）：自然语言 -> Cypher -> 校验 -> Neo4j 只读查询
  app.post<{ Body: SearchBody }>("/search/cypher", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }
    // 不依赖版本过滤（图遍历在检索层已按 tenantId 隔离），直接执行
    return text2Cypher(tenantId, query);
  });

  // Global Graph Search（Phase 7）：社区摘要检索
  app.post<{ Body: SearchBody }>("/search/global", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }
    const documentIds = await requireVersion(tenantId, req.body ?? {}, reply);
    if (documentIds === null) return;
    const topK =
      typeof req.body?.topK === "number" && req.body.topK > 0
        ? req.body.topK
        : undefined;
    return globalGraphSearch(tenantId, query, topK, documentIds);
  });
}
