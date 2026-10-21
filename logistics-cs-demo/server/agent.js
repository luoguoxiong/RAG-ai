// ============ Agent 编排：LangChain + DeepSeek 真实 LLM 工具调用（SSE 流式） ============
import { tool } from '@langchain/core/tools';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { queryShipment, queryFreight, queryKnowledge } from './tools.js';
import { startHumanSession, isHumanActive } from './session.js';
import { createLlm, DEEPSEEK_API_KEY } from './llm.js';
import * as store from './store.js';

const MAX_ITERATIONS = 4; // 最多工具调用轮数
const HISTORY_LIMIT = 20; // 构建 LLM 上下文时最多带的历史轮数

const SYSTEM_PROMPT = `你是"小邮"，物流公司的智能客服助手，使用简体中文与用户交流。

你可以调用以下工具：
1. query_shipment —— 查询运单物流状态。仅当用户提供了运单号时调用；未提供时先礼貌询问运单号，不要调用。
2. query_freight —— 估算运费与时效。从用户消息中抽取寄出城市、目的城市与重量（公斤）传入；重量未知传 1。只要目的地城市明确就立即调用（寄出城市未知可不传，系统会按默认城市估算并说明）；只有目的地城市也不明确时才先询问。
3. query_knowledge —— 检索寄递知识库，适用于禁运品、包装、理赔、保价、偏远地区、拒收退回、节假日、上门取件等政策类问题。
4. transfer_human —— 用户要求转人工、找真人客服或投诉时，必须调用此工具。注意：只回复"正在为您转接"之类的文字而**不调用工具**是不允许的，那样用户永远等不到人工。即使历史对话里出现过仅文字回应的情况，也必须调用工具。

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

// 从持久层加载对话历史（仅取用户/助手文本轮次）构建 LLM 上下文
function buildHistoryMessages(sessionId) {
  return store
    .getMessages(sessionId)
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

// 按会话构建 LangChain 工具（transfer_human 需要闭包 sessionId）
function buildTools(sessionId) {
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
      const r = await queryFreight({ origin, destination, weightKg });
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

  const transferHumanTool = tool(
    async () => {
      startHumanSession(sessionId);
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

  return [queryShipmentTool, queryFreightTool, queryKnowledgeTool, transferHumanTool];
}

// ---------- Agent 主流程：流式 + 工具调用循环 ----------
export async function handleAgentMessage({ sessionId, message, send }) {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY 未配置，请在项目根目录 .env 中配置');
  }

  const llm = createLlm();
  const tools = buildTools(sessionId);
  const llmWithTools = llm.bindTools(tools);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // 先持久化用户消息，再从存储构建上下文
  store.appendMessage(sessionId, { role: 'user', content: message });

  // 明确的转人工请求：走固定流程，不经 LLM 决策，保证必转成功
  if (isExplicitTransferRequest(message)) {
    console.log(message)
    send('status', { step: 'intent', label: '意图：转接人工', state: 'done' });
    send('status', { step: 'transfer', label: '发起转人工', state: 'active' });
    startHumanSession(sessionId);
    await streamFixed(send, TRANSFER_REPLY);
    send('status', { step: 'transfer', label: '已发起转接，等待客服接入', state: 'done' });
    send('done', { intent: 'transfer_human', mode: 'human' });
    return;
  }

  const messages = [new SystemMessage(SYSTEM_PROMPT), ...buildHistoryMessages(sessionId)];

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

      let detail = '完成';
      try {
        const parsed = JSON.parse(resultText);
        if (parsed?.summary) detail = parsed.summary;
        else if (parsed?.error) detail = `出错：${parsed.error}`;
      } catch { /* 非 JSON 结果 */ }

      send('status', { step, label: `工具完成 · ${call.name}`, detail: truncate(detail, 60), state: 'done' });
      messages.push(new ToolMessage({ content: resultText, tool_call_id: call.id }));
    }
  }

  if (finalText.trim()) {
    store.appendMessage(sessionId, { role: 'assistant', content: finalText });
  }

  // 兜底：用户明确要转人工，模型嘴上说"正在/已转接"却没调工具 -> 补触发，避免用户干等。
  // 只识别"声称已转接"的陈述句式，不识别"可以为您转接/需要我帮您转接吗"这类提议，避免误伤（如"投诉流程是什么"）。
  const claimsTransferred =
    /正在.{0,4}转(接|入工)|已.{0,4}转(接|入工)|已.{0,4}(发起|提交).{0,6}(转接|转人工|人工)/.test(finalText);
  if (!isHumanActive(sessionId) && /人工|真人|投诉/.test(message) && claimsTransferred) {
    startHumanSession(sessionId);
  }

  send('done', { intent: 'llm', mode: 'agent' });
}
