# 物流智能客服 Demo（LangGraph Agent + DeepSeek + SSE）

基于 **Node.js + Express + LangGraph（JS）+ DeepSeek** 的物流智能客服演示。ReAct Agent 由 LangGraph 的 `StateGraph`（agent ⇄ tools）+ `ToolNode` 编排（不再手写工具调用循环），槽位补全用 `interrupt()` 挂起图、`Command({ resume })` 断点续跑；LLM 真实 function calling 决定调用哪些工具，前后端交互全部通过 **SSE**，业务数据为 Mock。

## 功能

LLM（deepseek-chat）根据用户问题自主决策，调用 5 个工具：

- **query_shipment**：查运单状态（轨迹 / 预计送达 / 派送员 / 异常提示）— Mock 运单
- **query_freight**：估算运费时效（同城 / 省内 / 跨省 / 偏远 线路系数，三档产品）— Mock 计价引擎
- **query_knowledge**：寄递知识库检索（禁运品 / 包装 / 理赔 / 保价等 8 篇）— 关键词打分检索
- **query_branches**：网点查询（按城市 / 区县 / 省份检索营业点与自提点，支持按区县、地标、业务类型筛选）— Mock 网点数据
- **transfer_human**：转接人工（排队 -> 客服接入 -> 真人回复 -> 结束）— 会话级 SSE 推送

- **人工客服工作台**（`/agent.html`）：从 `support_human` 客服列表选择身份上岗，会话自动分配、用户消息实时推送，客服真人回复经 SSE 实时送达用户页面；客服工作台离线时消息照常入库并提示用户已记录，等待客服上线处理（不做任何自动应答）

- 工具由 LLM 通过 **bindTools + function calling** 自主选择并抽取参数（城市、重量、运单号等实体抽取全部交给模型），支持一问多工具的链式/并行调用（LangGraph `ToolNode` 执行后经条件边回到 agent）
- 支持**多轮对话记忆**：第二轮"那换成 5 公斤呢？"会自动继承上一轮的城市上下文
- Agent 过程（思考 -> 决定调用工具 -> 工具结果 -> 回复）以"过程徽章"实时展示，回复逐 token 流式输出
- 未提供运单号/目的地时，LLM 会先追问而不是瞎调工具
- **意图识别 + 槽位补全弹窗**：工具发现缺城市参数时在节点内 `interrupt()` 挂起整张图（断点存 `MemorySaver`），服务端推送 `ask_location` 事件，前端**弹窗选择地址**（寄出城市自动预填长期记忆的常用城市）后提交 `POST /api/chat/slots`，用 `Command({ resume })` 续跑——工具重跑一次拿到用户选择，再交 LLM 生成回答，替代纯文字追问；表述里完全没有城市的常见问法（如"帮我查下运费"）另有一条不经 LLM 的规则快速路径
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
DATABASE_URL=postgres://postgres:postgres@localhost:5432/logistics_cs
```

需要可用的 PostgreSQL（>= 13）。服务启动时自动建表（`chat_sessions` / `chat_messages` / `support_human`）并写入种子客服（林晓 / CS1024），首次运行前先创建数据库：

```bash
createdb logistics_cs   # 或: psql -c "CREATE DATABASE logistics_cs;"
```

## 演示话术

| 意图 | 示例 |
| --- | --- |
| 查运单 | `运单 SF1234567890 到哪了？`（演示单号：SF1234567890 / JD1008612345 / YT9876543210 / YD7788990011） |
| 查运费时效 | `寄 10kg 到北京多少钱？多久能到？`、`从广州寄20斤到成都几天到`、`那换成5公斤呢？` |
| 查知识库 | `充电宝可以寄吗？`、`包裹丢了怎么理赔？` |
| 查网点 | `杭州滨江有营业网点吗？`、`深圳哪里有 24 小时自提点？`、`浙江有哪些网点？`（未说城市 LLM 先追问） |
| 转人工 | `我要投诉，转人工` -> 排队约 4 秒接入 -> 试试 `我的件丢了` / `改地址` |
| 多需求 | `帮我查下 SF1234567890，顺便看看什么不能寄`（一次调用两个工具） |
| 缺信息追问 | `我的快递到哪了`（LLM 先追问运单号） |
| 槽位补全弹窗 | `帮我查下运费`（识别出查运费意图但无城市 → 弹窗选地址 → 提交后自动查询出结果）、`帮我查下网点`（弹窗选城市）；关掉弹窗则回退为文字追问 |
| 长期记忆 | 会话 A 说 `我常从杭州发货` -> 点右上角"**新会话**" -> 直接问 `寄 10kg 到北京多少钱？`（自动带出杭州，徽章显示"参考记忆"）；纠正用 `不对，我搬到深圳了`（记忆更新、旧值归档）；右上角"**我的记忆**"面板可查看每条的置信度/依据并单条删除或"忘记我" |

## 架构

```
public/                  前端（原生 HTML/CSS/JS，无构建）
  index.html             聊天界面 + 侧边栏
  app.js                 双通道 SSE 客户端
  agent.html             人工客服工作台（客服列表 / 会话接单 / 真人回复）
  agent.js               工作台逻辑：上岗、客服级 SSE、回复用户
  agent.css              工作台补充样式
  style.css              样式
server/
  index.js               Express 入口：静态资源 + 路由（启动时自动建表）
  db.js                   PostgreSQL 连接池 + 建表 + 种子客服
  agent.js               会话编排：上下文拼装（Prompt + 长期记忆 + 历史）/ 转人工快速路径 / 槽位补全 / 落库与记忆调度
  graph.js               LangGraph Agent：StateGraph(agent ⇄ tools) + ToolNode + interrupt 槽位补全 + 流式事件映射
  llm.js                 ChatDeepSeek 封装（读取 .env，temperature 可覆盖）
  tools.js               业务工具实现（运单/运费/知识库/网点）+ scoreKnowledge
  utils.js               通用小工具（消息取文本 / 截断 / 固定文案模拟流式）
  session.js             会话级 SSE 通道 + 人工客服会话管理（排队/接入/应答，状态持久化、重启可恢复）
  store.js               PostgreSQL 持久层：对话历史 + 人工会话状态存取（chat_sessions / chat_messages）
  memory.js              长期记忆：LLM 异步提取 + 合并更新策略 + 检索注入 + 会话摘要
  memstore.js            记忆持久层：PostgreSQL（memory_facts / memory_summaries，事务 + 用户级锁）
  memjobs.js             记忆异步任务队列：落库去抖、SKIP LOCKED 认领、失败退避重试、崩溃回收
  data.js                Mock 数据：知识库 / 运单 / 运费产品 / 网点 / 城市线路
scripts/
  migrate-memory-json.js 一次性迁移：旧 data/memory.json -> PostgreSQL（npm run migrate:memory）
```

**对话历史持久化（PostgreSQL）**：所有消息（智能客服问答、转人工事件、人工客服对话）按 sessionId 写入 `chat_messages` 表（单会话最多保留 200 条，超出滚动删除最早记录）；LLM 上下文与页面历史都从存储读取，服务重启后对话不丢。人工会话状态（排队/接入/结束）落在 `chat_sessions` 表的 `human_*` 字段，`GET /api/history` 一并返回；前端刷新后据此恢复人工模式。服务重启后按需从持久层恢复：`active` 直接恢复可继续对话，`queued` 按 `joinAt` 续排接入、已过期的立即补推接入（超过 24h 的残留状态视为已结束）。

**表结构**：

- `chat_sessions(session_id PK, human_status, human_queue_position, human_agent_id FK->support_human, human_join_at, human_updated_at, created_at, updated_at)`
- `chat_messages(id PK, session_id FK->chat_sessions, role, name, content, ts, created_at)`，索引 `(session_id, id)`
- `support_human(id PK, name, code UNIQUE, status, created_at)` —— 客服表；人工接入时从该表取 `status='online'` 的客服，无在线客服时回退到种子客服
- `memory_facts(id PK, user_id, type, key, value JSONB, confidence, source, evidence, hits, status, history JSONB, created_at, updated_at, expires_at, archived_at)`，部分唯一索引 `(user_id, type, key) WHERE status='active'` 保证同键只有一条生效事实
- `memory_summaries(id PK, user_id, session_id, summary, until_ts, ts)`，唯一索引 `(user_id, session_id)`
- `memory_jobs(id PK, kind, dedupe_key, user_id, session_id, payload JSONB, status, run_at, attempts, last_error)`，部分唯一索引 `(dedupe_key) WHERE status='pending'` 做去抖合并

**记忆并发与可靠性（生产化）**：所有"读-改-写"都在 `withUserLock` 事务内执行，用 `pg_advisory_xact_lock(user_id)` 串行化同一用户、提交前按 id 做 diff 精确落盘（不再整文件重写）；命中计数走原子 SQL。异步提取不再用进程内 `setTimeout`，而是写入 `memory_jobs`：同一 `dedupe_key` 的 pending 任务合并 payload 并推迟 `run_at`（等价于 10s 去抖），worker 用 `FOR UPDATE SKIP LOCKED` 认领、按用户级 advisory lock 串行执行、失败指数退避重试 3 次后置 `dead`，进程崩溃留下的 `running` 任务超过 5 分钟租约自动回收。多实例部署时任务不会被重复消费。

**长期记忆系统**：以前端 localStorage 生成的 `userId` 为命名空间（无则按"无记忆"降级），分两层——**语义记忆**（跨会话用户画像事实，存 `memory_facts`）与**情景记忆**（会话摘要，空闲 30 分钟/人工结束时生成）。回答时把 top 8 条记忆按 `confidence × recency`（半衰期：属性 90 天 / 偏好 60 天 / 事务 14 天）排序，注入为独立 SystemMessage（标注"可能过时，以用户当前表述为准"）；`query_freight` 未传寄出城市时自动用记忆兜底并推 `memory_used` 徽章。**更新策略**：每轮回答后异步（10s 去抖）LLM 按白名单提取 -> 按 `(type,key)` upsert 合并——值冲突按 `confidence × recency` 消解，用户显式纠正/明说无条件覆盖且旧值归档进 `history` 版本链，habit 类维护最近 3 值滑动窗口；context 类 14 天 TTL，confidence < 0.3 归档，每用户 100 条容量上限；命中使用 `confidence +0.05`，被矛盾未覆盖 `-0.2`；手机号/住址等敏感信息一律不抽取。前端右上角"我的记忆"面板可查看每条记忆的置信度/依据/使用次数、单条删除或"忘记我"。

**Agent 编排（LangGraph，`graph.js`）**：

```
START → agent（DeepSeek 决策）─┬─ 有 tool_calls → tools（ToolNode 执行）→ agent → …
                               └─ 无 tool_calls → END
```

- 图状态只有 `messages`（官方 `messagesStateReducer` 增量合并）；模型用 `bindTools` 绑定 5 个工具，条件边用官方 `toolsCondition` 判断是否进入 `ToolNode`——原来的手写 ReAct 循环整段消失
- 工具轮次用 `recursionLimit`（12 步 ≈ 4~5 轮工具调用）约束，超限时收口本轮而不是报错
- **流式**：`graph.stream(input, { streamMode: ['updates', 'messages'] })`——`messages` 流只取 `agent` 节点的 token 增量推成 `delta` 事件；`updates` 流拿节点级更新与 `__interrupt__`。工具内部把调用/结果写成 `status` 徽章，SSE 协议与重构前一致（前端零改动）
- **中断式槽位补全**：`query_freight` / `query_branches` 缺参时在工具内 `interrupt({ intent, missing, preset, originMemory })` 挂起图，`MemorySaver` 按 `thread_id` 保存断点（一个用户轮次一个 thread）；前端弹窗提交后用 `Command({ resume })` 续跑，工具重跑时 `interrupt()` 直接返回用户选择。弹窗作废 / 超时（10 分钟）会释放对应 thread，内存不留垃圾
- **对话历史仍以 PostgreSQL 为准**：每轮从库里重建 `SystemPrompt + 长期记忆 + 最近 20 条历史` 作为图输入；检查点只服务中断续跑，所以服务重启后对话上下文照旧可恢复

## SSE 协议

### 1) 请求级流：`POST /api/chat`（fetch + ReadableStream 解析）

| event | data | 说明 |
| --- | --- | --- |
| `start` | `{ts}` | 流开始 |
| `status` | `{step,label,detail,state}` | 过程徽章：`llm_N`（思考/决策）、`tool_N`（工具调用与结果） |
| `delta` | `{text}` | LLM 输出增量 token |
| `ask_location` | `{intent,missing,originMemory,preset}` | 意图已识别但缺城市槽位：前端弹窗选地址（`originMemory` 为记忆中的常用寄出城市，用于预填） |
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

其他接口：`GET /api/history?sessionId=`（拉取历史对话，前端刷新后回显）、`POST /api/chat/slots`（槽位补全提交：弹窗选完地址后恢复查询，SSE 流式协议同 `/api/chat`）、`GET /api/cities`（地址弹窗下拉数据源：计价城市 / 网点覆盖城市）、`POST /api/human/message`（人工模式发消息）、`POST /api/human/end`（结束会话）、`POST /api/human/transfer`（调试直触转人工）、`GET /api/memory?userId=`（记忆面板数据）、`DELETE /api/memory/:userId/facts/:factId`（删除单条记忆）、`POST /api/memory/forget`（忘记我，清空全部）。

### 3) 客服工作台（`/agent.html`）

| 接口 | 说明 |
| --- | --- |
| `GET /api/humans` | 客服列表（support_human 表：姓名 / 工号 / 在线状态） |
| `POST /api/humans/status` | 上/下岗（`online` 可接单，`offline` 不接单） |
| `GET /api/agent/events?agentId=` | 客服级 SSE：`session_assigned`（新会话分配）/ `user_message`（用户新消息）/ `session_ended` |
| `GET /api/agent/sessions?agentId=` | 我名下进行中的会话列表（含最后消息预览） |
| `POST /api/agent/message` | 客服真人回复（校验会话归属，入库 + 经用户 SSE 实时送达） |
| `POST /api/agent/end` | 客服侧结束会话（双端同步收到结束事件） |

**真人回复链路**：用户"转人工" -> 排队后系统从 `support_human` 取在线客服接入（问候语自动发出）-> 此后用户消息全部经客服级 SSE 实时推送到工作台（未读角标）-> 客服在 `/agent.html` 输入回复 -> `POST /api/agent/message` 校验"该会话是否分配给当前客服"后入库并推送到用户页。客服工作台离线时用户消息照常入库并提示"客服暂时离开，您的消息已记录"（同一会话仅提示一次），客服上线后可在工作台回看并继续处理。

## 替换为真实业务

- `tools.js`：把 mock 实现换成真实轨迹 API、计价引擎、向量检索（RAG）、网点目录服务（POI）；工具签名（zod schema）不变，LLM 侧无需改动
- `llm.js`：更换模型只需改 `DEEPSEEK_MODEL`，或把 ChatDeepSeek 换成其他 ChatModel
- `graph.js`：换更复杂的编排（多 Agent 协作、子图、审批节点）只需改 `StateGraph` 的节点与边；接生产可把 `MemorySaver` 换成持久化 checkpointer（Postgres/Redis），thread 就能跨重启续跑
- `session.js`：人工客服替换为真实客服工单系统（WebSocket / IM 网关）
