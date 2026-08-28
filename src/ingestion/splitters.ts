import type { ParentChildChunk } from "./parent-child.js";

/**
 * Splitter 接口：不同文档类型采用不同的切分策略。
 * 与 Parser 对称设计——解析按类型分发（parser.ts），切分也按类型分发。
 * 所有 splitter 统一返回 parent/child 两级结构，兼容 processVersion 的消费逻辑。
 */
export interface Splitter {
  /** 是否适用于该文档类型（language 取自解析器写入的 metadata.language） */
  supports(language?: string): boolean;
  /** 把整段文本切成 parent/child 两级 chunk 列表 */
  split(text: string): ParentChildChunk[];
}

/** child 块目标字符数（检索单元，控制向量召回粒度） */
const CHILD_MAX = 400;
/** parent 块目标字符数（上下文单元，超过则另起一组） */
const PARENT_MAX = 2000;

/** 按中英文句号/问号/感叹号/分号分句，lookbehind 保留分隔符在句尾 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？；.!?;])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 句子序列 → 聚合为 child（不硬切句子，超长句独立成块） */
function toChildren(sentences: string[]): string[] {
  const children: string[] = [];
  let child = "";
  for (const s of sentences) {
    // 当前 child 再加入会超限：闭合当前 child
    if (child && child.length + s.length + 2 > CHILD_MAX) {
      children.push(child);
      child = "";
    }
    child += (child ? " " : "") + s;
  }
  if (child) children.push(child);
  return children;
}

/** child 序列 → 贪心聚合成 parent/child 组（与 ParentChildSplitter 相同的闭合逻辑） */
function toGroups(children: string[]): ParentChildChunk[] {
  const groups: ParentChildChunk[] = [];
  let parent = "";
  let acc: string[] = [];
  for (const c of children) {
    // +2 是 "\n\n" 分隔符的长度
    if (acc.length > 0 && parent.length + c.length + 2 > PARENT_MAX) {
      groups.push({ parent: parent.trim(), children: acc });
      parent = "";
      acc = [];
    }
    acc.push(c);
    parent += (parent ? "\n\n" : "") + c;
  }
  if (acc.length > 0) groups.push({ parent: parent.trim(), children: acc });
  return groups;
}

/**
 * SentenceSplitter（text / pdf / docx 等无结构文档的通用策略）：
 * 按句号分句 → 句子聚合为 child（检索单元）→ child 聚合成 parent（上下文）。
 * 句子保持完整，不做字符级硬切，避免语义碎片化。
 */
export class SentenceSplitter implements Splitter {
  supports(): boolean {
    return true; // 兜底：任何未匹配专用 splitter 的类型
  }

  split(text: string): ParentChildChunk[] {
    return toGroups(toChildren(splitSentences(text)));
  }
}

/** 文本中的语义块：代码块/表格整体保留，普通段落保持内部换行 */
function splitBlocks(body: string): string[] {
  const lines = body.split("\n");
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) {
      // 围栏代码块：整体保留，不拆散
      const code = [line];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
        code.push(lines[i]!);
        i++;
      }
      if (i < lines.length) code.push(lines[i]!);
      i++;
      blocks.push(code.join("\n"));
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      // 表格块：连续 | 行整体保留
      const table = [line];
      i++;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        table.push(lines[i]!);
        i++;
      }
      blocks.push(table.join("\n"));
    } else {
      // 普通段落：直到空行
      const para = [line];
      i++;
      while (i < lines.length && lines[i]!.trim() !== "") {
        para.push(lines[i]!);
        i++;
      }
      blocks.push(para.join("\n"));
      while (i < lines.length && lines[i]!.trim() === "") i++;
    }
  }
  return blocks.filter((b) => b.trim().length > 0);
}

interface Section {
  heading: string;
  body: string;
}

/** 按 ATX 标题（# ~ ######）把 markdown 切成分节，标题作为节的语义锚点 */
function splitByHeadings(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let heading = "";
  let body: string[] = [];
  const flush = () => {
    if (heading || body.length > 0) {
      sections.push({ heading, body: body.join("\n") });
      heading = "";
      body = [];
    }
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) {
      flush();
      heading = m[2]!.trim();
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * MarkdownSplitter（md 专用，结构感知）：
 * 按标题层级分节，标题作为 parent 的语义前缀（检索命中后可定位"来自哪一节"）；
 * 节内再拆块：代码块/表格整体保留为 child（拆开会破坏语义），
 * 普通段落内按句子聚合。parent 超长时按 child 分片，每个分片仍带标题前缀。
 */
export class MarkdownSplitter implements Splitter {
  supports(language?: string): boolean {
    return language === "markdown" || language === "md";
  }

  split(text: string): ParentChildChunk[] {
    const sections = splitByHeadings(text);
    const groups: ParentChildChunk[] = [];
    for (const sec of sections) {
      // 节内容切块后，普通段落再按句子细分 child
      const children: string[] = [];
      for (const block of splitBlocks(sec.body)) {
        if (block.trimStart().startsWith("```") || /^\s*\|.*\|\s*$/.test(block)) {
          // 代码块 / 表格：整体作为一个 child（可能超长，但拆开会破坏结构）
          children.push(block);
        } else {
          children.push(...toChildren(splitSentences(block)));
        }
      }
      // 带标题前缀的 parent 聚合
      const headingPrefix = sec.heading ? `# ${sec.heading}` : "";
      let parent = headingPrefix;
      let acc: string[] = [];
      for (const c of children) {
        if (acc.length > 0 && parent.length + c.length + 2 > PARENT_MAX) {
          groups.push({ parent: parent.trim(), children: acc });
          parent = headingPrefix;
          acc = [];
        }
        acc.push(c);
        parent += (parent ? "\n\n" : "") + c;
      }
      if (acc.length > 0) groups.push({ parent: parent.trim(), children: acc });
    }
    return groups;
  }
}

/** 注册表：Markdown 专用在前，Sentence 兜底在后 */
const splitters: Splitter[] = [new MarkdownSplitter(), new SentenceSplitter()];

/** 按文档类型（language）选取切分器；未匹配时回退到通用句子切分 */
export function splitterFor(language?: string): Splitter {
  return splitters.find((s) => s.supports(language)) ?? splitters[splitters.length - 1]!;
}
