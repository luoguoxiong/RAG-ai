import { ParagraphSplitter } from "./splitter.js";

/** 一次分块的结果：一个 parent + 其包含的多个 child */
export interface ParentChildChunk {
  /** 父块：较大上下文，仅存储、不参与向量索引（检索命中 child 后，用它回填上下文） */
  parent: string;
  /** 子块：较小片段，用于向量检索 */
  children: string[];
}

export interface ParentChildOptions {
  /** child 块最大字符数 */
  childMaxChars?: number;
  /** child 块间重叠字符数（保持相邻块上下文连续） */
  childOverlap?: number;
  /** parent 块最大字符数，超过则另起一组 */
  parentMaxChars?: number;
}

/**
 * ParentChildSplitter（§6 Parent-Child Retrieval）：
 * 先切成小块（child，检索精准），再把相邻小块聚合成大块（parent，上下文完整）。
 *
 * 设计动机：小块做向量检索召回精准，但缺乏上下文；
 * 检索命中 child 后，用其所属 parent 作为上下文喂给 LLM，兼顾精准与完整。
 */
export class ParentChildSplitter {
  /** 底层切分器：负责把文本切成 child 级小块 */
  private readonly childSplitter: ParagraphSplitter;
  /** parent 聚合上限：超过该长度就闭合当前组、另起一组 */
  private readonly parentMaxChars: number;

  constructor(opts: ParentChildOptions = {}) {
    this.childSplitter = new ParagraphSplitter({
      maxChars: opts.childMaxChars ?? 400,
      overlapChars: opts.childOverlap ?? 80,
    });
    this.parentMaxChars = opts.parentMaxChars ?? 2000;
  }

  /**
   * 把整段文本拆成 parent/child 两级结构。
   * 步骤：1) 先用 ParagraphSplitter 得到 child 序列（已带 overlap）
   *       2) 顺序聚合：累积 child，直到 parent 长度触顶则闭合上一组
   */
  split(text: string): ParentChildChunk[] {
    // 1. 先用 ParagraphSplitter 切出 child 序列
    const children = this.childSplitter.split(text).map((s) => s.content);
    const groups: ParentChildChunk[] = [];
    // 当前组正在累积的状态：parent 全文 + 已收编的 child 列表
    let parent = "";
    let acc: string[] = [];

    // 2. 顺序遍历 child，贪心聚合到 parent：
    //    parent 若再加入当前 child 会超限（+2 是 "\n\n" 分隔符的长度），
    //    则闭合当前组（parent.trim() 去除首尾空白），重置后重新累积
    for (const child of children) {
      if (acc.length > 0 && parent.length + child.length + 2 > this.parentMaxChars) {
        groups.push({ parent: parent.trim(), children: acc });
        parent = "";
        acc = [];
      }
      acc.push(child);
      parent += (parent ? "\n\n" : "") + child;
    }

    // 3. 收尾：把最后一组（若有）也输出
    if (acc.length > 0) {
      groups.push({ parent: parent.trim(), children: acc });
    }
    return groups;
  }
}