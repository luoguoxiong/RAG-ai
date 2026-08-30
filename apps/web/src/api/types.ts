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