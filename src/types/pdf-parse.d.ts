/**
 * pdf-parse 的 lib 入口类型声明。
 * 主入口 `pdf-parse` 在 ESM 导入下会命中 `!module.parent` 判断而进入 debug 模式，
 * 因此统一走 `pdf-parse/lib/pdf-parse.js`（纯解析函数，无 test runner 副作用）。
 */
declare module "pdf-parse/lib/pdf-parse.js" {
  export interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    text: string;
    version: string;
  }
  const pdfParse: (
    dataBuffer: Buffer,
    options?: Record<string, unknown>,
  ) => Promise<PdfParseResult>;
  export default pdfParse;
}
