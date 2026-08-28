import type { FastifyInstance } from "fastify";
import { answerQuery } from "../application/query.js";
import { retrieveGraph } from "../retrieval/graph.js";
import { text2Cypher } from "../retrieval/text2cypher.js";
import { globalGraphSearch } from "../retrieval/global-graph.js";
import { analyzeAndRoute } from "../query/index.js";

function tenantOf(headers: Record<string, unknown>): string {
  const t = headers["x-tenant-id"];
  if (typeof t !== "string" || t.length === 0) {
    throw new Error("missing x-tenant-id header");
  }
  return t;
}

interface SearchBody {
  query?: string;
  topK?: number;
  maxHops?: number;
  /** 关闭 Query Intelligence（Phase 5），走直连混合检索 */
  intelligence?: boolean;
}

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: SearchBody }>("/search", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }
    const topK =
      typeof req.body?.topK === "number" && req.body.topK > 0
        ? req.body.topK
        : undefined;
    return answerQuery(tenantId, query, topK, {
      intelligence: req.body?.intelligence,
    });
  });

  // Query Intelligence 调试端点（§13-15）：只做分析 + 路由，不检索
  app.post<{ Body: SearchBody }>("/search/analyze", async (req, reply) => {
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }
    const topK =
      typeof req.body?.topK === "number" && req.body.topK > 0
        ? req.body.topK
        : undefined;
    return analyzeAndRoute(query, topK);
  });

  // 图检索（§12 n-hop）：实体链接 + 子图遍历 + 子图证据回表
  app.post<{ Body: SearchBody }>("/search/graph", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }
    const maxHops =
      typeof req.body?.maxHops === "number" &&
      req.body.maxHops > 0 &&
      req.body.maxHops <= 5
        ? req.body.maxHops
        : undefined;
    return retrieveGraph(tenantId, query, maxHops);
  });

  // Text2Cypher（§17）：自然语言 -> Cypher -> 校验 -> Neo4j 只读查询
  app.post<{ Body: SearchBody }>("/search/cypher", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }
    return text2Cypher(tenantId, query);
  });

  // Global Graph Search（Phase 7）：社区摘要检索
  app.post<{ Body: SearchBody }>("/search/global", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }
    const topK =
      typeof req.body?.topK === "number" && req.body.topK > 0
        ? req.body.topK
        : undefined;
    return globalGraphSearch(tenantId, query, topK);
  });
}