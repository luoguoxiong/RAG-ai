import { config } from "../config.js";
import { createLLMProvider, type LLMProvider } from "../ai/llm.js";

/**
 * Multi Query（§14，Phase 5）：把宽泛查询扩展为多个不同表述 / 角度的
 * 变体查询，分别检索后由 RRF 融合（§10），召回更多相关证据。
 * 无 API key 时回退为单查询。
 */

export interface MultiQueryGenerator {
  expand(query: string, count: number): Promise<string[]>;
}

export class LLMMultiQueryGenerator implements MultiQueryGenerator {
  constructor(private readonly llm: LLMProvider) {}

  async expand(query: string, count: number): Promise<string[]> {
    const prompt = [
      "你是查询扩展器。针对检索问题生成多个不同表述或角度的变体查询，以召回更多相关证据。",
      `生成 ${count} 个变体，每行一个，只输出查询本身，不要编号、不要解释。`,
      `问题：${query}`,
    ].join("\n");
    try {
      const reply = await this.llm.chat(
        [{ role: "user", content: prompt }],
        { temperature: 0.7 },
      );
      const variants = reply.content
        .split("\n")
        .map((l) => l.trim().replace(/^\d+[.、)]\s*/, ""))
        .filter((l) => l.length > 0 && l.length <= 200)
        .slice(0, count);
      const seen = new Set<string>([query]);
      const out: string[] = [query];
      for (const v of variants) {
        if (!seen.has(v)) {
          seen.add(v);
          out.push(v);
        }
      }
      return out.slice(0, count + 1);
    } catch {
      return [query];
    }
  }
}

/** 确定性回退：只保留原始查询 */
export class IdentityMultiQueryGenerator implements MultiQueryGenerator {
  async expand(query: string): Promise<string[]> {
    return [query];
  }
}

export function createMultiQueryGenerator(): MultiQueryGenerator {
  return config.openai.apiKey
    ? new LLMMultiQueryGenerator(createLLMProvider())
    : new IdentityMultiQueryGenerator();
}
