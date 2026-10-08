/** External root supervisor. Never run inside the target service cgroup.
 * CLI has no fixture/force/recover flag. A failed transition stays inactive;
 * a root operator must inspect its journal before any subsequent attempt.
 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { digestOf } from '../../account/ledger.mjs';

const fail = code => { const error = new Error(code); error.code = code; throw error; };
const equal = (a, b) => digestOf(a) === digestOf(b);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const ref = v => typeof v === 'string' && /^[A-Za-z0-9_.:@-]{1,128}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const positive = v => Number.isSafeInteger(v) && v > 0;
const boot = v => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const ticks = v => typeof v === 'string' && /^[1-9][0-9]{0,24}$/.test(v);
const SCOPE = ['authorityId', 'serviceIdentity', 'uid', 'unit', 'cgroupPath', 'clientFingerprint256', 'serverFingerprint256'];
const pin = v => String(v ?? '').replaceAll(':', '').toLowerCase();

export function validatePublisherScope(scope) {
  if (!exact(scope, SCOPE) || !ref(scope.authorityId) || !ref(scope.serviceIdentity) ||
      !positive(scope.uid) || !/^[A-Za-z0-9_.@-]+\.service$/.test(scope.unit) ||
      !/^\/sys\/fs\/cgroup\/[A-Za-z0-9_.@/-]+$/.test(scope.cgroupPath) ||
      scope.cgroupPath.split('/').slice(1).some(p => !p || p === '.' || p === '..') ||
      path.posix.normalize(scope.cgroupPath) !== scope.cgroupPath ||
      !hash(scope.clientFingerprint256) || !hash(scope.serverFingerprint256)) fail('publisher-scope-invalid');
  return structuredClone(scope);
}

export function parseProcStat(text) {
  // comm is parenthesized and may itself contain spaces or ')'.
  const end = text.lastIndexOf(')'), pid = Number(text.slice(0, text.indexOf(' ')));
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (end < 1 || !positive(pid) || !ticks(fields[19])) fail('publisher-proc-invalid');
  return { pid, startTicks: fields[19] };
}

function validateInstance(scope, instance) {
  if (!exact(instance, ['instanceId', 'bootId', 'pid', 'pidBirth', 'uid', 'unit', 'unitInvocationId', 'cgroup',
    'serviceIdentity', 'clientFingerprint256', 'serverFingerprint256']) || !ref(instance.instanceId) ||
      !boot(instance.bootId) || !positive(instance.pid) ||
      !exact(instance.pidBirth, ['bootId', 'startTicks']) || instance.pidBirth.bootId !== instance.bootId ||
      !ticks(instance.pidBirth.startTicks) || !/^[a-f0-9]{32}$/.test(instance.unitInvocationId) ||
      !exact(instance.cgroup, ['v2Path', 'dev', 'ino', 'bootId']) ||
      instance.cgroup.v2Path !== scope.cgroupPath || instance.cgroup.bootId !== instance.bootId ||
      !ticks(instance.cgroup.dev) || !ticks(instance.cgroup.ino)) fail('publisher-instance-invalid');
  for (const k of ['uid', 'unit', 'serviceIdentity', 'clientFingerprint256', 'serverFingerprint256'])
    if (instance[k] !== scope[k]) fail('publisher-scope-mismatch');
}

function activeRecord(scope, record) {
  if (!exact(record, ['v', 'authorityId', 'serviceId', 'epoch', 'state', 'instance', 'previous']) ||
      record.v !== 1 || record.authorityId !== scope.authorityId || record.serviceId !== 'asset' ||
      !positive(record.epoch) || record.state !== 'active') fail('publisher-current-invalid');
  validateInstance(scope, record.instance);
  if (record.epoch === 1 ? record.previous !== null :
    !exact(record.previous, ['epoch', 'registryDigest', 'instance', 'closureWitnessDigest']) ||
    record.previous.epoch !== record.epoch - 1 || !hash(record.previous.registryDigest) ||
    !hash(record.previous.closureWitnessDigest)) fail('publisher-chain-invalid');
}

/** Pure transaction coordinator. Injected IO in tests is a controlled model,
 * never an OS attestation. Only runAssetRootPublisher constructs production IO.
 */
export async function publishAssetRootRegistry({ scope, mode, io }) {
  scope = validatePublisherScope(scope);
  if (!['initialize', 'rotate'].includes(mode)) fail('publisher-mode-invalid');
  const release = await io.lock();
  try {
    const old = await io.read('current.json');
    const anchor = await io.read('anchor.json');
    if (mode === 'initialize') {
      if (old || anchor || await io.read('reservation.json') || await io.read('transition.json'))
        fail('publisher-bootstrap-not-empty');
      // Explicit --initialize is the root's fresh-deployment trust decision,
      // not evidence that a historical process was closed.
      await io.assertInitial();
    } else {
      if (!old || !anchor) fail('publisher-anchor-missing');
      activeRecord(scope, old);
      if (anchor.authorityId !== scope.authorityId || anchor.protocol !== 'promptcut.asset-root-anchor.v1' ||
          anchor.firstEpoch !== 1) fail('publisher-anchor-invalid');
      for (const k of SCOPE.filter(k => k !== 'authorityId')) if (anchor[k] !== scope[k]) fail('publisher-anchor-invalid');
      if (old.epoch === 1 && anchor.firstRegistryDigest !== digestOf(old)) fail('publisher-anchor-invalid');
      const committed = await io.read(`epoch-${old.epoch}.json`);
      if (!equal(old, committed)) fail('publisher-history-mismatch');
    }
    const epoch = old ? old.epoch + 1 : 1;
    if (!positive(epoch)) fail('publisher-epoch-overflow');
    const reservation = { v: 1, protocol: 'promptcut.asset-root-reservation.v1', ...scope,
      epoch, instanceId: io.uuid() };
    let witness = null;
    if (old) {
      // Pin exact kernel objects BEFORE making the known unit stop. This step
      // does not act on a numeric PID; no command targets a PID from disk.
      const pinned = await io.pinPrevious(old.instance);
      try {
        await io.write('current.json', { ...old, state: 'preparing' });
        await io.write('transition.json', { v: 1, phase: 'closing', fromDigest: digestOf(old), toEpoch: epoch });
        const observed = await pinned.stopAndObserve();
        if (!exact(observed, ['kind', 'closed', 'at', 'bootId', 'cgroup', 'unitInvocationId', 'pidBirth']) ||
            observed.kind !== 'cgroup-empty' || observed.closed !== true || !positive(observed.at) ||
            observed.bootId !== old.instance.bootId || !equal(observed.cgroup, old.instance.cgroup) ||
            observed.unitInvocationId !== old.instance.unitInvocationId || !equal(observed.pidBirth, old.instance.pidBirth))
          fail('publisher-closure-invalid');
        witness = { v: 1, protocol: 'promptcut.asset-os-closure.v1', witnessId: io.uuid(),
          authorityId: scope.authorityId, fromEpoch: old.epoch, toEpoch: epoch, previousRegistry: old, observed };
        await io.write(`witness-${epoch}.json`, witness, true);
      } finally { await pinned.close(); }
    }
    await io.write('reservation.json', reservation);
    await io.write('transition.json', { v: 1, phase: 'reserved', fromDigest: old ? digestOf(old) : null, toEpoch: epoch });
    await io.start();
    const before = await io.inspect(reservation);
    validateInstance(scope, before);
    const identity = await io.identity();
    const after = await io.inspect(reservation);
    validateInstance(scope, after);
    if (!equal(before, after) || (old && after.bootId !== old.instance.bootId)) fail('publisher-instance-changed');
    if (!exact(identity, ['v', 'serviceId', 'authorityId', 'epoch', 'instanceId', 'pid', 'startedAt', 'serviceIdentity',
      'docClientFingerprint256', 'internalServerFingerprint256', 'state']) || identity.v !== 1 ||
        identity.serviceId !== 'asset' || identity.authorityId !== scope.authorityId || identity.epoch !== epoch ||
        identity.instanceId !== reservation.instanceId || identity.instanceId !== after.instanceId ||
        identity.pid !== after.pid || identity.serviceIdentity !== scope.serviceIdentity || identity.state !== 'running' ||
        !positive(identity.startedAt) || identity.docClientFingerprint256 !== scope.clientFingerprint256 ||
        identity.internalServerFingerprint256 !== scope.serverFingerprint256) fail('publisher-identity-mismatch');
    const record = { v: 1, authorityId: scope.authorityId, serviceId: 'asset', epoch, state: 'active', instance: after,
      previous: old ? { epoch: old.epoch, registryDigest: digestOf(old), instance: old.instance,
        closureWitnessDigest: digestOf(witness) } : null };
    if (!old) await io.write('anchor.json', { v: 1, protocol: 'promptcut.asset-root-anchor.v1',
      ...scope, firstEpoch: 1, firstRegistryDigest: digestOf(record) }, true);
    await io.write(`epoch-${epoch}.json`, record, true);
    // Another check after filesystem awaits, before the sole authorization
    // publication. Death just after publication cannot prove an old socket.
    if (!equal(after, await io.inspect(reservation))) fail('publisher-instance-changed');
    await io.write('current.json', record);
    return { epoch, recordDigest: digestOf(record), anchorDigest: digestOf(old ? anchor : await io.read('anchor.json')) };
  } finally { await release(); }
}

async function rootDirectory(dir) {
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir) fail('publisher-path-untrusted');
  for (let p = dir; ; p = path.dirname(p)) {
    const st = await fs.lstat(p);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) fail('publisher-path-untrusted');
    if (p === path.dirname(p)) break;
  }
}
async function rootRead(filename, optional = false, bytes = false) {
  await rootDirectory(path.dirname(filename));
  let fd;
  try { fd = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o022) || st.size > 65536 || st.size < 1)
      fail('publisher-file-untrusted');
    const content = await fd.readFile();
    const last = await fs.lstat(filename);
    if (last.ino !== st.ino || last.dev !== st.dev || last.isSymbolicLink() || last.size !== st.size || last.mtimeMs !== st.mtimeMs)
      fail('publisher-file-changed');
    return bytes ? content : JSON.parse(content.toString('utf8'));
  } finally { await fd.close(); }
}
async function atomicWrite(dir, name, value, exclusive = false) {
  await rootDirectory(dir);
  const target = path.join(dir, name);
  if (exclusive && await rootRead(target, true)) fail('publisher-record-exists');
  const tmp = path.join(dir, `.${name}.${randomUUID()}.tmp`), fd = await fs.open(tmp, 'wx', 0o644);
  try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
  await fs.rename(tmp, target);
  const directory = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
const exec = args => new Promise((resolve, reject) => execFile('/usr/bin/systemctl', args,
  { windowsHide: true, timeout: 120000, maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) =>
    error ? reject(Object.assign(new Error('publisher-systemctl-failed'), { code: 'publisher-systemctl-failed' })) : resolve(stdout)));
async function unitInfo(unit) {
  const names = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup', 'InvocationID', 'KillMode', 'Delegate'];
  const raw = await exec(['show', unit, '--no-pager', ...names.map(n => `--property=${n}`)]);
  const value = Object.fromEntries(raw.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (value.Id !== unit || value.LoadState !== 'loaded' || value.KillMode !== 'control-group' || value.Delegate !== 'no')
    fail('publisher-unit-scope');
  return value;
}
async function bootId() { const v = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); if (!boot(v)) fail('publisher-boot-invalid'); return v; }
async function procInfo(pid) {
  const first = parseProcStat(await fs.readFile(`/proc/${pid}/stat`, 'utf8'));
  const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
  const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
  const cg = (await fs.readFile(`/proc/${pid}/cgroup`, 'utf8')).trim();
  const second = parseProcStat(await fs.readFile(`/proc/${pid}/stat`, 'utf8'));
  if (!equal(first, second) || first.pid !== pid || !ids || ids.slice(1).some(v => v !== ids[1]) || !/^0::\/[^\n]*$/.test(cg))
    fail('publisher-proc-changed');
  return { ...first, uid: Number(ids[1]), cgroupPath: `/sys/fs/cgroup${cg.slice(3)}` };
}
async function inspect(scope, reservation) {
  const before = await unitInfo(scope.unit), pid = Number(before.MainPID), bootBefore = await bootId();
  if (!positive(pid) || !['active', 'activating'].includes(before.ActiveState) ||
      `/sys/fs/cgroup${before.ControlGroup}` !== scope.cgroupPath || !/^[a-f0-9]{32}$/.test(before.InvocationID)) fail('publisher-unit-not-running');
  const proc = await procInfo(pid), cg = await fs.lstat(scope.cgroupPath, { bigint: true });
  if (!cg.isDirectory() || cg.isSymbolicLink() || proc.uid !== scope.uid || proc.cgroupPath !== scope.cgroupPath ||
      !equal(before, await unitInfo(scope.unit)) || bootBefore !== await bootId()) fail('publisher-proc-changed');
  return { instanceId: reservation.instanceId, bootId: bootBefore, pid,
    pidBirth: { bootId: bootBefore, startTicks: proc.startTicks }, uid: proc.uid, unit: scope.unit,
    unitInvocationId: before.InvocationID, cgroup: { v2Path: scope.cgroupPath, dev: String(cg.dev), ino: String(cg.ino), bootId: bootBefore },
    serviceIdentity: scope.serviceIdentity, clientFingerprint256: scope.clientFingerprint256, serverFingerprint256: scope.serverFingerprint256 };
}

async function freshIdentity(config, scope) {
  const [key, cert, ca] = await Promise.all(['keyFile', 'certFile', 'caFile'].map(k => rootRead(config[k], false, true)));
  return await new Promise((resolve, reject) => {
    let result, failure, socket;
    const req = https.request(new URL('/internal/v2/asset/run/identity', config.origin), {
      method: 'GET', agent: false, key, cert, ca, rejectUnauthorized: true, minVersion: 'TLSv1.3', timeout: 10000,
      checkServerIdentity(host, peer) { return checkServerIdentity(host, peer) ||
        (pin(peer.fingerprint256) !== scope.serverFingerprint256 ? new Error('publisher-tls-pin') : undefined); },
    }, res => {
      let length = 0; const chunks = [];
      res.on('data', chunk => { length += chunk.length; if (length > 16384) res.destroy(new Error('publisher-identity-size')); else chunks.push(chunk); });
      res.on('error', error => { failure = error; req.destroy(); });
      res.on('aborted', () => { failure = new Error('publisher-identity-aborted'); req.destroy(); });
      res.on('end', () => { try {
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (res.statusCode !== 200 || body.ok !== true) fail('publisher-identity-unavailable');
        result = body.result;
      } catch (e) { failure = e; } req.destroy(); socket?.destroy(); });
    });
    const complete = () => failure || !result ? reject(new Error('publisher-identity-unavailable')) : resolve(result);
    req.on('socket', s => { socket = s; s.once('close', complete); });
    req.on('error', e => { failure = e; if (!socket) complete(); });
    req.on('timeout', () => { failure = new Error('publisher-identity-timeout'); req.destroy(); }); req.end();
  });
}

export async function runAssetRootPublisher({ configFile, mode }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) fail('publisher-linux-root-required');
  const config = await rootRead(configFile);
  if (!exact(config, ['v', 'scope', 'registryDir', 'identity']) || config.v !== 1 ||
      !exact(config.identity, ['origin', 'keyFile', 'certFile', 'caFile'])) fail('publisher-config-invalid');
  const scope = validatePublisherScope(config.scope), dir = config.registryDir;
  const origin = new URL(config.identity.origin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
    fail('publisher-config-invalid');
  await rootDirectory(dir);
  const selfGroup = (await fs.readFile('/proc/self/cgroup', 'utf8')).trim();
  if (!/^0::\/[^\n]*$/.test(selfGroup) || scope.cgroupPath === `/sys/fs/cgroup${selfGroup.slice(3)}` ||
      `/sys/fs/cgroup${selfGroup.slice(3)}`.startsWith(`${scope.cgroupPath}/`)) fail('publisher-inside-target-cgroup');
  const io = {
    uuid: randomUUID,
    read: name => rootRead(path.join(dir, name), true),
    write: (name, value, exclusive) => atomicWrite(dir, name, value, exclusive),
    async lock() {
      const filename = path.join(dir, '.publisher.lock'), fd = await fs.open(filename, 'wx', 0o600);
      const stat = await fd.stat(); await fd.writeFile(JSON.stringify({ pid: process.pid })); await fd.sync();
      return async () => { try {
        const current = await fs.lstat(filename);
        if (current.ino !== stat.ino || current.dev !== stat.dev || current.isSymbolicLink()) fail('publisher-lock-changed');
        await fs.unlink(filename);
      } finally { await fd.close(); } };
    },
    async assertInitial() {
      const unit = await unitInfo(scope.unit);
      if (unit.ActiveState !== 'inactive' || Number(unit.MainPID) !== 0) fail('publisher-bootstrap-unit-active');
      const files = await fs.readdir(dir);
      if (files.some(n => n !== '.publisher.lock')) fail('publisher-bootstrap-not-empty');
    },
    async pinPrevious(previous) {
      if (!equal(previous, await inspect(scope, previous))) fail('publisher-previous-instance-mismatch');
      const group = await fs.open(scope.cgroupPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      let events;
      try {
        const st = await group.stat({ bigint: true });
        if (String(st.dev) !== previous.cgroup.dev || String(st.ino) !== previous.cgroup.ino) fail('publisher-cgroup-changed');
        events = await fs.open(`/proc/self/fd/${group.fd}/cgroup.events`, constants.O_RDONLY | constants.O_NOFOLLOW);
        return {
          async stopAndObserve() {
            // Start exact configured unit stop, immediately attach its rejection
            // handler, and inspect the pinned object while systemd drains it.
            const stopping = exec(['stop', scope.unit, '--no-ask-password']).then(() => ({ ok: true }), () => ({ ok: false }));
            const deadline = Date.now() + 120000; let empty = false;
            try {
              while (Date.now() < deadline) {
                const buffer = Buffer.alloc(4096), { bytesRead } = await events.read(buffer, 0, buffer.length, 0);
                const text = buffer.subarray(0, bytesRead).toString('utf8');
                if (!/^populated [01]$/m.test(text)) fail('publisher-cgroup-observation-invalid');
                const st2 = await group.stat({ bigint: true });
                if (String(st2.dev) !== previous.cgroup.dev || String(st2.ino) !== previous.cgroup.ino || await bootId() !== previous.bootId)
                  fail('publisher-cgroup-changed');
                let gone = false;
                try { const p = parseProcStat(await fs.readFile(`/proc/${previous.pid}/stat`, 'utf8')); gone = p.startTicks !== previous.pidBirth.startTicks; }
                catch (e) { if (e.code === 'ENOENT') gone = true; else throw e; }
                if (/^populated 0$/m.test(text) && gone) { empty = true; break; }
                await new Promise(resolve => setTimeout(resolve, 20));
              }
            } finally { if (!(await stopping).ok) fail('publisher-stop-failed'); }
            if (!empty) fail('publisher-closure-unproved');
            const unit = await unitInfo(scope.unit);
            if (unit.ActiveState !== 'inactive' || Number(unit.MainPID) !== 0) fail('publisher-unit-not-stopped');
            return { kind: 'cgroup-empty', closed: true, at: Date.now(), bootId: previous.bootId,
              cgroup: previous.cgroup, unitInvocationId: previous.unitInvocationId, pidBirth: previous.pidBirth };
          },
          async close() { await events.close(); await group.close(); },
        };
      } catch (e) { await events?.close(); await group.close(); throw e; }
    },
    start: () => exec(['start', scope.unit, '--no-ask-password']),
    inspect: reservation => inspect(scope, reservation),
    identity: () => freshIdentity(config.identity, scope),
  };
  return await publishAssetRootRegistry({ scope, mode, io });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || args[0] !== '--config' || !['--initialize', '--rotate'].includes(args[2])) fail('publisher-cli-invalid');
    const result = await runAssetRootPublisher({ configFile: args[1], mode: args[2].slice(2) });
    process.stdout.write(JSON.stringify({ ok: true, epoch: result.epoch, recordDigest: result.recordDigest, anchorDigest: result.anchorDigest }) + '\n');
  } catch (e) {
    process.stderr.write(JSON.stringify({ ok: false, code: /^publisher-[a-z-]+$/.test(e.code ?? '') ? e.code : 'publisher-failed' }) + '\n');
    process.exitCode = 1;
  }
}
