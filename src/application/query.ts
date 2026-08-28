import { createLLMProvider, type ChatMessage } from "../ai/llm.js";
import { config } from "../config.js";
import { retrieveEvidence, type Evidence } from "../retrieval/retriever.js";
import {
  runQueryIntelligence,
  type QueryIntelligenceResult,
} from "../query/index.js";

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
  /** Phase 5 Query Intelligence：分析 / 路由 / 实际检索文本（可观测性，§23） */
  analysis?: QueryIntelligenceResult["analysis"];
  plan?: QueryIntelligenceResult["plan"];
  effectiveQueries?: string[];
}

/** Context Builder（§20）：把 Evidence 序列化为带引用编号的提示词上下文。 */
export function buildMessages(query: string, evidence: Evidence[]): ChatMessage[] {
  const system = [
    "你是知识检索助手。仅依据下方【证据】回答用户问题。",
    "若证据不足，请明确说明「证据不足」，不要编造。",
    "回答时用 [1]、[2] 等编号引用对应证据。",
  ].join("\n");

  const blocks = evidence
    .map(
      (e, i) =>
        `[Evidence: ev_${i + 1}]\n标题：${e.title || "（无标题）"}\n内容：${e.content}`,
    )
    .join("\n\n");

  const user = evidence.length
    ? `【证据】\n${blocks}\n\n【问题】\n${query}`
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
  const reply = await createLLMProvider().chat(buildMessages(query, evidence));
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
  opts?: { intelligence?: boolean; documentIds?: string[] },
): Promise<SearchResult> {
  const k = topK ?? config.defaultTopK;
  const enabled = config.queryIntelligence.enabled && (opts?.intelligence ?? true);
  const documentIds = opts?.documentIds;

  let evidence: Evidence[];
  let qi: QueryIntelligenceResult | undefined;
  if (enabled) {
    qi = await runQueryIntelligence(tenantId, query, k, documentIds);
    evidence = qi.evidence;
  } else {
    evidence = await retrieveEvidence(tenantId, query, k, { documentIds });
  }

  const answer = await generateAnswer(query, evidence);

  const citations: Citation[] = evidence.map((e, i) => ({
    index: i + 1,
    title: e.title,
    documentId: e.documentId,
    chunkId: e.chunkId,
    score: e.score,
  }));

  return {
    query,
    answer,
    citations,
    evidenceCount: evidence.length,
    analysis: qi?.analysis,
    plan: qi?.plan,
    effectiveQueries: qi?.effectiveQueries,
  };
}