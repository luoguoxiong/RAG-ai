export interface Citation {
  index: number;
  title: string;
  documentId: string;
  chunkId: string;
  score: number;
}

export interface SearchResult {
  query: string;
  answer: string;
  citations: Citation[];
  evidenceCount: number;
  analysis?: unknown;
  plan?: unknown;
  effectiveQueries?: string[];
}

export interface DocumentRow {
  id: string;
  tenantId: string;
  versionId: string;
  sourceType: string;
  sourceUri: string;
  title: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobRow {
  id: string;
  type: string;
  status: string;
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentDetail {
  document: DocumentRow;
  jobs: JobRow[];
}

export interface VersionRow {
  id: string;
  name: string;
  version: number;
  status: string;
  createdAt: string;
  documentCount: number;
}

// ── 评估 ──────────────────────────────────────────────

export interface EvalMetrics {
  recallAtK: number;
  hitRate: number;
  mrr: number;
  ndcg: number;
  contextPrecision: number;
  contextRecall: number;
  faithfulness: number;
  answerRelevance: number;
}

export interface EvalDataset {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  indexVersion: string;
  embeddingVersion: string;
  createdAt: string;
}

export interface EvalQuery {
  id: string;
  datasetId: string;
  query: string;
  goldChunkIds: string[];
  referenceAnswer: string | null;
  keyFacts: string[];
}

export interface EvalRun {
  id: string;
  datasetId: string;
  indexVersion: string;
  embeddingVersion: string;
  embeddingModel: string | null;
  topK: number;
  llmModel: string | null;
  reranker: string | null;
  status: string;
  error: string | null;
  metrics: Partial<EvalMetrics>;
  report: string | null;
  baselineRunId: string | null;
  regressedMetrics: string[];
  gatePassed: boolean | null;
  createdAt: string;
}

export interface EvalRunResult {
  id: string;
  runId: string;
  queryId: string;
  query: string;
  goldChunkIds: string[];
  retrievedChunkIds: string[];
  metrics: Partial<EvalMetrics>;
  answer: string | null;
  createdAt: string;
}

export interface EvalRunDetail {
  run: EvalRun;
  results: EvalRunResult[];
}

export interface EvalRunSummary {
  runId: string;
  datasetId: string;
  status: "ready" | "failed";
  metrics: EvalMetrics;
  baselineRunId: string | null;
  regressedMetrics: string[];
  gatePassed: boolean;
  report: string;
}

export interface CreateDatasetResponse {
  dataset: EvalDataset;
  queries: EvalQuery[];
}

// ── 检索历史 ──────────────────────────────────────────

export interface RetrievalLog {
  id: string;
  tenantId: string;
  query: string;
  topK: number;
  intelligence: boolean;
  evidenceCount: number;
  citationCount: number;
  topScore: number | null;
  effectiveQueries: string[];
  chunkIds: string[];
  retrievalMs: number | null;
  generationMs: number | null;
  latencyMs: number | null;
  answer: string | null;
  createdAt: string;
}