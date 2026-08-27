import type { FastifyInstance } from "fastify";
import { answerQuery } from "../application/query.js";
import { retrieveGraph } from "../retrieval/graph.js";

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
    return answerQuery(tenantId, query, topK);
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
}