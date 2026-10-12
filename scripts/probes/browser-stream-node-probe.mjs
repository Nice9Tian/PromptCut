/**
 * 在线浏览器节点认领并生成单卡轨道流的本机端到端(`docs/plan/browser-stream-task.md` 第一到四处;任务书 `render-refactor-task.md`「甲一」的「产」这一半)。
 *
 *   node scripts/probes/browser-stream-node-probe.mjs [--dist <在线构建目录>] [--base-port 7410] [--out <目录>] [--keep-temp] [--no-yield]
 *        端口(整段 +0～+9):+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务、+5～+7 桌面编辑器(及它的舞台端口)。都只绑 127.0.0.1。
 *
 * 四个角色都在本机(照 `m7-node-probe.mjs`、`m7-browser-probe.mjs` 搭):
 *   - 文档服务 + 素材服务:进程内的托管组合,经共用的本机托管代理 `lib/hosted-proxy.mjs` 开三个同站跨源的源;
 *   - 切分方:**真的桌面预渲染进程**(`m8/procs.mjs` 的 `startQueueEditor`:编辑器 vite + 预渲染进程,队列模式,测试指纹,
 *     `PROMPTCUT_TEST_PLAN_ONLY=1` 只切分、不认领细任务,轨道流开着)。它认领页面发的清单计划,在自己的 Chrome 里算 card plan 与流计划,
 *     给浏览器出快照与单卡流那两份;它订阅着细任务的 `task.done`,浏览器产完它就按清单把块拉回去;
 *   - 浏览器节点:在线构建的编辑页(普通档、两个跨源舞台)。进项目用「刷新后回到项目」那条产品路径(`lib/online-resume-entry.mjs`;
 *     开始页的加入表单已经不在在线构建里);
 *   - 参照:本进程里另起一个 `FramePipeline`(与桌面预渲染进程同一份代码、同一个开发服务器当出图页),对同一版项目、同一张卡用 ffmpeg 产同一条流。
 *
 * 断言(任一不成立退出码 1):
 *   A 认领     页面报了能压流(`capabilities.streams`),认领并完成了一个 `stream:` 任务;切分方一个细任务都没做
 *   B 清单     内容库 `render-manifest` 里有 `<结果键>:<起>-<止>`,过桌面的 `manifestMatches`;结果键 = 流的内容键 × 浏览器指纹
 *              (内容键取参照管线算出的那一个:同一张卡、同一份内容);编码器名 `webcodecs-avc`、`stride: 1`、矩形 = bound、分段齐
 *   C 素材服务 开头文件与每个分段都在像素那一类(`px`)且 complete,取回的字节 sha256 与清单一致;服务端的 `initInfo` / `segmentInfo` 读得出
 *   D 桌面采纳 桌面预渲染进程把这条流拉了回去:诊断口的流表里有这个键、任务范围里的分段都在;它的流库里的字节与素材服务上的逐字节相同;
 *              `applyErrors` 为 0
 *   E 画面     把浏览器产的流与参照流都解出来逐帧比:色半区(预乘色)与透明度半区的平均差都 < 1(满分 255,`render-standard.md` 实测的量级);
 *              卡的范围之外的帧两边都是全透明;对照:同一条浏览器流的每一帧去比参照流里**隔得最远的那一帧**,内容区的差要明显更大(≥ 3 倍)
 *   F 快照回归 同一张卡的快照任务照旧由页面认领并完成(`snapshot-manifest` 两档齐)
 *   G 让路     产流途中开始播放:当前帧做完放回恰好一次(`yield-play`)、播放期间不认领不产帧、停下后恢复并做完,已推完的分段不重做,不计失败
 *   H 中止     产流途中页面隐藏:不等当前帧、立即放回(`yield-hidden`);回到前台后恢复并做完,不计失败
 * 耗时只记录(`guide_files/verification.md`「耗时只记录,不当闸门」):每帧取像素、送编码器的用时,整段用时,都写进结果行。
 *
 * 不打印令牌、口令。输出:过程写 stderr;stdout 最后一行一行 JSON `{ ok, fails, … }`;看图用的几帧 PNG 写到 `--out`。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import crypto, { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import dnsShim from './lib/localhost-dns.cjs'; // Node 这边也认得 *.localhost(托管组合对外说的是 pc.localhost)
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';
import { resumeRecord, plantResume } from './lib/online-resume-entry.mjs';
import { startQueueEditor, viteBin, portFree } from './m8/procs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const KEEP = argv.includes('--keep-temp');
const NO_YIELD = argv.includes('--no-yield');
const BASE = Number(arg('--base-port', 7410));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4, desk: BASE + 5 };
const BAND = [BASE, BASE + 9];
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const ORIGINS = proxyOrigins(PORTS.editor);
const SITE = ORIGINS.editor;
const HOSTED = `${SITE}/hosted/`;
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
const EDITOR = `${SITE}/editor`;
const DESK_FP = crypto.createHash('sha256').update(`bsn-desk-${RUN}`).digest('hex').slice(0, 16);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bstream-node-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'out')));
fs.mkdirSync(OUT, { recursive: true });
const deadline = Date.now() + 40 * 60_000;
// 探针起的 Node 子进程(桌面编辑器与它的预渲染进程)继承它,也能解析 pc.localhost
process.env.NODE_OPTIONS = dnsShim.withLocalhostDns(process.env.NODE_OPTIONS);

/** 探针项目:1280×720、30 fps、8 秒。卡从第 12 帧起(不在分段边界上),占 48 帧(全局 12～59,分段 0～3,头一个分段前 12 帧在卡之外) */
const PROJECT = { width: 1280, height: 720, fps: 30, duration: 8 };
const CLIP = { start: 0.4, duration: 1.6 };
const SEG = 15;

const fails = [];
const out = { ok: false, run: RUN, site: SITE, out: OUT, steps: {}, timings: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 700)}`)); return !!cond; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
let debugProbe = null;

async function until(label, fn, timeoutMs, everyMs = 300) {
  const end = Math.min(Date.now() + timeoutMs, deadline);
  let last = 0;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) { fails.push(`超时:${label}`); return null; }
    if (process.env.PROBE_DEBUG && Date.now() - last > 15_000) { last = Date.now(); say('waiting', { label, v: debugProbe ? await debugProbe().catch((e) => String(e?.message ?? e)) : null }); }
    await delay(everyMs);
  }
}

/* ================================================================== 本机站点:托管组合 + 三个源的代理 */

let combo = null, hostedProxy = null;
async function startLocalSite() {
  for (const p of [PORTS.editor, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  let dist = arg('--dist', null);
  if (!dist) {
    dist = path.join(TMP, 'dist-online');
    say('local.build-online', { dist });
    const b = spawnSync(process.execPath, [viteBin(), 'build', '--mode', 'online', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (b.status !== 0) throw new Error(`在线构建失败:${String(b.stderr).slice(-600)}`);
  }
  dist = path.resolve(dist);
  const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
  fs.mkdirSync(path.join(TMP, 'hosted'), { recursive: true });
  combo = await startHostedCombo({
    dataDir: path.join(TMP, 'hosted'), docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    docPublicUrl: `ws://pc.localhost:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
  });
  hostedProxy = await startHostedProxy({ dist, basePort: PORTS.editor, docPort: PORTS.doc, assetPort: PORTS.asset, policy: 'full' });
  say('local.up', { site: SITE, stages: ORIGINS.stages, doc: PORTS.doc, asset: PORTS.asset, dist });
  return dist;
}

/** 给刚建好的共享项目写进一份空项目(替创建者的桌面版;同 `lib-seed.mjs`,只是画幅用探针自己的) */
async function seedProject({ projectId, creator, name }) {
  const { buildAuthProtocols } = await import('../../server/auth/client.mjs');
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId, username: creator.username, deviceId: 'bsn-seed-node-0001', deviceName: 'probe-seed', as: 'creator', password: creator.password, role: 'page' });
  const ws = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const ask = (msg) => new Promise((resolve) => {
    const reqId = `seed${Math.random().toString(36).slice(2)}`;
    const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  try {
    const opened = await ask({ type: 'project.open', projectId });
    const body = { version: 1, id: `seed-${projectId.slice(-8)}`, name, ...PROJECT, themeId: 'midnight', media: [], tracks: [{ id: 't-1', name: '序列 1', clips: [] }] };
    const seeded = await ask({ type: 'project.op', projectId, opId: randomBytes(16).toString('base64url'), ops: [{ op: 'set', path: '', value: body }] });
    const bad = (m) => /error|reject/i.test(String(m?.type ?? ''));
    return { ok: !bad(opened) && !bad(seeded), opened: opened?.type, seeded: seeded?.type };
  } finally { ws.close(); }
}

/* ================================================================== 解流、逐帧比 */

let ffmpegPath = null;
/**
 * 一条流逐段解成原始 rgb24 帧,逐帧交出(每帧一个 Buffer)。每个分段配上开头文件单独解:桌面的每个分段是一次独立的 ffmpeg 编码,
 * 各段的时间戳都从头起,拼成一个文件解只出得来第一段。files 是每段一个文件(开头文件 + 那一段)。
 */
async function* decodeStream(files, width, height) {
  for (const file of files) yield* decodeFrames(file, width, height);
}
async function* decodeFrames(file, width, height) {
  const frameBytes = width * height * 3;
  const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let err = '';
  child.stderr.on('data', (c) => { err += c.toString(); });
  let pending = [], have = 0;
  try {
    for await (const chunk of child.stdout) {
      pending.push(chunk);
      have += chunk.length;
      while (have >= frameBytes) {
        const all = pending.length === 1 ? pending[0] : Buffer.concat(pending);
        yield all.subarray(0, frameBytes);
        const rest = all.subarray(frameBytes);
        pending = rest.length ? [rest] : [];
        have = rest.length;
      }
    }
    if (have) throw new Error(`解出来的字节不是整帧(多出 ${have} 字节):${err.slice(-200)}`);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

/**
 * 上下拼合的一帧 → 各种量。`w × ph`(`ph = 2h + 16`):第 0～h 行色半区(预乘色),第 h+8～2h+8 行透明度半区(灰度)。
 * 回 `{ color, alpha }`(平均绝对差,满分 255)、`maxAlphaA / B`、内容区(两边任一透明度 > 8 的像素)的个数与两种差。
 */
function compareFrames(a, b, w, h) {
  const row = w * 3;
  let colorSum = 0, alphaSum = 0, maxA = 0, maxB = 0, n = 0, inColor = 0, inAlpha = 0;
  const alphaTop = (h + 8) * row;
  for (let y = 0; y < h; y++) {
    const c = y * row, al = alphaTop + y * row;
    for (let x = 0; x < w; x++) {
      const i = c + x * 3, j = al + x * 3;
      const dc = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      const aa = a[j + 1], ab = b[j + 1];
      const da = Math.abs(aa - ab);
      colorSum += dc;
      alphaSum += da;
      if (aa > maxA) maxA = aa;
      if (ab > maxB) maxB = ab;
      if (aa > 8 || ab > 8) { n++; inColor += dc; inAlpha += da; }
    }
  }
  const px = w * h;
  return { color: colorSum / (px * 3), alpha: alphaSum / px, maxAlphaA: maxA, maxAlphaB: maxB, content: n, contentColor: n ? inColor / (n * 3) : 0, contentAlpha: n ? inAlpha / n : 0 };
}

/** 一帧里取一个窗口(色半区与透明度半区各一块)留着做对照:`{ color, alpha }` 两个 Buffer */
function cropWindow(frame, w, h, win) {
  const row = w * 3;
  const color = Buffer.alloc(win.w * win.h * 3), alpha = Buffer.alloc(win.w * win.h);
  for (let y = 0; y < win.h; y++) {
    const src = (win.y + y) * row + win.x * 3;
    frame.copy(color, y * win.w * 3, src, src + win.w * 3);
    const al = (h + 8 + win.y + y) * row + win.x * 3;
    for (let x = 0; x < win.w; x++) alpha[y * win.w + x] = frame[al + x * 3 + 1];
  }
  return { color, alpha };
}
function windowDiff(a, b) {
  let c = 0, al = 0;
  for (let i = 0; i < a.color.length; i++) c += Math.abs(a.color[i] - b.color[i]);
  for (let i = 0; i < a.alpha.length; i++) al += Math.abs(a.alpha[i] - b.alpha[i]);
  return { color: c / a.color.length, alpha: al / a.alpha.length };
}
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const stat = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? { n: s.length, mean: round(s.reduce((x, y) => x + y, 0) / s.length), max: round(s[s.length - 1]), p50: round(s[Math.floor(s.length / 2)]) } : { n: 0 }; };

/* ================================================================== 页面 */

let browser = null, editor = null, refPipeline = null, chk = null;
const EVAL_TIMEOUT_MS = 30_000;
const P = (page, fn, ...a) => Promise.race([page.evaluate(fn, ...a), delay(EVAL_TIMEOUT_MS).then(() => { throw new Error('页面 30 秒没应答'); })]);
const shot = async (page, name) => { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f }).catch(() => {}); return f; };
const nodeDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcBrowserNode?.() ?? null)); } catch { return null; } }).catch(() => null);
const streamHold = (d) => (d?.holding ?? []).find((h) => String(h.id).startsWith('stream:')) ?? null;

try {
  const dist = await startLocalSite();
  const health = await (await fetch(`${SITE}/hosted/healthz`)).json().catch(() => null);
  if (!check(health?.ok, '托管端 /hosted/healthz', health)) throw new Error('托管端不通');
  const { frameCode } = await import('../../server/frame-code.mjs');
  const codeVersion = frameCode(ROOT);
  const embedded = fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js')).some((f) => fs.readFileSync(path.join(dist, 'assets', f), 'utf8').includes(codeVersion));
  check(embedded, '在线构建嵌的代码版本与本进程算的一致(--dist 要是当前这份源码构建的)', { codeVersion: codeVersion.slice(0, 12) });

  /* ---------------------------------------------------------------- 0. 建项目、写进空项目、起桌面预渲染进程当切分方 */
  const { createSharedProject } = await import('../../server/auth/client.mjs');
  const { wsBaseOf } = await import('../../server/auth/route.mjs');
  const projName = `流节点-${RUN}`;
  const creator = { username: 'bsn-creator', password: `pw-${randomBytes(6).toString('hex')}` };
  const projectPassword = `pp-${randomBytes(6).toString('hex')}`;
  const made = await createSharedProject({ base: DOC_DIRECT, name: projName, mode: 'free', creator, password: projectPassword });
  const projectId = made.projectId;
  const seeded = await seedProject({ projectId, creator, name: projName });
  check(seeded.ok, '替创建者写进空项目', seeded);
  out.steps.project = { projectId, name: projName };

  const editorDir = path.join(OUT, 'editor');
  for (const d of ['card-overrides', 'projects', 'work']) fs.mkdirSync(path.join(editorDir, d), { recursive: true });
  const sharedConfig = path.join(editorDir, 'shared.json');
  fs.writeFileSync(sharedConfig, JSON.stringify([{ url: wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render',
    deviceId: `bsn-desk-${RUN}`.padEnd(16, '0'), deviceName: '流节点探针 桌面' }]));
  const tDesk = Date.now();
  editor = await startQueueEditor({ port: PORTS.desk, dir: editorDir, sharedConfig, fakeFingerprint: DESK_FP, band: BAND, extraEnv: {
    PROMPTCUT_CARD_OVERRIDES: path.join(editorDir, 'card-overrides'), PROMPTCUT_PROJECTS_DIR: path.join(editorDir, 'projects'), PROMPTCUT_WORK_DIR: path.join(editorDir, 'work'),
    PROMPTCUT_DEVICE_ID: `bsn-desk-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: '流节点探针 桌面',
    // 只切分、不认领细任务(D15 的测试开关);轨道流开着(桌面应用的缺省;`childEnv` 缺省把它关了)
    PROMPTCUT_TEST_PLAN_ONLY: '1', PROMPTCUT_STREAMS: '1' } });
  const deskQueue = await editor.waitActive();
  check(deskQueue.envFingerprint === DESK_FP, '桌面预渲染进程用上了测试指纹', { envFingerprint: deskQueue.envFingerprint });
  out.timings.deskUpMs = Date.now() - tDesk;
  say('desk.up', { envFingerprint: deskQueue.envFingerprint, nodeId: deskQueue.nodeId ?? null, ms: out.timings.deskUpMs });

  /* ---------------------------------------------------------------- 1. 成员页面进入(普通档) */
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  browser = await puppeteer.launch({
    headless: true, protocolTimeout: 900_000, defaultViewport: { width: 1600, height: 1000 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-gpu'],
  });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  await plantResume(page, await resumeRecord({ base: HOSTED, derivationBase: `${DOC_DIRECT}/`, projectId, name: projName, username: 'bsn-member', password: projectPassword,
    deviceId: `bsn-member-${RUN}`.padEnd(16, '0') }));
  await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const entered = await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 120_000 }).then(() => true, () => false);
  if (!check(entered, '成员进入项目(刷新后回到项目那条路)')) throw new Error('成员没进去');
  await until('成员页双舞台握上手', async () => P(page, () => { const d = window.__pcPreviewDiag?.(); return d?.dual && d.onlineStages?.handshake === 'ok'; }), 120_000, 500);

  /* ---------------------------------------------------------------- 2. 加一张重卡,等节点报到、报能压流 */
  const addClip = (start, duration, label, padNodes = 0) => P(page, (o) => {
    const S = window.__pcStore;
    const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'probe-slow-stepped', start: o.start, duration: o.duration });
    S.actions.setClipParams(c.id, { burnMs: 40, label: o.label, ...(o.padNodes ? { padNodes: o.padNodes } : {}) });
    S.actions.seek(o.start + o.duration / 2);
    return c.id;
  }, { start, duration, label, padNodes });
  const clipId = await addClip(CLIP.start, CLIP.duration, 'bsn', 300);
  out.steps.clip = clipId;
  const ready = await until('页面当节点、报到拿到指纹、探到编码器', async () => { const d = await nodeDiag(page); return d?.ready === 'ready' && d.envFingerprint && d.streams?.capable ? d : null; }, 240_000, 500);
  check(ready?.eligibility?.ok, '当节点的条件成立', ready?.eligibility);
  check(ready?.streams?.capable === true, 'A:宿主探到了浏览器自带的 H.264 编码器,报能压流', ready?.streams);
  const browserFp = ready?.envFingerprint ?? null;
  out.steps.ready = ready && { envFingerprint: browserFp, nodeId: ready.nodeId, streams: { capable: ready.streams.capable, probe: ready.streams.probe, mode: ready.streams.mode } };
  say('node.ready', out.steps.ready ?? {});
  debugProbe = async () => ({ node: await P(page, () => { const d = window.__pcBrowserNode?.(); return d ? { ready: d.ready, state: d.state, reason: d.reason, idle: d.idle, counters: d.counters, holding: d.holding, streams: d.streams, last: d.lastError } : null; }),
    plan: await P(page, () => { const p = window.__pcPlanPublisher?.(); return p ? { last: p.last, log: (p.log ?? []).slice(-3) } : null; }), desk: (await editor.queue().catch(() => null))?.stats ?? null });

  /* ---------------------------------------------------------------- 3. 清单计划 → 桌面切分 → 页面认领快照与流 → 完成 */
  const t0 = Date.now();
  const seen = new Set();
  const streamed = await until('页面节点做完第一条流任务(连同这张卡的快照任务)', async () => {
    const d = await nodeDiag(page);
    for (const h of d?.holding ?? []) seen.add(h.id);
    return d?.counters?.streamTasks >= 1 && d.counters.completed >= 2 ? d : null;
  }, 900_000, 250);
  const diag = streamed ?? (await nodeDiag(page));
  out.timings.firstStreamMs = streamed ? Date.now() - t0 : null;
  out.steps.node = diag && { counters: diag.counters, streams: diag.streams, manifests: diag.manifests, upload: diag.upload, lastError: diag.lastError };
  const streamIds = [...seen].filter((id) => id.startsWith('stream:'));
  out.steps.claimed = [...seen];
  check(diag?.counters?.streamTasks >= 1 && diag?.counters?.failed === 0, 'A:页面认领并完成了流任务,没有失败', diag?.counters);
  check(streamIds.length >= 1 || (diag?.streams?.tasks ?? 0) >= 1, 'A:页面手里出现过 stream: 任务', [...seen]);
  check((diag?.streams?.frames ?? 0) === 60 && diag?.streams?.blank === 12, 'A:送进编码器 60 帧(分段 0～3),其中卡之外的 12 帧送的是全透明', diag?.streams);
  check(diag?.streams?.segments === 4 && diag?.streams?.inits === 1, 'A:推了 4 个分段、1 个开头文件', diag?.streams);
  const deskQ = await editor.queue().catch(() => null);
  out.steps.desk = deskQ && { stats: deskQ.stats };
  check(deskQ && deskQ.stats.completed === 0 && deskQ.stats.dedup === 0 && deskQ.stats.planSplit >= 1, 'A:桌面只切分(planSplit ≥ 1),一个细任务都没做', deskQ?.stats);

  /* ---------------------------------------------------------------- 4. 参照:同一份代码的 FramePipeline 对同一版项目产同一条流(ffmpeg) */
  const { normalizeEntry, sharedProtocols } = await import('../../server/auth/shared-config.mjs');
  const { createWsEndpoint } = await import('../../server/render-node/ws-transport.mjs');
  const { createContentClient } = await import('../../server/render-node/content-client.mjs');
  const { createProjectClient } = await import('../../server/render-node/project-client.mjs');
  const { manifestMatches } = await import('../../server/artifact-transfer.mjs');
  const { resultKeyOf } = await import('../../server/render-node/fingerprint.mjs');
  const { initInfo, segmentInfo } = await import('../../server/frame-stream.mjs');
  const { renderProject } = await import('../../server/render-project.mjs');
  const { findFfmpeg } = await import('../../server/bakery/ffmpeg.mjs');
  ffmpegPath = await findFfmpeg();
  const chkEntry = normalizeEntry({ url: wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render',
    deviceId: `bsn-chk-${RUN}`.padEnd(16, '0'), deviceName: '流节点探针 核对' });
  chk = createWsEndpoint({ url: chkEntry.url, protocols: sharedProtocols(chkEntry, { role: 'render' }), log: () => {} });
  await new Promise((r) => { if (chk.connected) r(); else chk.onOpen(r); });
  const content = createContentClient(chk);
  const projects = createProjectClient(chk);

  // 浏览器产的那一段:任务 id 是 `stream:<结果键>:<起>-<止>`
  const listed = await content.list('render-manifest').catch((e) => ({ items: [], error: String(e?.message ?? e) }));
  out.steps.manifests = { listed: listed.items.map((it) => it.key ?? it).slice(0, 20), error: listed.error ?? null };
  const idOf = streamIds[0] ?? null;
  const m0 = idOf ? /^stream:([a-f0-9]{64}):(\d+)-(\d+)$/.exec(idOf) : null;
  const resultKey = m0?.[1] ?? null;
  const range = m0 ? { from: Number(m0[2]), to: Number(m0[3]) } : null;
  check(range && range.from === 0 && range.to === 3, 'B:流任务的范围是分段 0～3(卡占全局帧 12～59)', { idOf });
  const item = resultKey ? await content.get('render-manifest', `${resultKey}:${range.from}-${range.to}`).catch((e) => ({ error: String(e?.message ?? e) })) : null;
  const manifest = item?.body ?? null;
  check(manifest && manifestMatches(manifest, { kind: 'stream', resultKey, range }), 'B:内容库里有这一段的流清单(render-manifest,过桌面的 manifestMatches)', { key: resultKey?.slice(0, 12), item: item?.error ?? (manifest ? Object.keys(manifest) : null) });
  const initIds = Object.keys(manifest?.inits ?? {});
  const segNums = Object.keys(manifest?.segments ?? {}).map(Number).sort((a, b) => a - b);
  check(JSON.stringify(segNums) === '[0,1,2,3]' && initIds.length === 1, 'B:清单列着分段 0～3 与一个开头文件', { segNums, initIds });
  const bound = manifest?.header?.bound ?? null;
  check(manifest?.header?.kind === 'card' && manifest.header.plane === 'local' && JSON.stringify(manifest.header.clipIds) === JSON.stringify([clipId]) && manifest.header.fps === 30 && manifest.header.tight === null,
    'B:header 是这张卡的单卡流(plane local、tight null)', manifest?.header);
  check(bound && bound.x === 0 && bound.y === 0 && bound.w === PROJECT.width && bound.h === PROJECT.height, 'B:矩形 = bound(没设框的卡:整个画面)', bound);
  check(initIds.every((id) => manifest.inits[id].encoder === 'webcodecs-avc' && manifest.inits[id].hash.slice(0, 16) === id && JSON.stringify(manifest.inits[id].rect) === JSON.stringify(bound)
    && manifest.inits[id].width === PROJECT.width && manifest.inits[id].height === 2 * PROJECT.height + 16 && manifest.inits[id].timescale === 30),
  'B:开头文件的登记(编码器 webcodecs-avc、键 = 哈希前 16 位、矩形 = bound、拼合后的宽高、时间刻度)', manifest?.inits);
  check(segNums.every((n) => { const s = manifest.segments[n]; return s.stride === 1 && s.samples === SEG && s.sig === null && s.encoder === 'webcodecs-avc' && initIds.includes(s.init); }),
    'B:每个分段满密度(stride 1)、15 个样本、编码器 webcodecs-avc', manifest?.segments);

  // 参照管线:取任务那一版的项目,算计划、按清单里的这张卡算流、整段产出来
  const rev = await P(page, () => window.__pcPlanPublisher?.()?.last?.rev ?? null).catch(() => null);
  const planned = await P(page, () => window.__pcPlanPublisher?.() ?? null).catch(() => null);
  out.steps.plan = planned && { last: planned.last, log: (planned.log ?? []).slice(-4) };
  const revOf = (id) => { const m = /@(\d+)#clips:/.exec(String(id ?? '')); return m ? Number(m[1]) : null; };
  const projectRev = revOf(typeof planned?.last === 'string' ? planned.last : planned?.last?.id) ?? rev;
  let project = null;
  for (const r of [projectRev, ...(planned?.log ?? []).map((l) => revOf(l.id)).reverse()].filter((x) => Number.isSafeInteger(x) && x > 0)) {
    project = await projects.get(projectId, r).catch(() => null);
    if (project && (project.tracks ?? []).some((tr) => (tr.clips ?? []).some((c) => c.id === clipId))) break;
    project = null;
  }
  if (!project && typeof projects.locate === 'function') {
    const found = await projects.locate(projectId, 1).catch(() => null);
    if (Number.isSafeInteger(found?.currentRev)) project = await projects.get(projectId, found.currentRev).catch(() => null);
  }
  if (!check(project && (project.tracks ?? []).some((tr) => (tr.clips ?? []).some((c) => c.id === clipId)), '参照:从文档服务取到带这张卡的那一版项目', { projectRev })) throw new Error('取不到项目');
  // 参照只要第一张卡:后面让路、中止用的卡是之后才加的,这一版里没有
  const { FramePipeline } = await import('../../server/frame-pipeline.mjs');
  const refRoot = path.join(OUT, 'ref-library');
  fs.mkdirSync(refRoot, { recursive: true });
  // 选项照预渲染进程(vite-plugin-frames.ts):抓帧代码的版本进流的内容键,不给的话算出来的内容键与桌面的不同
  const { captureCode } = await import('../../server/frame-code.mjs');
  refPipeline = new FramePipeline({ root: refRoot, origin: () => editor.url, code: () => codeVersion, captureCode: () => captureCode(ROOT), interactive: true, playhead: () => null, dataRoot: refRoot });
  refPipeline.streamProducer().attachRoute();
  const tRef = Date.now();
  const { entry } = await refPipeline.planForQueue(renderProject(project));
  const spec = refPipeline.listStreamSpecs(entry, [clipId]).find((s) => s.topClipId === clipId) ?? null;
  if (!check(spec && spec.kind === 'card', '参照:这张卡有一条单卡流', spec && { kind: spec.kind, first: spec.firstSegment, last: spec.lastSegment })) throw new Error('参照管线没有这条流');
  check(spec.firstSegment === 0 && spec.lastSegment === 3 && spec.firstFrame === 12 && JSON.stringify(spec.bound) === JSON.stringify(bound), '参照:流的范围与矩形和浏览器任务里的相同',
    { first: spec.firstSegment, last: spec.lastSegment, firstFrame: spec.firstFrame, bound: spec.bound });
  check(browserFp && resultKeyOf(spec.contentKey, browserFp) === resultKey, 'B:结果键 = 流的内容键 × 浏览器指纹(内容键取参照管线算的:同一张卡、同一份内容)',
    { resultKey: resultKey?.slice(0, 12), expect: browserFp ? resultKeyOf(spec.contentKey, browserFp).slice(0, 12) : null });
  check(resultKey !== resultKeyOf(spec.contentKey, DESK_FP), 'B:它不是桌面指纹的键(两种环境的结果不混)');
  await refPipeline.renderStreamRange(entry, spec, { from: 0, to: 3 });
  out.timings.refStreamMs = Date.now() - tRef;
  const refDir = path.join(refRoot, 'streams', spec.streamKey);
  const refManifest = JSON.parse(fs.readFileSync(path.join(refDir, 'stream.json'), 'utf8'));
  const refInit = [...new Set([0, 1, 2, 3].map((n) => refManifest.segments[n]?.init))];
  check(refInit.length === 1 && refInit[0] && [0, 1, 2, 3].every((n) => refManifest.segments[n]?.stride === 1), '参照:ffmpeg 产出了分段 0～3(满密度、同一个开头文件)', { refInit, encoder: refManifest.inits?.[refInit[0]]?.encoder });
  check(JSON.stringify(refManifest.inits[refInit[0]]?.rect) === JSON.stringify(bound), '参照:矩形也是 bound(没有收紧),两边画面尺寸相同', refManifest.inits[refInit[0]]?.rect);
  out.steps.ref = { streamKey: spec.streamKey.slice(0, 12), encoder: refManifest.inits[refInit[0]]?.encoder ?? null, codec: refManifest.inits[refInit[0]]?.codec ?? null };

  /* ---------------------------------------------------------------- 5. 素材服务上的块;桌面预渲染进程把这条流拉了回去 */
  const tk = await new Promise((resolve) => {
    const reqId = `tk-${RUN}`;
    chk.onMessage((msg) => { if (msg?.reqId === reqId) resolve(msg); });
    chk.send({ type: 'auth.ticket', kind: 'asset', access: 'r', reqId });
  });
  const auth = tk?.type === 'auth.ticket.ok' ? { Authorization: `Bearer ${tk.ticket}` } : {};
  const fetchPx = async (hash) => Buffer.from(await (await fetch(`${SITE}/media/api/asset/px/${hash}`, { headers: auth })).arrayBuffer());
  const blocks = [...initIds.map((id) => ({ what: `init-${id}`, hash: manifest.inits[id].hash, bytes: manifest.inits[id].bytes })), ...segNums.map((n) => ({ what: `seg-${n}`, hash: manifest.segments[n].hash, bytes: manifest.segments[n].bytes }))];
  const got = new Map();
  let complete = 0, hashOk = 0;
  for (const b of blocks) {
    const c = await (await fetch(`${SITE}/media/api/asset/px/${b.hash}/chunks`, { headers: auth })).json().catch(() => null);
    if (c?.complete) complete++;
    const body = await fetchPx(b.hash);
    if (sha256(body) === b.hash && body.length === b.bytes) hashOk++;
    got.set(b.hash, body);
  }
  check(complete === blocks.length && hashOk === blocks.length, 'C:开头文件与每个分段都在素材服务的像素那一类(px)、complete,取回的字节哈希与清单一致', { blocks: blocks.length, complete, hashOk });
  const initBytes = got.get(manifest.inits[initIds[0]].hash);
  const info = initInfo(initBytes);
  check(info.codec === manifest.inits[initIds[0]].codec && info.width === PROJECT.width && info.height === 2 * PROJECT.height + 16 && info.timescale === 30, 'C:服务端读得出开头文件(编码串、宽高、时间刻度与清单一致)', info);
  const segInfos = segNums.map((n) => segmentInfo(got.get(manifest.segments[n].hash)));
  check(segInfos.every((s) => s.moofs === 1 && s.sampleCount === SEG && s.firstSampleIsSync === true), 'C:每个分段一个 moof、15 个样本、段首是关键帧', segInfos);
  out.steps.blocks = { bytes: blocks.reduce((s, b) => s + b.bytes, 0), codec: info.codec, each: blocks.map((b) => [b.what, b.bytes]) };

  const deskStream = await until('桌面预渲染进程把这条流拉回去(诊断口的流表里有这个键)', async () => {
    const d = await editor.diagnostics().catch(() => null);
    const s = (d?.streams?.streams ?? []).find((x) => x.streamKey === resultKey);
    return s && segNums.every((n) => s.segments?.[n]) ? { stream: s, stats: d.queue?.stats ?? null } : null;
  }, 120_000, 500);
  check(deskStream, 'D:桌面的流表里有浏览器结果键的这条流,分段 0～3 都在', deskStream?.stream && { segments: Object.keys(deskStream.stream.segments), inits: deskStream.stream.inits });
  check(deskStream?.stats && deskStream.stats.applied >= 1 && deskStream.stats.applyErrors === 0, 'D:桌面按 task.done 的清单拉取并落盘(applied ≥ 1、applyErrors 0)', deskStream?.stats);
  const deskDir = path.join(editorDir, 'frame-library', 'streams', resultKey ?? 'x');
  let deskManifest = null;
  try { deskManifest = JSON.parse(fs.readFileSync(path.join(deskDir, 'stream.json'), 'utf8')); } catch { deskManifest = null; }
  let same = 0;
  if (deskManifest) {
    try { if (fs.readFileSync(path.join(deskDir, `init-${initIds[0]}.mp4`)).equals(initBytes)) same++; } catch { /* 没有 */ }
    for (const n of segNums) { try { if (fs.readFileSync(path.join(deskDir, deskManifest.segments[n].file)).equals(got.get(manifest.segments[n].hash))) same++; } catch { /* 没有 */ } }
  }
  check(deskManifest && same === blocks.length, 'D:桌面流库里的开头文件与分段,和素材服务上的逐字节相同', { dir: deskDir, same, of: blocks.length });
  check(deskManifest && segNums.every((n) => deskManifest.segments[n]?.adopted === true && deskManifest.segments[n].encoder === 'webcodecs-avc' && deskManifest.segments[n].stride === 1),
    'D:桌面流库的清单把它们记成采纳来的满密度分段(adopted、编码器 webcodecs-avc)', deskManifest && Object.fromEntries(segNums.map((n) => [n, deskManifest.segments[n]])));

  /* ---------------------------------------------------------------- 6. 解出来逐帧比 */
  const W = PROJECT.width, H = PROJECT.height, PH = 2 * H + 16;
  const refInitBytes = fs.readFileSync(path.join(refDir, 'init-' + refInit[0] + '.mp4'));
  const browserFiles = [], refFiles = [];
  for (const n of segNums) {
    const bf = path.join(OUT, 'browser-seg-' + n + '.mp4'), rf = path.join(OUT, 'desktop-seg-' + n + '.mp4');
    fs.writeFileSync(bf, Buffer.concat([initBytes, got.get(manifest.segments[n].hash)]));
    fs.writeFileSync(rf, Buffer.concat([refInitBytes, fs.readFileSync(path.join(refDir, refManifest.segments[n].file))]));
    browserFiles.push(bf);
    refFiles.push(rf);
  }
  // 内容区的窗口:橙块在 (480, 420) 起 320×240,向右最多挪 20 px,四周各留 24 px
  const WIN = { x: 456, y: 396, w: 392, h: 288 };
  const matched = [], crops = { a: [], b: [] };
  const ia = decodeStream(browserFiles, W, PH), ib = decodeStream(refFiles, W, PH);
  const tCmp = Date.now();
  for (let f = 0; ; f++) {
    const [ra, rb] = await Promise.all([ia.next(), ib.next()]);
    if (ra.done || rb.done) { check(ra.done && rb.done, 'E:两条流解出来的帧数相同', { browserEnded: ra.done, desktopEnded: rb.done, at: f }); break; }
    matched.push({ frame: f, ...compareFrames(ra.value, rb.value, W, H) });
    crops.a.push(cropWindow(ra.value, W, H, WIN));
    crops.b.push(cropWindow(rb.value, W, H, WIN));
  }
  out.timings.compareMs = Date.now() - tCmp;
  check(matched.length === 60, 'E:解出 60 帧(4 个分段)', { frames: matched.length });
  const inCard = matched.filter((m) => m.frame >= 12 && m.frame <= 59), outside = matched.filter((m) => m.frame < 12);
  const colorMax = Math.max(...matched.map((m) => m.color)), alphaMax = Math.max(...matched.map((m) => m.alpha));
  check(colorMax < 1 && alphaMax < 1, 'E:每一帧的色半区、透明度半区平均差都 < 1(满分 255)', { colorMax: round(colorMax), alphaMax: round(alphaMax) });
  check(outside.length === 12 && outside.every((m) => m.maxAlphaA <= 2 && m.maxAlphaB <= 2 && m.content === 0), 'E:卡的范围之外的 12 帧(全局 0～11)两边都是全透明', outside.map((m) => [m.frame, m.maxAlphaA, m.maxAlphaB]));
  check(inCard.length === 48 && inCard.every((m) => m.maxAlphaA >= 250 && m.maxAlphaB >= 250 && m.content > 50_000), 'E:卡范围里的 48 帧两边都画着橙块(不透明区域 > 5 万像素)', inCard.slice(0, 3).map((m) => [m.frame, m.maxAlphaA, m.maxAlphaB, m.content]));
  // 对照:浏览器流的第 f 帧去比参照流里隔得最远的那一帧(橙块每帧右移 1/3 px,隔 24 帧以上差 8 px 以上)
  const farOf = (f) => (f - 12 < 24 ? f + 24 : f - 24);
  const own = [], far = [];
  for (let f = 12; f <= 59; f++) {
    const a = windowDiff(crops.a[f], crops.b[f]), b = windowDiff(crops.a[f], crops.b[farOf(f)]);
    own.push(a.color + a.alpha);
    far.push(b.color + b.alpha);
  }
  const ownMean = own.reduce((x, y) => x + y, 0) / own.length, farMean = far.reduce((x, y) => x + y, 0) / far.length;
  const ratios = own.map((v, i) => far[i] / Math.max(v, 1e-6));
  check(farMean >= 3 * ownMean && Math.min(...ratios) > 1.5, 'E:对照——同一帧去比隔 24 帧的参照帧,内容区的差明显更大(平均 ≥ 3 倍、每一帧都 > 1.5 倍)',
    { own: round(ownMean), far: round(farMean), ratio: round(farMean / Math.max(ownMean, 1e-6), 1), minRatio: round(Math.min(...ratios), 2) });
  out.steps.compare = {
    frames: matched.length, window: WIN,
    fullFrame: { color: stat(matched.map((m) => m.color)), alpha: stat(matched.map((m) => m.alpha)) },
    content: { pixels: stat(inCard.map((m) => m.content)), color: stat(inCard.map((m) => m.contentColor)), alpha: stat(inCard.map((m) => m.contentAlpha)) },
    control: { sameFrame: round(ownMean), farFrame: round(farMean), ratio: round(farMean / Math.max(ownMean, 1e-6), 1), minRatio: round(Math.min(...ratios), 2) },
  };
  // 看图:两条流各取全局第 14 帧(卡的第 3 帧,分段 0 的最后一帧)与第 58 帧(分段 3 里),存成 PNG(上半色、下半透明度)
  for (const [name, files] of [['browser', browserFiles], ['desktop', refFiles]]) for (const g of [14, 58]) {
    try { execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', files[Math.floor(g / SEG)], '-vf', 'select=eq(n' + '\\' + ',' + (g % SEG) + ')', '-frames:v', '1', path.join(OUT, name + '-frame-' + g + '.png')], { windowsHide: true }); } catch { /* 看图用,出不来不影响结论 */ }
  }

  /* ---------------------------------------------------------------- 7. 快照回归:同一张卡的快照任务照旧完成 */
  const snapId = [...seen].find((id) => id.startsWith('snapshot:'));
  const sm = snapId ? /^snapshot:([a-f0-9]{64}):(\d+)-(\d+)$/.exec(snapId) : null;
  const snapItem = sm ? await content.get('snapshot-manifest', `${sm[1]}:${sm[2]}-${sm[3]}`).catch(() => null) : null;
  check(snapItem?.body && manifestMatches(snapItem.body, { kind: 'snapshot', resultKey: sm[1], range: { from: Number(sm[2]), to: Number(sm[3]) } })
    && snapItem.body.frames.length === 48 && snapItem.body.small?.length === 48, 'F:同一张卡的快照任务照旧由页面完成(snapshot-manifest 两档齐,48 帧)',
  { snapId, frames: snapItem?.body?.frames?.length ?? null, small: snapItem?.body?.small?.length ?? null });
  check((diag?.counters?.bakedFrames ?? 0) === 48, 'F:快照那一段生成了 48 帧', diag?.counters);
  await shot(page, 'after-first-stream');

  /* ---------------------------------------------------------------- 8. 让路:产流途中开始播放 */
  if (!NO_YIELD) {
    const before0 = await nodeDiag(page);
    const clip2 = await addClip(2.0, 4.0, 'yield', 0);   // 全局帧 60～179:分段 4～11,一个流任务 8 段 120 帧
    const baking = await until('第二张卡的流任务做到一半(至少推完一个分段、又做了几帧)', async () => {
      const d = await nodeDiag(page);
      const h = streamHold(d);
      return d?.state === 'baking' && h && h.of === 120 && h.done >= 20 && h.done <= 90 && d.streams.segments > before0.streams.segments ? d : null;
    }, 600_000, 50);
    const b = baking?.streams ?? null;
    await P(page, () => { const S = window.__pcStore; S.actions.seek(0); S.actions.play(); });
    const released = await until('播放开始后放回一次', async () => { const d = await nodeDiag(page); return (d?.counters?.released?.['yield-play'] ?? 0) >= 1 ? d : null; }, 60_000, 50);
    await delay(2500);
    const during = await nodeDiag(page);
    await P(page, () => window.__pcStore.actions.pause());
    const after = await until('停下后恢复认领、做完第二张卡的流任务与快照任务', async () => { const d = await nodeDiag(page); return d?.counters?.streamTasks >= 2 && d.counters.completed >= before0.counters.completed + 3 ? d : null; }, 900_000, 500);
    out.steps.yield = {
      clip: clip2,
      baking: b && { frames: b.frames, segments: b.segments },
      released: released && { released: released.counters.released, frames: released.streams.frames, claims: released.counters.claims, segments: released.streams.segments, yields: released.streams.yields },
      during: during && { frames: during.streams.frames, claims: during.counters.claims, state: during.state, idle: during.idle },
      after: after && { counters: after.counters, frames: after.streams.frames, segments: after.streams.segments, resumedSegments: after.streams.resumedSegments, yields: after.streams.yields },
    };
    check(released && released.counters.released['yield-play'] === 1 && released.streams.yields === 1, 'G:播放开始后放回恰好一次(yield-play),宿主那一侧记了一次让路', out.steps.yield.released);
    check(released && b && released.streams.frames - b.frames <= 3, 'G:放回之前至多再做完手里那一两帧(先发的下一帧算在内)', { before: b?.frames, at: released?.streams?.frames });
    check(during && released && during.counters.claims === released.counters.claims && during.streams.frames === released.streams.frames, 'G:播放期间不认领、不产帧', out.steps.yield.during);
    check(after && after.counters.failed === 0, 'G:停下后恢复并做完,不计失败', after?.counters);
    check(after && after.streams.resumedSegments >= 1, 'G:重新认领同一段只补缺的分段(已推完的不重做)', out.steps.yield.after);
    // 两张卡一共 60 + 120 帧;让路时没满的那一段(至多 14 帧)要重做,已推完的分段不重做
    check(after && after.streams.frames >= 180 && after.streams.frames <= 180 + 14, 'G:送进编码器的总帧数 = 180 + 让路时丢掉的那不满一段(≤ 14)', { frames: after?.streams?.frames });
    check(after && after.streams.segments === 12, 'G:两张卡一共推了 12 个分段,一个不多', { segments: after?.streams?.segments });

    /* -------------------------------------------------------------- 9. 中止:产流途中页面隐藏 */
    const before1 = after ?? (await nodeDiag(page));
    const clip3 = await addClip(6.0, 2.0, 'hide', 0);   // 全局帧 180～239:分段 12～15,60 帧
    const baking3 = await until('第三张卡的流任务在做', async () => {
      const d = await nodeDiag(page);
      const h = streamHold(d);
      return d?.state === 'baking' && h && h.of === 60 && h.done >= 4 && h.done <= 40 ? d : null;
    }, 600_000, 50);
    const other = await ctx.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    const hidden = await until('页面变成隐藏', () => P(page, () => document.visibilityState === 'hidden').catch(() => false), 10_000, 50);
    const releasedHidden = await until('隐藏后立即放回', async () => { const d = await nodeDiag(page); return (d?.counters?.released?.['yield-hidden'] ?? 0) >= 1 ? d : null; }, 30_000, 50);
    await delay(1500);
    const whileHidden = await nodeDiag(page);
    await page.bringToFront();
    await other.close().catch(() => {});
    const after3 = await until('回到前台后恢复并做完第三张卡的流任务', async () => { const d = await nodeDiag(page); return d?.counters?.streamTasks >= 3 && d.counters.completed >= before1.counters.completed + 2 ? d : null; }, 900_000, 500);
    out.steps.hidden = {
      clip: clip3, hidden: !!hidden,
      baking: baking3 && { frames: baking3.streams.frames, done: streamHold(baking3)?.done ?? null },
      released: releasedHidden && { released: releasedHidden.counters.released, frames: releasedHidden.streams.frames, yields: releasedHidden.streams.yields },
      whileHidden: whileHidden && { frames: whileHidden.streams.frames, claims: whileHidden.counters.claims, state: whileHidden.state },
      after: after3 && { counters: after3.counters, frames: after3.streams.frames, segments: after3.streams.segments },
    };
    check(hidden, 'H:页面真的变成了隐藏(另开一个标签并切过去)');
    check(releasedHidden && releasedHidden.counters.released['yield-hidden'] >= 1, 'H:页面隐藏后立即放回(yield-hidden)', out.steps.hidden.released);
    check(releasedHidden && before1 && releasedHidden.streams.yields === before1.streams.yields, 'H:这一次是中止,不是等当前帧做完再停(宿主那一侧没有记让路)', { yields: releasedHidden?.streams?.yields, before: before1?.streams?.yields });
    check(whileHidden && releasedHidden && whileHidden.streams.frames === releasedHidden.streams.frames && whileHidden.counters.claims === releasedHidden.counters.claims, 'H:隐藏期间不认领、不产帧', out.steps.hidden.whileHidden);
    check(after3 && after3.counters.failed === 0 && after3.streams.segments === 16, 'H:回到前台后恢复并做完(不计失败;三张卡一共 16 个分段)', out.steps.hidden.after);
  }

  const final = await nodeDiag(page);
  out.steps.final = final && { counters: final.counters, streams: final.streams, stage: { frames: final.stage?.frames, errors: final.stage?.errors, frameMs: final.stage?.frameMs }, manifests: final.manifests, upload: { pushed: final.upload?.pushed, skipped: final.upload?.skipped, failed: final.upload?.failed } };
  out.timings.pixelsMs = final?.streams?.pixelsMs ?? null;
  out.timings.encodeMs = final?.streams?.encodeMs ?? null;
  out.timings.stageFrameMs = final?.stage?.frameMs ?? null;
  check((final?.manifests?.failed ?? 0) === 0, '清单写内容库没有失败', final?.manifests);
  check(pageErrors.length === 0, '页面没有未捕获的错误', pageErrors.slice(0, 5));
  out.ok = fails.length === 0;
} catch (e) {
  fails.push(`异常:${String(e?.stack ?? e).slice(0, 800)}`);
  try { if (debugProbe) out.steps.atFailure = await debugProbe(); } catch { /* 页面不在了 */ }
} finally {
  try { chk?.close(); } catch { /* 已关 */ }
  try { await refPipeline?.close(); } catch { /* 已关 */ }
  try { await browser?.close(); } catch { /* 已关 */ }
  try { await editor?.stop(); } catch { /* 已停 */ }
  try { await hostedProxy?.close(); } catch { /* 已关 */ }
  try { await combo?.close?.(); } catch { /* 已关 */ }
  if (!KEEP) try { fs.rmSync(path.join(TMP, 'hosted'), { recursive: true, force: true }); } catch { /* 留着 */ }
}
out.fails = fails;
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(fails.length ? 1 : 0);
