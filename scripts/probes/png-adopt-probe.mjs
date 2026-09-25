/**
 * X7 的可视验收(`docs/plan/m6c-contract.md` X7):远端节点产的卡,本机 `?preview=legacy` 下显示真实 PNG,不是占位。
 *
 * 在一台机器上用两套编辑器 + 预渲染进程模拟「远端产、本机取」(思路同 `queue-mode-probe.mjs`):
 *
 *   0. 起一个独立的文档服务 D(临时数据目录);
 *   1. **A(远端)**:编辑器 + 预渲染进程,连 D、开推送(`PROMPTCUT_PUSH=1`)。页面以 `?preview=legacy` 打开、载入探针项目,
 *      探针按页面的镜像键调 A 的 preload,等后台那一趟 `ready`、推送队列清空 —— A 产的快照与 PNG 缓存帧(X7 的 `pngs`)
 *      都推到了 A 的素材服务,清单写进了 D 的内容库;
 *   2. **B(本机)**:另一套编辑器 + 预渲染进程,连同一个 D,素材服务指向 A 的(`PROMPTCUT_ASSET_URL`):
 *        - **取之前(对照)**:探针用自己的会话把同一份项目推进 B 的镜像,调 legacy 整帧通道 `/api/frames/see`(1 秒那一帧,
 *          不触发 preload):B 没有这张卡的 PNG,这一帧 `incomplete`、`missing` 里有这张卡 —— 占位;帧图存 `legacy-before-frame.png`;
 *        - **取之后**:B 的编辑器页面以 `?preview=legacy` 打开同一份项目,停在 1 秒。legacy 页面自己触发 preload,B 先按清单换机取用
 *          (C6.4 `adoptFromManifests` → C6.2 `applyResult`,X7 在这里把 PNG 一并取回);等页面换上整帧,截图 `legacy-after.png`;
 *          再调一次 `see`,这一帧不再 `incomplete`(帧图存 `legacy-after-frame.png`);
 *        - B 盘上这张卡的 PNG 缓存与 A 逐字节相同;B 没有这张卡的 `full.mov`(没跑过 PNG 那一支),A 有。
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
const notes = [];
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
async function openLegacy(browser, editor, { placeholderShot = null } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  /*
   * 探针自带的垫片(不改产品代码):本分支的基线上,legacy 的 `UnifiedPreview` 按 `target: "user"` 把整帧请求发给
   * **编辑器**进程,而编辑器进程(`interactive: false`)对 user lane 一律回 503「交互帧请求请直接打预渲染进程」,
   * 所以 `?preview=legacy` 页面永远只有一条报错、没有画面 —— 与 X7 无关的既有问题(报告「遗留」一节)。
   * 这里在浏览器里把那一个模块的 `target: "user"` 换成 `target: "prerender"`(`see_frames` 的缺省),
   * 整帧请求照 D5 打预渲染进程,legacy 页面才看得到画面。只动这一处请求去哪,不动画面怎么来。
   */
  await page.setRequestInterception(true);
  page.on('request', async req => {
    let url;
    try { url = new URL(req.url()); } catch { return req.continue(); }
    if (url.pathname !== '/src/editor/preview/UnifiedPreview.tsx') return req.continue();
    try {
      const res = await fetch(req.url());
      const text = await res.text();
      const patched = text.split('target: "user"').join('target: "prerender"');
      out.legacyShim = (out.legacyShim ?? 0) + (patched !== text ? 1 : 0);
      await req.respond({ status: res.status, contentType: res.headers.get('content-type') || 'text/javascript', body: patched });
    } catch { await req.continue().catch(() => {}); }
  });
  await page.goto(editor.origin + '/?editor&nosetup=1&preview=legacy', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => { try { await import('/src/store/project.ts'); return true; } catch { return false; } }, { timeout: 180000, polling: 500 });
  await page.evaluate(async (project, t) => {
    const { actions } = await import('/src/store/project.ts');
    actions.loadProject(project);
    actions.seek(t);
  }, PROJECT, T_SEC);
  /*
   * 取之前的页面截图(尽力而为):页面第一次取到的整帧若是占位帧(`preview-frames/` 下),马上截一张。
   * 页面自己很快就触发 preload、取回 PNG,这个窗口可能只有一两秒,没抓到只记一条 note,不算失败。
   */
  if (placeholderShot) void (async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      let v = null;
      try { v = await legacyView(page); } catch { return; }
      if (v?.img && /preview-frames/.test(v.img)) {
        await delay(300);
        try { await page.screenshot({ path: placeholderShot }); out.shots.before = placeholderShot; } catch { /* 页面已关 */ }
        return;
      }
      if (v?.img) break;   // 第一张就已经是整帧:窗口错过了
      await delay(100);
    }
    notes.push('没抓到 B 页面上的占位帧(页面取第一帧之前 PNG 已经取回),取之前以 legacy-before-frame.png 为准');
  })();
  const key = await until(`[${editor.label}] 页面的镜像键`, async () => page.evaluate(async () => {
    const k = (await import('/src/render/dataMirror.ts')).mirrorKey();
    return k && k.localRev >= 1 ? { session: k.session, localRev: k.localRev } : null;
  }), 60000, 500);
  // 页面 store 里载入后的样子(`loadProject` 会补剪辑等字段);探针另起的会话要推这一份,键才与页面的相同
  const project = await page.evaluate(async () => JSON.parse(JSON.stringify((await import('/src/store/project.ts')).getState().project)));
  return { page, key, project };
}

/** legacy 页面此刻的样子:整帧 `<img>` 的地址、有没有报错条。不发帧请求(那会顶掉页面自己的请求) */
const legacyView = page => page.evaluate(() => {
  const img = [...document.querySelectorAll('img')].find(el => /\/api\/frames\//.test(el.getAttribute('src') || ''));
  const text = document.body.innerText || '';
  return { img: img ? img.getAttribute('src') : null, error: /Error:/.test(text) ? (text.match(/Error:[^\n]*/) || [''])[0].slice(0, 160) : null };
});

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
  out.shots = {};
  /*
   * 取之前(对照):B 刚起来、还没有任何 preload。探针用另一个会话把**同一份**项目(A 页面 store 里的那份)推进 B 的镜像,
   * 调 legacy 整帧通道 `see`(只渲这一帧,不触发 preload、不取清单):B 没有这张卡的 PNG,这一帧是占位。
   * 不用页面的会话:页面自己也在按同一条 lane 取帧,探针的请求会把它顶掉。
   */
  const probeKey = { session: `png-adopt-before-${STAMP}`, localRev: 1 };
  const pushedB = await postJson(`${B.origin}/api/data/project`, { ...probeKey, project: pageA.project });
  check(pushedB.ok, '[b] 对照会话推进镜像', pushedB.body);
  await until('[b] 预渲染进程手里有对照会话的项目', async () => (await json(`${B.base}/api/data/project?session=${probeKey.session}&localRev=1`)).ok || null, 30000);
  const before = await seeAt(B, probeKey);
  const beforeFrame = before?.frames?.[0] ?? null;
  out.before = beforeFrame ? { source: beforeFrame.source, incomplete: beforeFrame.incomplete, missing: beforeFrame.missing } : before;
  check(beforeFrame?.incomplete === true && beforeFrame.missing.includes('clip-remote'), '取之前:legacy 这一帧是占位(incomplete,缺这张卡)', out.before);
  if (beforeFrame?.url) {
    out.shots.beforeFrame = path.join(OUT, 'legacy-before-frame.png');
    await fs.writeFile(out.shots.beforeFrame, Buffer.from(await (await fetch(B.base + beforeFrame.url)).arrayBuffer()));
  }

  /*
   * 取之后:B 的编辑器页面以 `?preview=legacy` 打开同一份项目。legacy 页面自己会触发 preload(`usePrerenderPreload`),
   * B 的 preload 第一件事是按清单换机取用(C6.4 `adoptFromManifests` → `applyResult`,X7 在这里把 PNG 一并取回)。
   * 等诊断报出 `adoption`、页面的整帧 `<img>` 换上、没有报错条,截图。
   */
  const pageB = await openLegacy(browser, B, { placeholderShot: path.join(OUT, 'legacy-before.png') });
  if (!pageB.key) throw new Error('B 的页面没有镜像键');
  check((out.legacyShim ?? 0) >= 1, 'legacy 垫片生效(UnifiedPreview 的整帧请求改打预渲染进程)', out.legacyShim ?? 0);
  const adoption = await until('[b] 换机取用报出来', async () => (await diagnostics(B)).adoption ?? null, 180000, 500);
  out.b = { adoption };
  check((adoption?.manifests ?? 0) >= 1, '[b] 按清单换机取用了至少一段', adoption);
  // 一段 60 帧快照 + 同一段的 PNG 缓存帧都是从 A 的素材服务下的
  check((adoption?.fetched ?? 0) >= 60 + pngA.size, '[b] 下载的块数 = 快照 + PNG', { fetched: adoption?.fetched, png: pngA.size });
  const readyB = await preloadUntilReady(B, pageB.key, '[b] 后台那一趟跑完');
  check(readyB?.status === 'ready', '[b] 后台那一趟以 ready 结束', readyB);
  out.b.preload = readyB?.status ?? null;
  // 页面缺料时每 700 ms 重取同一帧;等它换上一张不缺料的整帧(img 地址不在 preview-frames 下),再多等一拍
  const view = await until('[b] legacy 页面换上整帧', async () => {
    const v = await legacyView(pageB.page);
    return v.img && !/preview-frames/.test(v.img) && !v.error ? v : null;
  }, 60000, 500);
  out.b.view = view;
  await delay(1500);
  out.shots.after = path.join(OUT, 'legacy-after.png');
  await pageB.page.screenshot({ path: out.shots.after });
  // 截完图再用探针自己的会话看这一帧(它会顶掉页面的请求,所以放在最后)
  const after = await seeAt(B, probeKey);
  const afterFrame = after?.frames?.[0] ?? null;
  out.after = afterFrame ? { source: afterFrame.source, incomplete: afterFrame.incomplete, missing: afterFrame.missing } : after;
  check(afterFrame && afterFrame.incomplete === false && afterFrame.missing.length === 0, '取之后:legacy 这一帧不再占位', out.after);
  if (afterFrame?.url) {
    out.shots.afterFrame = path.join(OUT, 'legacy-after-frame.png');
    await fs.writeFile(out.shots.afterFrame, Buffer.from(await (await fetch(B.base + afterFrame.url)).arrayBuffer()));
  }
  // B 没有为这张卡跑过 PNG 那一支:`fillCardControls` 见 HTML 与 PNG 都齐就跳过,不会走到 `cardCache.finish` 建 full.mov
  const movs = async library => {
    const outMovs = [];
    for (const key of await fs.readdir(path.join(library, 'controls')).catch(() => [])) {
      if (await fs.access(path.join(library, 'controls', key, 'mov', 'full.mov')).then(() => true, () => false)) outMovs.push(key);
    }
    return outMovs;
  };
  out.cardMov = { a: await movs(A.library), b: await movs(B.library) };
  check(out.cardMov.a.length >= 1 && out.cardMov.b.length === 0, 'A 为这张卡跑过 PNG 那一支(有 full.mov),B 没有(取回的 PNG 已齐)', out.cardMov);

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
const result = { ok: fails.length === 0, ...out, notes, fails };
console.log(JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, before: out.before ?? null, after: out.after ?? null, pngFrames: out.pngFrames ?? null, identicalPng: out.identicalPng ?? null, shots: out.shots ?? null, fails }));
process.exit(result.ok ? 0 : 1);
