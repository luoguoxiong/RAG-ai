import { config } from "../config.js";
import { createLLMProvider, type LLMProvider } from "../ai/llm.js";
import { splitSentences, tokenize } from "./metrics.js";

/**
 * Generation 评测（§22 Generation Metrics）：
 * Faithfulness（回答断言是否被上下文支撑）与 Answer Relevance（回答是否切题）。
 * 与 §21.1 Citation 校验共用同一套「断言 ↔ 证据」对齐逻辑。
 */

export interface FaithfulnessContext {
  /** 拼接后的检索上下文（Evidence 内容） */
  text: string;
  /** 上下文条数，用于校验 [ev_N] / [N] 引用编号是否越界 */
  evidenceCount: number;
}

export interface GenerationJudge {
  faithfulness(answer: string, ctx: FaithfulnessContext): Promise<number>;
  answerRelevance(query: string, answer: string): Promise<number>;
}

/** 校验一句回答中的引用标记：至少命中一个真实存在的证据编号 */
function hasValidCitation(sentence: string, evidenceCount: number): boolean {
  for (const m of sentence.matchAll(/\[ev_(\d+)\]|\[(\d+)\]/g)) {
    const n = Number(m[1] ?? m[2]);
    if (Number.isInteger(n) && n >= 1 && n <= evidenceCount) return true;
  }
  return false;
}

/**
 * 确定性 Judge（无 API key / LLM 失败时的兜底）：
 * - Faithfulness：按句判定「有合法引用」或「与上下文有词面重叠」为受支持
 * - Answer Relevance：问题词元在回答中的包含率
 */
export class LexicalJudge implements GenerationJudge {
  async faithfulness(answer: string, ctx: FaithfulnessContext): Promise<number> {
    const sentences = splitSentences(answer);
    if (sentences.length === 0) return 1;
    const ctxTokens = new Set(tokenize(ctx.text));
    let supported = 0;
    for (const s of sentences) {
      if (hasValidCitation(s, ctx.evidenceCount)) {
        supported++;
        continue;
      }
      const tokens = tokenize(s);
      if (tokens.some((t) => ctxTokens.has(t))) supported++;
    }
    return supported / sentences.length;
  }

  async answerRelevance(query: string, answer: string): Promise<number> {
    const q = new Set(tokenize(query));
    if (q.size === 0) return 0;
    const a = new Set(tokenize(answer));
    const hit = [...q].filter((t) => a.has(t)).length;
    return hit / q.size;
  }
}

/** 解析 LLM 输出的 JSON {"claims":[{"supported":true|false}]}；失败返回 null */
function parseFaithfulness(text: string): number | null {
  const block = text.match(/\{[\s\S]*\}/);
  if (block) {
    try {
      const obj = JSON.parse(block[0]) as { claims?: { supported?: unknown }[] };
      if (Array.isArray(obj.claims) && obj.claims.length > 0) {
        const verdicts = obj.claims.map((c) => Boolean(c.supported));
        return verdicts.filter(Boolean).length / verdicts.length;
      }
    } catch {
      /* 回退到逐行解析 */
    }
  }
  const verdicts = text
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean)
    .map((l): boolean | null => {
      if (l.includes("unsupported") || /^\s*(no|false)\s*$/.test(l)) return false;
      if (l.includes("supported") || /^\s*(yes|true)\s*$/.test(l)) return true;
      return null;
    })
    .filter((v): v is boolean => v !== null);
  if (verdicts.length === 0) return null;
  return verdicts.filter(Boolean).length / verdicts.length;
}

/** 解析 0-5 分输出；失败返回 null */
function parseScore(text: string): number | null {
  const m = text.match(/\d+(\.\d+)?/);
  if (!m) return null;
  const score = Number(m[0]);
  if (!Number.isFinite(score)) return null;
  return Math.max(0, Math.min(score, 5)) / 5;
}

/**
 * LLM Judge：让 LLM 做 Faithfulness 判定与 Relevance 打分。
 * 任一环节失败（超时 / 解析失败）自动回退到确定性实现，保证评估不中断。
 */
export class LLMJudge implements GenerationJudge {
  private readonly fallback = new LexicalJudge();

  constructor(private readonly llm: LLMProvider = createLLMProvider()) {}

  async faithfulness(answer: string, ctx: FaithfulnessContext): Promise<number> {
    try {
      const prompt = [
        "你是评估助手。判断【回答】中的每个事实断言是否被【上下文】支持。",
        "输出 JSON：{\"claims\":[{\"text\":\"断言\",\"supported\":true或false}]}",
        "",
        `【上下文】\n${ctx.text.slice(0, 4000)}`,
        "",
        `【回答】\n${answer}`,
      ].join("\n");
      const reply = await this.llm.chat(
        [{ role: "user", content: prompt }],
        { temperature: 0 },
      );
      const parsed = parseFaithfulness(reply.content);
      if (parsed !== null) return parsed;
    } catch {
      /* 回退 */
    }
    return this.fallback.faithfulness(answer, ctx);
  }

  async answerRelevance(query: string, answer: string): Promise<number> {
    try {
      const prompt = [
        "你是评估助手。判断【回答】与【问题】的相关程度，输出 0-5 的整数：",
        "0 表示完全无关，5 表示完整切题。只输出数字。",
        "",
        `【问题】${query}`,
        `【回答】${answer}`,
      ].join("\n");
      const reply = await this.llm.chat(
        [{ role: "user", content: prompt }],
        { temperature: 0 },
      );
      const parsed = parseScore(reply.content);
      if (parsed !== null) return parsed;
    } catch {
      /* 回退 */
    }
    return this.fallback.answerRelevance(query, answer);
  }
}

let _judge: GenerationJudge | undefined;

export function getGenerationJudge(): GenerationJudge {
  if (!_judge) {
    _judge = config.openai.apiKey ? new LLMJudge() : new LexicalJudge();
  }
  return _judge;
}
