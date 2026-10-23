// 评测环境兜底：必须最先 import。
// 本机 IDE 会经 NODE_OPTIONS 注入 node-language-shim.cjs，文件运行模式下会使
// globalThis.crypto 变为 undefined，LangChain/LangGraph 内部裸用 crypto 会崩；
// 在任何业务模块加载前补齐 webcrypto。
import { webcrypto } from 'node:crypto';
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto?.getRandomValues) {
  globalThis.crypto = webcrypto;
}
