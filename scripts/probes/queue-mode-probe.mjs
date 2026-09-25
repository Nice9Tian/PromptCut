/**
 * 队列模式的端到端探针(契约 `docs/plan/render-queue-contract.md` J.7 末段,设计附件第 0 节第 1 条)。
 *
 * 同一个探针项目、同一台机器,前后各起一套编辑器进程 + 预渲染进程,各用一个空帧库:
 *
 *   1. **普通模式**:preload,等后台那一趟跑完(`status === 'ready'`);
 *   2. **队列模式**(`PROMPTCUT_QUEUE_NODE=1`):等本机节点报到(诊断里 `queue.active`),preload,
 *      等后台那一趟跑完、`plan` 被切分、所有细任务都 `task.done`(或 `task.failed`)。
 *
 * 然后逐个比较两边帧库里的快照文件(`controls-html/**`、`controls-local/**` 的 `<帧>.html`)与 `index.json`。
 * 普通模式下同一帧可能先后被写三遍(锚帧那一趟、`fillCardControls` / `renderLocalSnapshots`、B 趟),
 * 后写的赢;队列模式下非锚帧只由执行器写一遍。两边有差异时 **`ok` 仍为真**、`identical: false`,
 * 差异逐帧列出来,由主 Agent 判断是不是 preload 本身三写造成的(契约 J.7)。
 *
 * **文档服务**:每一趟各起一个独立的文档服务(`server/docservice/main.mjs`,数据目录是新建的临时目录),
 * 经 `PROMPTCUT_DOCSERVICE_URL` 交给编辑器。不用编辑器里挂的那一份:它的内容库落在工作副本的
 * `out/docservice`,两趟共用 —— 后一趟的 preload 会按清单把前一趟推上去的段整段拉回来(C6.4 的换机取用),
 * 队列的细任务也会按清单去重完成,两边就「一定相同」,比较没有意义。`--docservice-url <ws://…>` 可以改用
 * 外面现成的一个(两趟共用,自己负责它是空的)。
 *
 * 轨道流缺省关掉(`PROMPTCUT_STREAMS=0`):流不走队列(J.0),也不影响快照;开着的话本机节点要等流全产完才闲。
 * `--streams` 保留流。
 *
 *   node scripts/probes/queue-mode-probe.mjs [--queue-port 5516] [--normal-port 5513] [--docservice-port 5519]
 *        [--docservice-url ws://…] [--streams] [--only queue|normal] [--timeout-min 20] [--keep]
 *
 * 端口:每台编辑器另占「端口 +1」「端口 +2」当舞台端口,三个连号都要空着;文档服务一个端口。
 * `--keep` 不删两边的临时帧库(调试用)。输出最后一行是一行 JSON:
 * `{ ok, tasks, done, identical, differentFrames: [...], fails }`,另带一些诊断字段;`ok` 为假时退出码 1。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { anchorFrames } from '../../src/render/snapshotPick.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const QUEUE_PORT = Number(arg('--queue-port', 5516));
const NORMAL_PORT = Number(arg('--normal-port', 5513));
const DOC_PORT = Number(arg('--docservice-port', 5519));
const DOC_URL = arg('--docservice-url', null);
const STREAMS = args.includes('--streams');
const KEEP = args.includes('--keep');
const ONLY = arg('--only', null);
const TIMEOUT_MS = Number(arg('--timeout-min', 20)) * 60_000;

const fails = [];
const out = { root: ROOT, queuePort: QUEUE_PORT, normalPort: NORMAL_PORT, docservice: DOC_URL ?? `standalone:${DOC_PORT}`, streams: STREAMS };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return cond; };

const FPS = 30;
const STAMP = Date.now().toString(36);
/**
 * 3 秒 = 90 帧:共享档的两张卡各切两段(0～59、60～89);`unknown` 卡(本地档)从 1 秒起,
 * 它的挂载帧(30)在另两张卡中间切出一个锚帧。项目 id 固定,两趟算出同一组键(帧库是空的)。
 */
const PROJECT = {
  id: 'queue-mode-probe', name: '队列模式探针', width: 1920, height: 1080, fps: FPS, duration: 3,
  themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-1', name: 'tr-1', hidden: false, clips: [{ id: 'clip-stateful', kind: 'card', cardId: 'r6-stateful', start: 0, end: 3, params: {} }] },
    { id: 'tr-2', name: 'tr-2', hidden: false, clips: [{ id: 'clip-canvas', kind: 'card', cardId: 'r6-canvas', start: 0, end: 3, params: {} }] },
    { id: 'tr-3', name: 'tr-3', hidden: false, clips: [{ id: 'clip-unknown', kind: 'card', cardId: 'r6-unknown', start: 1, end: 3, params: {} }] },
  ],
};
const ANCHORS = anchorFrames(PROJECT.tracks.flatMap(t => t.clips), FPS).filter(n => n >= 0 && n < PROJECT.duration * FPS);
out.anchors = ANCHORS;

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

/** 一趟:起文档服务(独立模式)和编辑器,preload 探针项目,等它产完,收帧库 */
async function runOnce(mode) {
  const port = mode === 'queue' ? QUEUE_PORT : NORMAL_PORT;
  const exportDir = path.join(os.tmpdir(), `pc-queue-probe-${mode}-${STAMP}`);
  const library = path.join(exportDir, 'frame-library');
  await fs.mkdir(path.join(exportDir, 'data'), { recursive: true });
  const run = { mode, port, exportDir, log: [] };
  const children = [];
  try {
    for (const p of [port, port + 1, port + 2, ...(DOC_URL ? [] : [DOC_PORT])]) check(await portFree(p), `[${mode}] 端口 ${p} 空着`);
    if (fails.length) return run;
    let docUrl = DOC_URL;
    if (!docUrl) {
      const docData = path.join(exportDir, 'docservice');
      // 只绑回环、不带令牌:匿名模式(main.mjs 文件头)。编辑器、预渲染进程也就不必带令牌
      const docEnv = { ...process.env, PROMPTCUT_DOCSERVICE_PORT: String(DOC_PORT), PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_DATA: docData };
      delete docEnv.PROMPTCUT_CLUSTER_TOKEN;
      const doc = spawn(process.execPath, [path.join(ROOT, 'server', 'docservice', 'main.mjs')], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: docEnv,
      });
      doc.stdout.resume(); doc.stderr.resume();
      children.push(doc);
      docUrl = `ws://127.0.0.1:${DOC_PORT}`;
      await until(`[${mode}] 文档服务起来`, async () => (await json(`http://127.0.0.1:${DOC_PORT}/healthz`)).body?.ok === true || null, 30000);
    }
    const env = { ...process.env, PROMPTCUT_EXPORT_DIR: exportDir, PROMPTCUT_DATA_DIR: path.join(exportDir, 'data'), PROMPTCUT_DOCSERVICE_URL: docUrl };
    delete env.PROMPTCUT_QUEUE_NODE;
    if (!DOC_URL) delete env.PROMPTCUT_CLUSTER_TOKEN;
    if (mode === 'queue') env.PROMPTCUT_QUEUE_NODE = '1';
    if (!STREAMS) env.PROMPTCUT_STREAMS = '0';
    const editor = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    children.push(editor);
    const keep = c => { run.log.push(c.toString()); if (run.log.length > 400) run.log.shift(); };
    editor.stdout.on('data', keep);
    editor.stderr.on('data', keep);
    const EDITOR = `http://127.0.0.1:${port}`;
    await until(`[${mode}] 编辑器进程起来`, async () => (await fetch(EDITOR + '/api/prerender/info').then(r => r.ok, () => false)) || null, 120000);
    const base = await until(`[${mode}] 预渲染进程就绪`, async () => {
      const info = await json(EDITOR + '/api/prerender/info');
      return info.body?.ready && info.body.url ? info.body.url : null;
    }, 180000);
    if (!base) return run;
    run.prerender = base;
    const diagnostics = async () => (await json(`${base}/api/frames/diagnostics`)).body ?? {};

    if (mode === 'queue') {
      // 第一次打 /api/frames/* 才建管线、起本机节点;等它连上文档服务、报到
      const active = await until('[queue] 本机节点报到(诊断里 queue.active)', async () => (await diagnostics()).queue?.active === true || null, 180000, 1000);
      const d = await diagnostics();
      run.queueStart = d.queue ? { mode: d.queue.mode, url: d.queue.url, nodeId: d.queue.nodeId, envFingerprint: d.queue.envFingerprint } : null;
      if (!active) {
        run.queueLog = run.log.join('').split('\n').filter(line => line.includes('[queue-node]')).slice(-10);
        return run;
      }
    } else {
      const d = await diagnostics();
      check(d.queue === undefined, '[normal] 开关关着时诊断里没有 queue 键', Object.keys(d));
    }

    const SESSION = `qmp-${mode}-${STAMP}`;
    const pushed = await postJson(EDITOR + '/api/data/project', { session: SESSION, localRev: 1, project: PROJECT });
    check(pushed.ok, `[${mode}] 项目推进镜像`, pushed.body);
    await until(`[${mode}] 预渲染进程手里有这一版项目`, async () => (await json(`${base}/api/data/project?session=${SESSION}&localRev=1`)).ok || null, 30000);
    const started = Date.now();
    const preload = await postJson(`${base}/api/frames/preload`, { session: SESSION, localRev: 1 });
    check(preload.ok, `[${mode}] preload 开跑`, preload.body);
    const key = preload.body?.key;
    run.entryKey = key;
    const ready = await until(`[${mode}] 后台那一趟跑完`, async () => {
      // 页面每 2 秒重发一次 preload 保活,这里照做(同一版直接返回)
      const status = await postJson(`${base}/api/frames/preload`, { session: SESSION, localRev: 1 });
      return status.body?.status === 'ready' ? status.body : status.body?.status === 'error' ? status.body : null;
    }, TIMEOUT_MS, 2000);
    check(ready?.status === 'ready', `[${mode}] 后台那一趟以 ready 结束`, ready);
    run.preloadMs = Date.now() - started;

    if (mode === 'queue') {
      const settled = await until('[queue] plan 切分完、所有细任务落定', async () => {
        const q = (await diagnostics()).queue;
        const plan = q?.published?.[0]?.planId;
        const derived = plan ? q.plans?.[plan] : null;
        if (!Array.isArray(derived)) return null;
        const states = derived.map(id => q.tasks?.[id]?.state ?? 'pending');
        return states.every(s => s === 'done' || s === 'failed') ? { plan, derived, states, q } : null;
      }, TIMEOUT_MS, 2000);
      if (settled) {
        const { q } = settled;
        run.plan = settled.plan;
        run.tasks = settled.derived.length;
        run.done = settled.states.filter(s => s === 'done').length;
        run.failedTasks = settled.derived.filter((id, i) => settled.states[i] === 'failed').map(id => ({ id, error: q.tasks[id]?.error ?? null }));
        run.queueStats = q.stats;
        run.queueEvents = q.events.filter(e => /failed|lost|discarded|mismatch|skip|offline|error/.test(e.event)).slice(-20);
        check(run.failedTasks.length === 0, '[queue] 没有细任务失败', run.failedTasks);
        check(q.stats.completed + q.stats.dedup >= run.done, '[queue] 细任务都由节点完成(completed + dedup)', q.stats);
      }
      run.queueMs = Date.now() - started;
      await delay(3000);   // task.done 的 applyResult 在后台串行跑,留一点时间
    }
    const d = await diagnostics();
    run.plans = (d.plans ?? []).map(p => ({ key: p.key, controls: p.controls.map(c => ({ clipId: c.clipId, tier: c.tier, snapshotKey: c.snapshotKey, picked: c.picked })) }));
    run.library = library;
    return run;
  } finally {
    for (const child of children.reverse()) killTree(child);
    await Promise.all(children.map(exited));
  }
}

/** 帧库里全部快照:`<相对路径>` → 字节。`controls-html/<键>/…`、`controls-local/<entry.key>/<键>/…` */
async function snapshotTree(library) {
  const files = new Map();
  const walk = async (dir) => {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else if (/\.(html|json)$/.test(item.name)) files.set(path.relative(library, file).replaceAll('\\', '/'), await fs.readFile(file));
    }
  };
  await walk(path.join(library, 'controls-html'));
  await walk(path.join(library, 'controls-local'));
  return files;
}

/** 键 → 片段与档位(从 card plan 反查),差异列表里好认 */
function keyIndex(run) {
  const map = new Map();
  for (const plan of run?.plans ?? []) for (const c of plan.controls) if (c.snapshotKey) map.set(c.snapshotKey, { clipId: c.clipId, tier: c.tier });
  return map;
}

const runs = {};
try {
  if (ONLY !== 'queue') runs.normal = await runOnce('normal');
  if (ONLY !== 'normal' && !fails.some(f => f.includes('端口'))) runs.queue = await runOnce('queue');
  out.runs = Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { ...r, log: undefined, library: undefined }]));
  out.tasks = runs.queue?.tasks ?? 0;
  out.done = runs.queue?.done ?? 0;
  out.identical = null;
  out.differentFrames = [];
  if (runs.normal?.library && runs.queue?.library) {
    const a = await snapshotTree(runs.normal.library);
    const b = await snapshotTree(runs.queue.library);
    const keys = keyIndex(runs.normal);
    const clipStart = Object.fromEntries(PROJECT.tracks.flatMap(t => t.clips).map(c => [c.id, Math.round(c.start * FPS)]));
    const describe = rel => {
      const parts = rel.split('/');
      const tier = parts[0] === 'controls-local' ? 'local' : 'shared';
      const key = tier === 'local' ? parts[2] : parts[1];
      const name = parts[parts.length - 1];
      const hit = keys.get(key);
      const frame = /^\d+\.html$/.test(name) ? Number(name.slice(0, -5)) : null;
      const global = hit && frame !== null ? frame + (clipStart[hit.clipId] ?? 0) : null;
      return { file: rel, tier, clipId: hit?.clipId ?? null, localFrame: frame, anchor: global !== null ? ANCHORS.includes(global) : null };
    };
    for (const rel of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      const x = a.get(rel), y = b.get(rel);
      if (x && y && x.equals(y)) continue;
      out.differentFrames.push({ ...describe(rel), reason: !x ? 'only-in-queue' : !y ? 'only-in-normal' : 'bytes', normalBytes: x?.length ?? null, queueBytes: y?.length ?? null });
    }
    out.compared = { normalFiles: a.size, queueFiles: b.size, htmlFiles: [...a.keys()].filter(k => k.endsWith('.html')).length };
    out.identical = out.differentFrames.length === 0;
    check(out.compared.htmlFiles > 0, '普通模式的帧库里有快照', out.compared);
    check(out.tasks > 0, '队列模式切出了细任务', out.tasks);
    check(out.done === out.tasks, '队列模式的细任务全部 done', { tasks: out.tasks, done: out.done });
    const summary = {};
    for (const d of out.differentFrames) {
      const k = `${d.clipId ?? '?'}/${d.tier}/${d.reason}/${d.anchor ? 'anchor' : 'non-anchor'}`;
      summary[k] = (summary[k] ?? 0) + 1;
    }
    out.differenceSummary = summary;
  } else if (!ONLY) check(false, '两趟都要有帧库才能比较', Object.keys(runs));
} catch (error) {
  fails.push(`探针自己出错:${error?.stack || error}`);
} finally {
  if (!KEEP) for (const run of Object.values(runs)) if (run?.exportDir) await fs.rm(run.exportDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}

const result = { ok: fails.length === 0, tasks: out.tasks ?? 0, done: out.done ?? 0, identical: out.identical ?? null,
  differentFrames: out.differentFrames ?? [], fails, ...out };
console.log(JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, tasks: result.tasks, done: result.done, identical: result.identical,
  differentFrames: result.differentFrames.length, differenceSummary: out.differenceSummary ?? null, fails }));
process.exit(result.ok ? 0 : 1);
