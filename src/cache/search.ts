import { createHash } from "node:crypto";
import { config } from "../config.js";
import { redis } from "../queue/index.js";

/**
 * 搜索结果缓存（§23.2）：以 (tenantId, topK, intelligence, query) 哈希为键，
 * 缓存 LLM 生成的回答与引用。Redis 不可用 / 解析失败时静默降级为未命中，
 * 不阻塞主链路（容错约定 §23.1）。
 */

/** 缓存条目：与 SearchResult 中可复用的字段对齐（不含性能耗时字段） */
export interface SearchCacheEntry {
  answer: string;
  citations: {
    index: number;
    title: string;
    documentId: string;
    chunkId: string;
    score: number;
  }[];
  evidenceCount: number;
}

function cacheKey(
  tenantId: string,
  query: string,
  topK: number,
  intelligence: boolean,
  documentIds?: string[],
): string {
  // 文档范围（版本展开的 documentIds）必须进键：同一 query 在不同版本下答案不同，
  // 缺失会导致切换激活版本后命中旧版本的缓存答案（正确性 bug）。
  // 排序后拼接保证键与传入顺序无关。
  const scope = documentIds ? [...documentIds].sort().join(",") : "";
  const raw = `${tenantId}\n${topK}\n${intelligence}\n${scope}\n${query}`;
  return `search:${createHash("sha256").update(raw).digest("hex")}`;
}

export async function getCachedSearch(
  tenantId: string,
  query: string,
  topK: number,
  intelligence: boolean,
  documentIds?: string[],
): Promise<SearchCacheEntry | null> {
  if (config.searchCacheTtlSeconds <= 0) return null;
  try {
    const raw = await redis.get(
      cacheKey(tenantId, query, topK, intelligence, documentIds),
    );
    if (!raw) return null;
    return JSON.parse(raw) as SearchCacheEntry;
  } catch {
    return null;
  }
}

export async function setCachedSearch(
  tenantId: string,
  query: string,
  topK: number,
  intelligence: boolean,
  entry: SearchCacheEntry,
  documentIds?: string[],
): Promise<void> {
  if (config.searchCacheTtlSeconds <= 0) return;
  try {
    await redis.set(
      cacheKey(tenantId, query, topK, intelligence, documentIds),
      JSON.stringify(entry),
      "EX",
      config.searchCacheTtlSeconds,
    );
  } catch {
    // 缓存写失败不影响主链路
  }
}
