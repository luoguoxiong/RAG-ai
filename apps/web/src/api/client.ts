import type {
  CreateDatasetResponse,
  DocumentDetail,
  DocumentRow,
  EvalDataset,
  EvalRun,
  EvalRunDetail,
  EvalRunSummary,
  RetrievalLog,
  SearchResult,
  VersionRow,
} from "./types";

const TENANT_KEY = "rag.tenantId";
export const DEMO_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export function getTenantId(): string {
  return localStorage.getItem(TENANT_KEY) ?? DEMO_TENANT_ID;
}

export function setTenantId(id: string): void {
  localStorage.setItem(TENANT_KEY, id);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isForm = init?.body instanceof FormData;
  const hasBody = !!init?.body;
  const res = await fetch(path, {
    ...init,
    headers: {
      "x-tenant-id": getTenantId(),
      ...(isForm ? {} : hasBody ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  // ── 检索 ──────────────────────────────────────────────
  search(body: {
    query: string;
    topK?: number;
    intelligence?: boolean;
    versionId?: string;
    /** 可选的 ground truth（黄金 chunk ids），提供后返回并记录 Recall@K / Hit Rate / MRR / NDCG */
    goldChunkIds?: string[];
  }): Promise<SearchResult> {
    return request<SearchResult>("/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  // ── 文档 ──────────────────────────────────────────────
  listDocuments(): Promise<DocumentRow[]> {
    return request<DocumentRow[]>("/documents");
  },
  getDocument(id: string): Promise<DocumentDetail> {
    return request<DocumentDetail>(`/documents/${id}`);
  },
  deleteDocument(id: string): Promise<{ accepted: boolean; jobId: string }> {
    return request(`/documents/${id}`, { method: "DELETE" });
  },
  uploadDocument(versionId: string, file: File): Promise<unknown> {
    const form = new FormData();
    form.append("versionId", versionId);
    form.append("file", file);
    return request("/documents", { method: "POST", body: form });
  },

  // ── 版本 ──────────────────────────────────────────────
  listVersions(): Promise<VersionRow[]> {
    return request<VersionRow[]>("/versions");
  },
  createVersion(name: string): Promise<VersionRow> {
    return request<VersionRow>("/versions", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },
  activateVersion(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/versions/${id}/activate`, {
      method: "POST",
    });
  },

  // ── 评估 ──────────────────────────────────────────────
  listEvalDatasets(): Promise<EvalDataset[]> {
    return request<EvalDataset[]>("/eval/datasets");
  },
  createEvalDataset(body: {
    name: string;
    description?: string;
    indexVersion?: string;
    embeddingVersion?: string;
    queries: {
      query: string;
      goldChunkIds?: string[];
      referenceAnswer?: string;
      keyFacts?: string[];
    }[];
  }): Promise<CreateDatasetResponse> {
    return request<CreateDatasetResponse>("/eval/datasets", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  listEvalRuns(): Promise<EvalRun[]> {
    return request<EvalRun[]>("/eval/runs");
  },
  runEvaluation(body: {
    datasetId: string;
    topK?: number;
  }): Promise<EvalRunSummary> {
    return request<EvalRunSummary>("/eval/runs", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  getEvalRunDetail(id: string): Promise<EvalRunDetail> {
    return request<EvalRunDetail>(`/eval/runs/${id}`);
  },
  async getEvalReport(id: string): Promise<string> {
    const res = await fetch(`/eval/runs/${id}/report`, {
      headers: { "x-tenant-id": getTenantId() },
    });
    if (!res.ok) {
      throw new ApiError(res.status, await res.text().catch(() => ""));
    }
    return res.text();
  },

  // ── 检索历史 ──────────────────────────────────────────
  listRetrievalLogs(): Promise<RetrievalLog[]> {
    return request<RetrievalLog[]>("/search/logs");
  },
};