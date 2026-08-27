import { config } from "../config.js";
import { createLLMProvider, type LLMProvider } from "../ai/llm.js";
import {
  extractJsonObject,
  isLowConfidence,
  type QueryAnalysis,
  type RetrievalSource,
} from "./analyzer.js";

/**
 * Query Router（§15，Phase 5 Query Intelligence）：
 * Rule Router 高置信 → 直连；低置信（unknown）→ LLM Router。
 * 不要所有请求都调用 LLM Router（cheap-first，§23.2）。
 */

export interface RetrievalPlan {
  sources: RetrievalSource[];
  parallel: boolean;
  topK: number;
  useReranker: boolean;
  /** 每个 Retriever 独立超时（毫秒，§23.1） */
  timeout: number;
  /** 路由决策来源 */
  routeBy: "rule" | "llm";
}

export interface QueryRouter {
  route(
    query: string,
    analysis: QueryAnalysis,
    topK?: number,
  ): Promise<RetrievalPlan>;
}

function buildPlan(
  analysis: QueryAnalysis,
  topK: number,
  routeBy: RetrievalPlan["routeBy"],
): RetrievalPlan {
  const sources: RetrievalSource[] =
    analysis.suggestedSources.length > 0
      ? analysis.suggestedSources
      : ["vector", "keyword"];
  return {
    sources,
    parallel: sources.length > 1,
    topK,
    useReranker: true,
    timeout: config.retrieverTimeoutMs,
    routeBy,
  };
}

/** Rule Router：高置信直接路由，不调用 LLM */
export class RuleRouter implements QueryRouter {
  async route(
    query: string,
    analysis: QueryAnalysis,
    topK?: number,
  ): Promise<RetrievalPlan> {
    return buildPlan(analysis, topK ?? config.defaultTopK, "rule");
  }
}

function normalizeLlmPlan(raw: unknown, topK: number): RetrievalPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.sources) || o.sources.length === 0) return null;
  const valid: RetrievalSource[] = ["vector", "keyword", "graph", "sql"];
  const sources = o.sources.filter(
    (s): s is RetrievalSource => typeof s === "string" && valid.includes(s as RetrievalSource),
  );
  if (sources.length === 0) return null;
  return {
    sources,
    parallel: o.parallel !== false,
    topK,
    useReranker: o.useReranker !== false,
    timeout: config.retrieverTimeoutMs,
    routeBy: "llm",
  };
}

/** LLM Router：只处理 Rule Router 无法高置信判定的查询，失败回退到规则 */
export class LLMRouter implements QueryRouter {
  constructor(
    private readonly llm: LLMProvider,
    private readonly fallback: QueryRouter,
  ) {}

  async route(
    query: string,
    analysis: QueryAnalysis,
    topK?: number,
  ): Promise<RetrievalPlan> {
    const k = topK ?? config.defaultTopK;
    const prompt = [
      "你是检索路由。根据问题的含义决定使用哪些检索来源与策略。",
      "只输出 JSON，不要输出其它文字：",
      '{"sources":["vector","keyword","graph"],"parallel":true,"useReranker":true}',
      "规则：事实/语义问题用 vector+keyword；涉及实体关系或多跳用 graph；聚合统计用 sql。",
      "",
      `问题：${query}`,
      `规则分析：${JSON.stringify(analysis)}`,
    ].join("\n");
    try {
      const reply = await this.llm.chat(
        [{ role: "user", content: prompt }],
        { temperature: 0 },
      );
      const plan = normalizeLlmPlan(extractJsonObject(reply.content), k);
      if (plan) return plan;
    } catch {
      // LLM 不可用或解析失败 → 回退
    }
    return this.fallback.route(query, analysis, k);
  }
}

/** Router 入口：Rule Router 高置信直连，低置信且有 API key 时走 LLM Router */
export async function routeQuery(
  query: string,
  analysis: QueryAnalysis,
  topK?: number,
): Promise<RetrievalPlan> {
  if (config.openai.apiKey && isLowConfidence(analysis)) {
    return new LLMRouter(createLLMProvider(), new RuleRouter()).route(
      query,
      analysis,
      topK,
    );
  }
  return new RuleRouter().route(query, analysis, topK);
}
