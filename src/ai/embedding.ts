import { config } from "../config.js";

/**
 * EmbeddingProvider：向量化抽象（§27 Provider Adapter）。
 * Domain 只依赖接口，不绑定具体 SDK。
 */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions(): number;
  model(): string;
}

/** 确定性 fallback：feature-hashing（hashing trick），无外部依赖，语义近似的文本得到相似向量。 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly dims: number = 384) {}

  model(): string {
    return "deterministic-hash";
  }

  dimensions(): number {
    return this.dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashVector(t, this.dims));
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly modelName: string;
  private readonly dims: number;
  /**
   * 是否走多模态向量化接口（/embeddings/multimodal）。
   * 火山方舟的 doubao-embedding-vision 仅支持该接口：input 为结构化对象、data 为单对象而非数组。
   */
  private readonly isMultimodal: boolean;

  constructor(opts: {
    apiKey: string;
    baseUrl: string;
    model: string;
    dimensions: number;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.modelName = opts.model;
    this.dims = opts.dimensions;
    this.isMultimodal = opts.model.startsWith("doubao-embedding-vision");
  }

  model(): string {
    return this.modelName;
  }

  dimensions(): number {
    return this.dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const path = this.isMultimodal ? "embeddings/multimodal" : "embeddings";
    const body = this.isMultimodal
      ? {
          model: this.modelName,
          encoding_format: "float",
          // doubao-embedding-vision 可选维度为 1024 / 2048，需与 Qdrant 集合保持一致
          dimensions: this.dims,
          input: texts.map((text) => ({ type: "text", text })),
        }
      : { model: this.modelName, input: texts };
    const res = await fetch(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`embedding request failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      data?: { embedding?: number[] } | { embedding?: number[] }[];
    };
    // 多模态接口 data 为单对象，标准接口为数组，统一归一化为数组
    const dataList = Array.isArray(json.data)
      ? json.data
      : json.data
        ? [json.data]
        : [];
    const embeddings = dataList.map((d) => d.embedding ?? []);
    if (embeddings.length !== texts.length) {
      throw new Error("embedding response dimension mismatch");
    }
    return embeddings;
  }
}

export function createEmbeddingProvider(): EmbeddingProvider {
  if (config.openai.apiKey) {
    return new OpenAIEmbeddingProvider({
      apiKey: config.openai.apiKey,
      baseUrl: config.openai.baseUrl,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
    });
  }
  return new DeterministicEmbeddingProvider(config.embedding.dimensions);
}

// ---- feature hashing ----

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter(Boolean);
}

function hashVector(text: string, dims: number): number[] {
  const vec = new Array<number>(dims).fill(0);
  for (const tok of tokenize(text)) {
    const h = fnv1a(tok);
    const idx = h % dims;
    const sign = (h & 1) === 0 ? 1 : -1;
    vec[idx] = (vec[idx] ?? 0) + sign;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  for (let i = 0; i < dims; i++) {
    vec[i] = (vec[i] ?? 0) / norm;
  }
  return vec;
}