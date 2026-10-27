// ============ 一次性脚本：将本地知识库（server/data.js KNOWLEDGE_BASE）上传到知识检索平台 ============
//
// 用法：
//   node scripts/seed-knowledge.js                 # 创建新版本（logistics-kb-<时间戳>）并激活后上传
//   node scripts/seed-knowledge.js --version <id>  # 上传到指定已有版本
//   node scripts/seed-knowledge.js --use-active    # 上传到当前激活版本（重复执行依赖内容哈希幂等）
//
// 流程：健康检查 → 确定版本（创建/激活）→ 逐篇生成 Markdown 并 multipart 上传
//       → 轮询 GET /documents/:id 直到索引 Job ready/failed → 输出版本信息
//
// 环境变量（与 server/knowledge.js 一致）：KNOWLEDGE_API_URL / KNOWLEDGE_TENANT_ID

import 'dotenv/config';
import { KNOWLEDGE_BASE } from '../server/data.js';

const API_URL = (process.env.KNOWLEDGE_API_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const TENANT_ID = process.env.KNOWLEDGE_TENANT_ID || '00000000-0000-0000-0000-000000000001';

const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const targetVersion = argOf('--version');
const useActive = args.includes('--use-active');

const HEADERS = { 'x-tenant-id': TENANT_ID };
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(method, path, body, extraHeaders = {}) {
  const resp = await fetch(`${API_URL}${path}`, {
    method,
    headers: { ...HEADERS, ...extraHeaders },
    ...(body !== undefined ? { body } : {})
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应保留文本 */
  }
  if (!resp.ok) {
    throw new Error(`${method} ${path} -> ${resp.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

/** 每篇知识生成一份 Markdown 文档：标题 + 主题关键词（利于关键词检索命中）+ 正文 */
function toMarkdown(entry) {
  return [
    `# ${entry.title}`,
    '',
    `主题：${entry.keywords.join('、')}`,
    '',
    entry.content,
    ''
  ].join('\n');
}

async function uploadDocument(versionId, entry) {
  const fileName = `${entry.id}-${entry.title}.md`;
  const md = toMarkdown(entry);
  // 注意：平台 req.file() 读取第一个 multipart part，file 必须放在最前
  const form = new FormData();
  form.append('file', new Blob([md], { type: 'text/markdown' }), fileName);
  form.append('versionId', versionId);

  const resp = await fetch(`${API_URL}/documents`, {
    method: 'POST',
    headers: HEADERS,
    body: form
  });
  const text = await resp.text();
  if (resp.status !== 202 && !resp.ok) {
    throw new Error(`upload ${fileName} -> ${resp.status}: ${text.slice(0, 200)}`);
  }
  const result = JSON.parse(text);
  return { fileName, ...result };
}

async function waitIndexed(doc) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const detail = await api('GET', `/documents/${doc.documentId}`);
    const job = (detail.jobs || []).find((j) => j.id === doc.jobId)
      || (detail.jobs || []).find((j) => j.payload?.documentId === doc.documentId);
    if (job) {
      if (job.status === 'ready') return;
      if (job.status === 'failed') throw new Error(`index failed for ${doc.fileName}: ${job.error || 'unknown'}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`index timeout for ${doc.fileName} after ${POLL_TIMEOUT_MS}ms`);
}

async function main() {
  console.log(`[seed] knowledge platform: ${API_URL} (tenant=${TENANT_ID})`);
  console.log(`[seed] documents to upload: ${KNOWLEDGE_BASE.length}`);

  // 0. 健康检查
  const health = await api('GET', '/health');
  console.log(`[seed] health: ${JSON.stringify(health)}`);

  // 1. 确定目标版本
  let versionId = targetVersion;
  if (!versionId && !useActive) {
    const name = `logistics-kb-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
    const version = await api('POST', '/versions', JSON.stringify({ name }), { 'content-type': 'application/json' });
    versionId = version.id;
    console.log(`[seed] created version ${name}: ${versionId}`);
    await api('POST', `/versions/${versionId}/activate`, JSON.stringify({}), { 'content-type': 'application/json' });
    console.log(`[seed] version activated`);
  } else if (useActive) {
    const versions = await api('GET', '/versions');
    const active = (Array.isArray(versions) ? versions : versions.versions || []).find((v) => v.status === 'active');
    if (!active) throw new Error('no active version found; run without --use-active to create one');
    versionId = active.id;
    console.log(`[seed] using active version: ${versionId}`);
  } else {
    console.log(`[seed] using given version: ${versionId}`);
  }

  // 2. 逐篇上传并等待索引完成
  const docs = [];
  for (const entry of KNOWLEDGE_BASE) {
    const doc = await uploadDocument(versionId, entry);
    console.log(`[seed] uploaded ${doc.fileName} (document=${doc.documentId}, job=${doc.jobId})`);
    docs.push(doc);
  }

  // 3. 轮询索引状态
  for (const doc of docs) {
    await waitIndexed(doc);
    console.log(`[seed] indexed  ${doc.fileName}`);
  }

  console.log('[seed] done.');
  console.log(`[seed] versionId=${versionId}`);
  console.log('[seed] 建议写入 logistics-cs-demo/.env：');
  console.log(`KNOWLEDGE_API_URL=${API_URL}`);
  console.log(`KNOWLEDGE_TENANT_ID=${TENANT_ID}`);
  console.log(`# KNOWLEDGE_VERSION_ID=${versionId}   # 可选；缺省走平台激活版本（已激活）`);
}

main().catch((err) => {
  console.error(`[seed] failed: ${err.message}`);
  process.exit(1);
});
