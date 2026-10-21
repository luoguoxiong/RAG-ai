// ============ 人工客服工作台 ============
// 客服列表（support_human）-> 上岗 -> 会话自动分配（SSE session_assigned）
// -> 实时收用户消息（SSE user_message）-> 真人回复（POST /api/agent/message）
// 回复经用户会话级 SSE 实时送达用户聊天页。

const $ = (s) => document.querySelector(s);

const loginView = $('#loginView');
const humanListEl = $('#humanList');
const workView = $('#workView');
const sessionListEl = $('#sessionList');
const convEmptyEl = $('#convEmpty');
const convCountEl = $('#convCount');
const connDot = $('#connDot');
const connText = $('#connText');
const offlineBtn = $('#offlineBtn');
const convTitle = $('#convTitle');
const agentInfoText = $('#agentInfoText');
const endConvBtn = $('#endConvBtn');
const convBanner = $('#convBanner');
const messagesEl = $('#messages');
const inputEl = $('#input');
const sendBtn = $('#sendBtn');

const ICONS = {
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>',
  agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V5"/><circle cx="12" cy="3.5" r="1"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M9.5 16.5h5"/></svg>',
  human: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13a8 8 0 0 1 16 0"/><rect x="2.5" y="13" width="4.5" height="6.5" rx="2"/><rect x="17" y="13" width="4.5" height="6.5" rx="2"/></svg>',
  conv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
};

const state = {
  agentId: null,      // 当前上岗客服 id（support_human.id）
  agent: null,        // { id, name, code }
  sessions: [],        // 名下 active 会话
  activeSessionId: null,
  unread: new Map(),   // sessionId -> 未读条数
  es: null
};

/* ---------- 工具 ---------- */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function md(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
}
function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function timeShort(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function setConn(on) {
  connDot.classList.toggle('on', on);
  connText.textContent = on ? `已连接 · ${state.agent?.name || ''} 在岗` : '连接断开，重连中…';
}
function setConvBanner(text) {
  if (text) {
    convBanner.textContent = text;
    convBanner.classList.remove('hidden');
  } else {
    convBanner.classList.add('hidden');
  }
}
async function api(url, opts) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || data.message || `请求失败（HTTP ${res.status}}`), { status: res.status });
  return data;
}

/* ---------- 消息渲染（客服视角：用户在左，客服在右） ---------- */
function addMessage(role, text, who) {
  const row = document.createElement('div');
  const byAgent = role === 'human_agent';
  row.className = 'msg ' + (byAgent ? 'by-agent' : '');
  const avatarClass = role === 'user' ? 'user' : role === 'assistant' ? 'agent' : 'human';
  row.innerHTML =
    `<div class="avatar ${avatarClass}">${ICONS[role === 'assistant' ? 'agent' : role === 'user' ? 'user' : 'human']}</div>` +
    `<div class="body">${who ? `<div class="who">${escapeHtml(who)}</div>` : ''}<div class="bubble"></div></div>`;
  row.querySelector('.bubble').innerHTML = md(text);
  messagesEl.appendChild(row);
  scrollBottom();
}

function addSystem(text) {
  const el = document.createElement('div');
  el.className = 'system';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollBottom();
}

function showEmpty() {
  messagesEl.innerHTML =
    `<div class="agent-empty">
      <div class="agent-empty-ic">${ICONS.conv}</div>
      <h3>等待接入会话</h3>
      <p>用户在聊天页点击"转人工"，会话将自动分配给您。<br />选择左侧会话即可回复用户，回复会实时送达用户页面。</p>
    </div>`;
}

/* ---------- 客服列表（登录视图） ---------- */
async function fetchHumans() {
  const data = await api('/api/humans');
  return data.humans || [];
}

function renderHumanList(humans) {
  loginView.classList.remove('hidden');
  workView.classList.add('hidden');
  offlineBtn.classList.add('hidden');
  humanListEl.innerHTML = humans.length
    ? humans
        .map(
          (h) =>
            `<div class="human-card" data-id="${h.id}">` +
            `<div class="avatar-sm">${escapeHtml(h.name.slice(0, 1))}</div>` +
            `<div class="human-info"><b>${escapeHtml(h.name)}</b><small>工号 ${escapeHtml(h.code)}</small><br>` +
            `<span class="status-pill ${h.status === 'online' ? 'online' : 'offline'}">${h.status === 'online' ? '在线' : '离线'}</span></div>` +
            `<button class="ghost">上岗</button></div>`
        )
        .join('')
    : '<div class="human-loading">客服表中暂无客服</div>';
}

humanListEl.addEventListener('click', (e) => {
  const card = e.target.closest('.human-card');
  if (!card) return;
  const id = Number(card.dataset.id);
  fetchHumans()
    .then((humans) => {
      const me = humans.find((h) => h.id === id);
      if (me) goOnline(me);
    })
    .catch((err) => alert(err.message));
});

/* ---------- 上岗 / 下岗 ---------- */
async function goOnline(me) {
  state.agentId = me.id;
  state.agent = me;
  try { localStorage.setItem('cs_agent_id', String(me.id)); } catch { /* ignore */ }

  await api('/api/humans/status', { method: 'POST', body: JSON.stringify({ agentId: me.id, status: 'online' }) });

  loginView.classList.add('hidden');
  workView.classList.remove('hidden');
  offlineBtn.classList.remove('hidden');
  agentInfoText.textContent = `当前身份：${me.name}（工号 ${me.code}）· 在线接单中`;
  convTitle.textContent = '人工客服工作台';

  showEmpty();
  connectAgentEvents();
  await loadSessions();
  inputEl.disabled = false;
}

async function goOffline() {
  if (state.activeSessionId) {
    if (!confirm('有正在进行的会话，下岗前会先结束当前打开的会话，确定吗？')) return;
    await endConversation(state.activeSessionId);
  }
  try {
    await api('/api/humans/status', { method: 'POST', body: JSON.stringify({ agentId: state.agentId, status: 'offline' }) });
  } catch { /* ignore */ }
  state.es?.close();
  state.es = null;
  state.agentId = null;
  state.agent = null;
  state.sessions = [];
  state.activeSessionId = null;
  state.unread.clear();
  try { localStorage.removeItem('cs_agent_id'); } catch { /* ignore */ }
  inputEl.disabled = true;
  inputEl.value = '';
  sendBtn.disabled = true;
  endConvBtn.classList.add('hidden');
  setConvBanner(null);
  agentInfoText.textContent = '从左侧客服列表选择身份上岗后开始接单';
  connText.textContent = '未连接';
  connDot.classList.remove('on');
  renderHumanList(await fetchHumans());
}

offlineBtn.addEventListener('click', () => goOffline().catch((err) => alert(err.message)));

/* ---------- 客服级 SSE：新会话分配 / 用户新消息 / 会话结束 ---------- */
function connectAgentEvents() {
  state.es?.close();
  const es = new EventSource(`/api/agent/events?agentId=${state.agentId}`);
  state.es = es;
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);

  es.addEventListener('connected', () => setConn(true));

  es.addEventListener('session_assigned', (e) => {
    const d = JSON.parse(e.data);
    setConvBanner(`新会话已接入：${d.sessionId.slice(0, 14)}…（用户已收到您的问候，等待用户提问）`);
    loadSessions();
  });

  es.addEventListener('user_message', (e) => {
    const d = JSON.parse(e.data);
    if (d.sessionId === state.activeSessionId) {
      addMessage('user', d.text);
      messagesEl.insertAdjacentHTML('beforeend', '<div class="agent-typing">等待您回复…</div>');
      scrollBottom();
    } else {
      state.unread.set(d.sessionId, (state.unread.get(d.sessionId) || 0) + 1);
      loadSessions();
    }
  });

  es.addEventListener('session_ended', (e) => {
    const d = JSON.parse(e.data);
    state.unread.delete(d.sessionId);
    if (d.sessionId === state.activeSessionId) {
      addSystem('用户已结束会话（或已切回智能客服）');
      endConvBtn.classList.add('hidden');
    }
    loadSessions();
  });
}

/* ---------- 会话列表 ---------- */
async function loadSessions() {
  const data = await api(`/api/agent/sessions?agentId=${state.agentId}`);
  state.sessions = data.sessions || [];
  const activeIds = new Set(state.sessions.map((s) => s.session_id));
  for (const k of state.unread.keys()) if (!activeIds.has(k)) state.unread.delete(k);
  renderSessionList();
}

function renderSessionList() {
  convCountEl.textContent = state.sessions.length ? `(${state.sessions.length})` : '';
  convEmptyEl.classList.toggle('hidden', state.sessions.length > 0);
  sessionListEl.innerHTML = state.sessions
    .map(
      (s) => {
        const n = state.unread.get(s.session_id) || 0;
        return `<div class="conv-item ${s.session_id === state.activeSessionId ? 'active' : ''}" data-id="${escapeHtml(s.session_id)}">` +
          `<div class="conv-ic">${ICONS.conv}</div>` +
          `<div class="conv-main"><b>${escapeHtml(s.session_id.slice(0, 16))}…</b>` +
          `<small>${escapeHtml(String(s.last_message || '暂无消息').slice(0, 26))} · ${timeShort(s.updated_at)}</small></div>` +
          (n ? `<span class="conv-badge">${n > 99 ? '99+' : n}</span>` : '') +
          '</div>';
      }
    )
    .join('');
}

sessionListEl.addEventListener('click', (e) => {
  const item = e.target.closest('.conv-item');
  if (!item) return;
  openSession(item.dataset.id);
});

/* ---------- 打开会话：拉历史并渲染（客服视角） ---------- */
async function openSession(sessionId) {
  if (sessionId === state.activeSessionId) return;
  state.activeSessionId = sessionId;
  state.unread.delete(sessionId);
  endConvBtn.classList.remove('hidden');

  messagesEl.innerHTML = '';
  let data;
  try {
    data = await api(`/api/history?sessionId=${encodeURIComponent(sessionId)}`);
  } catch (err) {
    addSystem(`历史加载失败：${err.message}`);
    return;
  }
  for (const m of data.messages || []) {
    if (m.role === 'user') addMessage('user', m.content, '用户');
    else if (m.role === 'human_agent') addMessage('human_agent', m.content, `我 · ${m.name || '客服'}`);
    else if (m.role === 'assistant') addMessage('assistant', m.content, '智能客服（历史）');
    else if (m.role === 'system') addSystem(m.content);
  }
  const h = data.human;
  convTitle.textContent = `会话 ${sessionId.slice(0, 16)}…`;
  agentInfoText.textContent = h?.status === 'active'
    ? `当前身份：${state.agent.name}（工号 ${state.agent.code}）· 与用户沟通中`
    : `当前身份：${state.agent.name}（工号 ${state.agent.code}）`;
  renderSessionList();
  inputEl.disabled = false;
  inputEl.focus();
  inputEl.placeholder = '输入回复，Enter 发送，Shift+Enter 换行';
}

/* ---------- 回复用户 ---------- */
async function sendReply() {
  const text = inputEl.value.trim();
  if (!text || !state.activeSessionId) return;
  inputEl.value = '';
  autoSize();
  updateSendState();
  addMessage('human_agent', text, `我 · ${state.agent.name}`);
  try {
    await api('/api/agent/message', {
      method: 'POST',
      body: JSON.stringify({ agentId: state.agentId, sessionId: state.activeSessionId, text })
    });
  } catch (err) {
    addSystem(`发送失败：${err.message}`);
  }
}

/* ---------- 结束会话 ---------- */
async function endConversation(sessionId) {
  try {
    await api('/api/agent/end', {
      method: 'POST',
      body: JSON.stringify({ agentId: state.agentId, sessionId })
    });
  } catch { /* ignore */ }
  if (sessionId === state.activeSessionId) {
    addSystem('会话已结束，用户已切回智能客服模式');
    endConvBtn.classList.add('hidden');
  }
  await loadSessions();
}

endConvBtn.addEventListener('click', () => endConversation(state.activeSessionId));

/* ---------- 输入交互 ---------- */
function autoSize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
}
function updateSendState() {
  sendBtn.disabled = !inputEl.value.trim() || !state.activeSessionId;
}
inputEl.addEventListener('input', () => {
  autoSize();
  updateSendState();
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendReply();
  }
});
sendBtn.addEventListener('click', sendReply);

/* ---------- 初始化：有上岗记录则直接恢复，否则显示客服列表 ---------- */
(async function init() {
  autoSize();
  try {
    const humans = await fetchHumans();
    const savedId = Number(localStorage.getItem('cs_agent_id')) || 0;
    const me = humans.find((h) => h.id === savedId);
    if (me) {
      await goOnline(me);
      return;
    }
    renderHumanList(humans);
  } catch (err) {
    humanListEl.innerHTML = `<div class="human-loading">客服列表加载失败：${escapeHtml(err.message)}</div>`;
  }
})();
