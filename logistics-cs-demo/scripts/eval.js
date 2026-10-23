// ============ 评测脚本：为简历/README 产出可复跑的实测数据 ============
// 全链路真实测量：真实 HTTP/SSE + DeepSeek + PostgreSQL，不做任何 mock 替身。
//
// 用法（在项目根目录）：
//   node scripts/eval.js tools    # 1) 工具选择与参数组装准确率（话术集回归）
//   node scripts/eval.js slots    # 2) 缺参补全成功率（规则快速路径 + 图内 interrupt 续跑）
//   node scripts/eval.js memory   # 3) 长期记忆：写入成功率 / 跨会话召回 / 纠正更新
//   node scripts/eval.js recall   # 4) 记忆注入命中率 Recall@8（top-8 排序回归）
//   node scripts/eval.js load     # 5) 并发压测：首 Token P95 / 完成率
//   node scripts/eval.js restart  # 6) 故障恢复：重启后历史/人工状态/对话恢复成功率
//   node scripts/eval.js all      # 依序执行 1-6
//
// 结果写入 data/eval-<phase>-<RUN>.json；会话/用户数据带 eval-<RUN>- 前缀，结束后自动清理。
import './eval-polyfill.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import * as memstore from '../server/memstore.js';
import { buildContext, forgetAll } from '../server/memory.js';
import { pool } from '../server/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.EVAL_PORT || 3100);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = process.env.EVAL_RUN || Date.now().toString(36);
const WAYBILLS = ['SF1234567890', 'JD1008612345', 'YT9876543210', 'YD7788990011'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sid = (tag) => `eval-${RUN}-${tag}-${Math.random().toString(36).slice(2, 8)}`;
const uid = (tag) => `eval-${RUN}-usr-${tag}`;

// ---------- 服务器进程管理 ----------
let serverProc = null;

async function startServer() {
  const env = { ...process.env, PORT: String(PORT) };
  delete env.NODE_OPTIONS; // 剥离 IDE 注入的 shim，避免子进程 crypto 被破坏
  serverProc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = fs.openSync(path.join(ROOT, 'data', `eval-server-${RUN}.log`), 'a');
  serverProc.stdout.on('data', (d) => fs.writeSync(log, d));
  serverProc.stderr.on('data', (d) => fs.writeSync(log, d));
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (serverProc.exitCode !== null) throw new Error(`server 提前退出(code=${serverProc.exitCode})，见 data/eval-server-${RUN}.log`);
    try {
      const r = await fetch(`${BASE}/api/cities`);
      if (r.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error('server 启动超时');
}

async function stopServer() {
  if (!serverProc) return;
  const p = serverProc;
  serverProc = null;
  p.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      resolve();
    }, 5000);
    p.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

// ---------- HTTP / SSE 客户端 ----------
async function getJson(urlPath) {
  const r = await fetch(`${BASE}${urlPath}`);
  return r.json();
}

async function postJson(urlPath, body) {
  const r = await fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

/** 发起一轮对话并解析请求级 SSE 流：返回事件列表 / 首个 delta 延迟 / 拼接全文 */
async function sseChat(pathname, body, { timeoutMs = 90000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const events = [];
  let firstDeltaMs = null;
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok || !res.body) {
      return { httpStatus: res.status, events, firstDeltaMs: null, text: '' };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const em = raw.match(/^event: (.+)$/m);
        if (!em) continue;
        const dm = raw.match(/^data: (.+)$/m);
        let data = {};
        try { data = dm ? JSON.parse(dm[1]) : {}; } catch {}
        const ev = { event: em[1], data, t: Date.now() - t0 };
        events.push(ev);
        if (ev.event === 'delta' && firstDeltaMs === null) firstDeltaMs = ev.t;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text || '').join('');
  return { httpStatus: 200, events, firstDeltaMs, text };
}

/** 从 status 徽章还原工具执行序列（名称 + 入参 JSON；detail 超 60 字截断时补 '}' 兜底） */
function toolRunsOf(events) {
  const runs = [];
  for (const e of events) {
    if (e.event !== 'status' || e.data.state !== 'active') continue;
    const m = /^调用工具 · (\S+)$/.exec(e.data.label || '');
    if (!m) continue;
    let args = {};
    try {
      args = JSON.parse(e.data.detail || '');
    } catch {
      try { args = JSON.parse(`${e.data.detail}}`); } catch {}
    }
    runs.push({ tool: m[1], args: args && typeof args === 'object' ? args : {} });
  }
  return runs;
}

// ---------- 结果落盘 ----------
function saveReport(phase, report) {
  const file = path.join(ROOT, 'data', `eval-${phase}-${RUN}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`[report] ${file}`);
}

// ---------- 参数匹配 ----------
function matchParam(actual, expect) {
  if (typeof expect === 'function') return !!expect(actual);
  if (typeof expect === 'number') return Number(actual) === expect;
  return String(actual ?? '') === String(expect ?? '');
}

// ================= 1) 工具选择与参数组装 =================
// 覆盖 6 类意图：查运单 / 查运费 / 知识库 / 网点 / 一问多工具 / 免工具闲聊
const TOOL_CASES = [
  // 查运单
  { id: 'ship-1', message: '运单 SF1234567890 到哪了？', tools: ['query_shipment'], params: { query_shipment: { trackingNo: 'SF1234567890' } } },
  { id: 'ship-2', message: '帮我查一下 JD1008612345 的物流状态', tools: ['query_shipment'], params: { query_shipment: { trackingNo: 'JD1008612345' } } },
  { id: 'ship-3', message: 'YT9876543210 现在到哪了？预计什么时候送达？', tools: ['query_shipment'], params: { query_shipment: { trackingNo: 'YT9876543210' } } },
  { id: 'ship-4', message: '我的快递到哪了？', tools: [], params: {} }, // 缺运单号：应文字追问而非瞎调工具
  // 查运费时效
  { id: 'freight-1', message: '寄 10kg 到北京多少钱？多久能到？', tools: ['query_freight'], params: { query_freight: { destination: '北京', weightKg: 10 } } },
  { id: 'freight-2', message: '从广州寄20斤到成都几天到', tools: ['query_freight'], params: { query_freight: { origin: '广州', destination: '成都', weightKg: 10 } } }, // 20斤=10kg
  { id: 'freight-3', message: '杭州到上海的快递费是多少', tools: ['query_freight'], params: { query_freight: { origin: '杭州', destination: '上海' } } },
  { id: 'freight-4', message: '寄5公斤东西去深圳要多久', tools: ['query_freight'], params: { query_freight: { destination: '深圳', weightKg: 5 } } },
  { id: 'freight-5', message: '从乌鲁木齐发 3kg 货到拉萨运费多少', tools: ['query_freight'], params: { query_freight: { origin: '乌鲁木齐', destination: '拉萨', weightKg: 3 } } },
  { id: 'freight-6', message: '从北京寄1公斤到上海要多少钱', tools: ['query_freight'], params: { query_freight: { origin: '北京', destination: '上海', weightKg: 1 } } },
  // 知识库
  { id: 'kb-1', message: '充电宝可以寄吗？', tools: ['query_knowledge'], params: {} },
  { id: 'kb-2', message: '包裹丢了怎么理赔？', tools: ['query_knowledge'], params: {} },
  { id: 'kb-3', message: '保价怎么收费？贵重物品可以保价吗', tools: ['query_knowledge'], params: {} },
  { id: 'kb-4', message: '生鲜要怎么包装？有没有冷链服务', tools: ['query_knowledge'], toolMatch: 'contains', params: {} }, // 两个子问题可拆成多次检索
  // 网点
  { id: 'branch-1', message: '杭州滨江有营业网点吗？', tools: ['query_branches'], params: { query_branches: { city: (v) => /杭州|滨江/.test(String(v)) } } },
  { id: 'branch-2', message: '深圳哪里有 24 小时自提点？', tools: ['query_branches'], params: { query_branches: { city: '深圳', keyword: (v) => !v || /24|自提/.test(String(v)) } } },
  { id: 'branch-3', message: '浙江有哪些网点？', tools: ['query_branches'], params: { query_branches: { city: '浙江' } } },
  { id: 'branch-4', message: '武汉光谷附近有网点吗？', tools: ['query_branches'], params: { query_branches: { city: '武汉' } } },
  // 一问多工具
  { id: 'multi-1', message: '帮我查下 SF1234567890，顺便看看什么不能寄', tools: ['query_shipment', 'query_knowledge'], params: { query_shipment: { trackingNo: 'SF1234567890' } } },
  { id: 'multi-2', message: 'JD1008612345 到哪了？另外从杭州寄10kg到北京多少钱？', tools: ['query_shipment', 'query_freight'], params: { query_freight: { origin: '杭州', destination: '北京', weightKg: 10 } } },
  { id: 'multi-3', message: '查一下深圳的网点，再告诉我充电宝能不能寄', tools: ['query_branches', 'query_knowledge'], params: { query_branches: { city: '深圳' } } },
  // 免工具（闲聊/咨询，不应调工具）
  { id: 'none-1', message: '你好，在吗？', tools: [], params: {} },
  { id: 'none-2', message: '谢谢，麻烦你了', tools: [], params: {} },
  { id: 'none-3', message: '你们好贴心呀', tools: [], params: {} }
];

async function phaseTools() {
  const detail = [];
  for (const c of TOOL_CASES) {
    const sessionId = sid('tool');
    const r = await sseChat('/api/chat', { sessionId, message: c.message });
    const runs = toolRunsOf(r.events);
    const gotTools = runs.map((x) => x.tool).sort();
    const wantTools = [...c.tools].sort();
    const toolOk =
      c.toolMatch === 'contains'
        ? wantTools.every((t) => gotTools.includes(t)) // 允许多次/额外调用（双子问题拆分检索等）
        : JSON.stringify(gotTools) === JSON.stringify(wantTools);
    const hasError = r.events.some((e) => e.event === 'error');
    const doneOk = r.events.some((e) => e.event === 'done');

    let paramOk = true;
    const paramDetail = {};
    for (const [toolName, fields] of Object.entries(c.params)) {
      const run = runs.find((x) => x.tool === toolName);
      for (const [field, want] of Object.entries(fields)) {
        const ok = run ? matchParam(run.args?.[field], want) : false;
        paramDetail[`${toolName}.${field}`] = { want: String(want), got: String(run?.args?.[field]), ok };
        if (!ok) paramOk = false;
      }
    }
    const pass = toolOk && paramOk && doneOk && !hasError && r.text.trim().length > 0;
    detail.push({ id: c.id, message: c.message, pass, toolOk, paramOk, gotTools, wantTools, paramDetail, answer: r.text.slice(0, 80) });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.id.padEnd(10)} ${c.message}`);
  }
  const n = detail.length;
  const toolOkN = detail.filter((d) => d.toolOk).length;
  const paramOkN = detail.filter((d) => d.toolOk && d.paramOk).length;
  const passN = detail.filter((d) => d.pass).length;
  const report = {
    phase: 'tools', run: RUN, cases: n,
    toolSelectAccuracy: +(toolOkN / n * 100).toFixed(1),
    paramAccuracy: +(paramOkN / n * 100).toFixed(1),
    overallAccuracy: +(passN / n * 100).toFixed(1),
    detail
  };
  console.log(`\n工具选择准确率: ${report.toolSelectAccuracy}% (${toolOkN}/${n})`);
  console.log(`参数组装准确率: ${report.paramAccuracy}% (${paramOkN}/${n})`);
  console.log(`综合通过率:     ${report.overallAccuracy}% (${passN}/${n})`);
  saveReport('tools', report);
}

// ================= 2) 缺参补全（弹窗补参 + 断点续跑） =================
const SLOT_CASES = [
  // 规则快速路径（不经 LLM 直接触发弹窗）
  { id: 'slot-fast-freight', message: '帮我查下运费', expectIntent: 'query_freight', submit: { destination: '北京', weightKg: 1 }, checkArgs: { query_freight: { destination: '北京' } } },
  { id: 'slot-fast-branch', message: '帮我查下网点', expectIntent: 'query_branches', submit: { city: '武汉' }, checkArgs: { query_branches: { city: '武汉' } } },
  { id: 'slot-fast-branch2', message: '查一下你们那边的自提点', expectIntent: 'query_branches', submit: { city: '西安' }, checkArgs: { query_branches: { city: '西安' } } },
  // 图内 interrupt() 挂起 + Command({resume}) 续跑（目的地经 interrupt 返回值注入，不在工具入参中）
  { id: 'slot-graph-freight', message: '我在杭州，寄10公斤东西大概多少钱？', expectIntent: 'query_freight', submit: { destination: '北京' }, checkArgs: { query_freight: { origin: '杭州', weightKg: 10 } }, expectText: '北京' }
];

async function phaseSlots() {
  const detail = [];
  for (const c of SLOT_CASES) {
    const sessionId = sid('slot');
    const first = await sseChat('/api/chat', { sessionId, message: c.message });
    const ask = first.events.find((e) => e.event === 'ask_location');
    let pass = false;
    let stage = 'ask_location';
    let second = null;
    if (ask && ask.data.intent === c.expectIntent) {
      second = await sseChat('/api/chat/slots', { sessionId, intent: c.expectIntent, slots: c.submit });
      const runs = toolRunsOf(second.events);
      const doneOk = second.events.some((e) => e.event === 'done' && e.data.mode !== 'slot_filling');
      const hasError = second.events.some((e) => e.event === 'error');
      let argsOk = true;
      for (const [toolName, fields] of Object.entries(c.checkArgs)) {
        const run = runs.find((x) => x.tool === toolName);
        for (const [field, want] of Object.entries(fields)) {
          if (!run || !matchParam(run.args?.[field], want)) argsOk = false;
        }
      }
      stage = 'resume';
      pass = doneOk && !hasError && argsOk && second.text.trim().length > 0;
      if (c.expectText && !second.text.includes(c.expectText)) pass = false;
    }
    detail.push({ id: c.id, message: c.message, pass, stage, asked: !!ask, answer: second ? second.text.slice(0, 60) : '' });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.id.padEnd(18)} ${c.message}`);
  }
  const n = detail.length;
  const okN = detail.filter((d) => d.pass).length;
  const report = {
    phase: 'slots', run: RUN, attempts: n, success: okN,
    successRate: +(okN / n * 100).toFixed(1),
    detail
  };
  console.log(`\n缺参补全成功率: ${report.successRate}% (${okN}/${n})`);
  saveReport('slots', report);
}

// ================= 3) 长期记忆：写入 / 跨会话召回 / 纠正更新 =================
async function phaseMemory() {
  const user = uid('mem');
  const out = { run: RUN, writeTotal: 4, writeHits: 0, write: {}, recall: {}, correction: {} };

  // 3.1 写入：同一会话连发 4 条陈述，一次去抖提取应产出 4 类白名单记忆
  const s1 = sid('mem-seed');
  for (const msg of ['我常从苏州发货，麻烦记一下', '我是做电商的，发货量比较大', '寄东西我一般都选特快，快一点', '最近常往郑州发货']) {
    await sseChat('/api/chat', { sessionId: s1, message: msg, userId: user });
  }
  const deadline = Date.now() + 120000;
  let facts = [];
  while (Date.now() < deadline) {
    await sleep(3000);
    const view = await getJson(`/api/memory?userId=${user}`);
    facts = view.facts || [];
    if (facts.length >= 4) break;
  }
  const expectFacts = [
    ['attribute', 'origin_city', (v) => String(v).includes('苏州')],
    ['attribute', 'business_type', (v) => /电商|微商|卖家/.test(String(v))],
    ['preference', 'product_tier', (v) => String(v).includes('特快')],
    ['habit', 'frequent_dest', (v) => String(v).includes('郑州')]
  ];
  for (const [type, key, test] of expectFacts) {
    const f = facts.find((x) => x.type === type && x.key === key);
    const ok = !!f && test(f.value);
    out.write[`${type}.${key}`] = { ok, value: f ? f.value : null };
    if (ok) out.writeHits++;
  }
  console.log(`记忆写入: ${out.writeHits}/4`);
  for (const [k, v] of Object.entries(out.write)) console.log(`  ${v.ok ? 'PASS' : 'FAIL'}  ${k} = ${v.value}`);

  // 3.2 跨会话召回：全新会话（无历史），常用寄出城市应被用于运费兜底
  const s2 = sid('mem-recall');
  const r2 = await sseChat('/api/chat', { sessionId: s2, message: '寄 5kg 到广州多少钱？', userId: user });
  const badge = r2.events.find((e) => e.event === 'memory_used');
  const fr = toolRunsOf(r2.events).find((x) => x.tool === 'query_freight');
  const viaArgs = fr?.args?.origin === '苏州';
  const viaText = r2.text.includes('苏州');
  out.recall.crossSession = { ok: !!badge || viaArgs || viaText, badge: badge?.data?.value ?? null, viaArgs, viaText };
  console.log(`跨会话召回: ${out.recall.crossSession.ok ? 'PASS' : 'FAIL'} (badge=${!!badge} args=${viaArgs} text=${viaText})`);

  // 3.3 纠正更新：显式纠正寄出城市，旧值应归档进版本链
  const s3 = sid('mem-fix');
  await sseChat('/api/chat', { sessionId: s3, message: '不对，我搬到宁波了', userId: user });
  const deadline2 = Date.now() + 120000;
  let fixed = null;
  while (Date.now() < deadline2) {
    await sleep(3000);
    const view = await getJson(`/api/memory?userId=${user}`);
    fixed = (view.facts || []).find((x) => x.type === 'attribute' && x.key === 'origin_city');
    if (fixed && String(fixed.value).includes('宁波') && fixed.versions >= 1) break;
  }
  out.correction = {
    ok: !!(fixed && String(fixed.value).includes('宁波') && fixed.versions >= 1),
    value: fixed?.value ?? null,
    versions: fixed?.versions ?? 0
  };
  console.log(`纠正更新: ${out.correction.ok ? 'PASS' : 'FAIL'} (value=${out.correction.value}, versions=${out.correction.versions})`);

  out.writeSuccessRate = +(out.writeHits / out.writeTotal * 100).toFixed(1);
  saveReport('memory', out);
}

// ================= 4) 记忆注入命中率 Recall@8 =================
// 用户事实数 ≤ 白名单键数（8），top-8 注入窗口应覆盖全部活跃事实；
// 多画像多键回归验证"提取->落库->top-8 注入"整条链路的排序与覆盖。
async function phaseRecall() {
  const profiles = [
    { keys: [['attribute', 'origin_city', '苏州'], ['attribute', 'business_type', '电商卖家'], ['preference', 'product_tier', '特快'], ['habit', 'frequent_dest', ['郑州', '南京']], ['context', 'active_case', '运单 SF1234567890 正在理赔']] },
    { keys: [['attribute', 'origin_city', '义乌'], ['attribute', 'role', '商家'], ['preference', 'reply_style', '简洁分点'], ['habit', 'ask_topics', '禁运品、理赔']] },
    { keys: [['attribute', 'origin_city', '佛山'], ['preference', 'product_tier', '经济'], ['habit', 'frequent_dest', '长沙'], ['attribute', 'business_type', '微商'], ['context', 'active_case', '改地址工单处理中'], ['attribute', 'role', '个人']] }
  ];
  const probes = [];
  for (let i = 0; i < profiles.length; i++) {
    const user = uid(`recall${i}`);
    const facts = profiles[i].keys.map(([type, key, value], j) => ({
      id: `f_${Date.now().toString(36)}_${i}${j}_${Math.random().toString(36).slice(2, 6)}`,
      type, key, value,
      confidence: 0.6 + 0.08 * ((i + j) % 5),
      evidence: `评测画像 ${i} 事实 ${j}`,
      source: 'explicit',
      hits: 0,
      createdAt: Date.now() - j * 1000,
      updatedAt: Date.now() - j * 1000,
      expiresAt: type === 'context' ? Date.now() + 7 * 86400000 : null,
      status: 'active',
      history: []
    }));
    for (const f of facts) await memstore.putFact(user, f);
    const { usedFacts, block } = await buildContext(user);
    const injected = new Set(usedFacts.map((f) => `${f.type}.${f.key}`));
    let hits = 0;
    for (const f of facts) {
      const ok = injected.has(`${f.type}.${f.key}`) && block.includes(String(Array.isArray(f.value) ? f.value.join('、') : f.value).slice(0, 8));
      if (ok) hits++;
      probes.push({ user, fact: `${f.type}.${f.key}`, ok });
    }
    await memstore.forgetUser(user);
  }
  const total = probes.length;
  const hits = probes.filter((p) => p.ok).length;
  const report = { phase: 'recall', run: RUN, probes: total, hits, recallAt8: +(hits / total * 100).toFixed(1), detail: probes };
  console.log(`\n记忆注入命中率 Recall@8: ${report.recallAt8}% (${hits}/${total})`);
  saveReport('recall', report);
}

// ================= 5) 并发压测：首 Token P95 =================
async function phaseLoad() {
  const TOTAL = Number(process.env.EVAL_LOAD_TOTAL || 50);
  const CONC = Number(process.env.EVAL_LOAD_CONC || 10);
  const utterances = [
    '运单 SF1234567890 到哪了？',
    '查一下 YT9876543210 的物流状态',
    '充电宝可以寄吗？',
    '杭州到上海寄1公斤多少钱？',
    '杭州滨江有营业网点吗？'
  ];
  const latencies = [];
  let okCount = 0;
  const results = new Array(TOTAL);
  const t0 = Date.now();

  async function worker(wid) {
    for (let i = wid; i < TOTAL; i += CONC) {
      const sessionId = sid(`load${i}`);
      try {
        const r = await sseChat('/api/chat', { sessionId, message: utterances[i % utterances.length] }, { timeoutMs: 120000 });
        const hasError = r.events.some((e) => e.event === 'error');
        const ok = !!r.firstDeltaMs && !hasError;
        results[i] = { ok, firstDeltaMs: r.firstDeltaMs };
      } catch {
        results[i] = { ok: false, firstDeltaMs: null };
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, (_, w) => worker(w)));

  for (const r of results) {
    if (!r) continue;
    if (r.ok) { okCount++; latencies.push(r.firstDeltaMs); }
  }
  latencies.sort((a, b) => a - b);
  const pick = (q) => latencies.length ? +(latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] / 1000).toFixed(2) : null;
  const wallSec = +((Date.now() - t0) / 1000).toFixed(1);
  const report = {
    phase: 'load', run: RUN, concurrency: CONC, total: TOTAL,
    success: okCount, successRate: +(okCount / TOTAL * 100).toFixed(1),
    firstTokenP50s: pick(0.5), firstTokenP95s: pick(0.95),
    wallSec, throughputRPM: +(TOTAL / (wallSec / 60)).toFixed(1),
    latenciesMs: latencies
  };
  console.log(`\n压测 ${CONC} 并发 / ${TOTAL} 请求：成功 ${report.successRate}%`);
  console.log(`首 Token P50 = ${report.firstTokenP50s}s, P95 = ${report.firstTokenP95s}s, 吞吐 ≈ ${report.throughputRPM} req/min`);
  saveReport('load', report);
}

// ================= 6) 故障恢复：重启后状态恢复 =================
async function phaseRestart() {
  const ROUNDS = Number(process.env.EVAL_RESTART_ROUNDS || 5);
  const detail = [];
  for (let i = 0; i < ROUNDS; i++) {
    const wb = WAYBILLS[i % WAYBILLS.length];
    const queuedCase = i % 2 === 1; // 奇数轮：接入前宕机（排队态恢复）；偶数轮：接入后宕机（活跃态恢复）
    const sessionId = sid(`rs${i}`);
    let ok = true;
    const steps = {};

    await sseChat('/api/chat', { sessionId, message: `运单 ${wb} 到哪了？` });
    await sseChat('/api/chat', { sessionId, message: '我要投诉' }); // 显式转人工（确定性快速路径）
    if (!queuedCase) await sleep(4800); // 等 mock 客服接入 -> active

    await stopServer();
    await startServer();

    // 恢复后：历史消息完整
    const hist = await getJson(`/api/history?sessionId=${sessionId}`);
    steps.history = (hist.messages || []).some((m) => m.role === 'user' && m.content.includes(wb));
    // 人工会话状态按需恢复（README 设计：重启后首次访问时从持久层恢复）。
    // 模拟用户回访动作触发惰性恢复；queued 场景 joinAt 已过 -> 立即补推接入。
    await postJson('/api/human/message', { sessionId, message: '客服还在吗' });
    const dl = Date.now() + 12000;
    while (Date.now() < dl) {
      const h = (await getJson(`/api/history?sessionId=${sessionId}`)).human;
      if (h?.status === 'active') break;
      await sleep(800);
    }
    steps.humanState = (await getJson(`/api/history?sessionId=${sessionId}`)).human?.status === 'active';
    // 恢复后人工通道可继续收发
    const send = await postJson('/api/human/message', { sessionId, message: '重启后补发的消息' });
    steps.humanMsg = send?.ok === true;
    // 结束人工 -> 智能客服可继续对话（上下文自 PostgreSQL 重建）
    await postJson('/api/human/end', { sessionId });
    const chat = await sseChat('/api/chat', { sessionId, message: '我刚才问的那个运单到哪了？' });
    steps.agentChat = chat.events.some((e) => e.event === 'done') && !chat.events.some((e) => e.event === 'error');

    ok = steps.history && steps.humanState && steps.humanMsg && steps.agentChat;
    detail.push({ round: i + 1, mode: queuedCase ? 'queued' : 'active', waybill: wb, pass: ok, steps });
    console.log(`${ok ? 'PASS' : 'FAIL'}  round ${i + 1} (${queuedCase ? '排队中重启' : '接入后重启'})  ${JSON.stringify(steps)}`);
  }
  const okN = detail.filter((d) => d.pass).length;
  const report = { phase: 'restart', run: RUN, rounds: ROUNDS, recovered: okN, recoveryRate: +(okN / ROUNDS * 100).toFixed(1), detail };
  console.log(`\n故障恢复成功率: ${report.recoveryRate}% (${okN}/${ROUNDS})`);
  saveReport('restart', report);
}

// ================= 清理与入口 =================
async function cleanup() {
  try {
    // 清理评测用户与评测会话（chat_messages 级联删除）
    await pool.query(`DELETE FROM chat_sessions WHERE session_id LIKE $1`, [`eval-${RUN}-%`]);
    const { rows } = await pool.query(`SELECT DISTINCT user_id FROM memory_facts WHERE user_id LIKE $1`, [`eval-${RUN}-%`]);
    for (const r of rows) await forgetAll(r.user_id);
    await pool.query(`DELETE FROM memory_jobs WHERE user_id LIKE $1`, [`eval-${RUN}-%`]);
    await pool.end();
  } catch (err) {
    console.warn('[cleanup] 清理失败（不影响评测结果）:', err.message);
  }
}

const PHASES = { tools: phaseTools, slots: phaseSlots, memory: phaseMemory, recall: phaseRecall, load: phaseLoad, restart: phaseRestart };
const phase = process.argv[2] || 'all';

async function main() {
  console.log(`=== 物流智能客服评测 run=${RUN} phase=${phase} port=${PORT} ===`);
  await startServer();
  console.log(`server ready: ${BASE}`);
  try {
    if (phase === 'all') {
      for (const fn of Object.values(PHASES)) await fn();
    } else {
      if (!PHASES[phase]) throw new Error(`未知 phase: ${phase}（可选: ${Object.keys(PHASES).join('/')}/all）`);
      await PHASES[phase]();
    }
  } finally {
    await stopServer();
    await cleanup();
  }
}

main().catch((err) => {
  console.error('[eval] 失败:', err);
  process.exitCode = 1;
  cleanup();
});
