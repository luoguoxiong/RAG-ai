import { createLLMProvider, type ChatMessage } from "../ai/llm.js";
import { config } from "../config.js";
import { retrieveEvidence, type Evidence } from "../retrieval/retriever.js";

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
}

/** Context Builder（§20）：把 Evidence 序列化为带引用编号的提示词上下文。 */
function buildMessages(query: string, evidence: Evidence[]): ChatMessage[] {
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

/**
 * Query 链路（§17 Query Pipeline）：
 * Retrieve → Evidence → Context → Generate → Citation。
 */
export async function answerQuery(
  tenantId: string,
  query: string,
  topK?: number,
): Promise<SearchResult> {
  const k = topK ?? config.defaultTopK;
  const evidence = await retrieveEvidence(tenantId, query, k);
  const reply = await createLLMProvider().chat(buildMessages(query, evidence));

  const citations: Citation[] = evidence.map((e, i) => ({
    index: i + 1,
    title: e.title,
    documentId: e.documentId,
    chunkId: e.chunkId,
    score: e.score,
  }));

  return {
    query,
    answer: reply.content,
    citations,
    evidenceCount: evidence.length,
  };
}