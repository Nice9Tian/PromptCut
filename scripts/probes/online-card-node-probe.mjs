/**
 * 在线纯浏览器节点认领用户卡任务的本机端到端(`docs/plan/sound-online-render-task.md` 第 16 条,
 * `docs/plan/online-card-exec-contract.md` 第 7、11.2 节;块 N)。
 * 全程在本机:本机托管组合代替阿里云,共用的本机托管代理 `lib/hosted-proxy.mjs` 开三个源(同站跨源,带策略头与 `/media-s/`),在线构建当页面,绝不连真正的托管端。
 *
 *   npx vite build --mode online --outDir <目录>
 *   node scripts/probes/online-card-node-probe.mjs [--dist <在线构建目录>] [--base-port 5780] [--out <目录>] [--keep-temp] [--strict]
 *        端口:+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务(都只绑 127.0.0.1)
 *
 * 摆法(沿用 `m7-node-probe.mjs`,同一套本机替身):
 *   - 创建者经内容库把一张用户卡(`src/cards/user/ocn-card.tsx`,无相对导入)写进 `card-source`;
 *   - 切分方 = 本进程里的 pc 档渲染节点(`createLocalNode`,真会话、真切分 `splitPlan`),**环境指纹取页面的 envFingerprint**
 *     (「同一台机器上的桌面节点与浏览器节点」),`weightPolicy` 只收 plan:它只切分、不认领细任务;
 *     它算的代码身份与页面同一个算法(`src/online/cardRuntime/codeIdentity.ts`);切分完成后按桌面的写法写层表 v 3(`layerMapOf`);
 *   - 成员甲(本人)、乙(同项目另一成员,晚一点进,验「别的成员能贴上」)、丙(另一用户,验「不认领别人产生的」)各一页(普通档,双舞台)。
 *
 * 验收(任务书第 16 条每一句,A-1～A-6;**★ 标的要等舞台一侧的接线合流后才能过**:
 * 块 T 的加载器还没挂到舞台、隔离闸门还没立,卡片在本页到不了 `ready`,节点也就报不出 `cardRuntime` / `cardEnvFingerprint`):
 *   A-0 前提(不依赖接线):页面当节点(双舞台、普通档、测量落定),`node.hello` 不带运行时版本时 `cardEnvFingerprint` 为空,
 *       内置卡路径不受影响(`__pcBrowserNode()` 的 `envFingerprint` 有、`cardEnvFingerprint` 空、`cards.runtime` 空)。
 *   A-1 ★ 在线普通档的后台舞台认领并完成**自己发出的**用户卡任务:甲的清单计划 `input.browser` 带 `cardEnvFingerprint` 与 `ocn-card` 的代码身份;
 *       切分方认领计划、切出两份(切分方指纹一份、`cardEnvFingerprint` 一份);甲认领浏览器那份、逐帧生成快照、推块、完成。
 *   A-2 ★ 结果入库后别的成员能贴上:内容库里有这一段清单(结果键 = 内容键 × cardEnvFingerprint),素材服务上每块都 complete;
 *       层表 v 3 的候选里有浏览器那份;乙进来后在线来源按层表贴上这一层(`__pcOnlineSnapshots().layers` 里有这个片段、环境是 cardEnvFingerprint)。
 *   A-3 ★ 它不认领别人产生的任务:丙也放这张卡、发自己的清单计划,甲的节点认领数里没有丙的任务 id(`claims` = 甲自己完成的段数);
 *       丙的页面同样只认领丙自己的。
 *   A-4 不认领需要本机转码的任务:页面节点 `capabilities.transcode` 为 false、认领的全是快照任务(不含流);要转码的任务与流在节点侧过滤
 *       规则 2 与队列侧被挡,逐条断言在单测 `server/test/online-card-n.test.mjs` OCN-04 与 `m7-browser-probe.mjs`(清单计划不切流,这里没法造)。
 *   A-5 ★ 桌面节点与浏览器节点环境不同时结果键不串:同一台机器上切分方指纹 = 页面 envFingerprint、浏览器那份指纹是 cardEnvFingerprint,
 *       两份结果键不同;锁在 cardEnvFingerprint 上、切分方那份作废(superseded);内容库里只有浏览器键的清单。
 *   A-6 图卡(2026-10-06 主会话裁定,契约 13A(二):图卡任务纯浏览器节点不认领,不放宽体积上限):图卡整屏快照典型 2 MB 以上,超过 M7 的 300 KB /
 *       画布位图 1 MB 的上限(量法见 `lib-graph-snapshot-size.mjs`),按画布卡处理。同步一张图卡(`ocn-graph`)、甲放一个片段:切分方(替身按画布卡标 canvasHeavy)
 *       给它出的每个细任务只有桌面那一份、没有浏览器那一份(没有 dual、没有 bake 输入、指纹不是 cardEnvFingerprint),甲的节点认领数不增加。
 *       (切分方是替身:它不会自己量体积,画布卡标记是替身按裁定给的;真实的「桌面量出超限就标」在单测 OCN-05 与 `server/render-node` 的切分测试里。)
 *
 * 退出码:有「非 ★」断言失败就非 0;★ 断言失败只记进 `pendingFails`(JSON 里 `wiringComplete: false`),带 `--strict` 时也算失败。
 * 不打印令牌、口令。输出:过程写 stderr;stdout 最后一行一行 JSON `{ ok, wiringComplete, fails, pendingFails, … }`。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawnSync } from 'node:child_process';
import crypto, { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import './lib/localhost-dns.cjs'; // Node 这边也认得 *.localhost(托管组合对外说的是 pc.localhost)
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const KEEP = argv.includes('--keep-temp');
const STRICT = argv.includes('--strict');
const BASE = Number(arg('--base-port', 5780));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4 };
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const ORIGINS = proxyOrigins(PORTS.editor); // 编辑器页 pc.localhost:<端口>,舞台 s1./s2.pc.localhost:<端口+1/+2>(同站跨源)
const SITE = ORIGINS.editor;
const STAGE_ORIGINS = ORIGINS.stages;
const HOSTED = `${SITE}/hosted/`;
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ocn-node-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'shots')));
fs.mkdirSync(OUT, { recursive: true });
const deadline = Date.now() + 40 * 60_000;
const CARD_ID = 'ocn-card';
const CARD_KEY = `src/cards/user/${CARD_ID}.tsx`;
/** A-6 的图卡:同步来的整屏 glsl 图卡(纯色;体积与画布标记由切分方替身按裁定给,见 A-6) */
const GRAPH_ID = 'ocn-graph';
const GRAPH_KEY = `src/cards/user/${GRAPH_ID}.tsx`;
const GRAPH_SOURCE = `/** 探针:在线执行图卡的端到端(块 N,A-6) */
import { glsl } from "../../render/cards/graphValues";
export const ocnGraph = {
  id: "${GRAPH_ID}",
  name: "OCN 探针图卡",
  description: "块 N A-6 探针",
  tags: ["探针"],
  kind: "animation",
  frameMode: "direct",
  defaults: {},
  controls: [],
  card: () => glsl("void main() { outColor = vec4(0.2, 0.4, 0.6, 1.0); }", [], {}),
};
`;
const CARD_SOURCE = `/** 探针:在线执行用户卡的端到端(块 N);无相对导入、无 Tailwind 以外的依赖 */
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string; tint: string }
function OcnCard({ params }: CardProps<Params>) {
  // 每次渲染忙等 40 毫秒(真墙钟):这张卡在本页能运行之后和内置卡一样按轻重区分,判轻的不进预渲染集合、不发任务;
  // 探针要的是「判重、发清单计划、由浏览器节点认领」这条路,所以人为把它的每拍成本拉高(同 src/cards/_probe/slow.tsx 的做法)
  const now = () => ((globalThis as any).__pcRealNow ? (globalThis as any).__pcRealNow() : performance.now());
  const end = now() + 40;
  while (now() < end) { /* 烧时间 */ }
  return <div className="absolute inset-0 flex items-center justify-center" data-ocn-card="1" style={{ color: params.tint, fontSize: 64 }}>OCN {params.text}</div>;
}
export const ocnCard: CardDef<Params> = {
  id: "${CARD_ID}",
  name: "OCN 探针卡",
  description: "块 N 端到端探针",
  frameMode: "stateful",
  defaults: { text: "hello", tint: "#33ccff" },
  controls: [
    { key: "text", label: "文字", type: "text" },
    { key: "tint", label: "颜色", type: "color" },
  ],
  Component: OcnCard,
};
`;

const fails = [];
const pendingFails = [];
const out = { ok: false, wiringComplete: false, run: RUN, site: SITE, out: OUT, steps: {} };
/** `pending` 为真的是要等舞台一侧接线合流后才能过的断言(★) */
const check = (cond, label, extra, { pending = false } = {}) => {
  if (!cond) (pending ? pendingFails : fails).push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 600)}`));
  return !!cond;
};
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
async function until(label, fn, timeoutMs, everyMs = 300, { pending = false } = {}) {
  const end = Math.min(Date.now() + timeoutMs, deadline);
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) { (pending ? pendingFails : fails).push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
}
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

/* ================================================================== 托管组合 + 三个源的仿 nginx 代理(同 m7-node-probe) */

let combo = null;
let hostedProxy = null;
async function startLocalSite() {
  for (const p of Object.values(PORTS)) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  let DIST = arg('--dist', null);
  if (!DIST) {
    DIST = path.join(TMP, 'dist-online');
    say('local.build-online', { dist: DIST });
    const b = spawnSync(process.execPath, [viteBin(), 'build', '--mode', 'online', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (b.status !== 0) throw new Error(`在线构建失败:${String(b.stderr).slice(-600)}`);
  }
  DIST = path.resolve(DIST);
  const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
  fs.mkdirSync(path.join(TMP, 'hosted'), { recursive: true });
  combo = await startHostedCombo({
    dataDir: path.join(TMP, 'hosted'), docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    docPublicUrl: `ws://pc.localhost:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
  });
  // 共用的本机托管代理(`lib/hosted-proxy.mjs`,full 策略:同站跨源的三个源、策略头、`/media-s/`、运行配置)
  hostedProxy = await startHostedProxy({ dist: DIST, basePort: PORTS.editor, docPort: PORTS.doc, assetPort: PORTS.asset, policy: 'full' });
  say('local.up', { site: SITE, doc: PORTS.doc, asset: PORTS.asset, dist: DIST });
  return DIST;
}

/* ================================================================== 创建者一侧的内容库连接 */

async function creatorContent(projectId, creator, label) {
  const [{ normalizeEntry, sharedProtocols }, { createWsEndpoint }, { createContentClient }, { wsBaseOf }] = await Promise.all([
    import('../../server/auth/shared-config.mjs'), import('../../server/render-node/ws-transport.mjs'),
    import('../../server/render-node/content-client.mjs'), import('../../server/auth/route.mjs'),
  ]);
  const entry = normalizeEntry({ url: wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'page',
    deviceId: `ocn-${label}-${RUN}`.padEnd(16, '0'), deviceName: `ocn-node-probe ${label}` });
  const ep = createWsEndpoint({ url: entry.url, protocols: sharedProtocols(entry, { role: 'page' }), log: () => {} });
  await new Promise((r) => { if (ep.connected) r(); else ep.onOpen(r); });
  return { ep, content: createContentClient(ep) };
}

/* ================================================================== 切分方:同一台机器上的桌面节点(只切分、不认领细任务) */

const splitterLog = [];
/** 切分方实际出的细任务(`afterSplit` 收到的 TaskInput,只留断言要的几项):A-6 核图卡有没有出浏览器那一份 */
const splitTasks = [];
async function startSplitter({ projectId, creator, codeVersion, envFingerprint, identity, graphIdentity, contentClient }) {
  const [{ normalizeEntry, sharedProtocols }, { createWsEndpoint }, { createLocalNode }, { createProjectClient }, { wsBaseOf }, { layerMapOf, splitCandidatesOf, layerMapKeyOf }] = await Promise.all([
    import('../../server/auth/shared-config.mjs'), import('../../server/render-node/ws-transport.mjs'), import('../../server/render-node/local-node.mjs'),
    import('../../server/render-node/project-client.mjs'), import('../../server/auth/route.mjs'), import('../../server/artifact-transfer.mjs'),
  ]);
  const entry = normalizeEntry({ url: wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render',
    deviceId: `ocn-split-${RUN}`.padEnd(16, '0'), deviceName: 'ocn-node-probe 切分方' });
  const ep = createWsEndpoint({ url: entry.url, protocols: sharedProtocols(entry, { role: 'render' }), log: () => {} });
  const projects = createProjectClient(ep);
  const events = [];
  /** 本机的 contentKey → 这一版项目与控制项(afterSplit 写层表要) */
  const contexts = new Map();
  const node = createLocalNode({
    nodeId: `ocn-splitter-${RUN}`,
    node: { profile: 'pc', envFingerprint, codeVersions: [codeVersion], capabilities: { transcode: false, streams: false, userCards: true, graphCards: true },
      cardSourceVersions: { [CARD_ID]: [identity], [GRAPH_ID]: [graphIdentity] }, weightPolicy: { pc: ['medium'] } },
    endpoint: ep, now: Date.now, projects: [projectId], codeVersion,
    executor: {
      async plan(planTask) {
        const { projectId: pid, projectRev } = planTask.source;
        const project = await projects.get(pid, projectRev);
        if (!project) throw Object.assign(new Error(`第 ${projectRev} 版没有项目快照`), { retryable: false });
        const fps = Number(project.fps) || 30;
        const clips = new Set(planTask.input?.clips ?? []);
        const cardPlan = [];
        for (const tr of project.tracks ?? []) for (const c of tr.clips ?? []) {
          if (!clips.has(c.id) || !c.cardId) continue;
          const first = Math.round(c.start * fps);
          const count = Math.max(1, Math.round((c.end - c.start) * fps));
          const key = `ocn-${RUN}-${planTask.source.userId ?? 'u'}-${c.id}`.replace(/[^\w-]/g, '_');
          // 图卡(A-6):替身按裁定(契约 13A(二))给「画布卡」标记 —— 桌面按图卡整屏快照的体积(2 MB 以上,超过浏览器 300 KB / 1 MB 的上限)与画布位图标 canvasHeavy,
          // 切分方就不出浏览器那一份。这里验的是整条链:标了之后浏览器节点一个图卡任务都不认领。
          const graph = c.cardId === GRAPH_ID;
          cardPlan.push({ clipId: c.id, cardId: c.cardId, snapshotKey: key, contentKey: key, tier: 'shared', start: c.start, end: c.end, count,
            sampling: { firstFrame: first, phase: { numerator: 0, denominator: 1 } }, compositing: 'independent',
            capabilities: { compositing: 'independent', canvasHeavy: graph } });
        }
        splitterLog.push({ at: Date.now(), plan: planTask.id, rev: projectRev, browser: planTask.input?.browser ?? null, cards: cardPlan.map((c) => ({ clipId: c.clipId, count: c.count })) });
        contexts.set(planTask.id, { project, cardPlan });
        return {
          entryKey: `ocn-${RUN}`, cardPlan, prerenderSet: new Set(cardPlan.map((c) => c.clipId)),
          cardSourceVersions: { [CARD_ID]: identity, [GRAPH_ID]: graphIdentity }, isUserCard: (control) => control?.cardId !== GRAPH_ID, isGraphCard: (control) => control?.cardId === GRAPH_ID,
          weightOf: () => ({ class: 'light', estMs: null }),
        };
      },
      async render() { throw Object.assign(new Error('切分方不渲染'), { retryable: true }); },
      // 切分完成后按桌面的写法写层表 v 3:候选 = 切分实际出键的指纹
      async afterSplit(planTask, { tasks }) {
        for (const t of tasks ?? []) splitTasks.push({ plan: planTask.id, id: t.id, clipId: t.input?.clipId ?? null, fingerprint: t.requires?.envFingerprint ?? null, dual: t.input?.dual === true,
          canvasHeavy: t.input?.canvasHeavy === true, userCards: t.requires?.userCards === true, graphCards: t.requires?.graphCards === true, hasBake: !!t.input?.bake });
        const ctx = contexts.get(planTask.id);
        if (!ctx) return;
        const candidates = splitCandidatesOf(tasks);
        const table = layerMapOf({ key: `ocn-${RUN}`, project: ctx.project, cardPlan: ctx.cardPlan }, { fingerprint: envFingerprint, candidatesOf: (c) => candidates.get(c.contentKey) ?? [] });
        // 层表的键按**项目内容里的 id**(在线页面的在线来源按 `project.id` 取层表,桌面也是按它写);不是清单计划里文档服务那一侧的项目号
        await contentClient.put('snapshot-manifest', layerMapKeyOf(ctx.project?.id || planTask.source.projectId), table);
      },
    },
    sink: { has: async () => false, put: async () => ({ complete: false }) },
    onEvent: (e) => { events.push({ at: Date.now(), ...e, results: undefined }); if (events.length > 200) events.shift(); },
  });
  ep.onOpen(() => node.start());
  const timer = setInterval(() => node.tick(), 250);
  return { events, node, stop() { clearInterval(timer); try { node.stop(); } catch { /* 已停 */ } try { ep.close(); } catch { /* 已关 */ } } };
}

/* ================================================================== 页面 */

let browser = null;
const P = (page, fn, ...a) => page.evaluate(fn, ...a);
const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {}); };
async function typeInto(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 20_000 });
  await page.click(sel);
  await page.$eval(sel, (el) => el.select());
  await page.keyboard.press('Backspace');
  if (text) await page.type(sel, text, { delay: 5 });
}
const nodeDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcBrowserNode?.() ?? null)); } catch { return null; } }).catch(() => null);
async function openMember(label, projName, username, projectPassword) {
  const { default: puppeteer } = await import('puppeteer');
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.label = label;
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e).slice(0, 200)));
  await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  await typeInto(page, '[data-pc="join-name"]', projName);
  await typeInto(page, '[data-pc="join-username"]', username);
  await typeInto(page, '[data-pc="join-password"]', projectPassword);
  await page.click('[data-pc="join-submit"]');
  const entered = await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 120_000 }).then(() => true, () => false);
  if (!check(entered, `成员${label}进入项目`)) throw new Error(`成员${label}没进去`);
  await until(`成员${label}页双舞台握上手`, async () => P(page, () => { const d = window.__pcPreviewDiag?.(); return d?.dual && d.onlineStages?.handshake === 'ok'; }), 120_000, 500);
  void puppeteer;
  return page;
}
async function addCardClip(page, label, cardIdOf = CARD_ID) {
  // 同步来的用户卡要等页面把内容库的卡片源码取到、认出它(定时重取,最多几秒)才放得上
  await until(`${page.label}页认出同步来的卡 ${cardIdOf}`, () => P(page, (id) => !!window.__pcCardSources?.()?.cards?.some((c) => c.id === id), cardIdOf), 60_000, 500);
  // 同步来的卡不在主注册表,不能用 addClipOnNewTrack;经 editCardProject 直接放一个片段(同 online-user-cards-probe)
  return P(page, (cardId, label2, tag) => {
    const S = window.__pcStore;
    const id = 'ocn-' + tag;
    S.actions.editCardProject((p) => ({ ...p, duration: Math.max(p.duration, 8), tracks: [{ id: 'ocn-t-' + tag, name: '序列 ' + tag, clips: [{ id, cardId, start: 0, end: 1, params: { text: label2 }, frame: { x: 0, y: 0, w: 640, h: 360 } }] }, ...p.tracks] }));
    S.actions.seek(0.5);
    return id;
  }, cardIdOf, label, label.replace(/[^a-z0-9]/gi, '') + Math.random().toString(36).slice(2, 6));
}

try {
  const DIST = await startLocalSite();
  const { frameCode } = await import('../../server/frame-code.mjs');
  const codeVersion = frameCode(ROOT);
  const embedded = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.js')).some((f) => fs.readFileSync(path.join(DIST, 'assets', f), 'utf8').includes(codeVersion));
  check(embedded, '在线构建嵌的代码版本与本进程算的一致', { codeVersion: codeVersion.slice(0, 12) });

  /* 代码身份:与页面同一个算法(`src/online/cardRuntime/codeIdentity.ts`),源码来自探针写进内容库的那一份,内置文件读本仓库 */
  await import(pathToFileURL(path.join(ROOT, 'src', 'testing', 'registerTs.mjs')).href);
  const { cardCodeIdentityOf, sourceHashOf } = await import(pathToFileURL(path.join(ROOT, 'src', 'online', 'cardRuntime', 'codeIdentity.ts')).href);
  const hash = await sourceHashOf(CARD_SOURCE);
  const identity = (await cardCodeIdentityOf(CARD_KEY, {
    synced: (key) => (key === CARD_KEY ? { body: CARD_SOURCE, hash } : null),
    builtin: (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; } },
  }))?.version;
  check(!!identity, '算出探针卡的代码身份', { identity });
  const graphHash = await sourceHashOf(GRAPH_SOURCE);
  const graphIdentity = (await cardCodeIdentityOf(GRAPH_KEY, {
    synced: (key) => (key === GRAPH_KEY ? { body: GRAPH_SOURCE, hash: graphHash } : null),
    builtin: (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; } },
  }))?.version;
  check(!!graphIdentity, '算出探针图卡的代码身份', { graphIdentity });
  out.steps.identity = identity;

  /* ---------------------------------------------------------------- 0. 建项目、写进空项目、卡片源码进内容库 */
  const { createSharedProject } = await import('../../server/auth/client.mjs');
  const { seedSharedProject } = await import('./lib-seed.mjs');
  const projName = `ocn节点-${RUN}`;
  const creator = { username: 'ocn-creator', password: `pw-${randomBytes(6).toString('hex')}` };
  const projectPassword = `pp-${randomBytes(6).toString('hex')}`;
  const made = await createSharedProject({ base: DOC_DIRECT, name: projName, mode: 'free', creator, password: projectPassword });
  const seeded = await seedSharedProject({ base: DOC_DIRECT, projectId: made.projectId, creator, name: projName });
  check(seeded.ok, '替创建者写进空项目', seeded);
  const adminLink = await creatorContent(made.projectId, creator, 'admin');
  const put = await adminLink.content.put('card-source', CARD_KEY, CARD_SOURCE).catch((e) => ({ error: String(e?.message ?? e) }));
  check(!put?.error, '创建者把用户卡源码写进内容库', put);
  const putGraph = await adminLink.content.put('card-source', GRAPH_KEY, GRAPH_SOURCE).catch((e) => ({ error: String(e?.message ?? e) }));
  check(!putGraph?.error, '创建者把图卡源码写进内容库', putGraph);

  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  browser = await puppeteer.launch({
    headless: true, protocolTimeout: 900_000, defaultViewport: { width: 1600, height: 1000 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-gpu'],
  });

  /* ---------------------------------------------------------------- 1. 甲(本人)进入,当节点;A-0 */
  const A = await openMember('甲', projName, 'ocn-member-a', projectPassword);
  const clipA = await addCardClip(A, 'from-a');
  const ready = await until('甲页面当节点、报到拿到指纹', async () => { const d = await nodeDiag(A); return d?.ready === 'ready' && d.envFingerprint ? d : null; }, 240_000, 500);
  check(ready?.eligibility?.ok, 'A-0 当节点的条件成立', ready?.eligibility);
  out.steps.ready = ready && { envFingerprint: ready.envFingerprint, cardEnvFingerprint: ready.cardEnvFingerprint, cards: ready.cards, nodeId: ready.nodeId };
  say('node.ready', out.steps.ready ?? {});
  const pageEnv = ready?.envFingerprint;
  check(!!pageEnv, 'A-0 页面的 envFingerprint 有值(内置卡路径不变)');

  /* ---------------------------------------------------------------- 2. 等卡片在本页 ready、节点报出运行时版本(★) */
  const cardReady = await until('★ 用户卡在本页载入成功、节点报出运行时版本与卡片代码身份', async () => {
    const d = await nodeDiag(A);
    return d?.cardEnvFingerprint && d.cards?.runtime && d.cards.sources?.[CARD_ID] === identity ? d : null;
  }, 90_000, 500, { pending: true });
  out.steps.cardReady = cardReady && { cardEnvFingerprint: cardReady.cardEnvFingerprint, cards: cardReady.cards };
  check(!!cardReady, 'A-1 ★ 本页载入了这张用户卡,节点报了运行时版本、cardEnvFingerprint 与代码身份', (await nodeDiag(A))?.cards, { pending: true });
  check(cardReady?.cardEnvFingerprint && cardReady.cardEnvFingerprint !== pageEnv, 'A-5 ★ cardEnvFingerprint 与 envFingerprint 不同', { page: pageEnv, card: cardReady?.cardEnvFingerprint }, { pending: true });

  /* 切分方:同一台机器(指纹 = 页面的 envFingerprint) */
  const splitterContent = await creatorContent(made.projectId, creator, 'split');
  const splitter = await startSplitter({ projectId: made.projectId, creator, codeVersion, envFingerprint: pageEnv ?? '5b1177e5b1177e50', identity, graphIdentity, contentClient: splitterContent.content });
  say('splitter.up', { fp: pageEnv });

  /* ---------------------------------------------------------------- 3. 清单计划 → 切分两份 → 甲认领自己那份 → 完成(A-1、A-5) */
  const t0 = Date.now();
  const done = await until('★ 页面节点完成一段用户卡任务', async () => { const d = await nodeDiag(A); return d?.counters?.completed >= 1 ? d : null; }, 300_000, 1000, { pending: true });
  const diag = done ?? (await nodeDiag(A));
  out.steps.node = diag;
  out.steps.completeMs = done ? Date.now() - t0 : null;
  const plan = await P(A, () => window.__pcPlanPublisher?.() ?? null).catch(() => null);
  out.steps.plan = plan && { last: plan.last, log: plan.log };
  out.steps.splitter = { log: splitterLog, events: splitter.events.slice(-40) };
  const mine = splitterLog.filter((s) => s.cards.some((c) => c.clipId === clipA));
  check(mine.length >= 1, 'A-1 ★ 切分方认领了甲的清单计划、列着这张用户卡', splitterLog, { pending: true });
  check(mine.some((s) => s.browser?.cardEnvFingerprint === cardReady?.cardEnvFingerprint && s.browser?.cardSources?.[CARD_ID] === identity),
    'A-1 ★ 清单计划的 input.browser 带 cardEnvFingerprint 与这张卡的代码身份', mine.map((s) => s.browser), { pending: true });
  check(diag?.counters?.claims >= 1 && diag?.counters?.completed >= 1, 'A-1 ★ 甲的节点认领并完成至少一段用户卡任务', diag?.counters, { pending: true });
  check((diag?.upload?.pushed ?? 0) >= 2, 'A-1 ★ 页面推了块(snap + px)', diag?.upload, { pending: true });
  // A-4:页面节点只认领做得了的快照任务,没有因「不支持」放回过、没有失败(要转码的与流在节点侧规则 2 与队列侧被挡,断言在单测 OCN-04)
  check(diag && (diag.counters.released?.unsupported ?? 0) === 0 && diag.counters.failed === 0, 'A-4 ★ 页面节点没有认领过不支持的任务、没有失败', diag?.counters, { pending: true });

  /* ---------------------------------------------------------------- 4. 入库:内容库清单、素材服务的块;层表候选(A-2、A-5) */
  const { resultKeyOf } = await import('../../server/render-node/fingerprint.mjs');
  const { manifestMatches } = await import('../../server/artifact-transfer.mjs');
  const lib = await creatorContent(made.projectId, creator, 'chk');
  // 层表的键按项目内容里的 id(与在线页面取层表的键同一个)
  const contentProjectId = await P(A, () => window.__pcStore.getState().project.id).catch(() => null);
  const layersItem = await lib.content.get('snapshot-manifest', `layers:${contentProjectId || made.projectId}`).catch(() => null);
  const layers = layersItem?.body?.layers ?? [];
  const layer = layers.find((l) => l.clipId === clipA);
  out.steps.layer = layer ? { candidates: layer.candidates?.map((c) => c.envFingerprint), contentKey: layer.contentKey } : null;
  check(layer?.candidates?.some((c) => c.envFingerprint === pageEnv) && layer?.candidates?.some((c) => c.envFingerprint === cardReady?.cardEnvFingerprint),
    'A-2 ★ 层表 v 3 的候选里有切分方(同一台机器、envFingerprint)与浏览器(cardEnvFingerprint)两份', out.steps.layer, { pending: true });
  if (layer && cardReady) {
    const brKey = resultKeyOf(layer.contentKey, cardReady.cardEnvFingerprint);
    const deskKey = resultKeyOf(layer.contentKey, pageEnv);
    check(brKey !== deskKey, 'A-5 ★ 同一台机器上桌面与浏览器的结果键不同', { brKey: brKey.slice(0, 12), deskKey: deskKey.slice(0, 12) }, { pending: true });
    const br = await lib.content.get('snapshot-manifest', `${brKey}:0-29`).catch(() => null);
    const desk = await lib.content.get('snapshot-manifest', `${deskKey}:0-29`).catch(() => null);
    check(br?.body && manifestMatches(br.body, { kind: 'snapshot', resultKey: brKey, range: { from: 0, to: 29 } }), 'A-2 ★ 内容库里有浏览器键的清单(结果键 = 内容键 × cardEnvFingerprint)', { brKey: brKey.slice(0, 12) }, { pending: true });
    check(!desk?.body, 'A-5 ★ 内容库里没有切分方键的清单(这一层只出自浏览器这一种环境、切分方那份作废)', { deskKey: deskKey.slice(0, 12) }, { pending: true });
  }

  /* ---------------------------------------------------------------- 5. 乙进来:按层表贴上浏览器那份(A-2) */
  const B = await openMember('乙', projName, 'ocn-member-b', projectPassword);
  const snapsB = await until('★ 乙的在线来源认到这个片段的层', async () => {
    const s = await P(B, () => { try { return JSON.parse(JSON.stringify(window.__pcOnlineSnapshots?.() ?? null)); } catch { return null; } }).catch(() => null);
    return s?.layers?.some?.((l) => l.clipId === clipA) ? s : null;
  }, 120_000, 1000, { pending: true });
  out.steps.memberB = snapsB && { layers: snapsB.layers?.filter?.((l) => l.clipId === clipA), aliveKeys: snapsB.aliveKeys };
  if (!snapsB) out.steps.memberBDebug = await P(B, (id) => { const j = (v) => { try { return JSON.parse(JSON.stringify(v ?? null)); } catch { return null; } }; const s2 = j(window.__pcOnlineSnapshots?.()); const d = window.__pcCardExecDiag?.(); return { online: s2 && { ...s2, layers: (s2.layers ?? []).slice(0, 6) }, run: d?.run ?? null, clip: window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id) ?? null }; }, clipA).catch((e) => String(e?.message ?? e));
  check(!!snapsB, 'A-2 ★ 乙按层表贴上甲的浏览器节点产出的这一层', out.steps.memberB, { pending: true });
  await shot(B, 'ocn-member-b');

  /* ---------------------------------------------------------------- 5b. 图卡(A-6,2026-10-06 裁定改成「浏览器节点不认领图卡任务」,契约 13A(二)) */
  const beforeG = await nodeDiag(A);
  const clipG = await addCardClip(A, 'graph-a', GRAPH_ID);
  await until('A-6 甲的图卡清单计划被切分', async () => splitterLog.some((s) => s.cards.some((c) => c.clipId === clipG)), 120_000, 500);
  await delay(6000);
  const afterG = await nodeDiag(A);
  const gTasks = splitTasks.filter((t) => t.clipId === clipG);
  out.steps.graph = { tasks: gTasks.map(({ id, ...rest }) => rest), before: beforeG?.counters, after: afterG?.counters, graphCards: afterG?.capabilities?.graphCards ?? null, cards: afterG?.cards ?? null };
  check(gTasks.length >= 1 && gTasks.every((t) => t.graphCards && !t.userCards), 'A-6 切分方给图卡出了细任务,标明是图卡任务(requires.graphCards)', out.steps.graph);
  check(gTasks.every((t) => t.canvasHeavy && !t.dual && !t.hasBake && t.fingerprint === pageEnv), 'A-6 图卡的整屏快照体积超过浏览器的上限、按画布卡处理:每个任务只有切分方(桌面)那一份,没有浏览器那一份(没有 dual、没有 bake 输入、指纹不是 cardEnvFingerprint)', gTasks);
  check(afterG && beforeG && afterG.counters.claims === beforeG.counters.claims, 'A-6 浏览器节点不认领图卡任务:认领数没增加', { before: beforeG?.counters, after: afterG?.counters });

  /* ---------------------------------------------------------------- 6. 丙(另一用户)放同一张卡:甲不认领丙的任务(A-3) */
  const C = await openMember('丙', projName, 'ocn-member-c', projectPassword);
  const clipC = await addCardClip(C, 'from-c');
  const beforeA = await nodeDiag(A);
  await until('★ 丙的清单计划被切分', async () => splitterLog.some((s) => s.cards.some((c) => c.clipId === clipC)), 120_000, 500, { pending: true });
  await delay(5000);
  const afterA = await nodeDiag(A);
  const diagC = await nodeDiag(C);
  out.steps.otherUser = { before: beforeA?.counters, after: afterA?.counters, c: diagC?.counters };
  check(afterA && beforeA && afterA.counters.claims === beforeA.counters.claims, 'A-3 ★ 丙的任务出来之后甲的认领数没增加(甲不认领别人产生的任务)', out.steps.otherUser, { pending: true });
  check(diagC?.state !== undefined, 'A-3 丙的页面也在当节点(它只认领丙自己的)', diagC?.eligibility);
  out.steps.pages = { A: A.errors, B: B.errors, C: C.errors };
  out.ok = fails.length === 0 && (!STRICT || pendingFails.length === 0);
  out.wiringComplete = pendingFails.length === 0;
} catch (e) {
  fails.push(`异常:${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  try { await browser?.close(); } catch { /* 已关 */ }
  try { await hostedProxy?.close(); } catch { /* 已关 */ }
  try { await combo?.close?.(); } catch { /* 已关 */ }
  if (!KEEP) try { fs.rmSync(path.join(TMP, 'hosted'), { recursive: true, force: true }); } catch { /* 留着 */ }
}
out.fails = fails;
out.pendingFails = pendingFails;
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(fails.length || (STRICT && pendingFails.length) ? 1 : 0);
