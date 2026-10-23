/**
 * 游客的写入由文档服务自己定序（claude/guest-enter，`server/account/password-order.mjs` 的 GUEST_ORDER_DOMAIN）。
 *
 * 0.7.21 线上：游客建好项目、进得去之后，每一步修改都被撤回 ——「有一步修改没被文档服务接受(bad-actor)」。
 * 账号服务的顺序见证只认 `acc_` 编号（VisuHive `account/order-witnesses.mjs` 的 `actor`），游客那一步交过去必回 400。
 *
 * 设了 PROMPTCUT_ACCOUNT_PROVIDER_ROOT / PROMPTCUT_PASSWORD_ORDER_MODULE 时账号那一侧是真的账号服务定序实现，否则是夹具里的模拟器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPasswordOrder, GUEST_ORDER_DOMAIN, createWitnessVerifier, signDocProof } from '../account/password-order.mjs';
import { fixture, actor, spec, keys } from './password-order-fixture.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-guest-order-'));
const guest = Object.freeze({ accountId: `gst_${'a'.repeat(24)}`, loginId: `guest:gst_${'a'.repeat(24)}`, credentialId: `guest:gst_${'a'.repeat(24)}:1`, loginGeneration: 1 });

test('游客的一步写入:文档服务自己签见证、落地,不经账号服务', async (t) => {
  const f = await fixture({ dir: tmp() }); t.after(() => f.close());
  const headBefore = f.account.head();
  const op = await f.coordinator.submit(spec('g1', { principal: guest }));
  assert.equal(op.state, 'materialized');
  assert.equal(f.history.snapshot('project-one').value.title, 'g1');
  assert.equal(op.witness.domain, GUEST_ORDER_DOMAIN);
  assert.equal(op.witness.state, 'sealed');
  assert.equal(op.witness.orderSeq, 1);
  assert.equal(op.witness.actorRef.accountId, guest.accountId);
  assert.equal(f.account.head(), headBefore, '账号服务那条序列没动(没去问它)');
  // 同一步重放:回原来那一份
  assert.deepEqual(await f.coordinator.submit(spec('g1', { principal: guest })), op);
});

test('账号和游客交替写:各自的顺序号单调,不互相判倒退;历史核得过', async (t) => {
  const f = await fixture({ dir: tmp() }); t.after(() => f.close());
  const a1 = await f.coordinator.submit(spec('a1', { principal: actor, expectedRev: 0 }));
  const g1 = await f.coordinator.submit(spec('g1', { principal: guest, expectedRev: 1 }));
  const g2 = await f.coordinator.submit(spec('g2', { principal: guest, expectedRev: 2 }));
  const a2 = await f.coordinator.submit(spec('a2', { principal: actor, expectedRev: 3 }));
  for (const op of [a1, g1, g2, a2]) assert.equal(op.state, 'materialized', op.opId);
  assert.notEqual(a1.witness.domain, GUEST_ORDER_DOMAIN);
  assert.deepEqual([g1.witness.orderSeq, g2.witness.orderSeq], [1, 2]);
  assert.ok(a2.witness.orderSeq > a1.witness.orderSeq);
  assert.equal(f.history.lastOrderSeq('project-one', GUEST_ORDER_DOMAIN), 2);
  assert.equal(f.history.validate('project-one').projectRev, 4);
});

test('重启后恢复:游客见证不去账号服务对账,签名照样核', async (t) => {
  const dir = tmp(), pair = keys();
  const f = await fixture({ dir, pair }); t.after(() => f.close());
  await f.coordinator.submit(spec('g1', { principal: guest }));
  // 同一份历史换一个协调者(等于文档服务重启)
  const again = createPasswordOrder({ history: f.history, account: f.client, verifyWitness: f.verifier, checkGate: async () => ({ allowed: true }), docAttestationPrivateKey: pair.doc.privateKey });
  await again.recover('project-one');
  const next = await again.submit(spec('g2', { principal: guest, expectedRev: 1 }));
  assert.equal(next.witness.orderSeq, 2);
  // 换了证明钥(别的文档服务签的):核不过,不当真
  const stranger = createPasswordOrder({ history: f.history, account: f.client, verifyWitness: f.verifier, checkGate: async () => ({ allowed: true }), docAttestationPrivateKey: keys().doc.privateKey });
  await assert.rejects(stranger.recover('project-one'), { code: 'bad-witness' });
});

test('游客域的见证不给账号的操作用', () => {
  const pair = keys();
  const forged = signDocProof({ v: 1, domain: GUEST_ORDER_DOMAIN, issuer: 'promptcut-doc', kind: 'operation', witnessId: 'gw_x', state: 'sealed', orderSeq: 1,
    requestId: 'r', docAuthorityId: 'd', projectId: 'project-one', opId: 'o', payloadDigest: 'a'.repeat(64), preparedDigest: 'b'.repeat(64), actorRef: { ...actor } }, pair.doc.privateKey);
  // 账号那一侧的核对只认账号服务的钥,游客域的见证在那里一定过不去
  const verify = createWitnessVerifier({ keys: { 'test-account': pair.account.publicKey } });
  assert.throws(() => verify(forged), { code: 'bad-witness' });
});

test('修好之前留在历史里的游客操作(只到 prepared,账号服务回过 bad-actor):恢复时作废,之后照常写', async (t) => {
  const f = await fixture({ dir: tmp() }); t.after(() => f.close());
  // 线上旧版本:prepare 落盘之后去账号服务 reserve 被 400 挡回,这一条就停在 prepared
  f.history.prepareOperation({ ...spec('stuck', { principal: guest }), requestIdentity: 'old' });
  assert.equal(f.history.get('project-one', 'stuck').state, 'prepared');
  await f.coordinator.recover('project-one');
  assert.equal(f.history.get('project-one', 'stuck').state, 'cancelled', '没定序的作废,不落地');
  assert.equal(f.history.snapshot('project-one').projectRev, 0);
  const next = await f.coordinator.submit(spec('after', { principal: guest }));
  assert.equal(next.state, 'materialized');
});
