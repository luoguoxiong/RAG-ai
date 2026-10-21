# 物流智能客服 Demo（LangChain + DeepSeek 工具调用 + SSE）

基于 **Node.js + Express + LangChain（JS）+ DeepSeek** 的物流智能客服演示。LLM 真实 function calling 决定调用哪些工具，前后端交互全部通过 **SSE**，业务数据为 Mock。

## 功能

LLM（deepseek-chat）根据用户问题自主决策，调用 4 个工具：

- **query_shipment**：查运单状态（轨迹 / 预计送达 / 派送员 / 异常提示）— Mock 运单
- **query_freight**：估算运费时效（同城 / 省内 / 跨省 / 偏远 线路系数，三档产品）— Mock 计价引擎
- **query_knowledge**：寄递知识库检索（禁运品 / 包装 / 理赔 / 保价等 8 篇）— 关键词打分检索
- **transfer_human**：转接人工（排队 -> mock 客服接入 -> 应答 -> 结束）— 会话级 SSE 推送

- 工具由 LLM 通过 **bindTools + function calling** 自主选择并抽取参数（城市、重量、运单号等实体抽取全部交给模型），支持一问多工具的链式调用
- 支持**多轮对话记忆**：第二轮"那换成 5 公斤呢？"会自动继承上一轮的城市上下文
- Agent 过程（思考 -> 决定调用工具 -> 工具结果 -> 回复）以"过程徽章"实时展示，回复逐 token 流式输出
- 未提供运单号/目的地时，LLM 会先追问而不是瞎调工具
- **长期记忆**：跨会话记住用户画像与偏好（常用寄出城市、业务身份、偏好档位等），带完整的更新策略（置信度合并、冲突消解、时间衰减、用户纠正、可遗忘）—— 设计详见 [docs/long-term-memory-design.md](docs/long-term-memory-design.md)

## 运行

```bash
npm install
npm start
# 打开 http://localhost:3000
```

需要 Node.js >= 18。API key 配置在项目根目录 `.env`（已 gitignore）：

```env
DEEPSEEK_API_KEY=sk-xxxx
DEEPSEEK_MODEL=deepseek-chat
```

## 演示话术

| 意图 | 示例 |
| --- | --- |
| 查运单 | `运单 SF1234567890 到哪了？`（演示单号：SF1234567890 / JD1008612345 / YT9876543210 / YD7788990011） |
| 查运费时效 | `寄 10kg 到北京多少钱？多久能到？`、`从广州寄20斤到成都几天到`、`那换成5公斤呢？` |
| 查知识库 | `充电宝可以寄吗？`、`包裹丢了怎么理赔？` |
| 转人工 | `我要投诉，转人工` -> 排队约 4 秒接入 -> 试试 `我的件丢了` / `改地址` |
| 多需求 | `帮我查下 SF1234567890，顺便看看什么不能寄`（一次调用两个工具） |
| 缺信息追问 | `我的快递到哪了`（LLM 先追问运单号） |
| 长期记忆 | 会话 A 说 `我常从杭州发货` -> 点右上角"**新会话**" -> 直接问 `寄 10kg 到北京多少钱？`（自动带出杭州，徽章显示"参考记忆"）；纠正用 `不对，我搬到深圳了`（记忆更新、旧值归档）；右上角"**我的记忆**"面板可查看每条的置信度/依据并单条删除或"忘记我" |

## 架构

```
public/                  前端（原生 HTML/CSS/JS，无构建）
  index.html             聊天界面 + 侧边栏
  app.js                 双通道 SSE 客户端
  style.css              样式
server/
  index.js               Express 入口：静态资源 + 路由
  agent.js               LangChain Agent：bindTools + 流式工具调用循环 + 会话记忆
  llm.js                 ChatDeepSeek 封装（读取 .env，temperature 可覆盖）
  tools.js               业务工具实现（运单/运费/知识库）+ scoreKnowledge
  session.js             会话级 SSE 通道 + 人工客服会话管理（排队/接入/应答，状态持久化、重启可恢复）
  store.js               本地 JSON 持久层：对话历史 + 人工会话状态存取（data/history.json）
  memory.js              长期记忆：LLM 异步提取 + 合并更新策略 + 检索注入 + 会话摘要
  memstore.js            记忆持久层：用户画像事实 + 会话摘要（data/memory.json，原子写）
  data.js                Mock 数据：知识库 / 运单 / 运费产品 / 城市线路
data/
  history.json           对话历史持久化文件（运行时生成，已 gitignore）
  memory.json            长期记忆持久化文件（运行时生成，已 gitignore）
```

**对话历史持久化**：所有消息（智能客服问答、转人工事件、人工客服对话）按 sessionId 写入 `data/history.json`（原子写入，单会话最多保留 200 条）；LLM 上下文与页面历史都从存储读取，服务重启后对话不丢。后续接入数据库时只需替换 `store.js` 的 `getMessages/appendMessage` 实现，上层无需改动。

**人工会话状态持久化**：排队中/已接入状态与客服信息写入会话记录的 `human` 字段，`GET /api/history` 一并返回；前端刷新后据此恢复人工模式。服务重启后按需从持久层恢复：`active` 直接恢复可继续对话，`queued` 按 `joinAt` 续排接入、已过期的立即补推接入（超过 24h 的残留状态视为已结束）。

**长期记忆系统**：以前端 localStorage 生成的 `userId` 为命名空间（无则按"无记忆"降级），分两层——**语义记忆**（跨会话用户画像事实 `data/memory.json`）与**情景记忆**（会话摘要，空闲 30 分钟/人工结束时生成）。回答时把 top 8 条记忆按 `confidence × recency`（半衰期：属性 90 天 / 偏好 60 天 / 事务 14 天）排序，注入为独立 SystemMessage（标注"可能过时，以用户当前表述为准"）；`query_freight` 未传寄出城市时自动用记忆兜底并推 `memory_used` 徽章。**更新策略**：每轮回答后异步（10s 去抖）LLM 按白名单提取 -> 按 `(type,key)` upsert 合并——值冲突按 `confidence × recency` 消解，用户显式纠正/明说无条件覆盖且旧值归档进 `history` 版本链，habit 类维护最近 3 值滑动窗口；context 类 14 天 TTL，confidence < 0.3 归档，每用户 100 条容量上限；命中使用 `confidence +0.05`，被矛盾未覆盖 `-0.2`；手机号/住址等敏感信息一律不抽取。前端右上角"我的记忆"面板可查看每条记忆的置信度/依据/使用次数、单条删除或"忘记我"。

Agent 循环（`agent.js`）：`system prompt + history + user` -> `llm.bindTools(tools).stream()` -> 聚合 chunk 得到 `tool_calls` -> 逐个执行工具回填 `ToolMessage` -> 循环直到模型输出最终回答（最多 4 轮）。与 LangGraph `createReactAgent` 等价，手写循环便于把过程映射成 SSE 事件。

## SSE 协议

### 1) 请求级流：`POST /api/chat`（fetch + ReadableStream 解析）

| event | data | 说明 |
| --- | --- | --- |
| `start` | `{ts}` | 流开始 |
| `status` | `{step,label,detail,state}` | 过程徽章：`llm_N`（思考/决策）、`tool_N`（工具调用与结果） |
| `delta` | `{text}` | LLM 输出增量 token |
| `memory_used` | `{label,value}` | 本轮回答参考了长期记忆（如运费估算兜底常用寄出城市） |
| `done` | `{intent,mode}` | 本轮结束 |
| `error` | `{message}` | 服务异常（含 DeepSeek 配置错误） |

### 2) 会话级通道：`GET /api/events?sessionId=`（EventSource）

| event | data | 说明 |
| --- | --- | --- |
| `connected` | `{sessionId}` | 通道就绪 |
| `transfer` | `{queuePosition,estimatedWaitMin}` | LLM 调用 transfer_human 后推送排队信息 |
| `human_joined` | `{agent:{name,code}}` | mock 人工客服接入 |
| `human_message` | `{from:'agent'|'system',text}` | 人工客服消息 / 系统提示 |
| `human_typing` | `{typing}` | 客服"正在输入" |
| `human_ended` | `{}` | 会话结束，切回智能客服 |
| `memory_saved` | `{action,label,value}` | 长期记忆提取结果通知：`created`/`updated`/`deleted`（提取异步去抖执行，回复结束后数秒才推送） |

其他接口：`GET /api/history?sessionId=`（拉取历史对话，前端刷新后回显）、`POST /api/human/message`（人工模式发消息）、`POST /api/human/end`（结束会话）、`POST /api/human/transfer`（调试直触转人工）、`GET /api/memory?userId=`（记忆面板数据）、`DELETE /api/memory/:userId/facts/:factId`（删除单条记忆）、`POST /api/memory/forget`（忘记我，清空全部）。

## 替换为真实业务

- `tools.js`：把 mock 实现换成真实轨迹 API、计价引擎、向量检索（RAG）；工具签名（zod schema）不变，LLM 侧无需改动
- `llm.js`：更换模型只需改 `DEEPSEEK_MODEL`，或把 ChatDeepSeek 换成其他 ChatModel
- `session.js`：人工客服替换为真实客服工单系统（WebSocket / IM 网关）
