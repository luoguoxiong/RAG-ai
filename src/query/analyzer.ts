import { config } from "../config.js";
import { createLLMProvider, type LLMProvider } from "../ai/llm.js";
import { DeterministicEntityExtractor } from "../ingestion/graph/extractor.js";

/**
 * Query Analyzer（§13，Phase 5 Query Intelligence）：
 * 把原始查询解析为结构化的 QueryAnalysis，驱动 Router 与变换选择。
 * 默认走确定性规则（cheap-first，§23.2）；仅当规则置信度低时才升级到 LLM。
 */

/** 检索来源（§15） */
export type RetrievalSource = "vector" | "keyword" | "graph" | "sql";

/** 查询意图（§13）：决定检索来源与变换选择 */
export type QueryIntent =
  | "fact" // 事实型：单点事实问答（什么是/如何）
  | "relationship" // 关系型：实体间关系（…与…的关系，走图）
  | "multi_hop" // 多跳：原因/影响等推理链
  | "aggregation" // 聚合统计：多少/列表/总数
  | "comparison" // 对比：区别/优劣/vs
  | "code" // 代码 / 接口 / 算法相关
  | "unknown"; // 无法判定：升级到 LLM 分析 / LLM Router

/** 查询复杂度：与变换选择、topK 相关 */
export type QueryComplexity = "simple" | "medium" | "complex";

export interface QueryAnalysis {
  intent: QueryIntent;
  entities: string[];
  complexity: QueryComplexity;
  needsRewrite: boolean;
  needsMultiQuery: boolean;
  needsHyDE: boolean;
  suggestedSources: RetrievalSource[];
}

// ---- 确定性规则 ----

const INTENT_RULES: Array<[QueryIntent, RegExp]> = [
  ["relationship", /(的关系|关系|关联|合作|共同|between)/i],
  ["comparison", /(对比|区别|比较|差异|哪个|孰优|优于|vs\.?)/i],
  ["aggregation", /(多少|几个|数量|统计|总数|全部|所有|哪些|清单|列表|汇总|count)/i],
  ["multi_hop", /(为什么|为何|如何导致|导致|原因|影响|后果|怎样影响|how does|why)/i],
  ["code", /(代码|函数|api|接口|实现|算法|bug|code|function)/i],
  ["fact", /^(什么是|是什么|怎么|如何|怎样|what is|how to|how do)/i],
];

export function detectIntent(query: string): QueryIntent {
  const q = query.trim();
  for (const [intent, re] of INTENT_RULES) {
    if (re.test(q)) return intent;
  }
  // 疑问句但没有强信号 → 默认事实型；否则 unknown（交给 LLM Router）
  return /[?？]$/.test(q) ? "fact" : "unknown";
}

export function detectComplexity(query: string): QueryComplexity {
  const len = query.length;
  const clauses = query.split(/[，,。;；？?]/).filter((s) => s.trim().length > 0).length;
  if (len <= 20 && clauses <= 1) return "simple";
  if (len >= 60 || clauses >= 3) return "complex";
  return "medium";
}

// \b 词边界对汉字无效，中文指示词直接枚举
const REWRITE_HINTS = /(它|他|她|这个|那个|这些|那些|这|那|相关|之类|上述|上面|那边)/;
const BROAD_HINTS = /(所有关于|全部|任何|everything|anything)/i;
const CONCEPT_HINTS = /(概念|原理|机制|本质|意义|理解|影响)/;

/** 问句 / 停用词：排除抽取出的伪实体（如"列表里有哪些公司"整句） */
const ENTITY_STOPWORDS =
  /(哪些|什么|怎么|如何|为什么|怎样|是否|哪个|这个|那个|关于|所有|全部|多少|几[个种])/;

function cleanEntities(names: string[]): string[] {
  return [...new Set(names)]
    .filter((n) => n.length >= 2 && n.length <= 16)
    .filter((n) => !ENTITY_STOPWORDS.test(n))
    .slice(0, 5);
}

/** 变换判定（§14）：Rewrite > Multi Query > HyDE > Direct，互斥。 */
export function decideTransforms(
  query: string,
  intent: QueryIntent,
  complexity: QueryComplexity,
  entities: string[],
): Pick<QueryAnalysis, "needsRewrite" | "needsMultiQuery" | "needsHyDE"> {
  const q = query.trim();
  // Ambiguous → Rewrite
  const needsRewrite =
    REWRITE_HINTS.test(q) || (q.length <= 6 && q.includes("的"));
  // Broad → Multi Query
  const needsMultiQuery =
    !needsRewrite &&
    (BROAD_HINTS.test(q) ||
      (q.length <= 8 && entities.length === 0 && complexity === "simple"));
  // Conceptual → HyDE
  const needsHyDE =
    !needsRewrite && !needsMultiQuery && (intent === "multi_hop" || CONCEPT_HINTS.test(q));
  return { needsRewrite, needsMultiQuery, needsHyDE };
}

export function suggestSources(
  intent: QueryIntent,
  entities: string[],
): RetrievalSource[] {
  const sources: RetrievalSource[] = ["vector", "keyword"];
  if (entities.length > 0 || intent === "relationship" || intent === "multi_hop") {
    sources.push("graph");
  }
  return sources;
}

// ---- JSON 解析工具（LLM 输出校验，非法则回退） ----

export function extractJsonObject(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

const INTENTS: QueryIntent[] = [
  "fact",
  "relationship",
  "multi_hop",
  "aggregation",
  "comparison",
  "code",
  "unknown",
];
const COMPLEXITIES: QueryComplexity[] = ["simple", "medium", "complex"];
const SOURCES: RetrievalSource[] = ["vector", "keyword", "graph", "sql"];

function normalizeLlmAnalysis(raw: unknown): QueryAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.intent !== "string") return null;
  const entities = Array.isArray(o.entities)
    ? o.entities.filter((e): e is string => typeof e === "string").slice(0, 10)
    : [];
  const suggestedSources = Array.isArray(o.suggestedSources)
    ? o.suggestedSources.filter(
        (s): s is RetrievalSource => typeof s === "string" && SOURCES.includes(s as RetrievalSource),
      )
    : [];
  return {
    intent: INTENTS.includes(o.intent as QueryIntent)
      ? (o.intent as QueryIntent)
      : "unknown",
    entities,
    complexity: COMPLEXITIES.includes(o.complexity as QueryComplexity)
      ? (o.complexity as QueryComplexity)
      : "medium",
    needsRewrite: o.needsRewrite === true,
    needsMultiQuery: o.needsMultiQuery === true,
    needsHyDE: o.needsHyDE === true,
    suggestedSources: suggestedSources.length
      ? suggestedSources
      : ["vector", "keyword"],
  };
}

// ---- Analyzer 实现 ----

export interface QueryAnalyzer {
  analyze(query: string): Promise<QueryAnalysis>;
}

/** 规则分析器：零依赖、可离线跑通（cheap-first 默认） */
export class RuleQueryAnalyzer implements QueryAnalyzer {
  async analyze(query: string): Promise<QueryAnalysis> {
    const intent = detectIntent(query);
    const complexity = detectComplexity(query);
    const extracted = await new DeterministicEntityExtractor().extract(query);
    const entities = cleanEntities(extracted.entities.map((e) => e.name));
    const { needsRewrite, needsMultiQuery, needsHyDE } = decideTransforms(
      query,
      intent,
      complexity,
      entities,
    );
    return {
      intent,
      entities,
      complexity,
      needsRewrite,
      needsMultiQuery,
      needsHyDE,
      suggestedSources: suggestSources(intent, entities),
    };
  }
}

/** LLM 分析器：低置信度时的升级路径，失败回退到规则结果 */
export class LLMQueryAnalyzer implements QueryAnalyzer {
  constructor(
    private readonly llm: LLMProvider,
    private readonly fallback: QueryAnalyzer,
  ) {}

  async analyze(query: string): Promise<QueryAnalysis> {
    const prompt = [
      "你是查询分析器。分析下面检索问题的意图、实体、复杂度与是否需要变换。",
      "只输出 JSON，不要输出其它文字：",
      '{"intent":"fact|relationship|multi_hop|aggregation|comparison|code|unknown",',
      '"entities":["实体名"],"complexity":"simple|medium|complex",',
      '"needsRewrite":false,"needsMultiQuery":false,"needsHyDE":false,',
      '"suggestedSources":["vector","keyword","graph"]}',
      "",
      `问题：${query}`,
    ].join("\n");
    try {
      const reply = await this.llm.chat(
        [{ role: "user", content: prompt }],
        { temperature: 0 },
      );
      const parsed = normalizeLlmAnalysis(extractJsonObject(reply.content));
      if (parsed) return parsed;
    } catch {
      // LLM 不可用或解析失败 → 回退
    }
    return this.fallback.analyze(query);
  }
}

/** 低置信度判定：未知意图 + 无实体 + 无变换信号时升级到 LLM 分析 */
export function isLowConfidence(a: QueryAnalysis): boolean {
  return (
    a.intent === "unknown" &&
    a.entities.length === 0 &&
    !a.needsRewrite &&
    !a.needsMultiQuery &&
    !a.needsHyDE
  );
}

/** Query Analyzer 入口：规则优先，低置信且配置了 API key 时用 LLM 精化 */
export async function analyzeQuery(query: string): Promise<QueryAnalysis> {
  const rule = new RuleQueryAnalyzer();
  const analysis = await rule.analyze(query);
  if (config.openai.apiKey && isLowConfidence(analysis)) {
    const refined = await new LLMQueryAnalyzer(createLLMProvider(), rule).analyze(query);
    return {
      ...refined,
      // 规则侧派生实体可能比 LLM 更稳（确定性），做合并兜底
      entities: refined.entities.length ? refined.entities : analysis.entities,
    };
  }
  return analysis;
}
