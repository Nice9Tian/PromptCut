/**
 * 托管方渲染节点的子选项「生成轨道流」：创建者操作 `set-hosted-option`、记录、成员列表、通知
 * （契约 `docs/plan/hosted-render-contract.md` 第 3.1 节；用例前缀 HS：Hosted Streams 入口）。
 * 这一项只记下并通知；渲染服务认领任务时看不看它不在这次范围，所以这里没有认领相关的断言。
 * 跑：npm test -- server/test/hosted-stream-option.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, join, adminOp, ask, members, sleep } from './auth-kit.mjs';
import { serviceHostFor, openControl, openData } from './hosted-render-kit.mjs';
import { hostedStateOf, hostedOptionEnabled, HOSTED_OPTIONS } from '../auth/service-identity.mjs';

const OPTION = (over = {}) => ({ service: 'render', option: 'streams', enabled: false, ...over });
const NOTICE = (enabled) => ({ type: 'shared.notice', event: 'hosted-option-changed', service: 'render', option: 'streams', enabled });
const isOptionNotice = (m) => m.type === 'shared.notice' && m.event === 'hosted-option-changed';

/** 起一个项目：创建者与一位成员各一条页面连接，渲染服务的控制连接与数据连接 */
async function setup(t, options) {
  const env = await serviceHostFor(t, options);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  const member = await join(env, proj, { username: 'mia' });
  const control = await openControl(env, env.keys.render);
  const data = await openData(env, control, proj.projectId);
  return { env, proj, creator, member, control, data };
}

/** 一段时间内没有收到这类消息 */
async function quietFor(c, pred, ms = 600) {
  const got = await c.next(pred, ms).then((m) => m, () => null);
  assert.equal(got, null, `不该收到：${JSON.stringify(got)}`);
}

const hostedOf = async (c) => (await ask(c, { type: 'shared.members' }, 'shared.members.list')).hosted;

test('HS1 纯函数：记录里没有这一项算开；只有渲染节点带 streams，云端 Agent 没有', () => {
  const registry = { get: () => ({}) };
  assert.deepEqual(HOSTED_OPTIONS, { render: ['streams'], agent: [] });
  assert.equal(hostedOptionEnabled(undefined, 'render', 'streams'), true);
  assert.equal(hostedOptionEnabled({}, 'render', 'streams'), true);
  assert.equal(hostedOptionEnabled({ hosted: { render: { enabled: true } } }, 'render', 'streams'), true);
  assert.equal(hostedOptionEnabled({ hosted: { render: { streams: false } } }, 'render', 'streams'), false);
  assert.deepEqual(hostedStateOf(registry, {}), { render: { available: true, enabled: true, streams: true }, agent: { available: true, enabled: true } });
  assert.deepEqual(
    hostedStateOf(registry, { hosted: { render: { enabled: false, streams: false }, agent: { enabled: false } } }),
    { render: { available: true, enabled: false, streams: false }, agent: { available: true, enabled: false } },
    '渲染节点关着与轨道流关着互不影响，各报各的',
  );
  assert.deepEqual(hostedStateOf(null, {}).render, { available: false, enabled: true, streams: true }, '没有登记表：照报，available 为假');
});

test('HS2 创建者能改：落盘、成员列表顶层 hosted.render.streams 跟着变；缺省是开；不加代数；旧字段原样', async (t) => {
  const { env, proj, creator, member } = await setup(t);
  const generation = env.store.peek(proj.projectId).generation;
  assert.deepEqual(await hostedOf(member), { render: { available: true, enabled: true, streams: true }, agent: { available: false, enabled: true } }, '缺省：记录里没有，算开');
  assert.equal(env.store.peek(proj.projectId).hosted, undefined, '没改过就不写记录');

  const off = await adminOp(creator, proj, 'set-hosted-option', OPTION());
  assert.deepEqual([off.type, off.op], ['shared.admin.ok', 'set-hosted-option'], JSON.stringify(off));
  assert.deepEqual(env.store.peek(proj.projectId).hosted, { render: { streams: false } });
  assert.equal(env.store.peek(proj.projectId).generation, generation, '不加代数');
  const list = await ask(member, { type: 'shared.members' }, 'shared.members.list');
  assert.deepEqual(list.hosted.render, { available: true, enabled: true, streams: false }, '旧字段 available、enabled 不变，多一个 streams');
  assert.deepEqual(list.hosted.agent, { available: false, enabled: true }, '云端 Agent 不带 streams');

  const on = await adminOp(creator, proj, 'set-hosted-option', OPTION({ enabled: true }));
  assert.equal(on.type, 'shared.admin.ok');
  assert.deepEqual((await hostedOf(member)).render, { available: true, enabled: true, streams: true });
  assert.equal(await ask(member, { type: 'shared.members' }, 'shared.members.list').then((m) => m.type), 'shared.members.list', '成员连接没断');
});

test('HS3 订阅了成员列表的连接在改完后收到刷新后的列表', async (t) => {
  const { proj, creator, member } = await setup(t);
  await ask(member, { type: 'shared.watch' }, 'shared.members.list');
  await adminOp(creator, proj, 'set-hosted-option', OPTION());
  const pushed = await member.next((m) => m.type === 'shared.members.list' && m.hosted?.render?.streams === false, 3000);
  assert.deepEqual(pushed.hosted.render, { available: true, enabled: true, streams: false });
});

test('HS4 只有创建者：不带证明、证明错、成员（拿不到创建者口令）都被拒，记录不变', async (t) => {
  const { env, proj, creator, member } = await setup(t);
  for (const [what, opts] of [['不带证明', { noProof: true }], ['证明错', { badProof: true }]]) {
    const r = await adminOp(creator, proj, 'set-hosted-option', OPTION(), opts);
    assert.deepEqual([r.type, r.reason], ['error', 'forbidden'], what);
  }
  const byMember = await adminOp(member, proj, 'set-hosted-option', OPTION(), { password: 'wrong-pw' });
  assert.deepEqual([byMember.type, byMember.reason], ['error', 'forbidden'], '成员没有创建者口令');
  assert.equal(env.store.peek(proj.projectId).hosted, undefined, '被拒的操作没有落盘');
  await quietFor(member, isOptionNotice);
});

test('HS5 校验：不认识的 option、不认识的 service、云端 Agent 没有 streams、enabled 不是布尔值，一律 bad-message 且不落盘不通知', async (t) => {
  const { env, proj, creator, member } = await setup(t, { services: ['render', 'agent'] });
  const bad = async (what, fields) => {
    const r = await adminOp(creator, proj, 'set-hosted-option', fields);
    assert.deepEqual([r.type, r.reason], ['error', 'bad-message'], `${what}：${JSON.stringify(r)}`);
  };
  await bad('不认识的 option', OPTION({ option: 'lod' }));
  await bad('不带 option', { service: 'render', enabled: false });
  await bad('option 不是字符串', OPTION({ option: ['streams'] }));
  await bad('原型链上的名字', OPTION({ option: 'constructor' }));
  await bad('不认识的 service', OPTION({ service: 'backup' }));
  await bad('不带 service', { option: 'streams', enabled: false });
  await bad('云端 Agent 没有 streams', OPTION({ service: 'agent' }));
  await bad('enabled 不是布尔值（字符串）', OPTION({ enabled: 'no' }));
  await bad('enabled 不是布尔值（数字）', OPTION({ enabled: 0 }));
  await bad('不带 enabled', { service: 'render', option: 'streams' });
  assert.equal(env.store.peek(proj.projectId).hosted, undefined, '被拒的操作没有落盘');
  await quietFor(member, isOptionNotice);
});

test('HS6 这台文档服务的登记表里没有渲染服务：被拒；放本机（挂载模式）的项目同样被拒，也没有 hosted 字段', async (t) => {
  // 登记表在、但里面没有 render
  const env = await serviceHostFor(t, { services: [] });
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  const r = await adminOp(creator, proj, 'set-hosted-option', OPTION());
  assert.deepEqual([r.type, r.reason], ['error', 'bad-message'], JSON.stringify(r));
  assert.deepEqual((await hostedOf(creator)).render, { available: false, enabled: true, streams: true });
  assert.equal(env.store.peek(proj.projectId).hosted, undefined);

  // 放本机：没有 hostedServices
  const lan = await serviceHostFor(t, { attached: true, trustLoopback: true });
  const made = await lan.http('shared/create', {
    method: 'POST',
    body: {
      name: `hs6-${process.pid}`, mode: 'free', kdf: { alg: 'pbkdf2-sha256', iter: 100_000 },
      creator: (await import('./auth-kit.mjs')).credential('creator-pw', 'alice'), project: (await import('./auth-kit.mjs')).credential('project-pw'),
    },
  });
  assert.equal(made.status, 201, made.text);
  const lanProj = { projectId: made.json.projectId, mode: 'free', creator: { username: 'alice', password: 'creator-pw' }, password: 'project-pw' };
  const host = await join(lan, lanProj, { username: 'alice', as: 'creator', remote: '198.51.100.20' });
  assert.equal('hosted' in (await ask(host, { type: 'shared.members' }, 'shared.members.list')), false);
  const refused = await adminOp(host, lanProj, 'set-hosted-option', OPTION());
  assert.deepEqual([refused.type, refused.reason], ['error', 'bad-message']);
});

test('HS7 两个开关互不冲掉：改渲染节点自己的开关不冲掉 streams，改 streams 不冲掉渲染节点的开关', async (t) => {
  const { env, proj, creator } = await setup(t, { services: ['render', 'agent'] });
  const recordHosted = () => env.store.peek(proj.projectId).hosted;

  assert.equal((await adminOp(creator, proj, 'set-hosted-option', OPTION())).type, 'shared.admin.ok');
  assert.deepEqual(recordHosted(), { render: { streams: false } });

  // 关渲染节点：streams 还在
  assert.equal((await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: false })).type, 'shared.admin.ok');
  assert.deepEqual(recordHosted(), { render: { streams: false, enabled: false } }, '改 enabled 不冲掉 streams');
  assert.deepEqual((await hostedOf(creator)).render, { available: true, enabled: false, streams: false });
  // 渲染节点关着时也能改 streams（界面把它置灰，但服务端不另设限）；enabled 保留
  assert.equal((await adminOp(creator, proj, 'set-hosted-option', OPTION({ enabled: true }))).type, 'shared.admin.ok');
  assert.deepEqual(recordHosted(), { render: { streams: true, enabled: false } }, '改 streams 不冲掉 enabled');
  // 再开渲染节点：streams 还在
  assert.equal((await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: true })).type, 'shared.admin.ok');
  assert.deepEqual(recordHosted(), { render: { streams: true, enabled: true } });

  // 别的服务的开关不受影响
  assert.equal((await adminOp(creator, proj, 'set-hosted-option', OPTION())).type, 'shared.admin.ok');
  assert.equal((await adminOp(creator, proj, 'set-hosted-service', { service: 'agent', enabled: false })).type, 'shared.admin.ok');
  assert.deepEqual(recordHosted(), { render: { streams: false, enabled: true }, agent: { enabled: false } });
});

test('HS8 通知：只发给本空间其余成员连接；不发给发起的那条，也不发给服务自己的连接；打开关闭都发；不断任何连接', async (t) => {
  const { env, proj, creator, member, data, control } = await setup(t);
  const other = await join(env, proj, { username: 'ned' });

  assert.equal((await adminOp(creator, proj, 'set-hosted-option', OPTION())).type, 'shared.admin.ok');
  assert.deepEqual(await member.next(isOptionNotice, 3000), NOTICE(false));
  assert.deepEqual(await other.next(isOptionNotice, 3000), NOTICE(false), '每位其余成员都收到');
  await quietFor(creator, isOptionNotice);
  await quietFor(data, isOptionNotice);
  await quietFor(control, isOptionNotice);

  assert.equal((await adminOp(creator, proj, 'set-hosted-option', OPTION({ enabled: true }))).type, 'shared.admin.ok');
  assert.deepEqual(await member.next(isOptionNotice, 3000), NOTICE(true), '打开时也发（界面决定要不要弹提示）');
  await quietFor(data, isOptionNotice);

  // 没断：渲染服务的数据连接还能用，成员连接还能问
  assert.equal((await members(member)).some((d) => d.service === 'render'), true, '服务那一行还在');
  const dataState = await Promise.race([data.closed.then(() => 'closed'), sleep(300).then(() => 'open')]);
  assert.equal(dataState, 'open', '服务的数据连接没被关');
});

test('HS9 向后兼容：新的通知是新的事件名，旧页面按事件名分支会忽略它；旧的开关通知形状不变', async (t) => {
  const { proj, creator, member } = await setup(t);
  await adminOp(creator, proj, 'set-hosted-option', OPTION());
  const notice = await member.next(isOptionNotice, 3000);
  const OLD_EVENTS = ['password-changed', 'hosted-service-changed'];
  assert.equal(OLD_EVENTS.includes(notice.event), false, '旧页面认的事件名里没有它');
  await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: false });
  assert.deepEqual(await member.next((m) => m.type === 'shared.notice' && m.event === 'hosted-service-changed', 3000),
    { type: 'shared.notice', event: 'hosted-service-changed', service: 'render', enabled: false }, '旧通知不带 option，形状不变');
});
