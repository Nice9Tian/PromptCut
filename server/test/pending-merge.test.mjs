/**
 * 待合并表模块(`server/docservice/modules/pending-merge.mjs`)。跑:npm test -- server/test/pending-merge.test.mjs
 *
 * 语义:`product/document-service.md`「冲突」——每个用户的待合并项按「项目 × 用户」存在文档服务、项目 JSON 之外;
 * 换设备登录同一用户也能继续;点「合并」或「删除选中」后从该用户的表里拿掉;重复提交幂等。
 *
 *   PM-01 按「项目 × 用户」分别存且不混:同一项目的两个用户互相看不见;同一用户在两个项目里是两张表
 *   PM-02 同一用户换设备看到同一张表,表变了另一台设备马上收到
 *   PM-03 独立于项目 JSON:写表不增加项目历史序号、不广播 project.ops
 *   PM-04 拿掉二级项:只拿掉给的属性,拿光了整条拿掉;重复拿掉不报错(幂等)
 *   PM-05 落盘:服务重启后按表恢复
 *   PM-06 消息里自报的用户不认;渲染节点之类的连接不能用;大小限制
 *   PM-07 用户身份的取法(账号项目按账号号、口令项目按用户名、本机空间是 local、服务与 Agent 不能用)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startSharedService, createProject, join, deviceId } from './fake-shared-env.mjs';
import { mergeUserOf, pendingMergeModule, MERGE_LIMITS } from '../docservice/modules/pending-merge.mjs';
import { createMemoryStore } from '../docservice/store/index.mjs';

const thing = (key, props = ['opacity']) => ({ key, source: 'offline', batch: 'b1', baseRev: 3, at: 1, ref: { kind: 'clip', id: key }, change: 'modify', label: key,
  base: null, mine: null, props: props.map((prop) => ({ prop, base: { v: 1 }, mine: { v: 2 } })) });

let reqSeq = 0;
async function ask(c, msg) {
  const reqId = `r${++reqSeq}`;
  c.send({ ...msg, reqId });
  return c.next((m) => m.reqId === reqId);
}

async function member(env, projectId, username, password = 'project-pw', tag = username) {
  const c = await join(env.base, { projectId, username, deviceId: deviceId(tag), password });
  await c.opened;
  return c;
}

test('PM-01 按「项目 × 用户」分别存且不混', async (t) => {
  const env = await startSharedService({ mode: 'hosted' });
  t.after(() => env.close());
  const p1 = await createProject(env.base);
  const p2 = await createProject(env.base);
  const alice = await member(env, p1.projectId, 'alice');
  const bob = await member(env, p1.projectId, 'bob');
  const alice2 = await member(env, p2.projectId, 'alice', 'project-pw', 'alice-p2');

  const put = await ask(alice, { type: 'merge.put', projectId: p1.projectId, things: [thing('offline:clip:c1')] });
  assert.equal(put.type, 'merge.state');
  assert.deepEqual(put.things.map((x) => x.key), ['offline:clip:c1']);
  assert.deepEqual((await ask(bob, { type: 'merge.list', projectId: p1.projectId })).things, [], '同一项目的另一个用户看不见');
  assert.deepEqual((await ask(alice2, { type: 'merge.list', projectId: p2.projectId })).things, [], '同一用户的另一个项目是另一张表');
  await ask(bob, { type: 'merge.put', projectId: p1.projectId, things: [thing('offline:clip:b9')] });
  assert.deepEqual((await ask(alice, { type: 'merge.list', projectId: p1.projectId })).things.map((x) => x.key), ['offline:clip:c1'], 'bob 的不混进 alice 的');
  // 只能碰自己连着的项目
  const cross = await ask(alice2, { type: 'merge.list', projectId: p1.projectId });
  assert.equal(cross.type, 'error');
  for (const c of [alice, bob, alice2]) c.ws.close();
});

test('PM-02 同一用户换设备看到同一张表,表变了另一台马上收到', async (t) => {
  const env = await startSharedService({ mode: 'hosted' });
  t.after(() => env.close());
  const p = await createProject(env.base);
  const pc = await member(env, p.projectId, 'alice', 'project-pw', 'pc');
  const phone = await member(env, p.projectId, 'alice', 'project-pw', 'phone');
  await ask(phone, { type: 'merge.list', projectId: p.projectId });
  await ask(pc, { type: 'merge.put', projectId: p.projectId, things: [thing('offline:clip:c1', ['opacity', '@time'])] });
  const pushed = await phone.next((m) => m.type === 'merge.state' && m.reqId === undefined);
  assert.deepEqual(pushed.things.map((x) => x.key), ['offline:clip:c1']);
  const listed = await ask(phone, { type: 'merge.list', projectId: p.projectId });
  assert.deepEqual(listed.things[0].props.map((x) => x.prop), ['opacity', '@time']);
  pc.ws.close(); phone.ws.close();
});

test('PM-03 独立于项目 JSON:写表不增加历史序号、不广播 project.ops', async (t) => {
  const env = await startSharedService({ mode: 'hosted' });
  t.after(() => env.close());
  const p = await createProject(env.base);
  const a = await member(env, p.projectId, 'alice');
  const b = await member(env, p.projectId, 'bob');
  a.send({ type: 'project.open', projectId: p.projectId });
  const st0 = await a.next((m) => m.type === 'project.state');
  b.send({ type: 'project.open', projectId: p.projectId });
  await b.next((m) => m.type === 'project.state');
  await ask(a, { type: 'merge.put', projectId: p.projectId, things: [thing('offline:clip:c1')] });
  assert.deepEqual(await b.quiet((m) => m.type === 'project.ops' || m.type === 'merge.state'), [], 'bob 什么都收不到');
  a.send({ type: 'project.open', projectId: p.projectId });
  const st1 = await a.next((m) => m.type === 'project.state');
  assert.equal(st1.rev, st0.rev, '历史序号不变');
  assert.equal(JSON.stringify(st1.project ?? null).includes('offline:clip:c1'), false, '项目 JSON 里没有它');
  a.ws.close(); b.ws.close();
});

test('PM-04 拿掉二级项;拿光整条拿掉;重复拿掉幂等', async (t) => {
  const env = await startSharedService({ mode: 'hosted' });
  t.after(() => env.close());
  const p = await createProject(env.base);
  const a = await member(env, p.projectId, 'alice');
  await ask(a, { type: 'merge.put', projectId: p.projectId, things: [thing('k1', ['opacity', 'fadeIn']), thing('k2')] });
  let st = await ask(a, { type: 'merge.remove', projectId: p.projectId, remove: [{ key: 'k1', props: ['opacity'] }] });
  assert.deepEqual(st.things.map((x) => [x.key, x.props.map((y) => y.prop)]), [['k1', ['fadeIn']], ['k2', ['opacity']]]);
  const v = st.version;
  st = await ask(a, { type: 'merge.remove', projectId: p.projectId, remove: [{ key: 'k1', props: ['opacity'] }, { key: 'nope' }] });
  assert.equal(st.version, v, '重复拿掉:不变、不报错');
  st = await ask(a, { type: 'merge.remove', projectId: p.projectId, remove: [{ key: 'k1', props: ['fadeIn'] }, { key: 'k2' }] });
  assert.deepEqual(st.things, []);
  a.ws.close();
});

test('PM-05 落盘:服务重启后按表恢复', async (t) => {
  const env = await startSharedService({ mode: 'hosted' });
  const p = await createProject(env.base);
  const a = await member(env, p.projectId, 'alice');
  await ask(a, { type: 'merge.put', projectId: p.projectId, things: [thing('offline:clip:c1')] });
  a.ws.close();
  await env.close();
  const again = await startSharedService({ mode: 'hosted', dataDir: env.dir });
  t.after(() => again.close());
  const a2 = await member(again, p.projectId, 'alice', 'project-pw', 'alice-again');
  const st = await ask(a2, { type: 'merge.list', projectId: p.projectId });
  assert.deepEqual(st.things.map((x) => x.key), ['offline:clip:c1']);
  a2.ws.close();
});

test('PM-06 自报的用户不认;不能用的连接被拒;大小限制', () => {
  const store = createMemoryStore();
  const mod = pendingMergeModule({ store, now: () => 5 });
  const sent = [];
  const ctx = { send: (connId, m) => sent.push({ connId, m }) };
  mod.connect(ctx, 'c1', { userId: 'alice@d1', username: 'alice', tenantId: 'P', scope: 'member', role: 'page' });
  mod.connect(ctx, 'c2', { userId: 'bob@d2', username: 'bob', tenantId: 'P', scope: 'member', role: 'page' });
  mod.connect(ctx, 'r', { userId: 'service:render@x', tenantId: 'P', role: 'render', service: 'render' });
  mod.handle(ctx, 'c2', { type: 'merge.put', projectId: 'P', user: 'user:alice', things: [thing('x')] });
  mod.handle(ctx, 'c1', { type: 'merge.list', projectId: 'P', reqId: 1 });
  assert.deepEqual(sent.at(-1).m.things, [], '消息里的 user 不认:写进的是 bob 的表');
  mod.handle(ctx, 'r', { type: 'merge.list', projectId: 'P', reqId: 2 });
  assert.equal(sent.at(-1).m.reason, 'forbidden');
  const big = { ...thing('huge'), blob: 'x'.repeat(MERGE_LIMITS.THING_BYTES) };
  mod.handle(ctx, 'c1', { type: 'merge.put', projectId: 'P', things: [big], reqId: 3 });
  assert.equal(sent.at(-1).m.reason, 'too-large');
  mod.handle(ctx, 'c1', { type: 'merge.put', projectId: 'P', things: [{ key: 1 }], reqId: 4 });
  assert.equal(sent.at(-1).m.reason, 'bad-message');
  // 落盘形状:按用户一条记录
  const records = store.read('merges/P');
  assert.deepEqual(records.map((r) => r.user), ['user:bob']);
});

test('PM-07 用户身份:账号按账号号、口令项目按用户名、本机空间 local、服务与 Agent 不能用', () => {
  assert.equal(mergeUserOf({ realm: 'account', identityVersion: 2, accountId: 'acc_1', userId: 'account:acc_1@dev', tenantId: 'P', role: 'page' }), 'account:acc_1');
  assert.equal(mergeUserOf({ userId: 'alice@dev-1', username: 'alice', tenantId: 'P', scope: 'member', role: 'page' }), 'user:alice');
  assert.equal(mergeUserOf({ userId: 'local', tenantId: 'local', scope: 'local', role: 'page' }), 'local');
  assert.equal(mergeUserOf({ userId: 'local', tenantId: 'local', scope: 'local', role: 'agent', conversation: 1 }), null);
  assert.equal(mergeUserOf({ userId: 'alice@dev-1', username: 'alice', tenantId: 'P', scope: 'member', role: 'agent', service: 'agent' }), null);
  assert.equal(mergeUserOf({ scope: 'admin' }), null);
});

test('PM-08 账号项目:按账号号分表(同一账号两台设备同一张表、两个账号不混);账号连接的逐消息权限按「读」核', async () => {
  const { instanceMessageAction } = await import('../account/agent-instance-internal.mjs');
  for (const type of ['merge.list', 'merge.put', 'merge.remove']) assert.equal(instanceMessageAction(type), 'read', `${type} 只要项目的读权限(表是自己的;真改项目走 project.op 另核写权限)`);
  const store = createMemoryStore();
  const mod = pendingMergeModule({ store });
  const sent = [];
  const ctx = { send: (connId, m) => sent.push({ connId, m }) };
  const acct = (accountId, deviceId) => ({ realm: 'account', identityVersion: 2, accountId, userId: `account:${accountId}@${deviceId}`, deviceId,
    loginId: `l-${deviceId}`, credentialId: `c-${deviceId}`, loginGeneration: 1, tenantId: 'ACC', role: 'page' });
  mod.connect(ctx, 'pc', acct('acc_a', 'pc'));
  mod.connect(ctx, 'phone', acct('acc_a', 'phone'));
  mod.connect(ctx, 'other', acct('acc_b', 'x'));
  mod.handle(ctx, 'phone', { type: 'merge.list', projectId: 'ACC', reqId: 1 });
  mod.handle(ctx, 'pc', { type: 'merge.put', projectId: 'ACC', things: [thing('offline:clip:c1')], reqId: 2 });
  assert.deepEqual(sent.find((s) => s.connId === 'phone' && s.m.reqId === undefined)?.m.things.map((t) => t.key), ['offline:clip:c1'], '同一账号的手机马上收到');
  mod.handle(ctx, 'other', { type: 'merge.list', projectId: 'ACC', reqId: 3 });
  assert.deepEqual(sent.at(-1).m.things, [], '另一个账号看不见');
  assert.deepEqual(store.read('merges/ACC').map((r) => r.user), ['account:acc_a']);
});

test('PM-09 到上限:整条不收(不丢最旧的、不收一半),表原样;拿掉一些之后再记照常', () => {
  const store = createMemoryStore();
  const mod = pendingMergeModule({ store, limits: { ...MERGE_LIMITS, THINGS_PER_USER: 2 } });
  const sent = [];
  const ctx = { send: (connId, m) => sent.push(m) };
  mod.connect(ctx, 'c', { userId: 'alice@d', username: 'alice', tenantId: 'P', scope: 'member', role: 'page' });
  mod.handle(ctx, 'c', { type: 'merge.put', projectId: 'P', things: [thing('k1'), thing('k2')], reqId: 1 });
  assert.equal(sent.at(-1).things.length, 2);
  mod.handle(ctx, 'c', { type: 'merge.put', projectId: 'P', things: [thing('k3')], reqId: 2 });
  assert.equal(sent.at(-1).reason, 'too-many', '第三条:拒绝再记');
  mod.handle(ctx, 'c', { type: 'merge.list', projectId: 'P', reqId: 3 });
  assert.deepEqual(sent.at(-1).things.map((t) => t.key), ['k1', 'k2'], '最旧的没被丢、也没收一半');
  mod.handle(ctx, 'c', { type: 'merge.put', projectId: 'P', things: [thing('k2', ['fadeIn'])], reqId: 4 });
  assert.equal(sent.at(-1).type, 'merge.state', '替换已有的一条不算新增,照收');
  mod.handle(ctx, 'c', { type: 'merge.remove', projectId: 'P', remove: [{ key: 'k1' }], reqId: 5 });
  mod.handle(ctx, 'c', { type: 'merge.put', projectId: 'P', things: [thing('k3')], reqId: 6 });
  assert.deepEqual(sent.at(-1).things.map((t) => t.key), ['k2', 'k3']);
  const big = pendingMergeModule({ store: createMemoryStore(), limits: { ...MERGE_LIMITS, USER_BYTES: 600 } });
  big.connect(ctx, 'c', { userId: 'alice@d', username: 'alice', tenantId: 'P', scope: 'member', role: 'page' });
  big.handle(ctx, 'c', { type: 'merge.put', projectId: 'P', things: [thing('a'), thing('b'), thing('c'), thing('d'), thing('e')], reqId: 7 });
  assert.equal(sent.at(-1).reason, 'too-large', '整张表超过大小上限:整条不收');
});
