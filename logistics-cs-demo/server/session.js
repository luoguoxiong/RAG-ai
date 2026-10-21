// ============ 会话级 SSE 通道 + 人工客服会话管理（mock） ============
// 每个浏览器会话通过 GET /api/events?sessionId=xxx 建立一条长连接 EventSource，
// 服务端通过该通道推送：转人工排队、人工接入、人工消息、输入中、会话结束等事件。
import * as store from './store.js';

const channels = new Map(); // sessionId -> Set<ServerResponse>
const humanSessions = new Map(); // sessionId -> human session

function push(sessionId, event, data) {
  const set = channels.get(sessionId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      // 连接已断开，忽略
    }
  }
}

export function addChannel(sessionId, res) {
  if (!channels.has(sessionId)) channels.set(sessionId, new Set());
  const set = channels.get(sessionId);
  set.add(res);
  push(sessionId, 'connected', { sessionId, ts: Date.now() });
  return () => {
    set.delete(res);
    if (!set.size) channels.delete(sessionId);
  };
}

// ---------- 人工会话状态持久化与恢复 ----------
// 状态每次变更都写入 store（data/history.json 的 human 字段），
// 服务重启后内存 Map 为空，首次访问时从持久层恢复：
// - active：直接恢复，人工消息可继续收发
// - queued：按 joinAt 续排接入定时器；已过期的立即补上接入
const JOIN_DELAY_MS = 4000; // 排队后多久 mock 客服接入
const HUMAN_STATE_TTL_MS = 24 * 60 * 60 * 1000; // 超过 24h 的残留人工状态视为已结束

function persistHuman(s) {
  store.setHumanState(s.sessionId, {
    status: s.status,
    queuePosition: s.queuePosition ?? null,
    agent: s.agent || null,
    joinAt: s.joinAt ?? null
  });
}

// 从持久层取人工会话（内存没有时自动恢复）
function getSession(sessionId) {
  let s = humanSessions.get(sessionId);
  if (s) return s;

  const saved = store.getHumanState(sessionId);
  if (!saved || saved.status === 'ended') return null;
  if (saved.updatedAt && Date.now() - saved.updatedAt > HUMAN_STATE_TTL_MS) {
    store.setHumanState(sessionId, { status: 'ended' }); // 残留状态过期清理
    return null;
  }

  s = {
    sessionId,
    status: saved.status,
    queuePosition: saved.queuePosition ?? 1,
    agent: saved.agent || null,
    joinAt: saved.joinAt ?? null,
    timers: [] // 定时器不持久化，恢复后按需重建
  };
  humanSessions.set(sessionId, s);
  if (s.status === 'queued' && s.joinAt) {
    if (Date.now() >= s.joinAt) activate(s, true);
    else s.timers.push(setTimeout(() => activate(s), Math.max(0, s.joinAt - Date.now())));
  }
  return s;
}

// ---------- 人工客服（mock：排队 -> 接入 -> 关键词应答） ----------
const HUMAN_REPLIES = [
  {
    test: /投诉/,
    text: '非常抱歉给您带来了不好的体验。我已记录您的反馈（工单号 TS-20261021-048），专班会在 2 小时内与您电话联系。方便告诉我运单号吗？我帮您加急处理。'
  },
  {
    test: /丢|丢失|丢件|理赔|破损|坏/,
    text: '收到，很抱歉给您造成损失。我已为您登记理赔工单 CL-20261021-112，理赔专员将在 24 小时内联系您。麻烦您保留外包装和物品照片作为凭证，方便定损。'
  },
  {
    test: /改地址|修改地址|换地址/,
    text: '好的，请提供运单号和新收件地址，我马上提交改址申请，一般 30 分钟内生效，不影响时效。'
  },
  {
    test: /催|太慢|迟迟/,
    text: '非常理解您着急的心情，我已帮您向派送网点发起催派，并备注了您的联系方式，预计今天 18:00 前给您答复。'
  },
  {
    test: /退回|拒收|退货/,
    text: '可以的呢。包裹拒收后会原路退回寄件人，退回运费视原因由责任方承担。需要我帮您提交拒收登记吗？'
  },
  {
    test: /保价/,
    text: '保价费率为声明价值的 0.5%（最低 1 元），单票最高 5 万元。3000 元以上的物品建议保价，出险后按保价金额赔付。'
  }
];
const DEFAULT_REPLY = '好的，您的问题我已记录（工单号 GD-20261021-236），我会持续跟进并第一时间回复您。请问还有其他需要帮忙的吗？';

function pickHumanReply(text) {
  for (const r of HUMAN_REPLIES) if (r.test.test(text)) return r.text;
  return DEFAULT_REPLY;
}

// mock 客服接入：推送接入事件 + 问候语（immediate=true 用于重启后补推）
function activate(s, immediate = false) {
  s.status = 'active';
  s.agent = { name: '林晓', code: 'CS1024' };
  persistHuman(s);
  push(s.sessionId, 'human_joined', { agent: s.agent });
  const pushGreeting = () => {
    const greeting = '您好，我是人工客服林晓（工号 CS1024），很高兴为您服务。请描述一下您遇到的问题，我会尽力帮您处理。';
    store.appendMessage(s.sessionId, { role: 'human_agent', name: s.agent.name, content: greeting });
    push(s.sessionId, 'human_message', { from: 'agent', text: greeting });
  };
  if (immediate) pushGreeting();
  else s.timers.push(setTimeout(pushGreeting, 900));
}

// 发起转人工：推送排队事件，4 秒后 mock 客服接入
export function startHumanSession(sessionId) {
  const prev = getSession(sessionId);
  if (prev && prev.status !== 'ended') return prev;

  const s = {
    sessionId,
    status: 'queued',
    queuePosition: 1 + Math.floor(Math.random() * 2),
    agent: null,
    joinAt: Date.now() + JOIN_DELAY_MS,
    timers: []
  };
  humanSessions.set(sessionId, s);
  persistHuman(s);
  store.appendMessage(sessionId, { role: 'system', content: '会话已转接人工客服，排队中' });
  push(sessionId, 'transfer', { queuePosition: s.queuePosition, estimatedWaitMin: 2 });

  s.timers.push(setTimeout(() => activate(s), JOIN_DELAY_MS));
  return s;
}

// 用户在人工模式下发消息 -> mock 客服"输入中"后回复
export function humanUserMessage(sessionId, text) {
  const s = getSession(sessionId);
  if (!s || s.status === 'ended') return false;
  store.appendMessage(sessionId, { role: 'user', content: text });
  if (s.status !== 'active') {
    const notice = '客服正在接入中，您的消息已记录，接入后会第一时间回复您。';
    store.appendMessage(sessionId, { role: 'system', content: notice });
    push(sessionId, 'human_message', { from: 'system', text: notice });
    return true;
  }
  const reply = pickHumanReply(text);
  s.timers.push(setTimeout(() => push(sessionId, 'human_typing', { typing: true }), 500));
  s.timers.push(
    setTimeout(() => {
      store.appendMessage(sessionId, { role: 'human_agent', name: '林晓', content: reply });
      push(sessionId, 'human_typing', { typing: false });
      push(sessionId, 'human_message', { from: 'agent', text: reply });
    }, 1500 + Math.random() * 900)
  );
  return true;
}

// 结束人工会话（用户点击或兜底）
export function endHumanSession(sessionId) {
  const s = getSession(sessionId);
  if (!s) {
    // 重启后内存无该会话时，也确保持久化状态被标记为结束
    const saved = store.getHumanState(sessionId);
    if (saved && saved.status !== 'ended') store.setHumanState(sessionId, { status: 'ended' });
    return;
  }
  for (const t of s.timers) clearTimeout(t);
  s.timers = [];
  s.status = 'ended';
  persistHuman(s);
  store.appendMessage(sessionId, { role: 'system', content: '人工会话已结束，已切回智能客服模式' });
  push(sessionId, 'human_ended', {});
}

export function isHumanActive(sessionId) {
  const s = getSession(sessionId);
  return !!s && s.status !== 'ended';
}
