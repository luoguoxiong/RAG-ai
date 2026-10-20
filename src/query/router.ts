import { config } from "../config.js";
import { createLLMProvider, type LLMProvider } from "../ai/llm.js";
import {
  RuleQueryAnalyzer,
  extractJsonObject,
  isLowConfidence,
  normalizeLlmAnalysis,
  type QueryAnalysis,
  type RetrievalSource,
} from "./analyzer.js";

/**
 * Query Router（§15，Phase 5 Query Intelligence）：
 * Rule Router 高置信 → 直连；低置信（unknown）→ 一次 LLM 同时产出 analysis + plan。
 * 原实现是 Analyzer 与 Router 两次串行 LLM（最坏 2 次往返），
 * 合并后低置信路径也只付一次 LLM 调用（cheap-first，§23.2）。
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

/**
 * 一次 LLM 同时产出分析 + 路由（§13-15 低置信升级路径，§23.2）。
 * 任一部分解析失败 / LLM 异常 → 返回 null，由调用方整体回退规则结果，
 * 不再像旧实现那样「Analyzer 失败后再试 Router」多付一次串行往返。
 */
async function llmAnalyzeAndRoute(
  llm: LLMProvider,
  query: string,
  ruleAnalysis: QueryAnalysis,
  topK: number,
): Promise<{ analysis: QueryAnalysis; plan: RetrievalPlan } | null> {
  const prompt = [
    "你是检索规划器。先分析问题，再决定使用哪些检索来源与策略。",
    "只输出 JSON，不要输出其它文字：",
    '{"analysis":{"intent":"fact|relationship|multi_hop|aggregation|comparison|code|unknown",',
    '"entities":["实体名"],"complexity":"simple|medium|complex",',
    '"needsRewrite":false,"needsMultiQuery":false,"needsHyDE":false,',
    '"suggestedSources":["vector","keyword","graph"]},',
    '"plan":{"sources":["vector","keyword","graph"],"parallel":true,"useReranker":true}}',
    "规则：事实/语义问题用 vector+keyword；涉及实体关系或多跳用 graph；聚合统计用 sql。",
    "",
    `问题：${query}`,
    `规则分析：${JSON.stringify(ruleAnalysis)}`,
  ].join("\n");
  try {
    const reply = await llm.chat(
      [{ role: "user", content: prompt }],
      { temperature: 0 },
    );
    const raw = extractJsonObject(reply.content);
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const analysis = normalizeLlmAnalysis(o.analysis);
    const plan = normalizeLlmPlan(o.plan, topK);
    if (!analysis && !plan) return null;
    return {
      analysis: analysis ?? ruleAnalysis,
      plan: plan ?? buildPlan(analysis ?? ruleAnalysis, topK, "llm"),
    };
  } catch {
    // LLM 不可用或解析失败 → 回退规则
    return null;
  }
}

/**
 * 分析 + 路由入口（§13-15）：
 * 规则高置信 → 直连规则路由，零 LLM；
 * 低置信且有 API key → 一次 LLM 调用同时产出 analysis + plan（省一次串行往返）；
 * LLM 失败/解析非法 → 规则分析与规则路由兜底。
 */
export async function analyzeAndPlan(
  query: string,
  topK?: number,
): Promise<{ analysis: QueryAnalysis; plan: RetrievalPlan }> {
  const k = topK ?? config.defaultTopK;
  const ruleAnalyzer = new RuleQueryAnalyzer();
  const analysis = await ruleAnalyzer.analyze(query);
  const rulePlan = buildPlan(analysis, k, "rule");
  if (!(config.openai.apiKey && isLowConfidence(analysis))) {
    return { analysis, plan: rulePlan };
  }
  const merged = await llmAnalyzeAndRoute(
    createLLMProvider(),
    query,
    analysis,
    k,
  );
  if (!merged) return { analysis, plan: rulePlan };
  // 规则侧派生实体可能比 LLM 更稳（确定性），做合并兜底
  if (merged.analysis.entities.length === 0 && analysis.entities.length > 0) {
    merged.analysis = { ...merged.analysis, entities: analysis.entities };
  }
  return merged;
}
