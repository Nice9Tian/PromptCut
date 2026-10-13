/**
 * 0.7.18 逐项验收「本地项目回归」(account-binding-task.md「逐项验收」表,编号 2.1-6)补的一条测试:
 * 「账号模式开着」的时候,本地(局域网主机)共享项目照旧不要账号,旧的进入/权限/邀请码/主机成员行为不退步。
 *
 * 做法:同一个进程里同时开着
 *   (1) 账号模式的托管文档服务(`createSharedDocService({ mode: 'hosted', accountRuntime })` + 账号账本),这是云端项目的入口;
 *   (2) 本机局域网主机(`startHost({ attached: true })`,与桌面版编辑器里 vite-plugin-docservice 同一个 `mode: 'lan'` 组装),
 *       本地共享项目放在这上面。
 * 然后在 (2) 上走一遍:自由进入、限定进入、邀请码签发-解析-兑换-作废、创建者操作、主机/成员列表、踢人与解禁、局域网来源进入——
 * 全程不带任何账号令牌。并核对两边互不相通:云端拒收口令式项目(account-required)与口令式握手;本地主机不认账号票据。
 *
 * 局域网发现(UDP 组播)、隔离中继不在这里重做:它们各有现成测试(sp-lan、asset-lan-discover、reopen-hosting),地图里逐条指过去。
 *
 * 跑:npm test -- server/test/accept-018-files-local-regression.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountHostedRuntime } from '../docservice/account-hosted.mjs';
import { mountAccountProjects } from '../docservice/modules/account-projects.mjs';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import {
  startHost, createProject, join, joinStatus, newDevice, adminOp, members, credential, rawHandshake, PROTOCOL,
} from './auth-kit.mjs';
import { resolveInvite, redeemInvite } from './c10a-kit.mjs';

const A = 'acc_' + 'a'.repeat(24);
const LAN_PEER = (i) => `192.168.1.${40 + i}`; // 局域网来源(私有地址),不是回环

/** 起账号模式的托管文档服务(只绑回环、端口 0)。返回 { origin, port, doc, runtime, authority, close } */
async function accountModeOn(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-accept-018-files-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'accept-018-files' });
  const accountClient = {
    verify: async (token) => {
      if (token !== 'tok-a') throw Object.assign(new Error('login-required'), { status: 401, code: 'login-required' });
      return { accountId: A, accountName: 'Alice', loginId: 'login-a', credentialId: 'cred-a', loginGeneration: 1,
        expiresAt: Date.now() + 3_600_000, accountEventSeq: 0, kind: 'editor' };
    },
    events: async () => ({ events: [], headSeq: 0 }),
  };
  const runtime = createAccountHostedRuntime({ ledger, accountClient, dataDir: path.join(dir, 'docservice'),
    authorityUrl: 'https://fixture.invalid', allowFixtureAssetReady: true, pollMs: 0 });
  await runtime.start();
  const accountProjects = mountAccountProjects({ authority: runtime.authority,
    issueSession: input => runtime.issueSession(input), resolveAssetTicket: ticket => runtime.resolveAssetTicket(ticket) });
  const doc = createSharedDocService({ mode: 'hosted', dataDir: path.join(dir, 'docservice'), accountRuntime: runtime, accountProjects,
    trustLoopback: false, service: { autoTick: false }, log: () => {} });
  const addr = await doc.service.listen(0, '127.0.0.1');
  const env = { origin: `http://127.0.0.1:${addr.port}`, port: addr.port, doc, runtime, authority: runtime.authority };
  t.after(async () => {
    await doc.service.close(); runtime.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return env;
}

/** 账号模式开着,并在其中建一个云端账号项目(证明账号系统是真的在工作,不是空壳) */
async function accountModeWithProject(t) {
  const cloud = await accountModeOn(t);
  const health = await fetch(`${cloud.origin}/healthz`).then(r => r.json());
  assert.equal(health.accountMode, 'v2', '云端文档服务确实处在账号模式');
  const created = await cloud.authority.createProject({ accessToken: 'tok-a' },
    { name: 'cloud-neighbour', requestId: 'create-neighbour', initialProject: { tracks: [] } });
  assert.match(created.projectId, /^sp_[a-z2-7]{26}$/);
  return { ...cloud, accountProjectId: created.projectId };
}

test('ACC018-LOCAL-1 账号模式开着:本地自由进入(局域网主机)——不带任何账号令牌,项目口令对才进,创建者口令才是创建者', async (t) => {
  const cloud = await accountModeWithProject(t);
  const env = await startHost({ attached: true }); t.after(() => env.close());
  const proj = await createProject(env, { mode: 'free', password: 'free-pw' });
  assert.match(proj.projectId, /^sp_[a-z2-7]{26}$/);
  assert.notEqual(proj.projectId, cloud.accountProjectId);
  // 局域网来源的成员凭项目口令进,同名不同设备各自一行
  const devA = newDevice('Laptop'), devB = newDevice('Phone');
  const zoeA = await join(env, proj, { username: 'zoe', device: devA, remote: LAN_PEER(1) });
  const zoeB = await join(env, proj, { username: 'zoe', device: devB, remote: LAN_PEER(2) });
  const principals = env.principals().filter(p => p.tenantId === proj.projectId);
  assert.ok(principals.length >= 2);
  for (const p of principals) {
    assert.notEqual(p.realm, 'account', '本地项目的连接不是账号身份');
    assert.equal(p.accountId, undefined);
  }
  assert.equal(await joinStatus(env, proj, { username: 'zoe', password: 'wrong-pw', remote: LAN_PEER(3) }), 401, '口令错 401');
  // 创建者:创建者口令 → creator;项目口令当创建者用 → 401
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: LAN_PEER(4) });
  assert.equal(env.principals().find(p => p.username === 'alice' && p.tenantId === proj.projectId)?.creator, true);
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', password: 'free-pw', remote: LAN_PEER(5) }), 401);
  assert.equal(creator.ws.readyState, 1); assert.equal(zoeA.ws.readyState, 1); assert.equal(zoeB.ws.readyState, 1);
  // 局域网主机仍只让本机创建项目:局域网来源建项目 403
  const lanCreate = await env.http('shared/create', { method: 'POST', remote: LAN_PEER(6),
    body: { name: 'lan-origin-create', mode: 'free', kdf: { alg: 'pbkdf2-sha256', iter: 100_000 }, creator: credential('x', 'mallory'), project: credential('y') } });
  assert.equal(lanCreate.status, 403, '局域网主机只许本机回环建项目(旧规矩不退步)');
});

test('ACC018-LOCAL-2 账号模式开着:本地限定进入(名单)——名单内口令对才进,名单外 401,创建者自动在名单里,移出名单立即断开', async (t) => {
  await accountModeWithProject(t);
  const env = await startHost({ attached: true }); t.after(() => env.close());
  const proj = await createProject(env, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }, { username: 'cara', password: 'cara-pw' }] });
  const bob = await join(env, proj, { username: 'bob', remote: LAN_PEER(11) });
  assert.equal(await joinStatus(env, proj, { username: 'bob', password: 'not-bob', remote: LAN_PEER(12) }), 401);
  assert.equal(await joinStatus(env, proj, { username: 'mallory', password: 'whatever', remote: LAN_PEER(13) }), 401, '名单外 401');
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: LAN_PEER(14) });
  const cara = await join(env, proj, { username: 'cara', remote: LAN_PEER(15) });
  const r = await adminOp(creator, proj, 'set-list', { list: [credential('cara-pw', 'cara')] });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  const closed = await Promise.race([bob.closed, new Promise(res => setTimeout(() => res(null), 5000))]);
  assert.deepEqual({ code: closed?.code, reason: closed?.reason }, { code: 4003, reason: 'removed' }, 'bob 被移出名单:连接以 4003 removed 关闭');
  assert.equal(cara.ws.readyState, 1, '名单里的人不受影响');
});

test('ACC018-LOCAL-3 账号模式开着:本地邀请码(局域网主机)——签发、解析不扣次数、兑换扣一次、同设备不重复扣、作废后一律 invite-invalid', async (t) => {
  await accountModeWithProject(t);
  const env = await startHost({ attached: true }); t.after(() => env.close());
  const proj = await createProject(env, { mode: 'free', password: 'invite-free-pw' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: LAN_PEER(21) });
  const issued = await adminOp(creator, proj, 'invite-create', { maxUses: 2 });
  assert.equal(issued.type, 'shared.admin.ok', JSON.stringify(issued));
  const code = issued.code;
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  const resolved = await resolveInvite(env, code, { remote: LAN_PEER(22) });
  assert.equal(resolved.status, 200, resolved.text);
  assert.deepEqual({ ok: resolved.json.ok, projectId: resolved.json.projectId, name: resolved.json.name, mode: resolved.json.mode },
    { ok: true, projectId: proj.projectId, name: proj.name, mode: 'free' });
  const dev1 = newDevice('Guest'), dev2 = newDevice('Guest');
  const r1 = await redeemInvite(env, { code, username: 'guest1', deviceId: dev1.deviceId }, { remote: LAN_PEER(23) });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(typeof r1.json.project?.key, 'string', '自由进入的邀请码兑换回项目口令派生的 K');
  assert.equal(await joinStatus(env, proj, { username: 'guest1', device: dev1, key: r1.json.project.key, remote: LAN_PEER(23) }), 101, '凭兑换得到的 K 握手进入');
  const again = await redeemInvite(env, { code, username: 'guest1', deviceId: dev1.deviceId }, { remote: LAN_PEER(23) });
  assert.equal(again.status, 200, '同一个用户名+设备再兑换不重复扣次数');
  const r2 = await redeemInvite(env, { code, username: 'guest2', deviceId: dev2.deviceId }, { remote: LAN_PEER(24) });
  assert.equal(r2.status, 200, r2.text);
  const dev3 = newDevice('Guest');
  const r3 = await redeemInvite(env, { code, username: 'guest3', deviceId: dev3.deviceId }, { remote: LAN_PEER(25) });
  assert.equal(r3.status, 404); assert.equal(r3.json.error, 'invite-invalid', '次数用满(2 次)后第三个人 invite-invalid');
  // 重新签发 = 作废旧的;再 revoke 后 resolve/redeem 都 invite-invalid
  const fresh = await adminOp(creator, proj, 'invite-create', {});
  assert.equal((await resolveInvite(env, code, { remote: LAN_PEER(26) })).json.error, 'invite-invalid', '再签发后旧码作废');
  const revoked = await adminOp(creator, proj, 'invite-revoke', {});
  assert.equal(revoked.type, 'shared.admin.ok');
  assert.equal((await resolveInvite(env, fresh.code, { remote: LAN_PEER(27) })).json.error, 'invite-invalid', '作废后 resolve invite-invalid');
});

test('ACC018-LOCAL-4 账号模式开着:本地主机/成员——成员列表、创建者操作要证明、踢人立即断开并 401、同名换设备不受影响、解禁后能进', async (t) => {
  await accountModeWithProject(t);
  const env = await startHost({ attached: true }); t.after(() => env.close());
  const proj = await createProject(env, { mode: 'free', password: 'host-member-pw' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: LAN_PEER(31) });
  const devZ = newDevice('Z');
  const zoe = await join(env, proj, { username: 'zoe', device: devZ, remote: LAN_PEER(32) });
  const yan = await join(env, proj, { username: 'yan', remote: LAN_PEER(33) });
  const listed = await members(creator);
  const names = listed.map(d => d.username).sort();
  assert.deepEqual(names, ['alice', 'yan', 'zoe'], '成员列表有创建者和两位成员(都不是账号用户)');
  // 创建者操作:不带证明/证明错 → forbidden,不生效
  const noProof = await adminOp(creator, proj, 'kick', { username: 'zoe', deviceId: devZ.deviceId }, { noProof: true });
  assert.equal(noProof.type === 'shared.admin.ok', false, '不带证明的创建者操作被拒');
  assert.equal(zoe.ws.readyState, 1, '被拒的踢人没生效');
  // 成员发创建者操作被拒
  const byMember = await adminOp(zoe, proj, 'kick', { username: 'yan', deviceId: yan.device.deviceId }, { password: 'host-member-pw', username: 'zoe' });
  assert.equal(byMember.type === 'shared.admin.ok', false, '成员不能执行创建者操作');
  // 带证明踢人
  const k = await adminOp(creator, proj, 'kick', { username: 'zoe', deviceId: devZ.deviceId });
  assert.equal(k.type, 'shared.admin.ok', JSON.stringify(k));
  const closed = await Promise.race([zoe.closed, new Promise(res => setTimeout(() => res(null), 5000))]);
  assert.deepEqual({ code: closed?.code, reason: closed?.reason }, { code: 4003, reason: 'kicked' });
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: devZ, remote: LAN_PEER(34) }), 401, '被踢设备再进 401');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: newDevice('Other'), remote: LAN_PEER(35) }), 101, '同名换设备不受禁入表影响');
  assert.equal(yan.ws.readyState, 1, '别的成员不受影响');
  const u = await adminOp(creator, proj, 'unban', { username: 'zoe', deviceId: devZ.deviceId });
  assert.equal(u.type, 'shared.admin.ok');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: devZ, remote: LAN_PEER(36) }), 101, '解禁后能进');
});

test('ACC018-LOCAL-5 本地与云端互不相通:云端账号模式拒收口令式项目与口令式握手;本地主机不认账号连接票据', async (t) => {
  const cloud = await accountModeWithProject(t);
  const env = await startHost({ attached: true }); t.after(() => env.close());
  const proj = await createProject(env, { mode: 'free', password: 'iso-pw' });
  // 云端(账号模式)不接受口令式 /shared/*:要账号
  const cloudCreate = await fetch(`${cloud.origin}/shared/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(cloudCreate.status, 403);
  assert.equal((await cloudCreate.json()).code, 'account-required');
  // 云端不接受口令式握手:用本地项目的合法证明去握手云端 → 不是 101
  const { protocols } = await (async () => {
    const { proofFor } = await import('./auth-kit.mjs');
    return proofFor(env, proj, { username: 'zoe', remote: LAN_PEER(41) });
  })();
  const cloudHandshake = await rawHandshake(cloud.port, { protocols, path: '/' });
  cloudHandshake.sock.destroy();
  assert.notEqual(cloudHandshake.status, 101, '账号模式的云端不收口令式项目的证明');
  // 本地主机不认账号连接票据
  const fakeAccountTicket = 'x'.repeat(40);
  const localHandshake = await env.handshake([PROTOCOL, `promptcut.account.${fakeAccountTicket}`], LAN_PEER(42));
  assert.notEqual(localHandshake.status, 101, '本地主机不认账号连接票据');
  // 云端账号项目的 ID 在本地主机上不存在
  const ch = await env.http('shared/challenge', { method: 'POST', remote: LAN_PEER(43),
    body: { projectId: cloud.accountProjectId, username: 'zoe', deviceId: newDevice().deviceId, as: 'member' } });
  assert.equal(ch.status, 404, '本地主机不知道云端账号项目');
});
