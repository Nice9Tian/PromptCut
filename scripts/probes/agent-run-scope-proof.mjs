/** ROOT-ONLY, one-shot isolated Linux proof. No production units or models.
 * Usage: node ... --config /run/<fresh>/probe.json --out /run/<fresh>/out [--forced]
 * Root precreates TWO fixed service fragments (Restart=no, KillMode=control-group,
 * Delegate=no, TimeoutStopSec=5, no base Slice=), fresh PKI and root configs.
 * probe.json={v:1,issuerPrivateKeyFile,protectedUnits:[four existing units],
 * slots:[{publisherConfigFile,workerConfigFile},...]}
 * This signs controlled Doc certificates; it does not claim real Doc admission.
 * Failures retain files/locks/units for explicit root inspection, never retry.
 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { execFile } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { digestOf } from '../../server/account/ledger.mjs';
import { rootRead, procInfo, systemUnitV2, writePublisherArtifact } from '../../server/hosted/deploy/asset-root-registry-publisher.mjs';
import { publishAgentScope, createAgentScopeRuntime } from '../../server/hosted/deploy/agent-run-scope-publisher.mjs';
import { createAgentScopeReader } from '../../server/hosted/agent-run-scope-reader.mjs';
import { exactScope, sameScope, validateAgentScopeExpected } from '../../server/hosted/agent-run-scope-schema.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const delay = ms => new Promise(r => setTimeout(r, ms));
const command = (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 5000, windowsHide: true, encoding: 'utf8', maxBuffer: 65536 },
  (error, stdout) => error ? reject(Error('probe-command-failed')) : resolve(stdout)));
const signValue = (body, key) => ({ ...body, signature: sign(null, Buffer.from(digestOf(body)), key).toString('base64url') });
const pin = v => String(v ?? '').replaceAll(':', '').toLowerCase();
async function listeners() {
  const text = await command('/usr/bin/ss', ['-ltnH']);
  return text.split('\n').map(line => Number(/:(\d+)$/.exec(line.trim().split(/\s+/)[3] ?? '')?.[1])).filter(p => p >= 6540 && p <= 6549);
}
async function protectedSnapshot(units) {
  const rows = [];
  for (const unit of units) {
    const raw = await command('/usr/bin/systemctl', ['show', unit, '--no-pager', '--property=Id', '--property=MainPID', '--property=NRestarts', '--property=ActiveState']);
    const v = Object.fromEntries(raw.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (v.Id !== unit || v.ActiveState !== 'active' || !/^[1-9][0-9]*$/.test(v.MainPID ?? '') || !/^[0-9]+$/.test(v.NRestarts ?? '')) fail('probe-protected-unit-unknown');
    rows.push(v);
  }
  return rows;
}
async function requestIntent(config, assignment, terminal, forcedExit = false) {
  const [key, cert, ca] = await Promise.all(['keyFile', 'certFile', 'caFile'].map(k => rootRead(config.identity[k], false, true)));
  return new Promise((resolve, reject) => {
    let socket, result, error, completed = false;
    const finish = () => { if (completed) return; completed = true; error || !result ? reject(Error('probe-intent-failed')) : resolve(result); };
    const req = https.request(new URL(`/internal/v2/agent/run-scope/${forcedExit ? 'probe-parent-exit' : 'probe-intent'}`, config.identity.origin), {
      method: 'POST', agent: false, key, cert, ca, minVersion: 'TLSv1.3', rejectUnauthorized: true, timeout: 3000,
      checkServerIdentity(host, peer) { return checkServerIdentity(host, peer) || (pin(peer.fingerprint256) !== config.expected.serverFingerprint256 ? Error('pin') : undefined); },
      headers: { 'content-type': 'application/json' },
    }, res => {
      const chunks = []; let length = 0;
      res.on('data', b => { length += b.length; if (length > 16384) { error = Error('size'); req.destroy(); } else chunks.push(b); });
      res.on('error', e => { error = e; req.destroy(); }); res.on('aborted', () => { error = Error('aborted'); req.destroy(); });
      res.on('end', () => { try { const body = JSON.parse(Buffer.concat(chunks)); if (res.statusCode !== 200 || !body.ok) throw Error('status'); result = body.result; }
        catch (e) { error = e; } req.destroy(); socket?.destroy(); });
    });
    req.on('socket', s => { socket = s; s.once('close', finish); });
    req.on('error', e => { error = e; if (!socket) finish(); });
    req.on('timeout', () => { error = Error('timeout'); req.destroy(); });
    req.end(JSON.stringify({ assignment, terminal }));
  });
}
async function observer(slot) {
  const peers = new Map(), sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); let text = '', peer;
    socket.on('error', () => {});
    socket.on('data', b => {
      text += b.toString('utf8'); if (text.length > 256) { socket.destroy(); return; }
      if (!text.endsWith('\n') || peer) return;
      const parts = text.trim().split('|');
      if (parts.length !== 3 || parts[0] !== slot.expected.slotId || !['parent', 'child'].includes(parts[1]) || !/^[1-9][0-9]*$/.test(parts[2]) || peers.has(parts[1])) { socket.destroy(); return; }
      peer = { pid: Number(parts[2]), eof: false, closed: false };
      peers.set(parts[1], peer);
    });
    socket.on('end', () => { if (peer) peer.eof = true; }); socket.on('close', () => { if (peer) peer.closed = true; });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(slot.worker.observerPort, '127.0.0.1', resolve); });
  return { peers, async close() { for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); } };
}
async function birthGone(tuple) {
  try { return (await procInfo(tuple.pid)).startTicks !== tuple.startTicks; }
  catch (e) { if (e.code === 'ENOENT') return true; throw e; }
}
async function holdsFile(pid, file) {
  try { for (const fd of await fs.readdir(`/proc/${pid}/fd`)) if (await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => '') === file) return true; }
  catch (e) { if (e.code !== 'ENOENT') throw e; } return false;
}
async function peersReady(slot, until) {
  while (Date.now() < until && slot.observer.peers.size !== 2) await delay(20);
  if (slot.observer.peers.size !== 2) fail('probe-peers-missing');
  const parent = slot.observer.peers.get('parent'), child = slot.observer.peers.get('child');
  const p = await procInfo(parent.pid), c = await procInfo(child.pid);
  if (parent.pid !== slot.record.instance.pid || p.startTicks !== slot.record.instance.pidBirth.startTicks ||
      p.uid !== slot.expected.uid || c.uid !== slot.expected.uid || c.cgroupPath !== slot.record.instance.cgroup.v2Path ||
      !(await holdsFile(child.pid, slot.worker.holdFile))) fail('probe-child-ownership');
  return { parent: p, child: c };
}
export async function runAgentScopeProof({ configFile, out, forced = false }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) fail('probe-linux-root-required');
  const config = await rootRead(configFile);
  if (!exactScope(config, ['v', 'issuerPrivateKeyFile', 'protectedUnits', 'slots']) || config.v !== 1 || !Array.isArray(config.slots) || config.slots.length !== 2 ||
      !Array.isArray(config.protectedUnits) || config.protectedUnits.length !== 4 || new Set(config.protectedUnits).size !== 4 ||
      config.protectedUnits.some(v => typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/.test(v))) fail('probe-config');
  if ((await listeners()).length) fail('probe-port-in-use');
  const slots = [], startedAt = Date.now(), deadline = startedAt + 30000; let stage = 'preflight';
  const result = { ok: false, mode: forced ? 'forced-dead-parent' : 'normal', controlledDocIssuer: true, productionExecutor: false, samples: [], checks: [], errors: [], retainedUnits: [] };
  result.protectedBefore = await protectedSnapshot(config.protectedUnits);
  const key = createPrivateKey(await rootRead(config.issuerPrivateKeyFile, false, true));
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
  if (key.asymmetricKeyType !== 'ed25519') fail('probe-issuer');
  for (const item of config.slots) {
    if (!exactScope(item, ['publisherConfigFile', 'workerConfigFile'])) fail('probe-config');
    const cfg = await rootRead(item.publisherConfigFile), worker = await rootRead(item.workerConfigFile), expected = validateAgentScopeExpected(cfg.expected);
    if (!/^pcagentrunproof[0-9a-f]{16}[ab]\.service$/.test(expected.unit) || config.protectedUnits.includes(expected.unit) || expected.docPublicKey !== publicKey || cfg.configuredAnchorDigest !== null ||
        !sameScope(worker.expected, expected) || worker.registryDir !== cfg.registryDir || ![worker.port, worker.observerPort].every(p => p >= 6540 && p <= 6549)) fail('probe-config');
    const unit = await systemUnitV2(expected.unit);
    if (unit.ActiveState !== 'inactive' || Number(unit.MainPID) !== 0 || unit.ControlGroup) fail('probe-unit-not-idle');
    const io = await createAgentScopeRuntime(cfg);
    slots.push({ expected, cfg, worker, io });
  }
  for (const field of ['unit', 'slotId', 'authorityId']) if (slots[0].expected[field] === slots[1].expected[field]) fail('probe-slots-not-independent');
  if (slots[0].cfg.registryDir === slots[1].cfg.registryDir || new Set(slots.flatMap(s => [s.worker.port, s.worker.observerPort])).size !== 4) fail('probe-slots-not-independent');
  await fs.mkdir(out, { mode: 0o755 }); await fs.chmod(out, 0o755); // exclusive; never chmod an existing output directory
  const signing = (slot, kind, extra) => signValue({ v: 1, protocol: `promptcut.agent-run-scope.${kind}.v1`, authorityId: slot.expected.authorityId,
    slotId: slot.expected.slotId, epoch: 1, recordDigest: digestOf(slot.record), docAuthorityId: slot.expected.docAuthorityId, ...extra }, key);
  try {
    for (const slot of slots) {
      stage = `${slot.expected.slotId}-initialize`;
      slot.observer = await observer(slot);
      const first = await publishAgentScope({ expected: slot.expected, mode: 'initialize', io: slot.io });
      slot.anchorDigest = first.anchorDigest;
      slot.reader = createAgentScopeReader({ registryDir: slot.cfg.registryDir, expected: slot.expected, configuredAnchorDigest: slot.anchorDigest });
      slot.record = (await slot.reader.read()).record;
      stage = `${slot.expected.slotId}-bind`;
      slot.assignment = signing(slot, 'assignment', { target: { projectId: 'isolated-proof', conversationId: slot.expected.slotId,
        messageId: `message-${slot.expected.slotId}`, runId: `run-${slot.expected.slotId}`, runGrantId: `grant-${slot.expected.slotId}`,
        serviceId: 'agent', serviceKid: 'controlled-doc-agent-key', instanceId: slot.record.instance.instanceId,
        instanceGeneration: 1, publicKeyDigest: slot.record.worker.publicKeyDigest } });
      await publishAgentScope({ expected: slot.expected, mode: 'bind', io: slot.io, configuredAnchorDigest: slot.anchorDigest, assignment: slot.assignment });
      slot.births = await peersReady(slot, deadline); slot.checkpoint = (await slot.reader.read()).checkpoint;
      result.checks.push(`${slot.expected.slotId}:ready-bound-real-TLS-root-files`);
    }
    const [a, b] = slots;
    const closeSlot = async (slot, observeNegative) => {
      const forcedSlot = forced && observeNegative;
      stage = `${slot.expected.slotId}-terminal-intent`;
      const terminal = forcedSlot ? signing(slot, 'forced-terminal', { assignmentDigest: digestOf(slot.assignment), fence: {
        controlId: `controlled-private-${slot.expected.slotId}`, fenceRevision: 1, payloadDigest: digestOf({ controlledFixture: true, kind: 'private' }),
        kind: 'private', outcome: 'interrupted' } }) : signing(slot, 'terminal', { assignmentDigest: digestOf(slot.assignment), finish: {
        readReceiptId: `controlled-read-${slot.expected.slotId}`, finishReceiptId: `controlled-finish-${slot.expected.slotId}`,
        outcomeDigest: digestOf({ status: 'done', controlledFixture: true }), terminalReceiptDigest: digestOf({ fixture: 'RAM-intent-before-OS-stop' }) } });
      const intent = forcedSlot ? null : await requestIntent(slot.cfg, slot.assignment, terminal);
      const pinName = forcedSlot ? 'pinRetired' : 'pinPrevious', originalPin = slot.io[pinName];
      const group = await fs.open(slot.record.closureScope.cgroup.v2Path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      let events;
      try { events = await fs.open(`/proc/self/fd/${group.fd}/cgroup.events`, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (e) { await group.close(); throw e; }
      let negative = false, sampling = true, sampleError;
      const sample = async () => {
        const st = await group.stat({ bigint: true });
        if (String(st.dev) !== slot.record.closureScope.cgroup.dev || String(st.ino) !== slot.record.closureScope.cgroup.ino) fail('probe-fixed-fd-changed');
        const bytes = Buffer.alloc(4096), read = await events.read(bytes, 0, bytes.length, 0);
        const match = /^populated ([01])$/m.exec(bytes.subarray(0, read.bytesRead).toString('utf8')); if (!match) fail('probe-populated-unknown');
        const mainGone = await birthGone(slot.births.parent), childGone = await birthGone(slot.births.child);
        const held = !childGone && await holdsFile(slot.births.child.pid, slot.worker.holdFile);
        const peersClosed = [...slot.observer.peers.values()].every(p => p.eof && p.closed);
        const row = { ms: Date.now() - startedAt, slotId: slot.expected.slotId, populated: Number(match[1]), mainGone, childGone, held, peersClosed };
        if (observeNegative && !negative && mainGone && !childGone && held && !peersClosed && row.populated === 1) {
          const scopeUnit = await systemUnitV2(slot.record.closureScope.unit);
          if (scopeUnit.ActiveState !== 'active' || scopeUnit.InvocationID !== slot.record.closureScope.unitInvocationId) fail('probe-scope-changed');
          let blocked = false;
          try { const p = await slot.reader.read({ checkpoint: slot.checkpoint }); blocked = forcedSlot && p.checkpoint.head.phase === 'bound'; }
          catch (e) { blocked = e.code === 'agent-scope-publisher-locked'; }
          if (!blocked) fail('probe-reader-during-negative');
          result.checks.push(forcedSlot ? 'A-parent-already-gone-child-live-reader-not-closed-same-active-scope' : 'A-parent-gone-child-FD-TCP-live-reader-locked-same-active-scope'); negative = true;
        }
        if (!result.samples.length || !sameScope({ ...row, ms: 0 }, { ...result.samples.at(-1), ms: 0 })) result.samples.push(row);
        return row;
      };
      const monitor = (async () => { while (sampling && Date.now() < deadline) { try { await sample(); } catch (e) { sampleError = e; break; } await delay(20); } })();
      slot.io[pinName] = async old => {
        if (forcedSlot && (!negative || !await birthGone(slot.births.parent) || await birthGone(slot.births.child))) fail('probe-forced-pin-precondition');
        const pin = await originalPin(old);
        return { ...pin, async stopAndObserve() {
          const observed = await pin.stopAndObserve(); sampling = false; await monitor;
          if (sampleError) throw sampleError;
          while (![...slot.observer.peers.values()].every(p => p.eof && p.closed) && Date.now() < deadline) await delay(10);
          const row = await sample();
          if (row.populated !== 0 || !row.mainGone || !row.childGone || !row.peersClosed || (observeNegative && !negative)) fail('probe-negative-or-close-missing');
          if (observeNegative && (!sameScope((await b.reader.read()).record, b.record) || await birthGone(b.births.child) ||
              !await holdsFile(b.births.child.pid, b.worker.holdFile) || [...b.observer.peers.values()].some(p => p.closed))) fail('probe-other-slot-interrupted');
          return observed;
        } };
      };
      try {
        if (forcedSlot) {
          // Reject an actual other-slot OS identity before causing any parent exit.
          let rejected = false;
          try { const wrong = await originalPin({ ...slot.record, instance: b.record.instance }); await wrong.close(); }
          catch (e) { rejected = e.code === 'publisher-previous-instance-mismatch'; }
          if (!rejected || await birthGone(slot.births.parent) || await birthGone(b.births.parent)) fail('probe-replacement-not-rejected');
          result.checks.push('actual-B-OS-tuple-cannot-replace-A-no-stop');
          const ack = await requestIntent(slot.cfg, slot.assignment, terminal, true);
          if (ack.instanceId !== slot.record.instance.instanceId || ack.parentExitRequested !== true) fail('probe-parent-exit-ack');
          while (!negative && !sampleError && Date.now() < deadline) await delay(10);
          if (!negative || sampleError) fail('probe-dead-parent-negative-missing');
        }
        stage = `${slot.expected.slotId}-close`;
        await publishAgentScope({ expected: slot.expected, mode: forcedSlot ? 'forced-close' : 'close', io: slot.io, configuredAnchorDigest: slot.anchorDigest, terminal, intent });
        const projection = await slot.reader.read({ checkpoint: slot.checkpoint });
        if (projection.checkpoint.head.phase !== 'closed') fail('probe-reader-not-closed');
        result.checks.push(`${slot.expected.slotId}:original-FD-empty-durable-reader-closed`);
      } finally { sampling = false; await monitor; await events.close(); await group.close(); slot.io[pinName] = originalPin; }
    };
    await closeSlot(a, true); result.checks.push('B-continued-during-A-close'); await closeSlot(b, false);
    // Actual trusted-file reader rejects incomplete and mixed evidence without
    // editing a good published chain. A preexisting lock file is exercised only
    // in a fresh root-owned copy, never a production directory.
    const source = a.cfg.registryDir;
    for (const kind of ['missing-marker', 'lock', 'mixed', 'new-empty']) {
      stage = `reader-${kind}`;
      const dir = path.join(path.dirname(source), `rejected-${kind}`); await fs.mkdir(dir, { mode: 0o755 }); await fs.chmod(dir, 0o755);
      for (const name of await fs.readdir(source)) if (name.endsWith('.json')) await fs.copyFile(path.join(source, name), path.join(dir, name), constants.COPYFILE_EXCL);
      if (kind === 'missing-marker') await fs.unlink(path.join(dir, 'publication-1-closed.json'));
      if (kind === 'lock') await writePublisherArtifact({ dir, name: 'lock-evidence.json', value: { pid: process.pid }, exclusive: true });
      if (kind === 'lock') await fs.rename(path.join(dir, 'lock-evidence.json'), path.join(dir, '.publisher.lock'));
      if (kind === 'mixed') await fs.copyFile(path.join(b.cfg.registryDir, 'closure-1.json'), path.join(dir, 'closure-1.json'));
      if (kind === 'new-empty') { const record = await rootRead(path.join(dir, 'epoch-1.json')); record.instance.instanceId = 'replacement-empty'; await writePublisherArtifact({ dir, name: 'epoch-1.json', value: record }); }
      let rejected = false; try { await createAgentScopeReader({ registryDir: dir, expected: a.expected, configuredAnchorDigest: a.anchorDigest }).read(); } catch { rejected = true; }
      if (!rejected) fail('probe-invalid-chain-accepted'); result.checks.push(`${kind}:reader-rejected`);
    }
    result.ok = true;
  } catch (e) { result.errors.push(`${stage}:${/^[a-z][a-z0-9-]+$/.test(e.code ?? '') ? e.code : 'probe-failed'}`); }
  finally {
    for (const slot of slots) try { await slot.observer?.close(); } catch { result.errors.push('probe-observer-close-unknown'); }
    for (const slot of slots) {
      try { const u = await systemUnitV2(slot.expected.unit); if (u.ActiveState !== 'inactive' || Number(u.MainPID) !== 0) result.retainedUnits.push({ unit: u.Id, activeState: u.ActiveState, mainPid: Number(u.MainPID) }); }
      catch { result.retainedUnits.push({ unit: slot.expected.unit, activeState: 'unknown' }); }
    }
    try { result.listeners = await listeners(); } catch { result.listeners = null; result.errors.push('probe-listeners-unknown'); }
    result.durationMs = Date.now() - startedAt;
    try { result.protectedAfter = await protectedSnapshot(config.protectedUnits); }
    catch { result.protectedAfter = null; result.errors.push('probe-protected-units-unknown'); }
    if (!sameScope(result.protectedBefore, result.protectedAfter)) result.errors.push('probe-protected-units-changed');
    if (result.listeners?.length || result.retainedUnits.length) result.errors.push('probe-owned-resources-retained');
    if (result.errors.length) result.ok = false;
    await writePublisherArtifact({ dir: out, name: 'result.json', value: result, exclusive: true, publicMetadata: true });
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const a = process.argv.slice(2); if (![4, 5].includes(a.length) || a[0] !== '--config' || a[2] !== '--out' || (a.length === 5 && a[4] !== '--forced')) fail('probe-cli');
    const result = await runAgentScopeProof({ configFile: a[1], out: a[3], forced: a[4] === '--forced' }); process.stdout.write(JSON.stringify(result) + '\n'); if (!result.ok) process.exitCode = 1;
  } catch (e) { process.stderr.write(JSON.stringify({ ok: false, code: e.code ?? 'probe-failed' }) + '\n'); process.exitCode = 1; }
}
