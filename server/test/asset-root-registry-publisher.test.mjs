import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digestOf } from '../account/ledger.mjs';
import { publishAssetRootRegistry, parseProcStat, validatePublisherScope, validatePublisherUnit, runAssetRootPublisher,
  writePublisherArtifact, openPublisherLock, publishAssetRootRegistryV2, runAssetRootPublisherV2,
  validatePublisherRuntimeAdapterV2, writePublisherTextV2 } from '../hosted/deploy/asset-root-registry-publisher.mjs';
import { assetClosureUnitV2, validateAssetRootHistoryV2 } from '../hosted/asset-root-registry-schema-v2.mjs';

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
    async lock() { if (locked) throw Error('locked'); locked = true; calls.push('lock'); return async ({ publicationDurable }) => {
      if (publicationDurable) { locked = false; calls.push('unlock'); } else calls.push('retain-lock');
    }; },
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
    'start', 'inspect', 'identity', 'inspect', 'write:epoch-2.json:active', 'inspect', 'write:current.json:active',
    'write:publication-2.json:', 'unlock']);
  const publication = m.files.get('publication-2.json');
  assert.deepEqual(publication, { v: 1, protocol: 'promptcut.asset-root-publication.v1', authorityId: scope.authorityId,
    epoch: 2, registryDigest: digestOf(value), anchorDigest: digestOf(m.files.get('anchor.json')),
    closureWitnessDigest: digestOf(witness), reservationDigest: digestOf(m.files.get('reservation.json')) });
});

test('controlled incorrect old process refuses stop; ENOENT observation remains inactive and never starts', async () => {
  const wrong = model(); await wrong.run('initialize'); wrong.calls.length = 0; wrong.faults.pin = true;
  await assert.rejects(wrong.run('rotate'), /wrong-process/); assert.equal(wrong.calls.includes('stop'), false);
  const m = model(); await m.run('initialize'); m.calls.length = 0; m.faults.stop = true;
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

test('controlled pre-write cuts leave nonactive and retain lock; these do not model post-rename failure', async t => {
  for (const name of ['transition.json', 'witness-2.json', 'reservation.json', 'epoch-2.json', 'current-active']) {
    await t.test(name, async () => {
      const m = model(); await m.run('initialize');
      m.faults.write = (file, value) => name === 'current-active' ? file === 'current.json' && value.state === 'active' : file === name;
      await assert.rejects(m.run('rotate'), /fsync-failed/);
      assert.notEqual(m.files.get('current.json').state, 'active');
      delete m.faults.write; await assert.rejects(m.run('rotate'), /locked/);
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
  const corrupt = model(); await corrupt.run('initialize'); corrupt.files.get('epoch-1.json').instance.pid++;
  await assert.rejects(corrupt.run('rotate'), { code: 'publisher-history-mismatch' });
});

test('controlled third epoch checks complete owned history; corrupt/missing prior witness cannot stop a unit', async () => {
  for (const corrupt of [true, false]) {
    const m = model(); await m.run('initialize'); await m.run('rotate');
    assert.equal((await m.run('rotate')).epoch, 3);
    if (corrupt) m.files.get('witness-2.json').observed.closed = false; else m.files.delete('witness-2.json');
    m.calls.length = 0; await assert.rejects(m.run('rotate'), { code: 'publisher-history-mismatch' });
    assert.equal(m.calls.includes('stop'), false);
  }
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
  t.diagnostic('actual active JSON visible after rename; injected directory barrier failure; lock retained; no accepted checkpoint claim');
});

async function diskModel(t, directoryBarrier, lockBarrier = directoryBarrier) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-root-publication-files-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const m = model(), original = m.io.write;
  m.io.lock = () => openPublisherLock(dir, { directoryBarrier: lockBarrier });
  m.io.write = async (name, value, exclusive) => {
    await writePublisherArtifact({ dir, name, value, exclusive, directoryBarrier });
    await original(name, value, exclusive);
  };
  return { ...m, dir, readDisk: async name => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) };
}

test('real TMP publication hardlink visible then directory barrier fails: marker alone never permits unlock', async t => {
  const m = await diskModel(t, async (_dir, item) => {
    if (item?.name === 'publication-1.json') throw Error('injected-post-link-dir-fsync');
  });
  await assert.rejects(m.run('initialize'), /injected-post-link-dir-fsync/);
  const record = await m.readDisk('current.json'), marker = await m.readDisk('publication-1.json');
  assert.equal(record.state, 'active'); assert.equal(marker.registryDigest, digestOf(record));
  assert.equal((await fs.lstat(path.join(m.dir, 'publication-1.json'))).nlink, 1);
  assert.equal((await fs.lstat(path.join(m.dir, '.publisher.lock'))).isFile(), true);
  await assert.rejects(openPublisherLock(m.dir), { code: 'EEXIST' });
  t.diagnostic('actual active + publication marker visible; injected post-link barrier failure; lock retained; marker is not sole authorization');
});

test('real TMP in-flight publication barrier keeps lock; only successful completion removes it and binds every digest', async t => {
  let entered, finish; const arrived = new Promise(r => { entered = r; }), gate = new Promise(r => { finish = r; });
  const m = await diskModel(t, async (_dir, item) => { if (item?.name === 'publication-1.json') { entered(); await gate; } });
  const running = m.run('initialize'); await arrived;
  const marker = await m.readDisk('publication-1.json');
  assert.equal((await fs.lstat(path.join(m.dir, '.publisher.lock'))).isFile(), true);
  finish(); const result = await running;
  await assert.rejects(fs.lstat(path.join(m.dir, '.publisher.lock')), { code: 'ENOENT' });
  assert.equal(marker.registryDigest, digestOf(await m.readDisk('current.json')));
  assert.equal(marker.anchorDigest, digestOf(await m.readDisk('anchor.json')));
  assert.equal(marker.reservationDigest, digestOf(await m.readDisk('reservation.json')));
  assert.equal(marker.closureWitnessDigest, null); assert.equal(result.recordDigest, marker.registryDigest);
  t.diagnostic('real file operations; controlled directory barrier on Windows; no Linux durability/power-loss claim');
});

test('real TMP unlock barrier failure has unknown CLI result but cannot undo already completed publication', async t => {
  let locks = 0;
  const m = await diskModel(t, async () => {}, async () => { if (++locks === 2) throw Error('injected-unlink-dir-fsync'); });
  await assert.rejects(m.run('initialize'), { code: 'publisher-unlock-result-unknown' });
  await assert.rejects(fs.lstat(path.join(m.dir, '.publisher.lock')), { code: 'ENOENT' });
  const marker = await m.readDisk('publication-1.json');
  assert.equal(marker.registryDigest, digestOf(await m.readDisk('current.json')));
  assert.equal(marker.anchorDigest, digestOf(await m.readDisk('anchor.json')));
  t.diagnostic('unlock result unknown; marker/active barriers completed before unlink; failure is NOT a claim of inactive');
});

test('prior active without exact publication completion marker cannot be rotated', async () => {
  for (const field of ['missing', 'anchorDigest', 'reservationDigest', 'closureWitnessDigest']) {
    const m = model(); await m.run('initialize');
    if (field === 'missing') m.files.delete('publication-1.json');
    else m.files.get('publication-1.json')[field] = 'f'.repeat(64);
    m.calls.length = 0;
    await assert.rejects(m.run('rotate'), { code: 'publisher-publication-missing' });
    assert.equal(m.calls.includes('stop'), false); assert.ok(m.calls.includes('retain-lock'));
  }
});

const expectedV2 = { authorityId: scope.authorityId, serviceIdentity: scope.serviceIdentity, uid: scope.uid, unit: scope.unit,
  clientFingerprint256: scope.clientFingerprint256, serverFingerprint256: scope.serverFingerprint256,
  closurePolicy: { kind: 'systemd-slice', unitNamespace: 'pcassetmodel', cgroupRoot: '/sys/fs/cgroup', placement: 'direct-child', singleEpoch: true } };
// Controlled ordering/failure model only: these callbacks attest no real OS,
// runtime drop-in, TLS identity, or production resource closure.
function modelV2() {
  const files = new Map(), calls = [], faults = {}; let serial = 0, locked = false, current;
  const io = {
    uuid: () => `id-${++serial}`, scopeId: () => String(++serial).padStart(32, '0'),
    async lock() { if (locked) throw Error('locked'); locked = true; calls.push('lock'); return async ({ publicationDurable }) => {
      if (publicationDurable) { locked = false; calls.push('unlock'); } else calls.push('retain-lock');
    }; },
    async read(name) { return clone(files.get(name) ?? null); },
    async write(name, value, exclusive) {
      calls.push(`write:${name}:${value.state ?? value.phase ?? ''}`);
      if (exclusive && files.has(name)) throw Error('exists');
      if (faults.beforeWrite?.(name, value)) throw Error('injected-before-write');
      files.set(name, clone(value));
      if (faults.afterWrite?.(name, value)) throw Error('injected-post-visible-fsync');
    },
    async assertInitial() { calls.push('initial'); },
    async pinPrevious(old) {
      calls.push('pin');
      return {
        async stopAndObserve() {
          calls.push('stop'); if (faults.stop) throw Error('ENODEV');
          const observed = { kind: 'cgroup-empty', closed: true, at: 100, bootId, serviceInstance: clone(old.instance),
            closureScope: clone(old.closureScope), scopeActive: true, scopeExclusive: true, populated: 0, serviceInactive: true, mainBirthGone: true };
          return faults.observed ? faults.observed(observed) : observed;
        },
        async releaseScope() { calls.push('release-scope'); if (faults.release) throw Error('release-failed'); },
        async close() { calls.push('close-pinned-fd'); },
      };
    },
    async createScope(plan) {
      calls.push('create-scope'); if (faults.create) throw Error('collision');
      const unit = assetClosureUnitV2(expectedV2, plan);
      return { ...plan, authorityId: expectedV2.authorityId, kind: 'systemd-slice', unit,
        unitInvocationId: String(plan.epoch * 2).padStart(32, '0'), bootId,
        cgroup: { v2Path: `/sys/fs/cgroup/${unit}`, dev: '30', ino: String(300 + plan.epoch), bootId } };
    },
    async configureService() { calls.push('configure-service'); if (faults.configure) throw Error('foreign-dropin'); },
    async start(r) {
      calls.push('start');
      const value = instance(r.instanceId, r.epoch); value.cgroup.v2Path = r.serviceCgroupPath;
      value.unitInvocationId = String(r.epoch * 2 + 1).padStart(32, '0');
      current = { instance: value, closureScope: clone(r.closureScope) };
    },
    async inspect() { calls.push('inspect'); return faults.inspect ? faults.inspect(clone(current)) : clone(current); },
    async identity() {
      calls.push('identity'); const r = files.get('reservation.json');
      const value = { v: 1, serviceId: 'asset', authorityId: expectedV2.authorityId, epoch: r.epoch, instanceId: r.instanceId,
        pid: current.instance.pid, startedAt: 100, serviceIdentity: expectedV2.serviceIdentity, state: 'running',
        docClientFingerprint256: expectedV2.clientFingerprint256, internalServerFingerprint256: expectedV2.serverFingerprint256 };
      return faults.identity ? faults.identity(value) : value;
    },
  };
  return { io, files, calls, faults, run: mode => publishAssetRootRegistryV2({ expected: expectedV2, mode, io }) };
}

test('v2 controlled two-epoch publisher persists witness before releasing old scope, archives every reservation and keeps new scope', async () => {
  const m = modelV2(); await m.run('initialize'); m.calls.length = 0;
  const cp = await m.run('rotate'); assert.equal(cp.v, 2); assert.equal(cp.epoch, 2);
  const pos = call => m.calls.indexOf(call);
  assert.ok(pos('write:witness-2.json:') < pos('release-scope'));
  assert.ok(pos('release-scope') < pos('create-scope'));
  assert.ok(pos('write:reservation-2.json:') < pos('configure-service'));
  assert.ok(pos('configure-service') < pos('start'));
  assert.ok(pos('write:publication-2.json:') < pos('unlock'));
  assert.equal(m.calls.filter(c => c === 'release-scope').length, 1);
  const entries = [1, 2].map(n => ({ record: m.files.get(`epoch-${n}.json`), reservation: m.files.get(`reservation-${n}.json`),
    publication: m.files.get(`publication-${n}.json`), witness: n === 1 ? null : m.files.get(`witness-${n}.json`) }));
  assert.deepEqual(validateAssetRootHistoryV2({ entries, currentRecord: m.files.get('current.json'), anchor: m.files.get('anchor.json'),
    expected: expectedV2, publisherLocked: false }), cp);
});

test('v2 controlled faults never release old scope before durable empty witness or authorize new active generation', async t => {
  for (const [name, set, forbidden] of [
    ['ENODEV', m => { m.faults.stop = true; }, 'release-scope'],
    ['populated', m => { m.faults.observed = o => ({ ...o, populated: 1 }); }, 'release-scope'],
    ['wrong tuple', m => { m.faults.observed = o => ({ ...o, closureScope: { ...o.closureScope, unitInvocationId: 'f'.repeat(32) } }); }, 'release-scope'],
    ['witness visible but fsync fails', m => { m.faults.afterWrite = n => n === 'witness-2.json'; }, 'release-scope'],
    ['release unknown', m => { m.faults.release = true; }, 'create-scope'],
    ['scope collision', m => { m.faults.create = true; }, 'configure-service'],
    ['foreign configuration', m => { m.faults.configure = true; }, 'start'],
    ['identity mismatch', m => { m.faults.identity = o => ({ ...o, instanceId: 'other' }); }, 'write:current.json:active'],
  ]) await t.test(name, async () => {
    const m = modelV2(); await m.run('initialize'); m.calls.length = 0; set(m);
    await assert.rejects(m.run('rotate')); assert.equal(m.calls.includes(forbidden), false);
    assert.equal(m.files.get('current.json').state, 'preparing'); assert.ok(m.calls.includes('retain-lock'));
  });
});

test('v2 refuses missing reservation history before any stop and rejects implicit v1 upgrade', async () => {
  const m = modelV2(); await m.run('initialize'); m.files.delete('reservation-1.json'); m.calls.length = 0;
  await assert.rejects(m.run('rotate')); assert.equal(m.calls.includes('stop'), false);
  const old = model(); await old.run('initialize');
  await assert.rejects(publishAssetRootRegistryV2({ expected: expectedV2, mode: 'rotate', io: old.io }));
  assert.equal(old.calls.includes('stop'), false);
});

test('v2 visible active/marker write failures retain exclusion, not a fictitious rollback', async () => {
  for (const name of ['current.json', 'publication-1.json']) {
    const m = modelV2(); m.faults.afterWrite = (n, value) => n === name && (n !== 'current.json' || value.state === 'active');
    await assert.rejects(m.run('initialize'));
    assert.equal(m.files.get('current.json').state, 'active'); assert.ok(m.calls.includes('retain-lock'));
    assert.equal(m.calls.includes('unlock'), false);
  }
});

test('v2 third epoch cannot reuse nonadjacent history identities or invocations', async () => {
  for (const field of ['scopeId', 'instanceId', 'unitInvocationId']) {
    const m = modelV2(); await m.run('initialize'); await m.run('rotate'); m.calls.length = 0;
    const first = m.files.get('epoch-1.json');
    if (field === 'scopeId') m.io.scopeId = () => first.closureScope.scopeId;
    if (field === 'instanceId') m.io.uuid = () => first.instance.instanceId;
    if (field === 'unitInvocationId') m.faults.inspect = pair => {
      pair.instance.unitInvocationId = first.instance.unitInvocationId; return pair;
    };
    await assert.rejects(m.run('rotate'));
    if (field !== 'unitInvocationId') assert.equal(m.calls.includes('stop'), false);
    assert.equal(m.files.has('epoch-3.json'), false);
    assert.equal(m.files.has('publication-3.json'), false);
    assert.ok(m.calls.includes('retain-lock'));
  }
});

test('v2 runtime configuration permits only exact owned drop-in and immutable declared base set; Linux root gate remains', async () => {
  const adapter = { unitFragment: { path: '/etc/systemd/system/promptcut-asset-test.service', sha256: 'a'.repeat(64) },
    baseDropIns: [], ownDropInPath: `/run/systemd/system/${expectedV2.unit}.d/90-promptcut-root-slice.conf` };
  assert.deepEqual(validatePublisherRuntimeAdapterV2(adapter, expectedV2), adapter);
  for (const changed of [{ ...adapter, ownDropInPath: '/etc/systemd/system/other.service.d/90.conf' },
    { ...adapter, baseDropIns: [{ path: adapter.ownDropInPath, sha256: 'b'.repeat(64) }] },
    { ...adapter, unitFragment: { path: '/etc/systemd/system/../other', sha256: 'a'.repeat(64) } }, { ...adapter, force: true }])
    assert.throws(() => validatePublisherRuntimeAdapterV2(changed, expectedV2));
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    await assert.rejects(runAssetRootPublisherV2({ configFile: 'not-read', mode: 'initialize' }), { code: 'publisher-linux-root-required' });
});

test('v2 real file drop-in replacement refuses foreign contents/inode; post-rename fsync failure retains real lock', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-root-v2-dropin-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'owned.conf');
  const first = await writePublisherTextV2({ filename, text: '[Service]\nSlice=old.slice\n', directoryBarrier: async () => {} });
  await assert.rejects(writePublisherTextV2({ filename, text: 'foreign replacement', directoryBarrier: async () => {} }), { code: 'publisher-dropin-ownership' });
  await assert.rejects(writePublisherTextV2({ filename, text: 'foreign replacement', previous: { ...first, ino: '999999' },
    directoryBarrier: async () => {} }), { code: 'publisher-dropin-ownership' });
  const release = await openPublisherLock(dir, { directoryBarrier: async () => {} });
  try {
    await assert.rejects(writePublisherTextV2({ filename, text: '[Service]\nSlice=new.slice\n', previous: first,
      directoryBarrier: async () => { throw Error('post-rename-directory-fsync'); } }), /post-rename-directory-fsync/);
  } finally { await release({ publicationDurable: false }); }
  assert.equal(await fs.readFile(filename, 'utf8'), '[Service]\nSlice=new.slice\n');
  assert.ok((await fs.lstat(path.join(dir, '.publisher.lock'))).isFile());
  await assert.rejects(openPublisherLock(dir, { directoryBarrier: async () => {} }), { code: 'EEXIST' });
  await assert.rejects(writePublisherTextV2({ filename, text: 'stale receipt', previous: first, directoryBarrier: async () => {} }), { code: 'publisher-dropin-ownership' });
  t.diagnostic('Real Windows file/rename/lock; injected directory fsync failure, not Linux unit or durability proof');
});
