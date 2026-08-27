/**
 * Domain 类型：与架构文档 §5 对齐，独立于持久层。
 * 所有集合均带 tenantId，遵守 §24 多租户约定。
 */

export type DocumentStatus =
  | "pending"
  | "processing"
  | "ready"
  | "failed"
  | "deleted";

export type VersionStatus = "pending" | "processing" | "ready" | "failed";

export interface Document {
  id: string;
  tenantId: string;
  sourceType: "file" | "url" | "database" | "api";
  sourceUri: string;
  title?: string;
  status: DocumentStatus;
  currentVersionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentVersion {
  id: string;
  tenantId: string;
  documentId: string;
  version: number;
  contentHash: string;
  rawContent?: string;
  metadata: Record<string, unknown>;
  status: VersionStatus;
  createdAt: Date;
}

export interface Chunk {
  id: string;
  tenantId: string;
  documentId: string;
  documentVersionId: string;
  parentId?: string;
  type: "parent" | "child";
  content: string;
  contentHash: string;
  chunkIndex: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export type IndexState = "pending" | "processing" | "ready" | "failed";

export interface IndexStatus {
  chunkId: string;
  tenantId: string;
  vector: IndexState;
  keyword: IndexState;
  graph: IndexState;
  embeddingModel?: string;
  embeddingVersion?: string;
  updatedAt: Date;
}

export interface Tenant {
  id: string;
  name: string;
  plan: "free" | "pro" | "enterprise";
  limits: {
    maxDocuments: number;
    maxChunks: number;
    maxEmbeddingsPerDay: number;
    maxQueriesPerMinute: number;
  };
  status: "active" | "suspended" | "deleted";
  createdAt: Date;
  updatedAt: Date;
}

export type JobType =
  | "index_document"
  | "reindex_document"
  | "delete_document"
  | "embedding_upgrade"
  | "chunk_strategy_upgrade"
  | "reconciliation";

export type JobStatus = "pending" | "processing" | "ready" | "failed";

export interface Job {
  id: string;
  tenantId: string;
  type: JobType;
  status: JobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}