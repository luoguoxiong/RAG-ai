// ============ 会话编排：LangGraph Agent 调用 + 转人工快速路径 + 槽位补全 + 长期记忆 ============
// Agent 的 ReAct 循环由 LangGraph 负责（见 graph.js），本文件只处理"会话层"的事情：
//   - 拼装上下文（SystemPrompt + 长期记忆 + 历史对话）→ 交给图
//   - 明确转人工：不经 LLM 的确定性快速路径
//   - 缺城市槽位：规则快速路径弹窗 / 图内 interrupt() 挂起，两种来源统一由 /api/chat/slots 恢复
//   - 回复落库、记忆提取调度
import { randomUUID } from 'node:crypto';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { CITY_LIST, BRANCH_CITIES, CITY_INFO } from './data.js';
import { startHumanSession, isHumanActive } from './session.js';
import { DEEPSEEK_API_KEY } from './llm.js';
import {
  buildAgentGraph,
  streamAgentTurn,
  releaseThread,
  registerPendingThread,
  unregisterPendingThread
} from './graph.js';
import * as slotstore from './slotstore.js';
import * as store from './store.js';
import {
  buildContext,
  recallFact,
  factDisplay,
  scheduleExtraction,
  scheduleIdleSummary
} from './memory.js';
import { truncate, streamFixed } from './utils.js';

const HISTORY_LIMIT = 20; // 构建 LLM 上下文时最多带的历史轮数

const SYSTEM_PROMPT = `你是"小邮"，物流公司的智能客服助手，使用简体中文与用户交流。

你可以调用以下工具：
1. query_shipment —— 查询运单物流状态。仅当用户提供了运单号时调用；未提供时先礼貌询问运单号，不要调用。
2. query_freight —— 估算运费与时效。从用户消息中抽取寄出城市、目的城市与重量（公斤）传入；重量未知传 1。用户只要表达了查运费/时效的意图就**立即调用**：目的地明确就传 destination；目的地未明确（如只说"从杭州寄"、只说重量、或目的地不是具体城市）就**不要传 destination，也不要用文字追问**，系统会自动弹出地址选择面板让用户补充；寄出城市未说明可不传，系统按默认城市估算并说明。
3. query_knowledge —— 检索寄递知识库，适用于禁运品、包装、理赔、保价、偏远地区、拒收退回、节假日、上门取件等政策类问题。
4. query_branches —— 查询营业网点/自提点（地址、电话、营业时间、可办业务）。从用户消息中抽取城市与可选筛选条件（区县、地标、业务类型如自提/大件/冷链）传入；城市明确就立即调用；用户想查网点但**没说城市**时，不要用文字追问，直接调用本工具且不传 city，系统会引导用户通过地址选择弹窗补充。
5. transfer_human —— 用户要求转人工、找真人客服或投诉时，必须调用此工具。注意：只回复"正在为您转接"之类的文字而**不调用工具**是不允许的，那样用户永远等不到人工。即使历史对话里出现过仅文字回应的情况，也必须调用工具。

回答要求：
- 基于工具返回的数据作答，严禁编造运单信息、价格或政策；未查到就如实告知。
- 语气专业、友好、简洁；关键信息（状态、价格、时效等）用 **加粗**；多条信息用分点列表。
- 用户有多个需求时可依次调用多个工具，全部完成后再统一回答。
- 调用 transfer_human 后只需简短告知用户正在转接人工，排队细节由系统提示，无需展开。`;

const TRANSFER_REPLY =
  '好的，已为您发起转接人工客服的请求，正在为您寻找合适的客服（服务时间 08:00-22:00）。\n转接成功后您可以直接与客服沟通；想返回智能客服，点击"结束人工会话"即可。';

// 明确的转人工请求（去掉标点空白后整句匹配）——不经 LLM 决策，保证必转成功
function isExplicitTransferRequest(message) {
  const stripped = String(message || '').replace(/[\s!！。？?~～，,]/g, '');
  return /^(转(接)?(个)?人工(客服)?|找(人工|真人)|真人客服|人工服务|我要(转人工|投诉)|投诉)$/.test(stripped);
}

// 确定性意图识别（快速路径）：运费/网点意图明确但消息不含任何已知城市 -> 直接弹窗补参。
// LLM 提示词约束不可靠（实测 deepseek-chat 仍会文字追问），规则路径保证"缺城市必弹窗"体验；
// 复杂表述（带上下文、口语化）仍由图内的 interrupt() 兜底。
const BRANCH_INTENT_RE = /网点|营业点|门店|自提点|驿站|营业厅/;
const FREIGHT_INTENT_RE =
  /运费|邮费|快递费|多少钱|几块钱|怎么收费|价格|时效|几天到|多久到|几天能到|多久能到|寄东西|寄快递|发快递|寄件/;
// 政策咨询词优先于运费/网点判断：如"保价怎么收费"是知识库问题而非查运费，
// 不能被"怎么收费"误触发缺城市弹窗
const KNOWLEDGE_INTENT_RE =
  /禁运|不能寄|可以寄|能寄吗|能寄|理赔|保价|包装|拒收|退回|节假日|上门取件|冷链|锂电池|充电宝/;
// 省份名：提及省份视为"地点明确"（query_branches 支持按省检索），交给 LLM 直接调工具
const PROVINCE_LIST = [...new Set(Object.values(CITY_INFO).map((c) => c.province))];
function detectCityIntent(message) {
  const m = String(message || '');
  if (KNOWLEDGE_INTENT_RE.test(m)) return null; // 政策咨询：交给 LLM 调知识库工具
  if (CITY_LIST.some((c) => m.includes(c)) || PROVINCE_LIST.some((p) => m.includes(p))) {
    return null; // 含城市/省份：交给 LLM 直接调工具
  }
  if (BRANCH_INTENT_RE.test(m)) return 'query_branches';
  if (FREIGHT_INTENT_RE.test(m)) return 'query_freight';
  return null;
}

// ---------- 待补参队列 ----------
// 存储外置到 slotstore（Redis 原生 TTL + GETDEL 原子取出；未配 REDIS_URL 则进程内存降级）：
//   sessionId -> { threadId, intent, originalMessage, missing, createdAt }
//   threadId 非空表示"图已中断"，提交后走 Command 续跑；为空表示规则快速路径，提交后重新发起一轮对话。
// 多实例收益：A 实例弹窗挂起 -> B 实例可提交续跑；重启不丢挂起；过期由 Redis TTL 原生保证。

async function discardPending(sessionId) {
  const p = await slotstore.getPending(sessionId);
  if (!p) return;
  await slotstore.delPending(sessionId);
  if (p.threadId) {
    void releaseThread(p.threadId);
    void unregisterPendingThread(p.threadId);
  }
}

async function takePending(sessionId, intent) {
  const p = await slotstore.takePending(sessionId); // 原子取出，防并发/跨实例重复提交
  if (!p || p.intent !== intent) {
    throw Object.assign(new Error('没有待补充的查询，请重新描述您的需求'), { status: 409 });
  }
  if (Date.now() - p.createdAt > slotstore.PENDING_SLOTS_TTL) {
    if (p.threadId) {
      void releaseThread(p.threadId);
      void unregisterPendingThread(p.threadId);
    }
    throw Object.assign(new Error('选择已超时，请重新描述您的需求'), { status: 410 });
  }
  if (p.threadId) void unregisterPendingThread(p.threadId); // 提交成功：摘除注册表，检查点由本轮收尾释放
  return p;
}

// 只读探测：供路由在进入 SSE 前校验（返回 JSON 错误码）
export async function hasPendingSlots(sessionId, intent) {
  const p = await slotstore.getPending(sessionId);
  return !!p && p.intent === intent && Date.now() - p.createdAt <= slotstore.PENDING_SLOTS_TTL;
}

// ---------- 每进程并发闸 ----------
// 防御性兜底：限制本进程同时在处理的 LLM 轮次（图执行 + 槽位续跑），防突发流量打爆上游。
// 超限快速失败 429，与入口限流（ratelimit.js，跨实例共享窗口）构成两级防护。
const MAX_CONCURRENT_TURNS = Number(process.env.MAX_CONCURRENT_TURNS) || 16;
let activeTurns = 0;

function acquireTurn() {
  if (activeTurns >= MAX_CONCURRENT_TURNS) return false;
  activeTurns += 1;
  return true;
}

function releaseTurn() {
  activeTurns -= 1;
}

// ---------- 上下文拼装 ----------
// 对话历史以 PostgreSQL 为准（含本轮刚写入的用户消息），每轮重新注入图状态
async function buildSeedMessages({ sessionId, userId }) {
  const memory = await buildContext(userId); // PG 版记忆为异步读取
  const history = (await store.getMessages(sessionId))
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-HISTORY_LIMIT)
    .map((m) => (m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)));

  return [
    new SystemMessage(SYSTEM_PROMPT),
    ...(memory.block ? [new SystemMessage(memory.block)] : []),
    ...history
  ];
}

// ---------- 一轮图执行 ----------
async function runGraphTurn({ sessionId, userId, send, originalMessage, userMessage, resume }) {
  const threadId = resume?.threadId || randomUUID();
  const graph = buildAgentGraph({ sessionId, userId, send, originalMessage });
  const input = resume ? new Command({ resume: resume.slots }) : { messages: await buildSeedMessages({ sessionId, userId }) };

  let keepThread = false;
  try {
    const { text, interrupted } = await streamAgentTurn({ graph, input, threadId, send });

    console.log('interrupted',interrupted)
    // 图被 interrupt() 挂起：登记 thread（检查点已落 PostgreSQL，可跨实例续跑），等前端弹窗补参
    if (interrupted && interrupted.intent) {
      keepThread = true;
      // 注册表先行：无论后续 Redis 写入成败，残留检查点都能被 sweeper 兜底释放
      await registerPendingThread(threadId, sessionId);
      const stored = await slotstore.putPending(sessionId, {
        threadId,
        intent: interrupted.intent,
        originalMessage,
        missing: interrupted.missing || [],
        createdAt: Date.now()
      });
      if (!stored) console.warn('[slots] 进程挂起登记已达上限，弹窗提交可能不可用（容量保护）');
      send('ask_location', {
        intent: interrupted.intent,
        missing: interrupted.missing || [],
        originMemory: interrupted.originMemory ?? null,
        preset: interrupted.preset || {}
      });
      send('done', { intent: interrupted.intent, mode: 'slot_filling' });
      return;
    }

    await finishTurn({ sessionId, userId, send, text, userMessage });
  } finally {
    if (!keepThread) void releaseThread(threadId); // 本轮已结束，释放检查点
  }
}

// 收口：落库回答 + 转人工兜底 + 长期记忆调度 + done 事件
async function finishTurn({ sessionId, userId, send, text, userMessage }) {
  if (text.trim()) {
    await store.appendMessage(sessionId, { role: 'assistant', content: text });
  }

  // 兜底：用户明确要转人工，模型嘴上说"正在/已转接"却没调工具 -> 补触发，避免用户干等。
  // 只识别"声称已转接"的陈述句式，不识别"可以为您转接/需要我帮您转接吗"这类提议，避免误伤（如"投诉流程是什么"）。
  const claimsTransferred =
    /正在.{0,4}转(接|入工)|已.{0,4}转(接|入工)|已.{0,4}(发起|提交).{0,6}(转接|转人工|人工)/.test(text);
  if (!(await isHumanActive(sessionId)) && /人工|真人|投诉/.test(userMessage) && claimsTransferred) {
    await startHumanSession(sessionId);
  }

  // 长期记忆：任务入队（落库后由后台 worker 执行，不阻塞已结束的回复流）+ 刷新会话摘要空闲窗口
  if (userId) {
    await Promise.all([
      scheduleExtraction({ userId, sessionId, userMsg: userMessage, assistantMsg: text }),
      scheduleIdleSummary({ userId, sessionId })
    ]).catch((err) => console.warn('[memory] 记忆任务入队失败:', err?.message || err));
  }

  send('done', { intent: 'llm', mode: 'agent' });
}

// ---------- 入口：用户发消息 ----------
async function handleAgentMessageInner({ sessionId, message, userId, send }) {
  // 先持久化用户消息，再从存储构建上下文
  await store.appendMessage(sessionId, { role: 'user', content: message });

  // 明确的转人工请求：走固定流程，不经 LLM 决策，保证必转成功（未配置 LLM key 也可转人工）
  if (isExplicitTransferRequest(message)) {
    send('status', { step: 'intent', label: '意图：转接人工', state: 'done' });
    send('status', { step: 'transfer', label: '发起转人工', state: 'active' });
    await startHumanSession(sessionId);
    await streamFixed(send, TRANSFER_REPLY);
    send('status', { step: 'transfer', label: '已发起转接，等待客服接入', state: 'done' });
    send('done', { intent: 'transfer_human', mode: 'human' });
    return;
  }

  if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY 未配置，请在项目根目录 .env 中配置');
  }

  // 上一轮遗留的弹窗（用户没补参直接问了新问题）作废，避免悬挂的检查点泄漏
  await discardPending(sessionId);

  // 确定性意图识别快速路径：意图明确但缺城市 -> 挂起并弹窗，不经 LLM
  // const fastIntent = detectCityIntent(message);
  // if (fastIntent) {
  //   const memFact = await recallFact(userId, 'attribute', 'origin_city');
  //   const stored = await slotstore.putPending(sessionId, {
  //     threadId: null, // 未进图：提交后按补全结果重新发起一轮对话
  //     intent: fastIntent,
  //     originalMessage: message,
  //     missing: fastIntent === 'query_freight' ? ['destination'] : ['city'],
  //     createdAt: Date.now()
  //   });
  //   if (!stored) {
  //     throw Object.assign(new Error('当前咨询人数较多，请稍后再试'), { status: 503 });
  //   }
  //   send('status', {
  //     step: 'intent',
  //     label: `意图：${fastIntent === 'query_freight' ? '查运费时效（缺城市）' : '查网点（缺城市）'}`,
  //     state: 'done'
  //   });
  //   send('ask_location', {
  //     intent: fastIntent,
  //     missing: fastIntent === 'query_freight' ? ['destination'] : ['city'],
  //     originMemory: memFact ? factDisplay(memFact).value : null,
  //     preset: {}
  //   });
  //   send('done', { intent: fastIntent, mode: 'slot_filling' });
  //   return;
  // }

  await runGraphTurn({ sessionId, userId, send, originalMessage: message, userMessage: message });
}

// 对外入口统一过并发闸（转人工快速路径不经 LLM，也一并计数，保证总量受控）
export async function handleAgentMessage(opts) {
  if (!acquireTurn()) {
    throw Object.assign(new Error('当前咨询人数较多，请稍后再试'), { status: 429 });
  }
  try {
    return await handleAgentMessageInner(opts);
  } finally {
    releaseTurn();
  }
}

// ---------- 槽位补全（弹窗选地址后恢复执行） ----------
function slotText(intent, s) {
  return intent === 'query_freight'
    ? `寄出城市 ${s.origin || '杭州'}，目的地 ${s.destination}，重量 ${Number(s.weightKg) || 1} 公斤`
    : `城市 ${s.city}${s.keyword ? `，筛选 ${s.keyword}` : ''}`;
}

export async function handleSlotSubmit({ sessionId, intent, slots, userId, send }) {
  if (!acquireTurn()) {
    throw Object.assign(new Error('当前咨询人数较多，请稍后再试'), { status: 429 });
  }
  try {
    const pending = await takePending(sessionId, intent);
    const s = slots || {};
    const desc = slotText(intent, s);
    const mergedUserText = `${pending.originalMessage}（已选择：${desc}）`;

    send('status', { step: 'slots', label: '已收到地址选择', detail: truncate(desc, 40), state: 'done' });
    await store.appendMessage(sessionId, { role: 'user', content: mergedUserText });

    if (pending.threadId) {
      // 图已中断：用 Command 从断点续跑（检查点在 PostgreSQL，任意实例均可接手）
      await runGraphTurn({
        sessionId,
        userId,
        send,
        originalMessage: pending.originalMessage,
        userMessage: mergedUserText,
        resume: { threadId: pending.threadId, slots: s }
      });
      return;
    }

    // 规则快速路径：把补全后的地址并入用户消息，重新走一轮图（工具参数仍由 LLM 抽取）
    await runGraphTurn({ sessionId, userId, send, originalMessage: pending.originalMessage, userMessage: mergedUserText });
  } finally {
    releaseTurn();
  }
}

// 弹窗下拉数据源
export function getCityOptions() {
  return { freightCities: CITY_LIST, branchCities: BRANCH_CITIES };
}
