/**
 * X6 的跨进程探针(`docs/plan/m6c-contract.md` X6 验收):同一内容在**两个预渲染进程**里生成的快照,块哈希逐张相同。
 *
 * 前后各起一套编辑器进程 + 预渲染进程(普通模式,各用一个空帧库),preload 同一个 10 张卡的探针项目,
 * 等后台那一趟跑完(`status === 'ready'`),然后按卡片计划把每张卡的共享档快照
 * (`controls-html/<共享键>/<帧>.html`)两边逐帧比 sha256 —— 也就是 C6.2 清单里的块哈希。
 *
 * 两趟都关掉推送(`PROMPTCUT_PUSH=0`)和轨道流(`PROMPTCUT_STREAMS=0`),不设文档服务:两个进程互不相干,
 * 也不会去连本机别处的文档服务。两边的差异另标 `styleOrderOnly`(只差 style 里声明的先后,X6 修的就是这一类)。
 *
 *   node scripts/probes/snapshot-hash-probe.mjs [--port-a 5420] [--port-b 5423] [--cards a,b,…] [--seconds 1]
 *        [--root <另一份检出>] [--timeout-min 20] [--keep]
 *
 * `--root`:用另一份检出(例如临时起的 main 的 worktree)的编辑器跑,拿来对照修复前的样子;缺省是本探针所在的检出。
 * 端口:每台编辑器另占「端口 +1」「端口 +2」当舞台端口,三个连号都要空着。
 * 输出最后一行是一行 JSON:`{ ok, cards, frames, identical, differentFrames, styleOrderOnly, fails }`;`ok` 为假时退出码 1。
 * `ok` 的条件:10 张卡(或 `--cards` 给的张数)每张两边都有快照、帧集合相同、逐帧 sha256 相同。
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

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const ROOT = path.resolve(arg('--root', HERE));
const PORT_A = Number(arg('--port-a', 5420));
const PORT_B = Number(arg('--port-b', 5423));
const SECONDS = Number(arg('--seconds', 1)) || 1;
const TIMEOUT_MS = Number(arg('--timeout-min', 20)) * 60_000;
const KEEP = args.includes('--keep');
/** 审阅表里 `independent`、`stateful` 的卡(共享档、进预渲染集合):SVG(lottie)、hud 卡、MagicUI 卡,外加两张 R6 探针卡
 *  (`r6-stateful` 带 `<style>` 与 Tailwind 类,`r6-canvas` 是画布卡)—— 改动之前正是这两张在两个进程之间只差 style 声明的先后
 *  (`docs/reports/AGENT-m5b-pipeline.md` 第 126 行)。
 *  `direct` 的卡(如 caption-track)不产快照,不能放进来 */
const DEFAULT_CARDS = ['ui-callout', 'entity-chips', 'focus-card', 'lottie-adrock', 'mu-animated-shiny-text',
  'r6-stateful', 'pin-board', 'punch-pill', 'quote-lockup', 'r6-canvas'];
const CARDS = (arg('--cards', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const cards = CARDS.length ? CARDS : DEFAULT_CARDS;

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return cond; };
const STAMP = Date.now().toString(36);
const FPS = 30;
const PROJECT = {
  id: 'snapshot-hash-probe', name: '块哈希探针', width: 1920, height: 1080, fps: FPS, duration: SECONDS,
  themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: cards.map((cardId, i) => ({ id: `tr-${i}`, name: `tr-${i}`, hidden: false,
    clips: [{ id: `clip-${i}-${cardId}`, kind: 'card', cardId, start: 0, end: SECONDS, params: {} }] })),
};

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
/** 工作副本没有自己的 node_modules(往上走到主仓库那一份),所以按模块解析 vite 的 bin */
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(path.join(ROOT, 'package.json')).resolve('vite');
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

/** 一趟:起编辑器(它拉起预渲染进程),preload 探针项目,等后台那一趟跑完,回帧库与卡片计划 */
async function runOnce(label, port) {
  const exportDir = path.join(os.tmpdir(), `pc-hash-probe-${label}-${STAMP}`);
  await fs.mkdir(path.join(exportDir, 'data'), { recursive: true });
  const run = { label, port, exportDir, library: path.join(exportDir, 'frame-library'), log: [] };
  let editor = null;
  try {
    for (const p of [port, port + 1, port + 2]) check(await portFree(p), `[${label}] 端口 ${p} 空着`);
    if (fails.length) return run;
    const env = { ...process.env, PROMPTCUT_EXPORT_DIR: exportDir, PROMPTCUT_DATA_DIR: path.join(exportDir, 'data'),
      PROMPTCUT_PUSH: '0', PROMPTCUT_STREAMS: '0' };
    for (const name of ['PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_ASSET_URL']) delete env[name];
    editor = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    const keep = c => { run.log.push(c.toString()); if (run.log.length > 300) run.log.shift(); };
    editor.stdout.on('data', keep);
    editor.stderr.on('data', keep);
    const EDITOR = `http://127.0.0.1:${port}`;
    await until(`[${label}] 编辑器进程起来`, async () => (await fetch(EDITOR + '/api/prerender/info').then(r => r.ok, () => false)) || null, 120000);
    const base = await until(`[${label}] 预渲染进程就绪`, async () => {
      const info = await json(EDITOR + '/api/prerender/info');
      return info.body?.ready && info.body.url ? info.body.url : null;
    }, 180000);
    if (!base) return run;
    const SESSION = `hash-${label}-${STAMP}`;
    const pushed = await postJson(EDITOR + '/api/data/project', { session: SESSION, localRev: 1, project: PROJECT });
    check(pushed.ok, `[${label}] 项目推进镜像`, pushed.body);
    await until(`[${label}] 预渲染进程手里有这一版项目`, async () => (await json(`${base}/api/data/project?session=${SESSION}&localRev=1`)).ok || null, 30000);
    const started = Date.now();
    const preload = await postJson(`${base}/api/frames/preload`, { session: SESSION, localRev: 1 });
    check(preload.ok, `[${label}] preload 开跑`, preload.body);
    const ready = await until(`[${label}] 后台那一趟跑完`, async () => {
      const status = await postJson(`${base}/api/frames/preload`, { session: SESSION, localRev: 1 });
      return status.body?.status === 'ready' ? status.body : status.body?.status === 'error' ? status.body : null;
    }, TIMEOUT_MS, 2000);
    check(ready?.status === 'ready', `[${label}] 后台那一趟以 ready 结束`, ready);
    run.preloadMs = Date.now() - started;
    const d = (await json(`${base}/api/frames/diagnostics`)).body ?? {};
    run.envFingerprint = d.envFingerprint ?? d.environment?.fingerprint ?? null;
    run.controls = (d.plans ?? []).flatMap(p => p.controls.map(c => ({ clipId: c.clipId, tier: c.tier, snapshotKey: c.snapshotKey, picked: c.picked })));
    return run;
  } finally {
    killTree(editor);
    await exited(editor);
  }
}

/** 一张卡在帧库里的快照:帧号 → 字节 */
async function framesOf(library, key) {
  const dir = path.join(library, 'controls-html', key);
  const out = new Map();
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const m = /^(\d+)\.html$/.exec(name);
    if (m) out.set(Number(m[1]), await fs.readFile(path.join(dir, name)));
  }
  return out;
}
const sortStyles = html => html.replace(/style="([^"]*)"/g, (_, s) => 'style="' + s.split(';').map(x => x.trim()).filter(Boolean).sort().join(';') + '"');

const out = { root: ROOT, ports: [PORT_A, PORT_B], cards, seconds: SECONDS };
const runs = [];
try {
  runs.push(await runOnce('a', PORT_A));
  if (!fails.some(f => f.includes('端口'))) runs.push(await runOnce('b', PORT_B));
  const [a, b] = runs;
  out.preloadMs = runs.map(r => r.preloadMs ?? null);
  if (a?.controls && b?.controls) {
    const perCard = [];
    let frames = 0, identical = 0, styleOrderOnly = 0;
    const differentFrames = [];
    for (const clip of PROJECT.tracks.flatMap(t => t.clips)) {
      const ca = a.controls.find(c => c.clipId === clip.id);
      const cb = b.controls.find(c => c.clipId === clip.id);
      const row = { cardId: clip.cardId, clipId: clip.id, tier: ca?.tier ?? null, sameKey: !!ca && ca.snapshotKey === cb?.snapshotKey };
      perCard.push(row);
      if (!check(ca && cb && ca.tier === 'shared' && row.sameKey, `[${clip.cardId}] 两边都有共享档键且相同`, { a: ca ?? null, b: cb ?? null })) continue;
      const fa = await framesOf(a.library, ca.snapshotKey);
      const fb = await framesOf(b.library, cb.snapshotKey);
      row.framesA = fa.size; row.framesB = fb.size;
      check(fa.size > 0 && fb.size > 0, `[${clip.cardId}] 两边都有快照`, { a: fa.size, b: fb.size });
      check([...fa.keys()].sort((x, y) => x - y).join() === [...fb.keys()].sort((x, y) => x - y).join(), `[${clip.cardId}] 两边帧集合相同`);
      row.identical = 0; row.hashA = null;
      for (const [n, bufA] of [...fa].sort((x, y) => x[0] - y[0])) {
        const bufB = fb.get(n);
        if (!bufB) continue;
        frames++;
        if (sha(bufA) === sha(bufB)) { identical++; row.identical++; continue; }
        const orderOnly = sortStyles(bufA.toString('utf8')) === sortStyles(bufB.toString('utf8'));
        if (orderOnly) styleOrderOnly++;
        differentFrames.push({ cardId: clip.cardId, frame: n, styleOrderOnly: orderOnly, bytesA: bufA.length, bytesB: bufB.length });
      }
      row.hashA = fa.size ? sha(Buffer.concat([...fa].sort((x, y) => x[0] - y[0]).map(([, buf]) => Buffer.from(sha(buf))))).slice(0, 16) : null;
      row.hashB = fb.size ? sha(Buffer.concat([...fb].sort((x, y) => x[0] - y[0]).map(([, buf]) => Buffer.from(sha(buf))))).slice(0, 16) : null;
    }
    Object.assign(out, { perCard, frames, identical, styleOrderOnly, differentFrames });
    check(perCard.length === cards.length, '每张卡都有一行', perCard.length);
    check(frames > 0 && identical === frames, '逐帧块哈希全同', { frames, identical, styleOrderOnly, different: differentFrames.slice(0, 10) });
  } else check(false, '两趟都要有卡片计划才能比', runs.map(r => r?.label));
} catch (error) {
  fails.push(`探针自己出错:${error?.stack || error}`);
} finally {
  out.runs = runs.map(r => ({ label: r.label, port: r.port, preloadMs: r.preloadMs ?? null, envFingerprint: r.envFingerprint ?? null, controls: r.controls?.length ?? null,
    logTail: fails.length ? r.log.join('').split('\n').slice(-15) : undefined }));
  if (!KEEP) for (const r of runs) await fs.rm(r.exportDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
const result = { ok: fails.length === 0, ...out, fails };
console.log(JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, cards: out.perCard?.length ?? 0, frames: out.frames ?? 0, identical: out.identical ?? 0,
  differentFrames: out.differentFrames?.length ?? null, styleOrderOnly: out.styleOrderOnly ?? null, fails }));
process.exit(result.ok ? 0 : 1);
