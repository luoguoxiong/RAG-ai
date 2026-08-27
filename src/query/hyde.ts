import { config } from "../config.js";
import { createLLMProvider, type LLMProvider } from "../ai/llm.js";

/**
 * HyDE（§14，Phase 5）：Hypothetical Document Embeddings。
 * 为概念型问题生成一段"假设性答案段落"，用其嵌入 / 词面做检索，
 * 弥补查询短而抽象导致的向量 / 关键词命中不足。
 * 无 API key 时返回 null（跳过 HyDE，走直连）。
 */

export interface HyDEGenerator {
  generate(query: string): Promise<string | null>;
}

export class LLMHyDEGenerator implements HyDEGenerator {
  constructor(private readonly llm: LLMProvider) {}

  async generate(query: string): Promise<string | null> {
    const prompt = [
      "你是文档模拟器。针对下面这个问题，写一段 2~4 句的假设性答案段落",
      "（即如果知识库里正好有答案，这段文字大概长什么样，包含关键实体与术语）。",
      "只输出段落内容，不要解释。",
      `问题：${query}`,
    ].join("\n");
    try {
      const reply = await this.llm.chat(
        [{ role: "user", content: prompt }],
        { temperature: 0.7 },
      );
      const text = reply.content.trim();
      return text.length > 0 && text.length <= 1000 ? text : null;
    } catch {
      return null;
    }
  }
}

/** 确定性回退：不生成（跳过 HyDE） */
export class NullHyDEGenerator implements HyDEGenerator {
  async generate(): Promise<string | null> {
    return null;
  }
}

export function createHydeGenerator(): HyDEGenerator {
  return config.openai.apiKey
    ? new LLMHyDEGenerator(createLLMProvider())
    : new NullHyDEGenerator();
}
