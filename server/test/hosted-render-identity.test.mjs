/**
 * 托管方服务身份：登记表、握手、目录、票据（契约 `docs/plan/hosted-render-contract.md` 第 1.1～1.4、2 节；用例 HR1～HR7、HR9、HR14、HR15）。
 * 跑：npm test -- server/test/hosted-render-identity.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createProject, join, joinStatus, newDevice, adminOp, ask, credential, challenge, proofFor, ticketOf, parseTicket, tamperTicket,
  waitFor, sleep, logText, PROTOCOL, KDF, b64u,
} from './auth-kit.mjs';
import {
  serviceHostFor, serviceProtocolsFor, serviceChallenge, openControl, watchDirectory, requestServiceTicket, openData, outcome,
  fakeUpgrade, serviceItem, enrollService, TICKET_PREFIX, ALL_TYPES,
} from './hosted-render-kit.mjs';
import {
  createServiceRegistry, parseRegistry, readRegistryFile, addServiceKey, retireServiceKey, generateServiceKeyPair, kidOfPublic,
  readServiceKeyFile, buildServiceProtocols, SERVICES_FILE,
} from '../auth/service-identity.mjs';
import { runKeygen, parseKeygenArgs } from '../hosted-render/keygen.mjs';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hr-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function closedWithin(c, ms, what) {
  let timer;
  const e = await Promise.race([
    c.closed,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}：${ms} ms 内没有关闭`)), ms); }),
  ]);
  clearTimeout(timer);
  return { code: e.code, reason: e.reason };
}


// ------------------------------------------------------------------ HR1

test('HR1 登记表：缺文件是空表；坏 JSON、坏服务名、坏 kid、公钥长度不对按空表并记错误；修改时刻变了重读', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'secrets', SERVICES_FILE);
  const logs = [];
  const reg = createServiceRegistry({ file, minCheckMs: 0, log: (event, fields) => logs.push({ event, ...fields }) });
  assert.equal(reg.get('render'), null, '没有文件：空表');
  assert.deepEqual(readRegistryFile(file), { v: 1, services: {} });

  const pair = generateServiceKeyPair();
  assert.equal(pair.kid, kidOfPublic(pair.pub));
  assert.equal(Buffer.from(pair.pub, 'base64url').length, 32);
  assert.equal(addServiceKey(file, { service: 'render', role: 'render', kid: pair.kid, pub: pair.pub }), true);
  assert.equal(addServiceKey(file, { service: 'render', role: 'render', kid: pair.kid, pub: pair.pub }), false, '同一把再加不重复');
  assert.throws(() => addServiceKey(file, { service: 'render', role: 'agent', kid: pair.kid, pub: pair.pub }), (e) => e.code === 'role-conflict');
  assert.equal(reg.get('render')?.role, 'render', '文件出现后重读');
  assert.equal(reg.has('render', pair.kid), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, '登记表 0600');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(pair.priv), '登记表里没有私钥');

  const good = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cases = {
    'v 不对': { ...good, v: 2 },
    '服务名不合格': { v: 1, services: { 'Render!': good.services.render } },
    '角色不合格': { v: 1, services: { render: { ...good.services.render, role: 'admin' } } },
    'kid 与公钥对不上': { v: 1, services: { render: { role: 'render', keys: [{ ...good.services.render.keys[0], kid: 'AAAAAAAA' }] } } },
    '公钥长度不对': { v: 1, services: { render: { role: 'render', keys: [{ kid: pair.kid, alg: 'ed25519', pub: b64u(randomBytes(31)) }] } } },
    '算法不对': { v: 1, services: { render: { role: 'render', keys: [{ ...good.services.render.keys[0], alg: 'rsa' }] } } },
  };
  for (const [what, json] of Object.entries(cases)) assert.throws(() => parseRegistry(json), (e) => e.code === 'bad-services-file', what);

  fs.writeFileSync(file, '{ not json');
  assert.equal(reg.get('render'), null, '坏文件按空表（失败即关）');
  assert.ok(logs.some((l) => l.event === 'services.registry-error'), '记了一条读表错误');

  fs.writeFileSync(file, JSON.stringify(good));
  assert.equal(reg.has('render', pair.kid), true, '修好后重读');
  assert.equal(retireServiceKey(file, { service: 'render', kid: pair.kid }), true);
  assert.equal(retireServiceKey(file, { service: 'render', kid: pair.kid }), false);
  assert.equal(reg.get('render'), null, '撤掉最后一把：服务整项没了');
});

test('HR1 keygen：命令行形状——生成并登记、沿用 instanceId 换钥、撤钥、列表；输出里没有私钥', (t) => {
  const dir = tmp(t);
  const hosted = path.join(dir, 'hosted');
  const secrets = path.join(dir, 'render-secrets');
  assert.throws(() => parseKeygenArgs(['--secrets', secrets]), /--hosted-data/);
  assert.throws(() => parseKeygenArgs(['--hosted-data', hosted]), /--secrets/);
  assert.throws(() => parseKeygenArgs(['--hosted-data', hosted, '--secrets', secrets, '--service', 'custom']), /--role/);
  assert.throws(() => parseKeygenArgs(['--hosted-data', hosted, '--bogus']), /不认识/);

  const a = runKeygen(['--hosted-data', hosted, '--secrets', secrets]);
  assert.deepEqual(Object.keys(a).sort(), ['action', 'actsFor', 'instanceId', 'keyFile', 'kid', 'ok', 'previousKid', 'registry', 'role', 'service']);
  assert.deepEqual([a.ok, a.action, a.service, a.role, a.actsFor, a.previousKid], [true, 'generate', 'render', 'render', 'self', null]);
  assert.equal(a.registry, path.join(hosted, 'secrets', SERVICES_FILE));
  const key = readServiceKeyFile(secrets);
  assert.deepEqual([key.service, key.kid, key.instanceId], ['render', a.kid, a.instanceId]);
  assert.ok(!JSON.stringify(a).includes(key.priv), '输出里没有私钥');
  if (process.platform !== 'win32') assert.equal(fs.statSync(a.keyFile).mode & 0o077, 0, '私钥文件 0600');

  const b = runKeygen(['--hosted-data', hosted, '--secrets', secrets]);
  assert.equal(b.instanceId, a.instanceId, '换钥不换身份');
  assert.equal(b.previousKid, a.kid);
  assert.notEqual(b.kid, a.kid);
  const list = runKeygen(['--hosted-data', hosted, '--list']);
  assert.deepEqual(list.services, { render: { role: 'render', actsFor: 'self', kids: [a.kid, b.kid] } }, '两把公钥并存');

  const r = runKeygen(['--hosted-data', hosted, '--retire', a.kid]);
  assert.deepEqual([r.action, r.removed], ['retire', true]);
  assert.deepEqual(runKeygen(['--hosted-data', hosted, '--list']).services.render.kids, [b.kid]);
  const agent = runKeygen(['--hosted-data', hosted, '--secrets', path.join(dir, 'agent-secrets'), '--service', 'agent', '--instance-name', 'Agent 服务']);
  assert.deepEqual([agent.role, agent.actsFor], ['agent', 'member'], '服务名就是角色名时不用另给 --role；agent 缺省代成员');
  assert.throws(() => runKeygen(['--hosted-data', hosted, '--secrets', path.join(dir, 'agent-secrets'), '--service', 'agent', '--acts-for', 'self']), (e) => e.code === 'role-conflict', '同一个服务的 actsFor 不能变');
  assert.throws(() => parseKeygenArgs(['--hosted-data', hosted, '--secrets', secrets, '--acts-for', 'nobody']), /--acts-for/);
});

test('HR1 撤掉公钥后：在线的控制连接与数据连接都以 4003 service-revoked 关闭，新的握手 401', async (t) => {
  const env = await serviceHostFor(t);
  const key = env.keys.render;
  const proj = await createProject(env, { mode: 'free' });
  const control = await openControl(env, key);
  const data = await openData(env, control, proj.projectId);
  const next = env.enroll({ service: 'render', instanceId: key.instanceId });
  env.tickHosted();
  await sleep(100);
  assert.equal(await outcome(control, { type: 'hosted.watch' }, 'hosted.projects'), 'hosted.projects', '换钥期间两把并存，旧连接不受影响');

  assert.equal(env.retire('render', key.kid), true);
  env.tickHosted();
  assert.deepEqual(await closedWithin(control, 3000, '控制连接'), { code: 4003, reason: 'service-revoked' });
  assert.deepEqual(await closedWithin(data, 3000, '数据连接'), { code: 4003, reason: 'service-revoked' });
  assert.equal((await env.handshake((await serviceProtocolsFor(env, key)).protocols)).status, 401, '旧钥再握手');
  assert.equal((await env.handshake((await serviceProtocolsFor(env, next)).protocols)).status, 101, '新钥照常');
});

// ------------------------------------------------------------------ HR2

test('HR2 服务握手：签名对得到控制身份；签名错、nonce 复用 / 过期 / 绑定不符、kid 或服务名不在表里、并给别的鉴权项都 401', async (t) => {
  const env = await serviceHostFor(t);
  const key = env.keys.render;

  const ok = await serviceProtocolsFor(env, key);
  const c = await env.open(ok.protocols);
  const p = env.principals().find((x) => x.scope === 'service');
  assert.deepEqual(
    { userId: p.userId, tenantId: p.tenantId, scope: p.scope, service: p.service, serviceKid: p.serviceKid, serviceRole: p.serviceRole, deviceId: p.deviceId, deviceName: p.deviceName },
    { userId: 'service:render', tenantId: null, scope: 'service', service: 'render', serviceKid: key.kid, serviceRole: 'render', deviceId: key.instanceId, deviceName: key.instanceName },
  );
  assert.equal(p.role, undefined, '控制身份没有连接角色');
  c.close();

  const status = async (protocols) => (await env.handshake(protocols)).status;
  assert.equal(await status(ok.protocols), 401, 'nonce 只能用一次');

  const badSig = await serviceProtocolsFor(env, key, { mutate: (f) => ({ ...f, m: b64u(randomBytes(64)) }) });
  assert.equal(await status(badSig.protocols), 401, '签名不对');
  const shortSig = await serviceProtocolsFor(env, key, { mutate: (f) => ({ ...f, m: b64u(randomBytes(32)) }) });
  assert.equal(await status(shortSig.protocols), 401, '签名长度不对');

  const other = enrollService(path.join(env.dataDir, 'elsewhere', SERVICES_FILE), { service: 'render', instanceId: key.instanceId });
  assert.equal(await status((await serviceProtocolsFor(env, other)).protocols), 401, 'kid 不在这台的登记表里');
  const ghost = { ...key, service: 'ghost' };
  const ch = await serviceChallenge(env, ghost);
  assert.equal(ch.status, 200, '服务名不在表里也照样回挑战（不暴露有没有这个服务）');
  assert.equal(typeof ch.json.nonce, 'string');
  assert.equal(await status((await serviceProtocolsFor(env, ghost, { nonce: ch.json.nonce })).protocols), 401, '服务名不在表里');

  env.clock.advance(61_000); // 上面已经失败 4 次，再错就进冷却：把限速窗口翻过去
  const moved = await serviceProtocolsFor(env, key, { mutate: (f) => ({ ...f, d: 'another-instance-0001' }) });
  assert.equal(await status(moved.protocols), 401, 'nonce 绑定的 instanceId 不符');

  const late = await serviceProtocolsFor(env, key);
  env.clock.advance(61_000);
  assert.equal(await status(late.protocols), 401, 'nonce 过期');

  const fresh = await serviceProtocolsFor(env, key);
  assert.equal(await status([...fresh.protocols, 'promptcut.token.' + b64u(randomBytes(32))]), 401, '与别的鉴权项并给');
  assert.equal(await status([fresh.protocols[1]]), 401, '没带 promptcut.v1');

  for (const body of [{}, { service: 'Render', deviceId: key.instanceId }, { service: 'render', deviceId: 'short' }]) {
    assert.equal((await env.http('shared/service-challenge', { method: 'POST', body })).status, 400, JSON.stringify(body));
  }
  const reasons = env.logs.filter((l) => l.event === 'auth.reject').map((l) => l.reason);
  for (const r of ['bad-service', 'nonce', 'multiple', 'bad-format']) assert.ok(reasons.includes(r), `日志里有 ${r}：${reasons}`);
});

test('HR2 服务握手失败与口令错同样计入限速：1 分钟内 5 次后这个来源进入冷却，对的也拒', async (t) => {
  const env = await serviceHostFor(t);
  const key = env.keys.render;
  for (let i = 0; i < 5; i += 1) {
    const bad = await serviceProtocolsFor(env, key, { mutate: (f) => ({ ...f, m: b64u(randomBytes(64)) }) });
    assert.equal((await env.handshake(bad.protocols)).status, 401);
  }
  assert.equal((await serviceChallenge(env, key)).status, 429, '冷却期内取不到挑战');
  env.clock.advance(61_000);
  const c = await openControl(env, key);
  assert.equal(await outcome(c, { type: 'hosted.watch' }, 'hosted.projects'), 'hosted.projects', '冷却过后恢复');
});

test('HR2 服务一侧的 buildServiceProtocols 与服务端对得上；shared/verify 认服务握手项', async (t) => {
  const env = await serviceHostFor(t);
  const key = env.keys.render;
  const protocols = await buildServiceProtocols({ base: `ws://127.0.0.1:${env.port}`, key });
  const c = await env.open(protocols);
  assert.equal((await watchDirectory(c)).length, 0);
  const again = await buildServiceProtocols({ base: `http://127.0.0.1:${env.port}/`, key });
  assert.equal((await env.http('shared/verify', { method: 'POST', body: { protocols: again } })).status, 200);
  assert.equal((await env.http('shared/verify', { method: 'POST', body: { protocols: again } })).status, 401, 'verify 也把 nonce 用掉');
});

// ------------------------------------------------------------------ HR3

test('HR3 来源：只认真正从本机发起的连接——带非回环转发头、对端不是回环都 401；与本机信任开关无关；挂载模式一律 401', async (t) => {
  for (const trustLoopback of [false, true]) {
    const env = await serviceHostFor(t, { trustLoopback });
    const key = env.keys.render;
    const attempt = async (reqOptions) => env.authenticate(fakeUpgrade((await serviceProtocolsFor(env, key)).protocols, reqOptions));
    assert.equal((await attempt({}))?.scope, 'service', `trustLoopback=${trustLoopback}：本机直连认`);
    assert.equal((await attempt({ headers: { 'x-forwarded-for': '127.0.0.1' } }))?.scope, 'service', '转发链上全是回环仍算本机');
    for (const headers of [
      { 'x-forwarded-for': '203.0.113.9' },
      { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' },
      { forwarded: 'for=203.0.113.9;proto=https' },
      { 'x-real-ip': '203.0.113.9' },
    ]) {
      assert.equal(await attempt({ headers }), null, `trustLoopback=${trustLoopback}：${JSON.stringify(headers)}`);
    }
    assert.equal(await attempt({ remoteAddress: '203.0.113.9' }), null, '对端不是回环');
    assert.equal(await attempt({ remoteAddress: '10.0.0.5' }), null, '内网地址（nginx 的 proxy_bind）也不是本机');
    assert.ok(env.logs.some((l) => l.event === 'auth.reject' && l.reason === 'service-origin'));
    // 真连接上再验一次：远端来源握手 401
    const p = await serviceProtocolsFor(env, key);
    assert.equal((await env.handshake(p.protocols, '198.51.100.7')).status, 401);
  }

  const lan = await serviceHostFor(t, { attached: true });
  assert.equal((await serviceChallenge(lan, lan.keys.render)).status, 404, '局域网主机没有服务挑战端点');
  const forged = { v: 1, s: 'render', kid: lan.keys.render.kid, d: lan.keys.render.instanceId, dn: 'x', nonce: b64u(randomBytes(32)), m: b64u(randomBytes(64)) };
  assert.equal(lan.authenticate(fakeUpgrade([PROTOCOL, serviceItem(forged)])), null, '局域网主机不认服务握手项');
});

// ------------------------------------------------------------------ HR4

test('HR4 控制身份：逐个发全部数据面与管理面消息都 forbidden；只有目录模块的四种消息过得了白名单', async (t) => {
  const env = await serviceHostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const control = await openControl(env, env.keys.render);
  for (const type of ALL_TYPES) {
    assert.equal(await outcome(control, { type, projectId: proj.projectId, kind: 'asset', kinds: 'all', projects: 'all' }), 'error:forbidden', type);
  }
  assert.equal(await outcome(control, { type: 'hosted.watch' }), 'hosted.projects');
  assert.equal(await outcome(control, { type: 'hosted.ticket', projectId: proj.projectId }), 'hosted.ticket.ok');
  assert.equal(await outcome(control, { type: 'hosted.demand', projectId: proj.projectId }), 'hosted.demand.ok');
  assert.equal(await outcome(control, { type: 'hosted.delegate.verify', delegation: 'x' }), 'error:unsupported', '分发点留给第四段');
  assert.equal(await outcome(control, { type: 'hosted.ticket', projectId: proj.projectId, purpose: 'publish' }), 'error:unsupported', '分发点留给第四段');
  assert.equal(await outcome(control, { type: 'hosted.other' }), 'error:forbidden');
  assert.ok(!env.service.describe().conns.some((c) => c.principal.scope === 'service' && c.principal.tenantId), '控制连接不在任何空间里');

  // 反过来：成员、管理身份发 hosted.* 一律 forbidden
  const member = await join(env, proj, { username: 'mia' });
  for (const type of ['hosted.watch', 'hosted.ticket', 'hosted.demand', 'hosted.delegate.verify']) {
    assert.equal(await outcome(member, { type, projectId: proj.projectId }), 'error:forbidden', `成员发 ${type}`);
  }
});

// ------------------------------------------------------------------ HR5

test('HR5 目录：建项目、成员进出、改开关、删项目各推一条；重新 watch 得到完整清单', async (t) => {
  const env = await serviceHostFor(t, { lingerMs: 60_000 });
  const control = await openControl(env, env.keys.render);
  assert.deepEqual(await watchDirectory(control), []);
  const nextFor = (projectId, pred = () => true) => control.next((m) => m.type === 'hosted.project' && m.projectId === projectId && pred(m), 3000);

  const proj = await createProject(env, { mode: 'free' });
  assert.deepEqual(await nextFor(proj.projectId), { type: 'hosted.project', projectId: proj.projectId, enabled: true, active: false, members: false, hosted: { render: { available: true, enabled: true }, agent: { available: false, enabled: true } } }, '建项目');

  const alice = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  assert.deepEqual(await nextFor(proj.projectId), { type: 'hosted.project', projectId: proj.projectId, enabled: true, active: true, members: true, hosted: { render: { available: true, enabled: true }, agent: { available: false, enabled: true } } }, '成员进来');

  const off = await adminOp(alice, proj, 'set-hosted-service', { service: 'render', enabled: false });
  assert.equal(off.type, 'shared.admin.ok', JSON.stringify(off));
  assert.equal((await nextFor(proj.projectId)).enabled, false, '关开关');
  await adminOp(alice, proj, 'set-hosted-service', { service: 'render', enabled: true });
  assert.equal((await nextFor(proj.projectId)).enabled, true, '再打开');

  alice.close();
  assert.deepEqual(await nextFor(proj.projectId), { type: 'hosted.project', projectId: proj.projectId, enabled: true, active: true, members: false, hosted: { render: { available: true, enabled: true }, agent: { available: false, enabled: true } } }, '成员走了：保持期内仍 active，但 members 已是 false');
  env.clock.advance(59_000);
  env.tickHosted();
  assert.equal((await control.quiet((m) => m.type === 'hosted.project', 150)).length, 0, '59 s：还在保持期');
  env.clock.advance(2_000);
  env.tickHosted();
  assert.equal((await nextFor(proj.projectId)).active, false, '60 s 保持期过后');

  const other = await createProject(env, { mode: 'restricted' });
  await nextFor(other.projectId);
  const full = await watchDirectory(control);
  assert.deepEqual(full.map((p) => p.projectId).sort(), [proj.projectId, other.projectId].sort(), '重新 watch：完整清单');
  assert.ok(full.every((p) => p.enabled === true && p.active === false && p.members === false));

  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  await nextFor(proj.projectId);
  const del = await adminOp(creator, proj, 'delete');
  assert.equal(del.type, 'shared.admin.ok');
  assert.deepEqual(await nextFor(proj.projectId, (m) => m.removed === true), { type: 'hosted.project', projectId: proj.projectId, removed: true }, '删项目');
  assert.deepEqual((await watchDirectory(control)).map((p) => p.projectId), [other.projectId]);
});

test('HR5 active 的判据：服务自己的连接不算；别的托管方服务的连接、别的服务的 hosted.demand 算（没有任何成员在线也 active）', async (t) => {
  const env = await serviceHostFor(t, { services: ['render', 'agent'], lingerMs: 1000 });
  const proj = await createProject(env, { mode: 'free' });
  const render = await openControl(env, env.keys.render);
  const agent = await openControl(env, env.keys.agent);
  const entry = async (c) => (await watchDirectory(c)).find((p) => p.projectId === proj.projectId);
  assert.equal((await entry(render)).active, false);
  assert.deepEqual((await entry(agent)).hosted, { render: { available: true, enabled: true }, agent: { available: true, enabled: true } });
  assert.equal(await outcome(agent, { type: 'hosted.ticket', projectId: proj.projectId }), 'error:unsupported', '代成员的服务的票据由第四段签');

  // 渲染服务自己连进项目：对它自己不算 active（否则永远不会断开）；对 agent 服务算
  const renderData = await openData(env, render, proj.projectId);
  assert.equal((await entry(render)).active, false, '自己的连接不算');
  assert.equal((await entry(agent)).active, true, '别的服务的连接算');
  renderData.close();
  await sleep(150);
  env.clock.advance(1500);
  env.tickHosted();
  assert.equal((await entry(agent)).active, false);

  // agent 服务声明这个项目有活要渲：渲染服务看到 active，agent 自己不受影响；没有成员在线
  const d = await ask(agent, { type: 'hosted.demand', projectId: proj.projectId, holdMs: 30_000 }, 'hosted.demand.ok');
  assert.equal(d.type, 'hosted.demand.ok', JSON.stringify(d));
  assert.equal(d.until - env.clock.now() <= 30_000, true);
  const pushed = await render.next((m) => m.type === 'hosted.project' && m.projectId === proj.projectId && m.active === true, 3000);
  assert.deepEqual([pushed.active, pushed.members], [true, false], '没有成员在线，凭声明 active');
  assert.equal((await entry(agent)).active, false, '声明的服务自己不受影响');
  assert.equal(await outcome(render, { type: 'hosted.demand', projectId: proj.projectId }, 'hosted.demand.ok'), 'hosted.demand.ok');
  assert.equal((await entry(render)).active, true);

  env.clock.advance(31_000);
  env.tickHosted();
  assert.equal((await render.next((m) => m.type === 'hosted.project' && m.projectId === proj.projectId && m.active === false, 3000)).active, false, '声明到期');
  await ask(agent, { type: 'hosted.demand', projectId: proj.projectId, holdMs: 60_000 }, 'hosted.demand.ok');
  assert.equal((await entry(render)).active, true);
  await ask(agent, { type: 'hosted.demand', projectId: proj.projectId, holdMs: 0 }, 'hosted.demand.ok');
  assert.equal((await entry(render)).active, false, 'holdMs: 0 撤回');
  for (const bad of [{ holdMs: -1 }, { holdMs: 600_001 }, { holdMs: 1.5 }, { projectId: 'nope' }]) {
    assert.equal(await outcome(agent, { type: 'hosted.demand', projectId: proj.projectId, ...bad }), 'error:bad-message', JSON.stringify(bad));
  }
  assert.equal(await outcome(agent, { type: 'hosted.demand', projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa' }), 'error:no-project');
  // 声明不绕过开关：渲染节点被关掉的项目，声明之后渲染服务照样要不到票据
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: false });
  await ask(agent, { type: 'hosted.demand', projectId: proj.projectId }, 'hosted.demand.ok');
  assert.equal(await outcome(render, { type: 'hosted.ticket', projectId: proj.projectId }), 'error:service-disabled');
  // enabled 按订阅的服务取：渲染关了，Agent 服务自己的 enabled 仍是 true，但从 hosted 里看得到渲染关了
  const seen = await entry(agent);
  assert.deepEqual([seen.enabled, seen.hosted.render.enabled, seen.hosted.agent.enabled], [true, false, true]);
  assert.equal((await entry(render)).enabled, false);
  await adminOp(creator, proj, 'set-hosted-service', { service: 'agent', enabled: false });
  const seen2 = await entry(agent);
  assert.deepEqual([seen2.enabled, seen2.hosted.agent.enabled], [false, false]);
  assert.deepEqual(env.store.peek(proj.projectId).hosted, { render: { enabled: false }, agent: { enabled: false } }, '两个开关各记各的');
});

// ------------------------------------------------------------------ HR6

test('HR6 hosted.ticket：票据带 sv / sk、角色取登记表、两分钟；项目不存在、开关关着各回原因；conversation / delegation 回 unsupported', async (t) => {
  const env = await serviceHostFor(t);
  const key = env.keys.render;
  const proj = await createProject(env, { mode: 'free' });
  const control = await openControl(env, key);
  const r = await requestServiceTicket(control, proj.projectId);
  assert.equal(r.type, 'hosted.ticket.ok', JSON.stringify(r));
  const body = parseTicket(r.ticket).body;
  assert.deepEqual(
    { k: body.k, p: body.p, u: body.u, r: body.r, sv: body.sv, sk: body.sk, dn: body.dn, ug: body.ug },
    { k: 'conn', p: proj.projectId, u: `service:render@${key.instanceId}`, r: 'render', sv: 'render', sk: key.kid, dn: key.instanceName, ug: 1 },
  );
  assert.equal(body.exp - body.iat, 120_000);
  assert.equal(r.exp, body.exp);
  for (const k of ['c', 'o', 'cr']) assert.equal(k in body, false, `票据里没有 ${k}`);

  assert.equal(await outcome(control, { type: 'hosted.ticket', projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa' }), 'error:no-project');
  assert.equal(await outcome(control, { type: 'hosted.ticket', projectId: 'not-an-id' }), 'error:bad-message');
  assert.equal(await outcome(control, { type: 'hosted.ticket', projectId: proj.projectId, conversation: 1 }), 'error:unsupported');
  assert.equal(await outcome(control, { type: 'hosted.ticket', projectId: proj.projectId, delegation: {} }), 'error:unsupported');

  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: false });
  assert.equal(await outcome(control, { type: 'hosted.ticket', projectId: proj.projectId }), 'error:service-disabled');
  assert.equal((await env.handshake([PROTOCOL, TICKET_PREFIX + r.ticket])).status, 401, '关掉之前签的票据也进不来');

  // 搬迁中的项目
  const moving = await createProject(env, { mode: 'free' });
  env.store.update(moving.projectId, (d) => { d.relocation = { phase: 'fenced', txnId: 'tx-1' }; });
  const out = await outcome(control, { type: 'hosted.ticket', projectId: moving.projectId });
  assert.match(out, /^error:relocat/, out);
});

// ------------------------------------------------------------------ HR7

test('HR7 数据连接：凭 sv 票据进入，身份是 scope: service、角色 render；限定进入的项目不在名单里也能进；成员造不出这种票据', async (t) => {
  const env = await serviceHostFor(t);
  const key = env.keys.render;
  const proj = await createProject(env, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }] });
  const control = await openControl(env, key);
  const data = await openData(env, control, proj.projectId);
  const p = env.principals().find((x) => x.scope === 'service' && x.tenantId === proj.projectId);
  assert.deepEqual(p, {
    userId: `service:render@${key.instanceId}`, tenantId: proj.projectId, scope: 'service', service: 'render', serviceKid: key.kid,
    username: 'service:render', deviceId: key.instanceId, deviceName: key.instanceName, creator: false, role: 'render', conversation: null, owner: null,
  });
  assert.equal(await outcome(data, { type: 'node.hello', nodeId: 'hosted-render:t/1', profile: 'host' }, 'node.welcome'), 'node.welcome', '能报到为渲染节点');

  // 成员的 auth.ticket 签出的票据不带 sv；改负载加上 sv 则签名不对
  const bob = await join(env, proj, { username: 'bob' });
  const conn = await ticketOf(bob, { kind: 'conn', role: 'render', owner: { kind: 'user' } });
  assert.equal('sv' in parseTicket(conn.ticket).body, false);
  const forged = tamperTicket(conn.ticket, { u: `service:render@${key.instanceId}`, sv: 'render', sk: key.kid });
  assert.equal((await env.handshake([PROTOCOL, TICKET_PREFIX + forged])).status, 401, '改过负载的票据');
  assert.equal((await env.handshake([PROTOCOL, TICKET_PREFIX + tamperTicket(data.ticket, { r: 'page' })])).status, 401, '把服务票据的角色改成 page');
  // 票据过期后进不来
  env.clock.advance(121_000 + 30_000);
  assert.equal((await env.handshake([PROTOCOL, TICKET_PREFIX + data.ticket])).status, 401, '两分钟后');
});

// ------------------------------------------------------------------ HR9

test('HR9 保留用户名：建项目、名单、进入挑战（回伪盐）、握手、邀请兑换、kick / unban 都不许用 service: 开头的用户名', async (t) => {
  const env = await serviceHostFor(t);
  const reserved = 'service:render';
  const base = { name: `hr9-${process.pid}`, mode: 'free', kdf: KDF, project: credential('pw') };
  assert.equal((await env.http('shared/create', { method: 'POST', body: { ...base, creator: credential('pw', reserved) } })).status, 400, '创建者名');
  assert.equal((await env.http('shared/create', {
    method: 'POST', body: { name: `hr9b-${process.pid}`, mode: 'restricted', kdf: KDF, creator: credential('pw', 'alice'), list: [credential('pw', 'service:agent')] },
  })).status, 400, '名单项');

  const proj = await createProject(env, { mode: 'free' });
  const dev = newDevice();
  const ch1 = await challenge(env, { projectId: proj.projectId, username: reserved, deviceId: dev.deviceId });
  const ch2 = await challenge(env, { projectId: proj.projectId, username: reserved, deviceId: dev.deviceId });
  assert.equal(ch1.status, 200);
  assert.equal(ch1.json.salt, ch2.json.salt, '同名两次同一个盐');
  const real = await challenge(env, { projectId: proj.projectId, username: 'mia', deviceId: dev.deviceId });
  assert.notEqual(ch1.json.salt, real.json.salt, '是伪盐，不是项目口令的盐');
  // 即使知道项目口令，用保留用户名也进不来（哪怕 deviceId 与服务的 instanceId 相同）
  const sameDevice = { deviceId: env.keys.render.instanceId, deviceName: 'spoof' };
  assert.equal(await joinStatus(env, proj, { username: reserved, device: sameDevice, key: undefined, password: proj.password }), 401, '握手');
  assert.ok(env.logs.some((l) => l.event === 'auth.reject' && l.reason === 'bad-format'));
  assert.ok(!env.principals().some((p) => p.scope === 'member' && String(p.username).startsWith('service:')));

  const restricted = await createProject(env, { mode: 'restricted' });
  const creator = await join(env, restricted, { username: restricted.creator.username, as: 'creator' });
  const setList = await adminOp(creator, restricted, 'set-list', { list: [credential('pw', 'service:render')] });
  assert.deepEqual([setList.type, setList.reason], ['error', 'bad-message'], 'set-list');
  for (const op of ['kick', 'unban']) {
    const r = await adminOp(creator, restricted, op, { username: reserved, deviceId: env.keys.render.instanceId });
    assert.deepEqual([r.type, r.reason], ['error', 'bad-message'], op);
  }
  const redeem = await env.http('shared/invite/redeem', { method: 'POST', body: { code: b64u(randomBytes(32)), username: reserved, deviceId: dev.deviceId } });
  assert.equal(redeem.status, 400, '邀请兑换');
});

// ------------------------------------------------------------------ HR14

test('HR14 日志与错误回包里不出现私钥、签名、nonce、票据原文', async (t) => {
  const env = await serviceHostFor(t);
  const key = env.keys.render;
  const proj = await createProject(env, { mode: 'free' });
  const good = await serviceProtocolsFor(env, key);
  const control = await env.open(good.protocols);
  const data = await openData(env, control, proj.projectId);
  const bad = await serviceProtocolsFor(env, key, { mutate: (f) => ({ ...f, m: b64u(randomBytes(64)) }) });
  await env.handshake(bad.protocols);
  const asset = await ask(data, { type: 'auth.ticket', kind: 'asset', access: 'rw' }, 'auth.ticket.ok');
  const refused = await ask(data, { type: 'auth.ticket', kind: 'conn', role: 'page' });
  const errors = JSON.stringify([refused, await ask(control, { type: 'hosted.ticket', projectId: 'x' })]);
  const text = logText(env);
  const secrets = { 私钥: key.priv, 签名: good.fields.m, 坏签名: bad.fields.m, nonce: good.nonce, 连接票据: data.ticket, 素材票据: asset.ticket };
  for (const [what, value] of Object.entries(secrets)) {
    assert.ok(typeof value === 'string' && value.length > 20, what);
    assert.ok(!text.includes(value), `日志里不该有${what}`);
    assert.ok(!errors.includes(value), `错误回包里不该有${what}`);
  }
  assert.ok(text.includes(key.kid), '日志里可以有公钥编号');
});

// ------------------------------------------------------------------ HR15

test('HR15 旧行为保持：没有登记表时服务握手 401、挑战端点 404、没有目录模块、成员列表没有 hosted；开关操作回 bad-message', async (t) => {
  const env = await serviceHostFor(t, { registry: false });
  assert.equal((await serviceChallenge(env, env.keys.render)).status, 404);
  const forged = { v: 1, s: 'render', kid: env.keys.render.kid, d: env.keys.render.instanceId, dn: 'x', nonce: b64u(randomBytes(32)), m: b64u(randomBytes(64)) };
  assert.equal((await env.handshake([PROTOCOL, serviceItem(forged)])).status, 401);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  assert.equal(await outcome(creator, { type: 'hosted.watch' }), 'error:unsupported', '目录模块没挂');
  const list = await ask(creator, { type: 'shared.members' }, 'shared.members.list');
  assert.equal('hosted' in list, false);
  assert.ok(list.devices.every((d) => !('service' in d)));
  const r = await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: false });
  assert.deepEqual([r.type, r.reason], ['error', 'bad-message']);

  // 登记表在、但里面没有渲染服务：available 为 false，开关操作同样 bad-message
  const empty = await serviceHostFor(t, { services: [] });
  const proj2 = await createProject(empty, { mode: 'free' });
  const c2 = await join(empty, proj2, { username: proj2.creator.username, as: 'creator' });
  const list2 = await ask(c2, { type: 'shared.members' }, 'shared.members.list');
  assert.deepEqual(list2.hosted, { render: { available: false, enabled: true }, agent: { available: false, enabled: true } });
  const r2 = await adminOp(c2, proj2, 'set-hosted-service', { service: 'render', enabled: false });
  assert.deepEqual([r2.type, r2.reason], ['error', 'bad-message']);
});

test('HR15 托管组合：读数据目录下的 secrets/services.json，服务能握手、要票据、进项目；没有这个文件时照常启动', async (t) => {
  const { startHostedCombo, hostedPaths } = await import('../hosted/combo.mjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hr-combo-'));
  const logs = [];
  const combo = await startHostedCombo({
    dataDir, docPort: 0, assetPort: 0, host: '127.0.0.1', trustLoopback: false, clusterToken: b64u(randomBytes(32)),
    log: (event, fields) => logs.push({ event, ...fields }),
  });
  t.after(async () => { await combo.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal(combo.serviceRegistry.get('render'), null, '没有文件：没有服务身份');
  const base = `http://127.0.0.1:${combo.docPort}`;
  const key = enrollService(hostedPaths(dataDir).servicesFile);
  const protocols = await buildServiceProtocols({ base, key });
  const { wsClient } = await import('./fake-ws-kit.mjs');
  const control = wsClient(`ws://127.0.0.1:${combo.docPort}/`, protocols);
  t.after(() => control.close());
  await control.opened;
  assert.deepEqual(await watchDirectory(control), [], '文件出现后不用重启就能握手');
  assert.ok(!JSON.stringify(logs).includes(key.priv));
});
