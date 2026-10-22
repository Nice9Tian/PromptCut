// 改密后选「退出」触发的逐项撤回,整条链路(0.7.20):真的 VisuHive 账号后端(网站接口加内部口)、真的文档服务组合
// (账本、操作历史、退出确认的续办器加撤回执行器)、真的素材服务进程、经边缘代理的 wss 编辑页连接。不连节点。
// 需要 PROMPTCUT_ACCOUNT_PROVIDER_ROOT / PROMPTCUT_PASSWORD_ORDER_MODULE 指向带撤回证明的账号后端。
//
// LR-E1 区间里旧设备改了两处,其中一处随后被另一位成员接着改过:撤一处、留一处;网页读到的状态在「设备已退出」时就带着
//       「撤了 1 处、保留 1 处」(网页据此显示那一行);此刻在线的两位成员各收一条气泡「〈用户名〉撤回了内容」,
//       名字是改密那个账号;项目内容里撤掉的那处回到改密前的值,别人改的那处不动;没有任何人收到待合并表的推送(不弹窗口)
// LR-E2 改密后旧设备什么都没改就选退出:没有要撤的,状态里不带撤回结果(网页不显示那一行),也没人收到气泡
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import WebSocket from 'ws';
import { freePorts } from './free-ports.mjs';
import { startAccountPasswordUserFixture } from './fixtures/account-password-user-path.mjs';

const actual = { skip: !process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT && 'Explicit actual account provider required', timeout: 240_000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, what, ms = 40_000) {
  const until = Date.now() + ms;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > until) throw Error(`timeout waiting for ${what}`); await sleep(100); }
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

test('LR-E 改密退出的逐项撤回:整条链路', actual, async t => {
  const [agentPort, ...ports] = await freePorts(8);
  const fixture = await startAccountPasswordUserFixture({ ports, agentPort, logoutConfirmPollMs: 250 });
  t.after(() => fixture.close());
  const ca = await fs.readFile(fixture.caFile), origin = fixture.origin, projectId = fixture.projectId;
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
  /** 一台设备上的编辑页:网站会话 → 编辑器登录 → 进项目 → wss 连接并打开项目 */
  async function page(account, password) {
    const site = await website(account, password), deviceId = tag('rollback-device');
    const editor = await site.request('POST', '/editor/session', { deviceId, deviceName: 'Rollback device', requestId: tag('editor') });
    assert.equal(editor.status, 200);
    const session = await doc('session', { projectId, deviceId, requestId: tag('session') }, editor.body.accessToken);
    assert.equal(session.status, 200, JSON.stringify(session.body));
    const ws = new WebSocket(origin.replace('https:', 'wss:') + '/hosted/', ['promptcut.v1', `promptcut.account.${session.body.connectionTicket}`], { ca, origin });
    const all = []; ws.on('message', bytes => { try { all.push(JSON.parse(bytes.toString())); } catch {} });
    const closed = new Promise(resolve => ws.once('close', resolve));
    t.after(() => ws.terminate());
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const send = frame => new Promise((resolve, reject) => { const reqId = tag('req');
      const timer = setTimeout(() => reject(Error(`page-request-timeout ${frame.type}`)), 15_000);
      const receive = bytes => { const reply = JSON.parse(bytes.toString()); if (reply.reqId !== reqId) return; clearTimeout(timer); ws.off('message', receive); resolve(reply); };
      ws.on('message', receive); ws.send(JSON.stringify({ ...frame, reqId })); });
    const opened = await send({ type: 'project.open', projectId });
    assert.equal(opened.type, 'project.state', JSON.stringify(opened).slice(0, 300));
    const op = async (ops) => { const reply = await send({ type: 'project.op', projectId, opId: tag('op'), ops }); assert.equal(reply.type, 'project.op.ok', JSON.stringify(reply)); return reply; };
    return { site, ws, all, closed, send, op };
  }
  async function changeAndExit(initiator, current, next) {
    const changed = await initiator.request('POST', '/password', { current, next, requestId: tag('change') });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    return { eventId: changed.body.passwordEventId,
      exit: async () => { const choice = await initiator.request('POST', `/password-events/${encodeURIComponent(changed.body.passwordEventId)}/choice`, { exitOthers: true, requestId: tag('choice') });
        assert.equal(choice.status, 202); } };
  }
  const status = async (initiator, eventId) => (await initiator.request('GET', `/password-events/${encodeURIComponent(eventId)}`)).body;
  const complete = (initiator, eventId) => waitFor(async () => { const body = await status(initiator, eventId); return body.logout?.state === 'complete' ? body : null; }, '网页读到退出办完');
  const [creator, member, other] = fixture.accounts;
  const notices = p => p.all.filter(m => m.type === 'shared.notice' && m.event === 'content-rolled-back');
  const summary = {};

  await t.test('LR-E1 撤一处、留一处;网页状态带结果;在线成员各一条气泡;不进待合并表', async () => {
    const owner = await page(creator, creator.password), peer = await page(other, other.password);
    const initiator = await website(member, member.password), old = await page(member, member.password);
    await old.op([{ op: 'set', path: '/rollbackE2E', value: { a: 'before', b: 'before' } }]);
    const { eventId, exit } = await changeAndExit(initiator, member.password, member.nextPassword);
    await old.op([{ op: 'set', path: '/rollbackE2E/a', value: 'old-device' }, { op: 'set', path: '/rollbackE2E/b', value: 'old-device' }]);
    await peer.op([{ op: 'set', path: '/rollbackE2E/b', value: 'other-member' }]);
    await exit();
    await old.closed;
    const done = await complete(initiator, eventId);
    assert.deepEqual([done.modifications.state, done.modifications.reverted, done.modifications.kept], ['rolled-back', 1, 1],
      `「设备已退出」时撤回结果已经在状态里:${JSON.stringify(done.modifications)}`);
    for (const p of [owner, peer]) {
      const [notice] = await waitFor(() => notices(p).length ? notices(p) : null, '在线成员收到气泡');
      assert.equal(notice.name, member.name, '〈用户名〉是改密的那个账号');
      assert.equal(notices(p).length, 1);
      assert.equal(p.all.some(m => String(m.type).startsWith('merge.')), false, '改密退出触发的撤回不进待合并表、不弹窗口');
    }
    const state = await owner.send({ type: 'project.open', projectId });
    assert.deepEqual(state.project.rollbackE2E, { a: 'before', b: 'other-member' });
    // 之后才打开的页面不补弹
    const late = await page(other, other.password); await sleep(500);
    assert.equal(notices(late).length, 0, '不在线的不补弹');
    const ledger = fixture.combo.logoutConfirmer.status(eventId);
    assert.equal(ledger.logoutComplete, true);
    summary.e1 = { modifications: done.modifications, notices: [notices(owner).length, notices(peer).length, notices(late).length] };
    if (process.env.LR_E_STATUS_OUT) await fs.writeFile(process.env.LR_E_STATUS_OUT, JSON.stringify(done, null, 2));
  });

  await t.test('LR-E2 改密后旧设备什么都没改:状态不带撤回结果,没有气泡', async () => {
    const watcher = await page(creator, creator.password);
    const initiator = await website(other, other.password); await page(other, other.password);
    const { eventId, exit } = await changeAndExit(initiator, other.password, other.nextPassword);
    await exit();
    const done = await complete(initiator, eventId);
    assert.equal(done.modifications.state, 'retained');
    await sleep(500);
    assert.equal(notices(watcher).length, 0);
    summary.e2 = { modifications: done.modifications.state };
  });
  t.diagnostic(JSON.stringify(summary));
});
