import { config } from "../../config.js";
import { createLLMProvider, type LLMProvider } from "../../ai/llm.js";

export interface ExtractedEntity {
  name: string;
  type: string;
  aliases: string[];
}

export interface ExtractedRelation {
  from: string;
  to: string;
  type: string;
}

export interface ExtractedGraph {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

/**
 * 实体抽取器（§11）：从 chunk 文本中抽取实体与关系。
 * LLM 抽取为主，确定性启发式为回退（无 API key / 解析失败）。
 */
export interface EntityExtractor {
  extract(text: string): Promise<ExtractedGraph>;
}

const MAX_ENTITIES = 24;
const MAX_RELATIONS = 32;

function dedupeEntities(list: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Map<string, ExtractedEntity>();
  for (const e of list) {
    const key = e.name.trim().toLowerCase();
    if (key && !seen.has(key)) seen.set(key, e);
  }
  return [...seen.values()].slice(0, MAX_ENTITIES);
}

/**
 * 确定性回退抽取：引号短语 + 英文专名 + 中文机构后缀。
 * 产出的关系是「相邻实体 RELATED_TO」，保证无 LLM 时也能形成连通图，
 * 便于 n-hop 检索端到端跑通（效果弱，仅演示）。
 */
export class DeterministicEntityExtractor implements EntityExtractor {
  async extract(text: string): Promise<ExtractedGraph> {
    const found: ExtractedEntity[] = [];

    for (const m of text.matchAll(/["「『]([^"」』\n]{1,40})["」』]/g)) {
      const name = m[1]?.trim();
      if (name) found.push({ name, type: "unknown", aliases: [] });
    }

    for (const m of text.matchAll(
      /\b[A-Z][a-z]{1,20}(?:\s+(?:[A-Z][a-z]{1,20}|of|and|the)){0,3}\b/g,
    )) {
      const name = m[0].trim();
      if (name) found.push({ name, type: "unknown", aliases: [] });
    }

    for (const m of text.matchAll(
      /[\u4e00-\u9fa5]{2,12}(?:公司|大学|集团|研究院|银行|基金|实验室|团队|部门)(?:[\u4e00-\u9fa5]{0,6})?/g,
    )) {
      const name = m[0];
      if (name) found.push({ name, type: "org", aliases: [] });
    }

    const entities = dedupeEntities(found);
    const relations: ExtractedRelation[] = [];
    for (let i = 0; i + 1 < entities.length; i++) {
      relations.push({
        from: entities[i]!.name,
        to: entities[i + 1]!.name,
        type: "RELATED_TO",
      });
    }

    return { entities, relations: relations.slice(0, MAX_RELATIONS) };
  }
}

function extractJsonObject(text: string): unknown {
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

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** 校验 + 归一化 LLM 抽取结果；不合法则返回 null 触发回退。 */
function normalizeLlmGraph(raw: unknown): ExtractedGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.entities)) return null;

  const entities: ExtractedEntity[] = [];
  for (const e of obj.entities) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (!isString(o.name)) continue;
    entities.push({
      name: o.name.trim(),
      type: isString(o.type) ? o.type : "unknown",
      aliases: Array.isArray(o.aliases) ? o.aliases.filter(isString) : [],
    });
  }
  if (entities.length === 0) return null;

  const relations: ExtractedRelation[] = [];
  const rels = Array.isArray(obj.relations) ? obj.relations : [];
  for (const r of rels) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (!isString(o.from) || !isString(o.to)) continue;
    relations.push({
      from: o.from.trim(),
      to: o.to.trim(),
      type: isString(o.type) ? o.type : "RELATED_TO",
    });
  }

  return {
    entities: dedupeEntities(entities),
    relations: relations.slice(0, MAX_RELATIONS),
  };
}

export class LLMEntityExtractor implements EntityExtractor {
  constructor(
    private readonly llm: LLMProvider,
    private readonly fallback: EntityExtractor,
  ) {}

  async extract(text: string): Promise<ExtractedGraph> {
    const prompt = [
      "你是知识图谱实体抽取器。从给定文本中抽取实体（人名/机构/地点/产品/概念等）与实体间关系。",
      "只输出 JSON，不要输出任何其它文字。格式：",
      '{"entities":[{"name":"实体名","type":"person|org|location|product|concept|unknown","aliases":["别名1"]}],',
      '"relations":[{"from":"实体名","to":"实体名","type":"关系类型"}]}',
      "",
      `文本：${text}`,
    ].join("\n");

    try {
      const reply = await this.llm.chat(
        [{ role: "user", content: prompt }],
        { temperature: 0 },
      );
      const graph = normalizeLlmGraph(extractJsonObject(reply.content));
      if (graph && graph.entities.length > 0) return graph;
    } catch {
      // LLM 不可用或解析失败 → 回退
    }
    return this.fallback.extract(text);
  }
}

export function createEntityExtractor(): EntityExtractor {
  if (config.openai.apiKey) {
    return new LLMEntityExtractor(
      createLLMProvider(),
      new DeterministicEntityExtractor(),
    );
  }
  return new DeterministicEntityExtractor();
}