import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCollaboration, serviceIdentity } from '../recovery/descriptor.mjs';
import { openRecoveryVault } from '../recovery/vault.mjs';
import { RecoveryCoordinator } from '../recovery/coordinator.mjs';
import { localDocumentDir } from '../recovery/paths.mjs';

const descriptor = { version: 1, roomId: 'sp_abcdefghijklmnopqrstuvwxyz', service: 'https://service.example/hosted', where: 'lan' };
const record = { ...descriptor, as: 'creator', username: 'one', profile: 'default', key: 'A'.repeat(43) };
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-recovery-test-'));
const plain = { kind: 'test-only', seal: b => b, open: b => b };
test('恢复描述拒绝不合法房间、凭证 URL 与未知版本丢失；角色不进入有效描述', () => {
  assert.deepEqual(parseCollaboration({ ...descriptor, creator: true, password: 'invalid' }), descriptor);
  for (const service of ['https://u:pw@evil.example', 'file:///x', 'https://evil.example?key=x', 'https://evil.example#key']) assert.throws(() => serviceIdentity(service));
  assert.throws(() => parseCollaboration({ ...descriptor, roomId: '../room' }));
  const future = { version: 2, special: 'retain' }; assert.deepEqual(parseCollaboration(future), future);
});
test('桌面稳定目录不随运行副本变化，文档和素材核验采用同一目录', () => {
  const env = { PROMPTCUT_DATA_DIR: 'stable-data' };
  assert.equal(localDocumentDir('runtime-one', env), localDocumentDir('runtime-two', env));
});
test('凭证分别保存服务、房间及身份，重启后绑定连续，第二设备不得抢主机', () => {
  const dir = temp(); const v = openRecoveryVault({ dir, protector: plain });
  v.remember(record, 'content-one');
  v.remember({ ...record, as: 'member', username: 'two', key: 'B'.repeat(43) }, 'content-two');
  const original = v.bindHost(descriptor, 'device-one');
  const reopened = openRecoveryVault({ dir, protector: plain });
  assert.equal(reopened.select(descriptor, 'content-one').selected.username, 'one');
  assert.equal(reopened.select(descriptor, 'content-two').selected.username, 'two');
  assert.equal(reopened.select(descriptor, 'other-content').selected, null);
  assert.equal(reopened.select({ ...descriptor, service: 'https://evil.example' }, 'content-one').identities.length, 0);
  assert.deepEqual(reopened.bindHost(descriptor, 'device-one'), original);
  assert.throws(() => reopened.bindHost(descriptor, 'device-two'));
  reopened.revoke(descriptor);
  assert.equal(openRecoveryVault({ dir, protector: plain }).select(descriptor, 'content-one').revoked, true);
  assert.throws(() => reopened.bindHost(descriptor, 'device-one'));
});
test('存盘失败不覆盖原身份，损坏必须明确拒绝，不创建空记录', () => {
  const dir = temp(); openRecoveryVault({ dir, protector: plain }).remember(record, 'content');
  const failed = openRecoveryVault({ dir, protector: plain, write() { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } });
  assert.throws(() => failed.remember({ ...record, key: 'B'.repeat(43) }, 'content'));
  assert.equal(openRecoveryVault({ dir, protector: plain }).select(descriptor, 'content').selected.key, record.key);
  fs.writeFileSync(path.join(dir, 'identities.json'), '{broken');
  assert.throws(() => openRecoveryVault({ dir, protector: plain }), /损坏/);
  assert.equal(fs.readFileSync(path.join(dir, 'identities.json'), 'utf8'), '{broken');
});
test('实际系统保护后端跨存储实例读取，磁盘没有明文凭证', () => {
  const dir = temp(); const v = openRecoveryVault({ dir }); v.remember(record, 'content');
  const text = fs.readFileSync(path.join(dir, 'identities.json'), 'utf8');
  assert.equal(text.includes(record.key), false);
  assert.equal(openRecoveryVault({ dir }).select(descriptor, 'content').selected.username, 'one');
});
test('恢复中换项目使旧异步发现失效，禁止触发旧身份接入', async () => {
  let resolve; const calls = [];
  const coordinator = new RecoveryCoordinator({ state: s => calls.push(s), identity: () => new Promise(r => { resolve = r; }),
    host: async () => { calls.push('host'); }, discover: async () => { calls.push('discover'); }, enter: async () => { calls.push('enter'); } });
  coordinator.start(descriptor, 'content'); coordinator.cancel(); resolve({ selected: record });
  await new Promise(r => setImmediate(r)); assert.deepEqual(calls, ['recovering']);
});
test('终止认证错误不会重试；未知版本不访问身份后端', async () => {
  const states = []; let entries = 0;
  const coordinator = new RecoveryCoordinator({ state: s => states.push(s), identity: async () => ({ selected: record }), discover: async () => ({}),
    enter: async () => { entries++; return { ok: false, error: 'auth' }; } });
  coordinator.start(descriptor, 'content'); await new Promise(r => setImmediate(r));
  assert.deepEqual(states, ['recovering', 'needs-auth']); assert.equal(coordinator.timer, null); assert.equal(entries, 1);
  coordinator.start({ version: 9 }, 'content'); assert.equal(states.at(-1), 'unsupported'); coordinator.cancel();
});
