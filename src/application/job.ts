import { eq } from "drizzle-orm";
import { jobs } from "../db/schema/job.js";
import { withTenantTx } from "../db/index.js";
import type { JobStatus, JobType } from "../domain/index.js";

/** 在 tenant 事务内创建 Job 行，返回 jobId 供入队 */
export async function createJob(
  tenantId: string,
  type: JobType,
  payload: Record<string, unknown>,
): Promise<string> {
  return withTenantTx(tenantId, async (tx) => {
    const [job] = await tx
      .insert(jobs)
      .values({ tenantId, type, status: "pending", payload })
      .returning();
    if (!job) throw new Error("failed to create job");
    return job.id;
  });
}

export async function markJob(
  tenantId: string,
  jobId: string,
  status: JobStatus,
  error?: string,
): Promise<void> {
  await withTenantTx(tenantId, (tx) =>
    tx
      .update(jobs)
      .set({ status, error, updatedAt: new Date() })
      .where(eq(jobs.id, jobId)),
  );
}