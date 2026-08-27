import { and, eq, inArray } from "drizzle-orm";
import { db, withTenantTx, type Tx } from "../db/index.js";
import { documents, documentVersions } from "../db/schema/document.js";
import { chunks, indexStatus } from "../db/schema/chunk.js";
import { jobs } from "../db/schema/job.js";
import { emitChunkUpserted, emitChunkRemoved } from "./outbox.js";
import { parserFor } from "../ingestion/parser.js";
import { normalize } from "../ingestion/normalizer.js";
import { ParentChildSplitter } from "../ingestion/parent-child.js";
import { hashContent, hashChunk } from "../lib/hash.js";

const splitter = new ParentChildSplitter();

export interface IngestInput {
  fileName: string;
  mimeType: string;
  content: Buffer;
}

export interface IngestResult {
  documentId: string;
  versionId: string;
  jobId: string;
}

/**
 * 上传入口：解析 → 归一化 → 落 Document + DocumentVersion → 建 Job。
 * 返回 jobId 供调用方入队（Queue 与 Application 解耦）。
 */
export async function ingestDocument(
  tenantId: string,
  input: IngestInput,
): Promise<IngestResult> {
  const parsed = await parserFor(input.fileName, input.mimeType).parse({
    fileName: input.fileName,
    mimeType: input.mimeType,
    content: input.content,
  });
  const text = normalize(parsed.text);
  const contentHash = hashContent(text);

  return withTenantTx(tenantId, async (tx) => {
    const [doc] = await tx
      .insert(documents)
      .values({
        tenantId,
        sourceType: "file",
        sourceUri: input.fileName,
        title: parsed.title,
        status: "pending",
      })
      .returning();
    if (!doc) throw new Error("failed to create document");

    const [version] = await tx
      .insert(documentVersions)
      .values({
        tenantId,
        documentId: doc.id,
        version: 1,
        contentHash,
        rawContent: text,
        metadata: { ...parsed.metadata, title: parsed.title, language: parsed.language },
        status: "pending",
      })
      .returning();
    if (!version) throw new Error("failed to create document version");

    const [job] = await tx
      .insert(jobs)
      .values({
        tenantId,
        type: "index_document",
        status: "pending",
        payload: { documentId: doc.id, versionId: version.id },
      })
      .returning();
    if (!job) throw new Error("failed to create job");

    return { documentId: doc.id, versionId: version.id, jobId: job.id };
  });
}

interface ChunkInsert {
  tenantId: string;
  documentId: string;
  documentVersionId: string;
  type: "parent" | "child";
  parentId: string | null;
  content: string;
  contentHash: string;
  chunkIndex: number;
  metadata: Record<string, unknown>;
}

/** 按 (documentVersionId, contentHash) 幂等插入 chunk 并返回其 id（§5.3 稳定 ID）。 */
async function insertChunkIfAbsent(tx: Tx, row: ChunkInsert): Promise<string> {
  const [inserted] = await tx
    .insert(chunks)
    .values(row)
    .onConflictDoNothing({
      target: [chunks.documentVersionId, chunks.contentHash],
    })
    .returning({ id: chunks.id });
  if (inserted?.id) return inserted.id;

  const [existing] = await tx
    .select({ id: chunks.id })
    .from(chunks)
    .where(
      and(
        eq(chunks.documentVersionId, row.documentVersionId),
        eq(chunks.contentHash, row.contentHash),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("failed to resolve chunk id");
  return existing.id;
}

/**
 * 处理 index_document / reindex_document（§6 Parent-Child Retrieval）：
 * split → 展开 parent（上下文，不索引）/ child（检索单元，落向量）→
 * 清理过期 chunk → upsert 幂等去重 → 写 Outbox → 标记 ready。
 */
export async function processVersion(
  versionId: string,
  tenantId: string,
): Promise<void> {
  await withTenantTx(tenantId, async (tx) => {
    const version = await loadVersion(tx, versionId, tenantId);
    if (!version) return;

    const text = normalize(version.rawContent ?? "");
    const title =
      typeof version.metadata.title === "string" ? version.metadata.title : "";

    // 先整段展开，得到两级 chunk 的稳定 contentHash（parent/child 用 kind 区分避免碰撞）
    const plans = splitter.split(text).map((group) => {
      const parentContent = group.parent.trim();
      const parentHash = hashChunk({
        documentVersionId: versionId,
        normalizedContent: parentContent,
        kind: "parent",
      });
      const children = group.children
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
        .map((content) => ({
          content,
          hash: hashChunk({
            documentVersionId: versionId,
            normalizedContent: content,
            kind: "child",
          }),
        }));
      return { parentContent, parentHash, children };
    });

    // 清理过期 chunk（先清再插，避免 chunkIndex 唯一索引冲突）
    const desiredHashes = new Set<string>();
    for (const p of plans) {
      desiredHashes.add(p.parentHash);
      for (const c of p.children) desiredHashes.add(c.hash);
    }

    const existing = await tx
      .select({ id: chunks.id, contentHash: chunks.contentHash })
      .from(chunks)
      .where(eq(chunks.documentVersionId, versionId));
    const stale = existing.filter((c) => !desiredHashes.has(c.contentHash));
    if (stale.length > 0) {
      const staleIds = stale.map((c) => c.id);
      await tx.delete(indexStatus).where(inArray(indexStatus.chunkId, staleIds));
      await tx.delete(chunks).where(inArray(chunks.id, staleIds));
      for (const s of stale) await emitChunkRemoved(tx, tenantId, s.id);
    }

    // 落库：parent 先于 child，回填 parentId；chunkIndex 全局递增保证版本内唯一
    let idx = 0;
    for (const p of plans) {
      const parentId = await insertChunkIfAbsent(tx, {
        tenantId,
        documentId: version.documentId,
        documentVersionId: versionId,
        type: "parent",
        parentId: null,
        content: p.parentContent,
        contentHash: p.parentHash,
        chunkIndex: idx++,
        metadata: { title },
      });
      for (const c of p.children) {
        await insertChunkIfAbsent(tx, {
          tenantId,
          documentId: version.documentId,
          documentVersionId: versionId,
          type: "child",
          parentId,
          content: c.content,
          contentHash: c.hash,
          chunkIndex: idx++,
          metadata: { title },
        });
      }
    }

    // 为当前所有 chunk 投递 upsert 事件（IndexWriter 幂等，仅 child 落向量）
    const all = await tx
      .select({ id: chunks.id })
      .from(chunks)
      .where(eq(chunks.documentVersionId, versionId));
    for (const c of all) await emitChunkUpserted(tx, tenantId, c.id);

    await tx
      .update(documentVersions)
      .set({ status: "ready" })
      .where(eq(documentVersions.id, versionId));

    await tx
      .update(documents)
      .set({ status: "ready", currentVersionId: versionId })
      .where(eq(documents.id, version.documentId));
  });
}

/**
 * 删除文档（§12 删除链路在 Phase 1 的基础实现）：
 * 删除 chunk / index_status / outbox 事件 / version / document。
 */
export async function deleteDocument(
  documentId: string,
  tenantId: string,
): Promise<void> {
  await withTenantTx(tenantId, async (tx) => {
    const docChunks = await tx
      .select({ id: chunks.id })
      .from(chunks)
      .where(eq(chunks.documentId, documentId));

    const chunkIds = docChunks.map((c) => c.id);
    if (chunkIds.length > 0) {
      await tx.delete(indexStatus).where(inArray(indexStatus.chunkId, chunkIds));
      for (const id of chunkIds) await emitChunkRemoved(tx, tenantId, id);
      await tx.delete(chunks).where(inArray(chunks.id, chunkIds));
    }

    await tx
      .delete(documentVersions)
      .where(eq(documentVersions.documentId, documentId));
    await tx
      .update(documents)
      .set({ status: "deleted", currentVersionId: null })
      .where(eq(documents.id, documentId));
  });
}

async function loadVersion(
  tx: Tx,
  versionId: string,
  tenantId: string,
) {
  const [row] = await tx
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.id, versionId),
        eq(documentVersions.tenantId, tenantId),
      ),
    )
    .limit(1);
  return row;
}

export { db };