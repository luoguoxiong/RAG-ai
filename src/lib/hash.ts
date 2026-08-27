import { createHash } from "node:crypto";

/** 内容哈希：稳定 ID / 增量 diff 判据（§5.3） */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export interface ChunkHashInput {
  documentVersionId: string;
  normalizedContent: string;
  /** 区分 parent / child，避免两者内容相同时 hash 碰撞 */
  kind?: string;
}

/** chunk 稳定依据 = hash(documentVersionId + kind + normalizedContent) */
export function hashChunk(input: ChunkHashInput): string {
  return sha256(
    `${input.documentVersionId}\n${input.kind ?? "chunk"}\n${input.normalizedContent}`,
  );
}

/** 文档版本内容哈希 */
export function hashContent(content: string): string {
  return sha256(content);
}