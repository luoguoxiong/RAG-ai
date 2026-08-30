import { config } from "../config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
}

/**
 * LLMProvider 最小接口（§27 Provider Adapter）。
 */
export interface LLMProvider {
  chat(messages: ChatMessage[], opts?: LLMOptions): Promise<ChatMessage>;
}

export class OpenAILLMProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly modelName: string;

  constructor(opts: { apiKey: string; baseUrl: string; model: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.modelName = opts.model;
  }

  async chat(messages: ChatMessage[], opts: LLMOptions = {}): Promise<ChatMessage> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelName,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens,
      }),
      // 60s 超时：上游不可达/挂起时快速失败，避免调用方（如 Reconcile）无限等待
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(`chat request failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("empty LLM response");
    }
    return { role: "assistant", content };
  }
}

/**
 * 无 API key 时的确定性 fallback：不调用外部 LLM，
 * 把上下文中携带的 [Evidence: ev_N] 以引用形式摘要返回，
 * 确保 /search 链路在无凭据时仍可端到端跑通。
 */
export class DeterministicLLMProvider implements LLMProvider {
  async chat(messages: ChatMessage[]): Promise<ChatMessage> {
    const user = [...messages].reverse().find((m) => m.role === "user");
    const question = user?.content ?? "";
    const joined = messages.map((m) => m.content).join("\n");
    const matches = [...joined.matchAll(/\[Evidence:\s*(ev_[A-Za-z0-9_-]+)\]/g)];
    const ids = [...new Set(matches.map((m) => m[1]))];
    const cited = ids.map((id) => `[${id}]`).join(" ");
    const content = ids.length
      ? `（未配置 LLM，演示回答）命中 ${ids.length} 条证据：${cited}`
      : `（未配置 LLM，演示回答）未命中证据，问题：${question}`;
    return { role: "assistant", content };
  }
}

export function createLLMProvider(): LLMProvider {
  if (config.openai.apiKey) {
    return new OpenAILLMProvider({
      apiKey: config.openai.apiKey,
      baseUrl: config.openai.baseUrl,
      model: config.openai.model,
    });
  }
  return new DeterministicLLMProvider();
}