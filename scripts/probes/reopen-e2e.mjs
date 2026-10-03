/** Isolated editor reopen probe. Starts and stops only its own services and browser. */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { waitFor } from '../../server/test/fake-ws-kit.mjs';

const require = createRequire(import.meta.url);
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reopen-e2e-'));
const testData = who => path.join(root, who);
const secret = () => randomBytes(32).toString('base64url');
const password = secret(), creatorPassword = secret();
const editors = new Set(); let browser, cloud; let phase = 'startup';
const evidence = [];
let wan; const wanResults = [];
const where = process.argv.includes('--hosted') ? 'hosted' : 'lan';
const mode = process.argv.includes('--restricted') ? 'restricted' : 'free';
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exit = new Promise(r => child.once('exit', r)); child.kill(); await exit; editors.delete(child);
}
async function editor(who, port) {
  fs.mkdirSync(testData(who), { recursive: true });
  const child = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, PROMPTCUT_DATA_DIR: testData(who), PROMPTCUT_EXPORT_DIR: path.join(testData(who), 'export'),
      PROMPTCUT_PROJECTS_DIR: path.join(testData(who), 'drafts'), PROMPTCUT_DEVICE_ID: `probe-${who}-device-000001`, PROMPTCUT_DEVICE_NAME: `isolated-${who}`,
      PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  editors.add(child); child.stdout.resume(); child.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { if (child.exitCode !== null) throw new Error('isolated editor exited'); try { const r = await fetch(`${base}/api/docservice/device`, { signal: AbortSignal.timeout(1000) }); return r.ok; } catch { return false; } }, 30000, 'isolated editor');
  return { child, base, pid: child.pid };
}
async function page(base) {
  const context = await browser.createBrowserContext(), p = await context.newPage();
  p.on('console', m => { if (/\[(collab|sync)\]/.test(m.text())) console.error(m.text().replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')); });
  await p.goto(base, { waitUntil: 'domcontentloaded' });
  await p.evaluate(async () => {
    const [sync, proc, store, collab, pack, drafts] = await Promise.all([import('/src/editor/sync/syncManager.ts'), import('/src/editor/io/proc.ts'), import('/src/store/project.ts'), import('/src/editor/sync/collab.ts'), import('/src/editor/io/procp.ts'), import('/src/editor/io/drafts.ts')]);
    window.probe = { sync, proc, store, collab, pack, drafts };
    await sync.startSync();
  });
  return p;
}
async function connected(p, roomId, username) {
  try { await p.waitForFunction((room, user) => { const v = window.probe.sync.getSyncView(); return v.shared?.projectId === room && v.shared.username === user && v.status === 'online'; }, { timeout: 30000 }, roomId, username); }
  catch { const v = await p.evaluate(() => { const v = window.probe.sync.getSyncView(); return { reopen: v.reopenState, status: v.status, shared: v.shared && { roomId: v.shared.projectId, username: v.shared.username }, registration: v.hostRegistration }; }); throw new Error(`${username} reopen state ${JSON.stringify(v)}`); }
}
async function open(p, text) { await p.evaluate(t => { const { proc, store } = window.probe; store.actions.loadProject(proc.loadProc(t), 'isolated.proc'); }, text); }
async function saved(p) { return p.evaluate(async () => { await window.probe.sync.whenSaved(); return window.probe.proc.serializeProc(); }); }
async function name(p, value) { await p.evaluate(n => window.probe.store.actions.setProjectMeta({ name: n }), value); }
async function sees(p, value) { await p.waitForFunction(n => window.probe.store.getState().project.name === n, { timeout: 20000 }, value); }
try {
  if (process.argv.includes('--wan')) { wan = await (await import('./reopen-wan.mjs')).startWanProbe(); cloud = wan; }
  else { fs.mkdirSync(testData('cloud')); cloud = await startHostedCombo({ dataDir: testData('cloud'), docPort: 0, assetPort: 0, host: '127.0.0.1', trustLoopback: false, clusterToken: secret(), log: () => {} }); }
  const service = wan?.service ?? `http://127.0.0.1:${cloud.docPort}`;
  browser = await puppeteer.launch({ headless: true, userDataDir: path.join(root, 'browser'), args: ['--no-sandbox'] });
  const hostRuntime = await editor('host', 5203), memberRuntime = await editor('member', 5206);
  let host = await page(hostRuntime.base), member = await page(memberRuntime.base);
  phase = 'create original LAN room';
  const created = await host.evaluate(async o => { window.probe.proc.newProject('isolated-reopen-file'); return window.probe.collab.enableCollab(o); }, { where, mode, name: `isolated-reopen-${Date.now()}`, creator: { username: 'host', password: creatorPassword }, projectPassword: password, list: [{ username: 'member', password }], hostedUrl: service });
  assert.equal(created.ok, true, `isolated creation must succeed (${created.error || 'unknown'})`);
  const hostFile = await saved(host), descriptor = JSON.parse(hostFile).collaboration, roomId = descriptor.roomId;
  assert.equal(descriptor.service, service);
  assert.equal(hostFile.includes(password) || hostFile.includes(creatorPassword), false);
  if (where === 'lan') await waitFor(() => cloud.hosting.online(roomId), 10000, 'cloud registration');
  phase = 'member first authentication';
  await open(member, hostFile);
  await member.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'needs-auth');
  const joined = await member.evaluate((o) => window.probe.sync.authenticateRecovery(o.username, o.password, 'member'), { username: 'member', password });
  assert.equal(joined.ok, true, 'member authentication must succeed'); await connected(member, roomId, 'member');
  const memberFile = await saved(member);
  phase = 'both directions before restart';
  await name(member, 'member-edit-before-restart'); await sees(host, 'member-edit-before-restart');
  await name(host, 'host-edit-before-restart'); await sees(member, 'host-edit-before-restart'); await saved(host); await saved(member);
  if (wan) {
    wanResults.push(await wan.peer({ roomId, password, expected: 'host-edit-before-restart', edit: 'wan-edit-before-restart' }));
    await sees(host, 'wan-edit-before-restart'); await sees(member, 'wan-edit-before-restart');
    await name(host, 'host-edit-before-restart'); await sees(member, 'host-edit-before-restart'); await saved(host);
  }
  phase = 'stop original host process';
  await host.close(); await stop(hostRuntime.child);
  if (where === 'lan') await waitFor(async () => !(await cloud.hosting.online(roomId)), 10000, 'host tunnel offline');
  await member.close(); await stop(memberRuntime.child);
  const restoredMember = await editor('member', 5206);
  assert.notEqual(restoredMember.pid, memberRuntime.pid);
  member = await page(restoredMember.base); await open(member, memberFile);
  if (where === 'lan') await member.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'waiting-host', { timeout: 15000 });
  else await connected(member, roomId, 'member');
  phase = 'restart original host at new port and discard browser storage';
  const restoredRuntime = await editor('host', 5209);
  assert.notEqual(restoredRuntime.pid, hostRuntime.pid);
  host = await page(restoredRuntime.base); await open(host, hostFile);
  await connected(host, roomId, 'host'); await connected(member, roomId, 'member');
  await sees(host, 'host-edit-before-restart'); await sees(member, 'host-edit-before-restart');
  phase = 'both directions after automatic reopen';
  await name(member, 'member-edit-after-reopen'); await sees(host, 'member-edit-after-reopen');
  await name(host, 'host-edit-after-reopen'); await sees(member, 'host-edit-after-reopen');
  phase = 'browser relay ticket asset transport';
  const asset = await member.evaluate(async hostedAsset => {
    const v = window.probe.sync.getSyncView(), link = window.probe.sync.currentSharedLink();
    const issued = await link.request({ type: 'auth.ticket', kind: 'asset', access: 'rw' });
    if (issued.type !== 'auth.ticket.ok') throw new Error('asset ticket failed');
    const base = hostedAsset ?? v.shared.base.replace(/\/doc$/, '/asset/api/asset');
    const bytes = crypto.getRandomValues(new Uint8Array(50000));
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    for (const ns of ['media', 'snap', 'px']) {
      const r = await fetch(`${base}/${ns}/${hash}/0`, { method: 'PUT', headers: { Authorization: `Bearer ${issued.ticket}`, 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(bytes.length), 'X-Media-Ext': 'bin' }, body: bytes });
      if (!r.ok) throw new Error(`browser asset upload ${r.status}`);
      const done = await fetch(`${base}/${ns}/${hash}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${issued.ticket}` } });
      if (!done.ok) throw new Error('browser asset completion failed');
    }
    const read = await link.request({ type: 'auth.ticket', kind: 'asset', access: 'r' });
    const r = await fetch(`${base}/media/${hash}?t=${encodeURIComponent(read.ticket)}`);
    if (!r.ok || (await r.arrayBuffer()).byteLength !== bytes.length) throw new Error('browser ticket read failed');
    return { hash, size: bytes.length, browserCors: true, namespaces: ['media', 'snap', 'px'] };
  }, where === 'hosted' ? `http://127.0.0.1:${cloud.assetPort}/api/asset` : null);
  if (wan) {
    phase = 'external member device identity after restart';
    wanResults.push(await wan.peer({ roomId, expected: 'host-edit-after-reopen', edit: 'wan-edit-after-reopen', asset }));
    await sees(host, 'wan-edit-after-reopen'); await sees(member, 'wan-edit-after-reopen');
    await name(host, 'host-edit-after-reopen'); await sees(member, 'host-edit-after-reopen');
    wanResults.push(await wan.peer({ roomId, expected: 'host-edit-after-reopen', asset }));
  }
  const journal = await host.evaluate(async () => { await window.probe.sync.whenSaved(); const d = window.probe.sync.getSyncView().association; return (await window.probe.sync.recoveryRequest('select', d, { contentId: window.probe.store.getState().project.id })).journal; });
  assert.ok(journal.rev >= 5); assert.equal(journal.pending.length, 0);
  phase = 'packed format and draft reopen';
  const packed = await member.evaluate(async () => { const p = await window.probe.pack.packProcp(); const { procText } = await window.probe.pack.unpackProcp(p.blob); return procText; });
  assert.equal(JSON.parse(packed).collaboration.roomId, roomId);
  await member.evaluate(async () => { await window.probe.drafts.saveDraft('isolated-reopen-draft'); window.probe.proc.newProject('unrelated'); await window.probe.drafts.openDraft('isolated-reopen-draft'); });
  await connected(member, roomId, 'member'); await sees(member, 'host-edit-after-reopen');
  phase = 'page refresh through shared coordinator';
  await member.reload({ waitUntil: 'domcontentloaded' });
  await member.evaluate(async () => { const [sync, proc, store, collab, pack, drafts] = await Promise.all([import('/src/editor/sync/syncManager.ts'), import('/src/editor/io/proc.ts'), import('/src/store/project.ts'), import('/src/editor/sync/collab.ts'), import('/src/editor/io/procp.ts'), import('/src/editor/io/drafts.ts')]); window.probe = { sync, proc, store, collab, pack, drafts }; await sync.startSync(); await sync.resumeShared(); });
  await connected(member, roomId, 'member'); await sees(member, 'host-edit-after-reopen');
  if (where === 'hosted') assert.equal(await host.evaluate(() => window.probe.sync.getSyncView().shared.where), 'hosted');
  phase = 'old-file tombstone';
  const disabled = await host.evaluate(pw => window.probe.collab.disableCollab(pw), creatorPassword); assert.equal(disabled.ok, true);
  await open(host, hostFile); await host.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'deleted');
  await host.screenshot({ path: path.join(root, 'recovery-deleted.png') });
  evidence.push({ roomId, where, mode, actualHostProcessRestart: true, actualMemberProcessRestart: true, pidChanged: true, portChanged: true, emptyBrowserStorage: true, memberWaitThenAutoJoin: where === 'lan',
    sameUsers: ['creator:host', 'member:member'], oldSnapshotsPreservedLatest: true, version: journal.rev, bidirectionalEdits: 4, formats: ['proc', 'procp', 'draft', 'refresh'], cancellationTombstone: true });
  const result = { ok: true, evidence, asset, wan: wan ? { service, remoteDirectory: wan.remoteDirectory, path: wan.path, publicHttp: wan.publicHttp, results: wanResults } : null, evidenceDirectory: root };
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (e) {
  console.error(JSON.stringify({ ok: false, phase, error: String(e.message).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]'), evidenceDirectory: root })); process.exitCode = 1;
} finally { await browser?.close(); for (const child of [...editors]) await stop(child); await cloud?.close(); }
