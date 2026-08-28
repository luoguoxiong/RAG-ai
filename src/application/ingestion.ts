import { and, eq, inArray } from "drizzle-orm";
import { db, withTenantTx, type Tx } from "../db/index.js";
import { documents, documentVersions } from "../db/schema/document.js";
import { chunks, indexStatus } from "../db/schema/chunk.js";
import { jobs } from "../db/schema/job.js";
import { emitChunkUpserted, emitChunkRemoved } from "./outbox.js";
import { parserFor } from "../ingestion/parser.js";
import { normalize } from "../ingestion/normalizer.js";
import { splitterFor } from "../ingestion/splitters.js";
import { hashContent, hashChunk } from "../lib/hash.js";

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
 * 文档上传的应用层入口（POST /documents 调用）。
 *
 * 链路：解析文件 → 归一化文本 → 计算内容哈希 → 单事务内写入
 *       documents / document_versions / jobs 三张表。
 *
 * 只做"受理"不做事后索引：真正的分块与派生索引由 Worker 消费
 * 队列中的 index_document Job 异步完成。返回 jobId 供调用方入队，
 * 从而让 Queue（基础设施）与 Application（业务）解耦。
 */
export async function ingestDocument(
  tenantId: string,
  input: IngestInput,
): Promise<IngestResult> {
  // 1. 按文件类型（扩展名/MIME）选择解析器，提取纯文本、标题、元数据
  const parsed = await parserFor(input.fileName, input.mimeType).parse({
    fileName: input.fileName,
    mimeType: input.mimeType,
    content: input.content,
  });

  // 2. 归一化文本（去空白/统一换行等），保证哈希稳定，避免同一内容重复入库
  const text = normalize(parsed.text);

  // 3. 基于归一化文本计算内容哈希，作为版本去重/幂等的依据
  const contentHash = hashContent(text);

  // 4. 事务内落库：Document、DocumentVersion、Job 任一失败则整体回滚，
  //    保证三者状态一致（不存在"有文档没 Job"的孤儿状态）
  return withTenantTx(tenantId, async (tx) => {
    // 4.1 建 Document（sourceType=file，sourceUri=原始文件名），初始 pending
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

    // 4.2 建首个 DocumentVersion（version=1），rawContent 暂存 PostgreSQL
    //     （后续 Phase 迁移到 S3/MinIO 时改为存对象存储路径），状态 pending
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

    // 4.3 建 index_document Job（pending），payload 指向待索引的版本。
    //     与 documents.ts 中 enqueueJob 共用一个 jobId：先落库保证可追溯/可重试，
    //     再投递到队列，避免"队列已发但库中无记录"导致丢失
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

    // 5. 返回三者的 id，由调用方负责入队与响应
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
 * 处理 index_document / reindex_document Job（§6 Parent-Child Retrieval）。
 *
 * 这是 Worker 消费索引任务时调用的核心函数，在单事务内完成：
 *   分块（parent/child 两级）→ 清理过期 chunk → 幂等落库 → 写 Outbox 事件 → 标记 ready。
 *
 * 幂等性保证：chunk 主键由 (documentVersionId, contentHash) 稳定哈希推导（insertChunkIfAbsent
 * 用 onConflictDoNothing 去重），同一版本重复处理只会得到同一批 chunk，可安全重跑（§5.3 稳定 ID）。
 */
export async function processVersion(
  versionId: string,
  tenantId: string,
): Promise<void> {
  await withTenantTx(tenantId, async (tx) => {
    // 1. 加载版本（带 tenantId 校验），不存在直接跳过（可能已被删除）
    const version = await loadVersion(tx, versionId, tenantId);
    if (!version) return;

    // 2. 取归一化文本与标题，作为分块与 metadata 的输入
    const text = normalize(version.rawContent ?? "");
    const title =
      typeof version.metadata.title === "string" ? version.metadata.title : "";

    // 3. 按文档类型（metadata.language）选切分器：
    //    markdown → 标题感知切分（结构语义锚点）；text/pdf/docx 等 → 句子级切分。
    //    所有切分器统一返回 parent/child 两级结构，后续哈希/落库逻辑不变。
    const language =
      typeof version.metadata.language === "string"
        ? version.metadata.language
        : undefined;
    const splitter = splitterFor(language);

    // 4. 分块并预计算稳定 contentHash：
    //    parent 保留整段上下文（不落检索索引），child 是检索单元（落向量/关键词）；
    //    hash 中带 kind 区分 parent/child，避免内容相同的两级 chunk 哈希碰撞
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

    // 4. 清理过期 chunk：
    //    先算出"期望存在的全部哈希集合"，再与库中现有记录对比，
    //    删除不再需要的（先清 index_status 再删 chunk，避免外键/唯一索引冲突）。
    //    先清后插的顺序保证 chunkIndex 在版本内唯一且连续
    const desiredHashes = new Set<string>();
    for (const p of plans) {
      desiredHashes.add(p.parentHash);
      for (const c of p.children) desiredHashes.add(c.hash);
    }

    // 查出该版本当前已落库的 chunk（只需 id + contentHash），
    // 与"期望哈希集合"比对即可找出过期 chunk（内容已变/已删的旧切片）
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

    // 5. 幂等落库：parent 先于 child 插入，拿到 parentId 回填到 child；
    //    chunkIndex 全局递增，保证同一版本内 chunk 顺序唯一（依赖步骤 4 的先清后插）
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

    // 6. 为当前版本所有 chunk 投递 chunk.upserted 事件到 Outbox：
    //    派生索引（向量/关键词/图）由 Reconciliation 消费 Outbox 后异步写入；
    //    IndexWriter 本身幂等，且仅 child 落检索索引（parent 只作上下文）
    const all = await tx
      .select({ id: chunks.id })
      .from(chunks)
      .where(eq(chunks.documentVersionId, versionId));
    for (const c of all) await emitChunkUpserted(tx, tenantId, c.id);

    // 7. 标记完成：version 与 document 状态置为 ready，
    //    document 记录 currentVersionId 指向当前生效版本
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