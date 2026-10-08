import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digestOf } from '../account/ledger.mjs';
import { publishAssetRootRegistry, parseProcStat, validatePublisherScope, validatePublisherUnit, runAssetRootPublisher,
  writePublisherArtifact, openPublisherLock } from '../hosted/deploy/asset-root-registry-publisher.mjs';

const scope = { authorityId: 'doc-test', serviceIdentity: 'asset-test', uid: 12001,
  unit: 'promptcut-asset-test.service', cgroupPath: '/sys/fs/cgroup/system.slice/promptcut-asset-test.service',
  clientFingerprint256: '1'.repeat(64), serverFingerprint256: '2'.repeat(64) };
const bootId = '11111111-1111-1111-1111-111111111111';
const clone = value => structuredClone(value);
function instance(id, n = 1) {
  return { instanceId: id, bootId, pid: 100 + n, pidBirth: { bootId, startTicks: String(1000 + n) },
    uid: scope.uid, unit: scope.unit, unitInvocationId: String(n).padStart(32, '0'),
    cgroup: { v2Path: scope.cgroupPath, dev: '30', ino: String(200 + n), bootId },
    serviceIdentity: scope.serviceIdentity, clientFingerprint256: scope.clientFingerprint256,
    serverFingerprint256: scope.serverFingerprint256 };
}
// Explicitly a controlled transaction model: no kernel, TLS or process-close
// claim is inferred from these callbacks. Linux root integration is separate.
function model() {
  const files = new Map(), calls = []; let serial = 0, locked = false, current;
  const faults = {};
  const io = {
    uuid: () => `id-${++serial}`,
    async lock() { if (locked) throw Error('locked'); locked = true; calls.push('lock'); return async () => { locked = false; calls.push('unlock'); }; },
    async read(name) { return clone(files.get(name) ?? null); },
    async write(name, value, exclusive) {
      calls.push(`write:${name}:${value.state ?? value.phase ?? ''}`);
      if (faults.write?.(name, value)) throw Error('fsync-failed');
      if (exclusive && files.has(name)) throw Error('exists');
      files.set(name, clone(value));
    },
    async assertInitial() { calls.push('initial'); },
    async pinPrevious(previous) {
      calls.push('pin');
      if (faults.pin) throw Error('wrong-process');
      return {
        async stopAndObserve() {
          calls.push('stop'); if (faults.stop) throw Error('ENOENT-not-proof');
          const result = { kind: 'cgroup-empty', closed: true, at: 100, bootId,
            cgroup: clone(previous.cgroup), unitInvocationId: previous.unitInvocationId, pidBirth: clone(previous.pidBirth) };
          return faults.observed ? faults.observed(result) : result;
        },
        async close() { calls.push('close-pinned-fd'); },
      };
    },
    async start() { calls.push('start'); const r = files.get('reservation.json'); current = instance(r.instanceId, r.epoch); },
    async inspect() { calls.push('inspect'); return faults.inspect ? faults.inspect(clone(current)) : clone(current); },
    async identity() {
      calls.push('identity'); const r = files.get('reservation.json');
      const result = { v: 1, serviceId: 'asset', authorityId: scope.authorityId, epoch: r.epoch,
        instanceId: r.instanceId, pid: current.pid, startedAt: 100, serviceIdentity: scope.serviceIdentity,
        docClientFingerprint256: scope.clientFingerprint256, internalServerFingerprint256: scope.serverFingerprint256, state: 'running' };
      return faults.identity ? faults.identity(result) : result;
    },
  };
  return { io, files, calls, faults, run: mode => publishAssetRootRegistry({ scope, mode, io }) };
}

test('publisher parses actual /proc stat field 22 without whitespace/comm confusion; scope rejects arbitrary unit/path', () => {
  const fields = ['S', ...Array(18).fill('0'), '987654321', '0'];
  assert.deepEqual(parseProcStat(`123 (name ) with spaces) ${fields.join(' ')}`), { pid: 123, startTicks: '987654321' });
  assert.throws(() => parseProcStat('123 malformed'));
  assert.deepEqual(validatePublisherScope(scope), scope);
  for (const change of [{ uid: 0 }, { unit: '../other.service' }, { unit: '--help.service' }, { cgroupPath: '/sys/fs/cgroup/a/../b' },
    { cgroupPath: '/sys/fs/cgroup/a//b' }, { arbitraryUnit: 'other.service' }]) assert.throws(() => validatePublisherScope({ ...scope, ...change }));
});

test('publisher rejects automatic replacement, delegated tree, alias unit, or process-only KillMode before unit control', () => {
  const value = { Id: scope.unit, LoadState: 'loaded', KillMode: 'control-group', Delegate: 'no', Restart: 'no' };
  assert.equal(validatePublisherUnit(value, scope.unit), value);
  for (const change of [{ Id: 'unrelated.service' }, { Restart: 'always' }, { Restart: 'on-failure' },
    { Delegate: 'yes' }, { KillMode: 'process' }, { LoadState: 'not-found' }])
    assert.throws(() => validatePublisherUnit({ ...value, ...change }, scope.unit), { code: 'publisher-unit-scope' });
});

test('controlled initialize creates immutable anchor; rotate closure precedes reservation/active; matches canonical witness chain', async () => {
  const m = model(); const first = await m.run('initialize'), old = clone(m.files.get('current.json'));
  assert.equal(first.epoch, 1); assert.equal(m.files.get('anchor.json').firstRegistryDigest, digestOf(old));
  assert.equal(old.previous, null); assert.equal(m.calls.includes('stop'), false);
  m.calls.length = 0;
  const next = await m.run('rotate'), value = m.files.get('current.json'), witness = m.files.get('witness-2.json');
  assert.equal(next.epoch, 2); assert.equal(value.previous.registryDigest, digestOf(old));
  assert.equal(value.previous.closureWitnessDigest, digestOf(witness));
  assert.deepEqual(witness.previousRegistry, old); assert.deepEqual(witness.observed.pidBirth, old.instance.pidBirth);
  assert.deepEqual(m.calls, ['lock', 'pin', 'write:current.json:preparing', 'write:transition.json:closing', 'stop',
    'write:witness-2.json:', 'close-pinned-fd', 'write:reservation.json:', 'write:transition.json:reserved',
    'start', 'inspect', 'identity', 'inspect', 'write:epoch-2.json:active', 'inspect', 'write:current.json:active', 'unlock']);
});

test('controlled incorrect old process refuses stop; ENOENT observation remains inactive and never starts', async () => {
  const m = model(); await m.run('initialize'); m.calls.length = 0; m.faults.pin = true;
  await assert.rejects(m.run('rotate'), /wrong-process/); assert.equal(m.calls.includes('stop'), false);
  delete m.faults.pin; m.faults.stop = true;
  await assert.rejects(m.run('rotate'), /ENOENT-not-proof/);
  assert.equal(m.files.get('current.json').state, 'preparing');
  assert.equal(m.files.has('witness-2.json'), false); assert.equal(m.calls.includes('start'), false);
  assert.ok(m.calls.includes('close-pinned-fd'));
});

test('controlled closure cannot substitute another boot/cgroup/birth/invocation or false completion', async t => {
  const changes = [r => ({ ...r, closed: false }), r => ({ ...r, cgroup: { ...r.cgroup, ino: '999' } }),
    r => ({ ...r, bootId: '22222222-2222-2222-2222-222222222222' }),
    r => ({ ...r, pidBirth: { ...r.pidBirth, startTicks: '999' } }), r => ({ ...r, unitInvocationId: 'f'.repeat(32) })];
  for (let i = 0; i < changes.length; i++) await t.test(`mismatch ${i}`, async () => {
    const m = model(); await m.run('initialize'); m.faults.observed = changes[i]; m.calls.length = 0;
    await assert.rejects(m.run('rotate'), { code: 'publisher-closure-invalid' });
    assert.equal(m.files.has('witness-2.json'), false); assert.equal(m.calls.includes('start'), false);
  });
});

test('controlled fsync cuts never publish active second epoch; rerun refuses incomplete current', async t => {
  for (const name of ['transition.json', 'witness-2.json', 'reservation.json', 'epoch-2.json', 'current-active']) {
    await t.test(name, async () => {
      const m = model(); await m.run('initialize');
      m.faults.write = (file, value) => name === 'current-active' ? file === 'current.json' && value.state === 'active' : file === name;
      await assert.rejects(m.run('rotate'), /fsync-failed/);
      assert.notEqual(m.files.get('current.json').state, 'active');
      delete m.faults.write; await assert.rejects(m.run('rotate'), { code: 'publisher-current-invalid' });
    });
  }
});

test('controlled identity cannot change PID/epoch/instance/authority/pin or self-attest extra OS fields', async t => {
  for (const change of [{ pid: 999 }, { epoch: 9 }, { instanceId: 'old' }, { authorityId: 'other' },
    { docClientFingerprint256: '3'.repeat(64) }, { uid: 12001 }]) await t.test(Object.keys(change)[0], async () => {
    const m = model(); m.faults.identity = r => ({ ...r, ...change });
    await assert.rejects(m.run('initialize'), { code: 'publisher-identity-mismatch' });
    assert.equal(m.files.has('current.json'), false); assert.equal(m.files.has('anchor.json'), false);
  });
});

test('controlled MainPID change during identity await or final fsync window never publishes active', async () => {
  for (const failAt of [2, 3]) {
    const m = model(); let n = 0;
    m.faults.inspect = v => ++n >= failAt ? { ...v, pid: v.pid + 1 } : v;
    await assert.rejects(m.run('initialize'), { code: 'publisher-instance-changed' });
    assert.equal(m.files.has('current.json'), false);
  }
});

test('controlled bootstrap is explicit, prior files/history cannot be reset and root mutex spans entire async operation', async () => {
  const m = model(); let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  const original = m.io.assertInitial; m.io.assertInitial = async () => { await original(); await gate; };
  const pending = m.run('initialize');
  await Promise.resolve(); await assert.rejects(m.run('initialize'), /locked/); unblock(); await pending;
  await assert.rejects(m.run('initialize'), { code: 'publisher-bootstrap-not-empty' });
  m.files.get('epoch-1.json').instance.pid++;
  await assert.rejects(m.run('rotate'), { code: 'publisher-history-mismatch' });
});

test('controlled third epoch checks complete owned history; corrupt/missing prior witness cannot stop a unit', async () => {
  const m = model(); await m.run('initialize'); await m.run('rotate');
  const good = clone(m.files.get('witness-2.json')); m.files.get('witness-2.json').observed.closed = false;
  m.calls.length = 0; await assert.rejects(m.run('rotate'), { code: 'publisher-history-mismatch' });
  assert.equal(m.calls.includes('stop'), false);
  m.files.set('witness-2.json', good);
  assert.equal((await m.run('rotate')).epoch, 3);
  m.files.delete('witness-2.json'); m.calls.length = 0;
  await assert.rejects(m.run('rotate'), { code: 'publisher-history-mismatch' });
  assert.equal(m.calls.includes('stop'), false);
});

test('production entry never accepts Windows/nonroot as OS evidence; CLI rejects fixture/force before IO and actually closes', async () => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    await assert.rejects(runAssetRootPublisher({ configFile: '/not-read', mode: 'initialize' }), { code: 'publisher-linux-root-required' });
  const script = fileURLToPath(new URL('../hosted/deploy/asset-root-registry-publisher.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--fixture'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stderr.on('data', chunk => { output += chunk; }); child.stdout.resume();
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 1); assert.match(output, /publisher-cli-invalid/); assert.equal(child.stdout.destroyed, true);
});

test('real TMP current rename followed by directory fsync failure may expose active, but must retain publisher lock', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-root-publication-red-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const m = model();
  // Windows cannot prove Linux directory durability. Only this boundary is
  // controlled; all writes, file fsyncs, rename/link, reads and locks are real.
  const directoryBarrier = async (_dir, item) => {
    if (item?.name === 'current.json' && item.value.state === 'active') throw Error('injected-post-rename-dir-fsync');
  };
  m.io.lock = () => openPublisherLock(dir, { directoryBarrier });
  const previousWrite = m.io.write;
  m.io.write = async (name, value, exclusive) => {
    await writePublisherArtifact({ dir, name, value, exclusive, directoryBarrier });
    await previousWrite(name, value, exclusive);
  };
  await assert.rejects(m.run('initialize'), /injected-post-rename-dir-fsync/);
  const visible = JSON.parse(await fs.readFile(path.join(dir, 'current.json'), 'utf8'));
  assert.equal(visible.state, 'active'); // Regression: "failure implies inactive" is false.
  assert.equal((await fs.lstat(path.join(dir, '.publisher.lock'))).isFile(), true);
});
