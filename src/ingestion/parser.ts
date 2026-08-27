export interface ParsedDocument {
  text: string;
  title?: string;
  language?: string;
  metadata: Record<string, unknown>;
}

export interface ParseInput {
  fileName: string;
  mimeType: string;
  content: Buffer;
}

/**
 * 解析器接口（§27 Provider Adapter 思想）：Domain 只依赖接口，
 * 不绑定具体 SDK。Phase 1 支持 text/plain 与 markdown，PDF 等在后续接入。
 */
export interface Parser {
  canParse(fileName: string, mimeType: string): boolean;
  parse(input: ParseInput): Promise<ParsedDocument>;
}

const Utf8 = (buf: Buffer): string => buf.toString("utf8");

export class TextParser implements Parser {
  canParse(_fileName: string, mimeType: string): boolean {
    return (
      mimeType === "text/plain" ||
      mimeType === "text/markdown" ||
      mimeType === "text/x-markdown"
    );
  }

  async parse(input: ParseInput): Promise<ParsedDocument> {
    const text = Utf8(input.content);
    return {
      text,
      title: input.fileName.replace(/\.[^.]+$/, ""),
      metadata: { fileName: input.fileName, mimeType: input.mimeType },
    };
  }
}

export class MarkdownParser implements Parser {
  canParse(fileName: string, _mimeType: string): boolean {
    return /\.md$/i.test(fileName);
  }

  async parse(input: ParseInput): Promise<ParsedDocument> {
    const text = Utf8(input.content);
    // 提取首个一级标题作为 title
    const h1 = text.match(/^#\s+(.+)$/m);
    return {
      text,
      title: h1?.[1]?.trim() || input.fileName.replace(/\.[^.]+$/, ""),
      language: "markdown",
      metadata: { fileName: input.fileName, mimeType: input.mimeType },
    };
  }
}

/** 兜底：任何未知类型按 UTF-8 文本尝试解码（Phase 1 简化） */
export class FallbackTextParser implements Parser {
  canParse(): boolean {
    return true;
  }

  async parse(input: ParseInput): Promise<ParsedDocument> {
    return {
      text: Utf8(input.content),
      title: input.fileName.replace(/\.[^.]+$/, ""),
      metadata: { fileName: input.fileName, mimeType: input.mimeType },
    };
  }
}

const parsers: Parser[] = [
  new MarkdownParser(),
  new TextParser(),
  new FallbackTextParser(),
];

export function parserFor(fileName: string, mimeType: string): Parser {
  return parsers.find((p) => p.canParse(fileName, mimeType))!;
}