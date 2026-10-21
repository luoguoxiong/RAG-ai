// ============ 本地 JSON 持久层：对话历史存储 ============
// 演示期用本地 JSON 文件（data/history.json）持久化所有会话消息；
// 后续接入数据库时只需替换本文件的 getMessages/appendMessage 实现，上层无需改动。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'history.json');

const MAX_MESSAGES_PER_SESSION = 200; // 每个会话最多保留的消息条数

let db = null;

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    db = { sessions: {} };
  }
  if (!db || typeof db !== 'object') db = { sessions: {} };
  if (!db.sessions) db.sessions = {};
  return db;
}

// 原子写入：先写临时文件再 rename，避免写一半损坏
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

export function getMessages(sessionId) {
  const s = load().sessions[sessionId];
  return s ? s.messages : [];
}

/**
 * 追加一条消息：{ role, content, name?, ts? }
 * role: 'user' | 'assistant' | 'human_agent' | 'system'
 */
export function appendMessage(sessionId, msg) {
  const d = load();
  if (!d.sessions[sessionId]) {
    d.sessions[sessionId] = { sessionId, createdAt: Date.now(), messages: [] };
  }
  const s = d.sessions[sessionId];
  s.updatedAt = Date.now();
  s.messages.push({ ts: Date.now(), ...msg });
  while (s.messages.length > MAX_MESSAGES_PER_SESSION) s.messages.shift();
  save();
  return s.messages;
}

// ---------- 人工客服会话状态持久化 ----------
// 人工会话（排队中/已接入）状态挂在会话记录的 human 字段，服务重启后可恢复。
// 形如 { status: 'queued'|'active'|'ended', queuePosition, agent, joinAt, updatedAt }

export function getHumanState(sessionId) {
  const s = load().sessions[sessionId];
  return s && s.human ? { ...s.human } : null;
}

export function setHumanState(sessionId, human) {
  const d = load();
  if (!d.sessions[sessionId]) {
    d.sessions[sessionId] = { sessionId, createdAt: Date.now(), messages: [] };
  }
  const s = d.sessions[sessionId];
  s.updatedAt = Date.now();
  s.human = { ...human, updatedAt: Date.now() };
  save();
  return s.human;
}
