import { eq, sql } from "drizzle-orm";
import { outbox } from "../db/schema/outbox.js";
import type { Tx } from "../db/index.js";

export type OutboxEventType = "chunk.upserted" | "chunk.removed";

export interface OutboxEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: OutboxEventType;
  payload?: Record<string, unknown>;
}

/** 在业务事务内写入 Outbox（与业务变更同事务，§7.1） */
export async function emitOutbox(
  tx: Tx,
  tenantId: string,
  evt: OutboxEvent,
): Promise<void> {
  await tx.insert(outbox).values({
    tenantId,
    aggregateType: evt.aggregateType,
    aggregateId: evt.aggregateId,
    eventType: evt.eventType,
    payload: evt.payload ?? {},
  });
}

export function emitChunkUpserted(tx: Tx, tenantId: string, chunkId: string) {
  return emitOutbox(tx, tenantId, {
    aggregateType: "chunk",
    aggregateId: chunkId,
    eventType: "chunk.upserted",
  });
}

export function emitChunkRemoved(tx: Tx, tenantId: string, chunkId: string) {
  return emitOutbox(tx, tenantId, {
    aggregateType: "chunk",
    aggregateId: chunkId,
    eventType: "chunk.removed",
  });
}

/** 标记 outbox 事件状态（dispatcher 使用） */
export async function markOutboxDone(tx: Tx, id: string): Promise<void> {
  await tx
    .update(outbox)
    .set({ status: "done" })
    .where(eq(outbox.id, id));
}

export async function markOutboxFailed(
  tx: Tx,
  id: string,
  error: string,
): Promise<void> {
  await tx
    .update(outbox)
    .set({
      status: "failed",
      error,
      attempts: sql`${outbox.attempts} + 1`,
      availableAt: sql`now() + (power(2, ${outbox.attempts}) * interval '1 second')`,
    })
    .where(eq(outbox.id, id));
}