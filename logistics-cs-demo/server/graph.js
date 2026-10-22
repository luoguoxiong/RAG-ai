// ============ LangGraph Agent：StateGraph(agent ⇄ tools) + ToolNode + interrupt 槽位补全 ============
// 图的形状（原手写 ReAct 循环改由 LangGraph 编排）：
//   START → agent（LLM 决策）─┬─ 有 tool_calls → tools（ToolNode 执行）→ agent → …
//                             └─ 无 tool_calls → END
// 槽位缺失（如查运费没给目的城市）时，工具内部调用 interrupt() 挂起整张图，
// 前端弹窗补参后由 Command({ resume }) 从断点续跑——同一个工具会重跑一次并拿到用户选择的值。
// 图状态由 MemorySaver 按 thread_id 保存（一个用户轮次一个 thread，仅用于中断续跑；
// 对话历史仍以 PostgreSQL 为准，每轮重新注入，服务重启不丢上下文）。
import {
  Annotation,
  StateGraph,
  START,
  END,
  MemorySaver,
  GraphRecursionError,
  interrupt,
  isGraphInterrupt,
  messagesStateReducer
} from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { queryShipment, queryFreight, queryKnowledge, queryBranches } from './tools.js';
import { startHumanSession } from './session.js';
import { createLlm } from './llm.js';
import { recallFact, factDisplay, bumpFact } from './memory.js';
import { textOf, truncate } from './utils.js';

const AGENT_NODE = 'agent';
const TOOLS_NODE = 'tools';
// 递归上限：每个工具轮次消耗 2 个 super-step（agent → tools），12 步约等于原来手写循环的 4~5 轮
const MAX_GRAPH_STEPS = 12;

// 图状态：只保留 messages（Agent 的全部上下文），用官方 messagesStateReducer 做增量合并
const AgentState = Annotation.Root({
  messages: Annotation({
    reducer: messagesStateReducer,
    default: () => []
  })
});

// 检查点存储：内存版即可（中断只是"本次提问缺参数"的短生命周期状态，10 分钟 TTL 后清理）
const checkpointer = new MemorySaver();

function summaryOf(resultText) {
  try {
    const parsed = JSON.parse(resultText);
    if (parsed?.summary) return parsed.summary;
    if (parsed?.error) return `出错：${parsed.error}`;
  } catch {
    // 非 JSON 结果，不展示摘要
  }
  return '完成';
}

// 按会话构建工具：send 用于把工具调用过程映射成 SSE 状态徽章，sessionId/userId 供业务工具闭包使用
function buildTools({ sessionId, userId, send, originalMessage }) {
  let seq = 0;

  // 统一包装：状态徽章（tool_N：调用中 / 完成）+ 中断透传（interrupt 不是错误，直接抛出给图）
  const define = ({ name, description, schema, run }) =>
    tool(
      async (args) => {
        const input = args && typeof args === 'object' ? args : {};
        const step = `tool_${seq++}`;
        send('status', {
          step,
          label: `调用工具 · ${name}`,
          detail: truncate(JSON.stringify(input), 60),
          state: 'active'
        });

        // 缺参时挂起图，前端随即弹出地址选择面板；续跑时 interrupt() 直接返回用户选择，不会再发一次等待状态
        const ask = (payload) => {
          try {
            return interrupt(payload);
          } catch (err) {
            if (isGraphInterrupt(err)) {
              send('status', { step, label: `${name} · 等待用户补充信息`, state: 'done' });
            }
            throw err;
          }
        };

        let resultText;
        try {
          resultText = await run(input, { ask });
        } catch (err) {
          if (isGraphInterrupt(err)) throw err; // 挂起：由 LangGraph 保存断点，不当作工具失败
          const message = String(err?.message || err);
          send('status', { step, label: `工具出错 · ${name}`, detail: truncate(message, 60), state: 'done' });
          return JSON.stringify({ error: message });
        }

        send('status', {
          step,
          label: `工具完成 · ${name}`,
          detail: truncate(summaryOf(resultText), 60),
          state: 'done'
        });
        return resultText;
      },
      { name, description, schema }
    );

  const queryShipmentTool = define({
    name: 'query_shipment',
    description:
      '根据运单号查询物流运单状态（当前状态、轨迹、预计送达、派送员）。仅当用户提供了运单号时调用。',
    schema: z.object({
      trackingNo: z.string().describe('运单号，如 SF1234567890；也支持 12-15 位纯数字')
    }),
    run: async ({ trackingNo }) => JSON.stringify(await queryShipment({ trackingNo }))
  });

  const queryFreightTool = define({
    name: 'query_freight',
    description:
      '估算两个城市间的寄递运费与时效（特快/标准/经济三档）。从用户消息中抽取城市与重量；目的地未知时先不传，系统会引导用户通过地址选择弹窗补充。',
    schema: z.object({
      origin: z.string().optional().describe('寄出城市名，如 杭州；用户未说明则不传'),
      destination: z.string().optional().describe('目的地城市名，如 北京；用户未说明则不传'),
      weightKg: z.number().optional().describe('重量（公斤），默认按 1 公斤')
    }),
    run: async (args, { ask }) => {
      // 寄出城市缺省时用长期记忆兜底（用户常用寄出城市）
      let origin = args.origin;
      let memFact = null;
      if (!origin && userId) {
        memFact = recallFact(userId, 'attribute', 'origin_city');
        if (memFact) origin = memFact.value;
      }

      let destination = args.destination;
      let weightKg = args.weightKg;

      // 缺目的地：挂起图，等前端弹窗选地址（续跑后从这里拿到用户选择）
      if (!destination) {
        const picked = await ask({
          intent: 'query_freight',
          missing: ['destination'],
          preset: { origin, weightKg },
          originMemory: memFact ? factDisplay(memFact).value : null,
          originalMessage,
          ts: Date.now()
        });
        destination = picked?.destination;
        origin = picked?.origin || origin;
        weightKg = picked?.weightKg || weightKg;
      }
      if (!destination) {
        return JSON.stringify({ needMore: true, missing: 'destination', summary: '未提供目的城市，查询未执行' });
      }

      const result = await queryFreight({ origin, destination, weightKg });
      if (memFact) {
        bumpFact(userId, memFact.id); // 命中：hits+1、confidence 微升
        send('memory_used', factDisplay(memFact));
      }
      return JSON.stringify(result);
    }
  });

  const queryKnowledgeTool = define({
    name: 'query_knowledge',
    description:
      '检索寄递知识库（禁运物品、包装要求、理赔流程、保价服务、偏远地区、拒收退回、节假日安排、上门取件）。政策咨询类问题调用。',
    schema: z.object({
      query: z.string().describe('检索内容，通常是用户原话或其中的关键词')
    }),
    run: async ({ query }) => JSON.stringify(await queryKnowledge({ query, topN: 2 }))
  });

  const queryBranchesTool = define({
    name: 'query_branches',
    description:
      '查询指定城市的营业网点/自提点（地址、电话、营业时间、可办业务，支持按区县、地标或业务类型如自提/大件/冷链筛选）。用户找网点、门店、自提点位置时调用。',
    schema: z.object({
      city: z.string().optional().describe('城市或区县名，如 杭州 / 滨江区；用户未说明则不传'),
      keyword: z
        .string()
        .optional()
        .describe('筛选关键词，如 区县（滨江）、地标（地铁站）、业务（自提/大件/冷链/保价）')
    }),
    run: async (args, { ask }) => {
      let city = args.city;
      let keyword = args.keyword;

      // 缺城市：同样挂起图，弹窗补齐后继续查询
      if (!city) {
        const picked = await ask({
          intent: 'query_branches',
          missing: ['city'],
          preset: { keyword },
          originalMessage,
          ts: Date.now()
        });
        city = picked?.city;
        keyword = picked?.keyword || keyword;
      }
      if (!city) {
        return JSON.stringify({ needMore: true, missing: 'city', summary: '未提供城市，查询未执行' });
      }
      return JSON.stringify(await queryBranches({ city, keyword }));
    }
  });

  return [queryShipmentTool, queryFreightTool, queryKnowledgeTool, queryBranchesTool];
}

/**
 * 构建一张按会话绑定的 Agent 图（工具与 SSE 通道都是会话级闭包，故每轮构建一次，成本仅为对象组装）。
 * @returns 编译后的图，运行方式见 streamAgentTurn
 */
export function buildAgentGraph({ sessionId, userId, send, originalMessage }) {
  const tools = buildTools({ sessionId, userId, send, originalMessage });
  const llmWithTools = createLlm().bindTools(tools);
  let round = 0;

  // agent 节点：LLM 决策（有 tool_calls 交给 ToolNode，否则结束）
  // 用 invoke 即可：图以 messages 模式流式输出时，LangChain 会自动把 token 回调转成增量 chunk
  const agentNode = async (state) => {
    const step = `llm_${round}`;
    const first = round === 0;
    round += 1;
    send('status', {
      step,
      label: first ? 'DeepSeek 思考中' : 'DeepSeek 继续分析',
      state: 'active'
    });

    const response = await llmWithTools.invoke(state.messages);
    const calls = response.tool_calls ?? [];
    send('status', {
      step,
      label: calls.length ? `决定调用工具（${calls.map((c) => c.name).join('、')}）` : '回复生成完成',
      state: 'done'
    });
    return { messages: [response] };
  };

  const graph = new StateGraph(AgentState)
    .addNode(AGENT_NODE, agentNode)
    .addNode(TOOLS_NODE, new ToolNode(tools))
    .addEdge(START, AGENT_NODE)
    .addConditionalEdges(AGENT_NODE, toolsCondition, [TOOLS_NODE, END])
    .addEdge(TOOLS_NODE, AGENT_NODE)
    .compile({ checkpointer });

  return graph;
}

/**
 * 跑一轮图（首次提问或中断续跑），把 LangGraph 的流映射成前端既有 SSE 事件。
 * - updates 模式：节点级更新 + __interrupt__
 * - messages 模式：agent 节点产出的 token 增量 → delta
 * @returns {Promise<{ text: string, interrupted: object|null, truncated: boolean }>}
 */
export async function streamAgentTurn({ graph, input, threadId, send }) {
  const config = {
    configurable: { thread_id: threadId },
    recursionLimit: MAX_GRAPH_STEPS,
    streamMode: ['updates', 'messages']
  };

  let text = '';
  let interrupted = null;

  try {
    for await (const [mode, payload] of await graph.stream(input, config)) {
      if (mode === 'messages') {
        const [chunk, meta] = payload;
        if (meta?.langgraph_node !== AGENT_NODE) continue; // 只要模型输出，工具结果不作为回答
        const piece = textOf(chunk.content);
        if (piece) {
          text += piece;
          send('delta', { text: piece });
        }
        continue;
      }
      // updates
      if (payload?.__interrupt__) {
        interrupted = payload.__interrupt__[0]?.value ?? {};
      }
    }
  } catch (err) {
    if (err instanceof GraphRecursionError) {
      // 工具轮次超限：收口本轮，避免前端卡在"思考中"
      const tail = '\n\n这个问题涉及的信息比较多，我先整理到这里。如果需要，可以再追问一个更具体的问题。';
      send('delta', { text: tail });
      return { text: text + tail, interrupted: null, truncated: true };
    }
    throw err;
  }

  return { text, interrupted, truncated: false };
}

// 释放某个 thread 的检查点（本轮已结束 / 弹窗已作废）
export async function releaseThread(threadId) {
  if (!threadId) return;
  try {
    await checkpointer.deleteThread(threadId);
  } catch {
    // 检查点不存在或已被清理，忽略
  }
}
