import { config } from "../config.js";
import { createLLMProvider, type LLMProvider } from "../ai/llm.js";

/**
 * Reranker（§19）：只做纯文本相关性排序，不感知结构。
 * 结构完整性由 Context Builder 的 Source Priority 兜底。
 */
export interface RerankItem {
  id: string;
  content: string;
  score: number;
}

export interface RerankResult {
  id: string;
  score: number;
}

export interface Reranker {
  rerank(query: string, items: RerankItem[]): Promise<RerankResult[]>;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter(Boolean);
}

/** 将输入分数 min-max 归一化到 [0,1]（处理 RRF 小量纲） */
function normalizeScores(items: RerankItem[]): RerankItem[] {
  const scores = items.map((i) => i.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  return items.map((i) => ({ ...i, score: (i.score - min) / range }));
}

/**
 * 确定性 Reranker（无外部依赖 / 无 API key 时的默认）：
 * 组合检索分（归一化）与 query↔content 词面重叠度，二者各占一半。
 */
export class LexicalReranker implements Reranker {
  async rerank(query: string, items: RerankItem[]): Promise<RerankResult[]> {
    const qTokens = new Set(tokenize(query));
    const normalized = normalizeScores(items);

    const scored = normalized.map((it) => {
      const tokens = tokenize(it.content);
      let overlap = 0;
      for (const t of tokens) if (qTokens.has(t)) overlap++;
      const lexical = tokens.length ? overlap / tokens.length : 0;
      return { id: it.id, score: 0.5 * it.score + 0.5 * lexical };
    });

    return scored.sort((a, b) => b.score - a.score);
  }
}

/** 解析 LLM 输出的「编号序列」，如 "3,1,2"；失败返回 null（走原始顺序） */
function parseIndices(text: string, count: number): number[] | null {
  const nums = [...text.matchAll(/\d+/g)]
    .map((m) => Number(m[0]))
    .map((n) => n - 1) // 1-based → 0-based
    .filter((n) => n >= 0 && n < count);
  const seen = new Set<number>();
  const order: number[] = [];
  for (const n of nums) {
    if (!seen.has(n)) {
      seen.add(n);
      order.push(n);
    }
  }
  if (order.length === 0) return null;
  for (let i = 0; i < count; i++) if (!seen.has(i)) order.push(i); // 补齐缺失索引
  return order;
}

/**
 * LLM Reranker（§19 LLM Rerank）：让 LLM 对候选按相关性排序。
 * 精排候选少时可用；输出解析失败则回退到原始顺序。
 */
export class LLMReranker implements Reranker {
  constructor(private readonly llm: LLMProvider) {}

  async rerank(query: string, items: RerankItem[]): Promise<RerankResult[]> {
    if (items.length <= 1) return items.map((i) => ({ id: i.id, score: i.score }));

    const numbered = items
      .map((it, i) => `[${i + 1}] ${it.content}`)
      .join("\n");
    const prompt = [
      "你是检索重排器。请根据用户问题与候选文本的相关性，输出候选编号的排序（从最相关到最不相关）。",
      "只输出编号，用逗号分隔，例如：3,1,2",
      "",
      `问题：${query}`,
      "",
      numbered,
    ].join("\n");

    const reply = await this.llm.chat(
      [{ role: "user", content: prompt }],
      { temperature: 0 },
    );
    const order = parseIndices(reply.content, items.length) ??
      items.map((_, i) => i);

    return order.map((idx, rank) => {
      const it = items[idx];
      return { id: it?.id ?? "", score: it ? 1 - rank / items.length : 0 };
    });
  }
}

let _reranker: Reranker | undefined;

export function getReranker(): Reranker {
  if (!_reranker) {
    _reranker = config.openai.apiKey
      ? new LLMReranker(createLLMProvider())
      : new LexicalReranker();
  }
  return _reranker;
}
