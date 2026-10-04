import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createHostingService } from '../hosting/service.mjs';
import { openCredentialStore } from '../auth/store.mjs';
import { mirrorOf } from '../hosting/host.mjs';
import { relocationPending } from '../hosting/relocation.mjs';
import { freePorts } from './sp-kit.mjs';

const key = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const device = 'source-original-device-01', nextDevice = 'destination-device-0001';
async function fixture(t, where = 'hosted') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-relocation-directory-'));
  const store = openCredentialStore({ dir: path.join(dir, 'source-auth'), log: () => {} });
  const rec = store.create({ name: 'isolated-room', mode: 'free', kdf: { alg: 'pbkdf2-sha256', iter: 100000 },
    creator: { username: 'host', salt: randomBytes(16).toString('base64url'), key: key() }, project: { salt: randomBytes(16).toString('base64url'), key: key() } });
  const authorityService = 'https://isolated-authority.invalid', hostKey = key(), targetKey = key();
  let cloud = createHostingService({ dir: path.join(dir, 'directory'), authorityService });
  let address = await cloud.listen((await freePorts(1))[0]), base = `http://127.0.0.1:${address.port}`;
  t.after(() => cloud.close());
  const post = async (endpoint, body, secret = hostKey) => {
    const res = await fetch(`${base}/hosting/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const register = (secret = hostKey, dev = device, hostingEpoch = 1) => post('register', { roomId: rec.projectId, deviceId: dev, instance: key(), hostingEpoch, mirror: mirrorOf(rec) }, secret);
  assert.equal((await register()).status, 200);
  const transaction = { roomId: rec.projectId, txnId: `move_${randomBytes(16).toString('hex')}`, expectedEpoch: 1,
    target: { service: authorityService, where, deviceId: where === 'lan' ? nextDevice : null },
    manifest: { rev: 7, logDigest: hash('complete-final-log'), assetDigest: hash('complete-original-small-and-results') }, targetVerifier: hash(targetKey) };
  return { dir, rec, post, register, transaction, hostKey, targetKey, file: path.join(dir, 'directory', 'directory.json'),
    async restart() { await cloud.close(); cloud = createHostingService({ dir: path.join(dir, 'directory'), authorityService }); address = await cloud.listen((await freePorts(1))[0]); base = `http://127.0.0.1:${address.port}`; },
    ready: () => post('relocation/ready', { roomId: rec.projectId, txnId: transaction.txnId, epoch: 2, manifest: transaction.manifest, deviceId: nextDevice }, targetKey) };
}
for (const where of ['lan', 'hosted']) test(`真实云端目录 ${where}：准备/目标校验/发布各自跨停止重开，原房间、代数和权限连续`, async t => {
  const f = await fixture(t, where), old = hash(fs.readFileSync(f.file));
  assert.equal((await f.post('relocation/begin', f.transaction, key())).status, 403);
  assert.equal(hash(fs.readFileSync(f.file)), old);
  assert.equal((await f.post('relocation/begin', { ...f.transaction, target: { ...f.transaction.target, service: 'https://untrusted.invalid' } })).status, 400);
  assert.equal(hash(fs.readFileSync(f.file)), old);
  assert.equal((await f.post('relocation/begin', f.transaction)).status, 200);
  const prepared = hash(fs.readFileSync(f.file));
  assert.equal((await f.post('relocation/begin', f.transaction)).status, 200); assert.equal(hash(fs.readFileSync(f.file)), prepared);
  assert.equal((await f.register()).json.error, 'relocating');
  assert.equal((await f.post('relocation/publish', f.transaction)).json.error, 'relocation-not-ready');
  assert.equal((await f.post('relocation/begin', { ...f.transaction, txnId: `move_${randomBytes(16).toString('hex')}` })).status, 409);
  await f.restart();
  assert.equal((await f.post('relocation/state', f.transaction)).json.move.phase, 'prepared');
  assert.equal((await f.register()).json.error, 'relocating');
  assert.equal((await f.post('relocation/ready', { roomId: f.rec.projectId, txnId: f.transaction.txnId, epoch: 2, deviceId: nextDevice, manifest: f.transaction.manifest })).status, 403);
  assert.equal((await f.post('relocation/ready', { roomId: f.rec.projectId, txnId: f.transaction.txnId, epoch: 2, deviceId: nextDevice, manifest: { ...f.transaction.manifest, rev: 6 } }, f.targetKey)).status, 409);
  assert.equal((await f.ready()).status, 200); await f.restart();
  assert.equal((await f.post('relocation/publish', f.transaction, f.targetKey)).status, 403);
  assert.equal((await f.post('relocation/publish', f.transaction, hash(f.hostKey))).status, 403, 'a stored verifier is not a bearer credential');
  assert.equal((await f.post('relocation/state', f.transaction)).json.move.phase, 'ready');
  const published = await f.post('relocation/publish', f.transaction);
  assert.equal(published.status, 200); assert.equal(published.json.location.target.where, where); assert.equal(published.json.location.roomId, f.rec.projectId); assert.equal(published.json.epoch, 2);
  const durable = hash(fs.readFileSync(f.file));
  await f.restart(); assert.equal((await f.post('relocation/publish', f.transaction)).status, 200); assert.equal(hash(fs.readFileSync(f.file)), durable);
  assert.equal((await f.register()).status, 403, 'old host key cannot register again');
  assert.equal((await f.post('unregister', { roomId: f.rec.projectId, deleted: true })).status, 403, 'late old deletion cannot delete the destination');
  assert.equal((await f.register(f.targetKey, nextDevice, 1)).status, 409); assert.equal((await f.register(f.targetKey, device, 2)).status, 409);
  assert.equal((await f.register(f.targetKey, nextDevice, 2)).status, 200);
  const bytes = fs.readFileSync(f.file, 'utf8');
  assert.equal([f.hostKey, f.targetKey, f.rec.creator.key, f.rec.project.key].some(secret => bytes.includes(secret)), false, 'directory stores only purpose-specific verifiers');
});
test('真实云端目录：搬迁期间删除是最终状态，目标确认和迟到发布均不能撤销', async t => {
  const f = await fixture(t, 'lan'); assert.equal((await f.post('relocation/begin', f.transaction)).status, 200);
  assert.equal((await f.post('unregister', { roomId: f.rec.projectId, deleted: true })).status, 200);
  await f.restart(); assert.equal((await f.ready()).status, 410); assert.equal((await f.post('relocation/publish', f.transaction)).status, 410);
  assert.equal((await f.register()).status, 410);
});
test('真实云端目录：ready 后正常退出保留搬迁，显式删除持久阻止发布', async t => {
  const f = await fixture(t); assert.equal((await f.post('relocation/begin', f.transaction)).status, 200); assert.equal((await f.ready()).status, 200);
  assert.equal((await f.post('unregister', { roomId: f.rec.projectId, deleted: false })).status, 200);
  await f.restart(); assert.equal((await f.post('relocation/state', f.transaction)).json.move.phase, 'ready');
  assert.equal((await f.post('unregister', { roomId: f.rec.projectId, deleted: true })).status, 200);
  await f.restart(); assert.equal((await f.post('relocation/publish', f.transaction)).status, 410);
});
test('真实云端目录：目标准备及位置发布原子写失败保留原状态，同事务可重试', async t => {
  const f = await fixture(t), rename = fs.renameSync, before = hash(fs.readFileSync(f.file));
  try {
    fs.renameSync = (a, b) => { if (b === f.file) throw Object.assign(new Error('isolated write failure'), { code: 'ENOSPC' }); return rename(a, b); };
    assert.equal((await f.post('relocation/begin', f.transaction)).json.error, 'relocation-storage'); assert.equal(hash(fs.readFileSync(f.file)), before);
  } finally { fs.renameSync = rename; }
  assert.equal((await f.post('relocation/begin', f.transaction)).status, 200); assert.equal((await f.ready()).status, 200);
  const ready = hash(fs.readFileSync(f.file));
  try {
    fs.renameSync = (a, b) => { if (b === f.file) throw Object.assign(new Error('isolated write failure'), { code: 'ENOSPC' }); return rename(a, b); };
    assert.equal((await f.post('relocation/publish', f.transaction)).json.error, 'relocation-storage'); assert.equal(hash(fs.readFileSync(f.file)), ready);
    assert.equal((await f.post('relocation/state', f.transaction)).json.move.phase, 'ready');
  } finally { fs.renameSync = rename; }
  assert.equal((await f.post('relocation/publish', f.transaction)).status, 200);
});
test('已知搬迁记录损坏不能恢复旧租约；无搬迁记录保持原有离线语义', () => {
  assert.equal(relocationPending({}), false);
  for (const move of [null, {}, { version: 1, phase: 'committed' }, { version: 2, phase: 'committed' }]) assert.equal(relocationPending({ move }), true);
});
