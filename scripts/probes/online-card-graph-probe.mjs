/**
 * 图卡在线执行的探针(块 G;契约 `docs/plan/online-card-exec-contract.md` 第 4 节、第 13A 节;任务书
 * `docs/plan/sound-online-render-task.md` 第 15 条里「带视频输入源的图卡」「图形能力不够的卡退回原做法」两句)。
 *
 *   npx vite build --mode online
 *   node scripts/probes/online-card-graph-probe.mjs [--dist dist-online] [--base-port 5720] [--doc-port 8796] [--asset-port 8797] [--out <截图目录>]
 *
 * 全程在本机、不连任何远端:本机托管组合(素材服务真核票据) + 仿 nginx 的代理 `lib/hosted-proxy.mjs`(带全套策略头的摆法) + 在线构建。
 * 创建者把一张带视频输入源的图卡(反色滤镜,`src/cards/user/ocg-invert.tsx`)的源码写进内容库,把一段纯色视频与一段解不了的「视频」
 * 传进素材服务;在线成员页加入,没有任何预渲染产物。
 *
 * # 验收标准(每条一行「过 / 不过」,最后一行是 JSON `{ ok, pass, fail, fails }`;退出码 = 有没有「不过」)
 *
 * G1 隔离生效、图形能力够(真显卡):图卡在两台舞台里载入成功(运行状态 `ready`),两台的图形能力都是 `ok`;
 *    可见舞台把这段素材的画面换成图卡的输出 —— 截图取片段中心的像素,是视频那一帧颜色的反色(容差 ±24);
 *    视频经舞台自己源上的 `/media-s/<会话号>/media/<哈希>` 按 Range 取(应答 206),请求里不带 `?t=`,舞台里的 `<video>` 地址不带票据;
 *    不显示「需要本地 PC 渲染辅助」,时间轴不挂徽标;没有页面错误。
 * G2 改参数即时生效:把反色强度从 1 改成 0,同一个像素变回视频的原色。
 * G3 输入解不了:另一段素材的字节不是视频,套同一张图卡 —— 这张卡的运行状态变成 `media`(这台设备解不了这段素材),
 *    参数面板的说明是那一句;它不再在舞台里运行(两段都退回原做法),舞台没有垮(内置卡照常画)。
 * G4 图形能力不够(另起一个 `--disable-gpu` 的浏览器,软件渲染):图卡的运行状态是 `gpu`,两台舞台报的图形能力是 `software`;
 *    片段退回原做法(舞台不挂图卡的画布);同一个项目里的内置卡照常画;没有页面错误。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';
import { seedSharedProject } from './lib-seed.mjs';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';
import { normalizeEntry, sharedProtocols } from '../../server/auth/shared-config.mjs';
import { createWsEndpoint } from '../../server/render-node/ws-transport.mjs';
import { createContentClient } from '../../server/render-node/content-client.mjs';
import { wsBaseOf } from '../../server/auth/route.mjs';
import { createAssetClient } from '../../server/asset-store/client.mjs';
import { findFfmpeg } from '../../server/bakery/index.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const BASE = Number(arg('--base-port', 5720));
const DOC_PORT = Number(arg('--doc-port', 8796)), ASSET_PORT = Number(arg('--asset-port', 8797));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'online-card-graph-shots')));
const ORIGINS = proxyOrigins(BASE);
const DOC_DIRECT = `http://127.0.0.1:${DOC_PORT}`;
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
let pass = 0;
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s === undefined ? '' : (s.length > 400 ? `${s.slice(0, 400)}…` : s).replace(/v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'v1.***'); };
const check = (label, ok, detail) => { console.log(`${ok ? '  过' : '不过'}  ${label}${detail !== undefined ? `  〔${short(detail)}〕` : ''}`); if (ok) pass++; else fails.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30_000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { check(`等到:${what}`, false, `${ms} ms 没等到`); return null; }
    await sleep(every);
  }
}

/* ------------------------------------------------------------------ 素材:一段纯色视频(2 秒,320×180,H.264) */
const COLOR = [200, 40, 40];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'online-card-graph-'));
const ffmpeg = await findFfmpeg();
if (!ffmpeg) { console.log(JSON.stringify({ ok: false, pass: 0, fail: 1, fails: ['找不到 ffmpeg,造不出视频素材'] })); process.exit(1); }
const videoFile = path.join(tmp, 'solid.mp4');
{
  const hex = COLOR.map((c) => c.toString(16).padStart(2, '0')).join('');
  const r = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=320x180:r=30:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoFile], { windowsHide: true, timeout: 60_000 });
  if (r.status !== 0) { console.log(JSON.stringify({ ok: false, pass: 0, fail: 1, fails: ['ffmpeg 造视频失败'] })); process.exit(1); }
}

const CARD_ID = 'ocg-invert';
const CARD_SOURCE = `import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

interface Params { amount: number }

export const ocgInvert: CardDef<Params> = {
  id: "${CARD_ID}",
  name: "探针反色滤镜",
  description: "把输入画面按强度混向它的反色",
  source: "user",
  tags: ["探针"],
  kind: "filter",
  frameMode: "direct",
  inputs: { source: { description: "要处理的画面" } },
  defaults: { amount: 1 },
  controls: [{ key: "amount", label: "强度", type: "number", min: 0, max: 1, step: 0.01 }],
  card: (sources, t, params) => glsl(
    \`uniform sampler2D u_input0;
     uniform float amount;
     void main() {
       vec4 c = texture(u_input0, v_uv);
       outColor = vec4(mix(c.rgb, 1.0 - c.rgb, amount), c.a);
     }\`,
    [sources.source.at(t)],
    { amount: params.amount },
  ),
};
`;

/* ------------------------------------------------------------------ 托管组合、项目、内容库、素材 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-card-graph-hosted-'));
const combo = await startHostedCombo({
  dataDir, docPort: DOC_PORT, assetPort: ASSET_PORT, host: '127.0.0.1', trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'),
  docPublicUrl: `ws://pc.localhost:${BASE}/hosted/`, assetPublicUrl: `${ORIGINS.editor}/media/api/asset`, log: () => {},
});
const NAME = `ocg-${Date.now().toString(36)}`;
const creator = { username: 'boss', password: `boss-${randomBytes(9).toString('hex')}` };
const PROJECT_PW = `pw-${randomBytes(9).toString('hex')}`;
const made = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });
const seeded = await seedSharedProject({ base: DOC_DIRECT, projectId: made.projectId, creator, name: NAME });
check('准备:替创建者写进空项目', seeded.ok === true, seeded);
let VIDEO_HASH = '', BAD_HASH = '';
{
  const entry = normalizeEntry({ url: wsBaseOf(DOC_DIRECT), projectId: made.projectId, username: creator.username, password: creator.password, as: 'creator', role: 'page', deviceId: 'ocg-probe-content1', deviceName: 'ocg-probe content' });
  const ep = createWsEndpoint({ url: entry.url, protocols: sharedProtocols(entry, { role: 'page' }), log: () => {} });
  await new Promise((r) => { if (ep.connected) r(); else ep.onOpen(r); });
  const put = await createContentClient(ep).put('card-source', `src/cards/user/${CARD_ID}.tsx`, CARD_SOURCE).catch((e) => ({ error: String(e?.message ?? e) }));
  check('准备:创建者把图卡源码写进内容库', !put?.error, put?.error);
  try { ep.close?.(); } catch { /* 已经关了 */ }
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId: made.projectId, username: creator.username, deviceId: 'ocg-probe-node-01', deviceName: 'probe-node', as: 'creator', password: creator.password, role: 'page' });
  const ws = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const tk = await new Promise((resolve) => { ws.addEventListener('message', (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === 't1') resolve(m); }); ws.send(JSON.stringify({ type: 'auth.ticket', kind: 'asset', access: 'rw', reqId: 't1' })); });
  const assets = createAssetClient({ base: `http://127.0.0.1:${ASSET_PORT}/api/asset`, ticket: () => tk.ticket });
  VIDEO_HASH = (await assets.put('media', fs.readFileSync(videoFile), { ext: 'mp4' })).hash;
  BAD_HASH = (await assets.put('media', Buffer.concat([Buffer.from('this is not a video file. '), randomBytes(4096)]), { ext: 'mp4' })).hash;
  check('准备:一段纯色视频与一段解不了的「视频」传进素材服务', /^[0-9a-f]{64}$/.test(VIDEO_HASH) && /^[0-9a-f]{64}$/.test(BAD_HASH), { video: fs.statSync(videoFile).size });
  ws.close();
}

const proxy = await startHostedProxy({ dist: DIST, basePort: BASE, docPort: DOC_PORT, assetPort: ASSET_PORT, policy: 'full' });
const browsers = [];
async function launch(extra = []) {
  const b = await puppeteer.launch({ headless: true, protocolTimeout: 600_000,
    args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--mute-audio', '--window-position=-32000,-32000', '--site-per-process', '--force-device-scale-factor=1', ...extra] });
  browsers.push(b);
  return b;
}
let clipsAdded = false;
async function openMember(browser, tag) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('dialog', (d) => void d.accept());
  const pageErrors = [], refused = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  page.on('console', (msg) => { const t = msg.text(); if (/Refused to|violates the following Content Security Policy/i.test(t)) refused.push(t.slice(0, 200)); });
  const typeInto = async (sel, value) => { await page.waitForSelector(sel, { visible: true, timeout: 30_000 }); await page.click(sel, { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type(sel, value, { delay: 5 }); };
  await page.goto(`${ORIGINS.editor}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  await typeInto('[data-pc="join-name"]', NAME);
  await typeInto('[data-pc="join-username"]', `m-${tag.toLowerCase()}`);
  await typeInto('[data-pc="join-password"]', PROJECT_PW);
  await page.click('[data-pc="join-submit"]');
  await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
  await until(`${tag} 时间轴`, () => page.evaluate(() => !!window.__pcStore), 30_000);
  await until(`${tag} 页面认出同步来的图卡`, () => page.evaluate((id) => !!window.__pcCardSources?.()?.cards?.some((c) => c.id === id), CARD_ID), 60_000, 500);
  if (!clipsAdded) {
    clipsAdded = true;
    // 时间轴:0~2 秒 好视频套图卡;4~6 秒 一张内置卡;8~10 秒 解不了的「视频」套同一张图卡(先不放,G3 再放)
    await page.evaluate((hash, cardId) => {
      const S = window.__pcStore;
      S.actions.addClipOnNewTrack({ index: 0, cardId: 'punch-pill', start: 4, duration: 2 });
      const m = S.actions.addMedia({ kind: 'video', name: 'solid.mp4', url: '/@media/' + hash, hash, ext: 'mp4', size: 1000, width: 320, height: 180, duration: 2 });
      S.actions.editCardProject((p) => ({ ...p, duration: Math.max(p.duration, 12),
        cardNodes: [...(p.cardNodes ?? []), { id: 'ocg-n1', adapter: 'card', cardId, kind: 'filter', inputs: { source: '@clip/ocg-clip/source' }, params: { amount: 1 } }],
        tracks: [{ id: 'ocg-t1', name: '图卡', clips: [{ id: 'ocg-clip', mediaId: m.id, cardId, nodeId: 'ocg-n1', start: 0, end: 2, params: { amount: 1 } }] }, ...p.tracks] }));
    }, VIDEO_HASH, CARD_ID);
  }
  await page.evaluate(() => window.__pcStore.actions.seek(1));
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && !f.detached);
  const diag = () => page.evaluate((id) => {
    const d = window.__pcCardExecDiag?.(), p = window.__pcPreviewDiag?.();
    if (!d) return null;
    return { cardExec: p?.cardExec ?? null, dual: p?.dual, run: d.run?.[id] ?? null, per: Object.fromEntries(Object.entries(d.stages).map(([k, v]) => [k, (v.states.find((s) => s[0] === id) ?? [null, null])[1]])),
      graph: Object.fromEntries(Object.entries(d.stages).map(([k, v]) => [k, v.graph])), bundles: d.bundles };
  }, CARD_ID).catch(() => null);
  /** 可见舞台里某个片段包裹层的状况 */
  const clipIn = async (clipId) => {
    const out = [];
    for (const f of stageFrames()) {
      out.push(await f.evaluate((id) => {
        const role = window.__pcStageDiag?.().role ?? null;
        const el = document.querySelector(`[data-pc-clip="${id}"]`);
        if (!el) return { role, mounted: false };
        const r = el.getBoundingClientRect();
        return { role, mounted: true, canvas: el.querySelectorAll('canvas').length, graphNode: !!el.querySelector('[data-pc-graph-node]'), error: el.querySelector('[data-pc-card-error]')?.getAttribute('data-pc-card-error') ?? null,
          placeholder: [...el.querySelectorAll('[data-pc-placeholder-slot]')].some((s) => !s.hidden), children: el.childElementCount, rect: [r.x, r.y, r.width, r.height],
          videos: [...document.querySelectorAll('video')].map((v) => v.getAttribute('src') ?? v.currentSrc ?? '').filter(Boolean) };
      }, clipId).catch(() => ({ role: null, mounted: false })));
    }
    return out;
  };
  /** 截图取预览区中心那一个像素(可见舞台的 iframe 中心) */
  const centerPixel = async (name) => {
    const box = await page.evaluate(() => { const els = [...document.querySelectorAll('iframe[data-pc^="stage-frame"]')]; const el = els.find((e) => Number(getComputedStyle(e).opacity) > 0.5) ?? els[0]; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    const png = PNG.sync.read(fs.readFileSync(file));
    const i = (Math.round(box.y) * png.width + Math.round(box.x)) * 4;
    return { rgb: [png.data[i], png.data[i + 1], png.data[i + 2]], file };
  };
  return { tag, page, pageErrors, refused, stageFrames, diag, clipIn, centerPixel, close: () => ctx.close().catch(() => {}) };
}
const near = (a, b, tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const summary = { out: OUT };

try {
  /* ============================================================ G1 / G2 / G3:真显卡 */
  console.log('\n== G1 隔离生效、图形能力够:带视频输入源的图卡在浏览器里活渲');
  const b1 = await launch();
  summary.chrome = await b1.version();
  const m = await openMember(b1, 'A');
  const d1 = await until('A 图卡在两台舞台里载入成功', async () => { const d = await m.diag(); return d && d.per.A?.state === 'ready' && d.per.B?.state === 'ready' && d.run?.state === 'ready' ? d : null; }, 90_000, 500);
  const dNow = d1 ?? await m.diag();
  summary.G1 = dNow;
  check('G1 本页隔离生效(双舞台、可执行、出口由浏览器拦)', dNow?.dual === true && dNow?.cardExec?.enabled === true && dNow.cardExec.egress === 'allowlist', dNow?.cardExec);
  check('G1 图卡在两台舞台里载入成功(运行状态 ready),两台的图形能力都是 ok', dNow?.run?.state === 'ready' && dNow?.graph?.A === 'ok' && dNow?.graph?.B === 'ok', { run: dNow?.run, per: dNow?.per, graph: dNow?.graph, bundles: dNow?.bundles });
  const sid = dNow?.cardExec?.sid ?? '';
  const want = COLOR.map((c) => 255 - c);
  let px = null;
  await until('A 可见舞台画出图卡的输出(片段中心是视频那一帧的反色)', async () => { px = await m.centerPixel('g1-invert'); return near(px.rgb, want); }, 45_000, 1000);
  const c1 = await m.clipIn('ocg-clip');
  const front = c1.find((c) => c.role === 'front') ?? c1[0];
  check(`G1 截图取片段中心的像素:是视频那一帧 (${COLOR}) 的反色 (${want}),容差 ±24`, !!px && near(px.rgb, want), { got: px?.rgb, file: px?.file });
  check('G1 可见舞台挂的是图卡的画布,不显示「需要本地 PC 渲染辅助」,图卡没有报错', front?.mounted === true && front.graphNode === true && front.canvas >= 1 && front.placeholder === false && !front.error, front);
  const mediaReqs = proxy.requests.filter((r) => r.path === `/media-s/${sid}/media/${VIDEO_HASH}`);
  check('G1 视频经舞台自己源上的 /media-s/<会话号>/media/<哈希> 按 Range 取到(应答 206)', mediaReqs.some((r) => r.status === 206), { count: mediaReqs.length, statuses: [...new Set(mediaReqs.map((r) => r.status))] });
  const leaky = proxy.requests.filter((r) => r.path.includes(VIDEO_HASH) && /[?&]t=/.test(r.path + (r.query ?? ''))).length;
  const videoSrcs = c1.flatMap((c) => c.videos ?? []);
  check('G1 取这段视频的请求里没有带 ?t= 的,舞台里的 <video> 地址不带票据', leaky === 0 && videoSrcs.every((s) => !/[?&]t=|v1\./.test(s)), { leaky, videoSrcs: videoSrcs.slice(0, 4) });
  const badge = await m.page.evaluate(() => document.querySelectorAll('[data-pc="clip-local-pc-badge"], [data-pc-local-pc-badge]').length);
  check('G1 时间轴不挂「需要本地 PC 渲染辅助」的徽标;没有页面错误', badge === 0 && m.pageErrors.length === 0, { badge, errors: m.pageErrors.slice(0, 3) });

  console.log('\n== G2 改参数即时生效');
  await m.page.evaluate(() => {
    const S = window.__pcStore;
    S.actions.editCardProject((p) => ({ ...p, cardNodes: (p.cardNodes ?? []).map((n) => (n.id === 'ocg-n1' ? { ...n, params: { amount: 0 } } : n)),
      tracks: p.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === 'ocg-clip' ? { ...c, params: { amount: 0 } } : c)) })) }));
  });
  let px2 = null;
  await until('A 强度改成 0 之后同一个像素变回视频的原色', async () => { px2 = await m.centerPixel('g2-amount0'); return near(px2.rgb, COLOR); }, 30_000, 1000);
  check(`G2 强度从 1 改成 0:同一个像素变回视频的原色 (${COLOR})`, !!px2 && near(px2.rgb, COLOR), { got: px2?.rgb, file: px2?.file });

  console.log('\n== G3 输入解不了:退回原做法');
  await m.page.evaluate((hash, cardId) => {
    const S = window.__pcStore;
    const bad = S.actions.addMedia({ kind: 'video', name: 'broken.mp4', url: '/@media/' + hash, hash, ext: 'mp4', size: 4000, width: 320, height: 180, duration: 2 });
    S.actions.editCardProject((p) => ({ ...p,
      cardNodes: [...(p.cardNodes ?? []), { id: 'ocg-n2', adapter: 'card', cardId, kind: 'filter', inputs: { source: '@clip/ocg-bad/source' }, params: { amount: 1 } }],
      tracks: [{ id: 'ocg-t2', name: '坏素材', clips: [{ id: 'ocg-bad', mediaId: bad.id, cardId, nodeId: 'ocg-n2', start: 8, end: 10, params: { amount: 1 } }] }, ...p.tracks] }));
  }, BAD_HASH, CARD_ID);
  // 项目时长跟着新片段变长之后再拨过去(同一拍里拨会被旧时长钳住)
  await until('A 项目时长含新片段', () => m.page.evaluate(() => window.__pcStore.getState().project.duration >= 10), 10_000);
  await m.page.evaluate(() => window.__pcStore.actions.seek(9));
  if (process.env.PROBE_DEBUG) { await sleep(3000); console.error('[debug]', JSON.stringify(await m.page.evaluate(() => { const p = window.__pcStore.getState().project; return { t: window.__pcStore.getState().t, duration: p.duration, tracks: p.tracks.map((tr) => tr.clips.map((c) => [c.id, c.start, c.end, c.cardId ?? null, c.mediaId ?? null, c.nodeId ?? null])), nodes: (p.cardNodes ?? []).map((n) => [n.id, n.inputs]), media: p.media.map((x) => [x.id, x.kind, x.hash?.slice(0, 6)]) }; })), JSON.stringify(await m.clipIn('ocg-bad')), JSON.stringify(await Promise.all(m.stageFrames().map((f) => f.evaluate(() => ({ err: [...document.querySelectorAll('[data-pc-card-error]')].map((e) => e.getAttribute('data-pc-card-error')), clips: [...document.querySelectorAll('[data-pc-clip]')].map((e) => e.getAttribute('data-pc-clip')), t: window.__pcStageDiag?.().t })))))); }
  const d3 = await until('A 图卡的运行状态变成 media', async () => { const d = await m.diag(); return d?.run?.state === 'media' ? d : null; }, 45_000, 500);
  summary.G3 = d3 ?? await m.diag();
  check('G3 输入解不了:这张图卡的运行状态是 media', summary.G3?.run?.state === 'media', { run: summary.G3?.run, per: summary.G3?.per });
  await m.page.evaluate(() => { const S = window.__pcStore; S.actions.select(['ocg-bad']); });
  // 参数面板在左栏的「编辑」页签里
  await m.page.evaluate(() => { document.querySelector('[data-pc-rail="edit"]')?.click(); });
  await sleep(300);
  await m.page.evaluate(() => { document.querySelector('[data-pc="inspector"] [data-pc-tab="form"]')?.click(); });
  const note = await until('A 参数面板的说明', () => m.page.evaluate(() => document.querySelector('[data-pc="params-run-state"]')?.textContent ?? null), 8000).catch(() => null);
  check('G3 参数面板说明原因(这台设备解不了这段素材)', /解不了这段素材/.test(note ?? ''), note);
  await sleep(1500);
  const c3 = await m.clipIn('ocg-bad');
  const front3 = c3.find((c) => c.role === 'front') ?? c3[0];
  check('G3 这张图卡不再在舞台里运行(片段不挂图卡的画布),退回原做法', front3?.mounted === true && front3.graphNode === false, front3);
  await m.page.evaluate(() => window.__pcStore.actions.seek(5));
  const builtin = await until('A 内置卡照常画', async () => { for (const f of m.stageFrames()) { if (await f.evaluate(() => [...document.querySelectorAll('[data-pc-clip]:not([data-pc-media])')].some((w) => w.childElementCount > 0 && w.textContent.trim().length > 0)).catch(() => false)) return true; } return false; }, 20_000);
  check('G3 舞台没有垮:拨到内置卡上照常画出来;没有页面错误', !!builtin && m.pageErrors.length === 0, m.pageErrors.slice(0, 3));
  summary.refused = m.refused.slice(0, 5);
  await m.page.screenshot({ path: path.join(OUT, 'g3-editor.png') }).catch(() => {});
  // 收尾:把坏素材那一段摘掉,G4 的页面里这张卡不该先被它带成 media
  await m.page.evaluate(() => { const S = window.__pcStore; S.actions.editCardProject((p) => ({ ...p, cardNodes: (p.cardNodes ?? []).filter((n) => n.id !== 'ocg-n2'), tracks: p.tracks.filter((tr) => tr.id !== 'ocg-t2') })); });
  await sleep(1500);
  await m.close();
  await b1.close().catch(() => {});

  /* ============================================================ G4:图形能力不够 */
  console.log('\n== G4 图形能力不够(--disable-gpu,软件渲染):退回原做法');
  const b2 = await launch(['--disable-gpu']);
  const n = await openMember(b2, 'B');
  const d4 = await until('B 图卡的运行状态有结论', async () => { const d = await n.diag(); return d?.run && d.run.state !== 'loading' && d.per.A && d.per.B ? d : null; }, 90_000, 500);
  summary.G4 = d4 ?? await n.diag();
  check('G4 软件渲染的浏览器:图卡的运行状态是 gpu,两台舞台报的图形能力都不是 ok', summary.G4?.run?.state === 'gpu' && summary.G4?.graph?.A !== 'ok' && summary.G4?.graph?.B !== 'ok' && !!summary.G4?.graph?.A, { run: summary.G4?.run, graph: summary.G4?.graph });
  await sleep(1500);
  const c4 = await n.clipIn('ocg-clip');
  const front4 = c4.find((c) => c.role === 'front') ?? c4[0];
  check('G4 片段退回原做法:舞台不挂图卡的画布', front4?.mounted === true && front4.graphNode === false, front4);
  await n.page.evaluate(() => window.__pcStore.actions.seek(5));
  const builtin4 = await until('B 内置卡照常画', async () => { for (const f of n.stageFrames()) { if (await f.evaluate(() => [...document.querySelectorAll('[data-pc-clip]:not([data-pc-media])')].some((w) => w.childElementCount > 0 && w.textContent.trim().length > 0)).catch(() => false)) return true; } return false; }, 20_000);
  check('G4 同一个项目里的内置卡照常画;没有页面错误', !!builtin4 && n.pageErrors.length === 0, n.pageErrors.slice(0, 3));
  await n.page.screenshot({ path: path.join(OUT, 'g4-editor.png') }).catch(() => {});
  await n.close();
} catch (e) {
  check('探针没有中途出错', false, String(e?.stack ?? e).slice(0, 500));
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  await proxy.close().catch(() => {});
  await combo.close?.().catch?.(() => {});
  for (const dir of [dataDir, tmp]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ } }
}
const ok = fails.length === 0;
console.log(JSON.stringify({ ok, pass, fail: fails.length, fails, ...summary }));
process.exit(ok ? 0 : 1);
