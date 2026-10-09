import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scopeModel, pair, signed } from './agent-run-scope-fixture.mjs';
import { digestOf } from '../account/ledger.mjs';
import { inspectAgentScopeSource, createAgentScopeReader } from '../hosted/agent-run-scope-reader.mjs';
import { validateAgentScopeReservation, scopeRuntimeExpected } from '../hosted/agent-run-scope-schema.mjs';
import { runAgentScopePublisher, parseAgentTcpListeners, validateAgentListenerOwner } from '../hosted/deploy/agent-run-scope-publisher.mjs';
import { openPublisherLock, writePublisherArtifact, createRootScopeRuntimeV2 } from '../hosted/deploy/asset-root-registry-publisher.mjs';

const read = (m, checkpoint = null) => inspectAgentScopeSource({ read: m.io.read, expected: m.expected,
  configuredAnchorDigest: digestOf(m.files.get('anchor.json')), checkpoint });
const initialize = async () => { const m = scopeModel(); await m.run('initialize'); return m; };
const bound = async () => { const m = await initialize(); await m.run('bind', { assignment: m.assignment() }); return m; };

test('listener parser/owner refuses another MainPID fd set, wildcard, other UID and ambiguous/reused port', async t => {
  const header = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
  const row = '0: 0100007F:198C 00000000:0000 0A 00000000:00000000 00:00000000 00000000 12001 0 91234 1 0';
  const input = { tcp4: `${header}\n${row}`, tcp6: header, links: ['socket:[91234]'], port: 6540, uid: 12001 };
  assert.equal(validateAgentListenerOwner(input).inode, '91234');
  assert.equal(parseAgentTcpListeners(input.tcp4, 4)[0].address, '0100007F');
  for (const [name, change] of [
    ['wrong MainPID owns different socket', { links: ['socket:[77777]'] }],
    ['recycled inode absent from actual fd', { links: [] }],
    ['wildcard bound management listener', { tcp4: `${header}\n${row.replace('0100007F', '00000000')}` }],
    ['other UID', { uid: 12002 }],
    ['multiple candidates', { tcp4: `${header}\n${row}\n${row.replace('91234', '91235')}` }],
    ['unknown table', { tcp4: '' }],
    ['malformed table', { tcp4: `${header}\n0: missing` }],
    ['IPv6 alternative listener', { tcp4: header, tcp6: `${header}\n${row.replace('0100007F', '00000000000000000000000001000000')}` }],
  ]) await t.test(name, () => assert.throws(() => validateAgentListenerOwner({ ...input, ...change })));
  assert.throws(() => validateAgentListenerOwner({ ...input, tcp4: header }), { code: 'agent-scope-listener-not-ready' });
});

test('controlled two independent slots: closing A leaves B bound; two epochs have distinct complete OS/key identities', async () => {
  const a = await bound(), b = scopeModel('slot-b'); await b.run('initialize'); await b.run('bind', { assignment: b.assignment() });
  const oldB = structuredClone([...b.files]), cp = (await read(a)).checkpoint;
  await a.run('close', a.closing()); const closed = await read(a, cp);
  assert.equal(closed.checkpoint.head.phase, 'closed'); assert.equal(closed.closure.observed.populated, 0);
  assert.deepEqual([...b.files], oldB); assert.equal((await read(b)).checkpoint.head.phase, 'bound');
  await a.run('start'); const next = await read(a, closed.checkpoint); assert.equal(next.record.epoch, 2);
  assert.notEqual(next.record.worker.publicKeyDigest, closed.record.worker.publicKeyDigest);
  assert.notEqual(next.record.closureScope.cgroup.ino, closed.record.closureScope.cgroup.ino);
});
test('single generation admits one signed grant; exact bind retry is idempotent, another conversation conflicts', async () => {
  const m = await bound(), original = m.files.get('assignment-1.json');
  await m.run('bind', { assignment: original }); assert.equal((await read(m)).assignment.target.runGrantId, 'grant-1');
  await assert.rejects(m.run('bind', { assignment: m.assignment({ conversationId: 'other', runGrantId: 'other' }) }), { code: 'agent-scope-assignment-conflict' });
  assert.deepEqual(m.files.get('assignment-1.json'), original); assert.ok(m.files.has('.publisher.lock'));
});
test('terminal retry uses identical old intent; changed terminal cannot rewrite closed history', async () => {
  const m = await bound(), c = m.closing(); await m.run('close', c);
  const old = structuredClone(m.files.get('closure-1.json')), stops = m.calls.filter(x => x === 'stop').length;
  await m.run('close', c); assert.equal(m.calls.filter(x => x === 'stop').length, stops);
  const { signature, ...body } = c.terminal; body.finish.finishReceiptId = 'another-finish';
  const terminal = signed(body, m.doc.privateKey);
  await assert.rejects(m.run('close', { terminal, intent: c.intent })); assert.deepEqual(m.files.get('closure-1.json'), old);
});
test('fresh generation cannot reuse old runGrantId even with a new valid doc signature', async () => {
  const m = await bound(); await m.run('close', m.closing()); await m.run('start');
  await assert.rejects(m.run('bind', { assignment: m.assignment({ runGrantId: 'grant-1' }) }), { code: 'agent-scope-grant-reused' });
  assert.equal(m.files.has('assignment-2.json'), false);
});
test('RAM key reuse across OS generations is rejected before a new publication', async () => {
  const m = await bound(), old = m.files.get('epoch-1.json').worker; await m.run('close', m.closing());
  const originalIdentity = m.io.identity; m.io.identity = async r => ({ ...await originalIdentity(r), ...old });
  await assert.rejects(m.run('start'), { code: 'agent-scope-generation-reused' });
  assert.equal(m.files.has('publication-2-ready.json'), false); assert.ok(m.files.has('.publisher.lock'));
});
test('active slot cannot start new OS generation', async () => {
  const m = await initialize(); await assert.rejects(m.run('start'), { code: 'agent-scope-slot-occupied' });
  assert.equal(m.calls.filter(x => x === 'start').length, 1);
});
test('missing or forged Doc signature never reaches OS stop', async () => {
  const m = await bound(), c = m.closing(); c.terminal.finish.finishReceiptId = 'other';
  await assert.rejects(m.run('close', c), { code: 'agent-scope-signature' }); assert.equal(m.calls.includes('pin'), false);
});
test('new OS key cannot sign the old terminal intent', async () => {
  const m = await bound(), c = m.closing(), { signature, ...body } = c.intent;
  c.intent = signed(body, pair().privateKey);
  await assert.rejects(m.run('close', c), { code: 'agent-scope-signature' }); assert.equal(m.calls.includes('stop'), false);
});
test('wrong slot/instance/generation is not accepted merely because a signature is valid', async t => {
  for (const change of [{ instanceId: 'replacement' }, { instanceGeneration: 0 }, { publicKeyDigest: 'f'.repeat(64) }, { serviceId: 'asset' }])
    await t.test(JSON.stringify(change), async () => { const m = await initialize();
      await assert.rejects(m.run('bind', { assignment: m.assignment(change) })); assert.equal(m.files.has('assignment-1.json'), false); });
});
test('old FD errors/nonempty keep marker absent, lock held, scope unreleased', async t => {
  for (const fault of ['observe', 'populated', 'pin', 'release']) await t.test(fault, async () => {
    const m = await bound(); m.faults[fault] = fault === 'populated' ? 1 : true;
    await assert.rejects(m.run('close', m.closing()));
    assert.ok(m.files.has('.publisher.lock')); assert.equal(m.files.has('publication-1-closed.json'), false);
    await assert.rejects(read(m), { code: 'agent-scope-publisher-locked' });
    if (fault !== 'release') assert.equal(m.calls.includes('release'), false);
  });
});
test('closure is durable before scope release and publication; no successful close is inferred from visible head', async () => {
  const m = await bound(); m.faults.afterWrite = name => name === 'publication-1-closed.json';
  await assert.rejects(m.run('close', m.closing()), /fsync-after-visible/);
  assert.equal(m.files.get('current.json').phase, 'closed'); assert.ok(m.files.has('publication-1-closed.json'));
  assert.ok(m.calls.indexOf('write:closure-1.json') < m.calls.indexOf('release'));
  await assert.rejects(read(m), { code: 'agent-scope-publisher-locked' });
});
test('reader rejects missing marker, mixed target, partial history, rollback and moved scope inode', async t => {
  for (const mutation of [
    m => m.files.delete('publication-1-closed.json'),
    m => { m.files.get('closure-1.json').assignmentDigest = 'f'.repeat(64); },
    m => m.files.delete('reservation-1.json'),
    m => { m.files.get('epoch-1.json').closureScope.cgroup.ino = '9999'; },
    m => { m.files.get('current.json').phase = 'ready'; },
  ]) await t.test('tampered chain', async () => { const m = await bound(); await m.run('close', m.closing()); mutation(m); await assert.rejects(read(m)); });
  const m = await bound(), old = structuredClone([...m.files]); await m.run('close', m.closing()); const cp = (await read(m)).checkpoint;
  m.files.clear(); old.forEach(([k, v]) => m.files.set(k, v)); await assert.rejects(read(m, cp), { code: 'agent-scope-rollback' });
});
test('reader detects a concurrent transition or lock before returning a projection', async () => {
  const m = await bound(); let calls = 0;
  const readChanged = async name => { const value = await m.io.read(name); if (name === 'current.json' && ++calls === 2) value.phase = 'closed'; return value; };
  await assert.rejects(inspectAgentScopeSource({ read: readChanged, expected: m.expected, configuredAnchorDigest: digestOf(m.files.get('anchor.json')) }), { code: 'agent-scope-source-changed' });
});
test('Agent reservation domain cannot be exchanged for Asset, and trusted anchor is explicit', async () => {
  const m = await initialize(), r = structuredClone(m.files.get('reservation-1.json')); r.protocol = 'promptcut.asset-root-reservation.v2';
  assert.throws(() => validateAgentScopeReservation(r, m.expected));
  await assert.rejects(inspectAgentScopeSource({ read: m.io.read, expected: m.expected, configuredAnchorDigest: 'f'.repeat(64) }), { code: 'agent-scope-anchor-or-lock' });
});
test('unknown/prototype phases cannot skip publication checks', async t => {
  for (const phase of ['__proto__', 'constructor', 'finished', null, {}]) await t.test(String(phase), async () => {
    const m = await bound(); m.files.get('current.json').phase = phase;
    await assert.rejects(read(m), { code: 'agent-scope-history' });
  });
});
test('real TMP file post-link directory barrier failure leaves visible marker AND exclusion lock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-agent-scope-fsync-'));
  const release = await openPublisherLock(dir, { directoryBarrier: async () => {} });
  try {
    await assert.rejects(writePublisherArtifact({ dir, name: 'publication-1-closed.json', value: { deliberately: 'not-a-valid-proof' }, exclusive: true,
      directoryBarrier: async () => { throw Error('post-link-dir-fsync'); } }), /post-link-dir-fsync/);
    assert.ok(await fs.stat(path.join(dir, 'publication-1-closed.json')));
  } finally { await release({ publicationDurable: false }); }
  assert.ok(await fs.stat(path.join(dir, '.publisher.lock')));
  // Files are only this test's evidence; keep directory for the first-failure audit.
});
test('Windows is never promoted to Linux root by an injected callback or valid config', async () => {
  if (process.platform === 'linux') return;
  const m = scopeModel(); await assert.rejects(runAgentScopePublisher({ configFile: 'unused', mode: 'initialize' }), { code: 'agent-scope-linux-root-required' });
  await assert.rejects(createRootScopeRuntimeV2({ expected: scopeRuntimeExpected(m.expected) }), { code: 'publisher-linux-root-required' });
  await assert.rejects(createAgentScopeReader({ registryDir: os.tmpdir(), expected: m.expected, configuredAnchorDigest: 'f'.repeat(64) }).read(), { code: 'agent-scope-linux-required' });
});
test('probe/worker CLI guards reject before any listener, and child actual close is awaited', async () => {
  for (const relative of ['../../scripts/probes/agent-run-scope-proof.mjs', '../../scripts/probes/fixtures/agent-run-scope-worker.mjs']) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL(relative, import.meta.url)), '--invalid'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
      child.once('error', reject); child.once('close', code => resolve({ code, output }));
    });
    assert.equal(result.code, 1); assert.match(result.output, /"ok":false/);
  }
});
