/** Resume a --keep-room checkpoint; default requires an actual OS reboot. Never reboots or changes the OS. */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { waitFor } from '../../server/test/fake-ws-kit.mjs';
import { reopenEditorEnv } from './reopen-editor-env.mjs';

export async function bootIdentity() {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Write((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks)'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0 || !/^\d{15,20}$/.test(r.stdout.trim())) throw new Error('无法核实操作系统启动标识');
    return r.stdout.trim();
  }
  return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

async function resume(root) {
  const resolved = fs.realpathSync(root), temp = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), temp.toLowerCase()); assert.match(path.basename(resolved), /^pc-reopen-e2e-[A-Za-z0-9]+$/);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(resolved, 'checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.version, 1);
  const actualComputerRestart = await bootIdentity() !== checkpoint.boot;
  if (!actualComputerRestart && !process.argv.includes('--allow-same-boot')) { console.log(JSON.stringify({ ok: false, actualComputerRestart, error: '尚未经过真正电脑重启；测试数据已保留', evidenceDirectory: resolved })); process.exitCode = 2; return; }
  const require = createRequire(import.meta.url), vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  let cloud, browser, phase = 'restore isolated cloud', recoveryCreateRequests = 0; const children = [];
  async function runtime(who, port) {
    const data = path.join(resolved, who);
    const child = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true,
      env: reopenEditorEnv(data, { PROMPTCUT_DEVICE_ID: who === 'host' ? '' : 'probe-member-device-000001', PROMPTCUT_DEVICE_NAME: `isolated-${who}`, PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '0', PROMPTCUT_QUEUE_NODE: '0', PROMPTCUT_SHARED_CONFIG: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); child.stdout.resume(); child.stderr.resume();
    const base = `http://127.0.0.1:${port}`;
    await waitFor(async () => { if (child.exitCode !== null) throw new Error('隔离编辑器启动失败'); try { return (await fetch(`${base}/api/docservice/device`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 30000, 'reboot editor');
    return { base, pid: child.pid };
  }
  async function open(runtime, who) {
    const context = await browser.createBrowserContext(), p = await context.newPage();
    p.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/shared/create')) recoveryCreateRequests++; });
    await p.goto(`${runtime.base}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded' });
    await p.evaluate(async text => { const [sync, proc, store] = await Promise.all([import('/src/editor/sync/syncManager.ts'), import('/src/editor/io/proc.ts'), import('/src/store/project.ts')]); window.rebootProbe = { sync, store }; store.actions.loadProject(proc.loadProc(text), 'isolated-reboot.proc'); }, fs.readFileSync(path.join(resolved, `${who}.proc`), 'utf8'));
    assert.equal(await p.evaluate(async () => {
      const response = await (await fetch('/api/ai/config')).json(), c = response.config ?? response;
      return !c.api?.apiKey?.set && !c.keys?.custom?.set && !c.keys?.router?.set;
    }), true, 'reboot editor must not load user provider credentials');
    return p;
  }
  try {
    cloud = await startHostedCombo({ dataDir: path.join(resolved, 'cloud'), docPort: checkpoint.docPort, assetPort: checkpoint.assetPort, host: '127.0.0.1', trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'), log: () => {} });
    browser = await puppeteer.launch({ headless: true, userDataDir: fs.mkdtempSync(path.join(resolved, 'reboot-browser-')), args: ['--no-sandbox'] });
    phase = 'member waits with stored device identity'; const memberRuntime = await runtime('member', 5206), member = await open(memberRuntime, 'member');
    if (checkpoint.where === 'lan') await member.waitForFunction(() => window.rebootProbe.sync.getSyncView().reopenState === 'waiting-host', { timeout: 15000 });
    phase = 'original host rejoins original room after boot'; const hostRuntime = await runtime('host', 5203), host = await open(hostRuntime, 'host');
    assert.notEqual(hostRuntime.pid, checkpoint.hostPid); assert.notEqual(memberRuntime.pid, checkpoint.memberPid);
    for (const [p, user] of [[host, 'host'], [member, 'member']]) await p.waitForFunction((room, user) => { const v = window.rebootProbe.sync.getSyncView(); return v.shared?.projectId === room && v.shared.username === user && v.status === 'online'; }, { timeout: 30000 }, checkpoint.roomId, user);
    const before = JSON.parse(fs.readFileSync(path.join(resolved, 'evidence.json'), 'utf8'));
    await host.evaluate(() => window.rebootProbe.sync.whenSaved());
    const beforeRev = await host.evaluate(() => window.rebootProbe.sync.currentSharedLink().ds.rev);
    assert.ok(beforeRev >= before.version, 'old snapshots must not reset the service version');
    const roles = await host.evaluate(async () => {
      const response = await window.rebootProbe.sync.currentSharedLink().request({ type: 'shared.members' });
      return response.devices.filter(d => ['host', 'member'].includes(d.username)).map(d => ({ username: d.username, creator: d.creator, roles: d.conns.map(c => c.role) }));
    });
    for (const user of ['host', 'member']) assert.ok(roles.some(d => d.username === user && d.creator === (user === 'host') && d.roles.includes('page')), 'service must authenticate the original role');
    let hostRegistration = null;
    if (checkpoint.where === 'lan') {
      phase = 'verify restored cloud registration and tunnel';
      await waitFor(() => cloud.hosting.online(checkpoint.roomId), 15000, 'post-boot cloud registration');
      hostRegistration = 'online';
    }
    const edit = async (p, value) => p.evaluate(async n => { window.rebootProbe.store.actions.setProjectMeta({ name: n }); await window.rebootProbe.sync.whenSaved(); }, value);
    phase = 'bidirectional post-boot editing'; await edit(member, 'member-after-physical-reboot'); await host.waitForFunction(() => window.rebootProbe.store.getState().project.name === 'member-after-physical-reboot');
    await edit(host, 'host-after-physical-reboot'); await member.waitForFunction(() => window.rebootProbe.store.getState().project.name === 'host-after-physical-reboot');
    const asset = await member.evaluate(async ({ asset, hostedBase }) => { const link = window.rebootProbe.sync.currentSharedLink(); const r = await link.request({ type: 'auth.ticket', kind: 'asset', access: 'r' });
      if (r.type !== 'auth.ticket.ok') throw new Error('post-boot asset ticket failed');
      const base = hostedBase ?? window.rebootProbe.sync.getSyncView().shared.base.replace(/\/doc$/, '/asset/api/asset');
      const reads = [];
      for (const ns of ['media', 'snap', 'px']) {
        const got = await fetch(`${base}/${ns}/${asset.hash}?t=${encodeURIComponent(r.ticket)}`); const bytes = await got.arrayBuffer();
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
        reads.push({ namespace: ns, ok: got.ok && hash === asset.hash && bytes.byteLength === asset.size, bytes: bytes.byteLength });
      }
      return { ok: reads.every(r => r.ok), reads }; }, { asset: before.asset, hostedBase: checkpoint.where === 'hosted' ? `http://127.0.0.1:${cloud.assetPort}/api/asset` : null }); assert.equal(asset.ok, true);
    const afterRev = await host.evaluate(() => window.rebootProbe.sync.currentSharedLink().ds.rev);
    assert.ok(afterRev >= beforeRev + 2, 'post-boot edits must advance the service version');
    assert.equal(recoveryCreateRequests, 0, 'post-boot recovery must not create a room');
    const evidence = { ok: true, actualComputerRestart, actualHostProcessRestart: true, actualMemberProcessRestart: true, roomId: checkpoint.roomId, sameUsers: ['creator:host', 'member:member'], authenticatedRoles: roles, beforeRev, afterRev, hostRegistration, recoveryCreateRequests, bidirectionalEdits: true, ticketAsset: asset, emptyBrowserStorage: true, testIsolation: { providerConfiguration: true }, evidenceDirectory: resolved };
    fs.writeFileSync(path.join(resolved, actualComputerRestart ? 'physical-reboot-evidence.json' : 'reboot-harness-dry-run.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
  } catch (e) { console.error(JSON.stringify({ ok: false, phase, actualComputerRestart, error: String(e.message).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]'), evidenceDirectory: resolved })); process.exitCode = 1; }
  finally { await browser?.close(); for (const c of children) if (c.exitCode === null && c.signalCode === null) { const exited = new Promise(r => c.once('exit', r)); c.kill(); await exited; } await cloud?.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = process.argv[2]; if (!root || root.startsWith('--')) throw new Error('请提供 --keep-room 生成的隔离测试目录'); await resume(root);
}
