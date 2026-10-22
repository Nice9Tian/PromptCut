// 〔裁〕H07（用户 2026-10-22「.20发版之前修好。」）：Agent 服务重启时有人开着云端对话页，这个登录之后的改密退出要能办完；
// 而实例还活着、确实还开着读取时，退出照旧不报办完。
//
// 环境同 account-logout-confirmation.test.mjs（真的账号后端、文档服务组合、独立的素材进程，都在本机、互相隔离），
// 只有一处不同：Agent 服务（对话接口与读取控制）跑在单独的进程里（fixtures/agent-entry-restartable.mjs），
// 「重启」是真的把这个进程硬杀掉（它来不及关任何读取、也来不及告诉文档服务），再在同一个数据目录上起一个新进程。
// 需要环境变量 PROMPTCUT_ACCOUNT_PROVIDER_ROOT 与 PROMPTCUT_PASSWORD_ORDER_MODULE 指向账号后端。
//
// 「网页显示什么」看的是网页自己读的那个接口：网页只在它回 logout.state === 'complete' 时显示已退出。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { freePorts } from './free-ports.mjs';
import { startAccountPasswordUserFixture } from './fixtures/account-password-user-path.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, what, ms = 30_000, explain = () => '') {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check(); if (value) return value;
    if (Date.now() > until) throw Error(`timeout waiting for ${what}${explain() ? `；${explain()}` : ''}`);
    await sleep(100);
  }
}
function jsonRequest(url, { method = 'GET', body, headers = {}, ca } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request(url, { method, ca, rejectUnauthorized: true, timeout: 8000,
      headers: { ...(data === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
      res.once('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }); } catch { reject(Error('invalid-json-response')); } });
    });
    req.once('error', reject); req.once('timeout', () => req.destroy(Error('request-timeout'))); req.end(data);
  });
}

test('H07：Agent 服务重启时开着云端对话页，之后的改密退出能办完；实例还活着、还开着读取时照旧不报办完', { timeout: 300_000 }, async t => {
  const [agentPort, sparePort, sparePort2, ...ports] = await freePorts(10);
  const fixture = await startAccountPasswordUserFixture({ ports, agentPort, logoutConfirmPollMs: 250,
    agentEntry: fileURLToPath(new URL('./fixtures/agent-entry-restartable.mjs', import.meta.url)) });
  t.after(() => fixture.close());
  const ca = await fs.readFile(fixture.caFile), origin = fixture.origin, projectId = fixture.projectId;
  let serial = 0;
  const tag = name => `${name}-${++serial}`;
  async function website(account, password) {
    let cookie = '', csrf = '';
    const request = async (method, route, body) => {
      const response = await jsonRequest(`${origin}/api/account${route}`, { method, body, ca, headers: {
        ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { origin, 'sec-fetch-site': 'same-origin', ...(csrf ? { 'x-csrf-token': csrf } : {}) } : {}) } });
      if (response.cookie) cookie = response.cookie;
      if (response.body.csrfToken) csrf = response.body.csrfToken;
      return response;
    };
    await request('GET', '/me');
    assert.equal((await request('POST', '/login', { name: account.name, password, remember: true })).status, 200);
    return { request };
  }
  const doc = (route, body, token) => jsonRequest(`${origin}/hosted/shared/account/${route}`, { method: 'POST', ca, body,
    headers: { authorization: `Bearer ${token}` } });
  async function otherDevice(account, password) {
    const site = await website(account, password), deviceId = tag('restart-device');
    const editor = await site.request('POST', '/editor/session', { deviceId, deviceName: 'Other device', requestId: tag('editor') });
    assert.equal(editor.status, 200);
    const session = await doc('session', { projectId, deviceId, requestId: tag('session') }, editor.body.accessToken);
    assert.equal(session.status, 200, JSON.stringify(session.body));
    return { site, deviceId, token: editor.body.accessToken, session: session.body,
      stillIn: async () => (await doc('session', { projectId, deviceId, requestId: tag('session-again') }, editor.body.accessToken)).status };
  }
  async function changeAndExit(initiator, current, next) {
    const changed = await initiator.request('POST', '/password', { current, next, requestId: tag('change') });
    assert.equal(changed.status, 200, JSON.stringify(changed.body)); assert.equal(changed.body.choice, 'pending');
    const eventId = changed.body.passwordEventId;
    const choice = await initiator.request('POST', `/password-events/${encodeURIComponent(eventId)}/choice`, { exitOthers: true, requestId: tag('choice') });
    assert.equal(choice.status, 202); assert.equal(choice.body.choice, 'exit');
    return eventId;
  }
  const page = async (initiator, eventId) => (await initiator.request('GET', `/password-events/${encodeURIComponent(eventId)}`)).body;
  const ledgerStatus = eventId => fixture.combo.logoutConfirmer.status(eventId);
  /** 文档服务账本此刻的内容：另开一条只读连接读 */
  const docState = () => { const db = new DatabaseSync(fixture.docLedgerFile(), { readOnly: true });
    try { return JSON.parse(db.prepare('SELECT payload FROM account_authority_state WHERE id=1').get().payload); } finally { db.close(); } };
  const reads = () => docState().agentReadsV1 ?? null;
  const instances = () => docState().agentInstancesV2 ?? {};
  const why = eventId => () => JSON.stringify({ services: ledgerStatus(eventId)?.services && Object.fromEntries(
    Object.entries(ledgerStatus(eventId).services).map(([k, v]) => [k, v ? 'confirmed' : null])) });
  const completeOnPage = (initiator, eventId, ms = 30_000) => waitFor(async () => { const body = await page(initiator, eventId);
    return body.logout?.state === 'complete' ? body : null; }, '网页读到退出办完', ms, why(eventId));
  /** 在一段时间里反复读：一次都不许显示成功，并且每次都点得出还差 Agent。 */
  async function neverShown(initiator, eventId, ms = 3000) {
    const until = Date.now() + ms; let reads = 0, last;
    while (Date.now() < until) {
      last = await page(initiator, eventId); reads += 1;
      assert.notEqual(last.logout.state, 'complete', 'Agent 那一项没收口时网页不能显示成功');
      assert.ok(last.logout.pendingServices.includes('agent') || last.logout.pendingServices.includes('doc'),
        `待确认里要有 agent 或 doc：${JSON.stringify(last.logout.pendingServices)}`);
      assert.equal(ledgerStatus(eventId).services.agent, null, '文档服务账本里 Agent 这一项没有确认');
      await sleep(250);
    }
    return { reads, last };
  }
  /** 一台设备上开着云端对话页：同意过提示、发过一条消息、开着这条对话的事件流。 */
  async function cloudPage(account, password, conversationId) {
    const other = await otherDevice(account, password);
    assert.equal((await other.site.request('POST', '/cloud-agent-consent', { accept: true, noticeVersion: 1, requestId: tag('consent') })).status, 200);
    const session = (await doc('session', { projectId, deviceId: other.deviceId, requestId: tag('agent-session') }, other.token)).body;
    assert.equal(session.hosted.agent.enabled, true);
    // 编辑页：连上、打开项目、报一次选区（发消息时要带它的页面号）
    const ws = new WebSocket(origin.replace('https:', 'wss:') + '/hosted/', ['promptcut.v1', `promptcut.account.${session.connectionTicket}`], { ca, origin });
    t.after(() => ws.terminate());
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const send = frame => new Promise((resolve, reject) => { const reqId = tag('page');
      const timer = setTimeout(() => reject(Error('page-request-timeout')), 10_000);
      const receive = bytes => { const reply = JSON.parse(bytes.toString()); if (reply.reqId !== reqId) return;
        clearTimeout(timer); ws.off('message', receive); resolve(reply); };
      ws.on('message', receive); ws.send(JSON.stringify({ ...frame, reqId })); });
    await send({ type: 'project.open', projectId });
    const pageId = tag('restart-page');
    assert.equal((await send({ type: 'selection.set', projectId, pageId, revision: 1, selection: { clipIds: [] } })).type, 'selection.ok');
    const agentHeaders = { authorization: `Bearer ${session.agentDelegationTicket}` };
    const posted = await jsonRequest(`${origin}/agent/v1/conversations/${conversationId}/messages`, { method: 'POST', ca, headers: agentHeaders,
      body: { prompt: 'Agent 重启测试用的一条消息', requestId: tag('message'), selectionSnapshot: { pageId } } });
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    const openStream = async () => {
      const stream = { status: null, closed: false };
      const request = https.get(`${origin}/agent/v1/conversations/${conversationId}/events`, { ca, headers: agentHeaders }, res => {
        stream.status = res.statusCode; res.on('data', () => {}); res.on('error', () => {}); res.once('close', () => { stream.closed = true; }); });
      request.on('error', () => { stream.closed = true; });
      t.after(() => request.destroy());
      await waitFor(() => stream.status !== null || stream.closed, '事件流打开');
      assert.equal(stream.status, 200);
      return stream;
    };
    return { other, openStream, stream: await openStream() };
  }
  /** 文档服务账本里这个实例名下还没关的读取 */
  const openReadsOf = instanceId => Object.values(reads()?.handles ?? {}).filter(h => h.instanceId === instanceId && h.state !== 'closed');

  // 项目创建者打开云端 Agent。
  const creatorSession = await doc('session', { projectId, deviceId: 'dual-device-0', requestId: tag('creator-session') }, fixture.creatorEditorToken);
  assert.equal(creatorSession.status, 200);
  const enabled = await doc('admin', { projectId, op: 'set-hosted-service', service: 'agent', enabled: true,
    expectedAccessRevision: creatorSession.body.accessRevision, requestId: tag('enable-agent') }, fixture.creatorEditorToken);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const accounts = fixture.accounts, summary = {};
  let current = await fixture.startAgent();
  assert.ok(current.ready.instanceGeneration > 0);

  await t.test('Agent 服务重启（硬杀再起）时开着云端对话页：之后改密退出能办完；旧实例名下的读取凭新进程的证据收口', async () => {
    const member = accounts[1], initiator = await website(member, member.password);
    const pageA = await cloudPage(member, member.password, 'restart_conversation_a');
    const before = current;
    assert.equal(openReadsOf(before.ready.instanceId).length, 1, '旧实例名下开着这条事件流的读取');
    // Agent 服务重启：旧进程被硬杀，来不及关读取；新进程在同一个数据目录上起来。
    await fixture.killAgent(before);
    await waitFor(() => pageA.stream.closed, '旧进程死了，页面上的事件流断了');
    current = await fixture.startAgent();
    assert.notEqual(current.pid, before.pid);
    assert.ok(current.ready.instanceGeneration > before.ready.instanceGeneration, '新进程是新的一代');
    // 页面会自己重连到新进程，又开一条读取（这一条由活着的新进程照常关、照常确认）。
    const reopened = await pageA.openStream();
    // 改密选退出：要办完。
    const eventId = await changeAndExit(initiator, member.password, member.nextPassword);
    assert.equal((await pageA.other.site.request('GET', '/me')).body.account, null);
    assert.equal(await pageA.other.stillIn(), 401, '权限当场就撤');
    const done = await completeOnPage(initiator, eventId);
    assert.deepEqual(done.logout.pendingServices, []);
    await waitFor(() => reopened.closed, '重连后的那条事件流也被新进程关了');
    const end = await waitFor(() => { const value = ledgerStatus(eventId); return value.logoutComplete ? value : null; }, '文档服务记下退出办完');
    assert.match(end.services.agent.receiptId, /^agent-read:/);
    assert.deepEqual(fixture.accountAcks(eventId).map(ack => ack.service).sort(), ['agent', 'asset', 'doc', 'render']);
    // 旧实例：在文档服务账本里记成已收口，收口凭的是新进程交来的「旧进程已不在」的证据，不是新一代自己登记了。
    const old = instances()[before.ready.instanceId];
    assert.equal(old.state, 'closed');
    assert.match(old.closure.witnessId, /^handover:/);
    assert.equal(old.closure.handoverByInstanceId, current.ready.instanceId);
    assert.equal(openReadsOf(before.ready.instanceId).length, 0);
    summary.restartThenLogout = { oldGeneration: before.ready.instanceGeneration, newGeneration: current.ready.instanceGeneration,
      evidence: old.closure.evidence };
  });

  await t.test('进程没了、还没有新进程：一直不报办完；新进程起来交了证据才办完', async () => {
    const member = accounts[2], initiator = await website(member, member.password);
    const pageB = await cloudPage(member, member.password, 'restart_conversation_b');
    const before = current;
    await fixture.killAgent(before);
    const eventId = await changeAndExit(initiator, member.password, member.nextPassword);
    assert.equal(await pageB.other.stillIn(), 401);
    // 没有任何东西能证明旧进程不在了（文档服务看到的只是连接断了）：照旧等。
    const pending = await neverShown(initiator, eventId, 3000);
    assert.equal(instances()[before.ready.instanceId].state, 'active', '没有证据，不把旧实例记成已收口');
    assert.deepEqual(openReadsOf(before.ready.instanceId).map(h => h.state), ['closing'], '旧实例名下的读取被点名要关，还没有收口');
    current = await fixture.startAgent();
    const done = await completeOnPage(initiator, eventId);
    assert.deepEqual(done.logout.pendingServices, []);
    assert.match(instances()[before.ready.instanceId].closure.witnessId, /^handover:/);
    summary.goneThenLogout = { pendingReads: pending.reads };
  });

  await t.test('反向：实例还活着、确实还开着读取，迟迟没关：再起一个更新的实例也不放过；它自己关了才办完', async () => {
    const owner = accounts[0], initiator = await website(owner, owner.password);
    const pageC = await cloudPage(owner, owner.password, 'restart_conversation_c');
    const alive = current;
    assert.equal(openReadsOf(alive.ready.instanceId).length, 1);
    await fixture.holdAgentChildReadClose(alive);
    // 同一个数据目录上再起一个：旧的那个还活着、握着这个目录，新的起不来（不会顶替它）。
    await assert.rejects(fixture.startAgent({ port: sparePort2 }), /read-control-owner-busy/);
    // 另一个数据目录上起一个更新的一代：它连上了文档服务，但它拿不出旧实例「不在了」的证据。
    const newer = await fixture.startAgent({ port: sparePort, receiptFile: path.join(path.dirname(fixture.agentReceiptFile), 'agent-elsewhere', 'reads.sqlite') });
    assert.ok(newer.ready.instanceGeneration > alive.ready.instanceGeneration);
    const eventId = await changeAndExit(initiator, owner.password, owner.nextPassword);
    assert.equal(await pageC.other.stillIn(), 401);
    const pending = await neverShown(initiator, eventId, 4000);
    assert.equal(instances()[alive.ready.instanceId].state, 'active', '活着的实例不被记成已收口');
    assert.equal(instances()[alive.ready.instanceId].closure, null);
    assert.equal(pageC.stream.closed, false, '页面上的事件流确实还开着');
    // 活着的那个自己关了、确认了，才办完。
    await fixture.releaseAgentChildReadClose(alive);
    const done = await completeOnPage(initiator, eventId);
    assert.deepEqual(done.logout.pendingServices, []);
    await waitFor(() => pageC.stream.closed, '事件流被它自己关了');
    assert.equal(instances()[alive.ready.instanceId].state, 'active', '它是自己确认的，不是被当成死了');
    await fixture.killAgent(newer);
    summary.aliveNotReleased = { pendingReads: pending.reads };
  });
  t.diagnostic(JSON.stringify(summary));
});
