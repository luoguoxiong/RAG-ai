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
): string {
  const raw = `${tenantId}\n${topK}\n${intelligence}\n${query}`;
  return `search:${createHash("sha256").update(raw).digest("hex")}`;
}

export async function getCachedSearch(
  tenantId: string,
  query: string,
  topK: number,
  intelligence: boolean,
): Promise<SearchCacheEntry | null> {
  if (config.searchCacheTtlSeconds <= 0) return null;
  try {
    const raw = await redis.get(cacheKey(tenantId, query, topK, intelligence));
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
): Promise<void> {
  if (config.searchCacheTtlSeconds <= 0) return;
  try {
    await redis.set(
      cacheKey(tenantId, query, topK, intelligence),
      JSON.stringify(entry),
      "EX",
      config.searchCacheTtlSeconds,
    );
  } catch {
    // 缓存写失败不影响主链路
  }
}
