/**
 * R6 数据面的端到端探针。起编辑器进程 + 预渲染进程,载入一个含 stateful DOM 卡、
 * canvas 卡、`unknown` 卡、超限卡的项目(四张固定卡在 `src/cards/_probe/r6.tsx`),
 * 然后逐条验收 C2 / C3 / C4 / A3c / F5:
 *
 *   1. 锚帧先于其他帧就绪(C2:锚帧全部就绪前不开始其余后台预渲染);
 *   2. SSE 先收到 `reset` 再收到 `layer`,区间随生产增长(C3);
 *   3. `HttpSnapshotSource` 取到的 HTML 和磁盘上的逐字节相同(J3);
 *   4. C4 选帧在冷缓存下回到区间起点;
 *   5. 超限帧不出现在索引里(A3c),但盘上有;
 *   6. `unknown` 卡出现在 `'local'` 表里(计划 3.1(2));
 *   7. 杀掉预渲染进程再起来:**没人发 preload**,编辑器进程照会话版本登记重放 preload,
 *      索引按键重建、**会话版本回来之后才发 `layer`**(F5 + Item 4 方案 A);
 *   8. `wanted` 发出后对应片段的批被提前(C4 服务端消费侧);
 *   9. **在所有位置都判轻的卡不产快照、不进就绪索引**(pinned 渲染 9)——
 *      给一张 stateful 卡写一条便宜的成本记录,它就该从预渲染集合里掉出去。
 *  10. **环境指纹进结果键**(M4,契约 E.7):诊断里的指纹是 16 位十六进制,
 *      每个带 `snapshotKey` 的 control 满足 `snapshotKey === resultKeyOf(contentKey, envFingerprint)`。
 *
 * 成本记录也隔离在临时目录(`PROMPTCUT_DATA_DIR`),不碰仓库的 `out/card-costs.json`。
 *
 *   node scripts/probes/ready-index-probe.mjs [--port 5231] [--out <dir>] [--keep]
 *
 * `--keep` 不关 dev server、也不删产物(调试用)。默认跑完就关、跑完就删。
 *
 * **每次都从冷缓存开始**:`PROMPTCUT_EXPORT_DIR` 指到一个新建的临时目录,所以
 * 「锚帧先于其他帧就绪」这一条量的是真的冷启动,而不是上一次跑剩下的盘。
 * 它由子进程继承,预渲染进程崩了重起也还是同一个目录(F5 那一条要靠它)。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { pickSnapshotFrame, segmentStartOf, anchorFrames } from '../../src/render/snapshotPick.mjs';
import { resultKeyOf } from '../../server/render-node/fingerprint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 5231);
const KEEP = args.includes('--keep');
const EDITOR = `http://127.0.0.1:${PORT}`;
const EXPORT_DIR = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1]
  : path.join(os.tmpdir(), `pc-r6-probe-${Date.now().toString(36)}`));
const LIBRARY = path.join(EXPORT_DIR, 'frame-library');
/** 成本记录（`card-costs.json`）也落在临时目录里，见 `startEditor` */
const DATA_DIR = path.join(EXPORT_DIR, 'data');
fsSync.mkdirSync(DATA_DIR, { recursive: true });
/** ⑨ 自己写的成本记录挂在这个假 device 上（服务端只当不透明字符串用） */
const PROBE_DEVICE = 'r6-probe-device';

const fails = [];
const out = { port: PORT, exportDir: EXPORT_DIR };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); return cond; };

const SESSION = `r6-${Date.now().toString(36)}`;
const FPS = 30;
/** 2 秒 = 60 帧。第四张卡从 1 秒起 —— 它的挂载帧把前三张卡切成两段(C4 的「区间」) */
const PROJECT = {
  id: `r6-probe-${SESSION}`, name: 'R6 数据面探针', width: 1920, height: 1080, fps: FPS, duration: 2,
  themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-1', name: 'tr-1', hidden: false, clips: [{ id: 'clip-stateful', kind: 'card', cardId: 'r6-stateful', start: 0, end: 2, params: {} }] },
    { id: 'tr-2', name: 'tr-2', hidden: false, clips: [{ id: 'clip-canvas', kind: 'card', cardId: 'r6-canvas', start: 0, end: 2, params: {} }] },
    { id: 'tr-3', name: 'tr-3', hidden: false, clips: [{ id: 'clip-unknown', kind: 'card', cardId: 'r6-unknown', start: 0, end: 2, params: {} }] },
    { id: 'tr-4', name: 'tr-4', hidden: false, clips: [{ id: 'clip-huge', kind: 'card', cardId: 'r6-huge', start: 1, end: 2, params: {} }] },
  ],
};

const json = async (url, init) => {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body };
};
const postJson = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** 等一个条件成立;超时回 false(探针自己判,不抛) */
async function until(label, fn, timeoutMs = 120000, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
}

/**
 * SSE 读客户端。不用 `EventSource`(Node 上要实验开关),直接读 body 流 ——
 * 探针要的是「第一条是不是 `reset`」这种顺序,自己解析最清楚。
 */
function openReady(base, onMessage, session = SESSION) {
  const controller = new AbortController();
  const messages = [];
  const done = (async () => {
    const res = await fetch(`${base}/api/frames/ready?session=${encodeURIComponent(session)}&localRev=1`, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`SSE 连不上:${res.status}`);
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const message = JSON.parse(line.slice(5).trim());
            messages.push(message);
            onMessage?.(message);
          } catch { /* 半条消息 */ }
        }
      }
    }
  })().catch(() => {});
  return { messages, close: () => { controller.abort(); return done; } };
}

/** 索引里某一层此刻的样子(从收到的消息里重放,和页面侧 `applyReadyMessage` 一个口径) */
function indexOf(messages) {
  const table = new Map();
  for (const message of messages) {
    if (message.type === 'reset') { table.clear(); continue; }
    if (message.type !== 'layer') continue;
    table.set(`${message.clipId}/${message.kind}`, { key: message.key, ranges: message.ranges });
  }
  return table;
}

/** 这个工作副本没有自己的 node_modules(Node 往上走到主仓库那一份),所以按模块解析;
 *  vite 的 `exports` 不放行 `./bin/vite.js`,解析主入口再回到包根。 */
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

let editor = null;
const editorLog = [];
async function startEditor() {
  editor = spawn(process.execPath, [viteBin(),
    '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    // 冷缓存:产物落在一个新建的临时目录,预渲染子进程继承这个变量
    // 成本记录也隔离到临时目录:⑨ 要自己写几条记录,不能污染仓库的 out/card-costs.json,
    // 也不能让仓库里 R1 / R4 留下的记录影响「没有记录时按声明兜底」那一条
    env: { ...process.env, PROMPTCUT_EXPORT_DIR: EXPORT_DIR, PROMPTCUT_DATA_DIR: DATA_DIR } });
  const keep = c => { const text = c.toString(); editorLog.push(text); if (editorLog.length > 400) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  return until('编辑器进程起来', async () => (await fetch(EDITOR + '/api/prerender/info').then(r => r.ok, () => false)) || null, 120000);
}
function stopEditor() {
  if (!editor || editor.exitCode !== null || !editor.pid) return;
  // 编辑器进程还拉着预渲染进程和 Chrome,只杀它会留孤儿
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editor.kill('SIGKILL');
}

/** 预渲染进程此刻的地址(它崩了会换一个新的空闲端口) */
const prerenderUrl = async () => {
  const info = await json(EDITOR + '/api/prerender/info');
  return info.body?.ready && info.body.url ? info.body.url : null;
};

try {
  await startEditor();
  const base = await until('预渲染进程就绪', prerenderUrl, 180000);
  out.prerender = base;
  if (!base) throw new Error('预渲染进程没起来');

  /* ---- 项目进镜像(编辑器进程收下、原样转发给预渲染进程) ---- */
  const pushed = await postJson(EDITOR + '/api/data/project', { session: SESSION, localRev: 1, project: PROJECT });
  check(pushed.ok, '项目推进镜像', pushed.body);
  await until('预渲染进程手里有这一版项目', async () => (await json(`${base}/api/data/project?session=${SESSION}&localRev=1`)).ok || null, 30000);

  /* ---- 连 SSE,再开预渲染 ---- */
  const ready = openReady(base);
  await until('SSE 连上并收到第一条', () => ready.messages.length > 0 || null, 30000);
  out.firstMessage = ready.messages[0];
  check(ready.messages[0]?.type === 'reset', '① SSE 的第一条是 reset,不是 layer', ready.messages[0]);

  const preload = await postJson(`${base}/api/frames/preload`, { session: SESSION, localRev: 1 });
  check(preload.ok, '预渲染开跑', preload.body);

  /* ---- ① 锚帧先于其他帧就绪 ---- */
  const doneAt = await until('收到 done(锚帧全部就绪)', () => ready.messages.findIndex(m => m.type === 'done') + 1 || null, 300000);
  const beforeDone = ready.messages.slice(0, (doneAt ?? 1) - 1);
  const anchors = anchorFrames(PROJECT.tracks.flatMap(t => t.clips), FPS).filter(n => n < PROJECT.duration * FPS);
  out.anchors = anchors;
  // 锚帧 = [0(三张卡挂载 + 第 0 帧), 29(clip-huge 挂载)];60 不算(超出时长)
  check(anchors.length >= 2 && anchors[0] === 0, '锚帧集合 = 每个片段的 mountFrameOf ∪ last+1 ∪ 第 0 帧', anchors);
  const atDone = indexOf(beforeDone.concat(ready.messages[(doneAt ?? 1) - 1] ?? []));
  out.layersAtDone = [...atDone].map(([id, layer]) => ({ id, ranges: layer.ranges }));
  const anchorLocalsOf = firstFrame => new Set(anchors.filter(n => n >= firstFrame).map(n => n - firstFrame));
  const onlyAnchors = [...atDone].every(([id, layer]) => {
    const firstFrame = id.startsWith('clip-huge') ? 29 : 0;
    const allowed = anchorLocalsOf(firstFrame);
    return layer.ranges.every(([from, to]) => { for (let n = from; n <= to; n++) if (!allowed.has(n)) return false; return true; });
  });
  check(atDone.size > 0, '② done 的时候已经有层了', out.layersAtDone);
  check(onlyAnchors, '② done 的时候每一层只有锚帧 —— 锚帧先于其他帧就绪', out.layersAtDone);

  /* ---- ④ C4 冷缓存:回到区间起点 ---- */
  const coldStateful = atDone.get('clip-stateful/html');
  if (coldStateful) {
    const target = 45;                       // 全局第 45 帧,落在 clip-huge 挂载(29)切出的那一段
    const segment = segmentStartOf(anchors, target);
    const picked = pickSnapshotFrame({ ranges: coldStateful.ranges, localFrame: target, segmentStart: segment });
    out.coldPick = { target, segment, picked, ranges: coldStateful.ranges };
    check(segment === 29, '④ 第 45 帧所在区间的起点是 clip-huge 的挂载帧', out.coldPick);
    check(picked === segment, '④ 冷缓存下 C4 选到区间起点,而不是第 0 帧、也不是空', out.coldPick);
  } else check(false, '④ 冷缓存时 clip-stateful 的 html 层应当已经有锚帧了', out.layersAtDone);

  /* ---- ⑧ wanted:批被提前 ---- */
  // 播放头报「clip-stateful 现在缺第 52 帧」;预渲染在 4 帧批边界读到之后该跳过去
  await postJson(EDITOR + '/api/data/playhead', { session: SESSION, t: 45 / FPS, playing: true, wanted: [{ clipId: 'clip-stateful', frame: 52 }] });
  const promotion = await until('wanted 让某一批插队', async () => {
    const d = await json(`${base}/api/frames/diagnostics`);
    return d.body?.promotions?.find(p => p.clipId === 'clip-stateful') || null;
  }, 300000, 500);
  out.promotion = promotion;
  check(!!promotion, '⑧ wanted 发出后对应片段的批被提前(诊断里有这条记录)');
  check(!promotion || promotion.start === 52 - (52 % 4), '⑧ 提前的正是含第 52 帧的那一批', promotion);

  /* ---- ② 区间随生产增长 ---- */
  const grew = await until('某一层的区间长过锚帧', () => {
    const table = indexOf(ready.messages);
    const layer = table.get('clip-stateful/html');
    return layer && layer.ranges.some(([from, to]) => to - from >= 3) ? layer : null;
  }, 300000, 500);
  out.grown = grew;
  check(!!grew, '② layer 的区间随生产增长(每次全量,不是增量)');
  check(ready.messages.filter(m => m.type === 'layer').length > 1, '② 收到了多条 layer');

  /* ---- ⑥ unknown 卡进 local 表 ---- */
  const table = indexOf(ready.messages);
  out.kinds = [...table.keys()].sort();
  check(table.has('clip-unknown/local'), '⑥ unknown 卡出现在 local 表里', out.kinds);
  check(!table.has('clip-unknown/html'), '⑥ unknown 卡不上云(不在 html 表里)', out.kinds);
  check(table.has('clip-stateful/html'), '⑥ 审阅表 independent 的 stateful 卡走共享档', out.kinds);
  check(table.has('clip-canvas/html'), '⑥ canvas 卡同样按审阅表走共享档', out.kinds);

  /* ---- ③ HttpSnapshotSource 取到的和磁盘逐字节相同 ---- */
  const statefulLayer = table.get('clip-stateful/html');
  if (statefulLayer) {
    const localFrame = statefulLayer.ranges[0][0];
    const overHttp = await fetch(`${base}/api/frames/snapshot/html/${statefulLayer.key}/${localFrame}`);
    const httpText = await overHttp.text();
    const file = path.join(LIBRARY, 'controls-html', statefulLayer.key, `${localFrame}.html`);
    const onDisk = await fs.readFile(file, 'utf8').catch(() => null);
    out.snapshot = { status: overHttp.status, bytes: httpText.length, file, sameBytes: onDisk !== null && onDisk === httpText };
    check(overHttp.ok, '③ GET /api/frames/snapshot/... 取得到', out.snapshot);
    check(out.snapshot.sameBytes, '③ 取到的 HTML 与磁盘上的逐字节相同', { ...out.snapshot, diskBytes: onDisk?.length ?? null });
    check((overHttp.headers.get('cache-control') || '').includes('immutable'), '③ 内容寻址的键回 immutable', overHttp.headers.get('cache-control'));
  } else check(false, '③ 没有 clip-stateful 的 html 层,没法比对字节');

  /* ---- ⑤ 超限帧落盘但不进索引 ---- */
  const diagnostics = await json(`${base}/api/frames/diagnostics`);
  const oversize = (diagnostics.body?.oversize || []).filter(item => item.clipId === 'clip-huge');
  out.oversize = oversize.slice(0, 3);
  check(oversize.length > 0, '⑤ 超限帧记了诊断(卡 id、字节数)', diagnostics.body?.oversize?.slice(0, 3));
  if (oversize.length) {
    check(oversize[0].bytes > oversize[0].limit && oversize[0].limit === 300 * 1024, '⑤ DOM 卡的上限是 300 KB', oversize[0]);
    const onDisk = await fs.stat(path.join(LIBRARY, 'controls-html', oversize[0].key, `${oversize[0].localFrame}.html`)).then(s => s.size, () => 0);
    check(onDisk > 300 * 1024, '⑤ 超限帧照常落盘(下一次不用重渲)', { onDisk });
    const hugeLayer = indexOf(ready.messages).get('clip-huge/html');
    const indexed = hugeLayer ? hugeLayer.ranges.some(([from, to]) => oversize[0].localFrame >= from && oversize[0].localFrame <= to) : false;
    out.hugeLayer = hugeLayer ?? null;
    check(!indexed, '⑤ 超限帧不进就绪索引', { hugeLayer, frame: oversize[0].localFrame });
  }

  /* ---- ⑩ M4:环境指纹进结果键(契约 E.7「探针」) ---- */
  {
    const d = diagnostics.body || {};
    const fingerprint = d.environment?.fingerprint;
    out.environment = d.environment ?? null;
    check(typeof fingerprint === 'string' && /^[0-9a-f]{16}$/.test(fingerprint), '⑩ diagnostics.environment.fingerprint 是 16 位十六进制', out.environment);
    const keyed = (d.plans || []).flatMap(p => (p.controls || []).filter(c => c.snapshotKey));
    const bad = keyed.filter(c => !(typeof c.contentKey === 'string' && c.envFingerprint === fingerprint && c.snapshotKey === resultKeyOf(c.contentKey, c.envFingerprint)))
      .map(c => ({ clipId: c.clipId, snapshotKey: c.snapshotKey, contentKey: c.contentKey, envFingerprint: c.envFingerprint }));
    check(keyed.length > 0, '⑩ 诊断里有带 snapshotKey 的 control', d.plans);
    check(bad.length === 0, '⑩ plans[].controls[] 的 snapshotKey === resultKeyOf(contentKey, envFingerprint),且 envFingerprint 就是本进程的指纹', bad);
  }

  /* ---- ⑦ F5:杀掉预渲染进程再起来 ---- */
  const beforeKill = indexOf(ready.messages);
  out.layersBeforeKill = beforeKill.size;
  await ready.close();
  const oldBase = base;
  const pid = await (async () => {
    // 预渲染进程是编辑器进程拉起来的,所以是我们自己起的那一棵。按端口找它的 PID。
    const port = new URL(oldBase).port;
    const { execSync } = await import('node:child_process');
    try {
      const text = execSync(process.platform === 'win32' ? `netstat -ano -p tcp` : `lsof -ti tcp:${port}`, { encoding: 'utf8' });
      if (process.platform !== 'win32') return Number(text.trim().split(/\s+/)[0]);
      const line = text.split(/\r?\n/).find(l => l.includes(`127.0.0.1:${port}`) && l.includes('LISTENING'));
      return line ? Number(line.trim().split(/\s+/).pop()) : null;
    } catch { return null; }
  })();
  out.prerenderPid = pid;
  if (check(!!pid, '⑦ 找得到预渲染进程的 PID(它是编辑器进程拉起来的)')) {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
    // 崩完等编辑器把它拉起来(vite-plugin-prerender 的 MAX_RESTARTS 路)
    const fresh = await until('预渲染进程自动拉起来', async () => {
      const next = await prerenderUrl();
      return next && next !== oldBase ? next : null;
    }, 180000, 500);
    out.prerenderAfterRestart = fresh;
    if (fresh) {
      const after = openReady(fresh);
      await until('重启后的 SSE 收到第一条', () => after.messages.length > 0 || null, 30000);
      out.afterRestartFirst = after.messages[0];
      check(after.messages[0]?.type === 'reset', '⑦ 重连先收到 reset', after.messages[0]);
      /*
       * **服务端自己恢复**(Item 4 方案 A):探针这里不发 preload,页面也不会发(它早就就绪了)。
       * 编辑器进程拉起预渲染进程、补推镜像之后,照「会话版本登记」把这个会话的 preload 重放一遍 ——
       * 会话的版本回来(reset 带 localRev 1)、card plan 重算出来,层才按键重建。
       */
      const rebuilt = await until('索引按键重建、重新发出 layer(没有人发 preload)', () => {
        const t = indexOf(after.messages);
        return t.size >= beforeKill.size ? t : null;
      }, 300000, 500);
      out.layersAfterRebuild = rebuilt ? [...rebuilt.keys()].sort() : null;
      check(!!rebuilt, '⑦ 没人发 preload,服务端重放之后索引按键重建、层数不少于崩之前', { before: [...beforeKill.keys()].sort(), after: out.layersAfterRebuild });
      if (rebuilt) {
        // 项目到位之前不发 layer:第一条 layer 一定在「会话版本回来」的那条 reset(localRev 1)之后
        const resetIndex = after.messages.findIndex(m => m.type === 'reset' && m.localRev === 1);
        const firstLayer = after.messages.findIndex(m => m.type === 'layer');
        out.recoveryReset = resetIndex;
        check(resetIndex >= 0 && resetIndex < firstLayer, '⑦ 会话版本先回来(reset 带 localRev 1),再发全量 layer', { resetIndex, firstLayer });
        // 区间和崩之前一致(扫盘是按 index.json 重建的,不是从头再产)
        const same = [...beforeKill].every(([id, layer]) => JSON.stringify(rebuilt.get(id)?.ranges ?? null) !== 'null');
        check(same, '⑦ 崩之前有的层,重建之后都在', { before: [...beforeKill.keys()].sort(), after: out.layersAfterRebuild });
      }
      await after.close();
    }
  }
  /* ---- ⑨ pinned 渲染 9:在所有位置都判轻的卡不产快照、不进就绪索引 ---- */
  // ⑦ 重启过一次,预渲染进程换了端口 —— 这里重新取一次地址
  const base9 = (await until('⑨ 预渲染进程地址', prerenderUrl, 60000)) || base;
  out.prerender9 = base9;
  // 第一阶段一条成本记录都没有 → `prerenderSetOfPlan` 按声明兜底,四张 stateful 卡都在集合里。
  const diag0 = await json(`${base9}/api/frames/diagnostics`);
  const plan0 = (diag0.body?.plans || []).find(p => (p.controls || []).some(c => c.clipId === 'clip-stateful'));
  out.planBefore = plan0 ? { key: plan0.key, prerenderSet: plan0.prerenderSet } : null;
  check(!!plan0?.prerenderSet, '⑨ 诊断露出预渲染集合', diag0.body?.plans);
  check(!!plan0?.prerenderSet?.includes('clip-stateful'), '⑨ 没有成本记录时按声明兜底:stateful 卡都在集合里', out.planBefore);
  const statefulControl = (plan0?.controls || []).find(c => c.clipId === 'clip-stateful');
  const statefulKey = statefulControl?.snapshotKey;
  const statefulDir = statefulKey ? path.join(LIBRARY, 'controls-html', statefulKey) : null;
  check(!!statefulDir && fsSync.existsSync(statefulDir), '⑨ 判重时 clip-stateful 确实产了快照目录', statefulDir);

  // 给 clip-stateful 写一条「便宜的随机访问卡」记录 → 每个位置都判轻;其余三张钉死为重,
  // 这样成本记录非空(不走声明兜底),而集合里只少了 clip-stateful 这一张。
  const records = [];
  for (const control of plan0?.controls || []) {
    if (!control.costKey) continue;
    records.push(control.clipId === 'clip-stateful'
      ? { identityKey: control.costKey, device: PROBE_DEVICE, mode: 'dev', kind: 'random',
          stepMs: 0.1, seekOk: true, seekMs: 0.1, catchUpMs: 0.1, capped: false, demoted: false, pinnedHeavy: false, measuredAt: Date.now() }
      : { identityKey: control.costKey, device: PROBE_DEVICE, mode: 'dev', kind: 'stateful',
          stepMs: 1, seekOk: false, seekMs: null, catchUpMs: 1, capped: true, demoted: false, pinnedHeavy: false, measuredAt: Date.now() });
  }
  const putCosts = await json(EDITOR + '/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records }) });
  out.costs = { put: putCosts.body, count: records.length };
  check(putCosts.ok && records.length >= 2, '⑨ 成本记录写进去了', out.costs);
  await until('预渲染进程读得到这几条成本记录', async () => {
    const got = await json(`${base9}/api/data/costs?device=${PROBE_DEVICE}`);
    return (got.body?.costs || []).length >= records.length || null;
  }, 60000);

  /*
   * 再推一版项目、再开一趟预渲染。`frameIdentity` **不看 `id` / `name`**,所以
   * `entry.key` 和第一版是同一个(卡和片段一字没动)。后台代次按页面会话分(Item 4:owner =
   * `session:<id>`),所以换一个会话来发 preload —— 不会走「同一个 entry 直接返回」那条早退,
   * 而是对同一个 entry 重跑一趟:`adoptCardPlan` 按**新的 costs** 重算 `prerenderSet`,这正是要验的东西。
   * 就绪索引也按会话分:SSE 订阅的是这个新会话。
   */
  const SESSION_B = `${SESSION}-b`, SESSION_C = `${SESSION}-c`;
  const PROJECT_B = { ...PROJECT, id: `${PROJECT.id}-b`, name: 'R6 数据面探针(第二版)' };
  const readyB = openReady(base9, undefined, SESSION_B);
  await until('第二版的 SSE 连上', () => readyB.messages.length > 0 || null, 30000);
  const pushedB = await postJson(EDITOR + '/api/data/project', { session: SESSION_B, localRev: 1, project: PROJECT_B });
  check(pushedB.ok, '⑨ 第二版项目推进镜像', pushedB.body);
  await until('预渲染进程手里有第二版', async () => (await json(`${base9}/api/data/project?session=${SESSION_B}&localRev=1`)).ok || null, 30000);
  const preloadB = await postJson(`${base9}/api/frames/preload`, { session: SESSION_B, localRev: 1 });
  check(preloadB.ok, '⑨ 第二版开跑', preloadB.body);

  // 按「clip-stateful 这张卡没被挑中」找,不按 entry.key 找(它和第一版是同一个)
  const planB = await until('按新 costs 重算出的预渲染集合', async () => {
    const d = await json(`${base9}/api/frames/diagnostics`);
    out.plansSeen = (d.body?.plans || []).map(p => ({ key: p.key, set: p.prerenderSet }));
    return (d.body?.plans || []).find(p => Array.isArray(p.prerenderSet)
      && (p.controls || []).some(c => c.clipId === 'clip-stateful' && c.picked === false)) || null;
  }, 180000, 500);
  out.planAfter = planB ? { key: planB.key, prerenderSet: planB.prerenderSet,
    picked: (planB.controls || []).map(c => [c.clipId, c.picked]) } : null;
  check(!!planB, '⑨ 按新 costs 重算出了预渲染集合', out.plansSeen);
  check(!!planB && !planB.prerenderSet.includes('clip-stateful'), '⑨ 判轻的卡不在预渲染集合里', out.planAfter);
  check(!!planB && planB.prerenderSet.includes('clip-canvas'), '⑨ 判重的卡还在集合里', out.planAfter);

  // 等第二版真的产起来(判重的那张卡长出了层),再看判轻的那张有没有动静
  await until('第二版里判重的卡开始就绪', () => indexOf(readyB.messages).has('clip-canvas/html') || null, 300000, 500);
  const tableB = indexOf(readyB.messages);
  out.layersB = [...tableB.keys()].sort();
  check(!tableB.has('clip-stateful/html'), '⑨ 判轻的卡不进就绪索引', out.layersB);

  /*
   * 「不产快照」:**重算之后**才删那棵目录 —— 第一版那一趟后台预渲染可能还在飞,
   * 早删会被它写回来(那一趟拿的还是旧的 `prerenderSet`)。删完再等 `clip-canvas`
   * 的区间继续长(证明这一趟确实还在产东西),那时判轻的那张仍然没有目录才算数。
   * 第三版同样换一个会话触发重跑;它和第二版是同一个 entry,所以这一趟发的层照样进第二版会话的 SSE。
   */
  if (statefulDir) await fs.rm(statefulDir, { recursive: true, force: true });
  const msgsBefore = readyB.messages.length;
  const PROJECT_C = { ...PROJECT, id: `${PROJECT.id}-c`, name: 'R6 数据面探针(第三版)' };
  await postJson(EDITOR + '/api/data/project', { session: SESSION_C, localRev: 1, project: PROJECT_C });
  await until('预渲染进程手里有第三版', async () => (await json(`${base9}/api/data/project?session=${SESSION_C}&localRev=1`)).ok || null, 30000);
  await postJson(`${base9}/api/frames/preload`, { session: SESSION_C, localRev: 1 });
  const rescanned = await until('删掉之后又跑了一趟(索引重新发了层)',
    () => readyB.messages.length > msgsBefore || null, 120000, 300);
  await delay(3000);
  out.statefulDirBack = statefulDir ? fsSync.existsSync(statefulDir) : null;
  out.canvasDir = fsSync.existsSync(path.join(LIBRARY, 'controls-html',
    (planB?.controls || []).find(c => c.clipId === 'clip-canvas')?.snapshotKey || 'none'));
  check(!!rescanned, '⑨ 删目录之后确实又跑了一趟预渲染');
  check(out.canvasDir === true, '⑨ 同一趟里判重的卡照样有快照目录', out.canvasDir);
  check(out.statefulDirBack === false, '⑨ 判轻的卡不产快照(目录删掉之后没长回来)', { statefulDir });
  await readyB.close();

} catch (error) {
  fails.push('exception: ' + (error?.stack || error));
} finally {
  stopEditor();
  if (KEEP) out.kept = EXPORT_DIR;
  else { await delay(500); await fs.rm(EXPORT_DIR, { recursive: true, force: true }).catch(() => {}); }
}

out.fails = fails;
console.log(JSON.stringify(out, null, 2));
process.exit(fails.length ? 1 : 0);
