import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
const { SyncLink } = await import(srcUrl("editor/sync/link.ts"));
const { createEmptyProject } = await import(srcUrl("kernel/project.ts"));
const { accountConnectionProtocols } = await import(srcUrl("account/client.ts"));
const pause = ms => new Promise(r => setTimeout(r, ms));
function link(protocols, onProtocolError) {
  return new SyncLink({ url: "ws://isolated.invalid", projectId: "room", session: "probe", initial: createEmptyProject("saved-content"),
    protocols, onProtocolError, reconnect: { minMs: 1, maxMs: 3 } });
}
test("可信接口明确拒绝后终止连接，不按网络故障反复认证", async () => {
  let attempts = 0, classified = 0;
  const c = link(async () => { attempts++; throw { status: 410 }; }, e => { classified++; assert.equal(e.status, 410); return true; });
  c.start(); await pause(60);
  assert.equal(attempts, 1); assert.equal(classified, 1); assert.equal(c.connected, false);
  c.start(); await pause(10); assert.equal(attempts, 1);
});
test("暂时取证明失败继续重试，停止后不再重试", async () => {
  let attempts = 0;
  const c = link(async () => { attempts++; throw new TypeError("network"); }, () => false);
  c.start(); await pause(90); c.stop(); const stoppedAt = attempts;
  assert.ok(stoppedAt > 1); await pause(20); assert.equal(attempts, stoppedAt);
});
test("离开后迟到的取证明错误不能修改新页面", async () => {
  let reject, classified = 0;
  const c = link(() => new Promise((_r, no) => { reject = no; }), () => { classified++; return true; });
  c.start(); c.stop(); reject({ status: 410 }); await pause(10);
  assert.equal(classified, 0);
});

test("账号初连和续接保留标准v1与当前票据，实际socket欢迎后发送project.open", async t => {
  const sockets = [];
  class Socket extends EventTarget {
    constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code:1000, reason:'closed' })); }
    welcome(resumed, ack = 0) {
      this.readyState = 1; this.protocol = 'promptcut.v1'; this.dispatchEvent(new Event('open'));
      this.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ type:'session.welcome', sid:'s'.repeat(43), resumed, ack, retainMs:60_000, transport:'ws' }) }));
    }
    drop() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code:1006, reason:'' })); }
  }
  const wait = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await pause(5); } assert.fail('controlled socket did not progress'); };
  let current = { connectionTicket:'a'.repeat(43), assetTicket:'b'.repeat(43), expiresAt:Date.now() + 60_000 }, renewals = 0;
  const c = new SyncLink({ url:'wss://isolated.invalid/hosted/', projectId:'account-room', session:'account-page', initialize:false,
    initial:createEmptyProject('account-entry'), WebSocketImpl:Socket,
    protocols:() => accountConnectionProtocols(current),
    resumeProtocols:async () => { renewals++; current = { ...current, connectionTicket:'c'.repeat(43) }; return accountConnectionProtocols(current); },
    reconnect:{ minMs:1, maxMs:3 } });
  t.after(() => c.stop()); c.start(); await wait(() => sockets.length === 1);
  assert.equal(sockets[0].url, 'wss://isolated.invalid/hosted/');
  assert.deepEqual(sockets[0].protocols, ['promptcut.v1', `promptcut.account.${'a'.repeat(43)}`, 'promptcut.session.new']);
  sockets[0].welcome(false); await wait(() => sockets[0].sent.some(msg => msg.type === 'project.open'));
  const opened = sockets[0].sent.find(msg => msg.type === 'project.open');
  assert.equal(opened.projectId, 'account-room'); assert.equal(opened.seq, 1);
  sockets[0].drop(); await wait(() => sockets.length === 2);
  assert.equal(renewals, 1);
  assert.deepEqual(sockets[1].protocols, ['promptcut.v1', `promptcut.session.${'s'.repeat(43)}.0`, `promptcut.account.${'c'.repeat(43)}`]);
  sockets[1].welcome(true, 1); await pause(5);
  assert.equal(c.connected, true); assert.equal(c.stats().resumes, 1);
  assert.equal(sockets[1].sent.some(msg => msg.type === 'project.open'), false, '接续不重新open或重放已确认消息');
});
