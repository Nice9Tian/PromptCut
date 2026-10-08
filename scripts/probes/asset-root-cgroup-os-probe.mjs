/** Linux/root OS experiments. The original --user experiment never invokes
 * publisher; the separate --publisher-v2 mode uses its actual root entry.
 * Usage: node ... --user <existing-dedicated-asset-user> [--out <new-absolute-dir>]
 * Root creates one random transient service inside its own active slice and its
 * own TCP server on 6540, after checking ALL 6540..6549 are free. Evidence stays.
 * systemd 249: main exits on SIGTERM; child keeps real fd/TCP for two seconds.
 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const now = () => performance.now();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeCode = e => /^[A-Z0-9_-]+$|^probe-[a-z-]+$/.test(e?.code ?? '') ? e.code : 'probe-error';
const fileSelf = fileURLToPath(import.meta.url);
const unitPrefix = 'pc-asset-cgroup-proof-';
const procStat = text => {
  const end = text.lastIndexOf(')'), fields = text.slice(end + 2).trim().split(/\s+/);
  if (!/^[1-9][0-9]* \(/.test(text) || !/^[1-9][0-9]*$/.test(fields[19])) fail('probe-proc-invalid');
  return { pid: Number(text.slice(0, text.indexOf(' '))), startTicks: fields[19] };
};
async function processInfo(pid) {
  const first = procStat(await fs.readFile(`/proc/${pid}/stat`, 'utf8'));
  const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
  const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
  const cg = (await fs.readFile(`/proc/${pid}/cgroup`, 'utf8')).trim();
  const last = procStat(await fs.readFile(`/proc/${pid}/stat`, 'utf8'));
  if (!uid || uid.slice(1).some(v => v !== uid[1]) || first.pid !== pid || first.startTicks !== last.startTicks || !/^0::\/[^\n]+$/.test(cg))
    fail('probe-proc-changed');
  return { ...first, uid: Number(uid[1]), cgroup: cg.slice(3) };
}
async function birthGone(record) {
  try { return procStat(await fs.readFile(`/proc/${record.pid}/stat`, 'utf8')).startTicks !== record.startTicks; }
  catch (e) { if (e.code === 'ENOENT') return true; throw e; }
}
async function listeners() {
  const result = [];
  for (const name of ['tcp', 'tcp6']) {
    const table = await fs.readFile(`/proc/net/${name}`, 'utf8');
    for (const line of table.trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/), port = Number.parseInt(fields[1]?.split(':')[1], 16);
      if (fields[3] === '0A' && port >= 6540 && port <= 6549) result.push({ family: name, port });
    }
  }
  return result;
}
function command(executable, args, timeout) {
  return new Promise(resolve => execFile(executable, args, { windowsHide: true,
    timeout: Math.max(1, Math.floor(timeout)), maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) => {
    resolve({ code: error ? typeof error.code === 'number' ? error.code : 1 : 0,
      stdout: stdout ?? '', timedOut: !!error?.killed });
  }));
}
async function describe(unit, timeout) {
  const names = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup', 'Description', 'User', 'Restart', 'KillMode', 'Delegate',
    'Slice', 'InvocationID', 'Transient', 'StopWhenUnneeded', 'FragmentPath', 'SourcePath', 'DropInPaths', 'Job', 'Following'];
  const result = await command('/usr/bin/systemctl', ['show', unit, '--no-pager', '--all', ...names.map(n => `--property=${n}`)], timeout);
  if (result.timedOut) fail('probe-systemctl-timeout');
  const value = Object.fromEntries(result.stdout.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  return value;
}

export function assertUnusedSlice(state, slice) {
  // v249 unit_is_pristine explicitly permits LOADED synthetic slices. show
  // itself loads this implicit object. Still reject configured, used, queued,
  // transient, merged/other-ID and non-default objects; never relax service.
  if (!/^pcassetproof[a-f0-9]{16}\.slice$/.test(slice) || state.Id !== slice ||
      state.LoadState !== 'loaded' || state.ActiveState !== 'inactive' || state.SubState !== 'dead' ||
      // systemctl v249 prints an absent D-Bus Job (0, '/') as Job=, not Job=0.
      state.Transient !== 'no' || state.StopWhenUnneeded !== 'no' || state.Job !== '' || state.Following !== '' ||
      state.Description !== `Slice /${slice.slice(0, -6)}` || state.User || state.MainPID ||
      ['FragmentPath', 'SourcePath', 'DropInPaths', 'InvocationID', 'ControlGroup'].some(key => state[key] !== ''))
    fail('probe-unit-exists');
}

async function durableJSON(root, name, value) {
  const file = await fs.open(path.join(root, name), 'wx', 0o644);
  try { await file.chmod(0o644); await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  const directory = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

// No sibling workload/sentinel is permitted. Read the actual cgroup tree; never
// subtract an observer PID from populated or migrate any process to make it empty.
async function inventory(cgroup) {
  const groups = [], pids = [];
  async function visit(dir) {
    if (groups.length >= 16) fail('probe-scope-inventory-too-large');
    groups.push(dir);
    const text = (await fs.readFile(path.join(dir, 'cgroup.procs'), 'utf8')).trim();
    if (text) for (const line of text.split('\n')) {
      if (!/^[1-9][0-9]*$/.test(line)) fail('probe-scope-inventory-invalid');
      pids.push(Number(line));
    }
    for (const entry of await fs.readdir(dir, { withFileTypes: true }))
      if (entry.isDirectory()) await visit(path.join(dir, entry.name));
  }
  await visit(cgroup);
  return { groups, pids: [...new Set(pids)].sort((a, b) => a - b) };
}

async function worker(role, manifestFile) {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || !['parent', 'child'].includes(role)) fail('probe-worker-forbidden');
  const st = await fs.lstat(manifestFile);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) fail('probe-worker-manifest');
  const cfg = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const info = await processInfo(process.pid);
  if (!new RegExp(`^${unitPrefix}[a-f0-9]{16}\\.service$`).test(cfg.unit) || info.uid !== cfg.uid ||
      !/^pcassetproof[a-f0-9]{16}\.slice$/.test(cfg.slice) || cfg.serviceCgroup !== `/${cfg.slice}/${cfg.unit}` ||
      info.cgroup !== cfg.serviceCgroup || cfg.port !== 6540 || cfg.root !== path.dirname(manifestFile)) fail('probe-worker-scope');
  const resource = path.join(cfg.root, 'data', `${role}.bin`), handle = await fs.open(resource, 'wx');
  await handle.writeFile('owned-cgroup-os-smoke\n'); await handle.sync();
  const socket = net.createConnection({ host: '127.0.0.1', port: cfg.port });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.on('error', () => {});
  socket.write(JSON.stringify({ role, pid: process.pid, fd: handle.fd }) + '\n');
  let stopping = false;
  if (role === 'parent') {
    process.on('SIGTERM', () => process.exit(0));
    const child = spawn(process.execPath, [fileSelf, '--worker', 'child', manifestFile], {
      windowsHide: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' },
    });
    child.on('error', () => process.exit(2));
  } else process.on('SIGTERM', () => {
    if (stopping) return; stopping = true;
    // Deliberate one-shot negative window, NOT a completion timeout extension.
    setTimeout(() => { void (async () => {
      await handle.close();
      const closed = new Promise(resolve => socket.once('close', resolve)); socket.end();
      await closed; process.exit(0);
    })().catch(() => process.exit(3)); }, 2000);
  });
}

export async function runAssetCgroupOSProbe({ user, out }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) fail('probe-linux-root-required');
  if (typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) fail('probe-user-invalid');
  const start = now(), deadline = start + 20000, totalDeadline = start + 30000;
  const time = () => Math.max(1, deadline - now());
  const id = randomBytes(8).toString('hex'), unit = `${unitPrefix}${id}.service`, description = `PromptCut asset cgroup OS proof ${id}`;
  const slice = `pcassetproof${id}.slice`, sliceDescription = `PromptCut exclusive asset closure scope ${id}`;
  const scopePath = `/${slice}`, servicePath = `${scopePath}/${unit}`, scopeDirectory = `/sys/fs/cgroup${scopePath}`;
  const result = { v: 2, ok: false, unit, slice, port: 6540, negativeObserved: false, emptyObserved: false,
    eventsReadError: null, stopIssued: 0, samples: [], checks: {}, errors: [], productionMounted: false };
  let root, server, group, events, launchAttempted = false, stopTask, stopResult, main, child, groupStat;
  let sliceAttempted = false, sliceInvocation, serviceInvocation, evidenceDurable = false;
  const sockets = new Set(), peers = new Map();
  async function issueStop() {
    if (stopTask) return stopTask;
    const state = await describe(unit, Math.min(2000, totalDeadline - now()));
    if (state.Id !== unit || state.Description !== description || ![user, String(result.uid)].includes(state.User) ||
        state.Transient !== 'yes' || state.Slice !== slice || serviceInvocation && state.InvocationID !== serviceInvocation ||
        state.ControlGroup && state.ControlGroup !== servicePath) fail('probe-stop-ownership-unproved');
    const scope = await verifyScope();
    if (scope.ActiveState !== 'active') fail('probe-stop-ownership-unproved');
    const owned = await inventory(scopeDirectory);
    if (owned.groups.some(g => g !== scopeDirectory && g !== `/sys/fs/cgroup${servicePath}`)) fail('probe-scope-not-exclusive');
    // Before verified parent/child setup, still require all current processes to
    // be the same dedicated UID and in this exact service, never a sibling.
    for (const pid of owned.pids) {
      const info = await processInfo(pid);
      if (info.uid !== result.uid || info.cgroup !== servicePath || main && child && ![main.pid, child.pid].includes(pid))
        fail('probe-stop-ownership-unproved');
    }
    result.stopIssued++;
    stopTask = command('/usr/bin/systemctl', ['stop', unit, '--no-ask-password'], Math.min(7000, totalDeadline - now()))
      .then(value => { stopResult = { code: value.code, timedOut: value.timedOut }; return stopResult; });
    return stopTask;
  }
  async function verifyScope() {
    const state = await describe(slice, Math.min(2000, totalDeadline - now()));
    // A slice has no ExecContext and no User. Its ownership is the unique root
    // transient unit/description/invocation/cgroup, not an invented UID value.
    if (state.Id !== slice || state.Description !== sliceDescription || state.Transient !== 'yes' || state.User ||
        state.StopWhenUnneeded !== 'no' || state.ControlGroup !== scopePath || !/^[a-f0-9]{32}$/.test(state.InvocationID ?? '') ||
        sliceInvocation && state.InvocationID !== sliceInvocation) fail('probe-slice-ownership-unproved');
    return state;
  }
  async function readPinnedPopulated() {
    const buf = Buffer.alloc(4096), read = await events.read(buf, 0, buf.length, 0);
    const match = /^populated ([01])$/m.exec(buf.subarray(0, read.bytesRead).toString('utf8'));
    const same = await group.stat({ bigint: true });
    const current = await fs.lstat(scopeDirectory, { bigint: true });
    if (!match || same.dev !== groupStat.dev || same.ino !== groupStat.ino || current.isSymbolicLink() ||
        current.dev !== groupStat.dev || current.ino !== groupStat.ino) fail('probe-pinned-object-changed');
    return Number(match[1]);
  }
  async function checkSliceVacancy() {
    const state = await describe(slice, time());
    assertUnusedSlice(state, slice);
    // ENOENT is only a pre-creation collision check. It is never closure proof.
    try { await fs.lstat(scopeDirectory); }
    catch (e) { if (e.code === 'ENOENT') return state; throw e; }
    fail('probe-slice-path-exists');
  }
  try {
    if (await fs.readlink('/proc/self/ns/net') !== await fs.readlink('/proc/1/ns/net')) fail('probe-network-namespace');
    result.preflightListeners = await listeners(); if (result.preflightListeners.length) fail('probe-port-occupied');
    const initial = await describe(unit, time()); if (initial.LoadState !== 'not-found') fail('probe-unit-exists');
    result.slicePreflight = await checkSliceVacancy();
    const uid = await command('/usr/bin/id', ['-u', '--', user], time()), gid = await command('/usr/bin/id', ['-g', '--', user], time());
    if (uid.code || gid.code || !/^[1-9][0-9]*\s*$/.test(uid.stdout) || !/^[1-9][0-9]*\s*$/.test(gid.stdout)) fail('probe-user-unavailable');
    result.uid = Number(uid.stdout); const groupId = Number(gid.stdout);
    if (out) { if (!path.isAbsolute(out)) fail('probe-out-invalid'); await fs.mkdir(out, { mode: 0o755 }); root = out; }
    else root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-cgroup-os-'));
    // Only our newly created directory reaches here; never chmod an existing
    // --out. Explicit modes avoid root's inherited umask hiding public metadata.
    await fs.chmod(root, 0o755);
    result.outputDirectory = root;
    await fs.mkdir(path.join(root, 'data'), { mode: 0o700 }); await fs.chmod(path.join(root, 'data'), 0o700);
    await fs.chown(path.join(root, 'data'), result.uid, groupId);
    const copy = path.join(root, 'probe.mjs'); await fs.copyFile(fileSelf, copy, constants.COPYFILE_EXCL); await fs.chmod(copy, 0o644);
    const manifest = path.join(root, 'manifest.json');
    await fs.writeFile(manifest, JSON.stringify({ unit, slice, serviceCgroup: servicePath, uid: result.uid, root, port: 6540 }), { flag: 'wx', mode: 0o644 });
    await fs.chmod(manifest, 0o644);
    // v249 supports transient .slice via the Manager API. systemd-run only has
    // --slice (not --slice-property); do not accidentally put properties on the
    // service. No runtime unit files, daemon-reload, or cgroup delegation.
    await checkSliceVacancy();
    sliceAttempted = true;
    const created = await command('/usr/bin/busctl', ['--system', '--no-pager', 'call', 'org.freedesktop.systemd1',
      '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))',
      slice, 'fail', '2', 'Description', 's', sliceDescription, 'StopWhenUnneeded', 'b', 'false', '0'], time());
    if (created.code) fail('probe-slice-start-failed');
    let scopeState;
    do {
      scopeState = await describe(slice, time());
      if (scopeState.ActiveState === 'active') break;
      if (scopeState.ActiveState === 'failed') fail('probe-slice-start-failed');
      await delay(10);
    } while (now() < deadline);
    scopeState = await verifyScope();
    if (scopeState.ActiveState !== 'active') fail('probe-slice-not-active');
    sliceInvocation = scopeState.InvocationID;
    const self = (await fs.readFile('/proc/self/cgroup', 'utf8')).trim().slice(3);
    if (self === scopePath || self.startsWith(`${scopePath}/`)) fail('probe-observer-inside-target');
    if ((await fs.statfs(scopeDirectory)).type !== 0x63677270) fail('probe-cgroup-not-vtwo');
    group = await fs.open(scopeDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    groupStat = await group.stat({ bigint: true });
    events = await fs.open(`/proc/self/fd/${group.fd}/cgroup.events`, constants.O_RDONLY | constants.O_NOFOLLOW);
    const initialInventory = await inventory(scopeDirectory);
    if (initialInventory.groups.length !== 1 || initialInventory.pids.length || await readPinnedPopulated() !== 0)
      fail('probe-scope-not-initially-empty');
    const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    result.closureScope = { unit: slice, invocationId: sliceInvocation, bootId,
      cgroup: { path: scopeDirectory, dev: String(groupStat.dev), ino: String(groupStat.ino) },
      user: null, initialInventory, observerOutside: true };
    server = net.createServer(socket => {
      sockets.add(socket); let text = '', record;
      socket.on('error', () => {});
      socket.on('data', piece => {
        if (record) return;
        text += piece.toString('utf8'); if (text.length > 1024) { socket.destroy(); return; }
        if (!text.includes('\n')) return;
        try {
          const hello = JSON.parse(text.trim());
          if (!['parent', 'child'].includes(hello.role) || peers.has(hello.role) || !Number.isSafeInteger(hello.pid) ||
              hello.pid < 1 || !Number.isSafeInteger(hello.fd) || hello.fd < 0) throw Error();
          record = { ...hello, eof: false, closed: false }; peers.set(hello.role, record);
        } catch { socket.destroy(); }
      });
      socket.on('end', () => { if (record) record.eof = true; });
      socket.on('close', () => { if (record) record.closed = true; sockets.delete(socket); });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(6540, '127.0.0.1', resolve); });
    launchAttempted = true;
    const launched = await command('/usr/bin/systemd-run', ['--quiet', `--unit=${unit}`, `--description=${description}`,
      `--slice=${slice}`, '--service-type=simple', `--uid=${result.uid}`, `--gid=${groupId}`, '--property=Restart=no', '--property=KillMode=control-group',
      '--property=Delegate=no', '--property=TimeoutStopSec=5s', '--property=StandardOutput=null', '--property=StandardError=null',
      process.execPath, copy, '--worker', 'parent', manifest], time());
    if (launched.code) fail('probe-unit-start-failed');
    while (peers.size !== 2 && now() < deadline) await delay(10);
    if (peers.size !== 2) fail('probe-workers-not-ready');
    const state = await describe(unit, time());
    if (state.Id !== unit || state.Description !== description || state.MainPID !== String(peers.get('parent').pid) ||
        ![user, String(result.uid)].includes(state.User) || state.Restart !== 'no' || state.KillMode !== 'control-group' || state.Delegate !== 'no' ||
        state.Transient !== 'yes' || state.Slice !== slice || !/^[a-f0-9]{32}$/.test(state.InvocationID ?? '') ||
        state.ControlGroup !== servicePath || state.ActiveState !== 'active') fail('probe-unit-identity');
    serviceInvocation = state.InvocationID;
    main = await processInfo(peers.get('parent').pid); child = await processInfo(peers.get('child').pid);
    const cgroup = `/sys/fs/cgroup${state.ControlGroup}`;
    if (main.uid !== result.uid || child.uid !== result.uid || main.cgroup !== state.ControlGroup || child.cgroup !== state.ControlGroup)
      fail('probe-worker-identity');
    for (const role of ['parent', 'child']) {
      const peer = peers.get(role);
      if (await fs.readlink(`/proc/${peer.pid}/fd/${peer.fd}`) !== path.join(root, 'data', `${role}.bin`)) fail('probe-file-not-held');
    }
    if ((await fs.statfs(cgroup)).type !== 0x63677270) fail('probe-cgroup-not-vtwo');
    const serviceStat = await fs.lstat(cgroup, { bigint: true });
    if (serviceStat.isSymbolicLink()) fail('probe-service-cgroup-invalid');
    const owned = await inventory(scopeDirectory);
    if (owned.groups.length !== 2 || !owned.groups.includes(cgroup) ||
        JSON.stringify(owned.pids) !== JSON.stringify([main.pid, child.pid].sort((a, b) => a - b)) ||
        await readPinnedPopulated() !== 1 || (await verifyScope()).ActiveState !== 'active') fail('probe-scope-not-exclusive');
    result.before = { service: { unit, invocationId: serviceInvocation, uid: result.uid, bootId,
      cgroup: { path: cgroup, dev: String(serviceStat.dev), ino: String(serviceStat.ino) } },
      main, child, exclusiveInventory: owned, heldFiles: 2, connectedPeers: 2 };
    // Attach the rejection handler now; the sole stop proceeds concurrently.
    const stopping = issueStop().catch(e => { result.errors.push(safeCode(e)); stopResult = { code: 1, timedOut: false }; });
    let lastSample = '';
    while (now() < deadline) {
      const mainGone = await birthGone(main), childGone = await birthGone(child);
      let populated = null;
      if (!result.emptyObserved && !result.eventsReadError) {
        try {
          populated = await readPinnedPopulated();
          if (populated === 0 && mainGone && childGone) result.emptyObserved = true;
        } catch (e) { result.eventsReadError = safeCode(e); }
      }
      let childFdHeld = false;
      if (!childGone) try { childFdHeld = await fs.readlink(`/proc/${child.pid}/fd/${peers.get('child').fd}`) === path.join(root, 'data', 'child.bin'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const sample = { mainGone, childGone, populated, childFdHeld, parentEof: peers.get('parent').eof,
        childEof: peers.get('child').eof, childClosed: peers.get('child').closed };
      if (mainGone && !childGone && populated === 1 && childFdHeld && !sample.childEof && !sample.childClosed) result.negativeObserved = true;
      const key = JSON.stringify(sample);
      if (key !== lastSample) { result.samples.push({ ms: Math.round(now() - start), ...sample }); lastSample = key; }
      if (stopResult && mainGone && childGone && [...peers.values()].every(p => p.eof && p.closed) &&
          (result.emptyObserved || result.eventsReadError)) break;
      await delay(10);
    }
    await stopping;
    const stopped = await describe(unit, Math.min(2000, totalDeadline - now()));
    const stillActive = await verifyScope();
    result.finalInventory = await inventory(scopeDirectory);
    result.checks = { mainBirthGone: await birthGone(main), childBirthGone: await birthGone(child),
      bothPeerEofAndClose: [...peers.values()].every(p => p.eof && p.closed),
      unitInactive: stopped.ActiveState === 'inactive' && Number(stopped.MainPID) === 0,
      closureScopeStillActive: stillActive.ActiveState === 'active',
      closureScopeStillEmpty: await readPinnedPopulated() === 0 && result.finalInventory.pids.length === 0 &&
        result.finalInventory.groups.every(g => g === scopeDirectory || g === cgroup),
      stopSucceeded: stopResult?.code === 0 && !stopResult.timedOut };
    result.ok = result.negativeObserved && result.emptyObserved && Object.values(result.checks).every(Boolean);
    if (!result.ok) result.errors.push(!result.negativeObserved ? 'probe-negative-not-observed' :
      !result.emptyObserved ? 'probe-pinned-empty-not-observed' : 'probe-final-close-incomplete');
  } catch (e) { result.errors.push(safeCode(e)); }
  finally {
    if (launchAttempted && !stopTask && now() < totalDeadline) try { await issueStop(); } catch (e) { result.errors.push(safeCode(e)); }
    if (stopTask) await stopTask;
    // Real peer EOF/close checks above precede any forced observer cleanup.
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    result.stop = stopResult ?? null;
    result.sliceCleanup = { stopIssued: 0, evidenceDurable: false, retained: sliceAttempted };
    if (sliceAttempted && events && group && now() < totalDeadline) try {
      const scope = await verifyScope(), state = await describe(unit, Math.min(2000, totalDeadline - now()));
      const contents = await inventory(scopeDirectory);
      const empty = await readPinnedPopulated() === 0;
      const noOldBirths = (!main || await birthGone(main)) && (!child || await birthGone(child));
      if (scope.ActiveState !== 'active' || !empty || contents.pids.length || !noOldBirths ||
          contents.groups.some(g => g !== scopeDirectory && g !== `/sys/fs/cgroup${servicePath}`) ||
          !['inactive', 'failed'].includes(state.ActiveState) || Number(state.MainPID ?? 0) !== 0)
        fail('probe-slice-release-unproved');
      result.sliceCleanup.emptyReadBeforeRelease = { populated: 0, noOldBirths, contents, invocationId: scope.InvocationID };
      // Persist this result while the exact scope is still ACTIVE and readable.
      // An error here leaves the slice alive. No catch/unlink rollback assertion.
      await durableJSON(root, 'closure-result.json', { ...result, phase: 'before-slice-release', wallMs: Math.round(now() - start) });
      evidenceDurable = true; result.sliceCleanup.evidenceDurable = true;
      // Recheck after the fsync await; never stop a newly replaced/occupied scope.
      const rechecked = await verifyScope(), remaining = await inventory(scopeDirectory);
      if (rechecked.ActiveState !== 'active' || await readPinnedPopulated() !== 0 || remaining.pids.length ||
          remaining.groups.some(g => g !== scopeDirectory && g !== `/sys/fs/cgroup${servicePath}`)) fail('probe-slice-release-unproved');
      if (now() >= totalDeadline) fail('probe-total-bound-exceeded');
      result.sliceCleanup.stopIssued++;
      const released = await command('/usr/bin/systemctl', ['stop', slice, '--no-ask-password'], Math.min(2000, totalDeadline - now()));
      result.sliceCleanup.stop = { code: released.code, timedOut: released.timedOut };
      const after = await describe(slice, Math.min(2000, totalDeadline - now()));
      result.sliceCleanup.inactive = after.ActiveState === 'inactive' || after.LoadState === 'not-found';
      result.sliceCleanup.retained = !result.sliceCleanup.inactive;
      if (released.code || released.timedOut || !result.sliceCleanup.inactive) fail('probe-slice-release-incomplete');
    } catch (e) { result.ok = false; result.errors.push(safeCode(e)); }
    if (sliceAttempted && (!evidenceDurable || result.sliceCleanup.retained)) {
      result.ok = false; result.errors.push('probe-slice-retained');
    }
    await events?.close(); await group?.close();
    result.afterListeners = await listeners();
    if (result.afterListeners.length) { result.ok = false; result.errors.push('probe-listener-remains'); }
    result.wallMs = Math.round(now() - start);
    if (result.wallMs > 30000) { result.ok = false; result.errors.push('probe-total-bound-exceeded'); }
    if (root) try { await durableJSON(root, 'result.json', result); }
    catch (e) { result.ok = false; result.errors.push(safeCode(e), 'probe-result-not-durable'); }
  }
  return result;
}

/** Root separately creates the random fixed service, worker.json and fresh TLS
 * material. No production unit or foreign configuration is created/deleted.
 * continue-epochN.json is an operator timing gate, NEVER a doc receipt.
 */
export async function runPublisherV2OSProbe({ configFile, out }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) fail('probe-linux-root-required');
  const { digestOf } = await import('../../server/account/ledger.mjs');
  const { runAssetRootPublisherV2, openPublisherLock, writePublisherArtifact } = await import('../../server/hosted/deploy/asset-root-registry-publisher.mjs');
  const { validateAssetRootHistoryV2 } = await import('../../server/hosted/asset-root-registry-schema-v2.mjs');
  const equal = (a, b) => digestOf(a) === digestOf(b);
  async function readRoot(filename) {
    if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) fail('probe-root-file');
    for (let p = path.dirname(filename); ; p = path.dirname(p)) {
      const st = await fs.lstat(p);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) fail('probe-root-file');
      if (p === path.dirname(p)) break;
    }
    const fd = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await fd.stat();
      if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o022) || st.size > 65536) fail('probe-root-file');
      return JSON.parse(await fd.readFile('utf8'));
    } finally { await fd.close(); }
  }
  const config = await readRoot(configFile), workerConfig = await readRoot(path.join(path.dirname(configFile), 'worker.json'));
  const expected = config.expected, match = /^pc-asset-cgroup-proof-([a-f0-9]{16})\.service$/.exec(expected?.unit ?? '');
  const origin = new URL(config.identity?.origin);
  if (config.v !== 2 || !match || config.runtimeAdapter?.unitFragment?.path !== `/run/systemd/system/${expected.unit}` ||
      config.runtimeAdapter.ownDropInPath !== `/run/systemd/system/${expected.unit}.d/90-promptcut-root-slice.conf` ||
      expected.closurePolicy?.unitNamespace !== `pcassetproof${match[1]}` || origin.protocol !== 'https:' || origin.hostname !== '127.0.0.1' ||
      Number(origin.port) !== workerConfig.identityPort || workerConfig.observerPort !== 6540 || !equal(workerConfig.expected, expected) ||
      workerConfig.reservationFile !== path.join(config.registryDir, 'reservation.json') || !path.isAbsolute(out) || path.normalize(out) !== out)
    fail('probe-v2-config');
  if ((await listeners()).length) fail('probe-port-busy');
  const stopConfig = await command('/usr/bin/systemctl', ['show', expected.unit, '--property=TimeoutStopUSec', '--value'], 2000);
  if (stopConfig.code || stopConfig.stdout.trim() !== '5s') fail('probe-stop-bound');
  await fs.mkdir(out, { mode: 0o755 }); await fs.chmod(out, 0o755); // exclusive: never chmod an existing out
  const start = now(), peers = new Map(), sockets = new Set();
  const result = { v: 2, mode: 'publisher-v2', ok: false, errors: [], samples: [], unit: expected.unit,
    productionMounted: false, docAcceptanceVerified: false, negativeObserved: false, publication: [], cleanup: {} };
  let server, releaseLock, group, events, latestPublished;
  const readRegistry = name => readRoot(path.join(config.registryDir, name));
  async function published(epoch) {
    await fs.lstat(path.join(config.registryDir, '.publisher.lock')).then(() => fail('probe-publisher-still-locked'), e => { if (e.code !== 'ENOENT') throw e; });
    const currentRecord = await readRegistry('current.json'), anchor = await readRegistry('anchor.json'), entries = [];
    for (let n = 1; n <= epoch; n++) entries.push({ record: await readRegistry(`epoch-${n}.json`), reservation: await readRegistry(`reservation-${n}.json`),
      witness: n === 1 ? null : await readRegistry(`witness-${n}.json`), publication: await readRegistry(`publication-${n}.json`) });
    if (currentRecord.epoch !== epoch) fail('probe-epoch');
    const checkpoint = validateAssetRootHistoryV2({ entries, currentRecord, anchor, expected, publisherLocked: false });
    result.publication.push(checkpoint); latestPublished = currentRecord; return currentRecord;
  }
  async function peerPair(record) {
    const deadline = now() + 5000;
    while (now() < deadline && !['parent', 'child'].every(r => peers.has(`${record.epoch}:${r}`))) await delay(20);
    const pair = ['parent', 'child'].map(r => peers.get(`${record.epoch}:${r}`));
    if (pair.some(p => !p)) fail('probe-worker-peers-missing');
    for (const p of pair) {
      const info = await processInfo(p.pid);
      if (p.instanceId !== record.instance.instanceId || p.authorityId !== expected.authorityId || info.uid !== expected.uid ||
          info.startTicks !== p.startTicks || `/sys/fs/cgroup${info.cgroup}` !== record.instance.cgroup.v2Path ||
          await fs.readlink(`/proc/${p.pid}/fd/${p.fd}`) !== path.join(workerConfig.dataDir, `${record.epoch}-${p.role}.bin`)) fail('probe-peer-identity');
      const inode = /^socket:\[(\d+)\]$/.exec(await fs.readlink(`/proc/${p.pid}/fd/${p.socketFd}`))?.[1];
      const row = (await fs.readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1).map(s => s.trim().split(/\s+/)).find(f => f[9] === inode);
      if (!inode || !row || row[1] !== `0100007F:${p.remotePort.toString(16).toUpperCase().padStart(4, '0')}` ||
          row[2] !== '0100007F:198C' || row[3] !== '01') fail('probe-peer-socket');
    }
    if (pair[0].pid !== record.instance.pid || pair[0].startTicks !== record.instance.pidBirth.startTicks) fail('probe-peer-main');
    return pair;
  }
  async function operatorGate(record) {
    await durableJSON(out, `stage-epoch${record.epoch}-ready.json`, { v: 2, epoch: record.epoch, recordDigest: digestOf(record),
      registryDir: config.registryDir, anchorDigest: result.publication.at(-1).anchorDigest, docAcceptanceVerified: false });
    // Root runs the real G SQLite factory/close/reopen assertions externally.
    // This file only controls when this experiment moves to its next OS step.
    const deadline = now() + 30000, filename = path.join(out, `continue-epoch${record.epoch}.json`);
    do {
      let st; try { st = await fs.lstat(filename); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (st) {
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o022) || st.size > 512) fail('probe-operator-gate');
        const v = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (!equal(v, { v: 1, continueEpoch: record.epoch, recordDigest: digestOf(record) })) fail('probe-operator-gate');
        return;
      }
      await delay(20);
    } while (now() < deadline);
    fail('probe-operator-gate-timeout');
  }
  async function pinScope(record) {
    const scope = record.closureScope;
    const handle = await fs.open(scope.cgroup.v2Path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { return { record, handle, events: await fs.open(`/proc/self/fd/${handle.fd}/cgroup.events`, constants.O_RDONLY | constants.O_NOFOLLOW) }; }
    catch (e) { await handle.close(); throw e; }
  }
  async function populated(pin) {
    const st = await pin.handle.stat({ bigint: true }), scope = pin.record.closureScope;
    if (String(st.dev) !== scope.cgroup.dev || String(st.ino) !== scope.cgroup.ino) fail('probe-scope-changed');
    const buf = Buffer.alloc(4096), { bytesRead } = await pin.events.read(buf, 0, buf.length, 0);
    const m = /^populated ([01])$/m.exec(buf.subarray(0, bytesRead).toString('utf8'));
    if (!m) fail('probe-events-invalid'); return Number(m[1]);
  }
  async function verifyScope(record) {
    const scope = record.closureScope, state = await describe(scope.unit, 2000);
    if (state.Id !== scope.unit || state.ActiveState !== 'active' || state.Transient !== 'yes' || state.StopWhenUnneeded !== 'no' ||
        state.InvocationID !== scope.unitInvocationId || `/sys/fs/cgroup${state.ControlGroup}` !== scope.cgroup.v2Path ||
        state.Description !== `PromptCut root closure ${expected.authorityId} epoch ${scope.epoch} ${scope.scopeId}` ||
        (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() !== scope.bootId) fail('probe-scope-changed');
    const inv = await inventory(scope.cgroup.v2Path);
    if (inv.groups.some(p => p !== scope.cgroup.v2Path && p !== record.instance.cgroup.v2Path)) fail('probe-scope-not-exclusive');
    return inv;
  }
  async function sample(pin, pair) {
    const [parent, child] = pair, mainGone = await birthGone(parent), childGone = await birthGone(child);
    let childFdHeld = false;
    if (!childGone) try { childFdHeld = await fs.readlink(`/proc/${child.pid}/fd/${child.fd}`) === path.join(workerConfig.dataDir, `${child.epoch}-child.bin`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { mainGone, childGone, populated: await populated(pin), childFdHeld, parentEof: parent.eof, childEof: child.eof,
      parentClosed: parent.closed, childClosed: child.closed };
  }
  try {
    server = net.createServer(socket => {
      sockets.add(socket); let text = '', admitted = false;
      socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
      socket.on('data', chunk => {
        if (admitted) return socket.destroy(); text += chunk.toString('utf8');
        if (text.length > 2048) return socket.destroy(); if (!text.endsWith('\n')) return;
        try {
          const v = JSON.parse(text), key = `${v.epoch}:${v.role}`;
          if (!['parent', 'child'].includes(v.role) || ![1, 2].includes(v.epoch) || peers.has(key) ||
              ![v.pid, v.fd, v.socketFd].every(Number.isSafeInteger) || !/^[1-9][0-9]*$/.test(v.startTicks)) throw Error();
          admitted = true; const p = { ...v, remotePort: socket.remotePort, eof: false, closed: false }; peers.set(key, p);
          socket.once('end', () => { p.eof = true; }); socket.once('close', () => { p.closed = true; });
        } catch { socket.destroy(); }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(6540, '127.0.0.1', resolve); });
    await runAssetRootPublisherV2({ configFile, mode: 'initialize' });
    const first = await published(1), pair1 = await peerPair(first); await operatorGate(first);
    const pin1 = await pinScope(first); await verifyScope(first);
    let rotationDone = false;
    const rotation = runAssetRootPublisherV2({ configFile, mode: 'rotate' }).then(value => ({ value }), error => ({ error }))
      .finally(() => { rotationDone = true; });
    try {
      while (!rotationDone) {
        try {
          const s = await sample(pin1, pair1);
          if (s.mainGone && !s.childGone && s.childFdHeld && s.populated === 1 && !s.childEof && !s.childClosed) result.negativeObserved = true;
          if (!equal(s, result.samples.at(-1)?.sample ?? {})) result.samples.push({ ms: Math.round(now() - start), sample: s });
        } catch (e) {
          // Publisher may already have durably witnessed empty and released this
          // old scope. ENODEV here is diagnostic, never an empty observation.
          result.oldObserverError = safeCode(e); break;
        }
        await delay(20);
      }
      const outcome = await rotation; if (outcome.error) throw outcome.error;
    } finally { await pin1.events.close(); await pin1.handle.close(); }
    const second = await published(2), pair2 = await peerPair(second);
    if (!result.negativeObserved || !pair1.every(p => p.eof && p.closed) || !await birthGone(pair1[0]) || !await birthGone(pair1[1]))
      fail('probe-real-rotation-negative-or-close-missing');
    const witness = await readRegistry('witness-2.json');
    result.rotationWitness = { digest: digestOf(witness), populated: witness.observed.populated, scopeActive: witness.observed.scopeActive,
      serviceInstance: witness.observed.serviceInstance, closureScope: witness.observed.closureScope };
    const old = await describe(first.closureScope.unit, 2000);
    if (old.ActiveState !== 'inactive') fail('probe-old-scope-not-released');
    await operatorGate(second);
    // End this isolated experiment; this is NOT an epoch3 authorization/witness.
    releaseLock = await openPublisherLock(config.registryDir);
    if (!equal(await readRegistry('current.json'), second)) fail('probe-current-changed');
    const pin2 = await pinScope(second); group = pin2.handle; events = pin2.events;
    const inv = await verifyScope(second), u = await describe(expected.unit, 2000), main = await processInfo(second.instance.pid);
    if (u.Id !== expected.unit || u.InvocationID !== second.instance.unitInvocationId || Number(u.MainPID) !== main.pid ||
        u.Restart !== 'no' || u.KillMode !== 'control-group' || u.Delegate !== 'no' || u.Slice !== second.closureScope.unit ||
        main.startTicks !== second.instance.pidBirth.startTicks || main.uid !== expected.uid ||
        `/sys/fs/cgroup${main.cgroup}` !== second.instance.cgroup.v2Path || inv.pids.some(p => !pair2.some(peer => peer.pid === p))) fail('probe-stop-ownership-unproved');
    await writePublisherArtifact({ dir: config.registryDir, name: 'current.json', value: { ...second, state: 'preparing' }, publicMetadata: true });
    const preStop = await describe(expected.unit, 2000), preMain = await processInfo(second.instance.pid);
    if (preStop.InvocationID !== second.instance.unitInvocationId || Number(preStop.MainPID) !== second.instance.pid ||
        preStop.Slice !== second.closureScope.unit || preStop.Restart !== 'no' || preStop.KillMode !== 'control-group' || preStop.Delegate !== 'no' ||
        !equal(preMain, main) || (await verifyScope(second)).pids.some(p => !pair2.some(peer => peer.pid === p)) || await populated(pin2) !== 1)
      fail('probe-stop-ownership-unproved');
    const stopped = await command('/usr/bin/systemctl', ['stop', expected.unit, '--no-ask-password'], 7000);
    result.cleanup.serviceStop = { code: stopped.code, timedOut: stopped.timedOut };
    const remaining = await verifyScope(second), state = await describe(expected.unit, 2000);
    if (stopped.code || stopped.timedOut || state.ActiveState !== 'inactive' || Number(state.MainPID) !== 0 || remaining.pids.length ||
        await populated(pin2) !== 0 || !await birthGone(pair2[0]) || !await birthGone(pair2[1]) || !pair2.every(p => p.eof && p.closed)) fail('probe-final-close-unproved');
    result.cleanup.empty = { populated: 0, scope: second.closureScope, birthsGone: true, bothEofClose: true };
    await durableJSON(out, 'publisher-v2-final-closure.json', result.cleanup);
    if ((await verifyScope(second)).pids.length || await populated(pin2) !== 0) fail('probe-final-close-unproved');
    const released = await command('/usr/bin/systemctl', ['stop', second.closureScope.unit, '--no-ask-password'], 3000);
    result.cleanup.scopeStop = { code: released.code, timedOut: released.timedOut };
    if (released.code || released.timedOut || (await describe(second.closureScope.unit, 2000)).ActiveState !== 'inactive') fail('probe-slice-release-incomplete');
    result.cleanup.lockIntentionallyRetained = true; result.ok = true;
  } catch (e) {
    result.errors.push(typeof e?.code === 'string' && /^(probe|publisher|asset-root-v2)-[a-z-]+$/.test(e.code) ? e.code : safeCode(e));
    // A failed operator gate must not leave this known isolated publication
    // freely admissible. Acquire, never replace, the real publisher lock; a
    // publisher failure's existing lock stays untouched. No guessed stop.
    if (latestPublished && !releaseLock) try {
      releaseLock = await openPublisherLock(config.registryDir);
      if (!equal(await readRegistry('current.json'), latestPublished)) fail('probe-current-changed');
      await writePublisherArtifact({ dir: config.registryDir, name: 'current.json', value: { ...latestPublished, state: 'preparing' }, publicMetadata: true });
      result.cleanup.failedPublicationFenced = true;
    } catch (error) { result.cleanup.fenceError = safeCode(error); }
  }
  finally {
    await events?.close(); await group?.close();
    if (releaseLock) await releaseLock({ publicationDurable: false });
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    result.afterListeners = await listeners(); if (result.afterListeners.length) { result.ok = false; result.errors.push('probe-listener-remains'); }
    result.wallMs = Math.round(now() - start);
    // Unknown ownership/partial publisher failure deliberately retains its unit,
    // scope and root lock. Root gets metadata for explicit recovery, no blind stop.
    result.remainingUnit = await describe(expected.unit, 2000);
    await durableJSON(out, 'publisher-v2-result.json', result);
  }
  return result;
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Linux root only: --user <existing-asset-user> [--out <new-absolute-dir>]; original single-scope 30s experiment. Or --publisher-v2 --config <root-v2-config> --out <new-dir>; root-prepared isolated fixed service, worker.json, real TLS; two 30s operator gates. Ports 6540..6549.\n'); return 0;
  }
  if (args.length === 5 && args[0] === '--publisher-v2' && args[1] === '--config' && args[3] === '--out') {
    const result = await runPublisherV2OSProbe({ configFile: args[2], out: args[4] });
    process.stdout.write(JSON.stringify(result) + '\n'); return result.ok ? 0 : 1;
  }
  if (args.length === 3 && args[0] === '--worker') { await worker(args[1], args[2]); return 0; }
  if (![2, 4].includes(args.length) || args[0] !== '--user' || args.length === 4 && args[2] !== '--out') fail('probe-cli-invalid');
  const result = await runAssetCgroupOSProbe({ user: args[1], out: args[3] });
  process.stdout.write(JSON.stringify(result) + '\n'); return result.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => {
    process.stderr.write(JSON.stringify({ ok: false, code: safeCode(e) }) + '\n'); process.exitCode = 1;
  });
}
