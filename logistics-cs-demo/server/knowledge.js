// ============ 知识库检索：RAG 检索平台 API 客户端 + 本地词法降级 ============
//
// 知识库文档与索引托管在独立的「知识检索平台」（RAG-ai，Fastify 服务）：
//   POST /search  → Query Intelligence（意图分析/改写/多查询）→ 向量+关键词混合检索
//                   → RRF 融合 → 重排 → LLM 生成带 [n] 引用的标准答案
// 客服 Agent 侧通过 HTTP API 调用该平台完成 query_knowledge 工具：
//   - 超时控制（AbortController）与连续失败熔断，避免知识服务故障拖垮对话链路
//   - 平台不可用时自动降级为本地关键词打分检索（KNOWLEDGE_BASE），保证服务可用性
// 配置（.env）：
//   KNOWLEDGE_API_URL      检索平台地址（默认 http://127.0.0.1:3000）
//   KNOWLEDGE_TENANT_ID    租户 ID（默认平台 demo 租户）
//   KNOWLEDGE_VERSION_ID   可选，限定检索的数据集版本；缺省用平台激活版本
//   KNOWLEDGE_TIMEOUT_MS   单次检索超时（默认 15000ms，平台含 LLM 生成，耗时高于普通接口）
//   KNOWLEDGE_FALLBACK_LOCAL  平台失败时是否降级本地词法检索（默认 true）

import { KNOWLEDGE_BASE } from './data.js';

const KB_API_URL = (process.env.KNOWLEDGE_API_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const KB_TENANT_ID = process.env.KNOWLEDGE_TENANT_ID || '00000000-0000-0000-0000-000000000001';
const KB_VERSION_ID = process.env.KNOWLEDGE_VERSION_ID || '';
const KB_TIMEOUT_MS = Number(process.env.KNOWLEDGE_TIMEOUT_MS || 15000);
const KB_FALLBACK_LOCAL = process.env.KNOWLEDGE_FALLBACK_LOCAL !== 'false';

// —— 简单熔断：连续失败 >= 阈值后打开，冷却窗口内直接走本地检索，不再等待超时 ——
const BREAK_THRESHOLD = 3;
const BREAK_COOLDOWN_MS = 60_000;
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

function breakerOpen() {
  return Date.now() < breakerOpenUntil;
}
function recordFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAK_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAK_COOLDOWN_MS;
    consecutiveFailures = 0;
  }
}
function recordSuccess() {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}

/**
 * 调用知识检索平台 POST /search。
 * 返回 { answer, citations, evidenceCount, latencyMs, ... }，失败抛错由上层降级。
 */
async function searchRagPlatform(query, topK) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KB_TIMEOUT_MS);
  try {
    const resp = await fetch(`${KB_API_URL}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': KB_TENANT_ID
      },
      body: JSON.stringify({
        query,
        topK,
        ...(KB_VERSION_ID ? { versionId: KB_VERSION_ID } : {})
      }),
      signal: controller.signal
    });
    if (!resp.ok) {
      throw new Error(`knowledge api responded ${resp.status}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// —— 降级路径：本地关键词打分检索（原实现，服务兜底） ——
export function scoreKnowledge(m) {
  const scored = [];
  for (const entry of KNOWLEDGE_BASE) {
    let score = 0;
    for (const k of entry.keywords) {
      if (m.includes(k)) score += k.length >= 3 ? 3 : 2;
    }
    if (score > 0) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

function localFallback(query, topN, reason) {
  const matched = scoreKnowledge(query).slice(0, topN).map(({ entry, score }) => ({
    title: entry.title,
    content: entry.content,
    score
  }));
  return {
    source: 'local-fallback',
    degraded: true,
    degradedReason: reason,
    answer: matched.map((m, i) => `[${i + 1}] ${m.title}\n${m.content}`).join('\n\n'),
    matched,
    citations: matched.map((m, i) => ({ index: i + 1, title: m.title, score: m.score })),
    empty: matched.length === 0,
    summary: matched.length
      ? `命中 ${matched.length} 条知识（本地降级检索）`
      : '知识库未命中（本地降级检索）'
  };
}

/**
 * 工具实现：知识库检索。
 * 主路径 = 知识检索平台 API（混合检索 + 引用溯源）；
 * 平台不可用/超时/熔断时降级本地关键词检索，保证问答链路不被外部服务故障阻断。
 */
export async function searchKnowledge({ query = '', topN = 2 } = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return { source: 'none', matched: [], citations: [], empty: true, summary: '知识库未命中（空查询）' };
  }

  if (breakerOpen()) {
    return localFallback(q, topN, 'circuit-breaker-open');
  }

  try {
    const r = await searchRagPlatform(q, topN);
    recordSuccess();
    const citations = (Array.isArray(r.citations) ? r.citations : []).map((c) => ({
      index: c.index,
      title: c.title,
      score: c.score,
      chunkId: c.chunkId || null,
      documentId: c.documentId || null
    }));
    return {
      source: 'rag-platform',
      degraded: false,
      // answer 为平台生成的带 [n] 引用标准答案，可直接作为回复依据
      answer: typeof r.answer === 'string' ? r.answer : '',
      // matched/citations 供 LLM 与排查日志溯源（保留引用编号与评分）
      matched: citations.map((c) => ({ title: c.title, score: c.score })),
      citations,
      empty: citations.length === 0,
      summary: citations.length
        ? `命中 ${citations.length} 条知识（RAG 检索平台）`
        : '知识库未命中（RAG 检索平台）',
      latencyMs: typeof r.latencyMs === 'number' ? r.latencyMs : null
    };
  } catch (err) {
    recordFailure();
    const reason = err && err.name === 'AbortError' ? `timeout>${KB_TIMEOUT_MS}ms` : String(err?.message || err);
    console.warn(`[knowledge] rag platform unavailable, fallback to local: ${reason}`);
    return KB_FALLBACK_LOCAL
      ? localFallback(q, topN, reason)
      : { source: 'rag-platform', answer: '', matched: [], citations: [], empty: true, summary: '知识服务暂不可用，请稍后再试' };
  }
}
