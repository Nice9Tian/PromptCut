/** Pure browser refresh through the actual online editor, using isolated services and accounts. */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';
import { wsClient, waitFor } from '../../server/test/fake-ws-kit.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reopen-online-'));
const mode = process.argv.includes('--restricted') ? 'restricted' : 'free';
const secret = () => randomBytes(32).toString('base64url');
const password = secret(), creatorPassword = secret(), require = createRequire(import.meta.url);
const port = 5223, origin = `http://127.0.0.1:${port}`, base = `${origin}/hosted`;
let cloud, child, browser, host, phase = 'startup', sequence = 0;
async function ask(m) { const reqId = `online-${++sequence}`; host.send({ ...m, reqId }); return host.next(r => r.reqId === reqId); }
try {
  const dataDir = path.join(root, 'cloud'); fs.mkdirSync(dataDir);
  cloud = await startHostedCombo({ dataDir, docPort: 0, assetPort: 0, host: '127.0.0.1', trustLoopback: false, clusterToken: secret(), log: () => {} });
  const direct = `http://127.0.0.1:${cloud.docPort}`;
  const created = await createSharedProject({ base: direct, name: `isolated-online-${Date.now()}`, mode, creator: { username: 'creator', password: creatorPassword }, password, list: [{ username: 'browser-member', password }] });
  host = wsClient(direct.replace('http:', 'ws:'), await buildAuthProtocols({ base: direct, projectId: created.projectId, username: 'creator', as: 'creator', password: creatorPassword, deviceId: 'isolated-online-host-0001', deviceName: 'isolated-online-host' })); await host.opened;
  await ask({ type: 'project.open', projectId: created.projectId });
  const project = { id: 'isolated-online-content', name: 'online-initial', width: 320, height: 180, fps: 10, duration: 1, tracks: [], media: [] };
  await ask({ type: 'project.op', projectId: created.projectId, opId: secret(), ops: [{ op: 'set', path: '', value: project }] });
  const config = path.join(root, 'vite-online.config.mjs');
  fs.writeFileSync(config, `import config from ${JSON.stringify(pathToFileURL(path.resolve('vite.config.ts')).href)};
    export default async () => { const c = await config({ mode: 'online', command: 'serve' }); return { ...c, root: ${JSON.stringify(process.cwd())}, server: { ...c.server, host: '127.0.0.1', port: ${port}, strictPort: true, proxy: { '/hosted': { target: ${JSON.stringify(direct)}, ws: true, rewrite: p => p.replace(/^\\/hosted/, '') } } } }; };`);
  const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  child = spawn(process.execPath, [vite, '--config', config], { windowsHide: true, env: { ...process.env, PROMPTCUT_DATA_DIR: path.join(root, 'desktop-data'), PROMPTCUT_EXPORT_DIR: path.join(root, 'export'), PROMPTCUT_NO_PORT_FILE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.resume(); child.stderr.resume();
  await waitFor(async () => { if (child.exitCode !== null) throw new Error('isolated online editor exited'); try { return (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 30000, 'online editor');
  browser = await puppeteer.launch({ headless: true, userDataDir: path.join(root, 'browser'), args: ['--no-sandbox'] });
  const page = await browser.newPage(); let localApiRequests = 0;
  page.on('request', r => { if (/^\/api\/(?:collaboration|docservice|agent|render-node)/.test(new URL(r.url()).pathname)) localApiRequests++; });
  await page.goto(`${origin}/editor/?editor&nosetup=1`, { waitUntil: 'domcontentloaded' });
  phase = 'first browser authentication';
  const result = await page.evaluate(async ({ base, roomId, password, mode }) => {
    const sync = await import('/editor/src/editor/sync/syncManager.ts');
    window.onlineProbe = sync;
    return sync.enterShared({ where: 'hosted', base, service: base, projectId: roomId, name: 'isolated-online', mode }, { as: 'member', username: 'browser-member', password });
  }, { base, roomId: created.projectId, password, mode }); assert.equal(result.ok, true);
  await page.evaluate(() => window.onlineProbe.whenSaved());
  phase = 'bidirectional edit and latest content before refresh';
  await page.evaluate(async () => { const store = await import('/editor/src/store/project.ts'); store.actions.setProjectMeta({ name: 'browser-before-refresh' }); await window.onlineProbe.whenSaved(); });
  assert.equal((await ask({ type: 'project.open', projectId: created.projectId })).project.name, 'browser-before-refresh');
  await ask({ type: 'project.op', projectId: created.projectId, opId: secret(), ops: [{ op: 'set', path: '/name', value: 'host-latest-before-refresh' }] });
  phase = 'actual UI refresh without calling resumeShared';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => { const [sync, store] = await Promise.all([import('/editor/src/editor/sync/syncManager.ts'), import('/editor/src/store/project.ts')]); window.onlineProbe = sync; window.onlineStore = store; });
  await page.waitForFunction(room => { const v = window.onlineProbe.getSyncView(); return v.reopenState === 'connected' && v.shared?.projectId === room && v.shared.username === 'browser-member' && v.status === 'online' && window.onlineStore.getState().project.name === 'host-latest-before-refresh'; }, { timeout: 30000 }, created.projectId);
  await page.evaluate(async () => { window.onlineStore.actions.setProjectMeta({ name: 'browser-after-refresh' }); await window.onlineProbe.whenSaved(); });
  const latest = await ask({ type: 'project.open', projectId: created.projectId }); assert.equal(latest.project.name, 'browser-after-refresh'); assert.equal(latest.rev, 4);
  assert.equal(localApiRequests, 0);
  await page.screenshot({ path: path.join(root, 'online-recovered.png') });
  const evidence = { ok: true, mode, roomId: created.projectId, role: 'member', username: 'browser-member', actualUiRefresh: true, sameBrowserIdentity: true, version: latest.rev, bidirectionalEdits: true, location: 'hosted', localApiRequests, evidenceDirectory: root };
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} catch (e) { console.error(JSON.stringify({ ok: false, phase, error: String(e.message).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]'), evidenceDirectory: root })); process.exitCode = 1; }
finally { await browser?.close(); host?.close(); if (child?.exitCode === null && child?.signalCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited; } await cloud?.close(); }
