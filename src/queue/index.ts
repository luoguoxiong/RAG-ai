import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config.js";
import type { JobType } from "../domain/index.js";

export const redis = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

export const indexQueue = new Queue<JobPayload>("rag-index", {
  connection: redis,
});

export interface JobPayload {
  tenantId: string;
  documentId?: string;
  versionId?: string;
}

export async function enqueueJob(
  type: JobType,
  jobId: string,
  payload: JobPayload,
): Promise<void> {
  await indexQueue.add(type, payload, {
    jobId,
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}