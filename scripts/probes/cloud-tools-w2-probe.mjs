/**
 * W2(本人页面反向通道)的真浏览器探针(无头)。
 *
 *   node scripts/probes/cloud-tools-w2-probe.mjs [--shots <目录>]
 *
 * 跑之前设好 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE(运行授权夹具要用)。端口只用 28420～28431。
 *
 * 验收(每条打一行 JSON `{ check, ok, detail }`,有一条不过退出码 1):
 *   P1  三张真的编辑器页面(发起人两张、另一个成员一张)各自连上文档服务的在场表、挂上到 Agent 服务的事件流;
 *   P2  发消息时的页面号由文档服务核过(发起人的第一张页面此刻连着、属于这次登录)才记进消息;
 *   P3  Agent 调 seek:只有发起页的播放头真的变了(读的是页面里编辑器自己的 store);发起人的另一张页面、另一个成员的页面
 *       播放头不变,也没有收到过请求、没有交回过结果;
 *   P4  别的成员拿到请求号与页面号也交不进来(410);发起页那一次照常做成(「还在等的时候被人乱交不受影响」由单测 W2-FORGE 逐条验);
 *   P5  play / pause 同一条路:发起页开始播、停下,另两张不动;
 *   P6  发起页关掉后再请求:回「发起方不在线」,不等满时限;发起人的另一张页面不顶替;
 *   P7  收尾:探针起的浏览器、编辑器进程都按进程号结束,端口放回。
 *
 * 哪些是真的:
 *   - 页面是本 worktree 的 dev server 提供的真编辑器(真的 store、真的播放头、`src/mcp/handlers/playback.ts` 那份本机实现);
 *   - 页面一侧执行请求的是 `src/ai/cloud/pageRequests.ts` 的 `createAccountPageRequests`;在场页面号是
 *     `src/editor/sync/selectionPresence.ts` 自己起的、经真的 WebSocket 报给真的文档服务在场模块;
 *   - 服务一侧是 `page-bridge.mjs` + 真的运行授权(SQLite 账本)+ 真的运行资源登记器,经真的 HTTP(事件流与交回)。
 * 哪些不是产品接线(中央文件归最后的接线包,本包不许改,所以探针自己搭):
 *   - 页面里「连文档服务报在场、开事件流、把请求交给执行器、交回结果」这一段是探针注入的一小段脚本,不是 `useCloud.ts` / `session.ts`;
 *   - Agent 服务这一侧的路由是探针自己的测试服务器挂的,不是 `server/agent-service/http.mjs`;
 *   - 身份:页面用一个探针专用的请求头自报账号(测试服务器只认探针给的三个账号),没有走账号登录与委托票据;
 *     文档服务的连接同样按探针给的账号建。账号登录、委托票据、真模型都不在本探针的范围里。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, startDesktop, killDesktop, launchBrowser, killBrowser, openDesktopEditor, portFree, createUi, sleep, alive } from './cloud-agent-ui-lib.mjs';
import { runFixture, projectId, conversationId, servicePrincipal } from '../../server/test/run-authority-fixture.mjs';
import { digestOf } from '../../server/account/ledger.mjs';
import { conversationReadInState } from '../../server/account/conversation-authority.mjs';
import { createDocService } from '../../server/docservice/service.mjs';
import { projectModule } from '../../server/docservice/modules/project.mjs';
import { mountSelection } from '../../server/docservice/modules/selection.mjs';
import { createRunResources } from '../../server/agent/service/run-resources.mjs';
import { createPageBridge, createPageControlTools, PageBridgeError } from '../../server/agent/service/page-bridge.mjs';
import { initiatorOffline } from '../../server/agent/service/cloud-tools.mjs';

const PORTS = { editor: 28420, agent: 28430, doc: 28431 };
const argOf = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const SHOTS = path.resolve(argOf('--shots') ?? path.join(ROOT, 'docs', 'reports', 'assets', 'v18-tools-w2'));
const OUT = path.join(ROOT, 'out', 'w2-probe', `run-${Date.now()}`);
const ACCOUNTS = ['sender', 'other', 'owner'];
const loginOf = (accountId) => ({ accountId, loginId: `login-${accountId}`, credentialId: `credential-${accountId}`, loginGeneration: 1 });
const { check, say, until, results } = createUi();

let authority; let doc; let agent; let bridge; let resources; let desktop; let browser;
const sockets = new Set();
const posts = [];

async function main() {
  for (const p of [PORTS.editor, PORTS.editor + 1, PORTS.editor + 2, PORTS.agent, PORTS.doc]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  /* ---- 文档服务:真的运行授权账本 + 真的在场模块,经真的 WebSocket */
  fs.mkdirSync(path.join(OUT, 'authority'), { recursive: true });
  authority = await runFixture({ dir: path.join(OUT, 'authority') });
  const { ledger } = authority;
  const project = projectModule();
  const selection = mountSelection({
    project,
    checkAccess: async ({ principal, projectId: target }) => {
      const state = ledger.read(); const p = state.projects?.[target];
      if (!p || state.revokedLogins?.[`login:${principal.loginId}`] || Object.hasOwn(p.bans ?? {}, principal.accountId)) return false;
      return principal.accountId === p.creatorAccountId || p.members?.[principal.accountId]
        ? { allowed: true, accountId: principal.accountId, projectId: target, accountName: `${principal.accountId} name` } : false;
    },
    authorizeQuery: async ({ projectId: target, runGrantId }) => {
      const principal = await authority.provider.resolveRunPrincipal({ servicePrincipal, projectId: target, runGrantId });
      return authority.provider.authorizeQuery({ principal, projectId: target, runGrantId });
    },
  });
  doc = createDocService({
    modules: [project, selection], autoTick: false, log: () => {},
    // 探针专用的身份:只认探针给的三个账号(真产品里这一步是账号登录后的文档服务连接)
    authenticate: (req) => {
      const accountId = new URL(req.url, 'http://doc.invalid').searchParams.get('account');
      if (!ACCOUNTS.includes(accountId)) return null;
      return { userId: accountId, tenantId: projectId, projectId, role: 'page', ...loginOf(accountId) };
    },
  });
  await doc.listen(PORTS.doc, '127.0.0.1');

  /* ---- Agent 服务一侧:反向通道 + 探针自己的测试服务器(事件流与交回两条路由) */
  const runClient = {
    registerInstance: async () => authority.agentProcess.registration,
    instanceIdentity: () => authority.agentProcess.registration,
    async checkAccess({ projectId: p, runGrantId, action }) {
      const principal = await authority.provider.resolveRunPrincipal({ servicePrincipal, projectId: p, runGrantId });
      return authority.provider.checkAccess({ principal, projectId: p, action });
    },
  };
  resources = createRunResources({ runClient });
  const checkSubmitter = async (identity, conversation) => conversationReadInState(ledger.read(), { projectId: identity.projectId, ...loginOf(identity.accountId) },
    { projectId: identity.projectId, conversationId: conversation, action: 'access' });
  bridge = createPageBridge({
    databasePath: path.join(OUT, 'page-requests.sqlite'), resources, runClient, checkSubmitter,
    presence: (context) => selection.querySelections({ principal: { service: 'agent', tenantId: context.projectId }, projectId: context.projectId, runGrantId: context.runGrantId }),
    limits: { pageMs: 15_000, attachMs: 3_000 },
  });
  const playheads = [];
  const control = createPageControlTools({ bridge, onPlayhead: (context, t) => { playheads.push(t); } });

  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-probe-account', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  const json = (res, status, body) => { res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  agent = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
      const url = new URL(req.url, 'http://agent.invalid');
      const m = /^\/v1\/conversations\/([A-Za-z0-9_-]{1,64})\/(events|page-results)$/.exec(url.pathname);
      const accountId = String(req.headers['x-probe-account'] ?? '');
      if (!m) return json(res, 404, { ok: false, code: 'not-found' });
      if (!ACCOUNTS.includes(accountId)) return json(res, 401, { ok: false, code: 'unauthorized' });
      const identity = { accountMode: true, accountId, projectId };
      if (m[2] === 'events' && req.method === 'GET') {
        // 与产品的 HTTP 层同一个次序:先核这个账号读得到这个对话,再挂流
        const access = await checkSubmitter(identity, m[1]);
        res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(': open\n\n');
        const attachment = bridge.attach({ identity, conversationId: m[1], pageId: url.searchParams.get('page'), aclRevision: access.aclRevision,
          send: (event) => { res.write(`data: ${JSON.stringify(event)}\n\n`); } });
        const off = () => attachment?.detach();
        req.on('aborted', off); res.on('close', off);
        return;
      }
      if (m[2] === 'page-results' && req.method === 'POST') {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) return json(res, 413, { ok: false, code: 'too-large' }); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        try {
          const out = await bridge.acceptResult({ identity, conversationId: m[1], body });
          posts.push({ accountId, pageId: body.pageId, id: body.id, status: 200 });
          return json(res, 200, out);
        } catch (error) {
          const status = error instanceof PageBridgeError ? error.status : 500;
          posts.push({ accountId, pageId: body?.pageId, id: body?.id, status, code: error?.code });
          return json(res, status, { ok: false, code: error?.code ?? 'error' });
        }
      }
      return json(res, 404, { ok: false, code: 'not-found' });
    } catch (error) { try { json(res, error?.status ?? 500, { ok: false, code: error?.code ?? 'error' }); } catch { res.destroy(); } }
  });
  agent.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { agent.once('error', reject); agent.listen(PORTS.agent, '127.0.0.1', resolve); });

  /* ---- 真的编辑器(本 worktree 的 dev server)+ 无头浏览器,三张页面 */
  say('editor.start');
  desktop = await startDesktop({ port: PORTS.editor, dir: path.join(OUT, 'editor') });
  browser = await launchBrowser();
  const config = { agent: `http://127.0.0.1:${PORTS.agent}`, docWs: `ws://127.0.0.1:${PORTS.doc}`, projectId, conversationId };
  const openTab = async (name, account) => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('dialog', (d) => void d.accept());
    // 进编辑器、等舞台起来、等开机的测量遮罩收掉(截图里要看得到播放头)
    await openDesktopEditor(page, desktop.origin);
    await page.waitForFunction(() => !!window.__pcStore && window.__pcStore.getState().project.duration > 0, { timeout: 240_000, polling: 500 });
    const info = await page.evaluate(harness, { ...config, account });
    return { name, account, page, pageId: info.pageId };
  };
  const tabs = {
    A: await openTab('发起人的第一张页面(发起页)', 'sender'),
    B: await openTab('发起人的第二张页面', 'sender'),
    C: await openTab('另一个成员的页面', 'other'),
  };
  const stateOf = (tab) => tab.page.evaluate(() => { const s = window.__pcStore.getState(); return { t: s.t, playing: s.playing, duration: s.project.duration, w2: window.__w2 }; });
  const shot = async (tab, file) => { await tab.page.screenshot({ path: path.join(SHOTS, file) }); return file; };
  const attached = await until('三张页面都挂上了事件流、在场表里有它们', async () => {
    const states = await Promise.all(Object.values(tabs).map(stateOf));
    return states.every((s) => s.w2?.attached === true && s.w2.presence === true) && bridge.describe().streams === 3 ? states : null;
  }, 60_000);
  check('P1 三张真的编辑器页面各自连上文档服务的在场表、挂上到 Agent 服务的事件流', !!attached && new Set(Object.values(tabs).map((t) => t.pageId)).size === 3,
    { pages: Object.fromEntries(Object.entries(tabs).map(([k, t]) => [k, { account: t.account, pageId: `${t.pageId.slice(0, 8)}…` }])), streams: bridge.describe().streams, selectionPages: selection.describe().pages });
  if (!attached) return;

  /* ---- 发消息:页面号由文档服务的在场模块核过才记进消息;再由文档服务把这一轮交给 Agent */
  const senderPrincipal = { role: 'page', tenantId: projectId, projectId, ...loginOf('sender') };
  const snapshot = await selection.captureSnapshot({ principal: senderPrincipal, projectId, pageId: tabs.A.pageId });
  const forged = await selection.captureSnapshot({ principal: { role: 'page', tenantId: projectId, projectId, ...loginOf('other') }, projectId, pageId: tabs.A.pageId }).then(() => 'accepted', (e) => e.code);
  ledger.transaction((s) => {
    const c = s.conversationsV2[projectId][conversationId]; const login = loginOf('sender'); const content = '把播放头移到中间';
    c.messages.push({ messageId: 'message1', requestId: 'send-message1', arrivalSeq: c.messages.length + 1, senderAccountId: 'sender', senderNameAtSend: 'sender name',
      loginId: login.loginId, credentialId: login.credentialId, loginGeneration: 1, content, contentDigest: digestOf(content), attachments: [],
      selectionSnapshot: { ...snapshot, messageId: 'message1' }, queueState: 'queued' });
  });
  const grant = await authority.admit('admit-message1');
  await authority.provider.confirmRead(authority.input(grant, 'read-message1'));
  const context = await resources.contextFor({ projectId, runGrantId: grant.runGrantId });
  const who = await bridge.initiator(context);
  check('P2 发消息时的页面号由文档服务核过才记进消息;别的成员报发起人的页面号发不出消息', snapshot.pageId === tabs.A.pageId && who.pageId === tabs.A.pageId && who.initiatorAccountId === 'sender' && forged !== 'accepted',
    { initiator: who.initiatorAccountId, pageIsTabA: who.pageId === tabs.A.pageId, otherMemberClaimingTabA: forged });

  /* ---- seek */
  const before = { A: await stateOf(tabs.A), B: await stateOf(tabs.B), C: await stateOf(tabs.C) };
  const target = Math.round(before.A.duration * 0.5 * 100) / 100;
  await shot(tabs.A, 'w2-01-A-before.png'); await shot(tabs.B, 'w2-01-B-before.png'); await shot(tabs.C, 'w2-01-C-before.png');
  const seekStarted = Date.now();
  const seekResult = await control.call('seek', { t: target }, context);
  const seekMs = Date.now() - seekStarted;
  await sleep(300);
  const after = { A: await stateOf(tabs.A), B: await stateOf(tabs.B), C: await stateOf(tabs.C) };
  await shot(tabs.A, 'w2-02-A-after-seek.png'); await shot(tabs.B, 'w2-02-B-after-seek.png'); await shot(tabs.C, 'w2-02-C-after-seek.png');
  const brief = (s) => ({ t: s.t, playing: s.playing, received: s.w2.received.length, posted: s.w2.posted.map((p) => p.status) });
  check('P3 Agent 调 seek:只有发起页的播放头真的变了;发起人的另一张页面与另一个成员的页面不变,没收到请求、没交回结果',
    seekResult?.ok === true && Math.abs(after.A.t - target) < 0.01 && before.A.t !== target && after.B.t === before.B.t && after.C.t === before.C.t &&
    after.A.w2.received.length === 1 && after.A.w2.posted[0]?.status === 200 && after.B.w2.received.length === 0 && after.C.w2.received.length === 0 &&
    after.B.w2.posted.length === 0 && after.C.w2.posted.length === 0 && playheads.at(-1) === target,
    { target, seekResult, seekMs, before: { A: before.A.t, B: before.B.t, C: before.C.t }, after: { A: brief(after.A), B: brief(after.B), C: brief(after.C) } });

  /* ---- 别的成员拿到请求号也交不进来 */
  const pending = control.call('seek', { t: 0 }, context);
  const held = await until('发起页收到第二次请求', async () => { const s = await stateOf(tabs.A); return s.w2.received.length === 2 ? s : null; }, 10_000, 50);
  const stolenId = held?.w2.received[1]?.id;
  const steal = await tabs.C.page.evaluate(async ({ agentUrl, conversation, id, pageId }) => {
    const r = await fetch(`${agentUrl}/v1/conversations/${conversation}/page-results`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-probe-account': 'other' },
      body: JSON.stringify({ v: 2, id, nonce: 'AAAAAAAAAAAAAAAAAAAAAAAA', pageId, ok: true, result: { ok: true } }) });
    return { status: r.status, body: await r.json() };
  }, { agentUrl: config.agent, conversation: conversationId, id: stolenId, pageId: tabs.A.pageId });
  const backResult = await pending;
  const back = await stateOf(tabs.A);
  check('P4 别的成员拿着发起页的请求号与页面号交结果:410;发起页那一次照常做成', steal.status === 410 && steal.body.code === 'page-request-gone' && backResult?.ok === true && back.t === 0,
    { steal, backResult, tA: back.t });

  /* ---- play / pause */
  const playResult = await control.call('play', {}, context);
  const playing = await until('发起页在播', async () => { const s = await stateOf(tabs.A); return s.playing && s.t > 0 ? s : null; }, 10_000, 50);
  const othersWhilePlaying = { B: await stateOf(tabs.B), C: await stateOf(tabs.C) };
  const pauseResult = await control.call('pause', {}, context);
  await sleep(200);
  const paused = await stateOf(tabs.A);
  check('P5 play / pause:发起页开始播、停下;另两张页面没在播、播放头不动', playResult?.ok === true && pauseResult?.ok === true && !!playing && paused.playing === false && paused.t > 0 &&
    othersWhilePlaying.B.playing === false && othersWhilePlaying.C.playing === false && othersWhilePlaying.B.t === before.B.t && othersWhilePlaying.C.t === before.C.t,
    { playResult, pauseResult, A: { whilePlaying: playing && { t: playing.t, playing: playing.playing }, paused: { t: paused.t, playing: paused.playing } },
      B: { t: othersWhilePlaying.B.t, playing: othersWhilePlaying.B.playing }, C: { t: othersWhilePlaying.C.t, playing: othersWhilePlaying.C.playing } });

  /* ---- 发起页关掉后再请求 */
  await tabs.A.page.close();
  await until('文档服务的在场表里没有发起页了', async () => {
    const state = await selection.querySelections({ principal: { service: 'agent', tenantId: projectId }, projectId, runGrantId: grant.runGrantId });
    return !state.members.some((m) => m.pages.some((p) => p.pageId === tabs.A.pageId && p.live)) ? state : null;
  }, 15_000, 50);
  const beforeOffline = { B: await stateOf(tabs.B), C: await stateOf(tabs.C) };
  const offStarted = Date.now();
  const offResult = await control.call('seek', { t: target }, context);
  const offMs = Date.now() - offStarted;
  await sleep(300);
  const afterOffline = { B: await stateOf(tabs.B), C: await stateOf(tabs.C) };
  await shot(tabs.B, 'w2-03-B-after-initiator-closed.png'); await shot(tabs.C, 'w2-03-C-after-initiator-closed.png');
  check('P6 发起页关掉后再请求:回「发起方不在线」,不等满时限;发起人的另一张页面不顶替,另一个成员的页面也不动',
    JSON.stringify(offResult) === JSON.stringify(initiatorOffline('seek')) && offMs < 5_000 && afterOffline.B.t === beforeOffline.B.t && afterOffline.C.t === beforeOffline.C.t &&
    afterOffline.B.w2.received.length === 0 && afterOffline.C.w2.received.length === 0,
    { offResult, offMs, B: brief(afterOffline.B), C: brief(afterOffline.C), streamsLeft: bridge.describe().streams });
  say('posts', { posts: posts.map((p) => ({ account: p.accountId, fromTabA: p.pageId === tabs.A.pageId, status: p.status, code: p.code })) });
}

/** 注入页面的那一小段(探针替代的是 `useCloud.ts` / `session.ts` 的接线;执行请求的是产品自己的模块) */
async function harness({ agent: agentUrl, docWs, account, projectId: project, conversationId: conversation }) {
  const PR = await import('/src/ai/cloud/pageRequests.ts');
  const PB = await import('/src/mcp/handlers/playback.ts');
  const SP = await import('/src/editor/sync/selectionPresence.ts');
  const UE = await import('/src/editor/userEditing.ts');
  const state = (window.__w2 = { account, pageId: null, presence: false, attached: false, received: [], posted: [], error: null });
  const ws = new WebSocket(`${docWs}/?account=${encodeURIComponent(account)}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('文档服务连不上')); });
  let seq = 0; const waits = new Map();
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } const w = waits.get(m.reqId); if (w) { waits.delete(m.reqId); if (m.type === 'selection.ok') state.presence = true; w(m); } };
  const link = { request(message, timeoutMs = 5000) {
    return new Promise((resolve, reject) => { const reqId = `w2-${++seq}`; waits.set(reqId, resolve); setTimeout(() => { if (waits.delete(reqId)) reject(new Error('timeout')); }, timeoutMs); ws.send(JSON.stringify({ ...message, reqId })); });
  } };
  // 在场页面号由产品的在场模块自己起、自己报(选区来源用它缺省的那一份:编辑器的 store)
  SP.setSelectionLink(link, project);
  for (let i = 0; i < 100 && !SP.selectionPresenceStatus().pageId; i++) await new Promise((r) => setTimeout(r, 50));
  state.pageId = SP.selectionPresenceStatus().pageId;
  const runner = PR.createAccountPageRequests({ pageId: () => SP.selectionPresenceStatus().pageId,
    exec: { seek: (a) => PB.playbackHandlers.seek(a), play: () => PB.playbackHandlers.play(), pause: () => PB.playbackHandlers.pause(), begin: UE.beginAgentTool, end: UE.endAgentTool } });
  void (async () => {
    const res = await fetch(`${agentUrl}/v1/conversations/${conversation}/events?page=${encodeURIComponent(state.pageId)}`, { headers: { 'x-probe-account': account } });
    state.attached = res.ok;
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const line = buffer.slice(0, at).split('\n').find((l) => l.startsWith('data: '));
        buffer = buffer.slice(at + 2);
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type !== 'page.request') continue;
        state.received.push({ id: ev.id, tool: ev.tool });
        const answer = await runner.run(ev);
        if (!answer) continue;
        const r = await fetch(`${agentUrl}/v1/conversations/${conversation}/page-results`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-probe-account': account }, body: JSON.stringify(answer) });
        state.posted.push({ id: ev.id, status: r.status });
      }
    }
  })().catch((e) => { state.error = String(e?.message ?? e); });
  return { pageId: state.pageId };
}

let failed = false;
try { await main(); } catch (error) { failed = true; check('探针跑完', false, { error: String(error?.stack ?? error).slice(0, 900), editorLog: desktop?.log?.slice(-4) }); }
/* ---- 收尾:只结束探针自己起的 */
const browserPid = browser?.process()?.pid ?? null;
const closedBrowser = browser ? await killBrowser(browser) : { gone: true };
const closedDesktop = desktop ? await killDesktop(desktop) : { gone: true, portsFree: true };
try { bridge?.close('probe-end'); } catch { /* 已关 */ }
try { await resources?.close(); } catch { /* 已关 */ }
for (const socket of sockets) socket.destroy();
if (agent) await new Promise((resolve) => agent.close(resolve));
try { await doc?.close(); } catch { /* 已关 */ }
try { authority?.close(); } catch { /* 已关 */ }
const portsFree = (await Promise.all([PORTS.editor, PORTS.editor + 1, PORTS.editor + 2, PORTS.agent, PORTS.doc].map(portFree))).every(Boolean);
check('P7 收尾:探针起的浏览器、编辑器都按进程号结束,端口放回', closedBrowser.gone && closedDesktop.gone && portsFree && !(browserPid && alive(browserPid)) && !(desktop && alive(desktop.pid)),
  { browserGone: closedBrowser.gone, editorGone: closedDesktop.gone, portsFree });
const bad = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: true, total: results.length, passed: results.length - bad.length, failed: bad.map((r) => r.check), shots: SHOTS }));
process.exit(failed || bad.length ? 1 : 0);
