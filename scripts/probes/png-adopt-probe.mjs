/**
 * X7 的可视验收(`docs/plan/m6c-contract.md` X7):远端节点产的卡,本机 `?preview=legacy` 下显示真实 PNG,不是占位。
 *
 * 在一台机器上用两套编辑器 + 预渲染进程模拟「远端产、本机取」(思路同 `queue-mode-probe.mjs`):
 *
 *   0. 起一个独立的文档服务 D(临时数据目录);
 *   1. **A(远端)**:编辑器 + 预渲染进程,连 D、开推送(`PROMPTCUT_PUSH=1`)。页面以 `?preview=legacy` 打开、载入探针项目,
 *      探针按页面的镜像键调 A 的 preload,等后台那一趟 `ready`、推送队列清空 —— A 产的快照与 PNG 缓存帧(X7 的 `pngs`)
 *      都推到了 A 的素材服务,清单写进了 D 的内容库;
 *   2. **B(本机)**:另一套编辑器 + 预渲染进程,连同一个 D,素材服务指向 A 的(`PROMPTCUT_ASSET_URL`)。页面同样以
 *      `?preview=legacy` 打开、载入同一份项目,停在 1 秒:
 *        - **取之前**:调 B 的 `/api/frames/see`(legacy 整帧通道就是它),这一帧 `incomplete`、`missing` 里有这张卡 —— 占位;
 *          截图 `legacy-before.png`;
 *        - 调 B 的 preload:B 先按清单换机取用(C6.4 `adoptFromManifests` → C6.2 `applyResult`,X7 在这里把 PNG 一并取回),
 *          等诊断里的 `adoption` 报出来;
 *        - **取之后**:再调 `see`,这一帧不再 `incomplete`;B 盘上这张卡的 PNG 缓存与 A 逐字节相同;截图 `legacy-after.png`。
 *
 *   node scripts/probes/png-adopt-probe.mjs [--port-a 5420] [--port-b 5423] [--docservice-port 5429] [--card r6-stateful]
 *        [--out <截图目录>] [--timeout-min 15] [--keep]
 *
 * 端口:每台编辑器另占「端口 +1」「端口 +2」当舞台端口,三个连号都要空着;文档服务一个端口。
 * 截图缺省放在本检出的 `out/png-adopt-probe/`。输出最后一行是一行 JSON:`{ ok, before, after, pngFrames, identicalPng, shots, fails }`。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT_A = Number(arg('--port-a', 5420));
const PORT_B = Number(arg('--port-b', 5423));
const DOC_PORT = Number(arg('--docservice-port', 5429));
const CARD = arg('--card', 'r6-stateful');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'png-adopt-probe')));
const TIMEOUT_MS = Number(arg('--timeout-min', 15)) * 60_000;
const KEEP = args.includes('--keep');
const STAMP = Date.now().toString(36);
const T_SEC = 1;

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return cond; };
const sha = buf => createHash('sha256').update(buf).digest('hex');
const json = async (url, init) => {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body };
};
const postJson = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function until(label, fn, timeoutMs = 120000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
}
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGKILL');
}
const exited = child => new Promise(resolve => { if (!child || child.exitCode !== null) return resolve(); child.once('exit', () => resolve()); setTimeout(resolve, 15000).unref?.(); });
const portFree = async port => {
  const net = await import('node:net');
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
};

/**
 * 探针项目:一张共享档的推帧卡(needPrerendering,legacy 通道缺 PNG 时画占位),2 秒 = 60 帧 = 一段。
 * 缺省用 `r6-stateful`:它每一帧都有实体(没有全透明帧),A 的 PNG 缓存一趟就齐,B 取回后 `hasComplete` 为真、
 * 本机不再为它渲任何一帧 —— B 盘上的 PNG 只可能是取回的。
 */
const PROJECT = {
  version: 1, id: `png-adopt-probe-${STAMP}`, name: 'PNG 取回探针', width: 1920, height: 1080, fps: 30, duration: 2,
  themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [{ id: 'tr-1', name: 'tr-1', hidden: false, clips: [{ id: 'clip-remote', kind: 'card', cardId: CARD, start: 0, end: 2, params: {} }] }],
};

const children = [];
const tmpDirs = [];
const out = { card: CARD, ports: { a: PORT_A, b: PORT_B, docservice: DOC_PORT }, out: OUT };

async function startEditor(label, port, extraEnv) {
  const exportDir = path.join(os.tmpdir(), `pc-png-adopt-${label}-${STAMP}`);
  tmpDirs.push(exportDir);
  await fs.mkdir(path.join(exportDir, 'data'), { recursive: true });
  const env = { ...process.env, PROMPTCUT_EXPORT_DIR: exportDir, PROMPTCUT_DATA_DIR: path.join(exportDir, 'data'), PROMPTCUT_STREAMS: '0', ...extraEnv };
  for (const name of ['PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_SHARED_CONFIG']) delete env[name];
  if (!extraEnv.PROMPTCUT_ASSET_URL) delete env.PROMPTCUT_ASSET_URL;
  const editor = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  children.push(editor);
  const log = [];
  const keep = c => { log.push(c.toString()); if (log.length > 400) log.shift(); };
  editor.stdout.on('data', keep); editor.stderr.on('data', keep);
  const origin = `http://127.0.0.1:${port}`;
  await until(`[${label}] 编辑器进程起来`, async () => (await fetch(origin + '/api/prerender/info').then(r => r.ok, () => false)) || null, 120000);
  const base = await until(`[${label}] 预渲染进程就绪`, async () => {
    const info = await json(origin + '/api/prerender/info');
    return info.body?.ready && info.body.url ? info.body.url : null;
  }, 180000);
  return { label, origin, base, exportDir, library: path.join(exportDir, 'frame-library'), log };
}

/** 编辑器页面 `?preview=legacy`,载入探针项目,停在 T_SEC;回页面与镜像键 */
async function openLegacy(browser, editor) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto(editor.origin + '/?editor&nosetup=1&preview=legacy', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => { try { await import('/src/store/project.ts'); return true; } catch { return false; } }, { timeout: 180000, polling: 500 });
  await page.evaluate(async (project, t) => {
    const { actions } = await import('/src/store/project.ts');
    actions.loadProject(project);
    actions.seek(t);
  }, PROJECT, T_SEC);
  const key = await until(`[${editor.label}] 页面的镜像键`, async () => page.evaluate(async () => {
    const k = (await import('/src/render/dataMirror.ts')).mirrorKey();
    return k && k.localRev >= 1 ? { session: k.session, localRev: k.localRev } : null;
  }), 60000, 500);
  return { page, key };
}

const preloadUntilReady = (editor, key, label) => until(label, async () => {
  const status = await postJson(`${editor.base}/api/frames/preload`, { ...key });
  return status.body?.status === 'ready' ? status.body : status.body?.status === 'error' ? status.body : null;
}, TIMEOUT_MS, 2000);
const diagnostics = async editor => (await json(`${editor.base}/api/frames/diagnostics`)).body ?? {};
const seeAt = async (editor, key) => (await postJson(`${editor.base}/api/frames/see`, { ...key, times: [T_SEC], lane: 'user' })).body;

/** 这张卡的 PNG 缓存键(card plan 里的 `key`)由诊断给不出,按目录找:`controls/<key>/mov/frames/*.png` */
async function pngFiles(library) {
  const outFiles = new Map();
  const base = path.join(library, 'controls');
  for (const key of await fs.readdir(base).catch(() => [])) {
    const dir = path.join(base, key, 'mov', 'frames');
    for (const name of await fs.readdir(dir).catch(() => [])) if (name.endsWith('.png')) outFiles.set(`${key}/${name}`, await fs.readFile(path.join(dir, name)));
  }
  return outFiles;
}

let browser = null;
try {
  await fs.mkdir(OUT, { recursive: true });
  for (const p of [PORT_A, PORT_A + 1, PORT_A + 2, PORT_B, PORT_B + 1, PORT_B + 2, DOC_PORT]) check(await portFree(p), `端口 ${p} 空着`);
  if (fails.length) throw new Error('端口被占');

  // 0. 文档服务 D(只绑回环,临时数据目录;编辑器与预渲染进程连它是本机身份)
  const docData = path.join(os.tmpdir(), `pc-png-adopt-doc-${STAMP}`);
  tmpDirs.push(docData);
  const docEnv = { ...process.env, PROMPTCUT_DOCSERVICE_PORT: String(DOC_PORT), PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_DATA: docData };
  delete docEnv.PROMPTCUT_CLUSTER_TOKEN;
  const doc = spawn(process.execPath, [path.join(ROOT, 'server', 'docservice', 'main.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: docEnv });
  doc.stdout.resume(); doc.stderr.resume();
  children.push(doc);
  await until('文档服务起来', async () => (await json(`http://127.0.0.1:${DOC_PORT}/healthz`)).body?.ok === true || null, 30000);
  const DOC_URL = `ws://127.0.0.1:${DOC_PORT}`;

  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });

  // 1. A:远端,产并推送
  const A = await startEditor('a', PORT_A, { PROMPTCUT_DOCSERVICE_URL: DOC_URL, PROMPTCUT_PUSH: '1' });
  if (!A.base) throw new Error('A 起不来');
  const assetA = `${A.origin}/api/asset`;
  const pageA = await openLegacy(browser, A);
  if (!pageA.key) throw new Error('A 的页面没有镜像键');
  const readyA = await preloadUntilReady(A, pageA.key, '[a] 后台那一趟跑完');
  check(readyA?.status === 'ready', '[a] 后台那一趟以 ready 结束', readyA);
  const pushedA = await until('[a] 推送队列清空', async () => {
    const push = (await diagnostics(A)).push;
    return push && push.pending === 0 && push.inflight === 0 && push.pushed > 0 && push.manifests > 0 ? push : null;
  }, 180000, 1000);
  out.a = { preload: readyA?.status ?? null, push: pushedA ? { pushed: pushedA.pushed, uploaded: pushedA.uploaded, manifests: pushedA.manifests, failures: pushedA.failures } : null };
  await pageA.page.close();
  const pngA = await pngFiles(A.library);
  out.a.pngFrames = pngA.size;
  check(pngA.size > 0, '[a] A 产出了 PNG 缓存帧', pngA.size);

  // 2. B:本机,取
  const B = await startEditor('b', PORT_B, { PROMPTCUT_DOCSERVICE_URL: DOC_URL, PROMPTCUT_PUSH: '1', PROMPTCUT_ASSET_URL: assetA });
  if (!B.base) throw new Error('B 起不来');
  const pageB = await openLegacy(browser, B);
  if (!pageB.key) throw new Error('B 的页面没有镜像键');
  const before = await seeAt(B, pageB.key);
  const beforeFrame = before?.frames?.[0] ?? null;
  out.before = beforeFrame ? { source: beforeFrame.source, incomplete: beforeFrame.incomplete, missing: beforeFrame.missing } : before;
  check(beforeFrame?.incomplete === true && beforeFrame.missing.includes('clip-remote'), '取之前:legacy 这一帧是占位(incomplete,缺这张卡)', out.before);
  await delay(2500);
  out.shots = { before: path.join(OUT, 'legacy-before.png') };
  await pageB.page.screenshot({ path: out.shots.before });

  // preload 开跑后第一件事是按清单换机取用(C6.4);它一报出来就马上看 legacy 这一帧,赶在后台那一趟往下走之前
  const kick = await postJson(`${B.base}/api/frames/preload`, { ...pageB.key });
  check(kick.ok, '[b] preload 开跑', kick.body);
  const adoption = await until('[b] 换机取用报出来', async () => (await diagnostics(B)).adoption ?? null, 180000, 200);
  const after = await seeAt(B, pageB.key);
  out.b = { adoption };
  check((adoption?.manifests ?? 0) >= 1, '[b] 按清单换机取用了至少一段', adoption);
  // 一段 60 帧快照 + 同一段的 PNG 缓存帧都是从 A 的素材服务下的
  check((adoption?.fetched ?? 0) >= 60 + pngA.size, '[b] 下载的块数 = 快照 + PNG', { fetched: adoption?.fetched, png: pngA.size });
  const afterFrame = after?.frames?.[0] ?? null;
  out.after = afterFrame ? { source: afterFrame.source, incomplete: afterFrame.incomplete, missing: afterFrame.missing } : after;
  check(afterFrame && afterFrame.incomplete === false && afterFrame.missing.length === 0, '取之后:legacy 这一帧不再占位', out.after);
  if (afterFrame?.url) {
    const img = Buffer.from(await (await fetch(B.base + afterFrame.url)).arrayBuffer());
    out.shots.frame = path.join(OUT, 'legacy-after-frame.png');
    await fs.writeFile(out.shots.frame, img);
  }
  // 页面在缺料时每 700 ms 重取同一帧;给它几拍换上
  await delay(4000);
  out.shots.after = path.join(OUT, 'legacy-after.png');
  await pageB.page.screenshot({ path: out.shots.after });
  const readyB = await preloadUntilReady(B, pageB.key, '[b] 后台那一趟跑完');
  check(readyB?.status === 'ready', '[b] 后台那一趟以 ready 结束', readyB);
  out.b.preload = readyB?.status ?? null;

  const pngB = await pngFiles(B.library);
  let same = 0;
  for (const [name, buf] of pngB) if (pngA.get(name)?.equals(buf)) same++;
  out.pngFrames = { a: pngA.size, b: pngB.size, identical: same };
  out.identicalPng = pngB.size > 0 && same === pngB.size;
  check(out.identicalPng, 'B 的 PNG 缓存与 A 逐字节相同(原样取回,不是本机补渲的)', out.pngFrames);
} catch (error) {
  fails.push(`探针自己出错:${error?.stack || error}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const child of children.reverse()) killTree(child);
  await Promise.all(children.map(exited));
  if (!KEEP) for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
const result = { ok: fails.length === 0, ...out, fails };
console.log(JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, before: out.before ?? null, after: out.after ?? null, pngFrames: out.pngFrames ?? null, identicalPng: out.identicalPng ?? null, shots: out.shots ?? null, fails }));
process.exit(result.ok ? 0 : 1);
