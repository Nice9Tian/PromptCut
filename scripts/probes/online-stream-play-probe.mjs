/**
 * 在线页面播放轨道流的端到端探针(`docs/plan/browser-stream-task.md` 第五、六、七处;`render-refactor-task.md`「甲一」的「播」这一半)。
 * 全程在本机:本机托管组合(文档服务 + 素材服务)、一条和预渲染进程同一份代码的预渲染管线(产流、推到素材服务、写层表)、
 * 一个在线页面打开同一个项目。
 *
 *   node scripts/probes/online-stream-play-probe.mjs [--base-port 7420] [--out <目录>] [--keep-temp] [--no-group]
 *
 * 端口(一段 10 个,`--base-port` 挪整段;别用 58xx,全量测试里有几个文件把那一带的端口写死了):+0 编辑器页的源、+1 / +2 两个舞台的源(三个都是探针自己的反代,带 OAC)、
 *   +3 文档服务、+4 素材服务、+5 在线模式的开发服务(页面,`vite --mode online`)、+6 桌面模式的开发服务(预渲染管线的 Chrome 开它的导出页;
 *   它自己另占 +7、+8 当舞台端口)。
 *
 * 为什么页面用在线模式的**开发服务**、不用在线构建:2026-10-07 起在线构建的首屏只有官网账号入口(`src/account/AccountProjects.tsx`),
 * 本机托管组合没有账号服务,页面进不了项目(`c10-browser-probe`、`m7-browser-probe`、`online-stale-layer-probe` 在这一步都过不去,见
 * `docs/reports/AGENT-rr-a1-play.md`「开工前的对照」)。开发服务认 `?editor` 直接进编辑器(`src/Shell.tsx`),探针在页面里引
 * `syncManager.ts` 的 `enterShared`,凭项目口令进同一个共享项目 —— 连接、同步、素材票据、内容库都是真的,只是没经过首屏那张表单。
 * 开发服务没有舞台入口 `stage.html`(落到 index.html),舞台的隔离自检不过、走「票据经 RPC」的旧办法;流的字节怎么到舞台与这无关
 * (隔离与否都是父页推过去,见 `src/render/streamPlayer.ts`)。
 *
 * 预渲染那一头:本进程里起 `FramePipeline`(`interactive: true`,和桌面预渲染进程同一份代码),配上真的推送队列、
 * 经文档服务连接取票据的素材客户端与内容库客户端。`preload(项目)` 之后它自己产快照与轨道流、按段推到素材服务、
 * 把段清单与层表(带 `streams` 表)写进内容库 —— 这是桌面预渲染进程「自己产、自己推」的那条路。
 * **没走的路**:经任务队列切分出的流任务(在线页面发的清单计划眼下不切流,`server/render-node/local-node.mjs` 的 `listPlanOverrides`,
 * 那是「产」这一半要改的地方);切分候选的收集由单测盖(`server/test/layer-map-streams.test.mjs`)。
 *
 * 摆法(一个共享项目,1920×1080、30 fps、6 秒):两张内置重卡 `probe-slow-stepped`(每帧烧 40 ms,在线页面判重;画面是一块随时间平移的橙块)
 *   a  框在左上,0 ～ 5 秒
 *   b  框在右下,0.5 ～ 5 秒(入点不在分段边界上)
 *
 * 断言:
 *   S1 层表:内容库里的层表带 `streams` 表,两张卡各一条单卡流,候选的结果键查得到流清单。
 *   S2 就绪索引:页面的在线来源认出两条流,播放头挪到片段上之后有就绪的分段;字节只由编辑器页去素材服务取(`px/<哈希>`),两个舞台的源一次都不取。
 *   S3 流在画:播放时两张卡的包裹层被抑制,舞台的流播放器给两条流各建了一条轨道(字节是父页推来的)、在出帧(`drawn` 在涨、`lastDrawn` 跟着播放头);
 *      垫在下面的快照是海报(播 N 帧只换了约 N/15 次,不是每拍换)。
 *   S4 像素:播放中截可见舞台(同时读流播放器正画着第几帧),暂停后把播放头放到那一帧、等追到精确活渲再截;两张图的差在编码误差以内,
 *      与往后 2 秒的精确活渲相比明显更大(对照)。
 *   S5 缺块:素材服务对 a 的第 4 段回 404。播到那一段时 a 没有流画面、露出快照(有内容、可见、没有占位符、仍被抑制),b 照常是流;
 *      那一刻的截图与同一时刻的精确活渲相符(不透明);过了那一段 a 的流接上。
 *   S6 组流(`--no-group` 跳过):把解码器预算压到 1 再起一条管线,两张卡并成一条组流;层表换成一行组流,页面的就绪消息带成员,
 *      播放时舞台根下的组流画布在出帧、两张卡都被抑制;像素同 S4 那样比。
 *   S7 页面没有错误。
 * 不打印口令与票据。输出:过程写 stderr;stdout 最后一行是一行 JSON `{ ok, fails, … }`;截图在 `--out`。有失败退出码 1。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { seedSharedProject } from './lib-seed.mjs';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';
import { renderProject } from '../../server/render-project.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { createPushQueue } from '../../server/artifact-push.mjs';
import { createDocEndpoint } from '../../server/render-node/session-link.mjs';
import { createContentClient } from '../../server/render-node/content-client.mjs';
import { createTicketSource } from '../../server/auth/ticket-source.mjs';
import { createAssetClient } from '../../server/asset-store/client.mjs';
import { SEGMENT_FRAMES } from '../../server/frame-stream.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(name);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN = Date.now().toString(36) + randomBytes(3).toString('hex');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'online-stream-play-probe', RUN)));
const TMP = path.join(OUT, 'tmp');
const BASE = Number(arg('--base-port', 7420));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4, page: BASE + 5, desk: BASE + 6 };
const SITE = `http://127.0.0.1:${PORTS.editor}`;
const STAGE_ORIGINS = [`http://127.0.0.1:${PORTS.stageA}`, `http://127.0.0.1:${PORTS.stageB}`];
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
const ASSET_DIRECT = `http://127.0.0.1:${PORTS.asset}/api/asset`;
const DESK = `http://127.0.0.1:${PORTS.desk}`;
const FPS = 30;
fs.mkdirSync(TMP, { recursive: true });

const fails = [];
const out = { ok: false, run: RUN, out: OUT, ports: PORTS };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 700))); return !!cond; };
const say = (step, fields = {}) => console.error(JSON.stringify({ t: new Date().toISOString(), step, ...fields }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30_000, every = 150) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { v = null; last = String(e?.message ?? e); }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}${last ? ` (${last.slice(0, 160)})` : ''}`); return null; }
    await sleep(every);
  }
}

/* ------------------------------------------------------------------ 进程 */
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ } }
}
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
function pidOnPort(port) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  for (const line of String(r.stdout).split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return null;
}
const children = [];
/** 起一台 vite 开发服务;`mode` 给了就是 `--mode <mode>`。数据目录都放探针自己的临时目录,不连任何文档服务、不推送 */
async function startVite(label, port, mode) {
  const dir = path.join(TMP, label);
  const tmp = path.join(dir, 'tmp');
  for (const d of [tmp, path.join(dir, 'data'), path.join(dir, 'card-overrides'), path.join(dir, 'projects'), path.join(dir, 'work')]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env };
  for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_NODE_PROFILE', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_TEST_CODE_VERSION',
    'PROMPTCUT_HEADLESS', 'PROMPTCUT_ROLE', 'PROMPTCUT_ASSET_URL', 'PROMPTCUT_CARD_SYNC', 'PROMPTCUT_LAN_HOST', 'VITE_PC_ONLINE', 'PROMPTCUT_TEST_ENV_FINGERPRINT', 'PROMPTCUT_STREAM_DECODERS']) delete env[key];
  Object.assign(env, {
    PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_CARD_OVERRIDES: path.join(dir, 'card-overrides'),
    PROMPTCUT_PROJECTS_DIR: path.join(dir, 'projects'), PROMPTCUT_WORK_DIR: path.join(dir, 'work'), PROMPTCUT_STREAMS: '0', PROMPTCUT_PUSH: '0', TEMP: tmp, TMP: tmp, TMPDIR: tmp,
  });
  const args = [viteBin(), ...(mode ? ['--mode', mode] : []), '--port', String(port), '--strictPort', '--host', '127.0.0.1'];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  const log = [];
  const keep = (c) => { for (const line of c.toString().split(/\r?\n/)) { if (line) { log.push(line); if (log.length > 400) log.shift(); } } };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const rec = { label, child, port, origin: `http://127.0.0.1:${port}`, log, base: mode === 'online' ? '/editor/' : '/' };
  children.push(rec);
  const up = await until(`${label} 开发服务起来`, async () => {
    if (child.exitCode !== null) throw new Error(`exited ${child.exitCode}: ${log.slice(-4).join(' | ')}`);
    return fetch(`${rec.origin}${rec.base}`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 240_000, 500);
  if (!up) throw new Error(`${label} 没起来:${log.slice(-6).join(' | ').slice(0, 500)}`);
  say('vite.up', { label, origin: rec.origin, pid: child.pid });
  return rec;
}
async function stopChildren() {
  for (const rec of children) {
    // 桌面模式的开发服务会带起一个预渲染进程:按它报的端口找到进程一并收掉(都是这支探针起的)
    let prePort = null;
    if (rec.base === '/') {
      try { const info = await fetch(`${rec.origin}/api/prerender/info`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()); prePort = info?.url ? Number(new URL(info.url).port) : null; } catch { prePort = null; }
    }
    killTree(rec.child.pid);
    if (prePort) { const pid = pidOnPort(prePort); if (pid) killTree(pid); }
    for (const p of rec.base === '/' ? [rec.port, rec.port + 1, rec.port + 2] : [rec.port]) { const pid = pidOnPort(p); if (pid) killTree(pid); }
  }
}

/* ------------------------------------------------------------------ 反代:三个源,仿托管端的路由 */
const OAC = { 'origin-agent-cluster': '?1' };
const runtimeConfig = JSON.stringify({ v: 1, stageOrigins: STAGE_ORIGINS });
/** 素材服务上「没有」的块(缺块那一段用):哈希在这里的 `px/` 请求回 404 */
const blocked = new Set();
/** `px/<哈希>` 的请求记录 `{ at, hash, port, status }` */
const pxLog = [];
const servers = [];
function makeProxy(port) {
  const origin = `http://127.0.0.1:${port}`;
  const forward = (req, res, upstream, strip, note) => {
    const target = strip ? req.url.slice(strip.length) || '/' : req.url;
    const headers = { ...req.headers, host: `127.0.0.1:${upstream}` };
    const up = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: target.startsWith('/') ? target : `/${target}`, headers }, (r) => {
      note?.(r.statusCode ?? 0);
      res.writeHead(r.statusCode ?? 502, { ...r.headers, ...OAC });
      r.pipe(res);
    });
    up.on('error', () => { try { res.writeHead(502, OAC); res.end('bad gateway'); } catch { /* 已经回了 */ } });
    req.pipe(up);
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    if (url.pathname === '/hosted' || url.pathname.startsWith('/hosted/')) return forward(req, res, PORTS.doc, '/hosted');
    const m = /^\/media\/api\/asset\/px\/([0-9a-f]{64})$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const rec = { at: Date.now(), hash: m[1], port, status: 0 };
      pxLog.push(rec);
      if (blocked.has(m[1])) { rec.status = 404; res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...OAC }); return res.end('{"error":"not-found"}'); }
      return forward(req, res, PORTS.asset, '/media', (status) => { rec.status = status; });
    }
    if (url.pathname.startsWith('/media/')) return forward(req, res, PORTS.asset, '/media');
    if (url.pathname === '/editor/runtime-config.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...OAC });
      return res.end(runtimeConfig);
    }
    return forward(req, res, PORTS.page, '');
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, origin);
    const hosted = url.pathname === '/hosted' || url.pathname.startsWith('/hosted/');
    const target = hosted ? (url.pathname.slice('/hosted'.length) || '/') + url.search : req.url;
    const upstream = hosted ? PORTS.doc : PORTS.page;
    const up = net.connect(upstream, '127.0.0.1', () => {
      const lines = [`${req.method} ${target} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${/^host$/i.test(req.rawHeaders[i]) && !hosted ? `127.0.0.1:${upstream}` : req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  servers.push(server);
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
}

/* ------------------------------------------------------------------ 页面 */
let browser = null;
const pageErrors = [];
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
const stageFrames = (page) => page.frames().filter((f) => /[?&]stage=1/.test(f.url()));
async function visibleStage(page) {
  for (const f of stageFrames(page)) {
    const el = await f.frameElement().catch(() => null);
    const vis = el ? await el.evaluate((e) => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5 && e.getBoundingClientRect().width > 10; }).catch(() => false) : false;
    if (vis) return f;
  }
  return stageFrames(page)[0] ?? null;
}
/** 可见舞台此刻的样子:每张卡的包裹层(抑制、快照平面、占位符),流播放器的各条轨道,舞台的时刻 */
async function stageState(page, ids) {
  const f = await visibleStage(page);
  if (!f) return null;
  return f.evaluate((ids2) => {
    const diag = window.__pcStageDiag?.() ?? null;
    const tracks = (diag?.streams?.tracks ?? []).map((t) => ({ id: t.id, clips: String(t.id).split('#')[0].split(','), pushed: !!t.pushed, drawn: t.drawn, lastDrawn: t.lastDrawn, decoder: t.decoder,
      manifest: t.manifest, blanks: t.blanks, holds: t.holds, errors: t.errors, lastError: t.lastError || null, segments: t.segments }));
    const clips = {};
    for (const id of ids2) {
      const w = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
      if (!w) { clips[id] = { wrapper: false }; continue; }
      const snap = w.querySelector(':scope > [data-pc-snapshot-plane]');
      const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
      const canvas = w.querySelector(':scope > canvas[data-pc-stream-plane]');
      clips[id] = {
        wrapper: true, suppressed: w.classList.contains('pc-suppressed'),
        snapshot: !!snap && snap.childElementCount > 0, snapshotHidden: !!snap && getComputedStyle(snap).visibility === 'hidden',
        placeholder: !!slot && !slot.hidden, streamCanvas: !!canvas,
        stream: tracks.find((t) => t.clips.includes(id)) ?? null,
      };
    }
    const group = document.querySelector('canvas[data-pc-group-plane]');
    return { role: diag?.role ?? null, t: diag?.t ?? null, playing: diag?.beatRunning ?? null, pushed: diag?.streams?.pushed ?? null, clips, tracks,
      groupCanvas: group ? { group: group.getAttribute('data-pc-stream-group'), w: group.width, h: group.height } : null, origin: location.origin };
  }, ids).catch(() => null);
}
/**
 * 截可见舞台(按舞台 iframe 的框裁);回 `{ file, png }`。页面的设备像素比设成 2(见开页面那里),截图不再另外放大:
 * 用截图的 `scale` 放大时,活渲的那一层(合成层按原来的比例栅格化)会比流的画布、快照平面糊一圈,两边的边缘就比不到一起。
 */
async function stageShot(page, name) {
  const f = await visibleStage(page);
  const el = f ? await f.frameElement().catch(() => null) : null;
  const box = el ? await el.boundingBox().catch(() => null) : null;
  if (!box || box.width < 10) return null;
  const file = path.join(OUT, `${name}.png`);
  const buf = await page.screenshot({ path: file, clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.floor(box.width), height: Math.floor(box.height) } });
  return { file, png: PNG.sync.read(Buffer.from(buf)) };
}
/** 两张图的差:平均绝对差(每通道,0～255)、差得多的像素占比(任一通道差 > 48) */
function diffOf(a, b) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  let sum = 0, bad = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4;
      const d0 = Math.abs(a.data[i] - b.data[j]), d1 = Math.abs(a.data[i + 1] - b.data[j + 1]), d2 = Math.abs(a.data[i + 2] - b.data[j + 2]);
      sum += d0 + d1 + d2;
      if (d0 > 48 || d1 > 48 || d2 > 48) bad++;
    }
  }
  return { mad: +(sum / (w * h * 3)).toFixed(3), bad: +(bad / (w * h)).toFixed(5), w, h };
}
/** 画面里橙块的像素占比(探针卡的块是 #f97316):用来确认「这一层不是透明的」 */
function orangeOf(png) {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) if (png.data[i] > 200 && png.data[i + 1] > 80 && png.data[i + 1] < 160 && png.data[i + 2] < 90) n++;
  return +(n / (png.width * png.height)).toFixed(5);
}
const onlineDiag = (page) => page.evaluate(() => window.__pcOnlineSnapshots?.() ?? null).catch(() => null);
const playFrom = (page, t) => store(page, `S.actions.pause(); S.actions.seek(args[0]); S.actions.play(); return true;`, t);
const pauseAt = (page, t) => store(page, `S.actions.pause(); S.actions.seek(args[0]); return true;`, t);
const pageT = (page) => store(page, `const s = S.getState(); return { t: s.t, playing: !!s.playing };`).catch(() => null);

/** 暂停在 `sec`、等两张卡追到精确活渲(不抑制、没有快照、没有占位符、流平面撤了),截一张 */
async function liveShot(page, ids, sec, name) {
  // 先停下、等舞台报完最后一拍,再放播放头:刚从播放停下的那一下,舞台回报的时刻会盖掉同一刻发的 seek
  await store(page, `S.actions.pause(); return true;`);
  await sleep(500);
  let ok = null, last = null;
  for (let round = 0; round < 5 && !ok; round++) {
    await pauseAt(page, sec);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !ok) {
      const s = await stageState(page, ids);
      last = s ? { t: s.t, tracks: s.tracks.length, clips: Object.fromEntries(ids.map((id) => [id, s.clips[id] ? { suppressed: s.clips[id].suppressed, snapshot: s.clips[id].snapshot, placeholder: s.clips[id].placeholder } : null])) } : null;
      if (s && Math.abs((s.t ?? -1) - sec) <= 0.5 / FPS && !s.tracks.length
        && ids.every((id) => s.clips[id]?.wrapper && !s.clips[id].suppressed && !s.clips[id].snapshot && !s.clips[id].placeholder)) ok = s;
      else await sleep(100);
    }
  }
  if (!ok) { fails.push(`等不到:暂停在 ${sec.toFixed(3)} 秒后追到精确活渲 :: ${JSON.stringify(last).slice(0, 400)}`); return null; }
  await sleep(250);
  return stageShot(page, name);
}

/**
 * 播放中截一张、同时记下流播放器正画着第几帧(截图前后各读一次,差得不多才算数),再与那一帧的精确活渲、往后 2 秒的精确活渲比。
 * `streamOf(state)` 回这一刻该在画的那些流轨道(都在画才截)。
 */
async function comparePixels(page, ids, { from, name, streamOf, until: untilSec = from + 1.2 }) {
  const res = { name, tries: 0 };
  let shot = null, frame = null;
  for (let round = 0; round < 6 && !shot; round++) {
    await playFrom(page, from);
    const t0 = Date.now();
    while (Date.now() - t0 < 12_000 && !shot) {
      const before = await stageState(page, ids);
      const tb = streamOf(before);
      if (!tb || (before.t ?? 0) < from + 0.25) { await sleep(40); continue; }
      if ((before.t ?? 0) > untilSec) break;
      res.tries++;
      const s = await stageShot(page, `${name}-stream`);
      const after = await stageState(page, ids);
      const ta = streamOf(after);
      if (!s || !ta) continue;
      const f0 = Math.min(...tb.map((t) => t.lastDrawn)), f1 = Math.max(...ta.map((t) => t.lastDrawn));
      // 截图那一下落在 f0～f1 之间:只收相差不超过 3 帧的(探针卡 3 帧只挪 1 像素,不影响结论)
      if (f1 - f0 <= 3) { shot = s; frame = Math.round((f0 + f1) / 2); res.f0 = f0; res.f1 = f1; res.during = { before: before.clips, after: after.clips }; }
    }
  }
  if (!check(!!shot, `${name}:播放中截到流在画的一帧`, res)) { await pauseAt(page, from); return res; }
  res.frame = frame;
  const same = await liveShot(page, ids, frame / FPS, `${name}-live-same`);
  const farFrame = frame + 2 * FPS;
  const far = await liveShot(page, ids, farFrame / FPS, `${name}-live-far`);
  if (!check(!!same && !!far, `${name}:截到精确活渲的两张参照`, { same: !!same, far: !!far })) return res;
  res.same = diffOf(shot.png, same.png);
  res.far = diffOf(shot.png, far.png);
  res.liveVsFar = diffOf(same.png, far.png);
  res.orange = { stream: orangeOf(shot.png), live: orangeOf(same.png) };
  // 编码误差:预乘色 H.264(上下拼合)解回来,平坦处差 1～5,边缘上个别像素差得多;探针卡是纯色块,差得多的像素只在块的边上
  check(res.same.mad <= 1.5 && res.same.bad <= 0.002, `${name}:流的画面与同一帧的精确活渲相符(平均差 ≤ 1.5、差得多的像素 ≤ 0.2%)`, res.same);
  check(res.far.bad >= 0.004 && res.far.bad >= res.same.bad * 4 + 0.002, `${name}:与往后 2 秒的精确活渲比,差明显更大(对照)`, { same: res.same, far: res.far });
  check(res.orange.stream > 0.02 && Math.abs(res.orange.stream - res.orange.live) <= 0.004, `${name}:流的画面里两块橙块都在(不透明)`, res.orange);
  return res;
}

/* ------------------------------------------------------------------ 预渲染管线(产流、推送、写层表) */
const pipelines = [];
async function produce({ label, project, link, decoders }) {
  const root = path.join(TMP, 'library');   // 两轮共用一个库根:第二轮(组流)不重渲快照,只多产一条组流
  fs.mkdirSync(root, { recursive: true });
  if (decoders) process.env.PROMPTCUT_STREAM_DECODERS = String(decoders); else delete process.env.PROMPTCUT_STREAM_DECODERS;
  const pipeline = new FramePipeline({ root, origin: () => DESK, interactive: true, playhead: () => null, dataRoot: root });
  pipeline.streamProducer().attachRoute();
  const pushLog = [];
  const queue = createPushQueue({ pipeline, client: link.client, content: link.content, dir: path.join(TMP, `push-${label}`), gate: false,
    log: (event, fields) => { pushLog.push({ event, ...fields }); if (pushLog.length > 2000) pushLog.shift(); } });
  fs.mkdirSync(path.join(TMP, `push-${label}`), { recursive: true });
  queue.start();
  const rec = { label, pipeline, queue, pushLog };
  pipelines.push(rec);
  const t0 = Date.now();
  await pipeline.preload(project);
  const producer = await until(`${label}:轨道流生产者起来`, () => (pipeline._streams?.streams.size ? pipeline._streams : null), 180_000, 500);
  if (!producer) return rec;
  const done = await until(`${label}:全部分段满密度`, () => {
    const status = producer.status();
    if (!status.streams.length) return null;
    for (const s of status.streams) for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
    return !producer.workers.size && !producer.encoding.size ? status : null;
  }, 900_000, 1000);
  rec.streams = (done?.streams ?? []).map((s) => ({ streamKey: s.streamKey, contentKey: s.contentKey, kind: s.kind, clipIds: s.clipIds, firstSegment: s.firstSegment, lastSegment: s.lastSegment }));
  rec.encoder = done?.encoder ?? null;
  // 快照也要齐(流画不出来时露出的就是它,暂停时页面也贴它)
  const controls = () => [...pipeline.entries.values()].flatMap((e) => e.cardPlan ?? []).filter((c) => c.snapshotKey);
  await until(`${label}:快照齐`, async () => {
    const list = controls();
    if (!list.length) return null;
    for (const c of list) {
      const index = await pipeline.snapshots().snapshotIndex({ tier: 'shared', key: c.snapshotKey });
      if (index.count + (index.oversize ?? []).reduce((n, [a, b]) => n + b - a + 1, 0) < c.count) return null;
    }
    return true;
  }, 900_000, 1000);
  try { await pipeline.whenSmallSettled?.(); } catch { /* 小尺寸失败不挡 */ }
  // 推送队列里同一段最后一次进队之后才推;等它空
  await until(`${label}:推送队列推完`, () => { const st = queue.stats(); return st.pending === 0 && st.inflight === 0 ? st : null; }, 600_000, 500);
  await sleep(1200);   // 层表攒 300 ms 再写
  rec.ms = Date.now() - t0;
  rec.envFingerprint = pipeline.envFingerprint ?? null;
  rec.push = (({ pushed, failed, layerMaps, lastError }) => ({ pushed, failed, layerMaps, lastError }))(queue.stats());
  say('produce.done', { label, ms: rec.ms, streams: rec.streams, encoder: rec.encoder, push: rec.push });
  return rec;
}
async function stopPipeline(rec) {
  try { await rec.queue.stop(); } catch { /* 已停 */ }
  try { await rec.pipeline.close(); } catch { /* 已关 */ }
}

/* ================================================================== 开跑 */
let combo = null;
let link = null;
try {
  for (const p of [PORTS.editor, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset, PORTS.page, PORTS.desk, PORTS.desk + 1, PORTS.desk + 2]) {
    if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  }
  fs.mkdirSync(path.join(TMP, 'hosted'), { recursive: true });
  combo = await startHostedCombo({
    dataDir: path.join(TMP, 'hosted'), docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    docPublicUrl: `ws://127.0.0.1:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
  });
  await Promise.all([makeProxy(PORTS.editor), makeProxy(PORTS.stageA), makeProxy(PORTS.stageB)]);
  await Promise.all([startVite('page', PORTS.page, 'online'), startVite('desk', PORTS.desk, null)]);
  say('local.up', { site: SITE, stages: STAGE_ORIGINS });

  /* ---------------- 共享项目 ---------------- */
  const NAME = `osp-${RUN}`;
  const creator = { username: 'boss', password: `boss-${randomBytes(6).toString('hex')}` };
  const PROJECT_PW = `pw-${randomBytes(6).toString('hex')}`;
  const made = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });
  check((await seedSharedProject({ base: DOC_DIRECT, projectId: made.projectId, creator, name: NAME })).ok, '替创建者写进空项目');

  /* ---------------- 页面进项目、摆卡 ---------------- */
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000,
    args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--site-per-process'] });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 240)));
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 });
  await page.goto(`${SITE}/editor/?editor`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await until('编辑器起来(window.__pcStore)', () => page.evaluate(() => !!window.__pcStore), 240_000, 300);
  const entered = await page.evaluate(async (cand, cred) => {
    const sm = await import('/editor/src/editor/sync/syncManager.ts');
    const r = await sm.enterShared(cand, cred);
    return { ok: r?.ok === true, error: r?.ok ? null : (r?.error ?? 'unknown') };
  }, { where: 'hosted', base: `${SITE}/hosted/`, ws: `ws://127.0.0.1:${PORTS.editor}/hosted/`, projectId: made.projectId, name: NAME, mode: 'free' },
  { as: 'member', username: '成员甲', password: PROJECT_PW });
  if (!check(entered.ok, '页面凭项目口令进入共享项目(syncManager.enterShared)', entered)) throw new Error('页面进不了项目');
  await until('页面收到项目内容', () => store(page, `return S.getState().project.tracks.some((t) => t.id === 't-1');`), 30_000);
  const A = 'osp-a', B = 'osp-b';
  const IDS = [A, B];
  const setup = await store(page, `
    S.actions.editCardProject((p) => ({ ...p, duration: 6, tracks: [
      { id: 'osp-t-a', name: '序列 a', clips: [{ id: 'osp-a', cardId: 'probe-slow-stepped', start: 0, end: 5, params: { burnMs: 40, label: 'A' }, frame: { x: 0, y: 0, w: 960, h: 720 } }] },
      { id: 'osp-t-b', name: '序列 b', clips: [{ id: 'osp-b', cardId: 'probe-slow-stepped', start: 0.5, end: 5, params: { burnMs: 40, label: 'B' }, frame: { x: 960, y: 360, w: 960, h: 720 } }] },
    ] }));
    S.actions.seek(5.5);
    const p = S.getState().project;
    return { projectId: p.id, fps: p.fps || 30, width: p.width, height: p.height };`);
  out.setup = setup;
  check(setup.fps === FPS && setup.width === 1920, '项目是 1920 宽、30 fps', setup);
  await until('两个舞台都起来', () => stageFrames(page).length >= 2, 120_000, 300);
  const layout = await until('页面是双舞台、普通档', async () => {
    const d = await onlineDiag(page);
    const hs = await page.evaluate(() => window.__pcStageHandshake?.() ?? null).catch(() => null);
    return d && d.tier === 'original' && stageFrames(page).length >= 2 ? { tier: d.tier, handshake: hs?.phase ?? null, stages: stageFrames(page).map((f) => new URL(f.url()).origin) } : null;
  }, 120_000, 500);
  out.layout = layout;
  check(layout && new Set(layout.stages).size === 2 && layout.stages.every((o) => STAGE_ORIGINS.includes(o)), '两个舞台各在自己的源上(跨源)', layout);
  // 页面把两张卡判重(在加载遮罩下测完,每帧烧 40 ms 超过一拍的预算):它发布的清单计划里有这两张
  const planned = await until('页面把两张卡判重', async () => {
    const p = await page.evaluate(() => window.__pcPlanPublisher?.() ?? null).catch(() => null);
    const clips = p?.lastClips ?? p?.clips ?? null;
    return Array.isArray(clips) && IDS.every((id) => clips.includes(id)) ? clips : null;
  }, 180_000, 500);
  out.planned = planned;

  /* ---------------- 渲染节点一侧:连文档服务、素材服务 ---------------- */
  {
    // 每次(重)连都重新取一次挑战
    const protocols = () => buildAuthProtocols({ base: DOC_DIRECT, projectId: made.projectId, username: creator.username, deviceId: `osp-node-${RUN}`.padEnd(16, '0'), deviceName: 'osp 预渲染',
      as: 'creator', password: creator.password, role: 'page' });
    const ep = createDocEndpoint({ url: DOC_DIRECT.replace(/^http/, 'ws'), protocols, log: () => {} });
    await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('渲染节点连不上文档服务')), 20_000); if (ep.connected) { clearTimeout(t); resolve(); } else ep.onOpen(() => { clearTimeout(t); resolve(); }); });
    link = { ep, content: createContentClient(ep), client: createAssetClient({ base: ASSET_DIRECT, ticket: createTicketSource(ep, { access: 'rw' }) }) };
  }
  const projectJson = renderProject(await page.evaluate(() => JSON.parse(JSON.stringify(window.__pcStore.getState().project))));

  /* ================================================================ 第一轮:两条单卡流 */
  const one = await produce({ label: 'card', project: projectJson, link });
  out.produce = { ms: one.ms, streams: one.streams, encoder: one.encoder, envFingerprint: one.envFingerprint, push: one.push };
  check((one.streams ?? []).length === 2 && one.streams.every((s) => s.kind === 'card'), '管线产了两条单卡流', one.streams);
  const specOf = (id) => (one.streams ?? []).find((s) => s.clipIds.length === 1 && s.clipIds[0] === id) ?? null;

  /* ---------------- S1 层表 ---------------- */
  const layerKey = `layers:${setup.projectId}`;
  const map1 = (await link.content.get('snapshot-manifest', layerKey))?.body ?? null;
  out.map1 = map1 ? { v: map1.v, layers: (map1.layers ?? []).length, streams: (map1.streams ?? []).map((r) => ({ topClipId: r.topClipId, kind: r.kind, plane: r.plane, clipIds: r.clipIds,
    candidates: (r.candidates ?? []).map((c) => ({ envFingerprint: c.envFingerprint, resultKey: String(c.resultKey).slice(0, 12) })), firstSegment: r.firstSegment, lastSegment: r.lastSegment,
    segmentsPerTask: r.segmentsPerTask, inputSig: r.inputSig ?? null })) } : null;
  check(map1?.v === 3 && Array.isArray(map1.streams) && map1.streams.length === 2, 'S1 层表(v 3,没升版本)带 streams 表,两行', out.map1);
  for (const id of IDS) {
    const rowOf = map1?.streams?.find((r) => r.topClipId === id);
    const spec = specOf(id);
    check(rowOf && spec && rowOf.kind === 'card' && rowOf.plane === 'local' && rowOf.clipIds.join() === id && rowOf.contentKey === spec.contentKey
      && rowOf.candidates.length === 1 && rowOf.candidates[0].resultKey === spec.streamKey && rowOf.candidates[0].envFingerprint === one.envFingerprint
      && rowOf.firstSegment === spec.firstSegment && rowOf.lastSegment === spec.lastSegment && /^s1-/.test(rowOf.inputSig ?? ''), `S1 ${id} 那一行:成员、内容键、候选(结果键 = 流键)、分段范围、输入签名`, { rowOf, spec });
    if (rowOf) {
      const first = [rowOf.firstSegment, Math.min(rowOf.lastSegment, rowOf.firstSegment + rowOf.segmentsPerTask - 1)];
      const manifest = (await link.content.get('render-manifest', `${rowOf.candidates[0].resultKey}:${first[0]}-${first[1]}`))?.body ?? null;
      check(manifest?.kind === 'stream' && Object.keys(manifest.segments ?? {}).length === first[1] - first[0] + 1, `S1 ${id}:按这一行的键查得到流清单,分段齐`, { key: `${String(rowOf.candidates[0].resultKey).slice(0, 12)}:${first[0]}-${first[1]}`, segments: Object.keys(manifest?.segments ?? {}).length });
    }
  }
  // b 从 0.5 秒起:第一段是 1(入点不在分段边界上)
  check(map1?.streams?.find((r) => r.topClipId === B)?.firstSegment === Math.floor((0.5 * FPS) / SEGMENT_FRAMES), 'S1 b 的流从第 1 段起', map1?.streams?.find((r) => r.topClipId === B)?.firstSegment);

  /* ---------------- S5 的准备:a 的第 4 段(2.0～2.5 秒)在素材服务上「没有」。页面还停在 5.5 秒,没碰过这条流的任何一段 ---------------- */
  const MISSING_SEG = 4;
  let missingHash = null;
  {
    const rowA = map1?.streams?.find((r) => r.topClipId === A);
    const manifest = rowA ? (await link.content.get('render-manifest', `${rowA.candidates[0].resultKey}:${rowA.firstSegment}-${Math.min(rowA.lastSegment, rowA.firstSegment + rowA.segmentsPerTask - 1)}`))?.body : null;
    const hash = manifest?.segments?.[MISSING_SEG]?.hash ?? null;
    missingHash = hash;
    if (check(/^[0-9a-f]{64}$/.test(String(hash)), 'S5 准备:取到 a 第 4 段的哈希', { hash: String(hash).slice(0, 12) })) blocked.add(hash);
    out.missing = { segment: MISSING_SEG, hash: String(hash).slice(0, 12) };
    check(!pxLog.some((r) => r.hash === hash), 'S5 准备:这之前页面没取过这一块');
  }

  /* ---------------- S2 就绪索引 ---------------- */
  const pxBefore = pxLog.length;
  await pauseAt(page, 0.6);
  const ready = await until('S2 页面认出两条流、播放头附近的分段就绪', async () => {
    const d = await onlineDiag(page);
    const list = d?.streams ?? [];
    return IDS.every((id) => (list.find((s) => s.clipId === id)?.ready ?? 0) >= 2) ? d : null;
  }, 60_000, 300);
  out.ready = ready ? { streams: ready.streams.map((s) => ({ clipId: s.clipId, kind: s.kind, ready: s.ready, envFingerprint: s.envFingerprint, resultKey: String(s.resultKey).slice(0, 12) })),
    streamManifests: ready.streamManifests, streamBlocks: ready.streamBlocks, streamFetches: ready.streamFetches, staleStreams: ready.staleStreams } : null;
  check(!!ready && ready.streams.length === 2 && ready.streams.every((s) => s.kind === 'card' && s.envFingerprint === one.envFingerprint) && ready.staleStreams.length === 0,
    'S2 页面的在线来源里有两条流,出自渲染节点那一种环境,没有过期的', out.ready);
  {
    const px = pxLog.slice(pxBefore);
    out.px = { total: px.length, editor: px.filter((r) => r.port === PORTS.editor).length, stages: px.filter((r) => r.port !== PORTS.editor).length, ok: px.filter((r) => r.status === 200).length };
    check(out.px.editor > 0 && out.px.stages === 0, 'S2 流的字节只由编辑器页去素材服务取(px/),两个舞台的源一次都不取', out.px);
  }

  /* ---------------- S3 流在画 ---------------- */
  // 在两个舞台里数快照平面换了几次(流覆盖着的层垫的是海报,一个分段才换一张)
  for (const f of stageFrames(page)) {
    await f.evaluate((ids) => {
      window.__ospSwaps = Object.fromEntries(ids.map((id) => [id, 0]));
      new MutationObserver((list) => {
        for (const m of list) {
          const plane = m.target instanceof Element ? m.target.closest('[data-pc-snapshot-plane]') : null;
          const id = plane?.parentElement?.getAttribute('data-pc-clip');
          if (id && id in window.__ospSwaps && m.type === 'childList') window.__ospSwaps[id]++;
        }
      }).observe(document.documentElement, { subtree: true, childList: true });
    }, IDS).catch(() => {});
  }
  const swapsNow = async () => { const f = await visibleStage(page); return f ? f.evaluate(() => ({ ...window.__ospSwaps })).catch(() => null) : null; };
  await playFrom(page, 0.6);
  const samples = [];
  {
    const t0 = Date.now();
    let swaps0 = null, first = null;
    while (Date.now() - t0 < 20_000) {
      const s = await stageState(page, IDS);
      if (!s) { await sleep(40); continue; }
      if ((s.t ?? 0) >= 1.75) break;
      const both = IDS.every((id) => s.clips[id]?.stream?.lastDrawn !== null && s.clips[id]?.stream?.lastDrawn !== undefined);
      if (both && !first) { first = s; swaps0 = await swapsNow(); }
      samples.push({ t: s.t, a: s.clips[A], b: s.clips[B], tracks: s.tracks.length });
      await sleep(45);
    }
    const swaps1 = await swapsNow();
    await pauseAt(page, 0.6);
    const drawn = samples.filter((x) => x.a?.stream && x.b?.stream && typeof x.a.stream.lastDrawn === 'number' && typeof x.b.stream.lastDrawn === 'number');
    const firstD = drawn[0], lastD = drawn[drawn.length - 1];
    const frames = firstD && lastD ? Math.round((lastD.t - firstD.t) * FPS) : 0;
    out.playing = { samples: samples.length, drawn: drawn.length, frames,
      a: firstD && lastD ? { drawnFrom: firstD.a.stream.drawn, drawnTo: lastD.a.stream.drawn, lastFrom: firstD.a.stream.lastDrawn, lastTo: lastD.a.stream.lastDrawn, errors: lastD.a.stream.errors, pushed: lastD.a.stream.pushed, decoder: lastD.a.stream.decoder } : null,
      b: firstD && lastD ? { drawnFrom: firstD.b.stream.drawn, drawnTo: lastD.b.stream.drawn, lastFrom: firstD.b.stream.lastDrawn, lastTo: lastD.b.stream.lastDrawn, errors: lastD.b.stream.errors, pushed: lastD.b.stream.pushed, decoder: lastD.b.stream.decoder } : null,
      swaps: swaps0 && swaps1 ? Object.fromEntries(IDS.map((id) => [id, swaps1[id] - swaps0[id]])) : null,
      tFrom: firstD?.t ?? null, tTo: lastD?.t ?? null };
    check(drawn.length >= 8 && frames >= 15, 'S3 播放中两条流同时在画的时间够长(≥ 15 帧)', out.playing);
    for (const [key, id] of [['a', A], ['b', B]]) {
      const p = out.playing[key];
      check(p && p.pushed === true, `S3 ${id}:流的字节是父页推来的`, p);
      check(p && p.drawnTo - p.drawnFrom >= frames * 0.6 && p.lastTo > p.lastFrom, `S3 ${id}:流播放器在出帧(画过的帧数跟着播放头涨)`, { ...p, frames });
      check(p && Math.abs(p.lastTo - Math.round(lastD.t * FPS)) <= 3, `S3 ${id}:画着的那一帧跟着播放头(差不超过 3 帧)`, { lastDrawn: p?.lastTo, stageFrame: Math.round((lastD?.t ?? 0) * FPS) });
      check(drawn.every((x) => x[key].suppressed), `S3 ${id}:播放中包裹层一直被抑制`, drawn.filter((x) => !x[key].suppressed).length);
      check(drawn.every((x) => !x[key].placeholder), `S3 ${id}:没有显示占位符`, drawn.filter((x) => x[key].placeholder).length);
      // 流在画的时候快照平面藏着;它是海报:播 `frames` 帧只换了约 frames / 15 次(每次换是一摘一挂,按两次变动算)
      check(drawn.filter((x) => x[key].snapshot && !x[key].snapshotHidden).length <= 1, `S3 ${id}:流在画的时候快照平面藏着`, drawn.filter((x) => x[key].snapshot && !x[key].snapshotHidden).length);
      const swaps = out.playing.swaps?.[id];
      check(typeof swaps === 'number' && swaps <= (Math.ceil(frames / SEGMENT_FRAMES) + 2) * 2, `S3 ${id}:不是快照在换(播 ${frames} 帧,快照平面只变动了 ${swaps} 次;每拍换的话是 ${frames * 2} 次上下)`, { swaps, frames });
    }
  }

  /* ---------------- S4 像素 ---------------- */
  const bothDrawing = (s) => {
    if (!s) return null;
    const ts = IDS.map((id) => s.clips[id]?.stream).filter((t) => t && typeof t.lastDrawn === 'number');
    return ts.length === IDS.length && IDS.every((id) => s.clips[id].suppressed) ? ts : null;
  };
  out.pixels = await comparePixels(page, IDS, { from: 0.6, name: 's4-card', streamOf: bothDrawing, until: 1.8 });

  /* ---------------- S5 缺块 ---------------- */
  {
    const segFrom = MISSING_SEG * SEGMENT_FRAMES, segTo = segFrom + SEGMENT_FRAMES - 1;
    const inSeg = (t) => { const f = Math.round(t * FPS); return f >= segFrom + 2 && f <= segTo - 2; };
    const afterSeg = (t) => Math.round(t * FPS) >= segTo + 8;
    const seen = [];
    let shot = null, shotAt = null;
    for (let round = 0; round < 4 && !(shot && seen.some((x) => afterSeg(x.t))); round++) {
      await playFrom(page, 1.55);
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) {
        const s = await stageState(page, IDS);
        if (!s) { await sleep(30); continue; }
        if ((s.t ?? 0) > 3.2) break;
        seen.push({ t: s.t, a: s.clips[A], b: s.clips[B] });
        if (!shot && inSeg(s.t) && Math.round(s.t * FPS) <= segFrom + 6) {
          const pic = await stageShot(page, 's5-missing-playing');
          const s2 = await stageState(page, IDS);
          if (pic && s2 && inSeg(s2.t)) { shot = pic; shotAt = { t0: s.t, t1: s2.t, a: s2.clips[A], b: s2.clips[B] }; }
        }
        await sleep(30);
      }
    }
    const during = seen.filter((x) => inSeg(x.t));
    const after = seen.filter((x) => afterSeg(x.t));
    const aStream = (x) => typeof x.a?.stream?.lastDrawn === 'number';
    out.missing = { ...out.missing, during: during.length, after: after.length,
      duringA: { noStream: during.filter((x) => !aStream(x)).length, snapshotVisible: during.filter((x) => x.a.snapshot && !x.a.snapshotHidden).length, placeholder: during.filter((x) => x.a.placeholder).length, suppressed: during.filter((x) => x.a.suppressed).length },
      duringB: { stream: during.filter((x) => typeof x.b?.stream?.lastDrawn === 'number').length },
      afterA: { stream: after.filter(aStream).length }, shotAt,
      requests: pxLog.filter((r) => blocked.has(r.hash)).map((r) => ({ port: r.port, status: r.status })) };
    check(during.length >= 3, 'S5 采到了缺的那一段里的样本', out.missing);
    check(out.missing.requests.length > 0 && out.missing.requests.every((r) => r.status === 404), 'S5 页面去取过那一块,素材服务回的是 404', out.missing.requests.slice(0, 4));
    check(during.length > 0 && out.missing.duringA.noStream === during.length, 'S5 缺的那一段里 a 没有流画面', out.missing.duringA);
    check(during.length > 0 && out.missing.duringA.snapshotVisible >= during.length - 1 && out.missing.duringA.placeholder === 0, 'S5 a 露出了快照(有内容、可见),没有占位符', out.missing.duringA);
    check(during.length > 0 && out.missing.duringA.suppressed === during.length, 'S5 a 仍被抑制(贴的是预渲染结果,不是活渲)', out.missing.duringA);
    check(during.length > 0 && out.missing.duringB.stream >= during.length - 1, 'S5 同一时刻 b 照常是流在画', out.missing.duringB);
    check(after.length > 0 && out.missing.afterA.stream >= after.length - 1, 'S5 过了缺的那一段,a 的流接上', { after: after.length, ...out.missing.afterA });
    if (check(!!shot, 'S5 在缺的那一段里截到一张', shotAt)) {
      const frame = Math.round(((shotAt.t0 + shotAt.t1) / 2) * FPS);
      const same = await liveShot(page, IDS, frame / FPS, 's5-missing-live-same');
      const far = await liveShot(page, IDS, (frame + 2 * FPS) / FPS, 's5-missing-live-far');
      if (check(!!same && !!far, 'S5 截到精确活渲的参照')) {
        const d = { same: diffOf(shot.png, same.png), far: diffOf(shot.png, far.png), orange: { playing: orangeOf(shot.png), live: orangeOf(same.png) } };
        out.missing.pixels = d;
        check(d.orange.playing > 0.02 && Math.abs(d.orange.playing - d.orange.live) <= 0.004, 'S5 缺块那一刻两块橙块都在画面里(a 那一层不透明)', d.orange);
        check(d.same.mad <= 1.5 && d.same.bad <= 0.002, 'S5 缺块那一刻的画面与同一时刻的精确活渲相符', d.same);
        check(d.far.bad >= d.same.bad * 4 + 0.002, 'S5 与别的时刻比差明显更大(对照)', d);
      }
    }
    await pauseAt(page, 5.5);
    // 补上那一块:页面过一会儿自己重取,区间接上
    blocked.clear();
    await pauseAt(page, 2.1);
    const healed = await until('S5 补上那一块之后页面自己取到', () => pxLog.some((r) => r.hash === missingHash && r.status === 200), 30_000, 300);
    check(!!healed, 'S5 那一块补上之后,页面重取成功(不用刷新)');
    await pauseAt(page, 5.5);
  }

  /* ================================================================ 第二轮:组流 */
  if (!flag('--no-group')) {
    await stopPipeline(one);
    const two = await produce({ label: 'group', project: projectJson, link, decoders: 1 });
    out.produceGroup = { ms: two.ms, streams: two.streams, push: two.push };
    const g = (two.streams ?? [])[0] ?? null;
    check((two.streams ?? []).length === 1 && g?.kind === 'group' && g.clipIds.length === 2, 'S6 解码器预算压到 1:两张卡并成一条组流', two.streams);
    const map2 = (await link.content.get('snapshot-manifest', layerKey))?.body ?? null;
    const rowG = map2?.streams?.[0] ?? null;
    out.map2 = map2 ? { streams: (map2.streams ?? []).map((r) => ({ topClipId: r.topClipId, kind: r.kind, plane: r.plane, clipIds: r.clipIds, firstSegment: r.firstSegment, lastSegment: r.lastSegment, inputSig: r.inputSig ?? null })) } : null;
    check(map2?.streams?.length === 1 && rowG.kind === 'group' && rowG.plane === 'stage' && g && rowG.clipIds.join() === g.clipIds.join() && rowG.topClipId === g.clipIds[g.clipIds.length - 1]
      && rowG.candidates[0].resultKey === g.streamKey && /^s1-/.test(rowG.inputSig ?? ''), 'S6 层表换成一行组流:成员按画家顺序,挂在最上面那张上', out.map2);
    await pauseAt(page, 0.8);
    const readyG = await until('S6 页面认出组流、播放头附近的分段就绪', async () => {
      const d = await onlineDiag(page);
      const list = d?.streams ?? [];
      return list.length === 1 && list[0].kind === 'group' && list[0].members === 2 && list[0].ready >= 2 ? d : null;
    }, 60_000, 300);
    out.readyGroup = readyG ? readyG.streams.map((s) => ({ clipId: s.clipId, kind: s.kind, members: s.members, ready: s.ready })) : null;
    check(!!readyG, 'S6 页面的在线来源里只剩一条组流(原来两条单卡流撤了)', out.readyGroup ?? (await onlineDiag(page))?.streams);
    const groupDrawing = (s) => {
      if (!s) return null;
      const t = s.tracks.find((x) => x.clips.length === 2 && IDS.every((id) => x.clips.includes(id)));
      return t && typeof t.lastDrawn === 'number' && IDS.every((id) => s.clips[id]?.suppressed) ? [t] : null;
    };
    await playFrom(page, 0.8);
    const seenG = [];
    {
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) {
        const s = await stageState(page, IDS);
        if (!s) { await sleep(40); continue; }
        if ((s.t ?? 0) >= 1.9) break;
        if (groupDrawing(s)) seenG.push({ t: s.t, track: groupDrawing(s)[0], canvas: s.groupCanvas, a: s.clips[A], b: s.clips[B], tracks: s.tracks.length });
        await sleep(45);
      }
      await pauseAt(page, 0.8);
    }
    const g0 = seenG[0], g1 = seenG[seenG.length - 1];
    out.playingGroup = { samples: seenG.length, canvas: g1?.canvas ?? null, drawnFrom: g0?.track.drawn ?? null, drawnTo: g1?.track.drawn ?? null, lastFrom: g0?.track.lastDrawn ?? null, lastTo: g1?.track.lastDrawn ?? null,
      pushed: g1?.track.pushed ?? null, tracks: g1?.tracks ?? null, tFrom: g0?.t ?? null, tTo: g1?.t ?? null };
    check(seenG.length >= 8, 'S6 播放中组流在画、两张卡都被抑制', out.playingGroup);
    check(g1 && g1.canvas && g1.canvas.group === g.clipIds.join(',') && g1.canvas.w === 1920 && g1.canvas.h === 1080, 'S6 组流画在舞台根下的那块画布上(整幅)', g1?.canvas);
    check(g1 && g1.track.pushed === true && g1.track.drawn > g0.track.drawn && g1.track.lastDrawn > g0.track.lastDrawn && g1.tracks === 1, 'S6 只有这一条轨道,字节是父页推来的,在出帧', out.playingGroup);
    check(seenG.every((x) => !x.a.placeholder && !x.b.placeholder), 'S6 没有显示占位符');
    out.pixelsGroup = await comparePixels(page, IDS, { from: 0.8, name: 's6-group', streamOf: groupDrawing, until: 2.0 });
    await stopPipeline(two);
  }

  /* ---------------- S7 页面没有错误 ---------------- */
  out.pageErrors = pageErrors.slice(0, 6);
  check(pageErrors.length === 0, 'S7 页面没有错误', out.pageErrors);
  out.pxStatus = pxLog.reduce((acc, r) => { const k = `${r.port === PORTS.editor ? 'editor' : 'stage'}:${r.status}`; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  out.final = await onlineDiag(page).then((d) => (d ? { streamFetches: d.streamFetches, streamBytes: d.streamBytes, streamFailures: d.streamFailures, streamManifestFetches: d.streamManifestFetches, errors: d.errors } : null));
} catch (e) {
  fails.push(`探针异常:${String(e?.stack ?? e).slice(0, 900)}`);
} finally {
  try { await browser?.close(); } catch { /* 已关 */ }
  for (const rec of pipelines) await stopPipeline(rec);
  try { link?.ep.close(); } catch { /* 已关 */ }
  for (const s of servers) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); }
  try { await combo?.close?.(); } catch { /* 已关 */ }
  await stopChildren();
  if (!flag('--keep-temp')) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 留着也无妨 */ } }
}
out.ok = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
