/**
 * Normalize（§8 Ingestion Pipeline）：对解析后的文本做清洗，
 * 稳定后续的 contentHash 与 chunk 质量。
 */
export function normalize(text: string): string {
  return text
    .normalize("NFC") // 统一 Unicode 组合形式
    .replace(/\r\n?/g, "\n") // 统一换行
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "") // 去除控制字符
    .replace(/[ \t]+\n/g, "\n") // 去掉行尾空白
    .replace(/\n{3,}/g, "\n\n") // 折叠多余空行
    .trim();
}