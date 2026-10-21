// ============ 物流智能客服 · 前端逻辑 ============
// 两条 SSE 通道：
// 1) POST /api/chat —— fetch 读取请求级 SSE 流（status/delta/done）
// 2) GET  /api/events —— EventSource 会话级通道（转人工排队/接入/人工消息/结束）

const $ = (s) => document.querySelector(s);

const messagesEl = $('#messages');
const inputEl = $('#input');
const sendBtn = $('#sendBtn');
const bannerEl = $('#banner');
const modeTextEl = $('#modeText');
const endHumanBtn = $('#endHumanBtn');
const humanTypingEl = $('#humanTyping');
const connDot = $('#connDot');
const connText = $('#connText');
const sessionShortEl = $('#sessionShort');
const transferBtn = $('#transferBtn');
const chatEl = document.querySelector('.chat');

const ICONS = {
  agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V5"/><circle cx="12" cy="3.5" r="1"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M9.5 16.5h5"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>',
  human: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13a8 8 0 0 1 16 0"/><rect x="2.5" y="13" width="4.5" height="6.5" rx="2"/><rect x="17" y="13" width="4.5" height="6.5" rx="2"/></svg>'
};
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

const state = {
  sessionId: loadSessionId(),
  mode: 'agent', // agent | pending | human
  busy: false,
  agentName: ''
};

function loadSessionId() {
  let id = null;
  try { id = localStorage.getItem('cs_session_id'); } catch { /* ignore */ }
  if (!id) {
    id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem('cs_session_id', id); } catch { /* ignore */ }
  }
  return id;
}

/* ---------- 渲染工具 ---------- */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function md(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
}
// 流式渲染：未闭合的 ** 先按普通文本展示，避免闪烁
function renderStreamMd(text) {
  const stars = (text.match(/\*\*/g) || []).length;
  if (stars % 2 === 1) text = text.replace(/\*\*([^*]*)$/, '$1');
  return md(text);
}
function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, text, name) {
  const row = document.createElement('div');
  row.className = 'msg ' + role;
  row.innerHTML =
    `<div class="avatar ${role}">${ICONS[role]}</div>` +
    `<div class="body">${name ? `<div class="who">${escapeHtml(name)}</div>` : ''}<div class="bubble"></div></div>`;
  row.querySelector('.bubble').innerHTML = md(text);
  messagesEl.appendChild(row);
  scrollBottom();
  return row.querySelector('.bubble');
}

function addUserMessage(text) {
  addMessage('user', text);
}

function addSystem(text) {
  const el = document.createElement('div');
  el.className = 'system';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollBottom();
}

function createAgentMessage() {
  const row = document.createElement('div');
  row.className = 'msg agent';
  row.innerHTML =
    `<div class="avatar agent">${ICONS.agent}</div>` +
    `<div class="body"><div class="trace"></div><div class="bubble"><span class="dots"><i></i><i></i><i></i></span></div></div>`;
  messagesEl.appendChild(row);
  scrollBottom();
  return { traceEl: row.querySelector('.trace'), bubble: row.querySelector('.bubble') };
}

function upsertTrace(traceEl, data) {
  let pill = traceEl.querySelector(`[data-step="${data.step}"]`);
  if (!pill) {
    pill = document.createElement('div');
    pill.className = 'trace-step';
    pill.dataset.step = data.step;
    pill.innerHTML = '<span class="t-icon"></span><span class="t-label"></span>';
    traceEl.appendChild(pill);
  }
  pill.querySelector('.t-label').textContent = data.label + (data.detail ? ` · ${data.detail}` : '');
  pill.classList.toggle('active', data.state === 'active');
  pill.classList.toggle('done', data.state === 'done');
  pill.querySelector('.t-icon').innerHTML = data.state === 'done' ? CHECK_SVG : '';
  scrollBottom();
}
/* ---------- 模式与连接状态 ---------- */
function setConn(on) {
  connDot.classList.toggle('on', on);
  connText.textContent = on ? '已连接' : '连接断开，重连中…';
}
function setBanner(text) {
  if (text) {
    bannerEl.textContent = text;
    bannerEl.classList.remove('hidden');
  } else {
    bannerEl.classList.add('hidden');
  }
}
function updateMode() {
  if (state.mode === 'agent') modeTextEl.textContent = '智能客服模式 · DeepSeek 工具调用';
  else if (state.mode === 'pending') modeTextEl.textContent = '人工客服接入中…';
  else modeTextEl.textContent = `人工客服模式 · ${state.agentName || '客服'} 为您服务`;
  endHumanBtn.classList.toggle('hidden', state.mode === 'agent');
  chatEl.classList.toggle('human-mode', state.mode !== 'agent');
  inputEl.placeholder =
    state.mode === 'agent'
      ? '请输入您的问题，Enter 发送，Shift+Enter 换行'
      : state.mode === 'pending'
        ? '人工客服接入中，您的消息将由人工客服回复…'
        : `正在与人工客服 ${state.agentName || '客服'} 对话，点击右上角可结束会话`;
}
function showHumanTyping(on) {
  humanTypingEl.classList.toggle('hidden', !on);
}

/* ---------- 会话级 SSE（EventSource）：转人工全流程 ---------- */
function connectEvents() {
  const es = new EventSource(`/api/events?sessionId=${encodeURIComponent(state.sessionId)}`);
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);

  es.addEventListener('connected', () => setConn(true));

  es.addEventListener('transfer', (e) => {
    const d = JSON.parse(e.data);
    state.mode = 'pending';
    updateMode();
    setBanner(`已为您转接人工客服，当前排队第 ${d.queuePosition} 位，预计等待约 ${d.estimatedWaitMin} 分钟，请稍候…`);
    addSystem('会话已转接人工客服');
  });

  es.addEventListener('human_joined', (e) => {
    const d = JSON.parse(e.data);
    state.mode = 'human';
    state.agentName = d.agent.name;
    updateMode();
    setBanner(`人工客服 ${d.agent.name}（工号 ${d.agent.code}）已接入，正在为您服务`);
    addSystem(`人工客服 ${d.agent.name} 已加入会话`);
  });

  es.addEventListener('human_message', (e) => {
    const d = JSON.parse(e.data);
    showHumanTyping(false);
    if (d.from === 'agent') addMessage('human', d.text, `人工客服 · ${state.agentName || '客服'}`);
    else addSystem(d.text);
  });

  es.addEventListener('human_typing', (e) => {
    showHumanTyping(!!JSON.parse(e.data).typing);
  });

  es.addEventListener('human_ended', () => {
    showHumanTyping(false);
    state.mode = 'agent';
    state.agentName = '';
    updateMode();
    setBanner(null);
    addSystem('人工会话已结束，已切回智能客服模式');
  });
}

/* ---------- 请求级 SSE（fetch 流式读取）：Agent 回复 ---------- */
function parseSSE(raw) {
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  return { event, data: dataLines.join('\n') };
}

async function sendMessage(text) {
  text = (text || '').trim();
  if (!text) return;
  if (state.mode !== 'agent') return sendHuman(text);
  if (state.busy) return;
  state.busy = true;
  setInputEnabled(false);
  addUserMessage(text);

  const ctx = { text: '' };
  const { traceEl, bubble } = createAgentMessage();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, message: text })
    });
    if (!res.ok) {
      let msg = `请求失败（HTTP ${res.status}）`;
      try {
        const j = await res.json();
        if (j.message) msg = j.message;
      } catch { /* ignore */ }
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const { event, data } = parseSSE(raw);
        if (!data) continue;
        handleStreamEvent(event, JSON.parse(data), { traceEl, bubble, ctx });
      }
    }
  } catch (err) {
    bubble.innerHTML = md(`抱歉，请求出现异常：${err.message}。请稍后重试，或输入"转人工"。`);
  } finally {
    state.busy = false;
    setInputEnabled(true);
  }
}

function handleStreamEvent(event, data, { traceEl, bubble, ctx }) {
  if (event === 'status') {
    upsertTrace(traceEl, data);
  } else if (event === 'delta') {
    ctx.text += data.text;
    bubble.innerHTML = renderStreamMd(ctx.text) + '<span class="cursor"></span>';
    scrollBottom();
  } else if (event === 'done') {
    bubble.innerHTML = md(ctx.text);
  } else if (event === 'error') {
    bubble.innerHTML = md('抱歉，服务出现异常，请稍后重试。');
  }
}
/* ---------- 人工模式发消息 ---------- */
async function sendHuman(text) {
  addUserMessage(text);
  try {
    const res = await fetch('/api/human/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, message: text })
    });
    if (res.status === 409) {
      state.mode = 'agent';
      state.agentName = '';
      updateMode();
      setBanner(null);
      addSystem('人工会话已失效，已切回智能客服模式');
    }
  } catch (err) {
    addSystem(`消息发送失败：${err.message}`);
  }
}

/* ---------- 输入交互 ---------- */
function autoSize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
}
function updateSendState() {
  sendBtn.disabled = state.busy || !inputEl.value.trim();
}
function setInputEnabled(on) {
  inputEl.disabled = !on;
  transferBtn.disabled = !on;
  if (on) {
    updateSendState();
    inputEl.focus();
  } else {
    sendBtn.disabled = true;
  }
}
function submit() {
  const text = inputEl.value.trim();
  if (!text) return;
  if (state.mode === 'agent' && state.busy) return;
  inputEl.value = '';
  autoSize();
  updateSendState();
  sendMessage(text);
}

inputEl.addEventListener('input', () => {
  autoSize();
  updateSendState();
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});
sendBtn.addEventListener('click', submit);

endHumanBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/human/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId })
    });
  } catch { /* ignore */ }
});

// 输入区"转人工"按钮：直接发送转人工请求
transferBtn.addEventListener('click', () => {
  if (state.mode !== 'agent' || state.busy) return;
  sendMessage('转人工');
});

$('#quickList').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  inputEl.value = btn.textContent;
  updateSendState();
  submit();
});

/* ---------- 历史对话（服务端 JSON 持久化） ---------- */
function renderHistory(messages) {
  for (const m of messages) {
    if (m.role === 'user') addMessage('user', m.content);
    else if (m.role === 'assistant') addMessage('agent', m.content);
    else if (m.role === 'human_agent') addMessage('human', m.content, `人工客服 · ${m.name || '客服'}`);
    else if (m.role === 'system') addSystem(m.content);
  }
  return messages.length > 0;
}

// 恢复持久化的人工会话状态（刷新页面后不丢人工模式）
function restoreHumanState(h) {
  if (!h || h.status === 'ended') return;
  if (h.status === 'queued') {
    state.mode = 'pending';
    setBanner(`已为您转接人工客服，当前排队第 ${h.queuePosition || 1} 位，预计等待约 2 分钟，请稍候…`);
  } else if (h.status === 'active') {
    state.mode = 'human';
    state.agentName = h.agent?.name || '';
    setBanner(`人工客服 ${state.agentName || '客服'}（工号 ${h.agent?.code || '-'}）已接入，正在为您服务`);
  }
  updateMode();
}

async function loadHistory() {
  try {
    const res = await fetch(`/api/history?sessionId=${encodeURIComponent(state.sessionId)}`);
    if (!res.ok) return false;
    const data = await res.json();
    const hasHistory = renderHistory(data.messages || []);
    restoreHumanState(data.human);
    return hasHistory;
  } catch {
    return false;
  }
}

/* ---------- 初始化 ---------- */
sessionShortEl.textContent = '会话 ' + state.sessionId.slice(0, 8);
updateMode();
connectEvents();
loadHistory().then((hasHistory) => {
  if (!hasHistory) {
    addMessage(
      'agent',
      '您好，我是小邮，物流智能客服助手。您可以问我：\n1. 运单状态：如"运单 SF1234567890 到哪了"\n2. 运费时效：如"寄 10kg 到北京多少钱，几天能到"\n3. 寄递知识：如"哪些物品不能寄"、"理赔流程"\n也可以随时输入"转人工"转接人工客服。'
    );
  }
});
inputEl.focus();
