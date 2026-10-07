/**
 * 在线浏览器模式的用户卡(C10 契约第 9 节,2026-09-29 用户改语义;验收 C10-A6 新写法)。
 * 全程在本机:本机托管组合代替阿里云,仿 nginx 的前缀代理开三个源(编辑器页 + 两个舞台,都带 OAC),在线构建当页面。
 *
 *   npx vite build --mode online --outDir <目录>
 *   node scripts/probes/online-user-cards-probe.mjs --dist <在线构建目录> [--out <截图目录>] [--base-port 5744]
 *
 * 端口:+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务(缺省 5744～5748)。
 * 预渲染结果由探针替渲染节点写:内容库的层表(v 2)与段清单(每帧都有原尺寸与小尺寸),字节由代理在 `/media/api/asset/snap|px/<hash>`
 * 上直接给(探针自己的「nginx」,不经素材服务的写票据);代理记下每个请求。
 *
 * 摆法(一个共享项目):
 *   0～4 秒,六条轨道同一时段,各占画面的一格(框 640×360、不缩放):
 *     b   内置卡 `punch-pill`(有层)
 *     u   仓库用户卡 `mu-animated-shiny-text`(有层)
 *     s1  内容库同步来的用户卡 `probe-synced-card`(有层)
 *     s2  同一张同步卡(先没有层,后补)
 *     s3  同一张同步卡(一直没有层;低内存档核补渲用)
 *     x   未知 id `probe-unknown-card`
 *   4～8 秒(核图标与沙漏在屏幕上的大小):
 *     s4、s5  同步卡,两个 320×180 的小框左右挨着(没有层):图标只留图标、各在自己的框里、不相交
 *     s6      同步卡,框 1920×1080、`frame.scale: 0.5`(没有层):框够大,图标横排、屏幕上仍是原大小(约 198×40)
 *     s7      同步卡,有层、清单每帧都有,但字节取不到(代理不给):结果「在路上」,一直是沙漏,屏幕上约 28 像素
 * 同步卡的源码由创建者 `content.put` 进内容库(`card-source`,键 `src/cards/user/probe-synced-card.tsx`),写着 text / number /
 * select / color 四种控件和 defaults。
 *
 * 断言:
 *   普通档(电脑浏览器,两个跨源舞台):
 *     - 时间轴标签:s1 →「探针同步卡」,x →「未知卡片」;
 *     - 有层的 s1(故意运行不了的同步卡):清单与 `snap/` 请求 > 0,舞台贴出快照,没有图标;时间轴没有徽标;
 *       u(仓库用户卡,本页能运行;2026-10-06 新语义)测完判轻:在舞台里活渲(没有快照、没有图标)、不在页面发布的清单计划里;
 *     - 没有层的 s2:舞台是「需要本地 PC 渲染辅助」(不是沙漏),时间轴有徽标、悬停文案对;给它写层与清单后几秒内图标换成快照、徽标撤掉;
 *     - x:舞台不画、不挂徽标;
 *     - 页面发布的清单计划(`__pcPlanPublisher().lastClips`)含 s1、s2、s3,稳定之后不含判轻的 u;
 *     - 选中同步卡片段:参数面板出现四种控件、值是 defaults;改 text 后另一成员看得到,页面重发清单计划;
 *     - 图标与沙漏在屏幕上的大小(见上面 4～8 秒那几段);
 *     - 另一成员(乙)页面一打开就每 100 ms 采样一次,直到快照贴上:有层的 u、s1 任何一次采样都没有图标、没有徽标;
 *       没层的 s2、s3 先可以是沙漏,层表取到之后才是图标加徽标;
 *     - 甲、乙两页的测量(常驻探针)从头到尾没测过同步卡片段,测量门按「卡片源码同步完」开;
 *     - 未知卡片 ouc-x(两边都没有定义)从头到尾没被测过,不在清单计划里;低内存档的补渲清单也没有它;
 *     - 乙在页面里点「首页」、加入另一个带同步卡的项目(丁先摆好片段):测量门按新连接等卡片源码同步完,新项目的同步卡没被测过。
 *   低内存档(仿手机):`__pcBackfill()` 在等的片段含 s3;舞台上 u、s1 贴小尺寸(`px/` 请求 > 0),s3 是图标。
 * 不打印口令;结果最后一行是一行 JSON(`ok`、`fails`、各项数字),截图在 --out。
 *
 * 环境变量 `PC_CHROME_ARGS`(空格分隔)只把参数原样透传给探针起的 Chrome,排障取证用,例如 `--log-net-log=<文件>` 抓网络日志
 * (r4、r5 两次合流里探针新开的页面偶发 120～180 s 打不开在线页,见 `docs/plan/TODO.md`)、云端 Linux 以 root 运行时的 `--no-sandbox`。
 * 不要用它关 TLS 校验(如 `--ignore-certificate-errors`),否则证书有问题时探针照样通过,掩盖真问题。
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { createTimings } from './probe-timings.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'online-user-cards-shots')));
const BASE = Number(arg('--base-port', 5780));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4 };
const ORIGINS = proxyOrigins(BASE); // 编辑器页 pc.localhost:<base>,舞台 s1./s2.pc.localhost:<base+1/+2>(同站跨源)
const SITE = ORIGINS.editor;
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
/** 耗时只记录(docs/semantics/guide_files/verification.md「耗时只记录,不当闸门」):u 测完之后还在快照上停了多久只写进 TIMINGS 行,不决定过不过 */
const timingLog = createTimings('online-user-cards-probe');
const out = { ok: false, out: OUT, normal: {}, lowmem: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return !!cond; };
const say = (k, v) => console.log(JSON.stringify({ [k]: v }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20_000, every = 250) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { v = null; last = String(e?.message ?? e); }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}${last ? ` (${last.slice(0, 120)})` : ''}`); return null; }
    await sleep(every);
  }
}
const UNSUPPORTED = '需要本地 PC 渲染辅助';
const SYNCED_ID = 'probe-synced-card';
const SYNCED_NAME = '探针同步卡';
const SYNCED_KEY = `src/cards/user/${SYNCED_ID}.tsx`;
const SYNCED_DEFAULTS = { text: 'synced', size: 48, side: 'left', tint: '#ff8800' };
const SYNCED_SOURCE = `/** 探针:内容库同步来的用户卡(本机构建里没有) */
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string; size: number; side: string; tint: string }
// 2026-10-06 新语义:同步来的用户卡在隔离生效的普通档里会被执行。本探针测的是「在线页面运行不了的同步卡」(没有层 → 图标与徽标、有层 → 贴快照、
// 不测量、进清单计划),所以让这张卡故意运行不了:转译前的预检会拦下 namespace(状态 unsupported-syntax)。同步卡真的运行的断言在 online-card-security-probe 等。
export namespace ProbeUnsupported { export const marker = 1; }
const SIDES = [{ value: "left", label: "靠左" }, { value: "right", label: "靠右" }];
function ProbeSynced({ params }: CardProps<Params>) {
  return <div className="absolute inset-0 flex items-center justify-center" style={{ color: params.tint, fontSize: params.size }}>It's {params.text}</div>;
}
export const probeSyncedCard: CardDef<Params> = {
  id: "${SYNCED_ID}",
  name: "${SYNCED_NAME}",
  description: "探针用",
  frameMode: "stateful",
  defaults: { text: "synced", size: 48, side: "left", tint: "#ff8800" },
  controls: [
    { key: "text", label: "文字", type: "text" },
    { key: "size", label: "字号", type: "number", min: 12, max: 200, step: 2 },
    { key: "side", label: "位置", type: "select", options: SIDES },
    { key: "tint", label: "颜色", type: "color" },
  ],
  Component: ProbeSynced,
};
`;

/* ------------------------------------------------------------------ 服务 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-user-cards-hosted-'));
const combo = await startHostedCombo({
  dataDir, docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1', trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'),
  docPublicUrl: `ws://pc.localhost:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
});

/** 代理直接给的预渲染字节:`<ns>/<hash>` → { type, bytes } */
const fakeAssets = new Map();
const assetLog = [];
/** 共用的本机托管代理(`lib/hosted-proxy.mjs`,full 策略:三个源同站跨源、带内容安全策略与出口白名单、`/media-s/`);预渲染字节由钩子直接给 */
const proxy = await startHostedProxy({
  dist: DIST, basePort: PORTS.editor, docPort: PORTS.doc, assetPort: PORTS.asset, policy: 'full',
  intercept: ({ role, req, url }) => {
    const m = /^\/media\/api\/asset\/(snap|px)\/([0-9a-f]{64})$/.exec(url.pathname);
    if (!m) return undefined;
    assetLog.push({ at: Date.now(), ns: m[1], hash: m[2], role });
    const hit = fakeAssets.get(`${m[1]}/${m[2]}`);
    if (hit && req.method === 'GET') {
      return { status: 200, body: hit.bytes, headers: { 'content-type': hit.type, 'content-length': hit.bytes.length, 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' } };
    }
    return undefined;
  },
});

/* ------------------------------------------------------------------ 共享项目 */
const stamp = Date.now().toString(36);
const NAME = `ouc-${stamp}`;
const creator = { username: 'boss', password: `boss-${randomBytes(6).toString('hex')}` };
const PROJECT_PW = `pw-${randomBytes(6).toString('hex')}`;
const made = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });

/** 凭证连接直接向托管端发请求(探针替渲染节点写层表与段清单、替桌面版写卡片源码) */
async function wsAsCreator(projectId = made.projectId) {
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId, username: creator.username, deviceId: 'ouc-probe-node-01', deviceName: 'probe-node', as: 'creator', password: creator.password, role: 'page' });
  const ws = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const ask = (msg) => new Promise((resolve) => {
    const reqId = `p${Math.random().toString(36).slice(2)}`;
    const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  return { ask, close: () => ws.close() };
}

/**
 * 在线页面只加入、不新建(`dce4b22b`,2026-10-04:加入用 `initialize: false`,服务端没有项目内容就拒绝,不拿本地这份去盖),
 * 所以项目要先有内容才进得去。探针替创建者的桌面版写进一份空项目(尺寸、时长同「新建项目」的缺省)。
 */
async function seedProject(node, projectId, name) {
  const opened = await node.ask({ type: 'project.open', projectId });
  const body = { version: 1, id: `ouc-seed-${projectId.slice(-8)}`, name, width: 1920, height: 1080, fps: 30, duration: 30, themeId: 'midnight', media: [],
    tracks: [{ id: 't-1', name: '序列 1', clips: [] }, { id: 't-2', name: '序列 2', clips: [] }] };
  const seeded = await node.ask({ type: 'project.op', projectId, opId: randomBytes(16).toString('base64url'), ops: [{ op: 'set', path: '', value: body }] });
  check(!/error|reject/i.test(String(opened?.type ?? '') + String(seeded?.type ?? '')), `替创建者写进空项目 ${name}`, { opened: opened?.type, seeded: seeded?.type });
  return body.id;
}

/* ------------------------------------------------------------------ 浏览器 */
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--site-per-process', ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : [])] });
async function newPage(label, { mobile = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  if (mobile) {
    await page.emulate({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      viewport: { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false },
    });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 4 }); });
  } else {
    await page.setViewport({ width: 1600, height: 900 });
  }
  page.label = label;
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e).slice(0, 200)));
  return page;
}
async function typeInto(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 15_000 });
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  if (text) await page.type(sel, text, { delay: 5 });
}
/** 加入共享项目;`reload: false` 时不刷新页面(已经在开始页上,比如在页面里点了「首页」) */
async function join(page, username, name = NAME, { reload = true } = {}) {
  if (reload) await page.goto(`${SITE}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  await typeInto(page, '[data-pc="join-name"]', name);
  await typeInto(page, '[data-pc="join-username"]', username);
  await typeInto(page, '[data-pc="join-password"]', PROJECT_PW);
  await page.click('[data-pc="join-submit"]');
  await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
  await until(`${username} 的时间轴`, () => page.evaluate(() => !!window.__pcStore), 30_000);
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
/** 可见舞台那一块放大截一张(整页截图里舞台只有两成大,图标看不清) */
async function stageShot(page, name) {
  const f = await visibleStage(page);
  const el = f ? await f.frameElement().catch(() => null) : null;
  const box = el ? await el.boundingBox().catch(() => null) : null;
  if (!box || box.width < 10) return null;
  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { ...box, scale: Math.min(4, 1600 / box.width) } }).catch(() => {});
  return `${name}.png`;
}
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
/** 可见舞台那一帧(`?stage=1`,两个舞台里此刻可见的那一个;低内存档只有一个) */
async function visibleStage(page) {
  const frames = page.frames().filter((f) => /[?&]stage=1/.test(f.url()));
  for (const f of frames) {
    const el = await f.frameElement().catch(() => null);
    const vis = el ? await el.evaluate((e) => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5 && e.getBoundingClientRect().width > 10; }).catch(() => false) : false;
    if (vis) return f;
  }
  return frames[0] ?? null;
}
/**
 * 某个片段显示着的占位平面(图标或沙漏)在**屏幕**上多大:舞台里占位平面的 `getBoundingClientRect`(已含包裹层与组件自己的变换)
 * 乘以父页把舞台 iframe 缩到预览框的倍数(iframe 在父页里的宽 / 它的布局宽),位置加上 iframe 在父页里的左上角。
 * 顺带量这个片段包裹层(位置框)在屏幕上的框。`sel` 缺省是整个占位平面;沙漏量 `.pc-ph-hourglass`。
 */
async function placeholderOnScreen(page, clipId, sel = null) {
  const f = await visibleStage(page);
  const el = f ? await f.frameElement().catch(() => null) : null;
  if (!el) return null;
  const outer = await el.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, layoutW: e.offsetWidth }; });
  const inner = await f.evaluate((id, sub) => {
    const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
    const p = document.querySelector(`[data-pc-clip="${id}"] > [data-pc-placeholder-slot]:not([hidden]) [data-pc-placeholder-plane]`);
    if (!p || !wrap) return null;
    const target = sub ? p.querySelector(sub) ?? p : p;
    const r = target.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const text = p.querySelector('.pc-ph-unsupported-text');
    return { x: r.left, y: r.top, w: r.width, h: r.height, clip: { x: wr.left, y: wr.top, w: wr.width, h: wr.height },
      kind: p.getAttribute('data-pc-placeholder-kind'), layout: p.getAttribute('data-pc-placeholder-layout'), reason: p.getAttribute('data-pc-placeholder-reason'),
      textShown: !!text && getComputedStyle(text).display !== 'none', aria: p.getAttribute('aria-label') };
  }, clipId, sel);
  if (!inner || !outer.layoutW) return null;
  const k = outer.w / outer.layoutW;
  const box = (b) => ({ x: +(outer.x + b.x * k).toFixed(1), y: +(outer.y + b.y * k).toFixed(1), w: +(b.w * k).toFixed(1), h: +(b.h * k).toFixed(1) });
  return { viewScale: +k.toFixed(4), kind: inner.kind, layout: inner.layout, reason: inner.reason, textShown: inner.textShown, aria: inner.aria,
    stage: { w: +inner.w.toFixed(1), h: +inner.h.toFixed(1) }, screen: box(inner), clipScreen: box(inner.clip) };
}
const iconOnScreen = (page, clipId) => placeholderOnScreen(page, clipId);
const inside = (a, b, tol = 0.6) => a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && a.y + a.h <= b.y + b.h + tol;
const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** 舞台里每个片段的状态:有没有包裹层、组件、快照平面(原尺寸 / 小尺寸)、占位槽位显没显示、原因与种类 */
async function stageState(page, ids) {
  const f = await visibleStage(page);
  if (!f) return null;
  return f.evaluate((ids2) => {
    const outS = {};
    for (const id of ids2) {
      const w = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
      if (!w) { outS[id] = { wrapper: false }; continue; }
      const snap = w.querySelector(':scope > [data-pc-snapshot-plane]');
      const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
      const plane = slot?.querySelector('[data-pc-placeholder-plane]');
      outS[id] = {
        wrapper: true,
        snapshot: !!snap && snap.childElementCount > 0,
        // 活组件:包裹层里除了快照平面与占位槽位以外还有带文字的内容(本页能运行的卡直接活渲)
        live: [...w.children].some((c) => !c.matches('[data-pc-placeholder-slot],[data-pc-snapshot-plane]') && (c.textContent ?? '').trim().length > 0),
        snapText: snap?.textContent?.trim().slice(0, 40) ?? null,
        small: !!snap?.querySelector('img[data-pc-small-snapshot]'),
        placeholderShown: !!slot && !slot.hidden,
        reason: slot?.getAttribute('data-pc-placeholder-reason') ?? plane?.getAttribute('data-pc-placeholder-reason') ?? null,
        kind: plane?.getAttribute('data-pc-placeholder-kind') ?? null,
        text: slot && !slot.hidden ? (plane?.textContent ?? '').trim().slice(0, 40) : null,
        fixed: !!w.querySelector('[data-pc-placeholder-fixed]'),
        classes: w.className,
      };
    }
    return outS;
  }, ids);
}
async function timelineState(page, ids) {
  return page.evaluate((ids2) => Object.fromEntries(ids2.map((id) => {
    const el = document.querySelector(`[data-clip-id="${id}"]`);
    const badge = el?.querySelector('[data-pc="clip-custom-card"]');
    return [id, el ? { label: (el.querySelector('span.truncate')?.textContent ?? '').trim(), badge: !!badge, title: badge?.getAttribute('title') ?? null } : null];
  })), ids);
}

/* ------------------------------------------------------------------ 预渲染结果(替渲染节点写) */
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
/** 1×1 的 PNG(小尺寸;类型照写 image/png) */
const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2b1d6d40000000049454e44ae426082', 'hex');
function makeLayer(clipId, color, fps, count) {
  const html = Buffer.from(`<div data-probe-snap="${clipId}" style="position:absolute;inset:0;background:${color};color:#fff;font:bold 160px sans-serif;display:flex;align-items:center;justify-content:center">SNAP ${clipId}</div>`, 'utf8');
  const png = Buffer.concat([PNG_1PX, Buffer.from(clipId)]); // 每层一张不同的「小尺寸」(尾巴不同,哈希不同;浏览器照样解得出 PNG)
  const L = { clipId, rk: randomBytes(32).toString('hex'), ck: randomBytes(32).toString('hex'), full: sha(html), small: sha(png), count, fps };
  fakeAssets.set(`snap/${L.full}`, { type: 'text/html', bytes: html });
  fakeAssets.set(`px/${L.small}`, { type: 'image/png', bytes: png });
  return L;
}
async function writeManifests(node, L) {
  const half = L.count / 2;
  for (const [from, to] of [[0, half - 1], [half, L.count - 1]]) {
    const frames = [], small = [];
    for (let f = from; f <= to; f++) { frames.push([f, L.full, 300]); small.push([f, L.small, 80]); }
    const r = await node.ask({ type: 'content.put', kind: 'snapshot-manifest', key: `${L.rk}:${from}-${to}`,
      body: { v: 1, kind: 'snapshot', tier: 'shared', resultKey: L.rk, dirKey: L.rk, entryKey: null, range: { from, to }, canvasHeavy: false, frames, small } });
    check(r.type === 'content.stored', `写段清单 ${L.clipId}`, r);
  }
}
async function writeLayerMap(node, projectId, fps, layers) {
  const map = { v: 2, kind: 'layer-map', projectId, fps, width: 1920, height: 1080, span: layers[0].count / 2, at: Date.now(),
    layers: layers.map((L) => ({ clipId: L.clipId, kind: 'html', key: L.rk, tier: 'shared', resultKey: L.rk, dirKey: L.rk, entryKey: null, firstFrame: 0, count: L.count, contentKey: L.ck, envFingerprint: 'ouc0probe0fp0000' })) };
  const r = await node.ask({ type: 'content.put', kind: 'snapshot-manifest', key: `layers:${projectId}`, body: map });
  check(r.type === 'content.stored', '写层表', r);
}
const reqsFor = (L, ns) => assetLog.filter((r) => r.ns === ns && r.hash === (ns === 'snap' ? L.full : L.small)).length;

try {
  /* ============================================================ 创建者:同步卡的源码进内容库 */
  const node = await wsAsCreator();
  await seedProject(node, made.projectId, NAME);
  const put = await node.ask({ type: 'content.put', kind: 'card-source', key: SYNCED_KEY, body: SYNCED_SOURCE });
  check(put.type === 'content.stored', '创建者写卡片源码(card-source)', put);

  /* ============================================================ 普通档成员:摆片段 */
  const A = await newPage('甲');
  await join(A, '甲');
  const tiles = [[0, 0], [640, 0], [1280, 0], [0, 360], [640, 360], [1280, 360]];
  const setup = await store(A, `
    const ids = { b: 'ouc-b', u: 'ouc-u', s1: 'ouc-s1', s2: 'ouc-s2', s3: 'ouc-s3', x: 'ouc-x' };
    const cards = { b: 'punch-pill', u: 'mu-animated-shiny-text', s1: args[1], s2: args[1], s3: args[1], x: 'probe-unknown-card' };
    const tiles = args[0];
    // 4～8 秒:核图标与沙漏在屏幕上的大小(见文件头)
    const later = {
      s4: { x: 0, y: 0, w: 320, h: 180 },
      s5: { x: 320, y: 0, w: 320, h: 180 },
      s6: { x: 960, y: 540, w: 1920, h: 1080, anchor: [0.5, 0.5], scale: 0.5 },
      s7: { x: 1440, y: 810, w: 480, h: 270 },
    };
    const laterIds = Object.fromEntries(Object.keys(later).map((k) => [k, 'ouc-' + k]));
    S.actions.editCardProject((p) => ({
      ...p,
      duration: Math.max(p.duration, 8),
      tracks: [
        ...Object.keys(ids).map((k, i) => ({ id: 'ouc-t-' + k, name: '序列 ' + k, clips: [{ id: ids[k], cardId: cards[k], start: 0, end: 4, params: {},
          frame: { x: tiles[i][0], y: tiles[i][1], w: 640, h: 360 } }] })),
        ...Object.keys(later).map((k) => ({ id: 'ouc-t-' + k, name: '序列 ' + k, clips: [{ id: laterIds[k], cardId: args[1], start: 4, end: 8, params: {}, frame: later[k] }] })),
        ...p.tracks,
      ],
    }));
    S.actions.seek(1);
    const p = S.getState().project;
    return { projectId: p.id, ids: { ...ids, ...laterIds }, fps: p.fps || 30 };`, tiles, SYNCED_ID);
  out.setup = { ...setup, sharedProjectId: made.projectId };
  check(!!setup?.projectId, '摆片段', setup);
  const ID = setup.ids;
  const count = 4 * setup.fps;

  /* 层表与段清单:b、u、s1 有层;s2、s3 没有;s7 有层、清单齐,但字节取不到(结果「在路上」) */
  const L = { b: makeLayer(ID.b, '#1d4ed8', setup.fps, count), u: makeLayer(ID.u, '#15803d', setup.fps, count), s1: makeLayer(ID.s1, '#b45309', setup.fps, count),
    s7: makeLayer(ID.s7, '#be123c', setup.fps, count) };
  fakeAssets.delete(`snap/${L.s7.full}`);
  fakeAssets.delete(`px/${L.s7.small}`);
  for (const k of ['b', 'u', 's1', 's7']) await writeManifests(node, L[k]);
  await writeLayerMap(node, setup.projectId, setup.fps, [L.b, L.u, L.s1, L.s7]);

  /* ============================================================ 普通档 */
  const n = {};
  n.cardSources = await until('页面从内容库认出同步卡', () => A.evaluate((id) => {
    const d = window.__pcCardSources?.();
    return d && d.cards.some((c) => c.id === id) ? d : null;
  }, SYNCED_ID), 30_000);
  n.timeline = await until('时间轴标签(同步卡真名)', async () => {
    const t = await timelineState(A, Object.values(ID));
    return t?.[ID.s1]?.label === SYNCED_NAME ? t : null;
  }, 20_000);
  check(n.timeline?.[ID.s1]?.label === SYNCED_NAME, '标签:同步卡 → 真名', n.timeline?.[ID.s1]);
  check(n.timeline?.[ID.x]?.label === '未知卡片', '标签:未知 id →「未知卡片」', n.timeline?.[ID.x]);
  // 舞台:有层的贴快照、没有图标;没层的同步卡是图标(不是沙漏);未知 id 不画
  n.stage = await until('舞台:s1 贴出快照,s2 是「需要本地 PC 渲染辅助」', async () => {
    const s = await stageState(A, Object.values(ID));
    return s && s[ID.s1]?.snapshot && s[ID.s2]?.placeholderShown ? s : null;
  }, 45_000);
  if (!n.stage) n.stageSeen = await stageState(A, Object.values(ID)); // 等不到时记下舞台此刻的实际状态(排障用,进结果行)
  const st = n.stage ?? n.stageSeen ?? {};
  // 新语义(2026-10-06):s1 是故意运行不了的同步卡(有层 → 贴快照);u 是仓库用户卡,本页能运行,测完判轻 → 直接活渲(没有快照、没有图标)
  n.uLive = await until('舞台:u 测完判轻后直接活渲', async () => { const s2 = await stageState(A, [ID.u]); return s2?.[ID.u]?.live && !s2[ID.u].snapshot && !s2[ID.u].placeholderShown ? s2[ID.u] : null; }, 90_000);
  st[ID.u] = (await stageState(A, [ID.u]))?.[ID.u] ?? st[ID.u];
  check(st[ID.s1]?.snapshot && /SNAP/.test(st[ID.s1]?.snapText ?? ''), '舞台:s1 贴出预渲染快照', st[ID.s1]);
  check(st[ID.u]?.live && !st[ID.u].snapshot, '舞台:u(仓库用户卡,本页能运行)测完判轻,直接活渲(没有预渲染快照)', st[ID.u]);
  for (const k of ['u', 's1']) {
    check(!st[ID[k]]?.placeholderShown, `舞台:${k} 没有图标`, st[ID[k]]);
    check(!st[ID[k]]?.fixed, `舞台:${k} 没有常驻槽位`, st[ID[k]]);
  }
  check(st[ID.s2]?.placeholderShown && st[ID.s2]?.reason === 'unsupported' && /^unsupported/.test(st[ID.s2]?.kind ?? '') && (st[ID.s2]?.text ?? '').includes(UNSUPPORTED),
    '舞台:没有层的同步卡是「需要本地 PC 渲染辅助」(不是沙漏)', st[ID.s2]);
  check(st[ID.x]?.wrapper === false, '舞台:未知 id 不画', st[ID.x]);
  // 图标在屏幕上看得清:640×360 的格子里横排放不下(预览约 27%),竖排,屏幕上约 160×62
  n.icon = await until('s2 的图标按预览缩放放大', async () => { const r = await iconOnScreen(A, ID.s2); return r && r.screen.w >= 120 ? r : null; }, 15_000) ?? await iconOnScreen(A, ID.s2);
  check(n.icon && n.icon.screen.w >= 120 && n.icon.screen.h >= 40 && n.icon.textShown, 's2 的「需要本地 PC 渲染辅助」图标在屏幕上看得清(宽 ≥ 120、高 ≥ 40、字显示着)', n.icon);
  check(n.icon && inside(n.icon.screen, n.icon.clipScreen), 's2 的图标不超出片段的框', n.icon);
  if (n.icon) {
    const pad = 24;
    await A.screenshot({ path: path.join(OUT, 'normal-1-icon.png'), clip: { x: Math.max(0, n.icon.screen.x - pad), y: Math.max(0, n.icon.screen.y - pad), width: n.icon.screen.w + pad * 2, height: n.icon.screen.h + pad * 2, scale: 2 } }).catch(() => {});
  }
  check(st[ID.b]?.wrapper === true, '舞台:内置卡在', st[ID.b]);
  n.requests = { snapU: reqsFor(L.u, 'snap'), snapS1: reqsFor(L.s1, 'snap'), snapB: reqsFor(L.b, 'snap'), pxAny: assetLog.filter((r) => r.ns === 'px').length };
  n.online = await A.evaluate(() => window.__pcOnlineSnapshots?.() ?? null);
  const manifestsOf = (id) => n.online?.layers?.find((l) => l.clipId === id) ?? null;
  // u 是本页能运行的仓库用户卡:测完判轻就活渲,早先有没有取过它的快照取决于先后,不断言;s1 是运行不了的同步卡,一定贴快照
  check(n.requests.snapS1 > 0, '有层的 s1:snap/ 请求 > 0', n.requests);
  check(n.requests.pxAny === 0, '普通档:预渲染小尺寸请求 0', n.requests);
  check(manifestsOf(ID.s1)?.ready > 0, '有层的 s1:清单取了、就绪帧 > 0', { s1: manifestsOf(ID.s1) });
  // 时间轴徽标:只在 s2、s3(没有层)上
  n.badges = await until('徽标:s2、s3 有,u、s1 没有', async () => {
    const t = await timelineState(A, Object.values(ID));
    return t && t[ID.s2]?.badge && t[ID.s3]?.badge && !t[ID.u]?.badge && !t[ID.s1]?.badge ? t : null;
  }, 30_000) ?? await timelineState(A, Object.values(ID));
  for (const k of ['u', 's1', 'b', 'x']) check(n.badges?.[ID[k]] && !n.badges[ID[k]].badge, `时间轴:${k} 没有徽标`, n.badges?.[ID[k]]);
  check(n.badges?.[ID.s2]?.badge && n.badges[ID.s2].title === UNSUPPORTED, '时间轴:s2 有徽标、悬停文案「需要本地 PC 渲染辅助」', n.badges?.[ID.s2]);
  const badge = await A.$(`[data-clip-id="${ID.s2}"] [data-pc="clip-custom-card"]`);
  if (badge) { await badge.hover(); await sleep(1200); }
  await shot(A, 'normal-1-before-s2-layer');
  n.stageShot1 = await stageShot(A, 'normal-1-stage');
  // 页面发布的清单计划含用户卡与同步卡
  n.plan = await until('页面发布的清单计划含 s1、s2、s3', async () => {
    const d = await A.evaluate(() => window.__pcPlanPublisher?.() ?? null);
    const clips = d?.lastClips ?? [];
    return [ID.s1, ID.s2, ID.s3].every((id) => clips.includes(id)) ? d : null;
  }, 90_000) ?? await A.evaluate(() => window.__pcPlanPublisher?.() ?? null);
  check([ID.s1, ID.s2, ID.s3].every((id) => (n.plan?.lastClips ?? []).includes(id)), '普通档清单计划含同步卡片段(s1、s2、s3)', { lastClips: n.plan?.lastClips, log: n.plan?.log?.slice(-3) });
  // 新语义:u 判轻,不进预渲染集合,所以不在清单计划里(测量完成前它按重,计划可能先含它;这里看的是稳定之后)
  n.planNoU = await until('页面发布的清单计划不含判轻的仓库用户卡 u', async () => { const d = await A.evaluate(() => window.__pcPlanPublisher?.() ?? null); return d && !(d.lastClips ?? []).includes(ID.u) ? d : null; }, 60_000, 1000);
  check(!!n.planNoU && !(n.planNoU.lastClips ?? []).includes(ID.u), '普通档清单计划不含判轻的仓库用户卡 u(它在浏览器里活渲)', { lastClips: n.planNoU?.lastClips });
  check(!(n.plan?.lastClips ?? []).includes(ID.x), '清单计划不含未知 id(它不画、不判重)', n.plan?.lastClips);

  /* ------------------------------------------------ 乙:页面一打开就每 100 ms 采样(刚打开页面不闪图标) */
  const B = await newPage('乙');
  const samples = [];
  let sampling = true;
  const sampler = (async () => {
    const t0 = Date.now();
    while (sampling && Date.now() - t0 < 90_000) {
      const at = Date.now() - t0;
      const st2 = await stageState(B, [ID.u, ID.s1, ID.s2, ID.s3]).catch(() => null);
      const tl = await timelineState(B, [ID.u, ID.s1, ID.s2, ID.s3]).catch(() => null);
      const map = await B.evaluate(() => window.__pcOnlineSnapshots?.()?.mapVersion ?? null).catch(() => null);
      samples.push({ at, st: st2, tl, map });
      if ((st2?.[ID.u]?.snapshot || st2?.[ID.u]?.live) && st2?.[ID.s1]?.snapshot && st2?.[ID.s2]?.reason === 'unsupported' && st2?.[ID.s2]?.placeholderShown
        && st2?.[ID.s3]?.placeholderShown && st2?.[ID.s3]?.reason === 'unsupported' && tl?.[ID.s2]?.badge && tl?.[ID.s3]?.badge) break;
      await sleep(100);
    }
  })();
  await join(B, '乙');
  await sampler;
  sampling = false;
  const dense = { samples: samples.length, firstAt: samples[0]?.at ?? null, lastAt: samples.at(-1)?.at ?? null };
  const shownKinds = (id) => samples.filter((x) => x.st?.[id]?.placeholderShown).map((x) => x.st[id].reason);
  const bad = [];
  for (const x of samples) {
    for (const k of ['u', 's1']) {
      const v = x.st?.[ID[k]];
      if (v?.placeholderShown && v.reason === 'unsupported') bad.push({ at: x.at, id: k, what: 'icon' });
      if (x.tl?.[ID[k]]?.badge) bad.push({ at: x.at, id: k, what: 'badge' });
    }
    for (const k of ['s2', 's3']) {
      const v = x.st?.[ID[k]];
      // 图标只在层表取到之后出(父页确认了没有可用的层);徽标同理
      if (v?.placeholderShown && v.reason === 'unsupported' && x.map === null) bad.push({ at: x.at, id: k, what: 'icon-before-map' });
      if (x.tl?.[ID[k]]?.badge && x.map === null) bad.push({ at: x.at, id: k, what: 'badge-before-map' });
    }
  }
  const last = samples.at(-1);
  dense.kinds = { u: [...new Set(shownKinds(ID.u))], s1: [...new Set(shownKinds(ID.s1))], s2: [...new Set(shownKinds(ID.s2))], s3: [...new Set(shownKinds(ID.s3))] };
  dense.firstMapAt = samples.find((x) => x.map !== null)?.at ?? null;
  dense.firstS2IconAt = samples.find((x) => x.st?.[ID.s2]?.placeholderShown && x.st[ID.s2].reason === 'unsupported')?.at ?? null;
  dense.firstSnapAt = samples.find((x) => (x.st?.[ID.u]?.snapshot || x.st?.[ID.u]?.live) && x.st?.[ID.s1]?.snapshot)?.at ?? null;
  dense.bad = bad.slice(0, 10);
  n.dense = dense;
  // 采到最终状态为止(层表到得快时次数自然少):至少 3 次、最后一次已到最终状态,才算这一段真的采过
  check(samples.length >= 3 && !!((last?.st?.[ID.u]?.snapshot || last?.st?.[ID.u]?.live) && last?.st?.[ID.s1]?.snapshot), '乙:页面一打开就密集采样(每 100 ms 一次,采到最终状态为止,至少 3 次)', dense);
  check(bad.length === 0, '乙:有层的 u、s1 任何一次采样都没有图标、没有徽标;s2、s3 层表取到之前不出图标、不出徽标', dense);
  check(last?.st?.[ID.s1]?.snapshot, '乙:s1(运行不了的同步卡)贴上快照', last?.st);
  /*
   * 待核实的结论(第二段收尾):同一张仓库用户卡 u,甲看到活渲、乙的采样里先是快照。判断是「乙刚打开页面就采样,没声明 direct 的卡在测量完成前按重、贴已有的层;
   * 甲是测完判轻之后采的」。这里继续对乙采样,断言:先贴已有的层(快照),测量完成后切到活渲;切换前后画面连续(任何一次采样都没有占位、没有「需要本地 PC 渲染辅助」,
   * 也没有「既没快照又没活内容」的空窗);切换发生在乙测完 u 之后。
   */
  const uSeq = [];
  {
    const t0u = Date.now();
    let measuredAt = null, prev = null;
    while (Date.now() - t0u < 90_000) {
      const stU = (await stageState(B, [ID.u]).catch(() => null))?.[ID.u] ?? null;
      const tlU = (await timelineState(B, [ID.u]).catch(() => null))?.[ID.u] ?? null;
      const probed = await B.evaluate((id) => window.__pcPreviewDiag?.()?.probeRun?.probed?.some((e) => e.clipId === id) ?? false, ID.u).catch(() => false);
      if (probed && measuredAt === null) measuredAt = Date.now() - t0u;
      const kind = !stU?.wrapper ? 'none' : stU.snapshot ? 'snapshot' : stU.live ? 'live' : 'empty';
      if (kind !== prev) uSeq.push({ at: Date.now() - t0u, kind, placeholder: !!stU?.placeholderShown, reason: stU?.reason ?? null, badge: !!tlU?.badge, measured: probed });
      prev = kind;
      if (kind === 'live' && probed) break;
      await sleep(50);
    }
    const kinds = uSeq.map((x) => x.kind);
    const switchedAt = uSeq.find((x) => x.kind === 'live')?.at ?? null;
    const sawIcon = uSeq.some((x) => x.placeholder && x.reason === 'unsupported') || uSeq.some((x) => x.badge);
    const emptyAfterFirst = kinds.slice(kinds.findIndex((k) => k !== 'none')).includes('empty');
    n.uSeq = { seq: uSeq, measuredAt, switchedAt };
    check(kinds.includes('live') && switchedAt !== null, '乙:u 最后切到活渲(测量完成后)', n.uSeq);
    check(kinds.filter((k) => k !== 'none')[0] === 'snapshot' || kinds.filter((k) => k !== 'none')[0] === 'live', '乙:u 先贴已有的层(快照),或测得快时直接活渲;不是空的', n.uSeq);
    // 原来「测完后 3 秒内不再停留在快照」是通过条件;切没切到活渲由上面第一条判,停了多久只记录
    timingLog.record('乙 u 测完到最后一拍还停在快照', measuredAt == null ? null : Math.max(0, ...uSeq.filter((x) => x.kind === 'snapshot' && x.measured).map((x) => x.at - measuredAt)), { formerLimit: '≤ 3 秒' });
    check(!sawIcon && !emptyAfterFirst, '乙:切换前后画面连续:u 的片段没出过占位、没出过「需要本地 PC 渲染辅助」图标与徽标,没有「既没有快照又没有活内容」的空窗', n.uSeq);
  }
  check(last?.st?.[ID.s2]?.reason === 'unsupported' && last?.st?.[ID.s3]?.reason === 'unsupported' && last?.tl?.[ID.s2]?.badge && last?.tl?.[ID.s3]?.badge,
    '乙:s2、s3 确认之后是图标加徽标', { st: last?.st, tl: last?.tl });
  await shot(B, 'normal-3-member-b');

  /* ------------------------------------------------ 同步卡在线能改参数(甲改、乙看得到) */
  await store(A, `S.actions.seek(1); return true;`);
  const s1El = await A.$(`[data-clip-id="${ID.s1}"]`);
  if (s1El) { const bb = await s1El.boundingBox(); await A.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await sleep(500); }
  n.selected = await store(A, `return S.getState().selection.includes(args[0]);`, ID.s1);
  check(n.selected, '同步卡片段点得选中');
  // 打开左侧「编辑」分区的「参数」页
  await A.evaluate(() => { document.querySelector('[data-pc-rail="edit"]')?.click(); });
  await sleep(300);
  await A.evaluate(() => { document.querySelector('[data-pc="inspector"] [data-pc-tab="form"]')?.click(); });
  n.params = await until('甲:选中同步卡片段后参数面板出现四种控件', () => A.evaluate(() => {
    const v = (k) => document.querySelector(`[data-pc-param="${k}"]`);
    if (!v('text')) return null;
    return { text: v('text')?.value ?? null, size: v('size')?.value ?? null, side: v('side')?.value ?? null, tint: v('tint')?.value ?? null,
      types: ['text', 'size', 'side', 'tint'].map((k) => v(k)?.tagName.toLowerCase() + ':' + (v(k)?.getAttribute('type') ?? '')),
      empty: document.querySelector('[data-pc="params-empty"]')?.textContent ?? null };
  }), 15_000);
  check(n.params && n.params.text === SYNCED_DEFAULTS.text && Number(n.params.size) === SYNCED_DEFAULTS.size && n.params.side === SYNCED_DEFAULTS.side && n.params.tint === SYNCED_DEFAULTS.tint,
    '参数面板:同步卡的 text / number / select / color 四种控件,值是 defaults', n.params);
  const planLog0 = (await A.evaluate(() => window.__pcPlanPublisher?.()?.log?.length ?? 0)) ?? 0;
  // 参数框每敲一个键都提交、重渲,三击选中留不住:先全选再敲
  await A.focus('[data-pc-param="text"]');
  await A.keyboard.down('Control'); await A.keyboard.press('KeyA'); await A.keyboard.up('Control');
  await A.keyboard.press('Backspace');
  await A.type('[data-pc-param="text"]', 'ouc edited', { delay: 5 });
  await sleep(300);
  n.paramsLocal = await store(A, `
    const c = S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === args[0]);
    return { text: c?.params?.text ?? null, input: document.querySelector('[data-pc-param="text"]')?.value ?? null };`, ID.s1);
  check(n.paramsLocal?.text === 'ouc edited', '甲:参数面板改 text 写进了项目', n.paramsLocal);
  n.paramsRemote = await until('乙看得到甲改的 text', () => store(B, `
    const c = S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === args[0]);
    return c?.params?.text === 'ouc edited' ? { text: c.params.text } : null;`, ID.s1), 20_000);
  if (!n.paramsRemote) n.paramsRemoteSeen = await store(B, `
    const c = S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === args[0]);
    return { text: c?.params?.text ?? null, clips: S.getState().project.tracks.flatMap((t) => t.clips).length };`, ID.s1);
  check(!!n.paramsRemote, '同步卡改 text 后另一成员看得到(经文档服务提交)', n.paramsRemote ?? n.paramsRemoteSeen);
  n.planAfterEdit = await until('改参数后页面重发清单计划', async () => {
    const d = await A.evaluate(() => window.__pcPlanPublisher?.() ?? null);
    return (d?.log?.length ?? 0) > planLog0 && d.lastClips.includes(ID.s1) ? { log: d.log.slice(-2), lastClips: d.lastClips } : null;
  }, 30_000);
  check(!!n.planAfterEdit, '改参数后页面重发清单计划,仍含这一片段(由桌面版节点重渲)', n.planAfterEdit);

  /* ------------------------------------------------ 测量从没测过同步卡片段(甲、乙) */
  const synIds = [ID.s1, ID.s2, ID.s3, ID.s4, ID.s5, ID.s6, ID.s7];
  for (const [label, pg] of [['A', A], ['B', B]]) {
    const d = await pg.evaluate(() => { const x = window.__pcPreviewDiag?.(); return x ? { probed: x.probeRun?.probed ?? null, gate: x.measureGate ?? null } : null; });
    n[`measure${label}`] = d;
    check(d && Array.isArray(d.probed) && !d.probed.some((e) => synIds.includes(e.clipId)), `${label === 'A' ? '甲' : '乙'}:测量从没测过同步卡片段`, d);
    check(d && Array.isArray(d.probed) && !d.probed.some((e) => e.clipId === ID.x), `${label === 'A' ? '甲' : '乙'}:测量从没测过未知卡片 ouc-x`, d);
    check(d?.gate?.reason === 'synced', `${label === 'A' ? '甲' : '乙'}:测量门在卡片源码第一次同步完时开`, d?.gate);
  }

  /* ------------------------------------------------ 图标与沙漏在屏幕上的大小(4～8 秒那几段) */
  await store(A, `S.actions.seek(5); return true;`);
  n.geom = await until('4～8 秒:s4、s5、s6 是图标,s7 是沙漏', async () => {
    const r = {};
    for (const k of ['s4', 's5', 's6']) r[k] = await placeholderOnScreen(A, ID[k]);
    r.s7 = await placeholderOnScreen(A, ID.s7);
    r.s7Glass = await placeholderOnScreen(A, ID.s7, '.pc-ph-hourglass');
    const ok = ['s4', 's5', 's6'].every((k) => r[k]?.reason === 'unsupported') && r.s7?.reason === 'awaiting';
    return ok ? r : null;
  }, 30_000);
  const g = n.geom ?? {};
  if (g.s4 && g.s5) {
    check(g.s4.layout === 'icon' && g.s5.layout === 'icon' && !g.s4.textShown && g.s4.aria === UNSUPPORTED, '相邻小片段:只留图标、字藏起来、aria-label 照旧是全文', { s4: g.s4, s5: g.s5 });
    check(!intersects(g.s4.screen, g.s5.screen), '相邻两个小片段的图标在屏幕上不相交', { s4: g.s4.screen, s5: g.s5.screen });
    check(inside(g.s4.screen, g.s4.clipScreen) && inside(g.s5.screen, g.s5.clipScreen), '相邻两个小片段的图标各在自己片段的屏幕框内', { s4: g.s4, s5: g.s5 });
  }
  if (g.s6) {
    check(g.s6.layout === 'row' && g.s6.textShown && Math.abs(g.s6.screen.w - 198) <= 20 && Math.abs(g.s6.screen.h - 40) <= 6,
      'frame.scale 0.5、框够大:图标横排,屏幕上仍是原大小(约 198×40)', g.s6);
    check(inside(g.s6.screen, g.s6.clipScreen), 'frame.scale 0.5 的图标不超出片段的框', g.s6);
  }
  if (g.s7Glass) check(Math.abs(g.s7Glass.screen.w - 28) <= 4 && Math.abs(g.s7Glass.screen.h - 28) <= 4, '沙漏在屏幕上约 28 像素', g.s7Glass);
  check(g.s7?.kind === 'badge', '结果在路上的同步卡:沙漏徽标(不是图标)', g.s7);
  await sleep(1500);
  n.stageShot3 = await stageShot(A, 'normal-4-sizes-stage');
  for (const k of ['s4', 's6', 's7']) {
    const r = g[k];
    if (!r) continue;
    const pad = 16;
    await A.screenshot({ path: path.join(OUT, `normal-4-${k}.png`), clip: { x: Math.max(0, r.clipScreen.x - pad), y: Math.max(0, r.clipScreen.y - pad), width: Math.min(700, r.clipScreen.w + pad * 2), height: Math.min(500, r.clipScreen.h + pad * 2), scale: 3 } }).catch(() => {});
  }
  await store(A, `S.actions.seek(1); return true;`);

  /* ------------------------------------------------ 换到另一个带同步卡的项目:测量门重新关上,同步卡没被测过 */
  {
    const NAME2 = `ouc2-${stamp}`;
    const made2 = await createSharedProject({ base: DOC_DIRECT, name: NAME2, mode: 'free', creator, password: PROJECT_PW });
    const node2 = await wsAsCreator(made2.projectId);
    await seedProject(node2, made2.projectId, NAME2);
    const SYNCED2_ID = 'probe-synced-card-b';
    const put2 = await node2.ask({ type: 'content.put', kind: 'card-source', key: `src/cards/user/${SYNCED2_ID}.tsx`,
      body: SYNCED_SOURCE.replaceAll(SYNCED_ID, SYNCED2_ID).replace(SYNCED_NAME, '探针同步卡乙') });
    check(put2.type === 'content.stored', '项目二:创建者写卡片源码', put2);
    // 丁先进项目二摆好同步卡片段(乙换过来时项目里已经有它们)
    const D2 = await newPage('丁');
    await join(D2, '丁', NAME2);
    const setup2 = await store(D2, `
      S.actions.editCardProject((p) => ({ ...p, duration: Math.max(p.duration, 4),
        tracks: [{ id: 'ouc2-t', name: '序列', clips: [{ id: 'ouc2-s', cardId: args[0], start: 0, end: 4, params: {}, frame: { x: 0, y: 0, w: 640, h: 360 } }] }, ...p.tracks] }));
      return { projectId: S.getState().project.id };`, SYNCED2_ID);
    await sleep(2500);
    const gateBefore = await B.evaluate(() => window.__pcPreviewDiag?.()?.measureGate ?? null);
    // 乙在页面里换项目:点「首页」回开始页,再用同一张表单加入项目二(不刷新页面,测量门的状态接着用)
    await B.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.title === '首页')?.click(); });
    await join(B, '乙', NAME2, { reload: false });
    const sw = {};
    sw.label = await until('乙:项目二的同步卡认出真名', async () => {
      const t = await timelineState(B, ['ouc2-s']);
      return t?.['ouc2-s']?.label === '探针同步卡乙' ? t['ouc2-s'] : null;
    }, 30_000);
    /*
     * 门按连接算:换过来之后,要么问门时发现新连接还没同步完、重新关上(holds 加一)再等它同步完开门;要么项目二的卡片源码
     * 在问门之前就同步完了(门开着,记下为新连接开过)。两种都满足「新项目的卡片源码同步完之前不测」,`links` 都加一。
     */
    sw.gate = await until('乙:测量门为项目二的连接开过(卡片源码同步完)', async () => {
      const g = await B.evaluate(() => window.__pcPreviewDiag?.()?.measureGate ?? null);
      return g && g.links > (gateBefore?.links ?? 0) && g.state === 'open' && g.confirmedAt > (gateBefore?.confirmedAt ?? 0) ? g : null;
    }, 30_000);
    sw.gateLast = await B.evaluate(() => window.__pcPreviewDiag?.()?.measureGate ?? null).catch(() => null);
    await sleep(3000);
    sw.probed = await B.evaluate(() => window.__pcPreviewDiag?.()?.probeRun?.probed ?? null);
    sw.gateBefore = gateBefore;
    sw.setup2 = setup2;
    n.switchProject = sw;
    check(sw.gate && sw.gate.reason === 'synced' && sw.gate.links > (gateBefore?.links ?? 0), '乙换到项目二:测量门等项目二的卡片源码同步完(按新连接开门)', { gate: sw.gate, before: gateBefore });
    check(Array.isArray(sw.probed) && !sw.probed.some((e) => e.clipId === 'ouc2-s'), '乙换到项目二:同步卡片段没被测过', sw.probed);
    node2.close();
  }

  // 给 s2 补层与清单:几秒内图标换成快照、徽标撤掉
  L.s2 = makeLayer(ID.s2, '#7e22ce', setup.fps, count);
  await writeManifests(node, L.s2);
  await writeLayerMap(node, setup.projectId, setup.fps, [L.b, L.u, L.s1, L.s2]);
  const t0 = Date.now();
  n.after = await until('s2 补了层:图标换成快照、徽标撤掉', async () => {
    const s = await stageState(A, [ID.s2]);
    const t = await timelineState(A, [ID.s2]);
    return s?.[ID.s2]?.snapshot && !s[ID.s2].placeholderShown && t?.[ID.s2] && !t[ID.s2].badge ? { stage: s[ID.s2], timeline: t[ID.s2], ms: Date.now() - t0 } : null;
  }, 20_000);
  check(!!n.after, 's2:产物到了换上快照、撤掉图标与徽标', n.after);
  if (n.after) check(n.after.ms < 15_000, 's2:几秒内换上', n.after.ms);
  await shot(A, 'normal-2-after-s2-layer');
  n.stageShot2 = await stageShot(A, 'normal-2-stage');
  // 未知卡片 ouc-x 从头到尾:没被测过、不在清单计划里(甲、乙)
  for (const [label, pg] of [['甲', A], ['乙', B]]) {
    const d = await pg.evaluate(() => ({ probed: window.__pcPreviewDiag?.()?.probeRun?.probed ?? null, plan: window.__pcPlanPublisher?.()?.lastClips ?? null,
      prerender: null })).catch(() => null);
    n[`unknownX${label === '甲' ? 'A' : 'B'}`] = d;
    check(d && Array.isArray(d.probed) && !d.probed.some((e) => e.clipId === ID.x), `${label}:最后核一遍,未知卡片 ouc-x 从没被测过`, d);
    check(d && !(d.plan ?? []).includes(ID.x), `${label}:未知卡片 ouc-x 不在清单计划里`, d?.plan);
  }
  n.errors = A.errors.slice(0, 5);
  check(A.errors.length === 0, '普通档页面没有页面错误(没有定义的同步卡沿线不崩)', n.errors);
  out.normal = n;

  /* ============================================================ 低内存档(仿手机) */
  const P = await newPage('丙', { mobile: true });
  await join(P, '丙');
  const lm = {};
  lm.diag = await P.evaluate(() => ({ lowMemory: !!document.querySelector('[data-pc-low-memory]') || null, stages: [...document.querySelectorAll('iframe')].filter((f) => /[?&]stage=1/.test(f.src)).length }));
  lm.backfill = await until('低内存档:补渲在等的片段含 s3', async () => {
    const d = await P.evaluate(() => window.__pcBackfill?.() ?? null);
    const waiting = new Set([...(d?.waiting ?? []).map((w) => w.clip), ...(d?.log ?? []).flatMap((e) => e.clips ?? [])]);
    return waiting.has(ID.s3) ? { waiting: [...waiting], log: d.log.slice(-3) } : null;
  }, 120_000);
  check(lm.backfill?.waiting?.includes(ID.s3), '低内存档:__pcBackfill 的缺口含没有层的同步卡 s3', lm.backfill);
  check(!(lm.backfill?.waiting ?? []).includes(ID.u) && !(lm.backfill?.waiting ?? []).includes(ID.s1), '低内存档:有层的 u、s1 不进补渲', lm.backfill);
  check(!(lm.backfill?.waiting ?? []).includes(ID.x), '低内存档:未知卡片 ouc-x 不在补渲清单里', lm.backfill);
  await store(P, `S.actions.seek(1.5); return true;`);
  lm.stage = await until('低内存档舞台:u、s1 贴小尺寸,s3 是图标', async () => {
    const s = await stageState(P, [ID.u, ID.s1, ID.s3, ID.x]);
    return s && s[ID.u]?.small && s[ID.s1]?.small && s[ID.s3]?.placeholderShown ? s : null;
  }, 60_000) ?? await stageState(P, [ID.u, ID.s1, ID.s3, ID.x]);
  for (const k of ['u', 's1']) check(lm.stage?.[ID[k]]?.small && !lm.stage[ID[k]].placeholderShown, `低内存档舞台:${k} 贴预渲染小尺寸、没有图标`, lm.stage?.[ID[k]]);
  check(lm.stage?.[ID.s3]?.placeholderShown && lm.stage[ID.s3].reason === 'unsupported' && (lm.stage[ID.s3].text ?? '').includes(UNSUPPORTED), '低内存档舞台:s3 是「需要本地 PC 渲染辅助」', lm.stage?.[ID.s3]);
  check(lm.stage?.[ID.x]?.wrapper === false, '低内存档舞台:未知 id 不画', lm.stage?.[ID.x]);
  lm.requests = { pxU: reqsFor(L.u, 'px'), pxS1: reqsFor(L.s1, 'px') };
  check(lm.requests.pxU > 0 && lm.requests.pxS1 > 0, '低内存档:u、s1 的 px/ 请求 > 0', lm.requests);
  // 停下追一帧之后(时限 5 秒):用户卡照旧贴着小尺寸,不被「画好」撤掉
  await sleep(6000);
  lm.afterSettle = await stageState(P, [ID.u, ID.s1, ID.s3]);
  for (const k of ['u', 's1']) check(lm.afterSettle?.[ID[k]]?.small && !lm.afterSettle[ID[k]].placeholderShown, `低内存档停下之后:${k} 照旧贴小尺寸`, lm.afterSettle?.[ID[k]]);
  lm.settle = await P.evaluate(() => window.__pcPreviewDiag?.()?.lowMemSettle ?? null).catch(() => null);
  await shot(P, 'lowmem-1');
  lm.stageShot = await stageShot(P, 'lowmem-1-stage');
  lm.errors = P.errors.slice(0, 5);
  check(P.errors.length === 0, '低内存档页面没有页面错误', lm.errors);
  out.lowmem = lm;
  node.close();
} catch (e) {
  fails.push(`探针异常:${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  await browser.close().catch(() => {});
  await proxy.close().catch(() => {});
  await combo.close?.().catch?.(() => {});
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 留着也无妨 */ }
}
out.ok = fails.length === 0;
out.fails = fails;
out.assetRequests = { snap: assetLog.filter((r) => r.ns === 'snap').length, px: assetLog.filter((r) => r.ns === 'px').length };
say('result', { ok: out.ok, fails: fails.length });
const sizeOf = (r) => r ? { layout: r.layout, reason: r.reason, screen: r.screen, clipScreen: r.clipScreen, textShown: r.textShown } : null;
console.log(JSON.stringify({ ok: out.ok, fails, uSeq: out.normal.uSeq ?? null, icon: out.normal.icon ?? null,
  sizes: { column_s2: sizeOf(out.normal.icon), icon_s4: sizeOf(out.normal.geom?.s4), icon_s5: sizeOf(out.normal.geom?.s5), row_s6: sizeOf(out.normal.geom?.s6), hourglass_s7: sizeOf(out.normal.geom?.s7Glass) },
  stageSeen: out.normal.stageSeen ?? null, dense: out.normal.dense ?? null, params: out.normal.params ?? null, paramsRemote: out.normal.paramsRemote ?? null, measure: { a: out.normal.measureA ?? null, b: out.normal.measureB ?? null },
  switchProject: out.normal.switchProject ? { gate: out.normal.switchProject.gate, gateBefore: out.normal.switchProject.gateBefore, gateLast: out.normal.switchProject.gateLast, probed: out.normal.switchProject.probed } : null,
  unknownX: { a: out.normal.unknownXA ?? null, b: out.normal.unknownXB ?? null }, normal: { timeline: out.normal.timeline, requests: out.normal.requests, planClips: out.normal.plan?.lastClips, after: out.normal.after }, lowmem: { backfill: out.lowmem.backfill, requests: out.lowmem.requests }, assetRequests: out.assetRequests }));
timingLog.print();
process.exit(out.ok ? 0 : 1);
