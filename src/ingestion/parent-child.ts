import { ParagraphSplitter } from "./splitter.js";

export interface ParentChildChunk {
  /** 父块：较大上下文，仅存储、不参与向量索引 */
  parent: string;
  /** 子块：较小片段，用于向量检索 */
  children: string[];
}

export interface ParentChildOptions {
  childMaxChars?: number;
  childOverlap?: number;
  parentMaxChars?: number;
}

/**
 * ParentChildSplitter（§6）：先切小块（child，检索精准），
 * 再把相邻小块聚合为大块（parent，上下文完整）。
 */
export class ParentChildSplitter {
  private readonly childSplitter: ParagraphSplitter;
  private readonly parentMaxChars: number;

  constructor(opts: ParentChildOptions = {}) {
    this.childSplitter = new ParagraphSplitter({
      maxChars: opts.childMaxChars ?? 400,
      overlapChars: opts.childOverlap ?? 80,
    });
    this.parentMaxChars = opts.parentMaxChars ?? 2000;
  }

  split(text: string): ParentChildChunk[] {
    const children = this.childSplitter.split(text).map((s) => s.content);
    const groups: ParentChildChunk[] = [];
    let parent = "";
    let acc: string[] = [];

    for (const child of children) {
      if (acc.length > 0 && parent.length + child.length + 2 > this.parentMaxChars) {
        groups.push({ parent: parent.trim(), children: acc });
        parent = "";
        acc = [];
      }
      acc.push(child);
      parent += (parent ? "\n\n" : "") + child;
    }

    if (acc.length > 0) {
      groups.push({ parent: parent.trim(), children: acc });
    }
    return groups;
  }
}