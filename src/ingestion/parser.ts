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

/**
 * PDF 解析器：pdf-parse 提取纯文本。
 * PDF 文本提取常带硬换行（每行一个 \n），restoreParagraphs 先把硬换行合并成段落，
 * 否则切分会把同一段落切成碎片（§ 分类型切分的前提是文本已还原）。
 */
export class PdfParser implements Parser {
  canParse(fileName: string, mimeType: string): boolean {
    return /\.pdf$/i.test(fileName) || mimeType === "application/pdf";
  }

  async parse(input: ParseInput): Promise<ParsedDocument> {
    const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
    const result = await pdfParse(input.content);
    return {
      text: restoreParagraphs(result.text),
      title: input.fileName.replace(/\.[^.]+$/, ""),
      language: "pdf",
      metadata: {
        fileName: input.fileName,
        mimeType: input.mimeType,
        numpages: result.numpages,
      },
    };
  }
}

/** docx 解析器：mammoth 提取段落原始文本（docx 是 zip+xml，需专门库解包） */
export class DocxParser implements Parser {
  canParse(fileName: string, mimeType: string): boolean {
    return (
      /\.docx$/i.test(fileName) ||
      mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  }

  async parse(input: ParseInput): Promise<ParsedDocument> {
    const { default: mammoth } = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: input.content });
    return {
      text: result.value,
      title: input.fileName.replace(/\.[^.]+$/, ""),
      language: "docx",
      metadata: { fileName: input.fileName, mimeType: input.mimeType },
    };
  }
}

/**
 * PDF 段落还原（启发式）：
 * 以空行分隔"伪段落"，段内硬换行合并为空格连接。
 * 页眉页脚/页码等噪声暂不过滤，后续可接入布局信息做更精细还原。
 */
function restoreParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.split("\n").map((l) => l.trim()).filter(Boolean).join(" "))
    .filter((p) => p.length > 0)
    .join("\n\n");
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
  new PdfParser(),
  new DocxParser(),
  new MarkdownParser(),
  new TextParser(),
  new FallbackTextParser(),
];

export function parserFor(fileName: string, mimeType: string): Parser {
  return parsers.find((p) => p.canParse(fileName, mimeType))!;
}