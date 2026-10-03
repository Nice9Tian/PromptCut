import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseCollaboration, serviceIdentity } from '../recovery/descriptor.mjs';
import { openRecoveryVault, privateDeviceProtector } from '../recovery/vault.mjs';
import { RecoveryCoordinator } from '../recovery/coordinator.mjs';
import { localDocumentDir, prepareLocalDocumentDir } from '../recovery/paths.mjs';
import { localDeviceInfo } from '../auth/device.mjs';

const descriptor = { version: 1, roomId: 'sp_abcdefghijklmnopqrstuvwxyz', service: 'https://service.example/hosted', where: 'lan' };
const record = { ...descriptor, as: 'creator', username: 'one', profile: 'default', key: 'A'.repeat(43) };
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-recovery-test-'));
const plain = { kind: 'test-only', seal: b => b, open: b => b };
test('私有设备密钥首次发布遇到另一进程已发布时，不覆盖密钥或丢失原加密身份', () => {
  const dir = temp(), first = privateDeviceProtector(dir), value = Buffer.from('isolated-recovery-value');
  const sealed = first.seal(value), file = path.join(dir, 'device.key'), bytes = fs.readFileSync(file);
  // Reproduce the exists-check race deterministically: another process has published since our check.
  const original = fs.existsSync; fs.existsSync = candidate => candidate === file ? false : original(candidate);
  let second; try { second = privateDeviceProtector(dir); } finally { fs.existsSync = original; }
  assert.equal(fs.readFileSync(file).equals(bytes), true, 'competing publication must preserve the existing secret without printing it');
  assert.deepEqual(second.open(sealed), value);
});
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
test('旧运行目录迁到稳定目录时原文件保留，已有新状态不被覆盖，显式测试目录不迁入', () => {
  const root = temp(), stable = temp(), env = { PROMPTCUT_DATA_DIR: stable };
  const old = path.join(root, 'out', 'docservice'); fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, 'state'), 'old-rev-8');
  const target = prepareLocalDocumentDir(root, env);
  assert.equal(fs.readFileSync(path.join(target, 'state'), 'utf8'), 'old-rev-8');
  assert.equal(fs.readFileSync(path.join(old, 'state'), 'utf8'), 'old-rev-8');
  fs.writeFileSync(path.join(target, 'state'), 'new-rev-9'); prepareLocalDocumentDir(root, env);
  assert.equal(fs.readFileSync(path.join(target, 'state'), 'utf8'), 'new-rev-9');
  const isolated = path.join(temp(), 'isolated'); prepareLocalDocumentDir(root, { ...env, PROMPTCUT_DOCSERVICE_DATA: isolated }); assert.equal(fs.existsSync(isolated), false);
});
test('桌面设备 ID 从稳定文件读取，运行副本和网卡顺序改变不重新生成身份，损坏失败关闭', () => {
  const dir = temp(); const first = localDeviceInfo({ PROMPTCUT_DATA_DIR: dir });
  assert.deepEqual(localDeviceInfo({ PROMPTCUT_DATA_DIR: dir }), first);
  const file = path.join(dir, 'device.json'); fs.writeFileSync(file, JSON.stringify({ version: 1, deviceId: 'persisted-device-id-00001', deviceName: 'stable-device' }));
  assert.equal(localDeviceInfo({ PROMPTCUT_DATA_DIR: dir }).deviceId, 'persisted-device-id-00001');
  fs.writeFileSync(file, '{broken'); assert.throws(() => localDeviceInfo({ PROMPTCUT_DATA_DIR: dir })); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
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
  const stopped = openRecoveryVault({ dir, protector: plain });
  assert.equal(stopped.pendingUnregister().length, 1);
  assert.equal(stopped.pendingUnregister()[0].registrationKey, original.registrationKey);
  stopped.completeUnregister(descriptor);
  assert.equal(openRecoveryVault({ dir, protector: plain }).pendingUnregister().length, 0);
  assert.equal(stopped.select(descriptor, 'content-one').revoked, true, 'cloud acknowledgement never removes the local tombstone');
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
test('两个运行实例的凭证更新与注销合并，不用旧内存覆盖另一实例；锁异常原数据保留', () => {
  const dir = temp(), one = openRecoveryVault({ dir, protector: plain }), two = openRecoveryVault({ dir, protector: plain });
  one.remember(record, 'one'); two.remember({ ...record, username: 'two' }, 'two');
  assert.equal(one.list(descriptor).length, 2);
  const h = one.bindHost(descriptor, 'original-device'); assert.deepEqual(two.bindHost(descriptor, 'original-device'), h);
  two.revoke(descriptor); assert.equal(one.select(descriptor, 'one').revoked, true);
  fs.writeFileSync(path.join(dir, 'identities.lock'), '{broken');
  assert.throws(() => one.remember(record, 'one'), /另一个实例/);
  assert.equal(two.select(descriptor, 'one').revoked, true);
});
test('实际系统保护后端跨存储实例读取，磁盘没有明文凭证', () => {
  const dir = temp(); const v = openRecoveryVault({ dir }); v.remember(record, 'content');
  const text = fs.readFileSync(path.join(dir, 'identities.json'), 'utf8');
  assert.equal(text.includes(record.key), false);
  assert.equal(openRecoveryVault({ dir }).select(descriptor, 'content').selected.username, 'one');
});

test('独立运行进程同时更新保护存储时保留双方记录，异常退出的锁可回收', async () => {
  const dir = temp(), module = new URL('../recovery/vault.mjs', import.meta.url).href;
  const code = `import { openRecoveryVault } from ${JSON.stringify(module)};
    const v = openRecoveryVault({ dir: process.env.PC_RECOVERY_TEST_DIR, protector: { kind: 'test-only', seal: b => b, open: b => b } });
    process.stdin.once('data', () => { for (let n = 0; n < 10; n++) v.remember({ version: 1, service: 'https://service.example/hosted', roomId: 'sp_abcdefghijklmnopqrstuvwxyz', as: 'member', username: process.env.PC_RECOVERY_TEST_PEER + n, profile: 'default', key: 'A'.repeat(43) }); });`;
  const children = ['one', 'two'].map(peer => spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, env: { ...process.env, PC_RECOVERY_TEST_DIR: dir, PC_RECOVERY_TEST_PEER: peer }, stdio: ['pipe', 'ignore', 'ignore'] }));
  const done = children.map(child => new Promise((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error('隔离写入进程失败')))));
  for (const child of children) child.stdin.end('go'); await Promise.all(done);
  const v = openRecoveryVault({ dir, protector: plain }); assert.equal(v.list(descriptor).length, 20);
  fs.writeFileSync(path.join(dir, 'identities.lock'), JSON.stringify({ pid: children[0].pid }));
  v.remember(record, 'after-crash'); assert.equal(v.list(descriptor).length, 21);
});
test('私有设备保护后端首次双进程并发发布和加密写入，重开可读取全部身份', async () => {
  const dir = temp(), module = new URL('../recovery/vault.mjs', import.meta.url).href;
  const code = `import fs from 'node:fs'; import path from 'node:path';
    import { openRecoveryVault, privateDeviceProtector } from ${JSON.stringify(module)};
    process.stdin.once('data', () => {
      const dir = process.env.PC_RECOVERY_TEST_DIR, file = path.join(dir, 'device.key');
      const original = fs.existsSync; fs.existsSync = p => p === file ? false : original(p);
      let protector; try { protector = privateDeviceProtector(dir); } finally { fs.existsSync = original; }
      const v = openRecoveryVault({ dir, protector });
      for (let n = 0; n < 10; n++) v.remember({ version: 1, service: 'https://service.example/hosted', roomId: 'sp_abcdefghijklmnopqrstuvwxyz', as: 'member', username: process.env.PC_RECOVERY_TEST_PEER + n, profile: 'default', key: 'A'.repeat(43) });
    });`;
  const children = ['one', 'two'].map(peer => spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true,
    env: { ...process.env, PC_RECOVERY_TEST_DIR: dir, PC_RECOVERY_TEST_PEER: peer }, stdio: ['pipe', 'ignore', 'ignore'] }));
  const done = children.map(child => new Promise((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error('隔离加密进程失败，不输出秘密')))));
  for (const child of children) child.stdin.end('go'); await Promise.all(done);
  const v = openRecoveryVault({ dir, protector: privateDeviceProtector(dir) }); assert.equal(v.list(descriptor).length, 20);
});
test('保存加密记录临时文件后进程真实退出，原记录可读并可回收退出锁后重试', async () => {
  const dir = temp(), module = new URL('../recovery/vault.mjs', import.meta.url).href;
  const first = openRecoveryVault({ dir, protector: privateDeviceProtector(dir) }); first.remember(record, 'content');
  const file = path.join(dir, 'identities.json'), before = fs.readFileSync(file);
  const code = `import fs from 'node:fs'; import path from 'node:path';
    import { openRecoveryVault, privateDeviceProtector } from ${JSON.stringify(module)};
    const dir = process.env.PC_RECOVERY_TEST_DIR, file = path.join(dir, 'identities.json');
    const v = openRecoveryVault({ dir, protector: privateDeviceProtector(dir) });
    const rename = fs.renameSync; fs.renameSync = (source, target) => { if (target === file) process.exit(31); return rename(source, target); };
    v.remember({ version: 1, service: 'https://service.example/hosted', roomId: 'sp_abcdefghijklmnopqrstuvwxyz', as: 'member', username: 'after-crash', profile: 'default', key: 'A'.repeat(43) }, 'new-content');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true,
    env: { ...process.env, PC_RECOVERY_TEST_DIR: dir }, stdio: 'ignore' });
  const codeAfter = await new Promise(r => child.once('exit', r)); assert.equal(codeAfter, 31);
  assert.equal(fs.readFileSync(file).equals(before), true, 'original encrypted record must remain byte-for-byte unchanged');
  const reopened = openRecoveryVault({ dir, protector: privateDeviceProtector(dir) });
  assert.equal(reopened.select(descriptor, 'content').selected.username, 'one');
  reopened.remember({ ...record, username: 'after-crash', as: 'member' }, 'new-content'); assert.equal(reopened.list(descriptor).length, 2);
});
test('临时记录已部分写入后出现 ENOSPC，原加密记录保留且下一次保存可重试', () => {
  const dir = temp(), v = openRecoveryVault({ dir, protector: privateDeviceProtector(dir) }); v.remember(record, 'content');
  const file = path.join(dir, 'identities.json'), before = fs.readFileSync(file), open = fs.openSync, write = fs.writeFileSync;
  let partial;
  fs.openSync = (name, ...args) => { const fd = open(name, ...args); if (String(name).startsWith(file + '.tmp-')) partial = fd; return fd; };
  fs.writeFileSync = (target, bytes, ...args) => {
    if (target === partial) { write(target, Buffer.from(bytes).subarray(0, 16)); throw Object.assign(new Error('isolated full-disk failure'), { code: 'ENOSPC' }); }
    return write(target, bytes, ...args);
  };
  try { assert.throws(() => v.remember({ ...record, username: 'after-full' }, 'another'), { code: 'ENOSPC' }); }
  finally { fs.openSync = open; fs.writeFileSync = write; }
  assert.equal(fs.readFileSync(file).equals(before), true, 'failed partial save must not print or overwrite encrypted contents');
  const reopened = openRecoveryVault({ dir, protector: privateDeviceProtector(dir) });
  assert.equal(reopened.select(descriptor, 'content').selected.username, 'one');
  reopened.remember({ ...record, username: 'after-full' }, 'another'); assert.equal(reopened.list(descriptor).length, 2);
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
test('限速保留原恢复身份，严格等 Retry-After 后自动重入；取消清除待重试任务', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0, entered = 0; const states = [];
  const coordinator = new RecoveryCoordinator({ state: s => states.push(s), identity: async () => ({ selected: record }),
    discover: async () => { if (++attempts === 1) throw Object.assign(new Error('isolated rate limit'), { reason: 'rate-limited', retryAfter: 2 }); return {}; },
    enter: async (_candidate, recovered) => { assert.equal(recovered, record); entered++; return { ok: true }; } });
  try {
    coordinator.start(descriptor, 'content'); await new Promise(r => setImmediate(r));
    assert.equal(states.at(-1), 'waiting-host'); assert.equal(entered, 0);
    t.mock.timers.tick(1999); await new Promise(r => setImmediate(r)); assert.equal(attempts, 1);
    t.mock.timers.tick(1); await new Promise(r => setImmediate(r));
    assert.equal(states.at(-1), 'connected'); assert.equal(attempts, 2); assert.equal(entered, 1);
    attempts = 0; coordinator.start(descriptor, 'content'); await new Promise(r => setImmediate(r));
    coordinator.cancel(); const before = states.length;
    t.mock.timers.tick(60000); await new Promise(r => setImmediate(r));
    assert.equal(attempts, 1); assert.equal(states.length, before); assert.equal(coordinator.timer, null);
  } finally { coordinator.cancel(); t.mock.timers.reset(); }
});
test('主机恢复、发现及接入的迟到结果在换项目后均不恢复旧状态', async () => {
  for (const phase of ['host', 'discover', 'enter']) {
    let resolve; const calls = [];
    const wait = () => new Promise(r => { resolve = r; });
    const coordinator = new RecoveryCoordinator({ state: s => calls.push(s),
      identity: async () => ({ selected: record, host: phase === 'host' }),
      host: async () => { calls.push('host'); return phase === 'host' ? wait() : {}; },
      discover: async () => { calls.push('discover'); return phase === 'discover' ? wait() : {}; },
      enter: async () => { calls.push('enter'); return phase === 'enter' ? wait() : { ok: true }; } });
    coordinator.start(descriptor, 'content'); await new Promise(r => setImmediate(r));
    assert.equal(typeof resolve, 'function'); coordinator.cancel(); const before = [...calls];
    resolve(phase === 'enter' ? { ok: true } : {}); await new Promise(r => setImmediate(r));
    assert.deepEqual(calls, before); assert.equal(calls.includes('connected'), false);
  }
});
