import type { FastifyInstance } from "fastify";
import {
  activateDatasetVersion,
  createDatasetVersion,
  getDatasetVersion,
  listDatasetVersions,
} from "../application/version.js";

/**
 * 数据集版本（知识库快照）管理路由。
 *
 * 产品语义（只增不改）：
 * - POST /versions       创建版本（版本号租户内递增）
 * - GET  /versions       版本列表（含文档数）
 * - GET  /versions/:id   版本详情 + 其下文档列表
 * - 无 DELETE / PUT：版本不可删除、不可修改
 */
function tenantOf(headers: Record<string, unknown>): string {
  const t = headers["x-tenant-id"];
  if (typeof t !== "string" || t.length === 0) {
    throw new Error("missing x-tenant-id header");
  }
  return t;
}

export async function versionRoutes(app: FastifyInstance): Promise<void> {
  // ── 创建版本 ──────────────────────────────────────────────
  app.post<{ Body: { name?: string } }>("/versions", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const name =
      typeof req.body?.name === "string" && req.body.name.trim().length > 0
        ? req.body.name.trim()
        : `version-${Date.now()}`;
    const version = await createDatasetVersion(tenantId, { name });
    return reply.code(201).send(version);
  });

  // ── 版本列表（含文档数） ──────────────────────────────────
  app.get("/versions", async (req) => {
    const tenantId = tenantOf(req.headers);
    return listDatasetVersions(tenantId);
  });

  // ── 激活版本：切换查询默认检索范围（状态变更，非内容修改） ──
  app.post<{ Params: { id: string } }>(
    "/versions/:id/activate",
    async (req, reply) => {
      const tenantId = tenantOf(req.headers);
      try {
        await activateDatasetVersion(tenantId, req.params.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "invalid versionId";
        return reply.code(400).send({ error: msg });
      }
      return reply.send({ ok: true });
    },
  );

  // ── 版本详情 + 文档列表 ───────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/versions/:id",
    async (req, reply) => {
      const tenantId = tenantOf(req.headers);
      const version = await getDatasetVersion(tenantId, req.params.id);
      if (!version) return reply.code(404).send({ error: "not found" });
      return version;
    },
  );
}
