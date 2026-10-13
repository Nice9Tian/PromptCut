// 退出确认的时限：选了「退出别的设备」以后，等各服务确认超过时限，网页读到的是失败和调试信息，不是「设备已退出」。
// 两种会一直等下去的情形各造一遍：某个服务一直不回确认；Agent 服务带着旧登录开着的读取被结束。
//
// 环境同 account-logout-confirmation.test.mjs（真的账号后端、文档服务组合、独立的素材进程、Agent 读取控制，都在本机）。
// 时限在这里设成 3 秒（生产缺省 120 秒），账号服务和文档服务两边用同一个数。
// 需要账号后端是带时限的那一版（VisuHive 分支 claude/v18-logout-text 起）；环境变量指着旧版时整份跳过并写明原因。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startAccountPasswordUserFixture } from './fixtures/account-password-user-path.mjs';

const ports = [28150, 28151, 28152, 28153, 28154, 28155, 28156], agentPort = 28157, TIMEOUT_MS = 3000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, what, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check(); if (value) return value;
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

test('退出确认超时：到时显示失败和调试信息，不冒称已退出，不放回权限；迟到的确认到齐后照实变成办完', { timeout: 300_000 }, async t => {
  const fixture = await startAccountPasswordUserFixture({ ports, agentPort, logoutConfirmPollMs: 250, logoutConfirmTimeoutMs: TIMEOUT_MS,
    assetEntry: fileURLToPath(new URL('./fixtures/asset-entry-restartable.mjs', import.meta.url)) });
  t.after(() => fixture.close());
  if (!fixture.providerSupportsLogoutTimeout) { t.skip('账号后端是没有退出确认时限的旧版（要 VisuHive 分支 claude/v18-logout-text 起）'); return; }
  const ca = await fs.readFile(fixture.caFile), origin = fixture.origin, projectId = fixture.projectId, accounts = fixture.accounts;
  let serial = 0; const tag = name => `${name}-${++serial}`;
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
  const doc = (route, body, token) => jsonRequest(`${origin}/hosted/shared/account/${route}`, { method: 'POST', ca, body, headers: { authorization: `Bearer ${token}` } });
  async function otherDevice(account, password) {
    const site = await website(account, password), deviceId = tag('timeout-device');
    const editor = await site.request('POST', '/editor/session', { deviceId, deviceName: 'Other device', requestId: tag('editor') });
    assert.equal(editor.status, 200);
    const session = await doc('session', { projectId, deviceId, requestId: tag('session') }, editor.body.accessToken);
    assert.equal(session.status, 200, JSON.stringify(session.body));
    return { site, deviceId, token: editor.body.accessToken, session: session.body,
      stillIn: async () => (await doc('session', { projectId, deviceId, requestId: tag('session-again') }, editor.body.accessToken)).status };
  }
  async function changeAndExit(initiator, current, next) {
    const changed = await initiator.request('POST', '/password', { current, next, requestId: tag('change') });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const eventId = changed.body.passwordEventId;
    assert.equal((await initiator.request('POST', `/password-events/${encodeURIComponent(eventId)}/choice`, { exitOthers: true, requestId: tag('choice') })).status, 202);
    return { eventId, at: Date.now() };
  }
  const page = async (initiator, eventId) => (await initiator.request('GET', `/password-events/${encodeURIComponent(eventId)}`)).body;
  const ledgerStatus = eventId => fixture.combo.logoutConfirmer.status(eventId);
  /** 到时之前每一次读到的都是进行中；到时以后读到失败。回第一次读到的失败。 */
  async function untilFailed(initiator, exit) {
    let reads = 0;
    for (;;) {
      const body = await page(initiator, exit.eventId), elapsed = Date.now() - exit.at;
      assert.notEqual(body.logout.state, 'complete', '没确认齐不许显示办完');
      if (body.logout.state === 'failed') { assert.ok(elapsed >= TIMEOUT_MS - 50, `不能早于时限就报失败（${elapsed} 毫秒）`); return { body, reads, elapsed }; }
      assert.equal(body.logout.state, 'revoking'); assert.equal(body.logout.failure, undefined);
      assert.ok(elapsed < TIMEOUT_MS + 3000, '过了时限还显示进行中');
      reads += 1; await sleep(200);
    }
  }
  /** 调试信息里不许有令牌、票据、密钥，也没有登录号。 */
  function assertNoSecrets(value, device) {
    const text = JSON.stringify(value);
    for (const secret of [device.token, device.session.connectionTicket, device.session.assetTicket, device.session.agentDelegationTicket])
      assert.equal(text.includes(secret), false, '调试信息里出现了令牌或票据');
    assert.doesNotMatch(text, /login_[0-9a-f]{8}|cred_[0-9a-f]{8}|Bearer|BEGIN [A-Z ]*KEY/);
  }
  const summary = {};

  await t.test('某个服务一直不回确认（素材服务停着）：到时失败；它后来回了，状态照实变成办完', async st => {
    let assetUp = true; st.after(async () => { if (!assetUp) await fixture.startAsset(); });
    const owner = accounts[0], initiator = await website(owner, owner.password), other = await otherDevice(owner, owner.password);
    await fixture.stopAsset(); assetUp = false;
    const exit = await changeAndExit(initiator, owner.password, owner.nextPassword);
    assert.equal((await other.site.request('GET', '/me')).body.account, null, '权限在选退出的那一刻就撤了');
    const failed = await untilFailed(initiator, exit), failure = failed.body.logout.failure;
    assert.equal(failure.reason, 'confirmation-timeout'); assert.equal(failure.eventId, exit.eventId); assert.equal(failure.timeoutMs, TIMEOUT_MS);
    assert.ok(failure.waitedMs >= TIMEOUT_MS);
    assert.deepEqual(failure.confirmedServices, [], '账号服务这边一样确认都没收到（文档服务等齐了才一起送）');
    assert.deepEqual(failure.pendingServices, ['doc', 'asset', 'agent', 'render']);
    // 文档服务把它那边看到的进度报了上来：素材没回，所以它自己那一项也没报；Agent 和渲染是齐的。
    const reported = await waitFor(async () => (await page(initiator, exit.eventId)).logout.failure?.docReport, '文档服务报来的进度');
    assert.deepEqual(reported.confirmed, ['agent', 'render']); assert.deepEqual(reported.pending, ['doc', 'asset']);
    assert.deepEqual(reported.reasons, ['logout-pending:doc,asset']); assert.ok(reported.waitedMs >= TIMEOUT_MS);
    assertNoSecrets((await page(initiator, exit.eventId)).logout, other);
    // 文档服务的账本里记了一次，之后不变；这次退出仍然算没办完、接着办。
    const record = ledgerStatus(exit.eventId).timeout;
    assert.deepEqual(record.pending, ['doc', 'asset']); assert.equal(record.reported, true);
    await sleep(800);
    assert.deepEqual(ledgerStatus(exit.eventId).timeout, record); assert.equal(ledgerStatus(exit.eventId).logoutComplete, false);
    assert.equal(fixture.accountInternalSeen(/^POST \/internal\/v2\/events\/[^/]+\/logout-report$/), 1, '进度只报一次');
    assert.equal((await page(initiator, exit.eventId)).logout.state, 'failed');
    // 迟到的确认：素材服务起来、回了确认，四样齐了，状态照实变成办完；失败和调试信息不再出现。旧登录始终进不来。
    await fixture.startAsset(); assetUp = true;
    const done = await waitFor(async () => { const body = await page(initiator, exit.eventId);
      assert.notEqual(body.logout.state, 'revoking', '到时以后不会退回「正在退出」'); return body.logout.state === 'complete' ? body : null; }, '迟到的确认到齐');
    assert.equal(done.logout.failure, undefined); assert.deepEqual(done.logout.pendingServices, []);
    assert.equal(await other.stillIn(), 401);
    assert.ok(ledgerStatus(exit.eventId).timeout, '曾经超时这件事留在账本里');
    summary.serviceSilent = { readsBeforeFailed: failed.reads, failedAfterMs: failed.elapsed, docReport: reported.reasons, lateState: done.logout.state };
  });

  await t.test('Agent 服务带着旧登录开着的读取被结束：到时失败，调试信息指到 Agent 的读取没关；一直是失败，不冒称办完', async st => {
    // 项目创建者（账号 0，已经改过密）用新密码登录后打开云端 Agent。
    const creator = await otherDevice(accounts[0], accounts[0].nextPassword);
    const enabled = await doc('admin', { projectId, op: 'set-hosted-service', service: 'agent', enabled: true,
      expectedAccessRevision: creator.session.accessRevision, requestId: tag('enable-agent') }, creator.token);
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    const member = accounts[1], initiator = await website(member, member.password), other = await otherDevice(member, member.password);
    assert.equal((await other.site.request('POST', '/cloud-agent-consent', { accept: true, noticeVersion: 1, requestId: tag('consent') })).status, 200);
    const session = (await doc('session', { projectId, deviceId: other.deviceId, requestId: tag('agent-session') }, other.token)).body;
    const ws = new WebSocket(origin.replace('https:', 'wss:') + '/hosted/', ['promptcut.v1', `promptcut.account.${session.connectionTicket}`], { ca, origin });
    st.after(() => ws.terminate());
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const send = frame => new Promise((resolve, reject) => { const reqId = tag('page');
      const timer = setTimeout(() => reject(Error('page-request-timeout')), 10_000);
      const receive = bytes => { const reply = JSON.parse(bytes.toString()); if (reply.reqId !== reqId) return;
        clearTimeout(timer); ws.off('message', receive); resolve(reply); };
      ws.on('message', receive); ws.send(JSON.stringify({ ...frame, reqId })); });
    await send({ type: 'project.open', projectId });
    assert.equal((await send({ type: 'selection.set', projectId, pageId: 'timeout-page', revision: 1, selection: { clipIds: [] } })).type, 'selection.ok');
    const agentHeaders = { authorization: `Bearer ${session.agentDelegationTicket}` }, conversationId = 'logout_timeout_conversation';
    const posted = await jsonRequest(`${origin}/agent/v1/conversations/${conversationId}/messages`, { method: 'POST', ca, headers: agentHeaders,
      body: { prompt: '退出超时测试用的一条消息', requestId: 'logout_timeout_message', selectionSnapshot: { pageId: 'timeout-page' } } });
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    const stream = { status: null };
    const streamRequest = https.get(`${origin}/agent/v1/conversations/${conversationId}/events`, { ca, headers: agentHeaders }, res => { stream.status = res.statusCode; res.on('data', () => {}); res.on('error', () => {}); });
    streamRequest.on('error', () => {}); st.after(() => streamRequest.destroy());
    await waitFor(() => stream.status !== null, '事件流打开'); assert.equal(stream.status, 200);
    // Agent 服务的进程没了：它开着的那条读取没来得及向文档服务关掉。
    await fixture.dropAgentInstance();
    const exit = await changeAndExit(initiator, member.password, member.nextPassword);
    assert.equal((await other.site.request('GET', '/me')).body.account, null);
    assert.equal(await other.stillIn(), 401, '权限在选退出的那一刻就撤了');
    const failed = await untilFailed(initiator, exit);
    const reported = await waitFor(async () => (await page(initiator, exit.eventId)).logout.failure?.docReport, '文档服务报来的进度');
    assert.deepEqual(reported.confirmed, ['asset', 'render']); assert.deepEqual(reported.pending, ['doc', 'agent']);
    assert.deepEqual(reported.reasons, ['logout-pending:doc,agent', 'agent:read-close-pending']);
    assertNoSecrets((await page(initiator, exit.eventId)).logout, { ...other, session });
    // 再等一个时限那么久：一直是失败，没有变成办完；旧登录仍然进不来；新密码照常登录。
    const until = Date.now() + TIMEOUT_MS;
    while (Date.now() < until) { assert.equal((await page(initiator, exit.eventId)).logout.state, 'failed'); await sleep(300); }
    assert.equal(ledgerStatus(exit.eventId).logoutComplete, false);
    assert.equal(await other.stillIn(), 401);
    assert.equal(await (await otherDevice(member, member.nextPassword)).stillIn(), 200);
    summary.agentGone = { readsBeforeFailed: failed.reads, failedAfterMs: failed.elapsed, docReport: reported.reasons };
  });
  t.diagnostic(JSON.stringify(summary));
});
