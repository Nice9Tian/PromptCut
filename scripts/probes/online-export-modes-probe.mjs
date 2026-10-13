/**
 * 在线浏览器导出分「快速导出」「完整导出」(语义 `docs/semantics/product/platforms.md`「在线浏览器」的「导出」,用户 2026-10-13 定)的端到端验收。
 *
 *   node scripts/probes/online-export-modes-probe.mjs [--dist <在线构建目录>] [--base-port 27220] [--out <目录>] [--shots <截图目录>] [--keep-temp]
 *        端口(整段 +0～+19):+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务、+10～+12 独立渲染主机(及它的舞台端口)。都只绑 127.0.0.1。
 *
 * 角色都在本机,页面用**在线构建**(进项目走「刷新后回到项目」那条产品路径):
 *   - 文档服务 + 素材服务:进程内的托管组合,经本机托管代理 `lib/hosted-proxy.mjs` 开三个同站跨源的源;
 *   - 在线页面:电脑身份(会自己产单卡轨道流);
 *   - 渲染节点:独立渲染主机(`scripts/render-host.mjs`,不带编辑界面的预渲染进程;它从内容库同步用户卡的源码),只在第三步起。
 *
 * 项目 1280×720、30 帧每秒、3 秒(90 帧),五张卡(自下而上):
 *   L  轻卡 `punch-pill`(整段);
 *   A  本页能跑的重卡 `probe-slow-stepped`(第 12～56 帧,3 个分段),本页很快把它的流产到满密度;
 *   B  本页能跑的重卡 `probe-slow-stepped`、人为拖慢(第 30～59 帧,2 个分段),稀疏版先有、满密度要等很久;
 *   G  依赖下层的卡 `chapter-bar`(毛玻璃,整段),压在上面三张上;
 *   S  本页不执行的卡:同步来的用户卡 `xe-synced`(源码在内容库里;编辑页面的注册表里没有它,导出页不执行它的代码)。第二步才放上时间轴。
 *
 * 步骤与断言(任一不成立退出码 1;耗时只记录):
 *   一 没有 S、没有渲染节点。等 A 满密度、B 的稀疏版齐。
 *      完整导出一遍、快速导出一遍(都逐帧拷出合成结果):
 *        - 快速导出里 A 的每一帧取的是流(按片段计数:45 张),A 整段不由导出页活渲(只挂包裹层);B 没有满密度的分段照旧逐帧渲;
 *        - 完整导出一张流都没取;两遍都没有请渲染节点;
 *        - 快速导出对完整导出逐帧比:取流的帧有差(压缩过的视频)、差在预期之内;没取流的帧(B 活渲、L、G)所在的帧里其余像素不跳。
 *   二 把 S 放上时间轴。界面:点「导出视频」先出两个选项(截图);选「完整导出」,进度窗口里说清楚在等渲染节点(截图),取消。
 *      探针入口再核一次:没有渲染节点在线时两种方式都停在等待、提示原文是「没有渲染节点在线」那一句,不出半截的成片。
 *   三 起渲染主机。完整导出两遍:
 *        - 等到渲染节点把 S 逐帧渲完才开始(等待提示里出现过「正在逐帧渲染」);S 的每一帧贴的是节点渲的位图(计数 = S 的帧数);
 *        - 内容库里有导出位图的清单(`export-frames`),素材服务 `px` 里每张 PNG 都在;层表里没有多出导出用的行;
 *        - 两遍逐帧逐字节相同(确定性);
 *        - 对桌面导出(同一台主机的编辑器上跑 `scripts/export-frames.mjs`,同一份项目)逐帧比,差多少记进输出。
 *   四 等 B 也满密度。快速导出两遍:A、B 的每一帧都取流、都不活渲;S 取位图(没有流);两遍逐帧逐字节相同;对完整导出的差记进输出。
 *
 * 输出:过程写 stderr;stdout 最后一行一行 JSON `{ ok, fails, steps, diffs, timings }`;截图在 `--shots`(缺省 `--out/shots`)。不打印令牌、口令。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PNG } from 'pngjs';
import dnsShim from './lib/localhost-dns.cjs'; // Node 这边也认得 *.localhost(托管组合对外说的是 pc.localhost)
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';
import { resumeRecord, plantResume } from './lib/online-resume-entry.mjs';
import { startRenderHost, viteBin, portFree } from './m8/procs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const KEEP = argv.includes('--keep-temp');
/** 排障用:做到第几步为止(`one` / `two` / `three`;不给 = 全做) */
const STOP_AFTER = arg('--until', null);
class StopHere extends Error {}
const BASE = Number(arg('--base-port', 27220));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4, host: BASE + 10 };
const BAND = [BASE, BASE + 19];
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const ORIGINS = proxyOrigins(PORTS.editor);
const SITE = ORIGINS.editor;
const HOSTED = `${SITE}/hosted/`;
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-export-modes-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'out')));
const SHOTS = path.resolve(arg('--shots', path.join(OUT, 'shots')));
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
const deadline = Date.now() + 80 * 60_000;
process.env.NODE_OPTIONS = dnsShim.withLocalhostDns(process.env.NODE_OPTIONS);

const PROJECT = { width: 1280, height: 720, fps: 30, duration: 3 };
const FPS = PROJECT.fps, TOTAL = PROJECT.duration * FPS;
const CLIPS = {
  // L 不设框(铺满舞台):页面要是把它也判重、产了流,框设小了药丸会被流的矩形(框外扩 32 像素)裁掉一截
  L: { id: 'xe-light', cardId: 'punch-pill', start: 0, end: 3, params: { text: `导出探针 ${RUN}` } },
  // 探针卡把橙块画在自己框里的 (480, 420) 起 320×240 的地方:A 不设框(铺满舞台),B 的框整个上移 360(橙块落在画面上半),两张不重叠。
  // (单卡流只装得下「框外扩 32 像素」以内的画面,框设小了橙块会落在流的矩形外面,预览里贴流时同样看不到)
  A: { id: 'xe-heavy-a', cardId: 'probe-slow-stepped', start: 0.4, end: 1.9, params: { burnMs: 40, label: 'A' } },
  B: { id: 'xe-heavy-b', cardId: 'probe-slow-stepped', start: 1.0, end: 2.0, params: { burnMs: 900, label: 'B' }, frame: { x: 0, y: -360, w: 1280, h: 720, anchor: [0, 0] } },
  G: { id: 'xe-glass', cardId: 'chapter-bar', start: 0, end: 3, params: {} },
  S: { id: 'xe-synced-clip', cardId: 'xe-synced', start: 0.2, end: 2.2, params: { tint: '#ff8800' }, frame: { x: 900, y: 560, w: 520, h: 240, anchor: [0.5, 0.5] } },
};
/** 片段盖住的项目帧(同 `src/export/cardLayers.ts` 的 `clipFrameWindow`) */
const windowOf = (c) => { const first = Math.ceil(c.start * FPS - 1e-9); return { first, last: Math.min(TOTAL - 1, first + Math.ceil((c.end - c.start - (first / FPS - c.start)) * FPS - 1e-9) - 1) }; };
const WIN = Object.fromEntries(Object.entries(CLIPS).map(([k, c]) => [k, windowOf(c)]));
const COUNT = Object.fromEntries(Object.entries(WIN).map(([k, w]) => [k, w.last - w.first + 1]));

const SYNCED_KEY = 'src/cards/user/xe-synced.tsx';
const SYNCED_SOURCE = `/** 导出探针:同步来的用户卡(画面只由时间和参数决定) */
import type { CardDef, CardProps } from "../../kernel/types";
(globalThis as any).__pcXeMark = ((globalThis as any).__pcXeMark ?? 0) + 1;
interface Params { tint: string }
function XeSynced({ params, t }: CardProps<Params>) {
  const sec = t ?? 0;
  return <div data-xe-synced="1" className="absolute inset-0" style={{ background: "rgba(20,30,60,0.55)", borderRadius: 18 }}>
    <div style={{ position: "absolute", left: 24 + Math.round(sec * 140), top: 28, width: 150, height: 80, background: params.tint, borderRadius: 14 }} />
    <div style={{ position: "absolute", left: 28, top: 136, color: "#ffffff", fontSize: 44, fontWeight: 700, fontFamily: "Arial, sans-serif" }}>SYNC {Math.round(sec * 30)}</div>
  </div>;
}
export const xeSynced: CardDef<Params> = {
  id: "xe-synced", name: "导出探针同步卡", description: "在线导出探针用", frameMode: "direct",
  defaults: { tint: "#ff8800" },
  controls: [{ key: "tint", label: "颜色", type: "color" }],
  Component: XeSynced,
};
`;

const fails = [];
const out = { ok: false, run: RUN, site: SITE, out: OUT, shots: SHOTS, steps: {}, diffs: {}, timings: {} };
let tag = '';
const check = (cond, label, extra) => { if (!cond) fails.push(`${tag}${label}` + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 700)}`)); return !!cond; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
async function until(label, fn, timeoutMs, everyMs = 500) {
  const end = Math.min(Date.now() + timeoutMs, deadline);
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) { fails.push(`${tag}超时:${label}`); return null; }
    await delay(everyMs);
  }
}

/* ================================================================== 本机站点 */

let combo = null, hostedProxy = null, browser = null, host = null, chk = null;
async function startLocalSite() {
  for (const p of [PORTS.editor, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset, PORTS.host, PORTS.host + 1, PORTS.host + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
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
  say('local.up', { site: SITE, doc: PORTS.doc, asset: PORTS.asset, dist });
  return dist;
}

/** 替创建者写进空项目、把同步卡的源码写进内容库(页面角色的连接;渲染角色写不了卡片源码) */
async function seedProject({ projectId, creator, name }) {
  const { buildAuthProtocols } = await import('../../server/auth/client.mjs');
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId, username: creator.username, deviceId: 'xem-seed-node-0001', deviceName: 'probe-seed', as: 'creator', password: creator.password, role: 'page' });
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
    const put = await ask({ type: 'content.put', kind: 'card-source', key: SYNCED_KEY, body: SYNCED_SOURCE });
    const bad = (m) => /error|reject/i.test(String(m?.type ?? ''));
    return { ok: !bad(opened) && !bad(seeded) && put?.type === 'content.stored', put: put?.type };
  } finally { ws.close(); }
}

/* ================================================================== 页面 */

const EVAL_TIMEOUT_MS = 30_000;
const P = (page, fn, ...a) => Promise.race([page.evaluate(fn, ...a), delay(EVAL_TIMEOUT_MS).then(() => { throw new Error('页面 30 秒没应答'); })]);
const store = (page, src, ...a) => P(page, (s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
const LAUNCH_ARGS = ['--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--site-per-process', '--window-position=-32000,-32000'];

async function openMember({ projectId, name, username, password, deviceId }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e).slice(0, 240)));
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  await plantResume(page, await resumeRecord({ base: HOSTED, derivationBase: `${DOC_DIRECT}/`, projectId, name, username, password, deviceId }));
  await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const entered = await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 120_000 }).then(() => true, () => false);
  if (!check(entered, `${username} 进入项目`)) throw new Error(`${username} 没进去`);
  await until(`${username} 的页面双舞台握上手`, async () => P(page, () => { const d = window.__pcPreviewDiag?.(); return d?.dual && d.onlineStages?.handshake === 'ok'; }), 120_000, 500);
  return { ctx, page };
}

/** 往时间轴上放卡(轨道数组里靠前的在上面);`keys` 是这一次新加的 */
const addClips = (page, keys) => store(page, `
  const clips = args[0];
  S.actions.editCardProject((p) => ({ ...p, duration: args[1],
    tracks: [...clips.map((c) => ({ id: 't-' + c.id, name: '序列 ' + c.id, clips: [c] })), ...p.tracks] }));
  S.actions.seek(args[1] - 0.01);
  S.actions.select([]);
  const p = S.getState().project;
  return { id: p.id, clips: p.tracks.flatMap((t) => t.clips.map((c) => c.id)) };`, keys.map((k) => CLIPS[k]), PROJECT.duration);

/** 这张卡的流此刻的样子:层表的行、每个分段是稀疏还是满密度(按候选逐个看,取满密度最多的那一个) */
async function streamState(content, docId, clipId) {
  const body = (await content.get('snapshot-manifest', `layers:${docId}`).catch(() => null))?.body ?? null;
  const row = (body?.streams ?? []).find((r) => r.topClipId === clipId && r.clipIds?.length === 1) ?? null;
  if (!row) return { row: null, dense: 0, sparse: 0, segments: 0, exportRows: (body?.streams ?? []).filter((r) => r.kind && !['card', 'group', 'below'].includes(r.kind)).length, rows: (body?.streams ?? []).length };
  let best = { dense: -1, sparse: 0 };
  for (const c of row.candidates ?? []) {
    let dense = 0, sparse = 0;
    for (let from = 0; from <= row.lastSegment; from += row.segmentsPerTask) {
      const to = Math.min(row.lastSegment, from + row.segmentsPerTask - 1);
      const m = (await content.get('render-manifest', `${c.resultKey}:${from}-${to}`).catch(() => null))?.body ?? null;
      for (const seg of Object.values(m?.segments ?? {})) { if (seg.stride === 1) dense++; else sparse++; }
    }
    if (dense > best.dense) best = { dense, sparse, resultKey: c.resultKey };
  }
  return { row: { kind: row.kind, plane: row.plane, originFrame: row.originFrame, lastSegment: row.lastSegment }, segments: row.lastSegment + 1, ...best, rows: (body?.streams ?? []).length };
}

/** 在页面上跑一次导出(探针入口,照正式导出取卡片画面的来源),每一帧拷一张 PNG 回来 */
async function runExport(page, mode, { waitLimit = 400, capture = true } = {}) {
  const t0 = Date.now();
  const r = await page.evaluate(async (o) => {
    try { return await window.__pcIo.exportVideoBrowser(o); } catch (e) { return { result: null, waits: [], error: String(e?.message ?? e) }; }
  }, { originals: true, mode, waitLimit, capture: capture ? Array.from({ length: TOTAL }, (_, i) => i) : [] });
  const frames = [];
  for (let i = 0; i < TOTAL; i++) {
    const url = r?.captures?.[i];
    frames.push(url ? Buffer.from(url.slice(url.indexOf(',') + 1), 'base64') : null);
  }
  return { ms: Date.now() - t0, result: r?.result ?? null, waits: r?.waits ?? [], error: r?.error ?? null, cancelled: !!r?.cancelled, frames, mp4Bytes: r?.base64 ? Math.floor(r.base64.length * 0.75) : 0 };
}

/* ================================================================== 比像素 */

const decode = (buf) => { const png = PNG.sync.read(buf); return { w: png.width, h: png.height, data: png.data }; };
/** 铺到黑底上(桌面导出的帧是带透明的;浏览器合成的帧底色是黑) */
function flatten(img) {
  const { w, h, data } = img;
  const outData = Buffer.alloc(w * h * 3);
  for (let i = 0, o = 0; i < w * h * 4; i += 4, o += 3) { const a = data[i + 3] / 255; outData[o] = Math.round(data[i] * a); outData[o + 1] = Math.round(data[i + 1] * a); outData[o + 2] = Math.round(data[i + 2] * a); }
  return { w, h, rgb: outData };
}
/** 两帧的差:最大差、有差的像素数、差超过 8 / 32 的像素数、平均绝对误差、PSNR;`rect` 只看这一块(舞台像素) */
function diffOf(a, b, rect = null) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return null;
  const x0 = rect ? Math.max(0, rect.x) : 0, y0 = rect ? Math.max(0, rect.y) : 0;
  const x1 = rect ? Math.min(a.w, rect.x + rect.w) : a.w, y1 = rect ? Math.min(a.h, rect.y + rect.h) : a.h;
  let max = 0, differ = 0, over8 = 0, over32 = 0, sum = 0, sq = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * a.w + x) * 3;
    const d = Math.max(Math.abs(a.rgb[i] - b.rgb[i]), Math.abs(a.rgb[i + 1] - b.rgb[i + 1]), Math.abs(a.rgb[i + 2] - b.rgb[i + 2]));
    const e = Math.abs(a.rgb[i] - b.rgb[i]) + Math.abs(a.rgb[i + 1] - b.rgb[i + 1]) + Math.abs(a.rgb[i + 2] - b.rgb[i + 2]);
    sum += e; sq += (a.rgb[i] - b.rgb[i]) ** 2 + (a.rgb[i + 1] - b.rgb[i + 1]) ** 2 + (a.rgb[i + 2] - b.rgb[i + 2]) ** 2;
    if (d > max) max = d;
    if (d > 0) differ++;
    if (d > 8) over8++;
    if (d > 32) over32++;
    n++;
  }
  const mse = sq / (n * 3);
  return { max, differ, over8, over32, mae: +(sum / (n * 3)).toFixed(4), psnr: mse ? +(10 * Math.log10((255 * 255) / mse)).toFixed(2) : 99, pixels: n };
}
/** 两组帧逐帧比,汇总;`frames` 只比这些帧 */
function compareRuns(a, b, { frames = null, rect = null } = {}) {
  const per = [];
  for (let i = 0; i < TOTAL; i++) {
    if (frames && !frames.includes(i)) continue;
    if (!a[i] || !b[i]) { per.push({ i, missing: true }); continue; }
    const d = diffOf(flatten(decode(a[i])), flatten(decode(b[i])), rect);
    per.push({ i, ...d });
  }
  const ok = per.filter((p) => !p.missing);
  const worst = [...ok].sort((x, y) => y.mae - x.mae)[0] ?? null;
  return { frames: per.length, missing: per.length - ok.length, identical: ok.filter((p) => p.differ === 0).length, maxDiff: Math.max(0, ...ok.map((p) => p.max)),
    maxDiffer: Math.max(0, ...ok.map((p) => p.differ)), maxOver8: Math.max(0, ...ok.map((p) => p.over8)), maxOver32: Math.max(0, ...ok.map((p) => p.over32)),
    meanMae: ok.length ? +(ok.reduce((s, p) => s + p.mae, 0) / ok.length).toFixed(4) : null, minPsnr: ok.length ? Math.min(...ok.map((p) => p.psnr)) : null, worst };
}
const sameBytes = (a, b) => a.every((buf, i) => !!buf && !!b[i] && buf.equals(b[i]));
const firstDiff = (a, b) => a.findIndex((buf, i) => !buf || !b[i] || !buf.equals(b[i]));
const diffFrames = (a, b) => a.map((buf, i) => (!buf || !b[i] || !buf.equals(b[i]) ? i : -1)).filter((i) => i >= 0);
const saveFrame = (dir, name, buf) => { if (buf) fs.writeFileSync(path.join(dir, name), buf); };
const rangeOf = (w) => Array.from({ length: w.last - w.first + 1 }, (_, i) => w.first + i);

/* ================================================================== 开跑 */

try {
  const dist = await startLocalSite();
  const health = await (await fetch(`${SITE}/hosted/healthz`)).json().catch(() => null);
  if (!check(health?.ok, '托管端 /hosted/healthz', health)) throw new Error('托管端不通');
  const { frameCode } = await import('../../server/frame-code.mjs');
  const codeVersion = frameCode(ROOT);
  const bundle = fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dist, 'assets', f), 'utf8'));
  check(bundle.some((js) => js.includes(codeVersion)), '在线构建嵌的代码版本与本进程算的一致(--dist 要是当前这份源码构建的)', { codeVersion: codeVersion.slice(0, 12) });
  check(!bundle.some((js) => js.includes('xe-synced')), '在线构建里没有同步卡的代码(它只在内容库里)');

  const M = {
    createSharedProject: (await import('../../server/auth/client.mjs')).createSharedProject, wsBaseOf: (await import('../../server/auth/route.mjs')).wsBaseOf,
    normalizeEntry: (await import('../../server/auth/shared-config.mjs')).normalizeEntry, sharedProtocols: (await import('../../server/auth/shared-config.mjs')).sharedProtocols,
    createWsEndpoint: (await import('../../server/render-node/ws-transport.mjs')).createWsEndpoint, createContentClient: (await import('../../server/render-node/content-client.mjs')).createContentClient,
  };
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 1_800_000, args: [...PROBE_CHROME_ARGS, ...LAUNCH_ARGS] });

  // 项目、核对用的连接(创建者,render 角色:读内容库、签素材票据)
  const projName = `导出两种方式-${RUN}`;
  const creator = { username: 'xem-creator', password: `pw-${randomBytes(6).toString('hex')}` };
  const projectPassword = `pp-${randomBytes(6).toString('hex')}`;
  const made = await M.createSharedProject({ base: DOC_DIRECT, name: projName, mode: 'free', creator, password: projectPassword });
  const projectId = made.projectId;
  const seeded = await seedProject({ projectId, creator, name: projName });
  check(seeded.ok, '替创建者写进空项目、把同步卡的源码写进内容库', seeded);
  const chkEntry = M.normalizeEntry({ url: M.wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render',
    deviceId: `xem-chk-${RUN}`.padEnd(16, '0'), deviceName: '导出探针 核对' });
  chk = M.createWsEndpoint({ url: chkEntry.url, protocols: M.sharedProtocols(chkEntry, { role: 'render' }), log: () => {} });
  await new Promise((r) => { if (chk.connected) r(); else chk.onOpen(r); });
  const content = M.createContentClient(chk);
  const ticket = () => new Promise((resolve) => {
    const reqId = `tk-${RUN}-${Math.random().toString(36).slice(2)}`;
    chk.onMessage((msg) => { if (msg?.reqId === reqId) resolve(msg?.type === 'auth.ticket.ok' ? { Authorization: `Bearer ${msg.ticket}` } : {}); });
    chk.send({ type: 'auth.ticket', kind: 'asset', access: 'r', reqId });
  });

  const { page } = await openMember({ projectId, name: projName, username: 'xem-jia', password: projectPassword, deviceId: `xem-jia-${RUN}`.padEnd(16, '0') });
  const synced = await until('同步卡的源码到了本页、在舞台里载入成功', async () => P(page, () => {
    const s = window.__pcCardExecDiag?.()?.run ?? null;
    return s && s['xe-synced']?.state === 'ready' ? s['xe-synced'] : null;
  }), 120_000, 500);
  out.steps.synced = synced ?? await P(page, () => window.__pcCardExecDiag?.() ?? null).catch(() => null);

  /* ---------------- 一:没有 S、没有渲染节点 */
  tag = '[一] ';
  const t1 = Date.now();
  const added = await addClips(page, ['G', 'B', 'A', 'L']);
  const docId = added.id;
  const waitStream = (key, want) => until(`${key} 的流:${want}`, async () => {
    const s = await streamState(content, docId, CLIPS[key].id);
    if (want === 'dense') return s.row && s.dense === s.segments ? s : null;
    return s.row && s.dense + s.sparse === s.segments ? s : null;
  }, 480_000, 1500);
  const aDense = await waitStream('A', 'dense');
  const bSparse = await waitStream('B', 'covered');
  out.steps.one = { streams: { A: aDense, B: bSparse }, waitMs: Date.now() - t1 };
  check(!!aDense && aDense.row.plane === 'local' && aDense.segments === 3, 'A 的单卡流满密度(3 个分段)', aDense);
  check(!!bSparse && bSparse.dense < bSparse.segments, 'B 还有只有稀疏版的分段(探针的前提:B 拖得够慢)', bSparse);
  say('one.streams', { A: aDense, B: bSparse });

  const fast1 = await runExport(page, 'fast');
  const full1 = await runExport(page, 'full');
  const bAfter = await streamState(content, docId, CLIPS.B.id);
  out.timings.fastMixedMs = fast1.ms; out.timings.fullNoSyncedMs = full1.ms;
  out.steps.one.fast = { layers: fast1.result?.layers ?? null, stats: fast1.result?.stats ?? null, error: fast1.error, waits: fast1.waits };
  out.steps.one.full = { layers: full1.result?.layers ?? null, error: full1.error, waits: full1.waits };
  const fl = fast1.result?.layers, ul = full1.result?.layers;
  check(!!fast1.result && fast1.result.frames === TOTAL && fast1.result.mode === 'fast', '快速导出导完了', { error: fast1.error, frames: fast1.result?.frames });
  check(!!full1.result && full1.result.frames === TOTAL && full1.result.mode === 'full', '完整导出导完了', { error: full1.error, frames: full1.result?.frames });
  check(fl?.perClip?.[CLIPS.A.id]?.stream === COUNT.A, `快速导出:A 的 ${COUNT.A} 帧都取的是流`, fl?.perClip);
  check(fl?.wrapperOnly >= 1, '快速导出:A 整段不由导出页活渲(只挂包裹层)', fl);
  const bStream = fl?.perClip?.[CLIPS.B.id]?.stream ?? 0;
  check(bStream < COUNT.B, '快速导出:B 没有满密度流的那几段照旧逐帧渲(没有拿稀疏版顶)', { bStream, total: COUNT.B, before: bSparse, after: bAfter });
  check(bStream % 15 === 0, '快速导出:B 取流的帧数是整分段的(只取满密度的分段)', { bStream });
  check(fl?.nodeClips === 0 && fl?.nodePictures === 0 && ul?.nodeClips === 0, '没有本页不执行的卡:两种方式都没有请渲染节点', { fast: fl, full: ul });
  check(ul?.streamPictures === 0 && ul?.streamClips === 0 && ul?.wrapperOnly === 0, '完整导出:一张流都没取,每张卡都由导出页逐帧渲', ul);
  check(fast1.frames.every(Boolean) && full1.frames.every(Boolean), '两遍都逐帧拷到了合成结果');
  // 快速对完整:取流的帧有差(压缩);没有 A、也没有 B 取流的帧应当一样
  const aFrames = rangeOf(WIN.A);
  // 没有任何一张卡取流的帧(页面把别的卡也判重、产了流的话,它们的帧也不算)
  const winById = Object.fromEntries(Object.values(CLIPS).map((c) => [c.id, windowOf(c)]));
  const streamed = Object.entries(fl?.perClip ?? {}).filter(([, v]) => v.stream > 0).map(([id]) => winById[id]).filter(Boolean);
  const quiet = Array.from({ length: TOTAL }, (_, i) => i).filter((i) => !streamed.some((w) => i >= w.first && i <= w.last));
  out.steps.one.quietFrames = quiet.length;
  out.diffs.fastVsFull_streamFrames = compareRuns(fast1.frames, full1.frames, { frames: aFrames });
  out.diffs.fastVsFull_noStreamFrames = compareRuns(fast1.frames, full1.frames, { frames: quiet });
  check(out.diffs.fastVsFull_streamFrames.maxDiffer > 0, '快速导出取流的帧和完整导出确实不是同一份像素(证明贴的是流)', out.diffs.fastVsFull_streamFrames);
  check(out.diffs.fastVsFull_streamFrames.minPsnr >= 30, '快速导出取流的帧:和完整导出的差在压缩视频的范围内(PSNR ≥ 30)', out.diffs.fastVsFull_streamFrames);
  check(quiet.length === 0 || out.diffs.fastVsFull_noStreamFrames.maxDiffer === 0, '没取流的帧:快速导出与完整导出逐像素相同', out.diffs.fastVsFull_noStreamFrames);
  // 衔接:A 的最后一帧(取流)和它之后一帧;B 取流与活渲交界的两帧 —— 各自对完整导出的同一帧,位置不跳(差超过 32 的像素很少)
  const seam = [WIN.A.first, WIN.A.last, Math.min(TOTAL - 1, WIN.A.last + 1), WIN.B.first, WIN.B.last];
  out.diffs.fastVsFull_seams = seam.map((i) => ({ i, ...diffOf(flatten(decode(fast1.frames[i])), flatten(decode(full1.frames[i]))) }));
  check(out.diffs.fastVsFull_seams.every((d) => d.over32 < 0.01 * d.pixels), '衔接处(取流的头尾、取流与逐帧渲交界):画面不跳', out.diffs.fastVsFull_seams);
  for (const i of [WIN.A.first + 10, WIN.B.first + 5]) { saveFrame(SHOTS, `step1-fast-f${i}.png`, fast1.frames[i]); saveFrame(SHOTS, `step1-full-f${i}.png`, full1.frames[i]); }
  say('one.done', { ms: Date.now() - t1, fast: fl ?? null, full: ul ?? null, fastMs: fast1.ms, fullMs: full1.ms, errors: [fast1.error, full1.error], stats: fast1.result?.stats ?? null });
  if (STOP_AFTER === 'one') throw new StopHere();

  /* ---------------- 二:放上 S,没有渲染节点 */
  tag = '[二] ';
  const t2 = Date.now();
  await addClips(page, ['S']);
  // 等这一步改动被文档服务确认(只为导出的计划按确认的版本发)
  await delay(4000);
  // 界面:点「导出视频」先出两个选项
  await P(page, () => { window.showSaveFilePicker = undefined; });
  const clickText = (text) => P(page, (t) => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').trim() === t || x.getAttribute('title') === t || x.getAttribute('aria-label') === t); if (!b) return false; b.click(); return true; }, text);
  check(await clickText('导出视频'), '找到「导出视频」按钮');
  const dialog = await page.waitForSelector('[data-pc="export-mode-dialog"]', { visible: true, timeout: 15_000 }).catch(() => null);
  if (check(!!dialog, '点导出先出选择导出方式的对话框')) {
    const texts = await P(page, () => [...document.querySelectorAll('[data-pc="export-mode"]')].map((b) => ({ mode: b.getAttribute('data-mode'), name: b.querySelector('.pc-export-mode-name')?.textContent, hint: b.querySelector('.pc-export-mode-hint')?.textContent })));
    out.steps.ui = { options: texts };
    check(texts.length === 2 && texts[0].name === '快速导出' && texts[1].name === '完整导出', '两个选项:快速导出、完整导出', texts);
    check(texts[0]?.hint === '重卡直接用预渲染好的轨道流画面，速度快，画质略低。' && texts[1]?.hint === '每一帧都重新渲染，画质和桌面版一样，速度慢。', '两句说明照草稿', texts);
    await dialog.screenshot({ path: path.join(SHOTS, 'export-mode-dialog.png') });
    await page.screenshot({ path: path.join(SHOTS, 'export-mode-page.png') });
    // 选「完整导出」:没有渲染节点,进度窗口里说清楚在等什么
    await P(page, () => document.querySelector('[data-pc="export-mode"][data-mode="full"]')?.click());
    const waiting = await page.waitForSelector('[data-pc="export-waiting"]', { visible: true, timeout: 60_000 }).catch(() => null);
    const waitingText = waiting ? await P(page, () => document.querySelector('[data-pc="export-waiting"]')?.textContent ?? '') : '';
    out.steps.ui.waiting = waitingText;
    check(/没有渲染节点在线/.test(waitingText) && /1 个片段/.test(waitingText), '进度窗口里说清楚在等渲染节点', waitingText);
    const title = await P(page, () => document.querySelector('.pc-export-title')?.textContent ?? '');
    check(title === '正在完整导出', '进度窗口的标题带着选的方式', title);
    await page.screenshot({ path: path.join(SHOTS, 'export-waiting-node.png') });
    await clickText('取消导出');
    await until('取消后对话框回到「已取消导出」', async () => P(page, () => /已取消/.test(document.querySelector('.pc-export-title')?.textContent ?? '')), 30_000, 300);
    await clickText('关闭');
  }
  // 探针入口再核:两种方式都停在等待,不出半截的成片
  for (const mode of ['full', 'fast']) {
    const r = await runExport(page, mode, { waitLimit: 2, capture: false });
    check(!r.result && r.cancelled && r.mp4Bytes === 0, `${mode}:没有渲染节点时停在等待、没有出成片`, { error: r.error, cancelled: r.cancelled, bytes: r.mp4Bytes });
    check(r.waits.length > 0 && r.waits.every((w) => /没有渲染节点在线/.test(w)), `${mode}:等待提示是「没有渲染节点在线」那一句`, r.waits.slice(0, 2));
    out.steps[`noNode_${mode}`] = { waits: r.waits.slice(0, 1), error: r.error };
  }
  say('two.done', { ms: Date.now() - t2 });
  if (STOP_AFTER === 'two') throw new StopHere();

  /* ---------------- 三:起渲染主机,完整导出 */
  tag = '[三] ';
  const t3 = Date.now();
  const hostDir = path.join(TMP, 'host');
  fs.mkdirSync(hostDir, { recursive: true });
  const config = path.join(hostDir, 'host.json');
  fs.writeFileSync(config, JSON.stringify([{ url: M.wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render',
    deviceId: `xem-host-${RUN}`.padEnd(16, '0'), deviceName: '导出探针 渲染主机' }]));
  host = await startRenderHost({ port: PORTS.host, dir: hostDir, config, maxConcurrent: 2, band: BAND });
  out.timings.hostUpMs = Date.now() - t3;
  say('host.up', { ms: Date.now() - t3 });
  // 一边导出一边看导出页(同源 `?export=1` 的 iframe):它不执行同步卡的代码,这张卡只有包裹层
  const seen = { samples: 0, marks: new Set(), live: false, wrappers: new Set() };
  let exporting = true;
  const watch = (async () => {
    while (exporting) {
      for (const fr of page.frames()) {
        if (!/[?&]export=1/.test(fr.url())) continue;
        const st = await fr.evaluate((id) => ({ mark: globalThis.__pcXeMark ?? null, live: !!document.querySelector('[data-xe-synced]'),
          wrap: [...document.querySelectorAll('[data-pc-clip]')].filter((w) => w.getAttribute('data-pc-clip') === id).map((w) => w.childElementCount) }), CLIPS.S.id).catch(() => null);
        if (st) { seen.samples++; seen.marks.add(String(st.mark)); seen.live ||= st.live; for (const n of st.wrap) seen.wrappers.add(n); }
      }
      await delay(60);
    }
  })();
  const full2 = await runExport(page, 'full');
  exporting = false;
  await watch;
  const topMark = await P(page, () => globalThis.__pcXeMark ?? null);
  out.steps.exportPage = { samples: seen.samples, marks: [...seen.marks], live: seen.live, wrapperChildren: [...seen.wrappers], topMark };
  check(seen.samples > 0 && seen.marks.size === 1 && seen.marks.has('null') && topMark === null, '导出页与编辑页面里都没有执行同步卡的代码(没有它的顶层记号)', out.steps.exportPage);
  check(seen.live === false && seen.wrappers.has(0), '导出页里这张卡只挂了包裹层、里面没有活内容', out.steps.exportPage);
  const full3 = await runExport(page, 'full');
  out.timings.fullMs = [full2.ms, full3.ms];
  const l2 = full2.result?.layers, l3 = full3.result?.layers;
  out.steps.three = { first: { layers: l2, error: full2.error, waits: [...new Set(full2.waits.map((w) => w.replace(/\d+/g, 'N')))] }, second: { layers: l3, error: full3.error, waits: full3.waits.length } };
  check(!!full2.result && full2.result.frames === TOTAL, '完整导出(有本页不执行的卡)导完了', { error: full2.error, waits: full2.waits.slice(-2) });
  check(full2.waits.some((w) => /正在为这次导出逐帧渲染|已接手/.test(w)), '导出前等过渲染节点(提示里出现过节点在渲)', full2.waits.slice(0, 3));
  check(l2?.nodeClips === 1 && l2?.perClip?.[CLIPS.S.id]?.frames === COUNT.S, `S 的 ${COUNT.S} 帧贴的都是渲染节点逐帧渲的位图`, l2);
  check(l2?.streamPictures === 0, '完整导出:一张流都没取', l2);
  check(!!full3.result && l3?.perClip?.[CLIPS.S.id]?.frames === COUNT.S, '第二遍完整导出同样', { error: full3.error, layers: l3 });
  // 两遍不同的帧:列出来,并逐帧量差多少(哪一块在变)
  const fullDiffs = diffFrames(full2.frames, full3.frames);
  out.diffs.fullTwice = { differFrames: fullDiffs, detail: fullDiffs.slice(0, 6).map((i) => ({ i, ...diffOf(flatten(decode(full2.frames[i])), flatten(decode(full3.frames[i]))) })) };
  for (const i of fullDiffs.slice(0, 2)) { saveFrame(SHOTS, `step3-full-run1-f${i}.png`, full2.frames[i]); saveFrame(SHOTS, `step3-full-run2-f${i}.png`, full3.frames[i]); }
  check(full2.frames.every(Boolean) && full3.frames.every(Boolean) && sameBytes(full2.frames, full3.frames), '完整导出两遍逐帧逐字节相同', out.diffs.fullTwice);
  // 内容库与素材服务:导出位图的清单、PNG 块;层表里没有多出导出用的行
  const planEvents = await P(page, () => null).catch(() => null);
  void planEvents;
  const hostQueue = await host.queue().catch(() => null);
  out.steps.three.host = { envFingerprint: hostQueue?.envFingerprint ?? null };
  const { exportFramesKey } = await import('../../server/export-frames.mjs');
  const { resultKeyOf } = await import('../../server/render-node/fingerprint.mjs');
  void exportFramesKey; void resultKeyOf;
  const layerMap = (await content.get('snapshot-manifest', `layers:${docId}`).catch(() => null))?.body ?? null;
  check(!(layerMap?.streams ?? []).some((r) => r.topClipId === CLIPS.S.id && r.kind === 'export-frames') && layerMap?.exports === undefined, '层表里没有导出用的行(这份产物预览不读)', (layerMap?.streams ?? []).map((r) => [r.topClipId, r.kind]));
  // 清单从主机的日志里找不到键,就从页面最近一次取的块反查:素材服务上这次导出取过的 PNG 都在
  const pxGets = hostedProxy.requests.filter((r) => r.role === 'editor' && r.method === 'GET' && /\/px\/[0-9a-f]{64}$/.test(r.path));
  out.steps.three.pxGets = pxGets.length;
  check(pxGets.length >= COUNT.S, '页面按帧从素材服务取了渲染节点渲好的 PNG', { gets: pxGets.length, need: COUNT.S });
  const auth = await ticket();
  const sample = pxGets[pxGets.length - 1]?.path.split('/').pop();
  if (sample) {
    const body = Buffer.from(await (await fetch(`${SITE}/media/api/asset/px/${sample}`, { headers: auth })).arrayBuffer());
    const isPng = body.length > 8 && body.readUInt32BE(0) === 0x89504e47;
    let dims = null;
    try { const d = decode(body); dims = { w: d.w, h: d.h }; } catch { dims = null; }
    out.steps.three.samplePng = { bytes: body.length, isPng, dims };
    check(isPng && !!dims, '取回来的是无损的 PNG(不是压缩视频)', out.steps.three.samplePng);
  }
  for (const i of [WIN.S.first + 3, WIN.A.first + 10, WIN.S.last]) saveFrame(SHOTS, `step3-full-f${i}.png`, full2.frames[i]);

  // 对桌面导出:同一份项目,在这台主机的编辑器上跑桌面的导出脚本(它的导出页有同步来的这张卡)
  const projectJson = await store(page, `return JSON.stringify(S.getState().project);`);
  const deskDir = path.join(OUT, 'desktop');
  fs.mkdirSync(deskDir, { recursive: true });
  const timeline = 'data:application/json,' + encodeURIComponent(projectJson);
  const tDesk = Date.now();
  const deskCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/export-frames.mjs', '--url', `${host.editor}/?export=1&timeline=${encodeURIComponent(timeline)}`, '--out', deskDir, '--fps', String(FPS), '--workers', '1', '--no-video'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const tail = [];
    for (const s of [child.stdout, child.stderr]) s.on('data', (b) => { tail.push(String(b)); if (tail.length > 40) tail.shift(); });
    child.on('close', (code) => { if (code !== 0) say('desktop.export-failed', { code, tail: tail.join('').slice(-800) }); resolve(code); });
    child.on('error', () => resolve(-1));
  });
  out.timings.desktopExportMs = Date.now() - tDesk;
  const deskFramesDir = path.join(deskDir, 'frames');
  const deskFiles = fs.existsSync(deskFramesDir) ? fs.readdirSync(deskFramesDir).filter((f) => f.endsWith('.png')).sort() : [];
  if (check(deskCode === 0 && deskFiles.length === TOTAL, '桌面导出出了同样多的帧', { code: deskCode, frames: deskFiles.length })) {
    const desk = deskFiles.map((f) => fs.readFileSync(path.join(deskFramesDir, f)));
    out.diffs.fullVsDesktop = compareRuns(full2.frames, desk);
    // 分开看:只有本页活渲的那几帧(S 不在场)、S 在场的帧
    const sFrames = rangeOf(WIN.S);
    out.diffs.fullVsDesktop_withSynced = compareRuns(full2.frames, desk, { frames: sFrames });
    out.diffs.fullVsDesktop_withoutSynced = compareRuns(full2.frames, desk, { frames: Array.from({ length: TOTAL }, (_, i) => i).filter((i) => !sFrames.includes(i)) });
    check(out.diffs.fullVsDesktop.missing === 0 && out.diffs.fullVsDesktop.minPsnr >= 30, '完整导出对桌面导出:逐帧比完了,差在光栅差的量级(PSNR ≥ 30;数字见输出)', out.diffs.fullVsDesktop);
    const w = out.diffs.fullVsDesktop.worst?.i ?? WIN.S.first + 3;
    saveFrame(SHOTS, `step3-desktop-f${w}.png`, desk[w]); saveFrame(SHOTS, `step3-full-worst-f${w}.png`, full2.frames[w]);
    saveFrame(SHOTS, `step3-desktop-f${WIN.S.first + 3}.png`, desk[WIN.S.first + 3]);
  }
  say('three.done', { ms: Date.now() - t3, layers: l2, diff: out.diffs.fullVsDesktop });
  if (STOP_AFTER === 'three') throw new StopHere();

  /* ---------------- 四:B 也满密度,快速导出两遍 */
  tag = '[四] ';
  const t4 = Date.now();
  const bDense = await waitStream('B', 'dense');
  out.steps.four = { B: bDense, waitMs: Date.now() - t4 };
  const fast2 = await runExport(page, 'fast');
  const fast3 = await runExport(page, 'fast');
  out.timings.fastMs = [fast2.ms, fast3.ms];
  const f2 = fast2.result?.layers, f3 = fast3.result?.layers;
  out.steps.four.first = { layers: f2, error: fast2.error }; out.steps.four.second = { layers: f3, error: fast3.error };
  check(!!fast2.result && fast2.result.frames === TOTAL, '快速导出(都有满密度流)导完了', { error: fast2.error, waits: fast2.waits.slice(-1) });
  check(f2?.perClip?.[CLIPS.A.id]?.stream === COUNT.A && f2?.perClip?.[CLIPS.B.id]?.stream === COUNT.B, 'A、B 的每一帧都取的是流', f2?.perClip);
  check(f2?.perClip?.[CLIPS.S.id]?.frames === COUNT.S && !(f2?.perClip?.[CLIPS.S.id]?.stream > 0), 'S 没有流:照完整导出的办法,贴渲染节点的位图', f2?.perClip);
  check(f2?.wrapperOnly >= 3 && f2?.streamClips >= 2 && f2?.nodeClips === 1, 'A、B、S 三张都不由导出页活渲(只挂包裹层;页面把别的卡也判重、产满了流的话它也算在内)', f2);
  out.diffs.fastTwice = { differFrames: diffFrames(fast2.frames, fast3.frames) };
  check(!!fast3.result && fast2.frames.every(Boolean) && sameBytes(fast2.frames, fast3.frames), '快速导出两遍逐帧逐字节相同', { ...out.diffs.fastTwice, error: fast3.error });
  out.diffs.fastVsFull = compareRuns(fast2.frames, full2.frames);
  out.diffs.fastVsFull_bFrames = compareRuns(fast2.frames, full2.frames, { frames: rangeOf(WIN.B) });
  check(out.diffs.fastVsFull.minPsnr >= 30, '快速导出对完整导出:差在压缩视频的范围内(PSNR ≥ 30;数字见输出)', out.diffs.fastVsFull);
  check(fast2.ms < full2.ms, '快速导出比完整导出快(只记录:两个数见输出)', { fast: fast2.ms, full: full2.ms });
  for (const i of [WIN.B.first + 5, WIN.A.first + 10]) saveFrame(SHOTS, `step4-fast-f${i}.png`, fast2.frames[i]);
  saveFrame(SHOTS, `step4-full-f${WIN.B.first + 5}.png`, full2.frames[WIN.B.first + 5]);
  say('four.done', { ms: Date.now() - t4, perClip: f2?.perClip });

  tag = '';
  check(page.errors.length === 0, '页面没有未捕获的错误', page.errors.slice(0, 3));
  out.ok = fails.length === 0;
} catch (e) {
  if (e instanceof StopHere) out.stoppedAfter = STOP_AFTER;
  else fails.push(`异常:${String(e?.stack ?? e).slice(0, 800)}`);
} finally {
  try { await browser?.close(); } catch { /* 已关 */ }
  try { await host?.stop(); } catch { /* 已停 */ }
  try { chk?.close?.(); } catch { /* 已关 */ }
  try { await hostedProxy?.close(); } catch { /* 已关 */ }
  try { await combo?.close?.(); } catch { /* 已关 */ }
  if (!KEEP) try { fs.rmSync(path.join(TMP, 'hosted'), { recursive: true, force: true }); fs.rmSync(path.join(TMP, 'host'), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 留着 */ }
}
out.fails = fails;
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(fails.length ? 1 : 0);
