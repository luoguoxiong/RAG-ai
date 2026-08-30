import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { db, pool, setupRls } from "./db/index.js";
import { tenants } from "./db/schema/tenant.js";
import { documentRoutes } from "./api/documents.js";
import { searchRoutes } from "./api/search.js";
import { versionRoutes } from "./api/versions.js";
import { evalRoutes } from "./api/eval.js";

const DEMO_TENANT_ID = "00000000-0000-0000-0000-000000000001";

async function ensureDemoTenant(): Promise<void> {
  const existing = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, DEMO_TENANT_ID))
    .limit(1);
  if (!existing[0]) {
    await db
      .insert(tenants)
      .values({
        id: DEMO_TENANT_ID,
        name: "demo",
        plan: "pro",
        status: "active",
      });
    console.log(`[bootstrap] created demo tenant ${DEMO_TENANT_ID}`);
  }
}

async function waitForPostgres(retries = 20): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query("select 1");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("postgres not ready");
}

async function startup(): Promise<void> {
  await waitForPostgres();
  await setupRls();
  await ensureDemoTenant();

  const app = Fastify({ logger: false });
  // 允许前端（vite :5173）跨域访问；生产可收紧为具体域名
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(documentRoutes);
  await app.register(versionRoutes);
  await app.register(searchRoutes);
  await app.register(evalRoutes);

  app.get("/health", async () => ({ ok: true }));

  await app.listen({ port: config.port, host: config.host });
  console.log(
    `[api] listening on http://${config.host}:${config.port} (demo tenant: ${DEMO_TENANT_ID})`,
  );
}

startup().catch((err) => {
  console.error(err);
  process.exit(1);
});