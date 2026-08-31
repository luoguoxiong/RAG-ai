import { createLLMProvider, type ChatMessage } from "../ai/llm.js";
import { config } from "../config.js";
import { retrieveEvidence, type Evidence } from "../retrieval/retriever.js";
import {
  runQueryIntelligence,
  type QueryIntelligenceResult,
} from "../query/index.js";
import { evaluateRetrieval, type RetrievalMetrics } from "../evaluation/metrics.js";
import {
  getCachedSearch,
  setCachedSearch,
} from "../cache/search.js";

export interface Citation {
  /** 引用编号，从 1 开始，与回答正文中的 [n] 一一对应 */
  index: number;
  /** 文档标题（无标题时为空串） */
  title: string;
  /** 命中的文档 ID */
  documentId: string;
  /** 命中的 chunk ID */
  chunkId: string;
  /** 证据最终得分：重排后为重排分，未重排时为融合分 */
  score: number;
}

export interface SearchResult {
  /** 原始查询文本 */
  query: string;
  /** LLM 生成的回答（含 [n] 引用标记） */
  answer: string;
  /** 引用来源列表，与回答中的 [n] 对应 */
  citations: Citation[];
  /** 送入 LLM 的证据条数 */
  evidenceCount: number;
  /** Phase 5 Query Intelligence：分析 / 路由 / 实际检索文本（可观测性，§23） */
  analysis?: QueryIntelligenceResult["analysis"];
  plan?: QueryIntelligenceResult["plan"];
  effectiveQueries?: string[];
  /** 检索阶段耗时（毫秒） */
  retrievalMs?: number;
  /** 生成阶段耗时（毫秒） */
  generationMs?: number;
  /** 总耗时（毫秒） */
  latencyMs?: number;
  /** 检索质量指标（Recall@K / Hit Rate / MRR / NDCG）：仅请求提供了 goldChunkIds 时计算 */
  retrievalMetrics?: RetrievalMetrics;
  /** 是否命中结果缓存（§23.2）：命中时 retrievalMs/generationMs 为 0 */
  cached?: boolean;
}

/** 单条证据送入 LLM 的正文长度上限（字符）：截断过长 chunk，控制生成成本与延迟 */
const MAX_EVIDENCE_CHARS = 1500;
/** 全部证据拼入上下文的总长度上限（字符）：超过后按相关度顺序丢弃尾部证据 */
const MAX_CONTEXT_CHARS = 8000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Context Builder（§20）：把 Evidence 序列化为带引用编号的提示词上下文。 */
export function buildMessages(query: string, evidence: Evidence[]): ChatMessage[] {
  const system = [
    "你是知识检索助手。仅依据下方【证据】回答用户问题。",
    "若证据不足，请明确说明「证据不足」，不要编造。",
    "回答时用 [1]、[2] 等编号引用对应证据。",
  ].join("\n");

  // 证据已按相关度排序：预算内逐条拼入，超预算的尾部证据丢弃（LLM 自然不会引用）
  const blocks: string[] = [];
  let used = 0;
  for (const e of evidence) {
    const header = `[Evidence: ev_${blocks.length + 1}]\n标题：${e.title || "（无标题）"}\n内容：`;
    const content = truncate(e.content, MAX_EVIDENCE_CHARS);
    const remaining = MAX_CONTEXT_CHARS - used;
    if (header.length + content.length > remaining) {
      if (remaining > header.length) {
        blocks.push(`${header}${truncate(content, remaining - header.length)}`);
      }
      break;
    }
    blocks.push(`${header}${content}`);
    used += header.length + content.length + 2;
  }
  const blocksText = blocks.join("\n\n");

  const user = blocks.length
    ? `【证据】\n${blocksText}\n\n【问题】\n${query}`
    : `【问题】\n${query}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** 生成回答（Eval / 回归测试复用同一套 Context→LLM 链路） */
export async function generateAnswer(
  query: string,
  evidence: Evidence[],
): Promise<string> {
  const reply = await createLLMProvider().chat(buildMessages(query, evidence), {
    // 限制输出长度：防止模型生成长文拖慢响应，回答通常不超过 1024 token
    maxTokens: 1024,
  });
  return reply.content;
}

/**
 * Query 链路（§13-15，Phase 5）：
 * Analyze → Route → Transform（Rewrite / Multi Query / HyDE）→
 * Retrieve → Evidence → Context → Generate → Citation。
 * opts.intelligence=false 可关闭 Query Intelligence，走直连混合检索。
 */
export async function answerQuery(
  tenantId: string,
  query: string,
  topK?: number,
  opts?: {
    intelligence?: boolean;
    documentIds?: string[];
    /** 可选的 ground truth（黄金 chunk ids），提供后计算 Recall@K / Hit Rate / MRR / NDCG */
    goldChunkIds?: string[];
  },
): Promise<SearchResult> {
  // 归一化 topK；是否启用 Query Intelligence = 全局开关 && 请求未显式关闭
  const k = topK ?? config.defaultTopK;
  const enabled = config.queryIntelligence.enabled && (opts?.intelligence ?? true);
  const documentIds = opts?.documentIds;
  // 带 ground truth 的评估请求不读/不写缓存，保证指标语义（缓存条目不携带指标）
  const useCache = !opts?.goldChunkIds || opts.goldChunkIds.length === 0;

  const totalStart = Date.now();

  // 缓存读：命中直接返回回答与引用，跳过检索与生成（§23.2）
  if (useCache) {
    const cached = await getCachedSearch(tenantId, query, k, enabled);
    if (cached) {
      return {
        query,
        answer: cached.answer,
        citations: cached.citations,
        evidenceCount: cached.evidenceCount,
        retrievalMs: 0,
        generationMs: 0,
        latencyMs: Date.now() - totalStart,
        cached: true,
      };
    }
  }

  let evidence: Evidence[];
  let qi: QueryIntelligenceResult | undefined;
  const retrievalStart = Date.now();
  if (enabled) {
    // 智能链路：分析 -> 路由 -> 变换 -> 检索，附带 analysis/plan 供可观测性
    qi = await runQueryIntelligence(tenantId, query, k, documentIds);
    evidence = qi.evidence;
  } else {
    // 直连链路：跳过 Query Intelligence，直接混合检索
    evidence = await retrieveEvidence(tenantId, query, k, { documentIds });
  }
  const retrievalMs = Date.now() - retrievalStart;

  // Context Builder -> LLM 生成带 [n] 引用的回答
  const generationStart = Date.now();
  const answer = await generateAnswer(query, evidence);
  const generationMs = Date.now() - generationStart;

  const latencyMs = Date.now() - totalStart;

  // 按证据顺序生成引用列表，index 与回答正文中的 [n] 一一对应
  const citations: Citation[] = evidence.map((e, i) => ({
    index: i + 1,
    title: e.title,
    documentId: e.documentId,
    chunkId: e.chunkId,
    score: e.score,
  }));

  // 检索质量指标：提供 ground truth 时才计算（复用评估系统的纯函数）
  const retrievalMetrics =
    opts?.goldChunkIds && opts.goldChunkIds.length > 0
      ? evaluateRetrieval(
          opts.goldChunkIds,
          evidence.map((e) => e.chunkId),
          k,
        )
      : undefined;

  // 缓存写：评估请求（带 goldChunkIds）不缓存
  if (useCache) {
    await setCachedSearch(tenantId, query, k, enabled, {
      answer,
      citations,
      evidenceCount: evidence.length,
    });
  }

  return {
    query,
    answer,
    citations,
    evidenceCount: evidence.length,
    // Query Intelligence 可观测字段：未启用时为 undefined
    analysis: qi?.analysis,
    plan: qi?.plan,
    effectiveQueries: qi?.effectiveQueries,
    retrievalMs,
    generationMs,
    latencyMs,
    retrievalMetrics,
  };
}