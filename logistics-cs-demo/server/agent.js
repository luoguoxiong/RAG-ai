// ============ Agent 编排：LangChain + DeepSeek 真实 LLM 工具调用（SSE 流式） ============
import { tool } from '@langchain/core/tools';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { queryShipment, queryFreight, queryKnowledge, queryBranches } from './tools.js';
import { CITY_LIST, BRANCH_CITIES } from './data.js';
import { startHumanSession, isHumanActive } from './session.js';
import { createLlm, DEEPSEEK_API_KEY } from './llm.js';
import * as store from './store.js';
import {
  buildContext,
  recallFact,
  factDisplay,
  bumpFact,
  scheduleExtraction,
  scheduleIdleSummary
} from './memory.js';

const MAX_ITERATIONS = 4; // 最多工具调用轮数
const HISTORY_LIMIT = 20; // 构建 LLM 上下文时最多带的历史轮数
const PENDING_SLOTS_TTL = 10 * 60 * 1000; // 槽位挂起有效期：超时后需重新提问

const SYSTEM_PROMPT = `你是"小邮"，物流公司的智能客服助手，使用简体中文与用户交流。

你可以调用以下工具：
1. query_shipment —— 查询运单物流状态。仅当用户提供了运单号时调用；未提供时先礼貌询问运单号，不要调用。
2. query_freight —— 估算运费与时效。从用户消息中抽取寄出城市、目的城市与重量（公斤）传入；重量未知传 1。只要目的地城市明确就立即调用（寄出城市未知可不传，系统会按默认城市估算并说明）；用户想查运费/时效但**没有提到任何城市**时，不要用文字追问，直接调用本工具且不传城市参数，系统会引导用户通过地址选择弹窗补充。
3. query_knowledge —— 检索寄递知识库，适用于禁运品、包装、理赔、保价、偏远地区、拒收退回、节假日、上门取件等政策类问题。
4. query_branches —— 查询营业网点/自提点（地址、电话、营业时间、可办业务）。从用户消息中抽取城市与可选筛选条件（区县、地标、业务类型如自提/大件/冷链）传入；城市明确就立即调用；用户想查网点但**没说城市**时，不要用文字追问，直接调用本工具且不传 city，系统会引导用户通过地址选择弹窗补充。
5. transfer_human —— 用户要求转人工、找真人客服或投诉时，必须调用此工具。注意：只回复"正在为您转接"之类的文字而**不调用工具**是不允许的，那样用户永远等不到人工。即使历史对话里出现过仅文字回应的情况，也必须调用工具。

回答要求：
- 基于工具返回的数据作答，严禁编造运单信息、价格或政策；未查到就如实告知。
- 语气专业、友好、简洁；关键信息（状态、价格、时效等）用 **加粗**；多条信息用分点列表。
- 用户有多个需求时可依次调用多个工具，全部完成后再统一回答。
- 调用 transfer_human 后只需简短告知用户正在转接人工，排队细节由系统提示，无需展开。`;

const TRANSFER_REPLY = '好的，已为您发起转接人工客服的请求，正在为您寻找合适的客服（服务时间 08:00-22:00）。\n转接成功后您可以直接与客服沟通；想返回智能客服，点击"结束人工会话"即可。';

// 明确的转人工请求（去掉标点空白后整句匹配）——不经 LLM 决策，保证必转成功
function isExplicitTransferRequest(message) {
  const stripped = String(message || '').replace(/[\s!！。？?~～，,]/g, '');
  return /^(转(接)?(个)?人工(客服)?|找(人工|真人)|真人客服|人工服务|我要(转人工|投诉)|投诉)$/.test(stripped);
}

// 确定性意图识别（快速路径）：运费/网点意图明确但消息不含任何已知城市 -> 直接弹窗补参。
// LLM 提示词约束不可靠（实测 deepseek-chat 仍会文字追问），规则路径保证"缺城市必弹窗"体验；
// 复杂表述（带上下文、口语化）仍由 LLM function calling 兜底（needMore 拦截同样会弹窗）。
const BRANCH_INTENT_RE = /网点|营业点|门店|自提点|驿站|营业厅/;
const FREIGHT_INTENT_RE =
  /运费|邮费|快递费|多少钱|几块钱|怎么收费|价格|时效|几天到|多久到|几天能到|多久能到|寄东西|寄快递|发快递|寄件/;
function detectCityIntent(message) {
  const m = String(message || '');
  if (CITY_LIST.some((c) => m.includes(c))) return null; // 含城市：交给 LLM 直接调工具
  if (BRANCH_INTENT_RE.test(m)) return 'query_branches';
  if (FREIGHT_INTENT_RE.test(m)) return 'query_freight';
  return null;
}

// 从持久层加载对话历史（仅取用户/助手文本轮次）构建 LLM 上下文
async function buildHistoryMessages(sessionId) {
  return (await store.getMessages(sessionId))
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-HISTORY_LIMIT)
    .map((m) => (m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)));
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
  }
  return '';
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function safeArgs(args) {
  if (args && typeof args === 'object') return args;
  if (typeof args === 'string') {
    try { return JSON.parse(args); } catch { return {}; }
  }
  return {};
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function splitChunks(text) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const n = 1 + Math.floor(Math.random() * 3);
    chunks.push(text.slice(i, i + n));
    i += n;
  }
  return chunks;
}

// 固定文案的模拟流式输出（快速路径用）
async function streamFixed(send, text) {
  for (const chunk of splitChunks(text)) {
    send('delta', { text: chunk });
    await delay(15);
  }
}

// 按会话构建 LangChain 工具（transfer_human 闭包 sessionId；query_freight 闭包 userId/send 做记忆兜底）
function buildTools({ sessionId, userId, send }) {
  const queryShipmentTool = tool(
    async ({ trackingNo }) => {
      const r = await queryShipment({ trackingNo });
      return JSON.stringify(r);
    },
    {
      name: 'query_shipment',
      description: '根据运单号查询物流运单状态（当前状态、轨迹、预计送达、派送员）。仅当用户提供了运单号时调用。',
      schema: z.object({
        trackingNo: z.string().describe('运单号，如 SF1234567890；也支持 12-15 位纯数字')
      })
    }
  );

  const queryFreightTool = tool(
    async ({ origin, destination, weightKg }) => {
      // origin 缺省时用长期记忆兜底（用户常用寄出城市），并提示前端"参考了记忆"
      let memFact = null;
      if (!origin && userId) {
        memFact = recallFact(userId, 'attribute', 'origin_city');
        if (memFact) origin = memFact.value;
      }
      const r = await queryFreight({ origin, destination, weightKg });
      if (memFact) {
        bumpFact(userId, memFact.id); // 命中：hits+1、confidence 微升
        send('memory_used', factDisplay(memFact));
      }
      return JSON.stringify(r);
    },
    {
      name: 'query_freight',
      description: '估算两个城市间的寄递运费与时效（特快/标准/经济三档）。从用户消息中抽取城市与重量；若目的地未知，先询问用户再调用。',
      schema: z.object({
        origin: z.string().optional().describe('寄出城市名，如 杭州；用户未说明则不传'),
        destination: z.string().optional().describe('目的地城市名，如 北京；用户未说明则不传'),
        weightKg: z.number().optional().describe('重量（公斤），默认按 1 公斤')
      })
    }
  );

  const queryKnowledgeTool = tool(
    async ({ query }) => {
      const r = await queryKnowledge({ query, topN: 2 });
      return JSON.stringify(r);
    },
    {
      name: 'query_knowledge',
      description: '检索寄递知识库（禁运物品、包装要求、理赔流程、保价服务、偏远地区、拒收退回、节假日安排、上门取件）。政策咨询类问题调用。',
      schema: z.object({
        query: z.string().describe('检索内容，通常是用户原话或其中的关键词')
      })
    }
  );

  const queryBranchesTool = tool(
    async ({ city, keyword }) => {
      const r = await queryBranches({ city, keyword });
      return JSON.stringify(r);
    },
    {
      name: 'query_branches',
      description: '查询指定城市的营业网点/自提点（地址、电话、营业时间、可办业务，支持按区县、地标或业务类型如自提/大件/冷链筛选）。用户找网点、门店、自提点位置时调用。',
      schema: z.object({
        city: z.string().optional().describe('城市或区县名，如 杭州 / 滨江区；用户未说明则不传'),
        keyword: z.string().optional().describe('筛选关键词，如 区县（滨江）、地标（地铁站）、业务（自提/大件/冷链/保价）')
      })
    }
  );

  const transferHumanTool = tool(
    async () => {
      await startHumanSession(sessionId);
      return JSON.stringify({ ok: true, summary: '已发起转人工，排队信息已推送给用户' });
    },
    {
      name: 'transfer_human',
      description: '转接人工客服。用户明确要求转人工、找真人，或投诉、情绪激动时调用；调用后系统自动排队接入。',
      schema: z.object({
        reason: z.string().optional().describe('转人工原因（可选）')
      })
    }
  );

  return [queryShipmentTool, queryFreightTool, queryKnowledgeTool, queryBranchesTool, transferHumanTool];
}

// ---------- Agent 主流程：流式 + 工具调用循环 ----------
export async function handleAgentMessage({ sessionId, message, userId, send }) {
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

  const llm = createLlm();
  const tools = buildTools({ sessionId, userId, send });
  const llmWithTools = llm.bindTools(tools);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // 确定性意图识别快速路径：意图明确但缺城市 -> 挂起并弹窗，不经 LLM
  const fastIntent = detectCityIntent(message);
  if (fastIntent) {
    const memFact = recallFact(userId, 'attribute', 'origin_city');
    setPendingSlots(sessionId, { intent: fastIntent, originalMessage: message, slots: {} });
    send('status', {
      step: 'intent',
      label: `意图：${fastIntent === 'query_freight' ? '查运费时效（缺城市）' : '查网点（缺城市）'}`,
      state: 'done'
    });
    send('ask_location', {
      intent: fastIntent,
      missing: fastIntent === 'query_freight' ? ['destination'] : ['city'],
      originMemory: memFact ? factDisplay(memFact).value : null,
      preset: {}
    });
    send('done', { intent: fastIntent, mode: 'slot_filling' });
    return;
  }

  // 长期记忆：把跨会话用户画像（L2）与最近会话摘要（L1）注入为独立 SystemMessage
  const memory = buildContext(userId);
  const messages = [
    new SystemMessage(SYSTEM_PROMPT),
    ...(memory.block ? [new SystemMessage(memory.block)] : []),
    ...await buildHistoryMessages(sessionId)
  ];

  let toolCounter = 0;
  let finalText = '';

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    send('status', { step: `llm_${i}`, label: i === 0 ? 'DeepSeek 思考中' : 'DeepSeek 继续分析', state: 'active' });

    const stream = await llmWithTools.stream(messages);
    let agg = null;
    for await (const chunk of stream) {
      agg = agg ? agg.concat(chunk) : chunk;
      const text = textOf(chunk.content);
      if (text) {
        finalText += text;
        send('delta', { text });
      }
    }

    const toolCalls = (agg?.tool_calls ?? []).map((c, j) => ({
      ...c,
      args: safeArgs(c.args),
      id: c.id || `call_${i}_${j}`
    }));

    send('status', {
      step: `llm_${i}`,
      label: toolCalls.length ? `决定调用工具（${toolCalls.map((c) => c.name).join('、')}）` : '回复生成完成',
      state: 'done'
    });

    // 没有工具调用 -> 回答已流式输出完毕
    if (!toolCalls.length) break;

    messages.push(new AIMessage({ content: textOf(agg?.content), tool_calls: toolCalls }));

    // 执行工具并把结果回填给模型
    let slotAsk = null; // 槽位缺失：需要弹窗补参的意图
    for (const call of toolCalls) {
      const step = `tool_${toolCounter++}`;
      send('status', {
        step,
        label: `调用工具 · ${call.name}`,
        detail: truncate(JSON.stringify(call.args), 60),
        state: 'active'
      });

      let resultText;
      const fn = toolMap.get(call.name);
      if (!fn) {
        resultText = JSON.stringify({ error: `未知工具：${call.name}` });
      } else {
        try {
          resultText = await fn.invoke(call.args);
        } catch (err) {
          resultText = JSON.stringify({ error: String(err?.message || err) });
        }
      }

      let parsed = null;
      let detail = '完成';
      try {
        parsed = JSON.parse(resultText);
        if (parsed?.summary) detail = parsed.summary;
        else if (parsed?.error) detail = `出错：${parsed.error}`;
      } catch { /* 非 JSON 结果 */ }

      // 意图已识别但缺城市类槽位 -> 不让 LLM 文字追问，改为前端弹窗补参
      if (parsed?.needMore) {
        if (call.name === 'query_freight' && parsed.missing === 'destination') {
          slotAsk = { intent: 'query_freight', slots: { ...call.args } };
        } else if (call.name === 'query_branches' && parsed.missing === 'city') {
          slotAsk = { intent: 'query_branches', slots: { ...call.args } };
        }
      }

      send('status', { step, label: `工具完成 · ${call.name}`, detail: truncate(detail, 60), state: 'done' });
      if (!slotAsk) messages.push(new ToolMessage({ content: resultText, tool_call_id: call.id }));
    }

    // 槽位补全：挂起本轮并通知前端弹窗，用户提交后经 /api/chat/slots 恢复执行
    if (slotAsk) {
      const memFact = recallFact(userId, 'attribute', 'origin_city');
      setPendingSlots(sessionId, {
        intent: slotAsk.intent,
        originalMessage: message,
        slots: slotAsk.slots
      });
      send('ask_location', {
        intent: slotAsk.intent,
        missing: slotAsk.intent === 'query_freight' ? ['destination'] : ['city'],
        originMemory: memFact ? factDisplay(memFact).value : null,
        preset: slotAsk.slots
      });
      send('done', { intent: slotAsk.intent, mode: 'slot_filling' });
      return;
    }
  }

  if (finalText.trim()) {
    await store.appendMessage(sessionId, { role: 'assistant', content: finalText });
  }

  // 兜底：用户明确要转人工，模型嘴上说"正在/已转接"却没调工具 -> 补触发，避免用户干等。
  // 只识别"声称已转接"的陈述句式，不识别"可以为您转接/需要我帮您转接吗"这类提议，避免误伤（如"投诉流程是什么"）。
  const claimsTransferred =
    /正在.{0,4}转(接|入工)|已.{0,4}转(接|入工)|已.{0,4}(发起|提交).{0,6}(转接|转人工|人工)/.test(finalText);
  if (!(await isHumanActive(sessionId)) && /人工|真人|投诉/.test(message) && claimsTransferred) {
    await startHumanSession(sessionId);
  }

  // 长期记忆：异步提取（fire-and-forget，不阻塞已结束的回复流）+ 重置会话摘要空闲计时
  if (userId) {
    scheduleExtraction({ userId, sessionId, userMsg: message, assistantMsg: finalText });
    scheduleIdleSummary({ userId, sessionId });
  }

  send('done', { intent: 'llm', mode: 'agent' });
}

// ---------- 槽位补全（弹窗选地址后恢复执行） ----------
// 挂起状态仅存内存（弹窗为即时交互，服务重启丢失无妨），sessionId -> { intent, originalMessage, slots, createdAt }
const pendingSlots = new Map();

function setPendingSlots(sessionId, pending) {
  pendingSlots.set(sessionId, { ...pending, createdAt: Date.now() });
}

// 只读探测：供路由在进入 SSE 前校验（返回 JSON 错误码）
export function hasPendingSlots(sessionId, intent) {
  const p = pendingSlots.get(sessionId);
  return !!p && p.intent === intent && Date.now() - p.createdAt <= PENDING_SLOTS_TTL;
}

// 弹窗提交：直接调用对应工具 + 把结果交给 LLM 生成最终回答（单轮，不再进入工具循环）
export async function handleSlotSubmit({ sessionId, intent, slots, userId, send }) {
  const pending = pendingSlots.get(sessionId);
  if (!pending || pending.intent !== intent) {
    throw Object.assign(new Error('没有待补充的查询，请重新描述您的需求'), { status: 409 });
  }
  if (Date.now() - pending.createdAt > PENDING_SLOTS_TTL) {
    pendingSlots.delete(sessionId);
    throw Object.assign(new Error('选择已超时，请重新描述您的需求'), { status: 410 });
  }
  pendingSlots.delete(sessionId); // 原子取出，防重复提交

  const s = slots || {};
  const desc =
    intent === 'query_freight'
      ? `寄出城市 ${s.origin || '杭州'} → 目的地 ${s.destination}${s.weightKg ? `，重量 ${s.weightKg}kg` : ''}`
      : `查询 ${s.city} 的营业网点${s.keyword ? `（筛选：${s.keyword}）` : ''}`;

  send('status', { step: 'slots', label: '已收到地址选择', detail: truncate(desc, 40), state: 'done' });
  send('status', { step: 'tool_resume', label: `调用工具 · ${intent}`, state: 'active' });

  let result;
  if (intent === 'query_freight') {
    result = await queryFreight({
      origin: s.origin,
      destination: s.destination,
      weightKg: Number(s.weightKg) || 1
    });
  } else {
    result = await queryBranches({ city: s.city, keyword: s.keyword });
  }
  send('status', {
    step: 'tool_resume',
    label: `工具完成 · ${intent}`,
    detail: truncate(result.summary || '完成', 60),
    state: 'done'
  });

  // 先取历史（不含本次选择），再落库合并消息，避免 LLM 上下文出现重复
  const history = await buildHistoryMessages(sessionId);
  await store.appendMessage(sessionId, { role: 'user', content: `${pending.originalMessage}（已选择：${desc}）` });

  const llm = createLlm();
  const memory = buildContext(userId);
  const messages = [
    new SystemMessage(SYSTEM_PROMPT),
    ...(memory.block ? [new SystemMessage(memory.block)] : []),
    ...history,
    new HumanMessage(pending.originalMessage),
    new SystemMessage(
      `用户已通过地址选择弹窗补充信息：${desc}。\n` +
        `工具查询结果（JSON）：\n${JSON.stringify(result)}\n` +
        `请基于以上结果直接回答用户最初的问题「${pending.originalMessage}」，不要调用任何工具。`
    )
  ];

  send('status', { step: 'llm_slots', label: 'DeepSeek 组织回答', state: 'active' });
  const stream = await llm.stream(messages);
  let finalText = '';
  for await (const chunk of stream) {
    const text = textOf(chunk.content);
    if (text) {
      finalText += text;
      send('delta', { text });
    }
  }
  send('status', { step: 'llm_slots', label: '回复生成完成', state: 'done' });

  if (finalText.trim()) {
    await store.appendMessage(sessionId, { role: 'assistant', content: finalText });
  }

  if (userId) {
    scheduleExtraction({ userId, sessionId, userMsg: `${pending.originalMessage}（已选择：${desc}）`, assistantMsg: finalText });
    scheduleIdleSummary({ userId, sessionId });
  }

  send('done', { intent, mode: 'slot_filling' });
}

// 弹窗下拉数据源
export function getCityOptions() {
  return { freightCities: CITY_LIST, branchCities: BRANCH_CITIES };
}
