/**
 * 云端 Agent 的身份与隔离：文档服务与素材服务一侧（契约 `docs/plan/cloud-agent-contract.md` 第 4、5、7.2、16 节，
 * 测试计划第 13.1 节；`docs/plan/auth-contract.md` 第 17 节的 AU16～AU21）。
 *
 * 编号：`CA-AUTH-01～06`（委托的签发与核对、换票据、白名单、只读）、`CA-GRANT-01～03`（对话委托、成员离线后照用、撤销）、
 * `CA-REVOKE-01～03`（四种撤销各自的关闭码与时延、只关这个项目的）、`CA-RENDER-04`（只用来发布的连接）、
 * `CA-SIGN-01`（署名与成员列表）、`CA-OWNER-01`（归属键）、`CA-ASSET-01`（素材）、`CA-LOG-01`（日志不记原文）、
 * `CA-CLIENT-01～02`（服务一侧的客户端小模块）。不依赖 Agent 服务本体：这里的「Agent 服务」是直接拿服务私钥走真握手的测试代码。
 * 跑：npm test -- server/test/cloud-agent-auth.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  createProject, join, adminOp, ask, members, newDevice, parseTicket, tamperTicket, flipSignature, bearer, logText, sleep, waitFor, PROTOCOL,
} from './auth-kit.mjs';
import {
  serviceHostFor, openControl, watchDirectory, requestServiceTicket, outcome, enrollService, TICKET_PREFIX, ALL_TYPES,
} from './hosted-render-kit.mjs';
import { createTcpProxy, snapshotTaskInput } from './fake-ws-kit.mjs';
import { signTicket } from '../auth/tickets.mjs';
import { signDelegation, verifyDelegation, memberAccess, ownerKeyOf, delegationDigest } from '../auth/delegation.mjs';
import { DELEGATION_TTL } from '../auth/protocol.mjs';
import { SERVICE_ALLOW, SERVICE_PUBLISH_ALLOW, AGENT_WRITE_TYPES, CLIP_LIST_KEY_MARKS, serviceGate } from '../docservice/service-gate.mjs';
import { actorOf } from '../docservice/modules/actor.mjs';
import { clipsPlanTaskOf, backfillPlanTaskOf, CLIPS_KEY_MARK, BACKFILL_KEY_MARK } from '../render-queue/messages.mjs';
import { createServiceClient } from '../auth/service-client.mjs';

const DOC = 'doc-1';
const projectBody = (name = 'demo') => ({ id: DOC, name, tracks: [] });
const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

async function closedWithin(c, ms, what) {
  let timer;
  const e = await Promise.race([
    c.closed,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}：${ms} ms 内没有关闭`)), ms); }),
  ]);
  clearTimeout(timer);
  return { code: e.code, reason: e.reason };
}

/** 成员的页面连接要一张委托：不给对话 id 是委托票据，给了是对话委托。回整条回包（可能是 error） */
const delegateOf = (page, conversation, extra = {}) => ask(page, {
  type: 'auth.ticket', kind: 'delegate', audience: 'agent', ...(conversation === undefined ? {} : { conversation }), ...extra,
}, 'auth.ticket.ok');

async function grantOf(page, conversationId) {
  const r = await delegateOf(page, conversationId);
  assert.equal(r.type, 'auth.ticket.ok', `对话委托：${JSON.stringify(r)}`);
  return r.ticket;
}

/** 假 Agent 服务：凭对话委托换票据（回整条回包） */
const exchange = (control, projectId, grant, { conversation = 1, conversationId } = {}) => requestServiceTicket(control, projectId, {
  conversation, conversationId, delegation: grant,
});

/** 换票据并开代成员的数据连接 */
async function openAgent(env, control, projectId, grant, { conversation = 1, conversationId }) {
  const r = await exchange(control, projectId, grant, { conversation, conversationId });
  assert.equal(r.type, 'hosted.ticket.ok', `hosted.ticket：${JSON.stringify(r)}`);
  const c = await env.open([PROTOCOL, TICKET_PREFIX + r.ticket]);
  c.ticket = r.ticket;
  c.reply = r;
  return c;
}

async function openPublish(env, control, projectId) {
  const r = await requestServiceTicket(control, projectId, { purpose: 'publish' });
  assert.equal(r.type, 'hosted.ticket.ok', `发布用的票据：${JSON.stringify(r)}`);
  const c = await env.open([PROTOCOL, TICKET_PREFIX + r.ticket]);
  c.ticket = r.ticket;
  return c;
}

const opOf = (opId, name, session = 's-agent') => ({
  type: 'project.op', projectId: DOC, opId, session, ops: [{ op: 'set', path: '/name', value: name }],
});
const submit = (c, opId, name, session) => ask(c, opOf(opId, name, session), ['project.op.ok', 'project.op.rejected']);
const stateOf = (c) => ask(c, { type: 'project.open', projectId: DOC }, 'project.state');

/** 一个项目、创建者的页面连接（已放好项目内容）、Agent 服务的控制连接 */
async function setup(t, { mode = 'free', services = ['render', 'agent'], list, assets = false } = {}) {
  const env = await serviceHostFor(t, { services, assets });
  const proj = await createProject(env, { mode, ...(list ? { list } : {}) });
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  const init = await ask(creator, { type: 'project.op', projectId: DOC, opId: 'op-init', session: 's-c', ops: [{ op: 'set', path: '', value: projectBody() }] }, ['project.op.ok', 'project.op.rejected']);
  assert.equal(init.type, 'project.op.ok', JSON.stringify(init));
  const control = services.includes('agent') ? await openControl(env, env.keys.agent) : null;
  return { env, proj, creator, control };
}

/** 成员 `username` 用新设备进项目，回页面连接与他的 userId */
async function member(env, proj, username, name = 'Laptop') {
  const device = newDevice(name);
  const page = await join(env, proj, { username, device });
  return { page, device, userId: `${username}@${device.deviceId}` };
}

// ------------------------------------------------------------------ CA-AUTH-01

test('CA-AUTH-01 / AU16 委托的签发：只有成员的页面连接要得到；形状、有效期、acc 由文档服务定；开关关着或没有这个服务回 service-disabled', async (t) => {
  const { env, proj, creator, control } = await setup(t, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }, { username: 'ro', password: 'ro-pw' }] });
  const bob = await member(env, proj, 'bob');
  const rec = () => env.store.peek(proj.projectId);

  // 委托票据：2 分钟，绑成员 × 项目
  const dlg = await delegateOf(bob.page);
  assert.equal(dlg.type, 'auth.ticket.ok', JSON.stringify(dlg));
  const d = parseTicket(dlg.ticket).body;
  assert.deepEqual(Object.keys(d).sort(), ['acc', 'aud', 'dn', 'exp', 'g', 'iat', 'k', 'kid', 'p', 'u', 'ug']);
  assert.deepEqual([d.k, d.p, d.u, d.aud, d.acc, d.dn, d.g, d.ug], ['dlg', proj.projectId, bob.userId, 'agent', 'rw', bob.device.deviceName, rec().generation, 1]);
  assert.equal(d.exp - d.iat, 2 * 60_000);
  assert.equal(dlg.exp, d.exp);
  assert.equal(DELEGATION_TTL.ticket, 2 * 60_000);

  // 对话委托：60 分钟，另绑对话
  const grant = await delegateOf(bob.page, 'conv-A_1');
  const g = parseTicket(grant.ticket).body;
  assert.deepEqual([g.k, g.u, g.cid, g.run, g.acc, g.exp - g.iat], ['dlg', bob.userId, 'conv-A_1', true, 'rw', 60 * 60_000]);
  assert.equal(DELEGATION_TTL.grant, 60 * 60_000);

  // 创建者的带 cr；只读成员的 acc 是 r，页面自己指定不了更高的
  assert.equal(parseTicket((await delegateOf(creator)).ticket).body.cr, true);
  env.store.update(proj.projectId, (x) => { x.readonly = ['ro']; });
  const ro = await member(env, proj, 'ro');
  for (const extra of [{}, { acc: 'rw' }, { access: 'rw' }, { r: 'rw' }]) {
    assert.equal(parseTicket((await delegateOf(ro.page, 'c1', extra)).ticket).body.acc, 'r', JSON.stringify(extra));
  }
  assert.equal(memberAccess(rec(), 'ro'), 'r');
  assert.equal(memberAccess(rec(), 'bob'), 'rw');
  assert.equal(memberAccess({ readonly: [proj.creator.username] }, proj.creator.username, true), 'rw', '以创建者身份进入的恒为读写');

  // 参数不对
  assert.equal(await outcome(bob.page, { type: 'auth.ticket', kind: 'delegate', audience: 'render' }), 'error:bad-message');
  assert.equal(await outcome(bob.page, { type: 'auth.ticket', kind: 'delegate' }), 'error:bad-message');
  for (const bad of ['', 'a b', 'x'.repeat(65), 7, '../x']) {
    assert.equal(await outcome(bob.page, { type: 'auth.ticket', kind: 'delegate', audience: 'agent', conversation: bad }), 'error:bad-message', String(bad));
  }

  // agent、render 角色的成员连接要不到（Agent 不能给自己续命）
  const bobAgent = await join(env, proj, { username: 'bob', device: bob.device, role: 'agent', c: 3 });
  const bobRender = await join(env, proj, { username: 'bob', device: bob.device, role: 'render' });
  assert.equal(await outcome(bobAgent, { type: 'auth.ticket', kind: 'delegate', audience: 'agent' }), 'error:forbidden');
  assert.equal(await outcome(bobRender, { type: 'auth.ticket', kind: 'delegate', audience: 'agent', conversation: 'c1' }), 'error:forbidden');

  // 云端 Agent 自己的连接、发布连接都要不到任何票据
  const cloud = await openAgent(env, control, proj.projectId, grant.ticket, { conversationId: 'conv-A_1' });
  const pub = await openPublish(env, control, proj.projectId);
  for (const c of [cloud, pub]) {
    for (const body of [{ kind: 'delegate', audience: 'agent' }, { kind: 'delegate', audience: 'agent', conversation: 'c1' }, { kind: 'conn', role: 'page' }, { kind: 'asset', access: 'r' }]) {
      assert.equal(await outcome(c, { type: 'auth.ticket', ...body }), 'error:forbidden', JSON.stringify(body));
    }
  }

  // 开关关着：service-disabled；开回来恢复
  assert.equal((await adminOp(creator, proj, 'set-hosted-service', { service: 'agent', enabled: false })).type, 'shared.admin.ok');
  assert.equal(await outcome(bob.page, { type: 'auth.ticket', kind: 'delegate', audience: 'agent' }), 'error:service-disabled');
  assert.equal(await outcome(bob.page, { type: 'auth.ticket', kind: 'delegate', audience: 'agent', conversation: 'c1' }), 'error:service-disabled');
  assert.equal(await outcome(bob.page, { type: 'auth.ticket', kind: 'asset', access: 'r' }, 'auth.ticket.ok'), 'auth.ticket.ok', '成员自己的票据不受影响');
  assert.equal((await adminOp(creator, proj, 'set-hosted-service', { service: 'agent', enabled: true })).type, 'shared.admin.ok');
  assert.equal(await outcome(bob.page, { type: 'auth.ticket', kind: 'delegate', audience: 'agent' }, 'auth.ticket.ok'), 'auth.ticket.ok');

  // 登记表里没有 agent 服务的托管端
  const plain = await setup(t, { services: ['render'] });
  assert.equal(await outcome(plain.creator, { type: 'auth.ticket', kind: 'delegate', audience: 'agent' }), 'error:service-disabled');
});

// ------------------------------------------------------------------ CA-AUTH-02

test('CA-AUTH-02 / AU17 hosted.ticket 的委托分支：票据的 u、ug 是成员的，带 sv、acc；握手得到成员身份加 service、access；别的要法一律拒', async (t) => {
  const { env, proj, creator, control } = await setup(t);
  const other = await createProject(env, { mode: 'free' });
  const bob = await member(env, proj, 'bob');
  const grant = await grantOf(bob.page, 'conv-1');
  const short = (await delegateOf(bob.page)).ticket;

  const r = await exchange(control, proj.projectId, grant, { conversation: 5, conversationId: 'conv-1' });
  assert.equal(r.type, 'hosted.ticket.ok', JSON.stringify(r));
  assert.deepEqual(
    { userId: r.userId, username: r.username, access: r.access, ownerKey: r.ownerKey, conversation: r.conversation, conversationId: r.conversationId },
    { userId: bob.userId, username: 'bob', access: 'rw', ownerKey: `device:${bob.userId}`, conversation: 5, conversationId: 'conv-1' },
  );
  const body = parseTicket(r.ticket).body;
  assert.deepEqual(Object.keys(body).sort(), ['acc', 'c', 'dn', 'exp', 'g', 'iat', 'k', 'kid', 'p', 'r', 'sk', 'sv', 'u', 'ug']);
  assert.deepEqual(
    [body.k, body.p, body.u, body.r, body.c, body.sv, body.sk, body.acc, body.ug, body.exp - body.iat],
    ['conn', proj.projectId, bob.userId, 'agent', 5, 'agent', env.keys.agent.kid, 'rw', 1, 2 * 60_000],
  );

  const conn = await env.open([PROTOCOL, TICKET_PREFIX + r.ticket]);
  assert.deepEqual(env.principals().find((p) => p.service === 'agent' && p.scope === 'member'), {
    userId: bob.userId, tenantId: proj.projectId, scope: 'member', username: 'bob', deviceId: bob.device.deviceId, deviceName: bob.device.deviceName,
    creator: false, role: 'agent', conversation: 5, owner: null, service: 'agent', serviceKid: env.keys.agent.kid, access: 'rw',
  });
  assert.equal((await stateOf(conn)).type, 'project.state');

  // 创建者的委托换出的票据带 cr
  const crGrant = await grantOf(creator, 'conv-c');
  const cr = await exchange(control, proj.projectId, crGrant, { conversationId: 'conv-c' });
  assert.deepEqual([parseTicket(cr.ticket).body.cr, cr.ownerKey], [true, 'creator']);

  // Agent 服务不带委托：只能要发布用的；别的 forbidden
  const reasonOf = async (c, extra) => outcome(c, { type: 'hosted.ticket', projectId: proj.projectId, ...extra });
  assert.equal(await reasonOf(control, {}), 'error:forbidden');
  assert.equal(await reasonOf(control, { conversation: 1, conversationId: 'conv-1' }), 'error:forbidden');
  assert.equal(await reasonOf(control, { purpose: 'read' }), 'error:forbidden');
  assert.equal(await reasonOf(control, { purpose: 'publish', conversation: 1 }), 'error:forbidden');
  assert.equal(await reasonOf(control, { purpose: 'publish', delegation: grant, conversation: 1, conversationId: 'conv-1' }), 'error:forbidden');
  // 短的委托票据换不出；对话、项目对不上换不出；形状不对
  assert.equal(await reasonOf(control, { delegation: short, conversation: 1, conversationId: 'conv-1' }), 'error:not-grant');
  assert.equal(await reasonOf(control, { delegation: grant, conversation: 1, conversationId: 'conv-2' }), 'error:conversation');
  assert.equal(await outcome(control, { type: 'hosted.ticket', projectId: other.projectId, delegation: grant, conversation: 1, conversationId: 'conv-1' }), 'error:project');
  assert.equal(await reasonOf(control, { delegation: grant, conversationId: 'conv-1' }), 'error:bad-message', '没给对话号');
  assert.equal(await reasonOf(control, { delegation: grant, conversation: 0, conversationId: 'conv-1' }), 'error:bad-message');
  assert.equal(await reasonOf(control, { delegation: grant, conversation: 1 }), 'error:bad-message', '没给对话 id');
  assert.equal(await reasonOf(control, { delegation: { ticket: grant }, conversation: 1, conversationId: 'conv-1' }), 'error:bad-message');

  // 渲染服务带委托：forbidden；它也核验不了委托
  const render = await openControl(env, env.keys.render);
  assert.equal(await reasonOf(render, { delegation: grant, conversation: 1, conversationId: 'conv-1' }), 'error:forbidden');
  assert.equal(await outcome(render, { type: 'hosted.delegate.verify', delegation: grant }), 'error:forbidden');

  // 委托不是握手票据：直接拿去握手 401
  for (const tk of [grant, short]) assert.equal((await env.handshake([PROTOCOL, TICKET_PREFIX + tk])).status, 401);
  // 成员的页面连接、Agent 的数据连接都碰不到目录
  for (const c of [bob.page, conn]) {
    assert.equal(await outcome(c, { type: 'hosted.delegate.verify', delegation: grant }), 'error:forbidden');
    assert.equal(await outcome(c, { type: 'hosted.ticket', projectId: proj.projectId, delegation: grant, conversation: 1, conversationId: 'conv-1' }), 'error:forbidden');
  }

  // 核验入口：两种委托都认，回的字段
  const v = await ask(control, { type: 'hosted.delegate.verify', delegation: short }, 'hosted.delegate.ok');
  const { reqId: _r, ...fields } = v;
  assert.deepEqual(fields, {
    type: 'hosted.delegate.ok', projectId: proj.projectId, userId: bob.userId, username: 'bob', deviceId: bob.device.deviceId, deviceName: bob.device.deviceName,
    creator: false, mode: 'free', acc: 'rw', exp: parseTicket(short).body.exp, ownerKey: `device:${bob.userId}`, grant: false,
  });
  const vg = await ask(control, { type: 'hosted.delegate.verify', delegation: grant }, 'hosted.delegate.ok');
  assert.deepEqual([vg.grant, vg.conversationId, vg.exp], [true, 'conv-1', parseTicket(grant).body.exp]);
  assert.equal(await outcome(control, { type: 'hosted.delegate.verify' }), 'error:bad-message');
});

// ------------------------------------------------------------------ CA-AUTH-03

test('CA-AUTH-03 / AU18 伪造、过期、代数变了、受众不对的委托：核验与换票据都拒', async (t) => {
  const { env, proj, creator, control } = await setup(t);
  const other = await createProject(env, { mode: 'free' });
  const bob = await member(env, proj, 'bob');
  const grant = await grantOf(bob.page, 'conv-1');
  const short = (await delegateOf(bob.page)).ticket;
  const verify = (c, delegation) => outcome(c, { type: 'hosted.delegate.verify', delegation }, 'hosted.delegate.ok');
  const swap = (c, delegation, projectId = proj.projectId) => outcome(c, { type: 'hosted.ticket', projectId, delegation, conversation: 1, conversationId: 'conv-1' }, 'hosted.ticket.ok');
  const both = async (delegation, reason, what) => {
    assert.equal(await verify(control, delegation), `error:${reason}`, `核验：${what}`);
    assert.equal(await swap(control, delegation), `error:${reason}`, `换票据：${what}`);
  };
  assert.equal(await verify(control, grant), 'hosted.delegate.ok');

  // 伪造：改签名一个字符、改负载保留原签名、用别的项目的密钥签
  await both(flipSignature(grant), 'signature', '签名改了一个字符');
  await both(tamperTicket(grant, { acc: 'rw', u: `mallory@${newDevice().deviceId}` }), 'signature', '改了负载');
  await both(tamperTicket(grant, { exp: parseTicket(grant).body.exp + 1 }), 'signature', '改了有效期');
  const recA = env.store.peek(proj.projectId);
  const recB = env.store.peek(other.projectId);
  const forged = signDelegation({ ...recA, ticketKey: recB.ticketKey }, { u: bob.userId, aud: 'agent', acc: 'rw', cid: 'conv-1' }, env.clock.now()).ticket;
  await both(forged, 'signature', '别的项目的密钥签的');
  // 乙项目自己签的委托拿到甲项目来：项目对不上
  const foreign = signDelegation(recB, { u: bob.userId, aud: 'agent', acc: 'rw', cid: 'conv-1' }, env.clock.now()).ticket;
  assert.equal(await swap(control, foreign), 'error:project');
  for (const junk of ['', 'x', 'v1.a.b', `v1.${'A'.repeat(3000)}.x`, grant.replace(/^v1/, 'v2')]) await both(junk, 'format', `乱写的 ${junk.slice(0, 12)}`);
  // 连接票据、素材票据不是委托
  const asset = (await ask(bob.page, { type: 'auth.ticket', kind: 'asset', access: 'rw' }, 'auth.ticket.ok')).ticket;
  const conn = (await ask(bob.page, { type: 'auth.ticket', kind: 'conn', role: 'agent', conversation: 1 }, 'auth.ticket.ok')).ticket;
  await both(asset, 'format', '素材票据');
  await both(conn, 'format', '成员自己的连接票据');

  // 受众不对：另一个代成员的服务拿给 agent 的委托来用
  const agent2 = enrollService(env.registryFile, { service: 'agent2', role: 'agent', actsFor: 'member' });
  env.store.update(proj.projectId, (x) => { x.hosted = { ...(x.hosted ?? {}) }; });
  const control2 = await openControl(env, agent2);
  assert.equal(await verify(control2, grant), 'error:audience');
  assert.equal(await swap(control2, grant), 'error:audience');
  assert.equal(verifyDelegation(grant, { lookup: (id) => env.store.peek(id), now: env.clock.now(), audience: 'render' }).reason, 'audience');

  // 过期：委托票据 2 分钟（外加 30 秒时钟偏差），对话委托 60 分钟
  env.clock.advance(2 * 60_000 + 29_000);
  assert.equal(await verify(control, short), 'hosted.delegate.ok', '时钟偏差之内');
  env.clock.advance(2_000);
  assert.equal(await verify(control, short), 'error:expired');
  assert.equal(await verify(control, grant), 'hosted.delegate.ok', '对话委托还没到期');
  env.clock.advance(58 * 60_000);
  await both(grant, 'expired', '对话委托 60 分钟后');

  // 代数变了：改项目口令（项目代数）、踢人（成员代数）
  const fresh = await grantOf(bob.page, 'conv-1');
  const alice = await member(env, proj, 'carol');
  const carolGrant = await grantOf(alice.page, 'conv-1');
  assert.equal((await adminOp(creator, proj, 'kick', { username: 'carol', deviceId: alice.device.deviceId })).type, 'shared.admin.ok');
  await both(carolGrant, 'generation', '被踢成员的委托');
  assert.equal(await verify(control, fresh), 'hosted.delegate.ok', '别人被踢不影响 bob');
  const { credential } = await import('./auth-kit.mjs');
  assert.equal((await adminOp(creator, proj, 'set-password', { project: credential('new-project-pw') })).type, 'shared.admin.ok');
  await both(fresh, 'generation', '改项目口令之后');
});

// ------------------------------------------------------------------ CA-AUTH-04

test('CA-AUTH-04 / AU19 只读成员发起的对话改不了项目：project.op、project.upload 被拒，读与事件照常；连接建立后才改成只读的也拦得住', async (t) => {
  const { env, proj, creator, control } = await setup(t, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }, { username: 'ro', password: 'ro-pw' }] });
  env.store.update(proj.projectId, (x) => { x.readonly = ['ro']; });
  const ro = await member(env, proj, 'ro');
  const bob = await member(env, proj, 'bob');
  const roConn = await openAgent(env, control, proj.projectId, await grantOf(ro.page, 'c-ro'), { conversationId: 'c-ro' });
  const bobConn = await openAgent(env, control, proj.projectId, await grantOf(bob.page, 'c-bob'), { conversation: 2, conversationId: 'c-bob' });
  assert.equal(roConn.reply.access, 'r');
  assert.equal(parseTicket(roConn.ticket).body.acc, 'r');
  assert.equal(env.principals().find((p) => p.service === 'agent' && p.username === 'ro').access, 'r');
  const verified = await ask(control, { type: 'hosted.delegate.verify', delegation: (await delegateOf(ro.page)).ticket }, 'hosted.delegate.ok');
  assert.equal(verified.acc, 'r');

  const before = await stateOf(creator);
  assert.equal((await stateOf(roConn)).type, 'project.state', '只读的能读');
  assert.equal(await outcome(roConn, opOf('op-ro-1', 'hacked')), 'error:forbidden');
  assert.equal(await outcome(roConn, { type: 'project.upload', projectId: DOC, uploadId: 'up-1', index: 0, count: 1, data: JSON.stringify(projectBody('hacked')) }), 'error:forbidden');
  assert.equal(await outcome(roConn, { type: 'content.put', kind: 'card-source', key: 'src/cards/user/x.card.tsx', body: { source: 'x' } }), 'error:forbidden', '内容库写入');
  const ev = await ask(roConn, { type: 'events.create', projectId: DOC, eventId: 'ev-ro-1', session: 's-ro', tool: 'get_project', args: {} });
  assert.notEqual(ev.reason, 'forbidden', `读工具的事件照发：${JSON.stringify(ev)}`);
  const after = await stateOf(creator);
  assert.deepEqual([after.rev, after.project?.name ?? after.state?.name], [before.rev, before.project?.name ?? before.state?.name], '版本号与内容都没变');

  // 读写成员的照常能改
  const ok = await submit(bobConn, 'op-bob-1', 'by-bob');
  assert.equal(ok.type, 'project.op.ok', JSON.stringify(ok));
  // 连接建立之后才被改成只读：下一次提交就被拒（按项目记录此刻的权限判）
  env.store.update(proj.projectId, (x) => { x.readonly = ['ro', 'bob']; });
  assert.equal(await outcome(bobConn, opOf('op-bob-2', 'again')), 'error:forbidden');
  assert.equal((await stateOf(creator)).rev, ok.rev);
  // 票据层的那一道（模块自己也拦）：principal.access 是 r 的连接，白名单与项目模块各拒一次
  const principal = { scope: 'member', service: 'agent', tenantId: proj.projectId, role: 'agent', conversation: 1, access: 'r' };
  for (const type of AGENT_WRITE_TYPES) assert.equal(serviceGate(principal, type, { type }), 'forbidden', type);
  assert.equal(serviceGate({ ...principal, access: 'rw' }, 'project.op', {}), null);
  assert.equal(serviceGate({ ...principal, access: undefined }, 'project.op', {}), 'forbidden', '没写权限的按只读');
});

// ------------------------------------------------------------------ CA-AUTH-05

test('CA-AUTH-05 白名单：代成员的连接只有表里的十种，表外逐个 forbidden；发布连接另一张表', async (t) => {
  assert.deepEqual([...SERVICE_ALLOW.agent].sort(), [
    'events.complete', 'events.create', 'events.text',
    'presence.clear', 'presence.list', 'presence.set',
    'project.close', 'project.op', 'project.open', 'project.upload',
  ]);
  assert.deepEqual({ ...SERVICE_PUBLISH_ALLOW }, { agent: ['publisher.hello', 'task.publish', 'task.unsubscribe'] });
  assert.deepEqual([...AGENT_WRITE_TYPES], ['project.op', 'project.upload']);
  assert.deepEqual([...CLIP_LIST_KEY_MARKS].sort(), [BACKFILL_KEY_MARK, CLIPS_KEY_MARK].sort(), '与队列的标记对拍');

  const { env, proj, control } = await setup(t);
  const bob = await member(env, proj, 'bob');
  const conn = await openAgent(env, control, proj.projectId, await grantOf(bob.page, 'c1'), { conversationId: 'c1' });
  const extra = ['events.list', 'presence.send', 'hosted.watch', 'hosted.ticket', 'hosted.demand', 'hosted.delegate.verify'];
  const outside = [...ALL_TYPES, ...extra].filter((type) => !SERVICE_ALLOW.agent.includes(type));
  for (const must of ['auth.ticket', 'shared.admin', 'shared.members', 'shared.watch', 'shared.challenge', 'node.hello', 'task.claim', 'task.publish',
    'publisher.hello', 'content.put', 'content.get', 'project.snapshot.put', 'project.announce', 'service.announce', 'service.withdraw', 'cost.put']) {
    assert.ok(outside.includes(must), `${must} 在表外`);
  }
  for (const type of outside) {
    assert.equal(await outcome(conn, { type, projectId: DOC, kind: 'asset', kinds: 'all', projects: 'all' }), 'error:forbidden', type);
  }
  // 表里的都不被白名单拒（形状不对由各模块自己回 bad-message，不是 forbidden）
  const samples = {
    'project.open': { projectId: DOC }, 'project.close': { projectId: DOC },
    'project.op': opOf('op-w-1', 'x'), 'project.upload': { projectId: DOC, uploadId: 'up-w', index: 0, count: 2, data: '{' },
    'events.create': { projectId: DOC, eventId: 'ev-1', session: 's', tool: 'get_project', args: {} },
    'events.complete': { projectId: DOC, eventId: 'ev-1', session: 's', status: 'ok' },
    'events.text': { projectId: DOC, eventId: 'ev-2', session: 's', text: 'hi' },
    'presence.set': { projectId: DOC, key: 'agent.scope', data: { clips: [] } }, 'presence.clear': { projectId: DOC, key: 'agent.scope' }, 'presence.list': { projectId: DOC },
  };
  assert.deepEqual(Object.keys(samples).sort(), [...SERVICE_ALLOW.agent].sort());
  for (const [type, fields] of Object.entries(samples)) {
    const r = await ask(conn, { type, ...fields });
    assert.notEqual(r.reason, 'forbidden', `${type}：${JSON.stringify(r)}`);
  }
  // 纯函数：agent 的表只给成员身份的连接；服务自己的身份（没有 purpose）拿不到这张表
  assert.equal(serviceGate({ scope: 'service', service: 'agent', tenantId: proj.projectId, role: 'agent' }, 'project.open', {}), 'forbidden');
  assert.equal(serviceGate({ scope: 'member', service: 'agent', tenantId: proj.projectId, role: 'agent', access: 'rw', purpose: 'publish' }, 'publisher.hello', {}), 'forbidden', '成员身份的连接不能自称发布连接');
});

// ------------------------------------------------------------------ CA-AUTH-06

test('CA-AUTH-06 控制连接：Agent 服务看到的 enabled 是云端 Agent 的开关；被踢成员的委托立刻核验不过', async (t) => {
  const { env, proj, creator, control } = await setup(t);
  const entry = async () => (await watchDirectory(control)).find((p) => p.projectId === proj.projectId);
  assert.deepEqual([(await entry()).enabled, (await entry()).hosted], [true, { render: { available: true, enabled: true }, agent: { available: true, enabled: true } }]);
  // 关渲染的开关：Agent 服务自己的 enabled 不变，hosted.render 变了
  assert.equal((await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: false })).type, 'shared.admin.ok');
  const push = await control.next((m) => m.type === 'hosted.project' && m.projectId === proj.projectId && m.hosted?.render?.enabled === false, 3000);
  assert.deepEqual([push.enabled, push.hosted.agent.enabled], [true, true]);
  // 关云端 Agent 的开关：推 enabled: false
  assert.equal((await adminOp(creator, proj, 'set-hosted-service', { service: 'agent', enabled: false })).type, 'shared.admin.ok');
  const off = await control.next((m) => m.type === 'hosted.project' && m.projectId === proj.projectId && m.enabled === false, 3000);
  assert.equal(off.hosted.agent.enabled, false);
  assert.equal((await adminOp(creator, proj, 'set-hosted-service', { service: 'agent', enabled: true })).type, 'shared.admin.ok');

  // 踢人之后，同一张委托下一次核验就不过（Agent 服务那一侧的 15 秒缓存是它自己的事，文档服务这边当场生效）
  const eve = await member(env, proj, 'eve');
  const dlg = (await delegateOf(eve.page)).ticket;
  assert.equal(await outcome(control, { type: 'hosted.delegate.verify', delegation: dlg }, 'hosted.delegate.ok'), 'hosted.delegate.ok');
  assert.equal((await adminOp(creator, proj, 'kick', { username: 'eve', deviceId: eve.device.deviceId })).type, 'shared.admin.ok');
  assert.equal(await outcome(control, { type: 'hosted.delegate.verify', delegation: dlg }), 'error:generation');
  // 就算代数没变（直接造一张按新代数签的），禁入表也拦
  const rec = env.store.peek(proj.projectId);
  const resigned = signDelegation(rec, { u: eve.userId, aud: 'agent', acc: 'rw' }, env.clock.now()).ticket;
  assert.equal(await outcome(control, { type: 'hosted.delegate.verify', delegation: resigned }), 'error:banned');
});

// ------------------------------------------------------------------ CA-GRANT-01

test('CA-GRANT-01 对话委托绑成员 × 项目 × 对话：别的对话、别的成员、别的项目都换不出这位成员的连接', async (t) => {
  const { env, proj, control } = await setup(t);
  const bob = await member(env, proj, 'bob');
  const eve = await member(env, proj, 'eve');
  const bobGrant = await grantOf(bob.page, 'conv-bob');
  const eveGrant = await grantOf(eve.page, 'conv-eve');
  // 各自的委托换出各自的身份，换不成对方
  const b = await exchange(control, proj.projectId, bobGrant, { conversationId: 'conv-bob' });
  const e = await exchange(control, proj.projectId, eveGrant, { conversationId: 'conv-eve' });
  assert.deepEqual([b.userId, e.userId], [bob.userId, eve.userId]);
  assert.deepEqual([parseTicket(b.ticket).body.u, parseTicket(e.ticket).body.u], [bob.userId, eve.userId]);
  // 拿 eve 的委托去换 bob 的对话：对话对不上；没有任何字段能让 Agent 服务指定「替谁」
  assert.equal((await exchange(control, proj.projectId, eveGrant, { conversationId: 'conv-bob' })).reason, 'conversation');
  const sneaky = await requestServiceTicket(control, proj.projectId, { conversation: 1, conversationId: 'conv-eve', delegation: eveGrant, userId: bob.userId, u: bob.userId, username: 'bob', access: 'rw' });
  assert.equal(sneaky.userId, eve.userId, '消息里自报的身份不认');
  assert.equal(parseTicket(sneaky.ticket).body.u, eve.userId);
});

// ------------------------------------------------------------------ CA-GRANT-02 / CA-SIGN-01

test('CA-GRANT-02 / CA-SIGN-01 成员的连接全断开后，凭对话委托仍能换票据、连上、提交写入；写入身份带 service，成员列表里归在成员那一行', async (t) => {
  const { env, proj, creator, control } = await setup(t);
  const bob = await member(env, proj, 'bob');
  const grant = await grantOf(bob.page, 'conv-1');
  await ask(creator, { type: 'project.open', projectId: DOC }, 'project.state');
  // 成员离线：他的页面连接断开，成员列表里没有他了
  bob.page.close();
  await waitFor(async () => !(await members(creator)).some((d) => d.username === 'bob'), 3000, 'bob 离线');

  const conn = await openAgent(env, control, proj.projectId, grant, { conversation: 4, conversationId: 'conv-1' });
  assert.equal((await stateOf(conn)).type, 'project.state');
  const ok = await submit(conn, 'op-cloud-1', 'by-cloud-agent', 's-cloud');
  assert.equal(ok.type, 'project.op.ok', JSON.stringify(ok));
  // 别的成员收到的广播：署名是 bob 的身份加 service: 'agent'
  const seen = await creator.next((m) => m.type === 'project.ops' && m.opId === 'op-cloud-1', 3000);
  assert.deepEqual(seen.actor, { userId: bob.userId, deviceId: bob.device.deviceId, role: 'agent', conversation: 4, session: 's-cloud', service: 'agent' });
  // 成员列表：归在 bob 那一行里，连接项带 service，不另起一行；bob 自己没有页面在线
  const rows = await members(creator);
  assert.equal(rows.some((d) => 'service' in d), false);
  const row = rows.find((d) => d.username === 'bob');
  assert.deepEqual(row.conns, [{ role: 'agent', conversation: 4, service: 'agent' }]);
  assert.deepEqual(row.tags, { editing: false, rendering: false, agents: 1 });

  // 这条连接断了：拿同一张对话委托再换一张、再连，不需要页面在场
  conn.close();
  await waitFor(async () => !(await members(creator)).some((d) => d.username === 'bob'), 3000, 'Agent 连接断开');
  const again = await openAgent(env, control, proj.projectId, grant, { conversation: 4, conversationId: 'conv-1' });
  assert.equal((await submit(again, 'op-cloud-2', 'again', 's-cloud')).type, 'project.op.ok');

  // 写入身份的形状（纯函数）：成员身份加 service 才带；渲染服务、本机 Agent、页面不带
  assert.deepEqual(actorOf({ userId: 'a@d', deviceId: 'd', role: 'agent', conversation: 1, scope: 'member', service: 'agent' }, 's'), { userId: 'a@d', deviceId: 'd', role: 'agent', conversation: 1, session: 's', service: 'agent' });
  assert.equal('service' in actorOf({ userId: 'service:render@i', deviceId: 'i', role: 'render', scope: 'service', service: 'render' }, 's'), false);
  assert.equal('service' in actorOf({ userId: 'a@d', deviceId: 'd', role: 'agent', conversation: 1, scope: 'member' }, 's'), false);
});

// ------------------------------------------------------------------ CA-REVOKE / CA-GRANT-03

/**
 * 四种撤销共用的骨架：成员离线，Agent 的数据连接与发布连接开着；创建者从自己的连接触发；量到连接被关的时延。
 * 回 `{ closed, ms, pub, env, proj, control, grant, oldTicket }`。
 */
async function revokeCase(t, { mode = 'free', list, trigger }) {
  const { env, proj, creator, control } = await setup(t, { mode, ...(list ? { list } : {}) });
  const bob = await member(env, proj, 'bob');
  const grant = await grantOf(bob.page, 'conv-1');
  const dlg = (await delegateOf(bob.page)).ticket;
  bob.page.close();
  await waitFor(async () => !(await members(creator)).some((d) => d.username === 'bob'), 3000, 'bob 离线');
  const conn = await openAgent(env, control, proj.projectId, grant, { conversationId: 'conv-1' });
  const spare = (await exchange(control, proj.projectId, grant, { conversationId: 'conv-1' })).ticket; // 还没用过、没过期的连接票据
  assert.equal((await submit(conn, 'op-before', 'before')).type, 'project.op.ok');
  const pub = await openPublish(env, control, proj.projectId);
  const at = performance.now();
  const done = trigger({ env, proj, creator, bob });
  const closed = await closedWithin(conn, 2000, 'Agent 的数据连接');
  const ms = performance.now() - at;
  assert.equal((await done).type, 'shared.admin.ok');
  t.diagnostic(`撤销到连接被关：${ms.toFixed(1)} ms（${closed.code} ${closed.reason}）`);
  assert.ok(ms < 2000, `2 秒之内：${ms}`);
  return { env, proj, creator, control, bob, grant, dlg, spare, pub, closed, ms };
}

const swapReason = async (control, projectId, grant) => (await exchange(control, projectId, grant, { conversationId: 'conv-1' })).reason;
const verifyReason = async (control, delegation) => (await ask(control, { type: 'hosted.delegate.verify', delegation }, 'hosted.delegate.ok')).reason;

test('CA-REVOKE-01 / CA-GRANT-03 / AU20 创建者关掉云端 Agent 开关（成员离线）：连接以 4003 service-disabled 关闭，委托当场失效；发布连接同关', async (t) => {
  const r = await revokeCase(t, { trigger: ({ creator, proj }) => adminOp(creator, proj, 'set-hosted-service', { service: 'agent', enabled: false }) });
  assert.deepEqual(r.closed, { code: 4003, reason: 'service-disabled' });
  assert.deepEqual(await closedWithin(r.pub, 2000, '发布连接'), { code: 4003, reason: 'service-disabled' });
  assert.equal(await swapReason(r.control, r.proj.projectId, r.grant), 'service-disabled');
  assert.equal(await verifyReason(r.control, r.dlg), 'service-disabled');
  assert.equal(await verifyReason(r.control, r.grant), 'service-disabled');
  assert.equal((await requestServiceTicket(r.control, r.proj.projectId, { purpose: 'publish' })).reason, 'service-disabled');
  assert.equal((await r.env.handshake([PROTOCOL, TICKET_PREFIX + r.spare])).status, 401, '关之前换好的连接票据也进不来');
  assert.equal((await stateOf(r.creator)).project?.name ?? 'before', 'before');
  // 开回来：同一张对话委托（还没过期）又能用
  assert.equal((await adminOp(r.creator, r.proj, 'set-hosted-service', { service: 'agent', enabled: true })).type, 'shared.admin.ok');
  assert.equal((await exchange(r.control, r.proj.projectId, r.grant, { conversationId: 'conv-1' })).type, 'hosted.ticket.ok');
});

test('CA-REVOKE-02a / CA-GRANT-03 成员被移出名单（成员离线）：连接以 4003 removed 关闭，委托当场失效；发布连接不受影响', async (t) => {
  const r = await revokeCase(t, {
    mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }, { username: 'eve', password: 'eve-pw' }],
    trigger: ({ creator, proj }) => adminOp(creator, proj, 'set-list', { list: [{ username: 'eve', keep: true }] }),
  });
  assert.deepEqual(r.closed, { code: 4003, reason: 'removed' });
  assert.equal(await swapReason(r.control, r.proj.projectId, r.grant), 'generation');
  assert.equal(await verifyReason(r.control, r.dlg), 'generation');
  assert.equal((await r.env.handshake([PROTOCOL, TICKET_PREFIX + r.spare])).status, 401);
  // 就算有一张按新代数签的委托，名单也拦
  const resigned = signDelegation(r.env.store.peek(r.proj.projectId), { u: r.bob.userId, aud: 'agent', acc: 'rw', cid: 'conv-1' }, r.env.clock.now()).ticket;
  assert.equal(await swapReason(r.control, r.proj.projectId, resigned), 'not-listed');
  assert.equal(await outcome(r.pub, { type: 'publisher.hello', publisherId: 'agent:pub' }, 'publisher.welcome'), 'publisher.welcome', '补渲的发布连接照常（改动已经在项目里了）');
  // 渲染服务的连接同理：改名单不关它（它不是成员）
  const render = await openControl(r.env, r.env.keys.render);
  const rt = await requestServiceTicket(render, r.proj.projectId);
  const renderData = await r.env.open([PROTOCOL, TICKET_PREFIX + rt.ticket]);
  assert.equal((await adminOp(r.creator, r.proj, 'set-list', { list: [] })).type, 'shared.admin.ok');
  assert.equal(await outcome(renderData, { type: 'service.watch' }, 'service.endpoints'), 'service.endpoints', '渲染服务的连接没被关');
});

test('CA-REVOKE-02b / CA-GRANT-03 成员被踢（成员离线）：连接以 4003 kicked 关闭，委托当场失效；发布连接不受影响', async (t) => {
  const r = await revokeCase(t, { trigger: ({ creator, proj, bob }) => adminOp(creator, proj, 'kick', { username: 'bob', deviceId: bob.device.deviceId }) });
  assert.deepEqual(r.closed, { code: 4003, reason: 'kicked' });
  assert.equal(await swapReason(r.control, r.proj.projectId, r.grant), 'generation');
  assert.equal(await verifyReason(r.control, r.grant), 'generation');
  assert.equal((await r.env.handshake([PROTOCOL, TICKET_PREFIX + r.spare])).status, 401);
  const resigned = signDelegation(r.env.store.peek(r.proj.projectId), { u: r.bob.userId, aud: 'agent', acc: 'rw', cid: 'conv-1' }, r.env.clock.now()).ticket;
  assert.equal(await swapReason(r.control, r.proj.projectId, resigned), 'banned');
  assert.equal(await outcome(r.pub, { type: 'publisher.hello', publisherId: 'agent:pub' }, 'publisher.welcome'), 'publisher.welcome');
});

test('CA-REVOKE-02c / CA-GRANT-03 项目删除（成员离线）：全部连接以 4004 deleted 关闭，目录推 removed，委托换不出', async (t) => {
  let control0 = null;
  const r = await revokeCase(t, {
    trigger: ({ creator, proj }) => adminOp(creator, proj, 'delete'),
  });
  control0 = r.control;
  assert.deepEqual(r.closed, { code: 4004, reason: 'deleted' });
  assert.deepEqual(await closedWithin(r.pub, 2000, '发布连接'), { code: 4004, reason: 'deleted' });
  assert.equal(await swapReason(control0, r.proj.projectId, r.grant), 'no-project');
  assert.equal(await verifyReason(control0, r.dlg), 'no-project');
  assert.equal((await requestServiceTicket(control0, r.proj.projectId, { purpose: 'publish' })).reason, 'no-project');
  assert.equal((await r.env.handshake([PROTOCOL, TICKET_PREFIX + r.spare])).status, 401);
  assert.equal((await watchDirectory(control0)).some((p) => p.projectId === r.proj.projectId), false);
});

test('CA-REVOKE-03 关开关只停这个项目的：同一位成员在另一个项目的 Agent 连接照常；逐消息也看名单与开关（第二道）', async (t) => {
  const { env, proj, creator, control } = await setup(t);
  const proj2 = await createProject(env, { mode: 'free' });
  const device = newDevice('Laptop');
  const bob1 = await join(env, proj, { username: 'bob', device });
  const bob2 = await join(env, proj2, { username: 'bob', device });
  const conn1 = await openAgent(env, control, proj.projectId, await grantOf(bob1, 'c1'), { conversationId: 'c1' });
  const grant2 = await grantOf(bob2, 'c1');
  const conn2 = await openAgent(env, control, proj2.projectId, grant2, { conversationId: 'c1' });
  assert.equal((await adminOp(creator, proj, 'set-hosted-service', { service: 'agent', enabled: false })).type, 'shared.admin.ok');
  assert.deepEqual(await closedWithin(conn1, 2000, '项目一的 Agent 连接'), { code: 4003, reason: 'service-disabled' });
  assert.equal(await outcome(conn2, { type: 'presence.list', projectId: DOC }, 'presence.state'), 'presence.state', '项目二的连接没断、照常能用');
  assert.equal((await exchange(control, proj2.projectId, grant2, { conversationId: 'c1' })).type, 'hosted.ticket.ok');

  // 第二道：关连接那一下万一漏了，逐消息的核对也拦——直接改记录（不经创建者操作，所以没人去关连接）
  env.store.update(proj2.projectId, (x) => { x.bans = [{ username: 'bob', deviceId: device.deviceId }]; });
  assert.equal(await outcome(conn2, { type: 'presence.list', projectId: DOC }), 'error:banned');
  env.store.update(proj2.projectId, (x) => { x.bans = []; x.hosted = { agent: { enabled: false } }; });
  assert.equal(await outcome(conn2, { type: 'presence.list', projectId: DOC }), 'error:service-disabled');
});

// ------------------------------------------------------------------ CA-RENDER-04

test('CA-RENDER-04 只用来发布的连接：能发带片段清单的计划；细任务、整项目的计划、报到、读写项目与内容库、取票据一律 forbidden；不进成员列表', async (t) => {
  const { env, proj, creator, control } = await setup(t);
  const r = await requestServiceTicket(control, proj.projectId, { purpose: 'publish' });
  assert.equal(r.type, 'hosted.ticket.ok', JSON.stringify(r));
  assert.deepEqual(Object.keys(r).filter((k) => k !== 'reqId').sort(), ['exp', 'ticket', 'type']);
  const body = parseTicket(r.ticket).body;
  assert.deepEqual(Object.keys(body).sort(), ['dn', 'exp', 'g', 'iat', 'k', 'kid', 'p', 'pu', 'r', 'sk', 'sv', 'u', 'ug']);
  assert.deepEqual([body.u, body.r, body.sv, body.pu, body.exp - body.iat], [`service:agent@${env.keys.agent.instanceId}`, 'agent', 'agent', 'publish', 2 * 60_000]);
  const pub = await env.open([PROTOCOL, TICKET_PREFIX + r.ticket]);
  assert.deepEqual(env.principals().find((p) => p.purpose === 'publish'), {
    userId: `service:agent@${env.keys.agent.instanceId}`, tenantId: proj.projectId, scope: 'service', username: 'service:agent',
    deviceId: env.keys.agent.instanceId, deviceName: env.keys.agent.instanceName, creator: false, role: 'agent', conversation: null, owner: null,
    service: 'agent', serviceKid: env.keys.agent.kid, purpose: 'publish',
  });

  assert.equal(await outcome(pub, { type: 'publisher.hello', publisherId: 'agent:pub-1' }, 'publisher.welcome'), 'publisher.welcome');
  const plan = clipsPlanTaskOf({ projectId: DOC, projectRev: 1, clips: ['clip-b', 'clip-a'], codeVersion: 'v-test' });
  const published = await ask(pub, { type: 'task.publish', tasks: [plan] }, 'task.published');
  assert.equal(published.type, 'task.published', JSON.stringify(published));
  const backfill = backfillPlanTaskOf({ projectId: DOC, projectRev: 1, clips: ['clip-a'] });
  assert.equal(await outcome(pub, { type: 'task.publish', tasks: [backfill] }, 'task.published'), 'task.published', '补渲档的清单计划也行');
  const gateOk = await ask(pub, { type: 'task.unsubscribe', ids: [plan.id] });
  assert.notEqual(gateOk.reason, 'forbidden', `撤回自己发的：${JSON.stringify(gateOk)}`);

  // 不许的发布内容
  const fine = snapshotTaskInput({ resultKey: `rk-ca-${Date.now()}`, projectId: DOC });
  const wholePlan = { id: `plan:${DOC}@1`, kind: 'plan', resultKey: `${DOC}@1`, range: null, source: { projectId: DOC, projectRev: 1 }, weight: { class: 'light' }, requires: {} };
  const noClips = { ...plan, input: { clips: [] } };
  const fakeMark = { ...fine, resultKey: `${DOC}@1#clips:abc` };
  for (const [what, tasks] of [['细任务', [fine]], ['整项目的计划', [wholePlan]], ['空清单', [noClips]], ['清单计划夹带细任务', [plan, fine]], ['细任务冒充结果键', [fakeMark]], ['空的 tasks', []], ['不是数组', 'x']]) {
    assert.equal(await outcome(pub, { type: 'task.publish', tasks }), 'error:forbidden', what);
  }
  // 发布以外的一律不行
  const outside = [...ALL_TYPES, 'events.list', 'presence.send', 'hosted.watch', 'hosted.ticket'].filter((type) => !SERVICE_PUBLISH_ALLOW.agent.includes(type));
  for (const must of ['node.hello', 'task.claim', 'queue.watch', 'project.open', 'project.op', 'content.get', 'content.put', 'auth.ticket', 'card.lock', 'events.create']) assert.ok(outside.includes(must), must);
  for (const type of outside) {
    assert.equal(await outcome(pub, { type, projectId: DOC, kind: 'asset', kinds: 'all', projects: 'all', nodeId: 'x', profile: 'host' }), 'error:forbidden', type);
  }
  // 成员列表里没有它
  const rows = await members(creator);
  assert.deepEqual(rows.map((d) => d.username), [proj.creator.username]);
  // 渲染服务这种「以自己的身份」的票据不能带 pu / acc；成员的票据带 pu 也进不来
  const rec = env.store.peek(proj.projectId);
  const at = env.clock.now();
  const status = async (fields) => (await env.handshake([PROTOCOL, TICKET_PREFIX + signTicket(rec, fields, at).ticket])).status;
  assert.equal(await status({ k: 'conn', u: `service:render@${env.keys.render.instanceId}`, r: 'render', sv: 'render', sk: env.keys.render.kid, pu: 'publish' }), 401);
  assert.equal(await status({ k: 'conn', u: `bob@${newDevice().deviceId}`, r: 'agent', c: 1, sv: 'agent', sk: env.keys.agent.kid, pu: 'publish' }), 401);
  assert.equal(await status({ k: 'conn', u: `service:agent@${env.keys.agent.instanceId}`, r: 'agent', sv: 'agent', sk: env.keys.agent.kid }), 401, 'Agent 服务自己的身份不带 pu 进不来');
  assert.equal(await status({ k: 'conn', u: `service:agent@${env.keys.agent.instanceId}`, r: 'agent', sv: 'agent', sk: env.keys.agent.kid, pu: 'publish', acc: 'rw' }), 401);
});

// ------------------------------------------------------------------ CA-OWNER-01

test('CA-OWNER-01 归属键由文档服务算：创建者按「创建者」、限定进入的成员按用户名、自由进入的成员按用户名加设备', async (t) => {
  const { env, proj, creator, control } = await setup(t);
  const owner = async (page) => (await ask(control, { type: 'hosted.delegate.verify', delegation: (await delegateOf(page)).ticket }, 'hosted.delegate.ok')).ownerKey;
  // 自由进入：同一个用户名的两台设备是两个归属
  const b1 = await member(env, proj, 'bob', 'Laptop');
  const b2 = await member(env, proj, 'bob', 'Pad');
  assert.deepEqual([await owner(b1.page), await owner(b2.page)], [`device:${b1.userId}`, `device:${b2.userId}`]);
  assert.equal(await owner(creator), 'creator');
  // 创建者换一台设备以创建者身份进入：同一个归属
  const creator2 = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  assert.equal(await owner(creator2), 'creator');
  // 自由进入里自报创建者同名、但没出示创建者口令的：不是创建者的归属
  const fake = await member(env, proj, proj.creator.username);
  assert.equal(await owner(fake.page), `device:${fake.userId}`);

  // 限定进入：名单成员按用户名，换设备是同一个
  const rproj = await createProject(env, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }] });
  const r1 = await member(env, rproj, 'bob', 'Laptop');
  const r2 = await member(env, rproj, 'bob', 'Pad');
  assert.deepEqual([await owner(r1.page), await owner(r2.page)], ['user:bob', 'user:bob']);
  assert.equal(ownerKeyOf({ mode: 'restricted' }, { username: 'creator', userId: 'creator@d', creator: false }), 'user:creator', '叫 creator 的普通成员与创建者的键不同');
  assert.equal(ownerKeyOf({ mode: 'restricted' }, { username: 'x', userId: 'x@d', creator: true }), 'creator');
});

// ------------------------------------------------------------------ CA-ASSET-01

test('CA-ASSET-01 / AU21 素材：云端 Agent 的连接要不到素材票据；委托当不了素材票据；sv: agent 的素材票据只读、写不进、开关关掉或被踢后当场失效', async (t) => {
  const { env, proj, creator, control } = await setup(t, { assets: true });
  const bob = await member(env, proj, 'bob');
  const grant = await grantOf(bob.page, 'c1');
  const conn = await openAgent(env, control, proj.projectId, grant, { conversationId: 'c1' });
  for (const access of ['r', 'rw']) assert.equal(await outcome(conn, { type: 'auth.ticket', kind: 'asset', access }), 'error:forbidden', access);

  // 成员自己传一件素材
  const rw = (await ask(creator, { type: 'auth.ticket', kind: 'asset', access: 'rw' }, 'auth.ticket.ok')).ticket;
  const bytes = randomBytes(256);
  const hash = sha256hex(bytes);
  const put = (ns, headers, data = bytes, h = hash) => env.asset(`${ns}/${h}/0`, { method: 'PUT', body: data, headers: { 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(data.length), ...headers } });
  assert.equal((await put('media', bearer(rw))).status, 200);
  assert.equal((await env.asset(`media/${hash}/complete`, { method: 'POST', headers: bearer(rw) })).status, 200);
  const read = (ticket) => env.asset(`media/${hash}`, { headers: bearer(ticket) }).then((r) => r.status);

  // 委托、对话委托、Agent 的连接票据都当不了素材票据
  for (const tk of [grant, (await delegateOf(bob.page)).ticket, conn.ticket]) assert.equal(await read(tk), 401);

  // 文档服务不签这种票据；万一有（这里直接用项目密钥造），素材服务的规则也钉死了
  const rec = () => env.store.peek(proj.projectId);
  const forge = (r, u = bob.userId) => signTicket(rec(), { k: 'asset', u, r, sv: 'agent', sk: env.keys.agent.kid }, env.clock.now()).ticket;
  assert.equal(await read(forge('rw')), 401, '读写的 sv: agent 素材票据一律无效');
  const ro = forge('r');
  assert.equal(await read(ro), 200, '只读的能读');
  const other = randomBytes(64);
  for (const ns of ['media', 'snap', 'px']) assert.equal((await put(ns, bearer(ro), other, sha256hex(other))).status, 403, `只读票据写 ${ns}`);
  assert.equal((await env.asset(`media/${hash}`, { method: 'DELETE', headers: bearer(ro) })).status, 405, '素材服务没有删除接口');
  // 关开关：当场失效，不等 15 分钟过期
  assert.equal((await adminOp(creator, proj, 'set-hosted-service', { service: 'agent', enabled: false })).type, 'shared.admin.ok');
  assert.equal(await read(ro), 401);
  assert.equal((await adminOp(creator, proj, 'set-hosted-service', { service: 'agent', enabled: true })).type, 'shared.admin.ok');
  assert.equal(await read(ro), 200);
  // 踢人：旧的（代数）与按新代数造的（禁入表）都无效
  assert.equal((await adminOp(creator, proj, 'kick', { username: 'bob', deviceId: bob.device.deviceId })).type, 'shared.admin.ok');
  assert.equal(await read(ro), 401);
  assert.equal(await read(forge('r')), 401);
  assert.equal(await read(rw), 200, '别的成员自己的票据不受影响');
});

// ------------------------------------------------------------------ CA-LOG-01

test('CA-LOG-01 日志与错误回包里不出现委托、对话委托、票据的原文（只记摘要）', async (t) => {
  const { env, proj, control } = await setup(t);
  const bob = await member(env, proj, 'bob');
  const dlg = (await delegateOf(bob.page)).ticket;
  const grant = await grantOf(bob.page, 'conv-1');
  const conn = await openAgent(env, control, proj.projectId, grant, { conversationId: 'conv-1' });
  const pub = await openPublish(env, control, proj.projectId);
  const bad = flipSignature(grant);
  const errors = JSON.stringify([
    await ask(control, { type: 'hosted.delegate.verify', delegation: bad }),
    await ask(control, { type: 'hosted.ticket', projectId: proj.projectId, delegation: bad, conversation: 1, conversationId: 'conv-1' }),
    await ask(control, { type: 'hosted.ticket', projectId: proj.projectId, delegation: dlg, conversation: 1, conversationId: 'conv-1' }),
    await ask(conn, { type: 'auth.ticket', kind: 'delegate', audience: 'agent' }),
  ]);
  await env.handshake([PROTOCOL, TICKET_PREFIX + grant]);
  const text = logText(env);
  const secrets = { 委托票据: dlg, 对话委托: grant, 坏的对话委托: bad, 代成员的连接票据: conn.ticket, 发布用的票据: pub.ticket, 服务私钥: env.keys.agent.priv };
  for (const [what, value] of Object.entries(secrets)) {
    assert.ok(typeof value === 'string' && value.length > 20, what);
    assert.ok(!text.includes(value), `日志里不该有${what}`);
    assert.ok(!errors.includes(value), `错误回包里不该有${what}`);
    // 负载段、签名段单独出现也不行
    for (const seg of value.split('.').filter((s) => s.length > 20)) assert.ok(!text.includes(seg), `日志里不该有${what}的片段`);
  }
  assert.ok(text.includes(delegationDigest(bad)), '被拒的委托记的是摘要');
  assert.ok(text.includes('"event":"hosted.ticket"') && text.includes('"event":"shared.delegate"'), '签发有记录');
  assert.equal(delegationDigest(grant).length, 8);
});

// ------------------------------------------------------------------ CA-CLIENT

const clientKey = (k) => ({ service: k.service, kid: k.kid, priv: k.priv, instanceId: k.instanceId, instanceName: k.instanceName });

test('CA-CLIENT-01 服务一侧的客户端：握手、目录、核验、换票据、发布用的票据、给数据连接的子协议；回包的 error 原样带回', async (t) => {
  const { env, proj, creator } = await setup(t);
  const logs = [];
  const client = createServiceClient({ base: `ws://127.0.0.1:${env.port}`, key: clientKey(env.keys.agent), log: (event, fields) => logs.push({ event, ...fields }) });
  t.after(() => client.close());
  assert.deepEqual(await client.verifyDelegation('x'), { ok: false, reason: 'unavailable' }, '没连上时立刻回，不排队');
  await client.ready();
  assert.equal(client.connected, true);
  assert.deepEqual([client.service, client.instanceId], ['agent', env.keys.agent.instanceId]);

  const seen = { full: [], changes: [] };
  const w = await client.watch({ onProjects: (list) => seen.full.push(list), onProject: (item) => seen.changes.push(item) });
  assert.equal(w.ok, true);
  assert.deepEqual(seen.full[0].map((p) => p.projectId), [proj.projectId]);
  const proj2 = await createProject(env, { mode: 'free' });
  await waitFor(() => seen.changes.some((p) => p.projectId === proj2.projectId), 3000, '目录推送');

  const bob = await member(env, proj, 'bob');
  const dlg = (await delegateOf(bob.page)).ticket;
  const grant = await grantOf(bob.page, 'conv-1');
  const who = await client.verifyDelegation(dlg);
  assert.deepEqual([who.ok, who.projectId, who.userId, who.username, who.acc, who.ownerKey, who.grant], [true, proj.projectId, bob.userId, 'bob', 'rw', `device:${bob.userId}`, false]);
  assert.deepEqual(await client.verifyDelegation(flipSignature(dlg)), { ok: false, reason: 'signature' });

  const tk = await client.memberTicket({ projectId: proj.projectId, conversation: 2, conversationId: 'conv-1', delegation: grant });
  assert.deepEqual([tk.ok, tk.userId, tk.access, tk.conversation], [true, bob.userId, 'rw', 2]);
  const data = await env.open(client.dataProtocols(tk.ticket));
  assert.equal((await submit(data, 'op-client-1', 'via-client')).type, 'project.op.ok');
  assert.deepEqual(await client.memberTicket({ projectId: proj.projectId, conversation: 2, conversationId: 'other', delegation: grant }), { ok: false, reason: 'conversation' });
  assert.deepEqual(await client.serviceTicket(proj.projectId), { ok: false, reason: 'forbidden' }, 'Agent 服务没有「服务自己进项目」');

  // 给 doc-link 用的 protocolsFor：每次调用都现换
  const protocolsFor = client.protocolsForConversation({ projectId: proj.projectId, conversationId: 'conv-1', delegation: () => grant });
  const p1 = await protocolsFor(3);
  const p2 = await protocolsFor(3);
  assert.deepEqual([p1.length, p1[0], p1[1].startsWith(TICKET_PREFIX)], [2, PROTOCOL, true]);
  assert.equal(parseTicket(p1[1].slice(TICKET_PREFIX.length)).body.c, 3);
  assert.ok((await env.handshake(p2)).status === 101);
  assert.equal((await adminOp(creator, proj, 'set-hosted-service', { service: 'agent', enabled: false })).type, 'shared.admin.ok');
  await assert.rejects(() => protocolsFor(3), (err) => err.code === 'service-disabled');
  assert.equal((await adminOp(creator, proj, 'set-hosted-service', { service: 'agent', enabled: true })).type, 'shared.admin.ok');

  const pubTicket = await client.publishTicket(proj.projectId);
  assert.equal(pubTicket.ok, true);
  const pub = await env.open(client.dataProtocols(pubTicket.ticket));
  assert.equal(await outcome(pub, { type: 'publisher.hello', publisherId: 'agent:pub' }, 'publisher.welcome'), 'publisher.welcome');
  const d = await client.demand(proj.projectId, 5000);
  assert.deepEqual([d.ok, d.projectId], [true, proj.projectId]);

  // 客户端自己的日志里没有私钥、委托、票据
  const text = JSON.stringify(logs);
  for (const secret of [env.keys.agent.priv, dlg, grant, tk.ticket, pubTicket.ticket]) assert.ok(!text.includes(secret));
  client.close();
  assert.deepEqual(await client.verifyDelegation(dlg), { ok: false, reason: 'closed' });
});

test('CA-CLIENT-02 控制连接断了：进行中的请求与之后的请求回 unavailable，按退避重连，目录自动重订；公钥被撤后连不上', async (t) => {
  const { env, proj } = await setup(t);
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const states = [];
  const client = createServiceClient({ base: `http://127.0.0.1:${proxy.port}`, key: clientKey(env.keys.agent), reconnectMs: [20, 40] });
  t.after(() => client.close());
  client.onState((s) => states.push(s));
  await client.ready();
  const full = [];
  await client.watch({ onProjects: (list) => full.push(list.map((p) => p.projectId)) });
  assert.deepEqual(full, [[proj.projectId]]);

  proxy.cutAll();
  await waitFor(() => states.includes('down'), 3000, '断开');
  await waitFor(() => client.connected && full.length === 2, 5000, '重连并重订目录');
  assert.deepEqual(states.slice(0, 3), ['up', 'down', 'up']);
  assert.deepEqual(full[1], [proj.projectId]);
  assert.equal((await client.publishTicket(proj.projectId)).ok, true, '重连后照常能用');

  // 撤掉公钥：文档服务关控制连接（4003 service-revoked），之后握手不过，请求回 unavailable
  env.retire('agent', env.keys.agent.kid);
  env.tickHosted();
  await waitFor(() => states.filter((s) => s === 'down').length === 2, 3000, '被撤之后断开');
  await sleep(150);
  assert.equal(client.connected, false);
  assert.deepEqual(await client.publishTicket(proj.projectId), { ok: false, reason: 'unavailable' });
  await assert.rejects(() => client.ready());
});
