// ============ 长期记忆系统：提取 / 合并更新 / 检索注入 ============
// 设计文档：docs/long-term-memory-design.md
// 数据分层：L2 语义记忆（facts，跨会话用户画像）+ L1 情景记忆（summaries，会话摘要）
// 更新策略：LLM 异步提取 -> 按 (type,key) upsert -> 置信度×新近度 冲突消解 -> TTL/容量淘汰
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { createLlm } from './llm.js';
import * as memstore from './memstore.js';
import * as store from './store.js';
import { pushEvent } from './session.js';

const EXTRACT_DEBOUNCE_MS = 10_000; // 提取去抖窗口：窗口内多轮合并成一次 LLM 调用
const IDLE_SUMMARY_MS = 30 * 60 * 1000; // 会话空闲 30 分钟后生成情景摘要（L1）
const CONTEXT_TTL_MS = 14 * 24 * 60 * 1000; // context 类记忆 TTL（进行中事务）
const TOP_FACTS = 8; // 注入记忆的事实条数上限
const TOP_SUMMARIES = 2; // 注入的最近会话摘要条数
const HABIT_WINDOW = 3; // habit 类滑动窗口：保留最近 3 个不同值

// 事实白名单：type -> 允许的 key（防止 LLM 提取出垃圾记忆）
const WHITELIST = {
  attribute: ['origin_city', 'business_type', 'role'],
  preference: ['product_tier', 'reply_style'],
  habit: ['frequent_dest', 'ask_topics'],
  context: ['active_case']
};
const TYPE_ALIASES = {
  attribute: '客观属性',
  preference: '偏好',
  habit: '行为习惯',
  context: '进行中事务'
};
const KEY_LABELS = {
  origin_city: '常用寄出城市',
  business_type: '业务身份',
  role: '用户角色',
  product_tier: '产品偏好',
  reply_style: '沟通偏好',
  frequent_dest: '常寄目的地',
  ask_topics: '常问话题',
  active_case: '进行中事务'
};
// recency 半衰期（天）：变化越慢的记忆半衰期越长
const HALF_LIFE_DAYS = { attribute: 90, preference: 60, habit: 30, context: 14 };

// ---------- 基础计算 ----------
function recencyOf(fact) {
  const halfLife = HALF_LIFE_DAYS[fact.type] ?? 60;
  const days = (Date.now() - (fact.updatedAt || fact.createdAt || Date.now())) / 86_400_000;
  return Math.pow(0.5, Math.max(0, days) / halfLife);
}
function scoreOf(fact) {
  return (fact.confidence ?? 0.5) * recencyOf(fact);
}
function clamp01(n, fallback) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}
function factValueText(f) {
  return Array.isArray(f.value) ? f.value.join('、') : String(f.value ?? '');
}

// ---------- 惰性清理：读取时顺手归档过期/低置信记忆 ----------
function sweepExpired(user) {
  const now = Date.now();
  let changed = false;
  for (const f of user.facts) {
    if (f.status !== 'active') continue;
    const expired = f.expiresAt && now > f.expiresAt;
    const tooWeak = (f.confidence ?? 0.5) < 0.3;
    if (expired || tooWeak) {
      f.status = 'archived';
      f.archivedAt = now;
      changed = true;
    }
  }
  if (changed) user.updatedAt = now;
  return changed;
}

// ---------- 记忆检索与注入（buildContext） ----------
// 返回 { block, usedFacts }；block 拼入 system prompt 后的独立 SystemMessage
export function buildContext(userId) {
  if (!userId) return { block: '', usedFacts: [] };
  const user = memstore.readUser(userId, { withCopy: false });
  if (!user) return { block: '', usedFacts: [] };
  if (sweepExpired(user)) memstore.mutateUser(userId, () => {}); // sweep 已原地改 user，这里仅触发落盘

  const facts = user.facts
    .filter((f) => f.status === 'active')
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, TOP_FACTS);
  const summaries = (user.summaries || []).slice(-TOP_SUMMARIES);

  const lines = facts.map((f) => {
    const label = KEY_LABELS[`${f.type}.${f.key}`] || KEY_LABELS[f.key] || f.key;
    return `- ${label}：${factValueText(f)}（依据："${String(f.evidence || '').slice(0, 30)}"）`;
  });
  if (summaries.length) {
    lines.push(
      '- 最近沟通：' + summaries.map((s) => String(s.summary || '').slice(0, 40)).join('；')
    );
  }
  if (!lines.length) return { block: '', usedFacts: facts };

  const block =
    '[用户长期记忆 —— 可能过时，仅供参考；与用户当前表述冲突时，一律以用户当前表述为准，不要主动复述本块内容]\n' +
    lines.join('\n');
  return { block, usedFacts: facts };
}

// 工具兜底：query_freight 未传 origin 时从记忆补默认寄出城市
export function recallFact(userId, type, key) {
  if (!userId) return null;
  const facts = memstore.listFacts(userId, 'active');
  return facts.find((f) => f.type === type && f.key === key) || null;
}

// ---------- LLM 结构化提取 ----------
const EXTRACT_SYSTEM = `你是物流客服系统的用户记忆抽取器。从对话中抽取值得长期记住的用户信息，用于跨会话个性化服务。

可抽取字段白名单（type.key）：
- attribute.origin_city 用户常用寄出城市（如"我常从杭州发货"）
- attribute.business_type 业务身份（如 电商卖家/微商/个人寄件）
- attribute.role 用户角色（如 商家/个人）
- preference.product_tier 产品偏好（如 偏好特快/倾向经济型）
- preference.reply_style 沟通偏好（如 喜欢简洁分点）
- habit.frequent_dest 常寄目的地城市（单个城市名，系统自动维护最近3个）
- habit.ask_topics 常问话题（如 禁运品/理赔）
- context.active_case 进行中的事务（如"运单 SF1234567890 正在理赔"）

只输出 JSON，不要输出其他文字：
{"ops":[
  {"op":"upsert","type":"attribute","key":"origin_city","value":"杭州","confidence":0.9,"source":"explicit","evidence":"用户原话片段"},
  {"op":"delete","type":"attribute","key":"origin_city","reason":"用户否认或要求忘记"}
]}

规则：
1. 只输出白名单内的 type.key；宁缺毋滥，一组对话通常 0~2 条 op，无值得记的内容输出 {"ops":[]}
2. 用户明确声明或要求记住 -> source=explicit、confidence=1.0；仅从上下文推断 -> source=inferred、confidence 0.5~0.8
3. 用户否认/纠正旧信息（"不对/我不是/改成"）-> 对该 key 输出新值 upsert（source=explicit）；"别记了/忘记这条" -> op=delete
4. 与"现有记忆"重复且无新增信息 -> 不要输出
5. 手机号、身份证、详细住址、银行卡等敏感信息一律不抽取
6. value 必须是简短短语（≤20字），evidence 保留用户原话片段（≤30字）`;

function parseJsonLoose(text) {
  const s = String(text ?? '').replace(/```json|```/g, '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function validOp(op) {
  if (!op || typeof op !== 'object') return false;
  if (!WHITELIST[op.type]?.includes(op.key)) return false;
  if (op.op === 'delete') return Boolean(op.reason || op.value);
  return op.op === 'upsert' && op.value !== undefined && String(op.value).trim() !== '';
}

async function llmExtractOps(dialogues, existingFacts) {
  const llm = createLlm({ temperature: 0 });
  const factsText = existingFacts.length
    ? existingFacts.map((f) => `- ${f.type}.${f.key} = ${factValueText(f)}（置信度 ${f.confidence}）`).join('\n')
    : '（暂无）';
  const dialogueText = dialogues
    .map((m) => `${m.role === 'user' ? '用户' : '客服'}：${String(m.content).slice(0, 400)}`)
    .join('\n');

  const res = await llm.invoke([
    new SystemMessage(EXTRACT_SYSTEM),
    new HumanMessage(`【现有记忆】\n${factsText}\n\n【最近对话】\n${dialogueText}`)
  ]);
  const parsed = parseJsonLoose(res.content);
  const ops = Array.isArray(parsed?.ops) ? parsed.ops.filter(validOp) : [];
  return ops.slice(0, 4); // 单次提取最多应用 4 条，防失控
}

// ---------- 合并与冲突消解（§5.2 核心更新策略） ----------
// 返回 [{ action: 'created'|'updated'|'deleted', type, key, value, label }]
function applyOps(user, ops) {
  const events = [];
  const now = Date.now();

  for (const op of ops) {
    const facts = user.facts;
    const old = facts.find((f) => f.status === 'active' && f.type === op.type && f.key === op.key);
    const label = KEY_LABELS[`${op.type}.${op.key}`] || op.key;

    // 删除：用户否认/要求忘记 -> superseded（软删除，可回溯）
    if (op.op === 'delete') {
      if (!old) continue;
      old.status = 'superseded';
      old.archivedAt = now;
      events.push({ action: 'deleted', type: op.type, key: op.key, label, value: '' });
      continue;
    }

    const source = op.source === 'explicit' ? 'explicit' : 'inferred';
    const newConfidence = source === 'explicit' ? 1.0 : clamp01(op.confidence, 0.6);

    // habit 类：维护最近 N 个不同值的滑动窗口，不做单值覆盖
    if (op.type === 'habit' && old) {
      const window = Array.isArray(old.value) ? old.value : [String(old.value)];
      const v = String(op.value);
      const next = [v, ...window.filter((x) => x !== v)].slice(0, HABIT_WINDOW);
      if (JSON.stringify(next) === JSON.stringify(window) && source !== 'explicit') continue;
      old.value = next;
      old.confidence = Math.max(old.confidence, newConfidence);
      old.evidence = op.evidence || old.evidence;
      old.source = source;
      old.updatedAt = now;
      events.push({ action: 'updated', type: op.type, key: op.key, label, value: next.join('、') });
      continue;
    }

    // 无同名事实 -> 新增
    if (!old) {
      facts.push({
        id: `f_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        type: op.type,
        key: op.key,
        value: op.value,
        confidence: newConfidence,
        evidence: String(op.evidence || '').slice(0, 60),
        source,
        hits: 0,
        createdAt: now,
        updatedAt: now,
        expiresAt: op.type === 'context' ? now + CONTEXT_TTL_MS : null,
        status: 'active',
        history: []
      });
      events.push({ action: 'created', type: op.type, key: op.key, label, value: factValueText({ value: op.value }) });
      continue;
    }

    // 值相同 -> 命中加权（hits/confidence/updatedAt 由 bump 处理，这里只处理显式重申）
    const sameValue = factValueText(old) === String(op.value);
    if (sameValue) {
      old.confidence = Math.min(1, Math.max(old.confidence, newConfidence));
      old.evidence = op.evidence || old.evidence;
      old.updatedAt = now;
      if (source === 'explicit') {
        events.push({ action: 'updated', type: op.type, key: op.key, label, value: factValueText(old) });
      }
      continue;
    }

    // 值冲突：用户显式纠正/明说 -> 无条件覆盖；否则按 score 消解
    const newScore = newConfidence; // 新证据发生在当下，recency = 1
    const oldScore = scoreOf(old);
    const decisive = source === 'explicit';
    if (!decisive && newScore < oldScore - 0.2) {
      old.confidence = Math.max(0, old.confidence - 0.2); // 被矛盾但未覆盖：降置信
      old.updatedAt = now;
      continue;
    }
    // 覆盖：旧值压入 history[] 归档
    old.history.push({ value: old.value, evidence: old.evidence, archivedAt: now });
    if (old.history.length > 5) old.history.shift();
    old.value = op.value;
    old.confidence = newConfidence;
    old.evidence = String(op.evidence || '').slice(0, 60);
    old.source = source;
    old.updatedAt = now;
    old.expiresAt = op.type === 'context' ? now + CONTEXT_TTL_MS : old.expiresAt;
    events.push({ action: 'updated', type: op.type, key: op.key, label, value: factValueText(old) });
  }

  return events;
}

// ---------- 提取调度（fire-and-forget，不阻塞主回答链路） ----------
const pendingExtracts = new Map(); // userId -> { timer, sessionId, dialogues }
const idleTimers = new Map(); // sessionId -> timer

export function scheduleExtraction({ userId, sessionId, userMsg, assistantMsg }) {
  if (!userId) return;
  const p = pendingExtracts.get(userId) || { timer: null, sessionId, dialogues: [] };
  p.sessionId = sessionId;
  if (userMsg) p.dialogues.push({ role: 'user', content: userMsg });
  if (assistantMsg) p.dialogues.push({ role: 'assistant', content: assistantMsg });
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    pendingExtracts.delete(userId);
    runExtraction(userId, p.sessionId, p.dialogues).catch((err) =>
      console.warn('[memory] 记忆提取失败:', err?.message || err)
    );
  }, EXTRACT_DEBOUNCE_MS);
  pendingExtracts.set(userId, p);
}

async function runExtraction(userId, sessionId, dialogues) {
  if (!dialogues.length) return;
  const existingFacts = memstore.listFacts(userId, 'active');
  const ops = await llmExtractOps(dialogues, existingFacts);
  if (!ops.length) return;

  const events = memstore.mutateUser(userId, (user) => {
    sweepExpired(user);
    return applyOps(user, ops);
  });
  // 提取结果经会话级 SSE 通道通知前端（徽章：已记住 / 已更新 / 已忘记）
  for (const ev of events) {
    pushEvent(sessionId, 'memory_saved', ev);
  }
}

// ---------- 情景记忆（L1）：会话摘要 ----------
// 每轮回答后重置空闲计时器；空闲超时 / 人工会话结束时触发摘要提取
export function scheduleIdleSummary({ userId, sessionId }) {
  if (!userId || !sessionId) return;
  clearTimeout(idleTimers.get(sessionId));
  idleTimers.set(
    sessionId,
    setTimeout(() => {
      idleTimers.delete(sessionId);
      summarizeSession({ userId, sessionId }).catch((err) =>
        console.warn('[memory] 会话摘要失败:', err?.message || err)
      );
    }, IDLE_SUMMARY_MS)
  );
}

export function cancelIdleSummary(sessionId) {
  clearTimeout(idleTimers.get(sessionId));
  idleTimers.delete(sessionId);
}

// 摘要已有更新的版本则跳过（以会话最后一条消息时间为基准去重）
export async function summarizeSession({ userId, sessionId }) {
  const msgs = (await store.getMessages(sessionId)).filter((m) => m.role === 'user' || m.role === 'assistant');
  if (!msgs.length) return false;
  const lastTs = msgs[msgs.length - 1].ts || 0;
  const existing = memstore.getSummaries(userId).find((s) => s.sessionId === sessionId);
  if (existing && existing.untilTs >= lastTs) return false;

  const llm = createLlm({ temperature: 0 });
  const dialogueText = msgs
    .slice(-12)
    .map((m) => `${m.role === 'user' ? '用户' : '客服'}：${String(m.content).slice(0, 200)}`)
    .join('\n');
  const res = await llm.invoke([
    new SystemMessage(
      '把物流客服对话压缩成一条不超过40字的中文摘要，包含关键实体（运单号/城市/问题），只输出摘要本身。'
    ),
    new HumanMessage(dialogueText)
  ]);
  const summary = String(res.content ?? '').trim().slice(0, 60);
  if (!summary) return false;
  memstore.appendSummary(userId, { sessionId, summary, untilTs: lastTs, ts: Date.now() });
  return true;
}

// ---------- 调试/管理 ----------
// 工具侧展示用：{ label, value }
export function factDisplay(fact) {
  const label = KEY_LABELS[`${fact.type}.${fact.key}`] || fact.key;
  return { label, value: factValueText(fact) };
}
export { bumpFact } from './memstore.js';

// 管理接口的薄封装：单条删除（软删）与"忘记我"（清空全部）
export function deleteFact(userId, factId) {
  return memstore.archiveFact(userId, factId, 'superseded');
}
export function forgetAll(userId) {
  return memstore.forgetUser(userId);
}

export function getMemoryView(userId) {
  const u = memstore.readUser(userId);
  if (!u) return { userId, facts: [], summaries: [] };
  const facts = u.facts
    .filter((f) => f.status === 'active')
    .map((f) => ({
      id: f.id,
      type: f.type,
      key: f.key,
      label: KEY_LABELS[`${f.type}.${f.key}`] || f.key,
      typeLabel: TYPE_ALIASES[f.type] || f.type,
      value: factValueText(f),
      confidence: Math.round((f.confidence ?? 0.5) * 100) / 100,
      evidence: f.evidence,
      source: f.source,
      hits: f.hits || 0,
      updatedAt: f.updatedAt,
      versions: (f.history || []).length
    }));
  return { userId, facts, summaries: u.summaries || [] };
}
