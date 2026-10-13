/**
 * 打开旧云端项目文件时的恢复状态机：只有文档服务签发、核对过的「已不存在」证明才报 `gone`（调用方据此转成本地项目）。
 * 本机凭证被撤、连到的服务说「没有这个项目」、暂时离线、认证失败、没有权限都不转。
 * 对应 `docs/plan/account-binding-task.md`「逐项验收」的「正常云端文件重开」「过期云端项目转本地」「非过期与坏文件」三行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryCoordinator } from '../recovery/coordinator.mjs';

const room = `sp_${'a'.repeat(26)}`;
const hosted = { version: 1, roomId: room, service: 'https://old-hosted.example/hosted', where: 'hosted' };
const lan = { ...hosted, where: 'lan' };
const record = { as: 'member', username: 'u', key: 'k', candidate: { where: 'hosted', base: 'https://old-hosted.example/hosted', projectId: room } };
const proof = { v: 1, authorityId: 'doc', projectId: room, state: 'gone', tombstoneRevision: 3, issuedAt: 1, kid: 'k1', signature: 's' };
const fail = (reason, extra = {}) => Object.assign(new Error(reason), { reason, ...extra });
const unavailable = () => fail('gone-check-unavailable');
const tick = () => new Promise(r => setImmediate(r));

/** 跑一轮，回状态序列与各钩子被叫了几次。`gone` 可以是一个答复，也可以是按次序用的一串（函数表示抛错）。 */
async function run(t, { descriptor = hosted, gone, identity = async () => ({ selected: record }), discover = async () => ({}), enter = async () => ({ ok: true }), withGone = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const states = [], details = [], calls = { gone: 0, identity: 0, discover: 0, enter: 0 };
  const answers = Array.isArray(gone) ? [...gone] : null;
  const coordinator = new RecoveryCoordinator({
    state: (s, detail) => { states.push(s); details.push(detail); },
    ...(withGone ? { gone: async () => { calls.gone++; const next = answers ? (answers.length > 1 ? answers.shift() : answers[0]) : gone; if (typeof next === 'function') throw next(); return next; } } : {}),
    identity: async (...a) => { calls.identity++; return identity(...a); },
    discover: async (...a) => { calls.discover++; return discover(...a); },
    host: async () => { throw fail('unreachable'); },
    enter: async (...a) => { calls.enter++; return enter(...a); },
  });
  try {
    coordinator.start(descriptor, 'content'); await tick(); await tick();
    return { states, details, calls, timer: coordinator.timer, coordinator };
  } finally { coordinator.cancel(); t.mock.timers.reset(); }
}

test('过期且有证明：一上来就收场，不去找身份、不去连', async t => {
  const r = await run(t, { gone: { state: 'gone', proof } });
  assert.deepEqual(r.states, ['recovering', 'gone']);
  assert.deepEqual(r.details.at(-1), { state: 'gone', proof });
  assert.deepEqual(r.calls, { gone: 1, identity: 0, discover: 0, enter: 0 }); assert.equal(r.timer, null);
});

test('没过期：服务明确没有墓碑，照常连原项目', async t => {
  const r = await run(t, { gone: { state: 'no-tombstone' } });
  assert.deepEqual(r.states, ['recovering', 'connected']);
  assert.deepEqual(r.calls, { gone: 1, identity: 1, discover: 1, enter: 1 });
});

test('暂时离线：证明问不到、服务也连不上，保留关联等着重试，不转', async t => {
  const r = await run(t, { gone: unavailable, discover: async () => { throw fail('unreachable'); } });
  assert.deepEqual(r.states, ['recovering', 'waiting-host']); assert.notEqual(r.timer, null, '排了下一次重试');
  // 重试时再问一次证明（上一次没问到）
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const states = []; let asked = 0;
  const c = new RecoveryCoordinator({ state: s => states.push(s), gone: async () => { asked++; throw unavailable(); }, identity: async () => ({ selected: record }),
    discover: async () => { throw fail('unreachable'); }, enter: async () => ({ ok: true }) });
  try { c.start(hosted, 'content'); await tick(); await tick(); t.mock.timers.tick(600); await tick(); await tick(); assert.equal(asked, 2); assert.deepEqual(states, ['recovering', 'waiting-host', 'recovering', 'waiting-host']); }
  finally { c.cancel(); t.mock.timers.reset(); }
});

test('认证失败、没有权限：各报各的，不转', async t => {
  for (const [reason, want] of [['auth', 'needs-auth'], ['unauthorized', 'needs-auth'], ['kicked', 'rejected'], ['banned', 'rejected'], ['removed', 'rejected']]) {
    const r = await run(t, { gone: { state: 'no-tombstone' }, enter: async () => ({ ok: false, error: reason }) });
    assert.deepEqual(r.states, ['recovering', want], reason); assert.equal(r.timer, null);
  }
  const none = await run(t, { gone: { state: 'no-tombstone' }, identity: async () => ({ identities: [] }) });
  assert.deepEqual(none.states, ['recovering', 'needs-auth'], '这台设备上没有身份');
  const offline = await run(t, { gone: unavailable, identity: async () => ({ identities: [] }) });
  assert.deepEqual(offline.states, ['recovering', 'needs-auth'], '证明问不到时照常走恢复');
});

test('服务说「没有这个项目」而没有墓碑：不是证明，不转，也不再报「已删除」', async t => {
  for (const reason of ['no-project', 'deleted']) {
    const r = await run(t, { gone: { state: 'no-tombstone' }, enter: async () => ({ ok: false, error: reason }) });
    assert.deepEqual(r.states, ['recovering', 'missing-unconfirmed'], reason); assert.equal(r.calls.gone, 2); assert.equal(r.timer, null);
  }
  const untrusted = await run(t, { gone: { state: 'untrusted-service' }, enter: async () => ({ ok: false, error: 'no-project' }) });
  assert.deepEqual(untrusted.states, ['recovering', 'missing-unconfirmed'], '文件里记的服务没处可问');
  const thrown = await run(t, { gone: { state: 'no-tombstone' }, discover: async () => { throw fail('no-project'); } });
  assert.deepEqual(thrown.states, ['recovering', 'missing-unconfirmed']);
});

test('本机凭证被撤：不是证明，不转', async t => {
  const r = await run(t, { gone: { state: 'no-tombstone' }, identity: async () => ({ revoked: true, identities: [] }) });
  assert.deepEqual(r.states, ['recovering', 'missing-unconfirmed']); assert.equal(r.calls.discover, 0);
  const offline = await run(t, { gone: unavailable, identity: async () => ({ revoked: true, identities: [] }) });
  assert.deepEqual(offline.states, ['recovering', 'waiting-host'], '问不到证明：等着重试，不下结论'); assert.notEqual(offline.timer, null);
  const late = await run(t, { gone: [unavailable, { state: 'gone', proof }], identity: async () => ({ revoked: true, identities: [] }) });
  assert.deepEqual(late.states, ['recovering', 'gone'], '先没问到、随后拿到证明');
});

test('过期但证明对不上：不转', async t => {
  const r = await run(t, { gone: { state: 'proof-rejected', reason: 'signature' }, enter: async () => ({ ok: false, error: 'no-project' }) });
  assert.deepEqual(r.states, ['recovering', 'proof-rejected']); assert.equal(r.timer, null);
  const noProof = await run(t, { gone: { state: 'gone' }, enter: async () => ({ ok: false, error: 'no-project' }) });
  assert.deepEqual(noProof.states, ['recovering', 'missing-unconfirmed'], '说 gone 却不带证明的答复不算');
  const auth = await run(t, { gone: { state: 'proof-rejected', reason: 'project' }, identity: async () => ({ identities: [] }) });
  assert.deepEqual(auth.states, ['recovering', 'needs-auth']);
});

test('服务说没有、随后拿到证明：转', async t => {
  const r = await run(t, { gone: [unavailable, { state: 'gone', proof }], enter: async () => ({ ok: false, error: 'no-project' }) });
  assert.deepEqual(r.states, ['recovering', 'gone']); assert.deepEqual(r.details.at(-1).proof, proof);
});

test('局域网项目、没接证明查询的旧调用方：照旧报「已删除」，从不报 gone', async t => {
  const revoked = await run(t, { descriptor: lan, gone: { state: 'gone', proof }, identity: async () => ({ revoked: true, identities: [] }) });
  assert.deepEqual(revoked.states, ['recovering', 'deleted']); assert.equal(revoked.calls.gone, 0, '局域网项目没有签发方，不问');
  const lanRecord = { ...record, candidate: { ...record.candidate, where: 'lan' } };
  const missing = await run(t, { descriptor: lan, gone: { state: 'gone', proof }, identity: async () => ({ selected: lanRecord }), enter: async () => ({ ok: false, error: 'no-project' }) });
  assert.deepEqual(missing.states, ['recovering', 'deleted']); assert.equal(missing.calls.gone, 0);
  const old = await run(t, { withGone: false, enter: async () => ({ ok: false, error: 'no-project' }) });
  assert.deepEqual(old.states, ['recovering', 'deleted']);
});

test('取消之后迟到的证明不生效', async t => {
  let release; const states = [];
  const c = new RecoveryCoordinator({ state: s => states.push(s), gone: () => new Promise(r => { release = r; }), identity: async () => ({ selected: record }), discover: async () => ({}), enter: async () => ({ ok: true }) });
  c.start(hosted, 'content'); await tick(); c.cancel(); release({ state: 'gone', proof }); await tick(); await tick();
  assert.deepEqual(states, ['recovering']);
});

test('本机身份注销之后，这台设备上没发出去的离线修改仍然读得到（转成本地项目时要并进去）', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { openRecoveryVault } = await import('../recovery/vault.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-gone-vault-'));
  try {
    const plain = { kind: 'test-plain', seal: b => b, open: b => b };
    const vault = openRecoveryVault({ dir, protector: plain });
    const identity = { ...record, service: hosted.service, roomId: room, key: 'k'.repeat(43) };
    vault.remember(identity, 'content-one');
    const journal = { version: 1, projectId: room, pending: [{ opId: 'x' }], project: { tracks: [] } };
    vault.journal(hosted, 'content-one', journal);
    assert.deepEqual(vault.select(hosted, 'content-one').journal, journal);
    vault.revoke(hosted);
    const after = openRecoveryVault({ dir, protector: plain }).select(hosted, 'content-one');
    assert.equal(after.revoked, true); assert.deepEqual(after.identities, [], '注销后不再给身份');
    assert.deepEqual(after.journal, journal, '离线修改还在');
    assert.equal(openRecoveryVault({ dir, protector: plain }).select(hosted, 'other-content').journal, null, '只给这份内容的');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
