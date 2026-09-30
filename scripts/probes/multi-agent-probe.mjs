/**
 * 多 Agent 探针(计划 docs/plan/agent-workflow-plan.md A3)。全程本机,不真的调用模型、不花额度:
 * 对话的驱动故意给一个不存在的名字(`probe-none`),/api/ai/chat 登记在起模型之前,起模型那一步直接报错
 * (做法同 scripts/probes/creativity-probe.mjs)。
 *
 *   node scripts/probes/multi-agent-probe.mjs [--phase 1|2|all] [--shots <目录>]
 *        [--origin http://127.0.0.1:5840]                 第一阶段用的编辑器;不给就自己起一台(端口 5840,舞台 5841/5842)
 *        [--a-port 5843] [--b-port 5846] [--doc-port 5850] [--asset-port 5851]   第二阶段自己起的两台编辑器与托管组合
 *
 * 第一阶段(一台编辑器,真的打开编辑台 ?editor):
 *   M1 主对话(编辑台主页的对话 ID)经 /api/ai/chat 登记;页面绑上项目副本;
 *   M2 经 /api/mcp/call 以主对话 ID 调 spawn_agent → 出现带角色名的新页签;登记表里子 Agent 带 role、parent;
 *      任务作为第一条消息由页面发出(信箱被取走、子页签里有一条来自主对话的消息);
 *   M3 父子各写一处:公告板的改动记录里两条都有、各记各的身份;
 *   M4 send_message:发给空闲的子 Agent 由页面自动发出;发给没有页签的会话,带在它下一次工具结果里;
 *   M5 互相覆盖:子 Agent 覆盖了父写的片段,子这次结果带 overwrote、父下一次结果带 overwrittenBy;
 *      父写进子声明的范围,父这次结果带 scopeClash、子下一次结果带 scopeChanges;
 *   M6 子 Agent 再拉起被拒(深度 1);第 5 个并发子 Agent 被拒(至多 4 个);
 *   截图:tabs.png(带角色名的页签)、child-tab.png(子页签的对话)。
 *
 * 第二阶段(两个成员共用一个本机文档服务,起法参考 scripts/probes/c10-ui-probe.mjs):本探针起托管组合(文档服务 + 素材服务,
 *   数据在系统临时目录)和两台编辑器(成员甲 alice、成员乙 bob,各自的数据目录),两个页面各自以成员身份进入同一个共享项目:
 *   X1 甲的编辑器进程绑上共享项目(票据模式);
 *   X2 乙的页面在时间轴上按住拖动一张卡 → 甲编辑器进程里的 Agent 读它,结果带「用户 bob 正在编辑」;
 *   X3 甲的 Agent 声明范围 → 乙的页面 AI 栏顶上列出「成员 alice 的 Agent … 正在改:…」;
 *   截图:b-dragging.png、b-remote-agents.png。
 *
 * 只结束本探针自己起的进程。结果最后一行是一行 JSON(ok、fails、passes 数)。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startDevServer } from '../lib/dev-server.mjs';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject } from '../../server/auth/client.mjs';

const PHASE = flagArg('phase', 'all');
const shots = flagArg('shots', path.join(os.tmpdir(), 'multi-agent-probe-shots'));
fs.mkdirSync(shots, { recursive: true });
const ORIGIN_ARG = flagArg('origin', null);
const PORT1 = 5840;
const A_PORT = Number(flagArg('a-port', 5843));
const B_PORT = Number(flagArg('b-port', 5846));
const DOC_PORT = Number(flagArg('doc-port', 5850));
const ASSET_PORT = Number(flagArg('asset-port', 5851));
for (const p of [PORT1, A_PORT, B_PORT, DOC_PORT, ASSET_PORT]) {
  if (p < 5840 || p > 5859) throw new Error(`端口 ${p} 不在分给本探针的 5840～5859 里`);
}

const fails = [];
const passes = [];
const check = (cond, label, extra) => {
  (cond ? passes : fails).push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 600) : ''));
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}
const mcp = (origin) => async (tool, args, agent) => {
  const res = await fetch(`${origin}/api/mcp/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, args, ...(agent ? { agent } : {}) }) });
  const j = await res.json();
  return j.ok === false ? { __error: j.error } : j.result;
};
const getJson = async (url) => (await fetch(url)).json();
/** 以一个对话 ID 在 AI 栏登记(驱动是不存在的名字:登记完起模型那一步就报错,不花额度) */
async function register(origin, conversationId, creativity = null) {
  const res = await fetch(`${origin}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'probe-none', prompt: 'x', conversationId, ...(creativity ? { creativity } : {}) }) });
  await res.text().catch(() => '');
}
/** 写入被 stale 拒了就重读再写(副本还没追上别人刚落地的那一版) */
async function writeWithReread(call, agent, clipId, args) {
  let out = null;
  for (let i = 0; i < 10; i += 1) {
    await call('get_clip', { clipId }, agent);
    out = await call('update_clip', { clipId, ...args }, agent);
    if (!out?.__error) return out;
    await sleep(300);
  }
  return out;
}

const own = [];
const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
async function openEditor(origin, label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`${label}: ${String(e?.message ?? e)}`));
  await page.goto(origin + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => { const m = await import('/src/store/project.ts'); return !!m.getState().project; }, { timeout: 180000, polling: 500 });
  await page.waitForFunction(() => !document.querySelector('[data-pc="probe-gate"]'), { timeout: 120000, polling: 500 }).catch(() => {});
  return page;
}
const tabsOf = (page) => page.evaluate(async () => (await import('/src/ai/agentTabs.ts')).getTabs().map((t) => ({ id: t.id, title: t.title, conversationId: t.conversationId, role: t.role ?? null, parent: t.parent ?? null, scope: t.scope })));

async function phase1() {
  let server = null;
  let origin = ORIGIN_ARG;
  if (!origin) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-probe-1-'));
    server = await startDevServer({ port: PORT1, logFile: path.join(shots, 'dev-5840.log'), env: { PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_DATA_DIR: path.join(dataDir, 'data'), PROMPTCUT_EXPORT_DIR: path.join(dataDir, 'export') } });
    own.push(server);
    origin = server.origin;
  }
  const call = mcp(origin);
  const page = await openEditor(origin, 'P1');

  /* M1 主对话 + 项目 */
  const ids = await page.evaluate(async () => {
    const m = await import('/src/store/project.ts');
    const reg = await import('/src/kernel/registry.ts');
    m.actions.newProject?.('ma-probe');
    const card = reg.allCards().find((c) => c.kind !== 'audio' && !c.id.startsWith('user'));
    const a = m.actions.addCardClip(card.id, 1, { duration: 3 });
    const b = m.actions.addCardClip(card.id, 6, { duration: 3 });
    m.actions.select([]);
    return { a: a?.id ?? null, b: b?.id ?? null, main: localStorage.getItem('pcChatId') };
  });
  check(!!ids.a && !!ids.b && !!ids.main, 'M1 新项目里放了两张卡,读到主对话 ID', ids);
  const MAIN = ids.main;
  await register(origin, MAIN, 'medium');
  const bound = await waitFor(async () => { const s = await getJson(`${origin}/api/agent/status`); return s.bound ? s : null; }, 60000, 500);
  check(!!bound, 'M1 Agent 服务端绑上了项目副本', bound && { mode: bound.mode });
  await waitFor(async () => { const r = await call('get_clip', { clipId: ids.a }, MAIN); return r && !r.__error; }, 30000, 500);

  /* M2 spawn_agent */
  const sp = await call('spawn_agent', { role: 'director', task: '把两张卡排好顺序(探针任务,不会真的跑)' }, MAIN);
  check(sp?.ok === true && /^sub-/.test(sp.conversationId ?? ''), 'M2 spawn_agent 成功,回子 Agent 的对话 ID', sp);
  const KID = sp?.conversationId;
  check(sp?.creativity === 'medium', 'M2 子 Agent 的创造力等级取父对话此刻生效的「中」', sp?.creativity);
  const kidTab = await waitFor(async () => (await tabsOf(page)).find((t) => t.conversationId === KID), 10000);
  check(!!kidTab && kidTab.title.startsWith('剪辑导演') && kidTab.role === 'director' && kidTab.parent === MAIN, 'M2 出现带角色名的新页签(剪辑导演),记着父对话', kidTab);
  await page.screenshot({ path: path.join(shots, 'tabs.png') });
  const board0 = await getJson(`${origin}/api/agent/board`);
  const kidSess = board0.sessions.find((s) => s.id === KID);
  check(kidSess?.role === 'director' && kidSess?.parent === MAIN && kidSess?.vendor === 'probe-none', 'M2 登记表:子 Agent 的 role、parent、厂商沿用父对话', kidSess);
  const delivered = await waitFor(async () => {
    const msgs = await page.evaluate(async (tabId) => (await import('/src/ai/liveChat.ts')).getChatStore(tabId).get().filter((m) => m.inbound?.length).map((m) => m.inbound), kidTab?.id);
    return msgs.length ? msgs : null;
  }, 15000);
  check(!!delivered && delivered[0][0].from === MAIN, 'M2 任务作为第一条消息由子页签发出(来自主对话)', delivered);

  /* M3 父子各写一处 */
  const wMain = await writeWithReread(call, MAIN, ids.a, { opacity: 0.8 });
  const wKid = await writeWithReread(call, KID, ids.b, { opacity: 0.7 });
  check(wMain?.ok === true && wKid?.ok === true, 'M3 父子各写一处都落地', { main: wMain?.__error ?? wMain?.ok, kid: wKid?.__error ?? wKid?.ok });
  const board1 = await getJson(`${origin}/api/agent/board`);
  const writers = board1.changes.filter((c) => c.kind === 'change' && c.by?.kind === 'agent').map((c) => c.by.agent);
  check(writers.includes(MAIN) && writers.includes(KID), 'M3 公告板的改动记录里父子两条都有、各记各的身份', board1.changes.slice(-6));

  /* M4 send_message */
  const toKid = await call('send_message', { to: KID, text: '探针:序列里第二张归你' }, MAIN);
  check(toKid?.ok === true && toKid.delivered?.includes(KID), 'M4 send_message 投给子 Agent', toKid);
  const kidGot = await waitFor(async () => {
    const msgs = await page.evaluate(async (tabId) => (await import('/src/ai/liveChat.ts')).getChatStore(tabId).get().filter((m) => m.inbound?.some((x) => x.text.includes('第二张归你'))).length, kidTab?.id);
    return msgs > 0;
  }, 15000);
  check(!!kidGot, 'M4 子 Agent 空闲:消息由它的页签自动发出', kidGot);
  const DESK = `probedesk${Date.now().toString(36)}`;
  await call('list_agents', {}, DESK);
  await call('send_message', { to: DESK, text: '探针:给没有页签的会话' }, MAIN);
  const deskNext = await call('get_clip', { clipId: ids.a }, DESK);
  check(Array.isArray(deskNext?.messages) && deskNext.messages[0]?.text === '探针:给没有页签的会话' && deskNext.notice?.includes('别的 Agent 给你的消息'), 'M4 没有页签的会话:消息带在它下一次工具结果里', deskNext?.messages ?? deskNext);

  /* M5 互相覆盖 + 写进别人声明的范围 */
  const kidOver = await writeWithReread(call, KID, ids.a, { opacity: 0.6 });
  check(Array.isArray(kidOver?.overwrote) && kidOver.overwrote.some((o) => o.by === 'agent'), 'M5 子 Agent 覆盖了父写的片段:子这次结果带 overwrote', kidOver?.overwrote ?? kidOver);
  await sleep(300);
  const mainNext = await call('get_clip', { clipId: ids.b }, MAIN);
  check(Array.isArray(mainNext?.overwrittenBy) && mainNext.overwrittenBy.some((o) => o.who.includes(KID)) && mainNext.notice?.startsWith('你写的'), 'M5 父下一次结果带 overwrittenBy「你写的 … 被 Agent <子>(厂商)覆盖」', mainNext?.overwrittenBy ?? mainNext);
  const scopeName = await page.evaluate(async (id) => {
    const m = await import('/src/store/project.ts');
    const p = m.getState().project;
    const cut = (p.cuts ?? []).find((c) => c.id === p.activeCutId)?.name ?? '剪辑1';
    return `${cut}->${p.tracks.find((t) => t.clips.some((c) => c.id === id))?.name}`;
  }, ids.a);
  const decl = await call('declare_scope', { scope: scopeName, note: '探针' }, KID);
  check(decl?.ok === true, 'M5 子 Agent 声明范围', { scopeName, decl });
  const kidTitled = await waitFor(async () => (await tabsOf(page)).find((t) => t.conversationId === KID && t.title.includes(scopeName)), 5000);
  check(!!kidTitled, 'M5 页签名跟着范围改(经 SSE 推给页面)', kidTitled);
  const mainInto = await writeWithReread(call, MAIN, ids.a, { opacity: 0.9 });
  check(Array.isArray(mainInto?.scopeClash) && mainInto.scopeClash.some((c) => c.agent === KID), 'M5 父写进子声明的范围:父这次结果带 scopeClash', mainInto?.scopeClash ?? mainInto);
  const kidNext = await call('get_clip', { clipId: ids.b }, KID);
  check(Array.isArray(kidNext?.scopeChanges) && kidNext.scopeChanges.some((c) => c.who.includes(MAIN)), 'M5 子下一次结果带 scopeChanges(别人正在改你声明的范围)', kidNext?.scopeChanges ?? kidNext);
  check(Array.isArray(kidNext?.overwrittenBy) && kidNext.overwrittenBy.length > 0, 'M5 子也得知自己写的被父覆盖了', kidNext?.overwrittenBy);

  /* M6 上限 */
  const deep = await call('spawn_agent', { role: 'fx-assistant', task: '再拉一个' }, KID);
  check(deep?.ok === false && /不能再拉起/.test(deep.error ?? ''), 'M6 子 Agent 再拉起被拒(深度 1)', deep);
  const more = [];
  for (let i = 0; i < 3; i += 1) more.push(await call('spawn_agent', { role: 'fx-assistant', task: `探针 ${i}` }, MAIN));
  check(more.every((m) => m?.ok === true), 'M6 再拉 3 个(共 4 个)都成功', more.map((m) => m?.error ?? m?.conversationId));
  const fifth = await call('spawn_agent', { role: 'collector', task: '第五个' }, MAIN);
  check(fifth?.ok === false && /上限 4/.test(fifth.error ?? ''), 'M6 第 5 个并发子 Agent 被拒', fifth);
  await sleep(500);
  const tabsNow = await tabsOf(page);
  check(tabsNow.filter((t) => t.parent === MAIN).length === 4, 'M6 页面上正好 4 个子 Agent 页签', tabsNow.map((t) => t.title));
  // 切到子页签截一张
  await page.evaluate(async (id) => { (await import('/src/ai/agentTabs.ts')).activateTab(id); }, kidTab?.id);
  await sleep(800);
  await page.screenshot({ path: path.join(shots, 'child-tab.png') });
  check(page.errors.length === 0, 'M 页面没有未捕获的异常', page.errors.slice(0, 5));
  await page.browserContext().close();
}

async function phase2() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-probe-2-'));
  const hostedDir = path.join(root, 'hosted');
  fs.mkdirSync(hostedDir, { recursive: true });
  const combo = await startHostedCombo({ dataDir: hostedDir, docPort: DOC_PORT, assetPort: ASSET_PORT, host: '127.0.0.1', log: () => {} });
  own.push({ stop: () => combo.close() });
  const base = `http://127.0.0.1:${DOC_PORT}/`;
  const name = `ma-${Date.now().toString(36)}`;
  const PROJECT_PW = `pw-${randomBytes(6).toString('hex')}`;
  const made = await createSharedProject({ base, name, mode: 'free', creator: { username: 'boss', password: `boss-${randomBytes(6).toString('hex')}` }, password: PROJECT_PW });
  const env = (who) => ({ PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_DATA_DIR: path.join(root, who, 'data'), PROMPTCUT_EXPORT_DIR: path.join(root, who, 'export') });
  const devA = await startDevServer({ port: A_PORT, logFile: path.join(shots, `dev-${A_PORT}.log`), env: env('a') });
  own.push(devA);
  const devB = await startDevServer({ port: B_PORT, logFile: path.join(shots, `dev-${B_PORT}.log`), env: env('b') });
  own.push(devB);
  const pageA = await openEditor(devA.origin, 'A');
  const pageB = await openEditor(devB.origin, 'B');
  const enter = (page, username) => page.evaluate(async (c) => {
    const m = await import('/src/editor/sync/syncManager.ts');
    return m.enterShared({ where: 'hosted', base: c.base, projectId: c.projectId, name: c.name, mode: 'free' }, { as: 'member', username: c.username, password: c.pw });
  }, { base, projectId: made.projectId, name, username, pw: PROJECT_PW });
  const ea = await enter(pageA, 'alice');
  check(ea?.ok === true, 'X0 成员甲 alice 的页面进入共享项目', ea);
  // 甲的页面放两张卡(共享项目刚建是空的,甲的页面把当前项目带进去)
  const ids = await pageA.evaluate(async () => {
    const m = await import('/src/store/project.ts');
    const reg = await import('/src/kernel/registry.ts');
    const card = reg.allCards().find((c) => c.kind !== 'audio' && !c.id.startsWith('user'));
    const a = m.actions.addCardClip(card.id, 1, { duration: 3 });
    const b = m.actions.addCardClip(card.id, 6, { duration: 3 });
    m.actions.select([]);
    return { a: a?.id ?? null, b: b?.id ?? null };
  });
  const eb = await enter(pageB, 'bob');
  check(eb?.ok === true, 'X0 成员乙 bob 的页面进入同一个共享项目', eb);
  const boundA = await waitFor(async () => { const s = await getJson(`${devA.origin}/api/agent/status`); return s.bound && s.mode === 'ticket' ? s : null; }, 60000, 500);
  check(!!boundA, 'X1 甲的编辑器进程以票据模式绑上共享项目', boundA && { mode: boundA.mode, projectId: boundA.projectId });
  const callA = mcp(devA.origin);
  const AGENT = `probea${Date.now().toString(36)}`;
  await register(devA.origin, AGENT);
  await waitFor(async () => { const r = await callA('get_clip', { clipId: ids.a }, AGENT); return r && !r.__error; }, 30000, 500);
  const seenB = await waitFor(async () => pageB.evaluate(async (id) => (await import('/src/store/project.ts')).getState().project.tracks.some((t) => t.clips.some((c) => c.id === id)), ids.a), 30000, 500);
  check(!!seenB, 'X1 乙的页面看得到甲放的卡', seenB);

  /* X2 乙按住拖动 → 甲的 Agent 读它带「用户 bob 正在编辑」。机器有负载时开场的卡片测量(probe-gate)要很久,等它撤掉、卡出现在时间轴上 */
  const gateGone = await waitFor(async () => pageB.evaluate((id) => !document.querySelector('[data-pc="probe-gate"]') && !!document.querySelector(`[data-clip-id="${id}"]`), ids.a), 600000, 1000);
  check(!!gateGone, 'X2 乙的编辑台挂好了(卡片测量结束、卡出现在时间轴上)', gateGone);
  await waitFor(async () => pageA.evaluate(() => !document.querySelector('[data-pc="probe-gate"]')), 600000, 1000);
  await pageB.evaluate((id) => document.querySelector(`[data-clip-id="${id}"]`)?.scrollIntoView({ block: 'center', inline: 'center' }), ids.a);
  await sleep(300);
  const box = await pageB.$eval(`[data-clip-id="${ids.a}"]`, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const sx = box.x + Math.min(40, box.w / 2);
  const sy = box.y + box.h / 2;
  await pageB.mouse.move(sx, sy);
  await pageB.mouse.down();
  for (let i = 1; i <= 12; i += 1) { await pageB.mouse.move(sx + i * 5, sy); await sleep(16); }
  await pageB.screenshot({ path: path.join(shots, 'b-dragging.png') });
  const read = await waitFor(async () => {
    const r = await callA('get_clip', { clipId: ids.a }, AGENT);
    return Array.isArray(r?.userEditing) && r.userEditing.some((e) => e.clipId === ids.a && e.who === 'bob') ? r : null;
  }, 10000, 400);
  if (!read) {
    const st = await getJson(`${devA.origin}/api/agent/status`);
    console.log('DIAG A status', JSON.stringify({ presence: st.presence, editing: st.editing }));
    console.log('DIAG B presence', JSON.stringify(await pageB.evaluate(async () => (await import('/src/editor/sync/presence.ts')).presenceStatus())));
    console.log('DIAG B editing', JSON.stringify(await pageB.evaluate(async () => (await import('/src/editor/userEditing.ts')).userEditingSnapshot())));
  }
  check(!!read, 'X2 甲的 Agent 读乙正在拖的卡,结果带 userEditing(who: bob)', read?.userEditing);
  check(typeof read?.notice === 'string' && read.notice.startsWith(`用户 bob 正在编辑片段 ${ids.a}(拖动中)`), 'X2 提示「用户 bob 正在编辑……」', read?.notice);
  const other = await callA('get_clip', { clipId: ids.b }, AGENT);
  check(other && !other.__error && other.userEditing === undefined, 'X2 读别的卡不带提示', other?.notice);
  await pageB.mouse.up();

  /* X3 甲的 Agent 声明范围 → 乙的页面看得到 */
  const decl = await callA('declare_scope', { scope: '剪辑1->序列1', note: '探针' }, AGENT);
  check(decl?.ok === true, 'X3 甲的 Agent 声明范围', decl);
  const strip = await waitFor(async () => pageB.evaluate(() => [...document.querySelectorAll('[data-pc="remote-agent"]')].map((el) => el.textContent)), 10000, 400);
  const hit = Array.isArray(strip) && strip.find((t) => t.includes('成员 alice') && t.includes('剪辑1->序列1'));
  check(!!hit, 'X3 乙的页面 AI 栏顶上列出「成员 alice 的 Agent … 正在改:剪辑1->序列1」', strip);
  await pageB.screenshot({ path: path.join(shots, 'b-remote-agents.png') });
  check(pageA.errors.length === 0 && pageB.errors.length === 0, 'X 两个页面都没有未捕获的异常', [...pageA.errors, ...pageB.errors].slice(0, 5));
}

try {
  if (PHASE === '1' || PHASE === 'all') await phase1();
  if (PHASE === '2' || PHASE === 'all') await phase2();
} catch (err) {
  fails.push(`探针自己出错:${err?.stack ?? err}`);
} finally {
  await browser.close().catch(() => {});
  for (const s of own.reverse()) { try { await s.stop(); } catch { /* 已停 */ } }
}
for (const p of passes) console.log('PASS', p);
for (const f of fails) console.log('FAIL', f);
console.log(JSON.stringify({ ok: fails.length === 0, fails: fails.length, passes: passes.length, shots }));
process.exit(fails.length ? 1 : 0);
