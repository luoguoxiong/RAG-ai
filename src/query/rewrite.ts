import { config } from "../config.js";
import { createLLMProvider, type LLMProvider } from "../ai/llm.js";

/**
 * Query Rewrite（§14，Phase 5）：把含糊 / 口语化的查询改写成清晰、
 * 自包含、适合检索的查询。无 API key 时回退为原样返回（链路可用）。
 */

export interface QueryRewriter {
  rewrite(query: string): Promise<string>;
}

export class LLMQueryRewriter implements QueryRewriter {
  constructor(private readonly llm: LLMProvider) {}

  async rewrite(query: string): Promise<string> {
    const prompt = [
      "你是查询改写器。把含糊、口语化的检索问题改写成清晰、自包含、适合检索的单个问题。",
      "只输出改写后的查询，不要解释，不要加引号或编号。",
      `问题：${query}`,
    ].join("\n");
    try {
      const reply = await this.llm.chat(
        [{ role: "user", content: prompt }],
        { temperature: 0 },
      );
      const text = reply.content.trim().replace(/^["'“”]|["'“”]$/g, "");
      if (text.length > 0 && text.length <= 200 && text !== query) return text;
    } catch {
      // LLM 不可用 → 回退
    }
    return query;
  }
}

/** 确定性回退：原样返回 */
export class IdentityQueryRewriter implements QueryRewriter {
  async rewrite(query: string): Promise<string> {
    return query;
  }
}

export function createQueryRewriter(): QueryRewriter {
  return config.openai.apiKey
    ? new LLMQueryRewriter(createLLMProvider())
    : new IdentityQueryRewriter();
}
