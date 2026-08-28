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
    // 关键行：通过 set_config 把当前租户写入 PG 会话变量 app.tenant_id。
    // - 第三个参数 true（is_local，等价 SET LOCAL）→ 仅当前事务内生效，
    //   事务结束自动还原，避免连接池复用时把租户绑定泄漏给下一个请求
    // - RLS 策略（setupRls 创建）用 current_setting('app.tenant_id') 过滤，
    //   因此即使查询漏写 WHERE tenant_id = ...，数据库层也会静默隔离，
    //   作为应用层过滤之外的兜底防线（defense in depth）
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * 幂等创建 RLS 策略。可在启动时调用；Production 中应纳入迁移。
 * 策略本质：把每张租户表的所有行，绑定到"当前会话声明的租户"。
 */
export async function setupRls(): Promise<void> {
  // tenants 表本身不套 RLS（它是租户根；跨租户对账需要枚举它）。
  // 其余 tenant-scoped 表开启 RLS 并 FORCE，使应用连接（即便为表 owner）也必须命中策略，
  // 从而使 `app.tenant_id` 会话变量真正生效。
  await db.execute(sql`
    DO $$
    DECLARE t text;
    BEGIN
      -- 逐个处理所有租户相关表（新增表需同步维护此清单）
      FOREACH t IN ARRAY ARRAY['documents','document_versions','chunks','index_status','jobs','outbox','entities','entity_mentions','relations','communities','community_members','eval_datasets','eval_queries','eval_runs','eval_run_results','dataset_versions']
      LOOP
        -- 1. 开启并强制 RLS：即便连接角色是表 owner 也必须走策略，无法绕过
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        -- 2. 幂等重建策略（先删后建，重复调用不报错）
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        -- 3. 策略条件：行所属租户 = 会话变量声明的租户。
        --    current_setting(..., true) 取不到值时返回 NULL 而非抛错，
        --    未绑定租户的查询会因条件不成立而返回空结果（安全失败方向）
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
          t
        );
      END LOOP;
    END $$;
  `);
}