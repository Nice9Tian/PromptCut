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
import { pathToFileURL } from 'node:url';
import { waitFor } from '../../server/test/fake-ws-kit.mjs';

const require = createRequire(import.meta.url);
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reopen-e2e-'));
const testData = who => path.join(root, who);
const secret = () => randomBytes(32).toString('base64url');
const password = secret(); let creatorPassword = secret();
const editors = new Set(); let browser, cloud; let phase = 'startup';
const evidence = [];
let createRequests = 0;
let wan; const wanResults = [];
const where = process.argv.includes('--hosted') ? 'hosted' : 'lan';
const mode = process.argv.includes('--restricted') ? 'restricted' : 'free';
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise(r => child.once('exit', r)); child.kill(); await exit; editors.delete(child);
}
async function editor(who, port) {
  fs.mkdirSync(testData(who), { recursive: true });
  const child = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, PROMPTCUT_DATA_DIR: testData(who), PROMPTCUT_DOCSERVICE_DATA: path.join(testData(who), 'docservice'), PROMPTCUT_EXPORT_DIR: path.join(testData(who), 'export'),
      PROMPTCUT_PROJECTS_DIR: path.join(testData(who), 'drafts'), PROMPTCUT_DEVICE_ID: `probe-${who}-device-000001`, PROMPTCUT_DEVICE_NAME: `isolated-${who}`,
      PROMPTCUT_AUTO_RENDER_NODE: process.argv.includes('--nodes') ? '1' : '0', PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_PUSH: process.argv.includes('--nodes') ? '' : '0', PROMPTCUT_LAN_HOST: '0', PROMPTCUT_NODE_PROFILE: 'user', PROMPTCUT_SHARED_CONFIG: '', PROMPTCUT_QUEUE_NODE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  editors.add(child); child.stdout.resume(); child.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { if (child.exitCode !== null) throw new Error('isolated editor exited'); try { const r = await fetch(`${base}/api/docservice/device`, { signal: AbortSignal.timeout(1000) }); return r.ok; } catch { return false; } }, 30000, 'isolated editor');
  return { child, base, pid: child.pid };
}
async function hostedProcess(docPort = 0, assetPort = 0) {
  fs.mkdirSync(testData('cloud'), { recursive: true });
  const comboUrl = pathToFileURL(path.resolve('server/hosted/combo.mjs')).href;
  const code = `import { startHostedCombo } from ${JSON.stringify(comboUrl)};
    const c = await startHostedCombo({ dataDir: process.env.PROMPTCUT_DATA_DIR, docPort: Number(process.env.PC_PROBE_DOC_PORT), assetPort: Number(process.env.PC_PROBE_ASSET_PORT), host: '127.0.0.1', trustLoopback: false, clusterToken: process.env.PROMPTCUT_CLUSTER_TOKEN, log: () => {} });
    console.log(JSON.stringify({ docPort: c.docPort, assetPort: c.assetPort }));
    process.stdin.resume(); process.stdin.on('end', () => c.close().then(() => process.exit(0)));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, env: { ...process.env, PROMPTCUT_DATA_DIR: testData('cloud'), PROMPTCUT_CLUSTER_TOKEN: secret(), PC_PROBE_DOC_PORT: String(docPort), PC_PROBE_ASSET_PORT: String(assetPort) }, stdio: ['pipe', 'pipe', 'pipe'] });
  editors.add(child); child.stderr.resume();
  let ports, output = ''; child.stdout.on('data', b => { output += b; if (output.includes('\n') && !ports) { try { ports = JSON.parse(output.split('\n')[0]); } catch {} } });
  await waitFor(() => { if (child.exitCode !== null) throw new Error('isolated hosted process exited'); return ports; }, 15000, 'isolated hosted process');
  return { ...ports, pid: child.pid, hosting: { online: async () => (await (await fetch(`http://127.0.0.1:${ports.docPort}/hosting/healthz`)).json()).online === 1 }, close: () => stop(child) };
}
async function page(base, openPath = null) {
  const context = await browser.createBrowserContext(), p = await context.newPage();
  p.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/shared/create')) createRequests++; });
  p.on('console', m => { if (/\[(collab|sync)\]/.test(m.text())) console.error(m.text().replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')); });
  await p.setViewport({ width: 1440, height: 1000 });
  await p.evaluateOnNewDocument(() => {
    window.recoverySockets = []; const Native = window.WebSocket;
    window.WebSocket = class extends Native { constructor(...args) { super(...args); window.recoverySockets.push(this); } };
  });
  await p.goto(openPath ? `${base}/?nosetup=1&open=${encodeURIComponent(openPath)}` : `${base}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded' });
  await p.evaluate(async () => {
    const [sync, proc, store, collab, pack, drafts] = await Promise.all([import('/src/editor/sync/syncManager.ts'), import('/src/editor/io/proc.ts'), import('/src/store/project.ts'), import('/src/editor/sync/collab.ts'), import('/src/editor/io/procp.ts'), import('/src/editor/io/drafts.ts')]);
    window.probe = { sync, proc, store, collab, pack, drafts };
    await sync.startSync();
  });
  // Empty browser profiles show the first-run AI settings dialog. Close that UI only;
  // never change its provider/account settings or let its mask intercept recovery clicks.
  await p.waitForFunction(() => document.querySelector('.ais-dialog') || window.probe.sync.getSyncView().device, { timeout: 10000 });
  await p.evaluate(() => {
    const close = [...document.querySelectorAll('.ais-dialog button')].find(b => b.textContent?.trim() === '关闭');
    close?.click();
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
  else cloud = await hostedProcess();
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
  await member.evaluate(() => {
    const records = window.recoveryEvidence = [];
    const log = (kind, value) => records.push({ t: performance.now(), kind, ...value });
    const snapshot = () => ({ state: window.probe.sync.getSyncView().reopenState,
      buttons: [...document.querySelectorAll('[data-pc="recovery-auth-open"]')].map(el => {
        const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { connected: el.isConnected, rect: r.toJSON(), hit: hit?.tagName, hitButton: hit?.closest('[data-pc="recovery-auth-open"]') === el };
      }), form: !!document.querySelector('form[aria-label="恢复原协作身份"]') });
    window.recoverySnapshot = snapshot;
    log('before-click', snapshot());
    window.probe.sync.subscribeSync(() => log('sync', { state: window.probe.sync.getSyncView().reopenState }));
    document.addEventListener('click', e => log('click', { tag: e.target?.tagName, recoveryButton: !!e.target?.closest?.('[data-pc="recovery-auth-open"]') }), true);
    const containsForm = n => n.nodeType === 1 && (n.matches?.('form[aria-label="恢复原协作身份"]') || n.querySelector?.('form[aria-label="恢复原协作身份"]'));
    new MutationObserver(ms => { for (const m of ms) { for (const n of m.addedNodes) if (containsForm(n)) log('form-added', {}); for (const n of m.removedNodes) if (containsForm(n)) log('form-removed', {}); } }).observe(document.body, { childList: true, subtree: true });
  });
  await member.locator('[data-pc="recovery-auth-open"]').click();
  await member.evaluate(() => window.recoveryEvidence.push({ t: performance.now(), kind: 'after-click', ...window.recoverySnapshot() }));
  await member.waitForSelector('form[aria-label="恢复原协作身份"]');
  await member.screenshot({ path: path.join(root, 'recovery-auth-empty.png') });
  await member.type('form[aria-label="恢复原协作身份"] input[autocomplete="username"]', 'member');
  await member.type('form[aria-label="恢复原协作身份"] input[type="password"]', password);
  await member.click('form[aria-label="恢复原协作身份"] button[type="submit"]');
  await connected(member, roomId, 'member');
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
  if (!wan) {
    phase = 'stop and restart isolated cloud process';
    const previous = cloud; await previous.close();
    if (where === 'hosted') { cloud = await hostedProcess(previous.docPort, previous.assetPort); assert.notEqual(cloud.pid, previous.pid); }
  }
  await member.close(); await stop(memberRuntime.child);
  const restoredMember = await editor('member', 5206);
  assert.notEqual(restoredMember.pid, memberRuntime.pid);
  member = await page(restoredMember.base); await open(member, memberFile);
  if (where === 'lan') {
    await member.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'waiting-host', { timeout: 15000 });
    await member.screenshot({ path: path.join(root, 'recovery-waiting.png') });
  }
  else await connected(member, roomId, 'member');
  phase = 'restart original host at new port and discard browser storage';
  const restoredRuntime = await editor('host', 5209);
  assert.notEqual(restoredRuntime.pid, hostRuntime.pid);
  host = await page(restoredRuntime.base); await open(host, hostFile);
  await connected(host, roomId, 'host');
  if (!wan && where === 'lan') {
    phase = 'original host opens while cloud is offline and automatically registers after cloud returns';
    await host.evaluate(() => window.probe.store.actions.setProjectMeta({ width: 1280 })); await saved(host);
    const previous = cloud; cloud = await hostedProcess(previous.docPort, previous.assetPort); assert.notEqual(cloud.pid, previous.pid);
    await waitFor(() => cloud.hosting.online(roomId), 30000, 'host automatic registration after network return');
  }
  await connected(member, roomId, 'member');
  if (!wan && where === 'lan') await member.waitForFunction(() => window.probe.store.getState().project.width === 1280);
  await sees(host, 'host-edit-before-restart'); await sees(member, 'host-edit-before-restart');
  phase = 'both directions after automatic reopen';
  await name(member, 'member-edit-after-reopen'); await sees(host, 'member-edit-after-reopen');
  await name(host, 'host-edit-after-reopen'); await sees(member, 'host-edit-after-reopen');
  await member.screenshot({ path: path.join(root, 'recovery-connected.png') });
  phase = 'restored Agent, cards and optional render-node bindings';
  for (const p of [host, member]) await p.waitForFunction(async room => {
    const [agent, cards] = await Promise.all(['/api/agent/status', '/api/cards/sync/status'].map(async url => (await fetch(url)).json()));
    return agent.bound && agent.projectId === room && cards.projectId === room;
  }, { timeout: 15000 }, roomId);
  if (process.argv.includes('--nodes')) for (const p of [host, member]) await p.waitForFunction(async room => {
    const r = await (await fetch('/api/render-node/status')).json();
    const stage = await (await fetch('/api/frames/render-node')).json();
    return r.binding?.projectId === room && stage.bound && stage.projectId === room && stage.started;
  }, { timeout: 30000 }, roomId);
  if (process.argv.includes('--nodes')) await host.waitForFunction(async () => {
    const r = await window.probe.sync.currentSharedLink().request({ type: 'shared.members' });
    return ['host', 'member'].every(user => ['agent', 'render'].every(role => r.devices.some(d => d.username === user && d.conns.some(c => c.role === role))));
  }, { timeout: 15000 });
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
    for (const ns of ['media', 'snap', 'px']) {
      const r = await fetch(`${base}/${ns}/${hash}?t=${encodeURIComponent(read.ticket)}`);
      if (!r.ok) throw new Error('browser ticket read failed');
      const got = await r.arrayBuffer();
      const gotHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', got))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (got.byteLength !== bytes.length || gotHash !== hash) throw new Error('browser ticket content mismatch');
    }
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
  if (process.argv.includes('--password-change')) {
    phase = 'own creator password updates both device record and live reconnect proof';
    const next = secret();
    await host.evaluate(async ({ before, after }) => {
      const sync = window.probe.sync, creator = await sync.makeCredential(after);
      const r = await sync.adminOp('set-creator-password', { password: before }, { creator });
      if (!r.ok) throw new Error('isolated own password change failed'); await sync.whenSaved();
      const base = new URL(sync.getSyncView().shared.base); base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      for (const ws of window.recoverySockets) if (ws.readyState === 1 && ws.url.startsWith(base.href.replace(/\/$/, ''))) ws.close();
    }, { before: creatorPassword, after: next });
    await host.waitForFunction(() => window.probe.sync.getSyncView().status !== 'online'); await connected(host, roomId, 'host');
    creatorPassword = next; await saved(host);
  }
  if (process.argv.includes('--roles')) {
    phase = 'creator second device joins without owning the host';
    const secondRuntime = await editor('creator-second', 5215), second = await page(secondRuntime.base); await open(second, hostFile);
    await second.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'needs-auth');
    const secondResult = await second.evaluate(pw => window.probe.sync.authenticateRecovery('host', pw, 'creator'), creatorPassword); assert.equal(secondResult.ok, true);
    await connected(second, roomId, 'host');
    const role = await second.evaluate(async () => { await window.probe.sync.whenSaved(); const v = window.probe.sync.getSyncView(); const r = await window.probe.sync.recoveryRequest('select', v.association, { contentId: window.probe.store.getState().project.id }); return { creator: v.shared.creator, where: v.shared.where, hostBinding: !!r.host }; });
    assert.deepEqual(role, { creator: true, where, hostBinding: false }); await second.close(); await stop(secondRuntime.child);
  }
  phase = 'packed format and draft reopen';
  const packed = await member.evaluate(async () => { const p = await window.probe.pack.packProcp(); const { procText } = await window.probe.pack.unpackProcp(p.blob); return procText; });
  assert.equal(JSON.parse(packed).collaboration.roomId, roomId);
  await open(member, packed); await connected(member, roomId, 'member');
  await member.evaluate(async () => { await window.probe.drafts.saveDraft('isolated-reopen-draft'); window.probe.proc.newProject('unrelated'); await window.probe.drafts.openDraft('isolated-reopen-draft'); });
  await connected(member, roomId, 'member'); await sees(member, 'host-edit-after-reopen');
  phase = 'desktop system path entry';
  const systemFile = path.join(root, 'isolated-system-open.proc'); fs.writeFileSync(systemFile, memberFile);
  const fromPath = await page(restoredMember.base, systemFile); await connected(fromPath, roomId, 'member');
  await sees(fromPath, 'host-edit-after-reopen'); await fromPath.close();
  phase = 'page refresh through shared coordinator';
  await member.reload({ waitUntil: 'domcontentloaded' });
  await member.evaluate(async () => { const [sync, proc, store, collab, pack, drafts] = await Promise.all([import('/src/editor/sync/syncManager.ts'), import('/src/editor/io/proc.ts'), import('/src/store/project.ts'), import('/src/editor/sync/collab.ts'), import('/src/editor/io/procp.ts'), import('/src/editor/io/drafts.ts')]); window.probe = { sync, proc, store, collab, pack, drafts }; await sync.startSync(); await sync.resumeShared(); });
  await connected(member, roomId, 'member'); await sees(member, 'host-edit-after-reopen');
  if (where === 'hosted') assert.equal(await host.evaluate(() => window.probe.sync.getSyncView().shared.where), 'hosted');
  phase = 'old-file tombstone';
  assert.equal(createRequests, 1, 'every reopen must reuse the original room without a create request');
  const disabled = await host.evaluate(pw => window.probe.collab.disableCollab(pw), creatorPassword); assert.equal(disabled.ok, true);
  await member.waitForFunction(async () => {
    const v = window.probe.sync.getSyncView(); const agent = await (await fetch('/api/agent/status')).json();
    const cards = await (await fetch('/api/cards/sync/status')).json(); const render = await (await fetch('/api/render-node/status')).json();
    return v.reopenState === 'deleted' && !agent.bound && cards.local && !render.binding;
  }, { timeout: 15000 });
  await open(host, hostFile); await host.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'deleted');
  await host.screenshot({ path: path.join(root, 'recovery-deleted.png') });
  evidence.push({ roomId, where, mode, actualHostProcessRestart: true, actualMemberProcessRestart: true, actualCloudProcessRestart: !wan, hostOpenedWhileCloudOffline: !wan && where === 'lan', pidChanged: true, portChanged: true, emptyBrowserStorage: true, memberWaitThenAutoJoin: where === 'lan',
    sameUsers: ['creator:host', 'member:member'], oldSnapshotsPreservedLatest: true, version: journal.rev, bidirectionalEdits: 4, formats: ['proc', 'procp', 'draft', 'system-path', 'refresh'], nativeOsDoubleClick: false, cancellationTombstone: true, recoveryCreateRequests: createRequests - 1, agentAndCardBindings: true, renderNodeStarted: process.argv.includes('--nodes'), nodeRolesAuthenticated: process.argv.includes('--nodes'), staleBindingsRemovedOnDelete: true, creatorPasswordReconnect: process.argv.includes('--password-change'), creatorSecondDevice: process.argv.includes('--roles') });
  const result = { ok: true, evidence, asset, wan: wan ? { service, remoteDirectory: wan.remoteDirectory, path: wan.path, publicHttp: wan.publicHttp, results: wanResults } : null, evidenceDirectory: root };
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (e) {
  if (browser) for (const [index, p] of (await browser.pages()).entries()) {
    try {
      const state = await p.evaluate(async () => {
        for (const input of document.querySelectorAll('input[type="password"]')) input.value = '';
        const v = window.probe?.sync.getSyncView();
        const diagnostics = {};
        for (const [key, url] of Object.entries({ agent: '/api/agent/status', cards: '/api/cards/sync/status', render: '/api/render-node/status', stage: '/api/frames/render-node' })) {
          try { const r = await (await fetch(url)).json(); diagnostics[key] = { bound: r.bound, projectId: r.projectId, enabled: r.enabled, off: r.off, binding: r.binding, started: r.started, starting: r.starting, lastError: r.lastError }; } catch {}
        }
        return { url: location.href, reopen: v?.reopenState, diagnostics, recoveryEvidence: window.recoveryEvidence, buttons: [...document.querySelectorAll('[data-pc="recovery-auth-open"]')].map(el => ({ text: el.textContent, rect: JSON.stringify(el.getBoundingClientRect()), parent: el.parentElement?.tagName })), dialogs: [...document.querySelectorAll('[role="dialog"]')].map(el => ({ label: el.getAttribute('aria-label'), cls: el.className })), project: window.probe?.store.getState().project.id };
      });
      fs.writeFileSync(path.join(root, `failure-page-${index}.json`), JSON.stringify(state, null, 2));
      await p.screenshot({ path: path.join(root, `failure-page-${index}.png`) });
    } catch {}
  }
  console.error(JSON.stringify({ ok: false, phase, error: String(e.message).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]'), evidenceDirectory: root })); process.exitCode = 1;
} finally { await browser?.close(); for (const child of [...editors]) await stop(child); await cloud?.close(); }
