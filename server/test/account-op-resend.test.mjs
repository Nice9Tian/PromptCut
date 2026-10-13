/**
 * 账号云端项目里,已经落地的提交在续了访问令牌之后重发(同 opId、同内容):文档服务要按重复提交认,不能拒。
 * 真的账号服务、文档服务、素材服务(`fixtures/account-dual-user-path.mjs`);页面一侧用真的 `DocSync`。
 * 报告 `docs/reports/AGENT-v18-cardsync.md`。跑:npm test -- server/test/account-op-resend.test.mjs
 *
 * 原问题(审查复现):请求身份的摘要里含访问凭证号,令牌一续它就变,重发回 `project.op.rejected operation-id-mismatch`;
 * 页面弹「有一步修改没被文档服务接受…已撤回」并拿掉撤销步,而那一步其实落地了。页面断线重连、到期前换会话之后的重发都会中。
 *
 *   1 旧连接上提交一条,落地
 *   2 同一张令牌、另一条连接重发:回 ok、duplicate、同一个版本号
 *   3 续令牌(凭证号变了)、再开一条连接重发:同样回 ok、duplicate、同一个版本号;服务端版本没有再前进(内容只落一次)
 *   4 页面一侧(换连接之后收到这条回包):没有被拒的通知、没有未确认的、撤销步还在
 *   5 换了内容用同一个 opId、另一个账号用同一个 opId 同样内容:照旧回 operation-id-mismatch
 */
import { srcUrl } from '../../src/testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import WS from 'ws';
import { startAccountDualUserFixture } from './fixtures/account-dual-user-path.mjs';
import { freePorts } from './free-ports.mjs';

const { DocSync } = await import(srcUrl('store/docsync.ts'));

test('已落地的提交在续访问令牌之后重发:按重复提交认(ok、duplicate),内容只落一次', { timeout: 180_000 }, async (t) => {
  const fixture = await startAccountDualUserFixture({ ports: await freePorts(7) });
  const sockets = [];
  try {
    const ca = fs.readFileSync(fixture.caFile);
    const origin = fixture.origin, projectId = fixture.projectId;
    const wsUrl = `${origin.replace(/^https:/, 'wss:')}/hosted/`;
    const post = (route, body, token) => new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https.request(new URL(route, origin), { method: 'POST', ca, timeout: 10_000,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (e) { reject(e); } });
      });
      req.once('error', reject);
      req.once('timeout', () => req.destroy(new Error('timeout')));
      req.end(data);
    });
    let seq = 0;
    async function login(i, device) {
      const r = await post('/api/account/editor/login', { name: fixture.accounts[i].name, password: fixture.accounts[i].password, deviceId: device, deviceName: device, requestId: `rs-login-${device}` });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return { token: r.body.accessToken, recovery: r.body.recoveryToken, device };
    }
    async function conn(who) {
      const s = await post('/hosted/shared/account/session', { projectId, deviceId: who.device, requestId: `rs-s-${++seq}` }, who.token);
      assert.equal(s.status, 200, JSON.stringify(s.body));
      const socket = new WS(wsUrl, ['promptcut.v1', `promptcut.account.${s.body.connectionTicket}`], { ca, handshakeTimeout: 5000 });
      sockets.push(socket);
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const inbox = [], waiters = [];
      socket.on('message', (bytes) => { let m; try { m = JSON.parse(bytes.toString('utf8')); } catch { return; } inbox.push(m); for (const w of [...waiters]) w(); });
      const next = (pred, ms = 20_000) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等回包超时;收到的:${JSON.stringify(inbox.map((m) => m.type))}`)), ms);
        const check = () => { const i = inbox.findIndex(pred); if (i >= 0) { clearTimeout(timer); waiters.splice(waiters.indexOf(check), 1); resolve(inbox.splice(i, 1)[0]); } };
        waiters.push(check); check();
      });
      const send = (m) => socket.send(JSON.stringify(m));
      send({ type: 'project.open', projectId });
      const state = await next((m) => m.type === 'project.state');
      return { next, send, state };
    }

    const alice = await login(0, 'rs-a');
    // ---- 1 旧连接上提交一条
    const c1 = await conn(alice);
    const sent = [];
    const notices = [];
    const ds = new DocSync(c1.state.project, { projectId, session: 'rs-page', send: (m) => sent.push(m), saveBackup: () => {}, initialize: false });
    ds.on('notice', (n) => notices.push(n.kind === 'rejected' ? `rejected:${n.reason}` : n.kind));
    ds.connect(); ds.receive(c1.state);
    ds.commit({ ...ds.project, resendProbe: 'v1' });
    const op = sent.find((m) => m.type === 'project.op');
    assert.ok(op);
    c1.send(op);
    const ok1 = await c1.next((m) => m.opId === op.opId);
    assert.equal(ok1.type, 'project.op.ok', JSON.stringify(ok1));
    t.diagnostic(`1 旧连接:${ok1.type} rev ${ok1.rev}`);

    // ---- 2 同一张令牌、另一条连接重发
    const c2 = await conn(alice);
    c2.send(op);
    const r2 = await c2.next((m) => m.opId === op.opId);
    assert.deepEqual([r2.type, r2.rev, r2.duplicate], ['project.op.ok', ok1.rev, true], JSON.stringify(r2));
    t.diagnostic(`2 同一张令牌的新连接重发:${r2.type} rev ${r2.rev} duplicate ${r2.duplicate}`);

    // ---- 3 续令牌(新的凭证号),再开一条连接重发
    const rec = await post('/api/account/editor/recover', { recoveryToken: alice.recovery, deviceId: alice.device, requestId: 'rs-rec-1' });
    assert.equal(rec.status, 200, JSON.stringify(rec.body));
    alice.token = rec.body.accessToken; alice.recovery = rec.body.recoveryToken;
    const c3 = await conn(alice);
    assert.equal(c3.state.rev, ok1.rev);
    c3.send(op);
    const r3 = await c3.next((m) => m.opId === op.opId || m.type === 'error');
    t.diagnostic(`3 续令牌后的新连接重发:${r3.type} ${r3.reason ?? ''} rev ${r3.rev ?? ''} duplicate ${r3.duplicate ?? ''}`);
    assert.deepEqual([r3.type, r3.rev, r3.duplicate], ['project.op.ok', ok1.rev, true], `续令牌后重发被拒:${JSON.stringify(r3)}`);
    const c4 = await conn(alice);
    assert.equal(c4.state.rev, ok1.rev, '内容只落一次,版本没有再前进');
    assert.equal(c4.state.project.resendProbe, 'v1');

    // ---- 4 页面一侧:换连接(handover)之后在新连接上重发,收到这条回包
    assert.equal(ds.canUndo(), true);
    ds.handover(); ds.receive(c3.state);
    const resent = sent.filter((m) => m.type === 'project.op').at(-1);
    ds.receive({ ...r3, opId: resent?.opId ?? op.opId });
    assert.deepEqual(notices, [], '页面没有「被拒」之类的通知');
    assert.equal(ds.unconfirmed, 0);
    assert.equal(ds.canUndo(), true, '撤销步还在');
    assert.equal(ds.project.resendProbe, 'v1');
    t.diagnostic(`4 页面一侧:通知 ${JSON.stringify(notices)},未确认 ${ds.unconfirmed},撤销步还在 ${ds.canUndo()}`);

    // ---- 5 身份里别的部分照旧把关
    c3.send({ ...op, ops: [{ op: 'set', path: '/resendProbe', value: 'other' }] });
    const changed = await c3.next((m) => m.opId === op.opId || m.type === 'error');
    assert.equal(changed.reason, 'operation-id-mismatch', `同一个 opId 换了内容:${JSON.stringify(changed)}`);
    const bob = await login(1, 'rs-b');
    const cb = await conn(bob);
    cb.send(op);
    const other = await cb.next((m) => m.opId === op.opId || m.type === 'error');
    assert.equal(other.reason, 'operation-id-mismatch', `另一个账号拿同一个 opId:${JSON.stringify(other)}`);
    t.diagnostic(`5 同一个 opId 换内容:${changed.type} ${changed.reason};另一个账号同样内容:${other.type} ${other.reason}`);
  } finally {
    for (const s of sockets) s.terminate();
    const state = await fixture.close();
    assert.equal(state.closed, true);
    assert.equal(state.childClosed, true);
  }
});
