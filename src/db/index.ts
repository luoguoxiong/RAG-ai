import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import * as schema from "./schema/index.js";
import { config } from "../config.js";

export const pool = new Pool({ connectionString: config.databaseUrl });

export const db = drizzle(pool, { schema });

export type DB = typeof db;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * 租户隔离（RLS）运行时约定：
 * 所有 tenant-scoped 表在 PG 侧启用 Row-Level Security，
 * 用会话变量 `app.tenant_id` 做策略过滤。
 *
 * 在事务内执行 `SET LOCAL` 使该会话绑定到指定 tenant，
 * 任何「未显式携带 tenantId 过滤」的查询都会被 RLS 拦截，
 * 作为应用层注入过滤之外的兜底防线（defense in depth）。
 */
export async function withTenantTx<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * 幂等创建 RLS 策略。可在启动时调用；Production 中应纳入迁移。
 */
export async function setupRls(): Promise<void> {
  // tenants 表本身不套 RLS（它是租户根；跨租户对账需要枚举它）。
  // 其余 tenant-scoped 表开启 RLS 并 FORCE，使应用连接（即便为表 owner）也必须命中策略，
  // 从而使 `app.tenant_id` 会话变量真正生效。
  await db.execute(sql`
    DO $$
    DECLARE t text;
    BEGIN
      FOREACH t IN ARRAY ARRAY['documents','document_versions','chunks','index_status','jobs','outbox','entities','entity_mentions','relations','eval_datasets','eval_queries','eval_runs','eval_run_results']
      LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
          t
        );
      END LOOP;
    END $$;
  `);
}