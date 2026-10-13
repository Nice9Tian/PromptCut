// 改密后选「退出别的设备」的确认链：账号、文档、素材、Agent 各服务都确认以后，网页才显示退出成功。
//
// 环境（都在本机、互相隔离，不连节点）：真的 VisuHive 账号后端（网站接口加内部口，库是临时目录里的 SQLite）、
// 真的文档服务组合（账本、操作历史、退出确认的续办器）、单独一个进程的真的素材服务、真的 Agent 服务（对话接口与读取控制）。
// 需要环境变量 PROMPTCUT_ACCOUNT_PROVIDER_ROOT 与 PROMPTCUT_PASSWORD_ORDER_MODULE 指向账号后端。
//
// 「网页显示什么」看的是网页自己读的那个接口 GET /api/account/password-events/<事件号>：
// 网页（VisuHive 的 site/assets/account.js）只在它回 logout.state === 'complete' 时显示已退出，其余时候显示正在退出。
//
// 这里的 Agent 服务没有开「一条任务一个进程」（那一档读 root 记录的代码只在 Linux 上跑），所以它要确认的是「旧登录开着的读取都关了」；
// 任务那一半（私有任务中止、共有已读任务继续）在 account-worker-lifecycle.test.mjs 里用真的任务子进程验。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { startAccountPasswordUserFixture } from './fixtures/account-password-user-path.mjs';

const ports = [28140, 28141, 28142, 28143, 28144, 28145, 28146], agentPort = 28147;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, what, ms = 30_000) {
  const until = Date.now() + ms; let last;
  for (;;) {
    last = await check(); if (last) return last;
    if (Date.now() > until) throw Error(`timeout waiting for ${what}`);
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

test('退出确认：四个服务都确认以后网页才显示成功；缺一个不显示；丢通知、重复、重启后续办', { timeout: 300_000 }, async t => {
  const fixture = await startAccountPasswordUserFixture({ ports, agentPort, logoutConfirmPollMs: 250,
    assetEntry: fileURLToPath(new URL('./fixtures/asset-entry-restartable.mjs', import.meta.url)) });
  t.after(() => fixture.close());
  const ca = await fs.readFile(fixture.caFile), origin = fixture.origin, projectId = fixture.projectId;
  let serial = 0;
  const tag = name => `${name}-${++serial}`;
  /** 一台设备上的网站会话（各有自己的 cookie）。 */
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
  /** 另一台设备：一个网站会话，加上这台设备上的编辑器登录和它进项目的会话。 */
  async function otherDevice(account, password) {
    const site = await website(account, password), deviceId = tag('logout-device');
    const editor = await site.request('POST', '/editor/session', { deviceId, deviceName: 'Other device', requestId: tag('editor') });
    assert.equal(editor.status, 200);
    const session = await doc('session', { projectId, deviceId, requestId: tag('session') }, editor.body.accessToken);
    assert.equal(session.status, 200, JSON.stringify(session.body));
    return { site, deviceId, token: editor.body.accessToken, session: session.body,
      stillIn: async () => (await doc('session', { projectId, deviceId, requestId: tag('session-again') }, editor.body.accessToken)).status };
  }
  /** 在发起的那台设备上改密，然后选「退出别的设备」。 */
  async function changeAndExit(initiator, current, next) {
    const changed = await initiator.request('POST', '/password', { current, next, requestId: tag('change') });
    assert.equal(changed.status, 200, JSON.stringify(changed.body)); assert.equal(changed.body.choice, 'pending');
    const eventId = changed.body.passwordEventId;
    const choice = await initiator.request('POST', `/password-events/${encodeURIComponent(eventId)}/choice`, { exitOthers: true, requestId: tag('choice') });
    assert.equal(choice.status, 202); assert.equal(choice.body.choice, 'exit');
    return eventId;
  }
  /** 网页读到的状态。 */
  const page = async (initiator, eventId) => (await initiator.request('GET', `/password-events/${encodeURIComponent(eventId)}`)).body;
  const shown = body => body.logout?.state === 'complete' ? '已退出' : '正在退出';
  const ledgerStatus = eventId => fixture.combo.logoutConfirmer.status(eventId);
  const completeOnPage = (initiator, eventId) => waitFor(async () => { const body = await page(initiator, eventId);
    return body.logout?.state === 'complete' ? body : null; }, '网页读到退出办完');
  /** 在一段时间里反复读：一次都不许显示成功，并且每次都点得出还差谁。 */
  async function neverShown(initiator, eventId, missing, ms = 2500) {
    const until = Date.now() + ms; let reads = 0, last;
    while (Date.now() < until) {
      last = await page(initiator, eventId); reads += 1;
      assert.equal(shown(last), '正在退出', `缺 ${missing} 的确认时网页不能显示成功`);
      assert.equal(last.logout.state, 'revoking');
      assert.ok(last.logout.pendingServices.includes(missing), `待确认里要有 ${missing}：${JSON.stringify(last.logout.pendingServices)}`);
      await sleep(250);
    }
    return { reads, last };
  }
  const accounts = fixture.accounts, summary = {};

  await t.test('Agent 没确认（旧登录开着读取，Agent 服务收口的那一步迟迟没做完）：不显示成功；做完以后才显示', async st => {
    // 项目创建者打开云端 Agent；这位成员同意过提示，在另一台设备上开着编辑页和一条对话的事件流。
    const creatorSession = await doc('session', { projectId, deviceId: 'dual-device-0', requestId: tag('creator-session') }, fixture.creatorEditorToken);
    assert.equal(creatorSession.status, 200);
    const enabled = await doc('admin', { projectId, op: 'set-hosted-service', service: 'agent', enabled: true,
      expectedAccessRevision: creatorSession.body.accessRevision, requestId: tag('enable-agent') }, fixture.creatorEditorToken);
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    const member = accounts[1], initiator = await website(member, member.password);
    const other = await otherDevice(member, member.password);
    assert.equal((await other.site.request('POST', '/cloud-agent-consent', { accept: true, noticeVersion: 1, requestId: tag('consent') })).status, 200);
    const session = (await doc('session', { projectId, deviceId: other.deviceId, requestId: tag('agent-session') }, other.token)).body;
    assert.equal(session.hosted.agent.enabled, true);
    const ws = new WebSocket(origin.replace('https:', 'wss:') + '/hosted/', ['promptcut.v1', `promptcut.account.${session.connectionTicket}`], { ca, origin });
    const wsClosed = new Promise(resolve => ws.once('close', resolve));
    st.after(() => ws.terminate());
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const send = frame => new Promise((resolve, reject) => { const reqId = tag('page');
      const timer = setTimeout(() => reject(Error('page-request-timeout')), 10_000);
      const receive = bytes => { const reply = JSON.parse(bytes.toString()); if (reply.reqId !== reqId) return;
        clearTimeout(timer); ws.off('message', receive); resolve(reply); };
      ws.on('message', receive); ws.send(JSON.stringify({ ...frame, reqId })); });
    await send({ type: 'project.open', projectId });
    assert.equal((await send({ type: 'selection.set', projectId, pageId: 'logout-page', revision: 1, selection: { clipIds: [] } })).type, 'selection.ok');
    const agentHeaders = { authorization: `Bearer ${session.agentDelegationTicket}` }, conversationId = 'logout_confirmation_conversation';
    const posted = await jsonRequest(`${origin}/agent/v1/conversations/${conversationId}/messages`, { method: 'POST', ca, headers: agentHeaders,
      body: { prompt: '退出确认测试用的一条消息', requestId: 'logout_confirmation_message', selectionSnapshot: { pageId: 'logout-page' } } });
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    // 旧登录开着的读取：这条对话的事件流，一直不关。
    const stream = { status: null, closed: false };
    const streamRequest = https.get(`${origin}/agent/v1/conversations/${conversationId}/events`, { ca, headers: agentHeaders }, res => {
      stream.status = res.statusCode; res.on('data', () => {}); res.once('close', () => { stream.closed = true; }); });
    streamRequest.on('error', () => { stream.closed = true; });
    st.after(() => streamRequest.destroy());
    await waitFor(() => stream.status !== null, '事件流打开');
    assert.equal(stream.status, 200);

    // Agent 服务收到「把这个登录的读取关掉并确认」以后，收口的那一步迟迟没做完，所以它的确认一直没到。
    let release; const gate = new Promise(resolve => { release = resolve; });
    const restore = fixture.holdAgentReadClose(gate);
    st.after(() => { release(); restore(); });
    const eventId = await changeAndExit(initiator, member.password, member.nextPassword);
    // 权限当场就撤：旧设备的网站会话、编辑器登录、编辑页的连接都已经不行了。
    assert.equal((await other.site.request('GET', '/me')).body.account, null);
    assert.equal(await other.stillIn(), 401);
    await wsClosed;
    const pending = await neverShown(initiator, eventId, 'agent');
    const mid = ledgerStatus(eventId);
    assert.equal(mid.services.agent, null, 'Agent 这一项还没有确认');
    assert.ok(mid.services.asset, '素材服务已经确认了，但只有它不够');
    assert.equal(mid.services.render.attested, true);
    assert.equal(mid.docConfirmed, false, '别的服务没齐之前文档服务不报自己这一项');
    assert.equal(fixture.accountAcks(eventId).some(ack => ack.logoutComplete), false, '账号服务没收到任何一份「已退出」的确认');
    release(); restore();
    const done = await completeOnPage(initiator, eventId);
    assert.deepEqual(done.logout.pendingServices, []); assert.equal(shown(done), '已退出');
    assert.equal(stream.closed, true, '旧登录的那条事件流确实关了');
    const end = await waitFor(() => { const value = ledgerStatus(eventId); return value.logoutComplete ? value : null; }, '文档服务记下退出办完');
    assert.match(end.services.agent.receiptId, /^agent-read:/);
    const acks = fixture.accountAcks(eventId);
    assert.deepEqual(acks.map(ack => ack.service).sort(), ['agent', 'asset', 'doc', 'render']);
    assert.ok(acks.every(ack => ack.logoutComplete === true));
    assert.equal(acks.find(ack => ack.service === 'doc').transport, 'closed');
    assert.equal(acks.find(ack => ack.service === 'doc').connections, 1, '文档服务的确认里写明了它关掉的那条编辑页连接');
    summary.agent = { pendingReads: pending.reads, pendingServicesWhileHeld: pending.last.logout.pendingServices };
  });

  await t.test('通知没送到、回应丢了、同一份确认重复送到：照样办完，而且只办一次', async () => {
    const account = accounts[2], initiator = await website(account, account.password);
    const other = await otherDevice(account, account.password);
    const ackRoute = /^POST \/internal\/v2\/events\/[^/]+\/ack$/, sealRoute = /^POST \/internal\/v2\/order\/logout-complete$/;
    // 文档服务去取账号事件的请求有三次没送到；它的确认有两次、结束见证有一次是账号服务办了但回应丢了。
    const lostFetch = fixture.accountFault({ match: /^GET \/internal\/v2\/events$/, kind: 'drop-request', times: 3 });
    const lostAck = fixture.accountFault({ match: ackRoute, kind: 'drop-response', times: 2 });
    const lostSeal = fixture.accountFault({ match: sealRoute, kind: 'drop-response', times: 1 });
    const sealsBefore = fixture.accountInternalSeen(sealRoute);
    const eventId = await changeAndExit(initiator, account.password, account.nextPassword);
    const done = await completeOnPage(initiator, eventId);
    assert.equal(await other.stillIn(), 401);
    const end = await waitFor(() => { const value = ledgerStatus(eventId); return value.logoutComplete ? value : null; }, '文档服务记下退出办完');
    assert.deepEqual([lostFetch.applied, lostAck.applied, lostSeal.applied], [3, 2, 1], '三种故障都真的发生过');
    assert.ok(fixture.accountInternalSeen(sealRoute) - sealsBefore >= 2, '结束见证重发过');
    // 重复送到的确认没有变成两份：每个服务一行；结束位置只有一个，两边记的是同一个。
    const acks = fixture.accountAcks(eventId);
    assert.deepEqual(acks.map(ack => ack.service).sort(), ['agent', 'asset', 'doc', 'render']);
    const witness = fixture.combo.accountRuntime.authority.revocationStatus(eventId).logoutWitness;
    assert.equal(witness.orderSeq, done.logout.endOrderSeq);
    // 办完以后再催也不会再发任何东西。
    const seen = () => [fixture.accountInternalSeen(ackRoute), fixture.accountInternalSeen(sealRoute)];
    const before = seen();
    for (let i = 0; i < 3; i++) await fixture.combo.logoutConfirmer.tick();
    await sleep(600);
    assert.deepEqual(seen(), before, '办完的退出不重复办');
    assert.equal((await page(initiator, eventId)).logout.endOrderSeq, witness.orderSeq);
    assert.deepEqual(end.pendingServices, []);
    summary.faults = { lostFetch: lostFetch.applied, lostAck: lostAck.applied, lostSeal: lostSeal.applied, endOrderSeq: witness.orderSeq };
  });

  const owner = accounts[0]; let ownerPassword = owner.password, assetUp = true;
  const stopAsset = async () => { await fixture.stopAsset(); assetUp = false; };
  const startAsset = async () => { const pid = await fixture.startAsset(); assetUp = true; return pid; };
  const assetBack = async () => { if (!assetUp) await startAsset(); };
  await t.test('素材服务没确认：不显示成功；素材服务重新起来以后接着办完', async st => {
    st.after(assetBack);
    const initiator = await website(owner, ownerPassword), other = await otherDevice(owner, ownerPassword);
    await stopAsset();
    const eventId = await changeAndExit(initiator, ownerPassword, owner.nextPassword); ownerPassword = owner.nextPassword;
    assert.equal((await other.site.request('GET', '/me')).body.account, null);
    const pending = await neverShown(initiator, eventId, 'asset');
    const mid = ledgerStatus(eventId);
    assert.equal(mid.services.asset, null); assert.match(mid.services.agent.receiptId, /^agent-read:/);
    assert.equal(mid.docConfirmed, false); assert.equal(mid.logoutComplete, false);
    assert.ok(pending.last.logout.pendingServices.includes('doc'), '文档服务等别的服务齐了才报自己这一项');
    // 素材服务在同一个数据目录上重新起来（另一个进程）：它从自己记的位置接着读事件、关掉该关的、再确认。
    const pid = await startAsset();
    const done = await completeOnPage(initiator, eventId);
    assert.deepEqual(done.logout.pendingServices, []);
    assert.equal(await other.stillIn(), 401, '旧设备的编辑器登录进不了项目');
    const acks = fixture.accountAcks(eventId);
    assert.ok(acks.length === 4 && acks.every(ack => ack.logoutComplete === true));
    assert.equal(acks.find(ack => ack.service === 'doc').transport, 'closed');
    summary.asset = { pendingReads: pending.reads, restartedPid: pid };
  });

  await t.test('文档服务在等确认的时候重启：重启后接着办完，不显示假成功，也不放回旧登录', async st => {
    st.after(assetBack);
    const initiator = await website(owner, ownerPassword), other = await otherDevice(owner, ownerPassword);
    const next = randomBytes(24).toString('base64url');
    await stopAsset();
    const eventId = await changeAndExit(initiator, ownerPassword, next); ownerPassword = next;
    await neverShown(initiator, eventId, 'asset', 1200);
    const firstInstance = fixture.combo.accountRuntime.docInstanceId;
    await fixture.restartDoc();
    assert.notEqual(fixture.combo.accountRuntime.docInstanceId, firstInstance, '确实是另一个文档服务实例');
    await neverShown(initiator, eventId, 'asset', 1200);
    assert.equal(ledgerStatus(eventId).logoutComplete, false);
    await startAsset();
    const done = await completeOnPage(initiator, eventId);
    assert.deepEqual(done.logout.pendingServices, []);
    assert.equal(await other.stillIn(), 401, '重启以后旧登录仍然进不来');
    const acks = fixture.accountAcks(eventId);
    assert.ok(acks.length === 4 && acks.every(ack => ack.logoutComplete === true));
    // 这个文档服务实例没有亲手关过旧登录的连接（它起来的时候那些登录已经作废），证据写的是这一条。
    assert.equal(acks.find(ack => ack.service === 'doc').transport, 'started-after-revocation');
    await waitFor(() => ledgerStatus(eventId).logoutComplete, '重启后的文档服务记下退出办完');
    // 新密码照常登录、照常进项目。
    const fresh = await otherDevice(owner, ownerPassword);
    assert.equal(await fresh.stillIn(), 200);
    summary.docRestart = { resumed: true };
  });
  t.diagnostic(JSON.stringify(summary));
});
