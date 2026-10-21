// ============ 长期记忆持久层：data/memory.json ============
// 结构与读写模式对齐 store.js（同步读 + 临时文件 rename 原子写）。
// 只提供数据原语，提取/合并/衰减等策略见 memory.js。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'memory.json');

const MAX_FACTS_PER_USER = 100; // 每用户 active 事实上限，超出按 score 淘汰
const MAX_SUMMARIES_PER_USER = 20; // 每用户会话摘要上限，超出按时间淘汰

let db = null;

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    db = {};
  }
  if (!db || typeof db !== 'object') db = {};
  return db;
}

// 原子写入：先写临时文件再 rename，避免写一半损坏
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function ensureUser(d, userId) {
  if (!d.users) d.users = {};
  if (!d.users[userId]) {
    d.users[userId] = {
      userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      facts: [],
      summaries: []
    };
  }
  return d.users[userId];
}

// 读用户记忆（不存在返回 null）；withCopy=true 返回深拷贝，避免外部改动内部引用
export function readUser(userId, { withCopy = true } = {}) {
  const u = load().users?.[userId];
  if (!u) return null;
  return withCopy ? JSON.parse(JSON.stringify(u)) : u;
}

// 事务式修改：fn(user) 内直接改 user 对象，返回 false 表示未变更不落盘
export function mutateUser(userId, fn) {
  const d = load();
  const u = ensureUser(d, userId);
  const result = fn(u);
  if (result !== false) {
    u.updatedAt = Date.now();
    save();
  }
  return result;
}

export function listFacts(userId, status = 'active') {
  const u = readUser(userId);
  if (!u) return [];
  return u.facts.filter((f) => !status || f.status === status);
}

export function getSummaries(userId) {
  const u = readUser(userId);
  return u ? u.summaries : [];
}

// 新增/更新一条事实（fact 由调用方构造完整对象，含 id）
export function putFact(userId, fact) {
  return mutateUser(userId, (u) => {
    const idx = u.facts.findIndex((f) => f.id === fact.id);
    if (idx >= 0) u.facts[idx] = fact;
    else u.facts.push(fact);
    enforceCapacity(u);
  });
}

// 命中记忆：hits+1、confidence 微升并刷新 updatedAt（提升 recency）
export function bumpFact(userId, factId) {
  return mutateUser(userId, (u) => {
    const f = u.facts.find((x) => x.id === factId);
    if (!f) return false;
    f.hits = (f.hits || 0) + 1;
    f.confidence = Math.min(1, (f.confidence ?? 0.5) + 0.05);
    f.updatedAt = Date.now();
  });
}

// 软删除：status 置为 archived/superseded，保留记录可回溯
export function archiveFact(userId, factId, status = 'archived') {
  return mutateUser(userId, (u) => {
    const f = u.facts.find((x) => x.id === factId);
    if (!f) return false;
    f.status = status;
  });
}

export function deleteFactPhysical(userId, factId) {
  return mutateUser(userId, (u) => {
    const idx = u.facts.findIndex((x) => x.id === factId);
    if (idx < 0) return false;
    u.facts.splice(idx, 1);
  });
}

export function appendSummary(userId, summary) {
  return mutateUser(userId, (u) => {
    u.summaries.push(summary);
    while (u.summaries.length > MAX_SUMMARIES_PER_USER) u.summaries.shift();
  });
}

// "忘记我"：清空该用户全部记忆（合规）
export function forgetUser(userId) {
  const d = load();
  if (!d.users || !d.users[userId]) return false;
  delete d.users[userId];
  save();
  return true;
}

// 容量上限：active 事实超过 MAX 时按 score（confidence × recency 的简化版：confidence × 时间序）淘汰最低分
// recency 计算依赖 memory.js 的类型半衰期配置，这里用 updatedAt 近似（最旧的先淘汰），策略层已保证 confidence 影响排序展示
function enforceCapacity(u) {
  const active = u.facts.filter((f) => f.status === 'active');
  if (active.length <= MAX_FACTS_PER_USER) return;
  active
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, active.length - MAX_FACTS_PER_USER)
    .forEach((f) => {
      f.status = 'archived';
    });
}
