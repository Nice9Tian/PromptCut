/** Explicit external-root Agent slot lifecycle. No finalizer or network write
 * API. Failure retains the root lock; no force/recover/assume-empty option. */
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { digestOf } from '../../account/ledger.mjs';
import { createRootScopeRuntimeV2, rootRead, procInfo } from './asset-root-registry-publisher.mjs';
import { loadAgentScopeChain } from '../agent-run-scope-reader.mjs';
import { failScope, exactScope, sameScope, scopeRuntimeExpected, scopeHead, scopePublication,
  validateAgentScopeExpected, validateAgentScopeRecord, validateAgentScopeReservation, validateAgentScopeAssignment,
  validateAgentScopeTerminal, validateAgentScopeClosure, validateAgentScopeHistory, scopePublicKey } from '../agent-run-scope-schema.mjs';

const protocol = name => `promptcut.agent-run-scope.${name}.v1`;
const emptyEntry = (record, reservation) => ({ record, reservation, assignment: null, terminal: null, intent: null, closure: null,
  publications: { ready: null, bound: null, closed: null } });

export function parseAgentTcpListeners(text, family) {
  const lines = String(text).trim().split('\n');
  if (![4, 6].includes(family) || !/local_address/.test(lines.shift() ?? '')) failScope('listener-table');
  const listeners = [];
  for (const line of lines) {
    const columns = line.trim().split(/\s+/), local = /^([0-9A-F]+):([0-9A-F]{4})$/i.exec(columns[1] ?? '');
    if (!local || local[1].length !== (family === 4 ? 8 : 32) || !/^[0-9A-F]{2}$/i.test(columns[3] ?? '') ||
        !/^\d+$/.test(columns[7] ?? '') || !/^\d+$/.test(columns[9] ?? '')) failScope('listener-table');
    if (columns[3].toUpperCase() === '0A') listeners.push({ family, address: local[1].toUpperCase(),
      port: parseInt(local[2], 16), uid: Number(columns[7]), inode: columns[9] });
  }
  return listeners;
}
/** Pure negative-test surface; actual paths/PID come only from root inspection. */
export function validateAgentListenerOwner({ tcp4, tcp6, links, port, uid }) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !Array.isArray(links)) failScope('listener-owner');
  const rows = [...parseAgentTcpListeners(tcp4, 4), ...parseAgentTcpListeners(tcp6, 6)].filter(r => r.port === port);
  if (!rows.length) failScope('listener-not-ready');
  if (rows.length !== 1 || rows[0].family !== 4 || rows[0].address !== '0100007F' || rows[0].uid !== uid ||
      rows[0].inode === '0' || !links.includes(`socket:[${rows[0].inode}]`)) failScope('listener-owner');
  return rows[0];
}
async function listenerOwnership(origin, instance) {
  const parsed = new URL(origin);
  if (parsed.hostname !== '127.0.0.1' || parsed.protocol !== 'https:') failScope('identity-origin');
  const before = await procInfo(instance.pid);
  if (before.startTicks !== instance.pidBirth.startTicks || before.uid !== instance.uid || before.cgroupPath !== instance.cgroup.v2Path) failScope('instance-changed');
  // Same network namespace is required. No host table substitution or socket
  // activation guess: the inspected MainPID must own the listening inode.
  const [selfNet, peerNet] = await Promise.all([fs.readlink('/proc/self/ns/net'), fs.readlink(`/proc/${instance.pid}/ns/net`)]);
  if (selfNet !== peerNet) failScope('listener-namespace');
  const links = await Promise.all((await fs.readdir(`/proc/${instance.pid}/fd`)).map(async fd => {
    try { return await fs.readlink(`/proc/${instance.pid}/fd/${fd}`); }
    catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
  }));
  const [tcp4, tcp6] = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(f => fs.readFile(f, 'utf8')));
  const result = validateAgentListenerOwner({ tcp4, tcp6, links, port: Number(parsed.port || 443), uid: instance.uid });
  if (!sameScope(before, await procInfo(instance.pid))) failScope('instance-changed');
  return result;
}
function matchIdentity(identity, expected, reservation, tuple) {
  if (!exactScope(identity, ['v', 'serviceId', 'authorityId', 'slotId', 'epoch', 'instanceId', 'pid', 'publicKey', 'publicKeyDigest',
    'clientFingerprint256', 'serverFingerprint256']) || identity.v !== 1 || identity.serviceId !== 'agent' ||
      identity.authorityId !== expected.authorityId || identity.slotId !== expected.slotId || identity.epoch !== reservation.epoch ||
      identity.instanceId !== reservation.instanceId || identity.pid !== tuple.instance.pid ||
      identity.publicKeyDigest !== digestOf(identity.publicKey) || identity.clientFingerprint256 !== expected.clientFingerprint256 ||
      identity.serverFingerprint256 !== expected.serverFingerprint256) failScope('identity');
  scopePublicKey(identity.publicKey);
}

/** Pure transaction coordinator. Injected IO exercises ordering/faults only.
 * runAgentScopePublisher below supplies the authenticated Linux root adapter. */
export async function publishAgentScope({ expected, mode, configuredAnchorDigest = null, assignment = null, terminal = null, intent = null, io }) {
  validateAgentScopeExpected(expected);
  if (!['initialize', 'start', 'bind', 'close'].includes(mode)) failScope('mode');
  const unlock = await io.lock(); let durable = false, pinned;
  try {
    let current = await io.read('current.json'), chain, entry, anchor;
    if (mode === 'initialize') {
      if (current || configuredAnchorDigest !== null) failScope('initialize');
      await io.assertInitial();
    } else {
      chain = await loadAgentScopeChain(io.read, current);
      validateAgentScopeHistory({ ...chain, expected, configuredAnchorDigest, locked: false });
      anchor = chain.anchor; entry = chain.entries.at(-1);
    }
    const publish = async phase => {
      const head = scopeHead(entry, phase), publication = scopePublication(entry, phase, anchor);
      // Both artifacts may be visible after a rejected directory barrier.
      // Consumers require the marker AND lock absence, never head alone.
      await io.write('current.json', head);
      await io.write(`publication-${entry.record.epoch}-${phase}.json`, publication, true);
      durable = true;
      return { head, anchorDigest: digestOf(anchor) };
    };
    if (mode === 'initialize' || mode === 'start') {
      if (mode === 'start' && current.phase !== 'closed') failScope('slot-occupied');
      const epoch = (current?.epoch ?? 0) + 1, instanceId = io.uuid(), scopeId = io.scopeId();
      const closureScope = await io.createScope({ epoch, instanceId, scopeId });
      const reservation = { v: 1, protocol: protocol('reservation'), authorityId: expected.authorityId, slotId: expected.slotId,
        epoch, instanceId, serviceCgroupPath: `${closureScope.cgroup.v2Path}/${expected.unit}`, closureScope };
      validateAgentScopeReservation(reservation, expected);
      await io.write(`reservation-${epoch}.json`, reservation, true); await io.write('reservation.json', reservation);
      await io.configureService(reservation); await io.start(reservation);
      const before = await io.inspect(reservation), identity = await io.identity(reservation), after = await io.inspect(reservation);
      if (!sameScope(before, after)) failScope('instance-changed');
      matchIdentity(identity, expected, reservation, before);
      const record = { v: 1, protocol: protocol('epoch'), authorityId: expected.authorityId, slotId: expected.slotId, epoch,
        ...before, worker: { publicKey: identity.publicKey, publicKeyDigest: identity.publicKeyDigest },
        previousClosureDigest: entry ? digestOf(entry.closure) : null };
      validateAgentScopeRecord(record, expected);
      if (entry && record.instance.bootId !== entry.record.instance.bootId) failScope('boot-transition');
      entry = emptyEntry(record, reservation);
      if (!anchor) { anchor = { v: 1, protocol: protocol('anchor'), expected, firstRecordDigest: digestOf(record) }; await io.write('anchor.json', anchor, true); }
      entry.publications.ready = scopePublication(entry, 'ready', anchor);
      // Validate whole prospective history before publishing, including unique
      // RAM key, instance and invocation across previous generations.
      validateAgentScopeHistory({ expected, anchor, configuredAnchorDigest: digestOf(anchor), entries: [...(chain?.entries ?? []), entry],
        current: scopeHead(entry, 'ready'), locked: false });
      await io.write(`epoch-${epoch}.json`, record, true);
      if (!sameScope(before, await io.inspect(reservation))) failScope('instance-changed');
      return await publish('ready');
    }
    if (mode === 'bind') {
      validateAgentScopeAssignment(assignment, expected, entry.record);
      if (current.phase !== 'ready') {
        if (!sameScope(entry.assignment, assignment)) failScope('assignment-conflict');
        durable = true; return { head: current, anchorDigest: digestOf(anchor) };
      }
      if (!sameScope(await io.inspect(entry.reservation), { instance: entry.record.instance, closureScope: entry.record.closureScope })) failScope('instance-changed');
      entry.assignment = assignment;
      if (chain.entries.slice(0, -1).some(e => e.assignment.target.runGrantId === assignment.target.runGrantId)) failScope('grant-reused');
      await io.write(`assignment-${current.epoch}.json`, assignment, true);
      return await publish('bound');
    }
    validateAgentScopeTerminal(terminal, intent, expected, entry.record, entry.assignment);
    if (current.phase === 'closed') {
      if (!sameScope(entry.terminal, terminal) || !sameScope(entry.intent, intent)) failScope('terminal-conflict');
      durable = true; return { head: current, anchorDigest: digestOf(anchor) };
    }
    if (current.phase !== 'bound') failScope('phase');
    pinned = await io.pinPrevious(entry.record);
    await io.write(`terminal-${current.epoch}.json`, terminal, true); await io.write(`intent-${current.epoch}.json`, intent, true);
    const observed = await pinned.stopAndObserve();
    entry.terminal = terminal; entry.intent = intent;
    entry.closure = { v: 1, protocol: protocol('closure'), authorityId: expected.authorityId, slotId: expected.slotId, epoch: current.epoch,
      recordDigest: digestOf(entry.record), assignmentDigest: digestOf(entry.assignment), terminalDigest: digestOf(terminal), intentDigest: digestOf(intent), observed };
    validateAgentScopeClosure(entry.closure, expected, entry.record, entry.assignment, terminal, intent);
    await io.write(`closure-${current.epoch}.json`, entry.closure, true);
    // Empty evidence is durable before scope release. Marker stays locked
    // through release; failure never becomes a consumable closed publication.
    await pinned.releaseScope();
    return await publish('closed');
  } finally {
    try { await pinned?.close(); }
    catch (error) { durable = false; throw error; }
    finally { await unlock({ publicationDurable: durable }); }
  }
}

export async function runAgentScopePublisher({ configFile, mode, assignmentFile = null, terminalFile = null, intentFile = null }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) failScope('linux-root-required');
  const config = await rootRead(configFile);
  const io = await createAgentScopeRuntime(config);
  return publishAgentScope({ expected: config.expected, mode, configuredAnchorDigest: config.configuredAnchorDigest,
    assignment: assignmentFile ? await rootRead(assignmentFile) : null,
    terminal: terminalFile ? await rootRead(terminalFile) : null, intent: intentFile ? await rootRead(intentFile) : null, io });
}
/** Root-only adapter used identically by CLI and the isolated OS experiment. */
export async function createAgentScopeRuntime(config) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) failScope('linux-root-required');
  if (!exactScope(config, ['v', 'expected', 'registryDir', 'identity', 'runtimeAdapter', 'configuredAnchorDigest']) || config.v !== 1 ||
      !exactScope(config.identity, ['origin', 'keyFile', 'certFile', 'caFile'])) failScope('config');
  const expected = validateAgentScopeExpected(config.expected);
  if (new URL(config.identity.origin).hostname !== '127.0.0.1') failScope('identity-origin');
  const io = await createRootScopeRuntimeV2({ ...config, expected: scopeRuntimeExpected(expected) }, {
    validateReservation: value => validateAgentScopeReservation(value, expected), identityPath: '/internal/v2/agent/run-scope/identity',
  });
  const identity = io.identity;
  io.identity = async reservation => {
    const tuple = await io.inspect(reservation); let before;
    for (let attempt = 0; ; attempt++) {
      try { before = await listenerOwnership(config.identity.origin, tuple.instance); break; }
      catch (e) {
        if (e.code !== 'agent-scope-listener-not-ready' || attempt >= 6) throw e;
        if (!sameScope(tuple, await io.inspect(reservation))) failScope('instance-changed');
        await new Promise(r => setTimeout(r, Math.min(100 * 2 ** attempt, 1600)));
      }
    }
    const result = await identity(reservation), after = await listenerOwnership(config.identity.origin, tuple.instance);
    if (!sameScope(before, after) || !sameScope(tuple, await io.inspect(reservation))) failScope('identity-socket-changed');
    return result;
  };
  return io;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [flag, configFile, modeFlag, ...rest] = process.argv.slice(2), mode = modeFlag?.replace(/^--/, '');
    if (flag !== '--config' || !configFile || !['initialize', 'start', 'bind', 'close'].includes(mode) ||
        rest.length !== (mode === 'bind' ? 1 : mode === 'close' ? 2 : 0)) failScope('cli');
    const result = await runAgentScopePublisher({ configFile, mode, assignmentFile: mode === 'bind' ? rest[0] : null,
      terminalFile: mode === 'close' ? rest[0] : null, intentFile: mode === 'close' ? rest[1] : null });
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
  } catch (e) { process.stderr.write(JSON.stringify({ ok: false, code: /^(agent-scope|publisher|asset-root-v2)-[a-z-]+$/.test(e.code ?? '') ? e.code : 'agent-scope-failed' }) + '\n'); process.exitCode = 1; }
}
