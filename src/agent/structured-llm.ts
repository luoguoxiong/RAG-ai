import { config } from "../config.js";
import {
  createLLMProvider,
  type ChatMessage,
  type LLMOptions,
} from "../ai/llm.js";
import type { z } from "zod";

/**
 * 结构化 LLM 调用（设计方案 §5 核心原则）：
 * LLM 负责分析与提案，服务端 zod Schema 负责校验——
 * 输出不符合 Schema 一律视为失败，由调用方回退到确定性实现。
 */

/** 是否配置了真实 LLM（DeterministicLLMProvider 无法产出结构化 JSON） */
export function hasLLM(): boolean {
  return config.openai.apiKey.length > 0;
}

/** 从 LLM 文本输出中提取 JSON 对象（兼容 markdown 围栏与前后杂文） */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("no JSON object found in LLM output");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * 调用 LLM 并按 zod Schema 校验输出。
 * 任一环节失败（网络 / 非法 JSON / Schema 不匹配）抛错，调用方自行回退。
 */
export async function chatJson<T>(
  schema: z.ZodType<T>,
  messages: ChatMessage[],
  opts?: LLMOptions,
): Promise<T> {
  const reply = await createLLMProvider().chat(messages, {
    temperature: 0,
    ...opts,
  });
  const parsed = schema.safeParse(extractJson(reply.content));
  if (!parsed.success) {
    throw new Error(`LLM output failed schema validation: ${parsed.error.message}`);
  }
  return parsed.data;
}
