export interface ChunkSpec {
  content: string;
  chunkIndex: number;
  metadata: Record<string, unknown>;
}

export interface SplitOptions {
  maxChars?: number;
  overlapChars?: number;
}

/**
 * ParagraphSplitter：按段落聚合到最大字符数，带 overlap。
 * Phase 1 基础切分；后续可替换为 recursive / 结构感知 splitter（§4.2 可重建）。
 */
export class ParagraphSplitter {
  private readonly maxChars: number;
  private readonly overlapChars: number;

  constructor(opts: SplitOptions = {}) {
    this.maxChars = opts.maxChars ?? 1000;
    this.overlapChars = opts.overlapChars ?? 200;
  }

  split(text: string): ChunkSpec[] {
    const paragraphs = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const chunks: ChunkSpec[] = [];
    let current = "";
    let index = 0;

    const push = () => {
      if (current.trim().length === 0) return;
      chunks.push({ content: current.trim(), chunkIndex: index++, metadata: {} });
    };

    for (const para of paragraphs) {
      // 单段超长：硬切
      if (para.length > this.maxChars) {
        push();
        for (let i = 0; i < para.length; i += this.maxChars - this.overlapChars) {
          const slice = para.slice(i, i + this.maxChars);
          if (!slice) break;
          chunks.push({ content: slice, chunkIndex: index++, metadata: {} });
        }
        current = "";
        continue;
      }

      if (current.length + para.length + 2 > this.maxChars) {
        push();
        // overlap：保留上一段尾部作为上下文
        const tail = current.trim();
        current = tail.slice(-this.overlapChars) ? tail.slice(-this.overlapChars) + "\n\n" : "";
      }
      current += (current ? "\n\n" : "") + para;
    }
    push();

    return chunks;
  }
}