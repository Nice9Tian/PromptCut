/** Native argument/IPC and runtime-copy recovery acceptance. Own fixture only, no installation.
 * First build: node scripts/probes/reopen-native-fixture.mjs --build
 * Then run: node scripts/probes/reopen-native.mjs <fixture.json>
 * A native argument/IPC pass is not evidence of an OS default-file-association double click.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { waitFor } from '../../server/test/fake-ws-kit.mjs';
import { loadNativeFixture, nativeTestEnv } from './reopen-native-fixture.mjs';

const fixture = loadNativeFixture(process.argv[2]);
const { port } = fixture;
const root = fs.mkdtempSync(path.join(fixture.root, 'run-'));
assert.equal(port, 5203);
const require = createRequire(import.meta.url);
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const secret = () => randomBytes(32).toString('base64url');
const password = secret(), creatorPassword = secret();
const children = new Set(), nativeConnections = new Set();
let browser, cloud, phase = 'start', createRequests = 0;
async function freePort(p) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(p, '127.0.0.1', resolve); });
  const actual = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return actual;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; children.delete(child);
}
async function hosted(docPort = 0, assetPort = 0) {
  fs.mkdirSync(path.join(root, 'cloud'), { recursive: true });
  const url = pathToFileURL(path.resolve('server/hosted/combo.mjs')).href;
  const code = `import { startHostedCombo } from ${JSON.stringify(url)};
    const c = await startHostedCombo({ dataDir: process.env.PROMPTCUT_DATA_DIR, docPort: Number(process.env.PC_PROBE_DOC_PORT), assetPort: Number(process.env.PC_PROBE_ASSET_PORT), host: '127.0.0.1', trustLoopback: false, clusterToken: process.env.PROMPTCUT_CLUSTER_TOKEN, log: () => {} });
    console.log(JSON.stringify({ docPort:c.docPort, assetPort:c.assetPort }));
    process.stdin.resume(); process.stdin.on('end', () => c.close().then(() => process.exit(0)));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true,
    env: nativeTestEnv({ PROMPTCUT_DATA_DIR: path.join(root, 'cloud'), PROMPTCUT_CLUSTER_TOKEN: secret(), PC_PROBE_DOC_PORT: String(docPort), PC_PROBE_ASSET_PORT: String(assetPort) }), stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child); child.stderr.resume();
  let ports, output = ''; child.stdout.on('data', b => { output += b; if (output.includes('\n') && !ports) ports = JSON.parse(output.split('\n')[0]); });
  await waitFor(() => { assert.equal(child.exitCode, null, 'own cloud exited'); return ports; }, 15000);
  return { ...ports, child, pid: child.pid, online: async () => (await (await fetch(`http://127.0.0.1:${ports.docPort}/hosting/healthz`)).json()).online === 1 };
}
async function memberProcess() {
  for (const p of [5206, 5207, 5208]) await freePort(p);
  const data = path.join(root, 'member'); fs.mkdirSync(data, { recursive: true });
  const child = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', '5206', '--strictPort'], { cwd: process.cwd(), windowsHide: true,
    env: nativeTestEnv({ PROMPTCUT_DATA_DIR: data, PROMPTCUT_DOCSERVICE_DATA: path.join(data, 'docservice'), PROMPTCUT_EXPORT_DIR: path.join(data, 'export'), PROMPTCUT_PROJECTS_DIR: path.join(data, 'drafts'),
      PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_QUEUE_NODE: '0', PROMPTCUT_LAN_HOST: '0', PROMPTCUT_NO_PORT_FILE: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); child.stdout.resume(); child.stderr.resume();
  await waitFor(async () => { assert.equal(child.exitCode, null, 'own member exited'); try { return (await fetch('http://127.0.0.1:5206/api/docservice/device')).ok; } catch { return false; } }, 30000);
  return child;
}
async function observe(p) {
  p.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/shared/create')) createRequests++; });
  await p.waitForFunction(() => !!document.querySelector('.pc-app-shell'), { timeout: 30000 });
  await p.evaluate(async () => {
    const [sync, proc, store, collab] = await Promise.all([import('/src/editor/sync/syncManager.ts'), import('/src/editor/io/proc.ts'), import('/src/store/project.ts'), import('/src/editor/sync/collab.ts')]);
    window.probe = { sync, proc, store, collab }; await sync.startSync();
    [...document.querySelectorAll('.ais-dialog button')].find(b => b.textContent?.trim() === '关闭')?.click();
  });
  return p;
}
async function native(copy, file = null) {
  phase = `native ${copy} test port preflight`;
  for (const p of [port, port + 1, port + 2]) await freePort(p);
  const cdpPort = await freePort(0), profile = path.join(root, `browser-${copy}`);
  assert.equal(fs.existsSync(profile), false, 'native restart must use an empty browser profile');
  const entry = fixture.copies[copy === 'A' ? 0 : 1];
  const child = spawn(entry.exe, file ? [file] : [], { cwd: path.dirname(entry.exe), windowsHide: true,
    env: nativeTestEnv({ PC_REOPEN_NATIVE_ROOT: root, PC_REOPEN_NATIVE_BROWSER_DIR: profile, PROMPTCUT_RUNTIME_DIR: entry.runtime, PROMPTCUT_AGENT_CDP: String(cdpPort),
      PROMPTCUT_PROJECTS_DIR: path.join(root, 'data/drafts'), PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_QUEUE_NODE: '0', PROMPTCUT_LAN_HOST: '0' }), stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); child.stdout.resume(); child.stderr.resume();
  phase = `native ${copy} start and debugging endpoint`;
  let connection;
  await waitFor(async () => { assert.equal(child.exitCode, null, 'isolated native shell exited'); try { connection = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: null }); return true; } catch { return false; } }, 60000);
  nativeConnections.add(connection);
  phase = `native ${copy} editor navigation`;
  let p;
  await waitFor(async () => { p = (await connection.pages()).find(p => p.url().startsWith(`http://127.0.0.1:${port}/`)); return p; }, 60000);
  if (file) assert.equal(new URL(p.url()).searchParams.get('open'), file, 'native Rust argument must reach the original boot URL');
  phase = `native ${copy} real shell permissions`;
  await observe(p);
  assert.equal(await p.evaluate(() => !!window.__TAURI__?.core?.invoke), true, 'actual Tauri shell required');
  const info = await p.evaluate(() => window.__TAURI__.core.invoke('agent_webview_info'));
  assert.equal(info.port, cdpPort, 'only our shell debugging endpoint may be connected');
  return { child, p, connection, pid: child.pid, profile, entry };
}
async function quit(n) {
  const ended = new Promise(resolve => n.child.once('exit', resolve));
  await n.p.evaluate(() => window.__TAURI__.core.invoke('desktop_titlebar_command', { command: 'quit' })).catch(() => {});
  await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('own native exit timed out')), 15000))]);
  assert.equal(n.child.exitCode, 0, 'native normal exit required'); children.delete(n.child);
  n.connection.disconnect(); nativeConnections.delete(n.connection);
  await waitFor(async () => { try { for (const p of [port, port + 1, port + 2]) await freePort(p); return true; } catch { return false; } }, 15000);
}
const connected = (p, room, user) => p.waitForFunction((r, u) => { const v = window.probe.sync.getSyncView(); return v.shared?.projectId === r && v.shared.username === u && v.status === 'online'; }, { timeout: 30000 }, room, user);
const saved = p => p.evaluate(async () => { await window.probe.sync.whenSaved(); return window.probe.proc.serializeProc(); });
const name = (p, value) => p.evaluate(n => window.probe.store.actions.setProjectMeta({ name: n }), value);
const sees = (p, value) => p.waitForFunction(n => window.probe.store.getState().project.name === n, { timeout: 20000 }, value);
const open = (p, text) => p.evaluate(t => window.probe.store.actions.loadProject(window.probe.proc.loadProc(t), 'isolated-native.proc'), text);
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function memberPage() {
  const context = await browser.createBrowserContext(), p = await context.newPage();
  await p.goto('http://127.0.0.1:5206/?editor&nosetup=1', { waitUntil: 'domcontentloaded' }); return observe(p);
}
try {
  phase = 'start isolated cloud'; cloud = await hosted();
  phase = 'start own member browser';
  browser = await puppeteer.launch({ headless: true, userDataDir: path.join(root, 'member-browser'), args: ['--no-sandbox'] });
  const first = await native('A'); let host = first.p;
  await host.click('.sp-hero');
  const created = await host.evaluate(o => window.probe.collab.enableCollab(o), { where: 'lan', mode: 'restricted', name: 'isolated-native-reopen', creator: { username: 'host', password: creatorPassword }, projectPassword: password, list: [{ username: 'member', password }], hostedUrl: `http://127.0.0.1:${cloud.docPort}` });
  assert.equal(created.ok, true, 'isolated native room creation');
  const hostFile = await saved(host), descriptor = JSON.parse(hostFile).collaboration, room = descriptor.roomId;
  const filePath = path.join(root, 'original-host.proc'); fs.writeFileSync(filePath, hostFile);
  const fileHash = sha(filePath), deviceFile = path.join(root, 'data/device.json'), deviceHash = sha(deviceFile);
  await waitFor(() => cloud.online(), 10000);
  const memberBefore = await memberProcess(); let member = await memberPage(); await open(member, hostFile);
  await member.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'needs-auth');
  await member.click('[data-pc="recovery-auth-open"]'); await member.waitForSelector('form[aria-label="恢复原协作身份"]');
  await member.type('form[aria-label="恢复原协作身份"] input[autocomplete="username"]', 'member');
  await member.type('form[aria-label="恢复原协作身份"] input[type="password"]', password);
  await member.click('form[aria-label="恢复原协作身份"] button[type="submit"]');
  await connected(member, room, 'member'); const memberFile = await saved(member);
  await name(member, 'native-member-before'); await sees(host, 'native-member-before');
  await name(host, 'native-host-before'); await sees(member, 'native-host-before'); await saved(host); await saved(member);
  phase = 'normal native exit, stop member and cloud'; await quit(first);
  await waitFor(async () => !(await cloud.online()), 10000);
  await member.close(); await stop(memberBefore); const cloudBefore = cloud; await stop(cloud.child);
  cloud = await hosted(cloudBefore.docPort, cloudBefore.assetPort); assert.notEqual(cloud.pid, cloudBefore.pid);
  const memberAfter = await memberProcess(); assert.notEqual(memberAfter.pid, memberBefore.pid);
  member = await memberPage(); await open(member, memberFile);
  await member.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'waiting-host', { timeout: 15000 });
  phase = 'other runtime copy with native original file argument and empty WebView profile';
  createRequests = 0;
  const second = await native('B', filePath); host = second.p; assert.notEqual(first.pid, second.pid);
  await connected(host, room, 'host'); await waitFor(() => cloud.online(), 15000); await connected(member, room, 'member');
  assert.equal(sha(deviceFile), deviceHash, 'stable native device identity across runtime directories');
  await sees(host, 'native-host-before'); await sees(member, 'native-host-before');
  await name(member, 'native-member-after'); await sees(host, 'native-member-after');
  await name(host, 'native-host-after'); await sees(member, 'native-host-after'); await saved(host); await saved(member);
  const binding = await host.evaluate(async () => { const v = window.probe.sync.getSyncView(), r = await window.probe.sync.recoveryRequest('select', v.association, { contentId: window.probe.store.getState().project.id }); return { creator: v.shared.creator, where: v.shared.where, hostBinding: !!r.host, rev: r.journal.rev }; });
  assert.equal(binding.creator && binding.hostBinding && binding.where === 'lan', true); assert(binding.rev >= 5);
  phase = 'native second launch IPC reopens original file in existing instance';
  await host.evaluate(async target => { window.nativeOpenEvents = 0; await window.__TAURI__.event.listen('pc-open-file', ev => { if (ev.payload === target) window.nativeOpenEvents++; }); }, filePath);
  const ipc = spawn(second.entry.exe, [filePath], { cwd: path.dirname(second.entry.exe), windowsHide: true, env: nativeTestEnv({ PC_REOPEN_NATIVE_ROOT: root, PC_REOPEN_NATIVE_BROWSER_DIR: second.profile, PROMPTCUT_RUNTIME_DIR: second.entry.runtime }), stdio: 'ignore' });
  children.add(ipc); assert.equal(await new Promise(resolve => ipc.once('exit', resolve)), 0); children.delete(ipc);
  await host.waitForFunction(() => window.nativeOpenEvents === 1); await connected(host, room, 'host'); await sees(host, 'native-host-after');
  phase = 'member ticket reads bytes through recovered cloud relay';
  const asset = await member.evaluate(async () => {
    const v = window.probe.sync.getSyncView(), link = window.probe.sync.currentSharedLink();
    const issued = await link.request({ type: 'auth.ticket', kind: 'asset', access: 'rw' }); if (issued.type !== 'auth.ticket.ok') throw new Error('asset ticket failed');
    const base = v.shared.base.replace(/\/doc$/, '/asset/api/asset'), bytes = crypto.getRandomValues(new Uint8Array(50000));
    const hashOf = async b => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x => x.toString(16).padStart(2, '0')).join('');
    const hash = await hashOf(bytes);
    for (const ns of ['media', 'snap', 'px']) {
      const upload = await fetch(`${base}/${ns}/${hash}/0`, { method: 'PUT', headers: { Authorization: `Bearer ${issued.ticket}`, 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(bytes.length), 'X-Media-Ext': 'bin' }, body: bytes });
      if (!upload.ok || !(await fetch(`${base}/${ns}/${hash}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${issued.ticket}` } })).ok) throw new Error('asset upload failed');
    }
    const read = await link.request({ type: 'auth.ticket', kind: 'asset', access: 'r' });
    for (const ns of ['media', 'snap', 'px']) { const r = await fetch(`${base}/${ns}/${hash}?t=${encodeURIComponent(read.ticket)}`); if (!r.ok) throw new Error('asset read failed'); const got = await r.arrayBuffer(); if (got.byteLength !== bytes.length || await hashOf(got) !== hash) throw new Error('asset mismatch'); }
    return { bytes: bytes.length, hash, namespaces: ['media', 'snap', 'px'] };
  });
  assert.equal(createRequests, 0, 'native restoration must not create a room'); assert.equal(sha(filePath), fileHash, 'native path opening must not alter the original file');
  await host.screenshot({ path: path.join(root, 'native-restored.png') }); await quit(second);
  const evidence = { sourceCommit: fixture.sourceCommit, nativeArgument: true, nativeSingleInstanceIpc: true, nativeNormalExit: true,
    runtimeCopyChanged: true, emptyBrowserProfiles: true, stableDevice: true, stableRoom: room, memberWaitThenAutomaticJoin: true,
    hostPidBefore: first.pid, hostPidAfter: second.pid, memberPidBefore: memberBefore.pid, memberPidAfter: memberAfter.pid,
    bidirectionalEdits: 4, binding, asset, originalFileUnchanged: true, recoveryCreateRequests: createRequests,
    nativeOsDoubleClick: false, installerUpgrade: false, actualComputerRestart: false, fileAssociationsChanged: false, evidenceDirectory: root };
  fs.writeFileSync(path.join(root, 'native-evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} catch (e) {
  const primitive = x => x === null || ['boolean', 'number'].includes(typeof x) ? x : undefined;
  console.error(JSON.stringify({ ok: false, phase, errorClass: e?.name || 'Error', errorCode: /^[A-Z_0-9]+$/.test(e?.code || '') ? e.code : undefined,
    actual: primitive(e?.actual), expected: primitive(e?.expected), evidenceDirectory: root })); process.exitCode = 1;
} finally {
  for (const connection of nativeConnections) connection.disconnect();
  if (browser) await browser.close();
  for (const child of [...children]) await stop(child);
}
