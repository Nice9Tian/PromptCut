// 在线构建 + 本机托管组合复现:剪辑段里的粒子卡,跳进去时的长任务、分派表、贴流诊断。
//   node out/cut-stream-fix/repro-online.mjs --dist out/cut-stream-fix/dist-online [--base-port 29300] [--json f] [--trace f]
// 端口 +0 编辑器页、+1/+2 舞台、+3 文档服务、+4 素材服务。骨架照 scripts/probes/cut-online-e2e-probe.mjs(不起切分方)。
import '../../scripts/lib/no-user-dirs.mjs';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import dnsShim from '../../scripts/probes/lib/localhost-dns.cjs';
import { startHostedProxy, proxyOrigins } from '../../scripts/probes/lib/hosted-proxy.mjs';
import { resumeRecord, plantResume } from '../../scripts/probes/lib/online-resume-entry.mjs';
import { startQueueEditor } from '../../scripts/probes/m8/procs.mjs';
import crypto from 'node:crypto';
setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 1_200_000).unref();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const BASE = Number(arg('--base-port', 29300));
const PORTS = { editor: BASE, doc: BASE + 3, asset: BASE + 4 };
const ORIGINS = proxyOrigins(PORTS.editor);
const SITE = ORIGINS.editor;
const HOSTED = `${SITE}/hosted/`;
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-csf-online-'));
const BODY = JSON.parse(fs.readFileSync(arg('--project', path.join(HERE, 'project41.json')), 'utf8'));
const SEEKS = arg('--seeks', '1.5,5.5,2.5').split(',').map(Number);
const WAIT = Number(arg('--wait', '10000'));
const TRACE = arg('--trace', null);
process.env.NODE_OPTIONS = dnsShim.withLocalhostDns(process.env.NODE_OPTIONS);
const say = (...a) => console.error(new Date().toISOString().slice(11, 23), ...a);

const dist = path.resolve(arg('--dist', path.join(HERE, 'dist-online')));
const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
fs.mkdirSync(path.join(TMP, 'hosted'), { recursive: true });
const combo = await startHostedCombo({ dataDir: path.join(TMP, 'hosted'), docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
  docPublicUrl: `ws://pc.localhost:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {} });
const proxy = await startHostedProxy({ dist, basePort: PORTS.editor, docPort: PORTS.doc, assetPort: PORTS.asset, policy: 'full' });
say('site up', SITE);

const { createSharedProject, buildAuthProtocols } = await import('../../server/auth/client.mjs');
const creator = { username: 'csf-creator', password: `pw-${randomBytes(6).toString('hex')}` };
const projectPassword = `pp-${randomBytes(6).toString('hex')}`;
const name = `csf-${Date.now().toString(36)}`;
const made = await createSharedProject({ base: DOC_DIRECT, name, mode: 'free', creator, password: projectPassword });
const projectId = made.projectId;
{
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId, username: creator.username, deviceId: 'csf-seed-node-0001', deviceName: 'csf-seed', as: 'creator', password: creator.password, role: 'page' });
  const ws = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const ask = (msg) => new Promise((resolve) => {
    const reqId = `seed${Math.random().toString(36).slice(2)}`;
    const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  await ask({ type: 'project.open', projectId });
  const seeded = await ask({ type: 'project.op', projectId, opId: randomBytes(16).toString('base64url'), ops: [{ op: 'set', path: '', value: { ...BODY, id: `seed-${projectId.slice(-8)}`, name } }] });
  say('seeded', seeded.type);
  ws.close();
}

let editor = null;
if (argv.includes('--desk')) {
  const { wsBaseOf } = await import('../../server/auth/route.mjs');
  const editorDir = path.join(TMP, 'editor');
  for (const d of ['card-overrides', 'projects', 'work']) fs.mkdirSync(path.join(editorDir, d), { recursive: true });
  const sharedConfig = path.join(editorDir, 'shared.json');
  const deskDevice = 'csf-desk-node-0001';
  fs.writeFileSync(sharedConfig, JSON.stringify([{ url: wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render', deviceId: deskDevice, deviceName: 'csf desk' }]));
  editor = await startQueueEditor({ port: BASE + 5, dir: editorDir, sharedConfig, fakeFingerprint: crypto.createHash('sha256').update('csf-desk').digest('hex').slice(0, 16), band: [BASE, BASE + 9], extraEnv: {
    PROMPTCUT_CARD_OVERRIDES: path.join(editorDir, 'card-overrides'), PROMPTCUT_PROJECTS_DIR: path.join(editorDir, 'projects'), PROMPTCUT_WORK_DIR: path.join(editorDir, 'work'),
    PROMPTCUT_DEVICE_ID: deskDevice, PROMPTCUT_DEVICE_NAME: 'csf desk', PROMPTCUT_STREAMS: '1', PROMPTCUT_NO_PORT_FILE: '1' } });
  try { await editor.waitActive(); } catch (e) { console.error(editor.lines.slice(-60).join(String.fromCharCode(10))); await editor.stop(); throw e; }
  say('desk up');
}
const costRecords = (page, pin = null, unpin = false) => page.evaluate(async (pinKeys, unpin) => {
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open('promptcut-l2'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try {
    if (!db.objectStoreNames.contains('costs')) return [];
    const all = await new Promise((resolve, reject) => { const r = db.transaction('costs', 'readonly').objectStore('costs').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    if (pinKeys) {
      const tx = db.transaction('costs', 'readwrite');
      for (const row of all) if (pinKeys.includes(row.record?.identityKey)) tx.objectStore('costs').put({ ...row, record: { ...row.record, pinnedHeavy: !unpin } });
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    }
    return all.map((row) => ({ identityKey: row.record?.identityKey, stepMs: row.record?.stepMs, pinned: !!row.record?.pinnedHeavy }));
  } finally { db.close(); }
}, pin, unpin);
const { default: puppeteer } = await import('puppeteer');
const { PROBE_CHROME_ARGS } = await import('../../scripts/probes/probe-chrome.mjs');
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 900_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--site-per-process'] });
const out = { seeks: [] };
try {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 240)));
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.25 });
  await plantResume(page, await resumeRecord({ base: HOSTED, derivationBase: `${DOC_DIRECT}/`, projectId, name, username: 'csf-jia', password: projectPassword, deviceId: 'csf-jia-node-0001' }));
  await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 120_000 });
  await page.waitForFunction(() => { const d = window.__pcPreviewDiag?.(); return d?.dual && d.onlineStages?.handshake === 'ok'; }, { timeout: 120_000, polling: 500 });
  await page.waitForFunction(() => !document.querySelector('[data-pc="probe-gate"]'), { timeout: 300_000, polling: 300 });
  say('entered');
  const enter = async () => {
    await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 120_000 });
    await page.waitForFunction(() => { const d = window.__pcPreviewDiag?.(); return d?.dual && d.onlineStages?.handshake === 'ok'; }, { timeout: 120_000, polling: 500 });
    await page.waitForFunction(() => !document.querySelector('[data-pc="probe-gate"]'), { timeout: 300_000, polling: 300 });
  };
  if (editor) {
    // 照线上:剪辑2 激活时那张粒子卡(原始 id)有一条流;切回剪辑1 后它是剪辑段里的虚拟卡(判轻)
    const RAW = 'c-mvhdf6ef-2', KEY = '1fbf0198c5c366';
    await page.evaluate(() => { window.__pcStore.actions.switchCut('cut-mvfsi65q-1'); });
    await delay(6000);
    say('costs', JSON.stringify(await costRecords(page)));
    await costRecords(page, [KEY]);
    await enter();
    await page.evaluate(() => { window.__pcStore.actions.pause(); window.__pcStore.actions.seek(1.5); });
    const t1 = Date.now();
    for (;;) {
      const r = await page.evaluate((id) => { const d = window.__pcPreviewDiag?.(); return { ready: (d?.snapshotFeed?.ready ?? []).some((x) => x.clipId === id), heavy: d?.snapshotFeed?.heavy ?? [] }; }, RAW);
      if (r.ready) { say('raw stream ready', Date.now() - t1, JSON.stringify(r)); break; }
      if (Date.now() - t1 > 600_000) { say('raw stream NOT ready'); break; }
      await delay(2000);
    }
    await costRecords(page, [KEY], true);
    await enter();
    await page.evaluate(() => { window.__pcStore.actions.switchCut('cut-1'); });
    await delay(4000);
    say('back to cut-1');
  }
  await page.evaluate(() => {
    window.__pcLong = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__pcLong.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) }); }).observe({ entryTypes: ['longtask'] });
  });
  await delay(8000);
  out.diag0 = await page.evaluate(() => { const d = window.__pcPreviewDiag?.(); return { heavy: d?.snapshotFeed?.heavy, long: window.__pcLong.length }; });
  say('idle', JSON.stringify(out.diag0));
  for (const t of SEEKS) {
    await page.evaluate(() => { window.__pcLong = []; });
    if (TRACE && t === SEEKS[0]) await page.tracing.start({ path: TRACE, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'disabled-by-default-v8.cpu_profiler', 'toplevel'] });
    const t0 = await page.evaluate((t) => { const now = performance.now(); window.__pcStore.actions.pause(); window.__pcStore.actions.seek(t); return now; }, t);
    await delay(WAIT);
    if (TRACE && t === SEEKS[0]) await page.tracing.stop();
    const r = await page.evaluate((t0) => {
      const longs = window.__pcLong.filter((l) => l.start >= t0 - 5);
      const d = window.__pcPreviewDiag?.();
      const f = d?.snapshotFeed;
      return { count: longs.length, totalMs: longs.reduce((a, l) => a + l.dur, 0), top: longs.map((l) => l.dur).sort((a, b) => b - a).slice(0, 12),
        heavy: f?.heavy ?? null, streams: (f?.streams ?? []).map((s) => s.clipIds), swap: d?.swapLog?.slice?.(-3) ?? null };
    }, t0);
    out.seeks.push({ t, ...r });
    say('seek', t, JSON.stringify(r));
  }
  out.errors = errors;
} finally {
  await browser.close().catch(() => {});
  await proxy?.close?.().catch?.(() => {});
  await combo?.close?.().catch?.(() => {});
  await editor?.stop?.().catch?.(() => {});
}
const file = arg('--json', null);
if (file) fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ seeks: out.seeks.map((s) => ({ t: s.t, count: s.count, totalMs: s.totalMs, top: s.top, heavy: s.heavy })), errors: out.errors?.length }));
process.exit(0);
