# 长期记忆系统功能设计（Long-Term Memory）

> 状态：**P0 已实现**。`server/memory.js`（策略）、`server/memstore.js`（持久层）为核心，`agent.js` / `index.js` / 前端已接入；与实现的差异：显式声明/纠正统一由提取 LLM 输出 `source=explicit` 识别（未做正则直写通道），habit 滑动窗口内去重后 `confidence` 取新旧较大值。

## 1. 背景与目标

**现状**：Demo 已有会话级多轮记忆——`store.js` 把消息持久化到 `data/history.json`，`agent.js` 的 `buildHistoryMessages` 取最近 20 条构建 LLM 上下文。但这只是**会话内短期记忆**：换个 sessionId（新窗口/第二天再来），"您常从杭州发货""上次问过充电宝能不能寄"全部归零，用户必须重新交代背景。

**目标**：

- 跨会话记住用户画像、偏好与业务习惯（城市、产品档位、高频问题、身份角色）
- 记忆**可更新、可冲突消解、可遗忘、可解释**（每条记忆能追溯到原话依据）
- 提取与合并**不阻塞主回答链路**（异步、fire-and-forget）
- 合规兜底：敏感信息不入库，支持"忘记我"一键清除

**非目标**：不做账号体系；demo 阶段 userId 由前端 localStorage 生成传入，无则降级为仅会话内记忆。

## 2. 记忆分层

| 层 | 名称 | 内容 | 生命周期 | 存储 | 现状 |
| --- | --- | --- | --- | --- | --- |
| L0 | 工作记忆 | 当前会话最近 N 条原始消息 | 会话内 | `history.json` | ✅ 已有（`HISTORY_LIMIT=20`） |
| L1 | 情景记忆 | 会话摘要 + 关键事实（"咨询过 SF1234567890 丢件理赔"） | 长期保留、按时间滚动 | `memory.json`（本期新增） | 设计 |
| L2 | 语义记忆 | 用户画像事实（原子化 key-value，见 §3） | 长期，带置信度与 TTL | `memory.json`（本期新增） | 设计 |

回答时注入顺序：`system prompt` → `L2 用户记忆块（top N）` → `L1 相关会话摘要（可选）` → `L0 最近消息`。L2 保证跨会话连续性，L1 提供"上次聊到哪"的上下文，L0 维持本会话细节。

## 3. 数据模型

新增 `data/memory.json`（与 `history.json` 同级，原子写入复用 store 的 save 模式）：

```json
{
  "users": {
    "u_ab12cd34": {
      "createdAt": 1760000000000,
      "updatedAt": 1761000000000,
      "facts": [
        {
          "id": "f_01",
          "type": "attribute",            // attribute | preference | habit | context
          "key": "origin_city",           // 类型内唯一主键
          "value": "杭州",
          "confidence": 0.9,              // 0~1
          "evidence": "我平时都从杭州发货",  // 原话依据，可解释
          "source": "extracted",          // extracted | explicit(用户明说) | correction(用户纠正)
          "hits": 3,                      // 被注入使用的次数
          "createdAt": 1760000000000,
          "updatedAt": 1761000000000,
          "expiresAt": null,              // null=不过期，否则惰性清理
          "status": "active",             // active | archived(旧值版本链) | superseded
          "history": [                    // 被覆盖的旧值，只读，供回溯
            { "value": "上海", "archivedAt": 1760900000000, "evidence": "我在上海上班" }
          ]
        }
      ],
      "summaries": [                      // L1 情景记忆
        { "sessionId": "s_xxx", "summary": "咨询了运单 SF1234567890 的丢件理赔流程", "ts": 1761000000000 }
      ]
    }
  }
}
```

事实类型白名单（`type + key` 组合受控，防止 LLM 提取出垃圾记忆）：

| type | key 示例 | 说明 | 默认 TTL |
| --- | --- | --- | --- |
| attribute | origin_city、business_type、role | 客观属性（寄出城市、电商卖家/个人） | preference 同策略，不过期靠衰减 |
| preference | product_tier、reply_style | 偏好（偏特快/经济、喜欢分点列表） | null（衰减淘汰） |
| habit | frequent_dest、ask_topics | 行为模式（常发北京、高频问禁运品） | 30 天滑动窗口 |
| context | active_case | 进行中的事务（某个运单正在理赔） | 14 天 |

## 4. 整体流程

```
用户消息 ──► agent.js handleAgentMessage
              │
              ├─(1) memory.buildContext(userId)          // 检索 L2/L1 → 拼记忆块
              │        └─ 顺手做惰性清理（TTL 过期 → archived）
              ├─(2) messages = [System, 记忆块, ...history, user]
              ├─(3) Agent 工具调用循环（现有逻辑不变）──► SSE 回复
              │
              └─(4) 回答完成后（不 await，fire-and-forget）
                       memory.extractAndMerge(userId, 本轮 user+assistant, 现有 facts)
                         ├─ LLM 结构化提取 ops[]
                         ├─ 合并/冲突消解（§5.2）
                         ├─ 原子写入 memory.json
                         └─ SSE 推送 memory_saved 事件 ──► 前端徽章"已记住：您常从杭州发货"
```

提取失败/超时静默吞掉（try-catch + console.warn），绝不影响主链路。

## 5. 更新策略（核心）

### 5.1 记忆提取（Extract）

**触发时机与去抖**：

- 每轮回答完成后触发，但用 **10 秒滑动窗口去抖**：窗口内的多轮对话合并成一次提取（用户连续追问运费时避免每轮都提取一遍）
- 会话空闲超时（30 分钟无消息）或 `POST /api/human/end` 时，额外触发一次 **会话摘要提取**（写入 L1 summaries，每会话上限 20 条，超出按时间淘汰）

**提取输入**：本轮 `user + assistant` 消息 + 现有相关 facts（让模型做增量决策而不是重复提取）。

**提取输出协议**（LLM JSON 输出，temperature=0）：

```json
{
  "ops": [
    { "op": "upsert", "type": "attribute", "key": "origin_city",
      "value": "杭州", "confidence": 0.9, "evidence": "我平时都从杭州发货" },
    { "op": "delete", "key": "origin_city", "reason": "用户明确否认" }
  ]
}
```

规则：只允许输出白名单内的 `type+key`；`confidence` 显式声明 1.0、推断 0.6~0.8、模糊 0.4；一句话尽量只产生 ≤2 条 op，宁缺毋滥。

**显式直写通道**：用户说"记住，我的发货地是深圳"这类明确指令时，跳过 LLM 提取，以 `source=explicit, confidence=1.0` 直接 upsert（正则粗筛 + 提取模型兜底均可）。

### 5.2 合并与冲突消解（Merge / Conflict Resolution）

以 `(type, key)` 为主键 upsert，对每条 op 决策：

| 情况 | 处理 |
| --- | --- |
| 无同名事实 | 新增，status=active |
| value 相同 | 命中：`hits+1`，`confidence = min(1, c + 0.05)`，刷新 updatedAt |
| value 不同（普通覆盖） | 计算新旧 `score = confidence × recency`（见 §5.3）。新 score ≥ 旧 score → 新值生效，旧值压入 `history[]` 归档；新 score < 旧 score − 0.2 → 丢弃新值（避免低置信噪声冲掉稳定记忆），console 记录 |
| value 不同（用户显式纠正，source=correction 或本轮出现"不对/我不是/改一下"） | **无条件覆盖**，旧值归档。纠正信号优先级最高 |
| `op: delete` | status → superseded 并从注入候选中剔除（物理删除延迟到清理任务） |
| habit 类（如 frequent_dest） | 不做单值覆盖，维护**最近 3 个不同值**的滑动窗口（数组 value） |

置信度后续演化：

- 被注入使用一次：`+0.05`（封顶 1.0）——常被用到的记忆越来越可信
- 被新证据矛盾但未被覆盖：`-0.2`
- 长期未命中随 recency 自然衰减（§5.3）

### 5.3 时间衰减与遗忘（Decay / Forget）

**recency 函数**（半衰期按类型区分）：

```
recency = 0.5 ^ (Δdays / half_life)      // Δdays = 距 updatedAt 的天数
attribute: half_life = 90 天（城市、身份这类变化慢）
preference: half_life = 60 天
context:    half_life = 14 天（进行中的事务很快过期）
```

**TTL（expiresAt）**：context 类写入时设 14 天；habit 类采用"最近 3 值"滑动窗口天然滚动，无需 TTL。

**清理时机（惰性 + 兜底）**：

- 惰性：每次 `buildContext` 读取时顺手扫描，`expiresAt` 已过或 `confidence < 0.3` → status=archived（软删除，注入时跳过）
- 兜底：每日定时任务（`setInterval` 24h）全量清理一次，物理删除 archived 超 90 天的条目

**容量上限**：每用户 facts ≤ 100 条。超出时按 `score = confidence × recency` 升序淘汰最低分（淘汰也走 archived，可回溯）。

### 5.4 用户纠正与删除

- **定向纠正**：提取阶段识别否定语义（"不对，我是在深圳的""别记这个了"）→ 生成 update/delete op，§5.2 走无条件覆盖
- **查看记忆**：`GET /api/memory?userId=` 返回全部 active facts（前端可做"我的记忆"面板，演示可解释性）
- **单条删除**：`DELETE /api/memory/:userId/facts/:factId`
- **忘记我（合规）**：`POST /api/memory/forget` 清空该 userId 全部 facts + summaries

### 5.5 幂等与并发

- 提取是异步并发场景，`memory.json` 读写收敛到单一 store 模块（同 `store.js` 的同步读写 + 原子 rename），Node 单进程内天然串行
- 同一轮消息重复触发提取：以 `(userId, messageTs)` 做去重标记，处理过直接跳过
- 服务重启无状态损失：一切以 `memory.json` 为准

## 6. 检索与注入

**排序**：`score = confidence × recency`，取 top 8，token 预算约 300 tokens（每条一行）。

**注入格式**（拼在 system prompt 之后的独立 SystemMessage，与现有 `SYSTEM_PROMPT` 解耦）：

```
[用户长期记忆 —— 可能过时，仅作参考，与用户当前表述冲突时以用户为准]
- 常用寄出城市：杭州（依据："我平时都从杭州发货"）
- 业务身份：电商卖家，日均约 30 单
- 偏好：注重时效，倾向特快
- 近期事务：运单 SF1234567890 正在理赔中（2026-10-05）
```

要点：

- 明确标注"可能过时、以用户当前表述为准"，防止模型拿旧记忆顶撞用户
- 附 `evidence` 摘要，模型可判断适用性，也便于调试
- 命中记忆并被本轮实际复用（简化判定：本轮调用了 query_freight 且 origin 来自记忆）→ `hits+1`
- 向前端 SSE 推送 `memory_used` 事件，聊天界面显示"参考了记忆：常用寄出城市·杭州"徽章

检索实现从简到难：**阶段一全量注入**（facts ≤ 100 直接打分排序）→ **阶段二关键词打分**（复用 `tools.js` 的 `scoreKnowledge` 思路）→ **阶段三向量检索**（summaries 与长记忆向量化）。

## 7. 代码集成点

| 文件 | 改动 |
| --- | --- |
| `server/memory.js`（新增） | `buildContext(userId)`、`extractAndMerge(...)`（提取 prompt + JSON 解析 + §5.2 合并）、`explicitWrite(...)`、惰性清理；LLM 调用复用 `llm.js` |
| `server/memstore.js`（新增） | `data/memory.json` 读写（复制 store.js 的原子写模式）：`getUser / upsertFact / archiveFact / listFacts` 等 |
| `server/agent.js` | ① `handleAgentMessage` 开头：`const memoryBlock = buildContext(userId)`，插入 messages；② 循环结束后：`void extractAndMerge(...)` 不 await；③ `bindTools` 的 query_freight 未传 origin 时从记忆补默认值 |
| `server/index.js` | chat 请求体新增可选 `userId`；新增 `GET /api/memory`、`DELETE /api/memory/:uid/facts/:fid`、`POST /api/memory/forget` |
| `public/app.js` | localStorage 生成 userId；监听 `memory_saved / memory_used` 事件渲染徽章；"我的记忆"面板 + 清除按钮 |
| `server/store.js` | 不动。记忆独立文件，避免与 history.json 互相影响 |

核心伪代码（合并）：

```js
function applyOp(facts, op) {
  const key = `${op.type}.${op.key}`;
  const old = facts.find((f) => f.status === 'active' && `${f.type}.${f.key}` === key);
  if (op.op === 'delete' && old) { archive(old, op.reason); return; }

  const isNew = !old;
  const correction = op.source === 'correction' || op.source === 'explicit';
  if (old && !isNew && !correction) {
    const newScore = op.confidence * recencyOf(op);          // 新证据视为刚发生
    const oldScore = old.confidence * recencyOf(old);
    if (newScore < oldScore - 0.2) return;                    // 低置信噪声，丢弃
  }
  if (old) archive(old);                                      // 旧值入 history[]
  facts.push(toFact(op, { source: op.source ?? 'extracted' }));
}
```

## 8. API 设计

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/memory?userId=` | 返回 active facts + summaries（调试 / "我的记忆"面板） |
| DELETE | `/api/memory/:userId/facts/:factId` | 删除单条记忆 |
| POST | `/api/memory/forget` `{userId}` | 清空该用户全部记忆（合规） |
| SSE（既有通道） | `memory_saved` `{key,value}` / `memory_used` `{key,value}` | 前端徽章 |

## 9. 演示场景

| 步骤 | 操作 | 预期效果 |
| --- | --- | --- |
| 1 | 会话 A："我常从杭州发货，主要发电商件" | 回答后徽章"已记住：常用寄出城市·杭州、业务身份·电商卖家" |
| 2 | **新开会话 B**："寄 10kg 到北京多少钱？" | 无需再问寄出地，直接按杭州估算；徽章"参考了记忆" |
| 3 | 会话 B："不对，我最近搬到深圳了" | 旧值"杭州"归档进 history，新值"深圳"生效（memory_saved） |
| 4 | 一周后再来 | "杭州"因被覆盖已失效；"深圳"confidence 升至 0.95 |
| 5 | "忘记我对你的所有记忆" / 点"清除记忆" | 返回空画像，确认合规能力 |

## 10. 演进路线

1. **P0（本设计）**：JSON 持久化 + LLM 提取 + 规则合并，单机跑通闭环，重点验证更新策略
2. **P1**：接入 SQLite（替 memstore），提取改批量队列，补会话摘要的检索过滤
3. **P2**：facts 向量化（OpenAI/本地 embedding），summaries 语义检索，解决记忆量大后的精准召回
4. **P3**：评估 Mem0 / Zep / LangGraph Store 等现成方案，若其合并与衰减策略满足业务则替换自研部分
