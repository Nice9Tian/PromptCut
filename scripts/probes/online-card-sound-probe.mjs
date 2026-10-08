/**
 * 在线执行用户卡与图卡 · 声音线程的真实浏览器探针(`docs/plan/online-card-exec-contract.md` 3.5)。
 * 全程在本机:本探针自己起的 dev server,不连任何托管端,不向扬声器出声(Chrome 无头、`--mute-audio`;声音线程只算采样、不播)。
 *
 *   node scripts/probes/online-card-sound-probe.mjs [--port 5783] [--out <目录>] [--phases dev,online]
 *        [--dist dist-online] [--online-base 5780] [--doc-port 8786] [--asset-port 8787]
 *
 * 做法:编辑页面里把几张测试用的用户卡源码转译成包(与在线页面同一个转译入口),交给**后台舞台那个文档**(与编辑页面跨源),
 * 在那里建声音宿主、起声音线程、载入、求采样块。带内容安全策略的舞台入口与「从 blob 地址引导」的起法由安全隔离那一块给,
 * 接上之后隔离断言在安全探针里补;这里核的是功能与线程的环境。端口:dev server 占 `--port` 起连号三个。
 *
 * 验收标准(每项一行 `{ check, ok }`,最后一行 `{ summary }`,有失败退出码 1):
 *   S1 声音线程起在舞台源上(不是编辑页面的源);线程里没有 `document`、`localStorage`、`parent`、`RTCPeerConnection`;
 *   S2 载入:写了 `audio()` 的卡报回来能合成;文件顶上只是引了要 DOM 的包(`lottie-web`)与带画面的内置模块的卡照常载入;
 *      顶层调用了占位的卡载入不成,原因是「声音代码里不能用 lottie-web」;
 *   S3 求一块采样:与编辑页面按同一配方算的逐样本相同,不是静音;后面的块接得上;
 *   S4 线程里的真模块:`three`(真包)、`../native/sound-effects`(卡片目录下不带画面的内置模块,用到才载入)都能用;
 *   S5 卡片代码只在线程里执行:卡片文件顶层写的记号在编辑页面与舞台文档里都没有;
 *   S6 死循环掐得断:到时限线程被掐掉、这一块失败;之后别的卡照常合成(重新起了线程);
 *   S7 要读素材采样的节点不在线合成,原因说明白。
 *
 * 第二段(`--phases online`,S8):在线构建 + 隔离代理(`lib/hosted-proxy.mjs`)的真实路径。创建者把有声用户卡源码写进内容库,在线页面
 * (隔离生效)取回、转译、发给两台舞台;页面请求生成这段卡片的声音,`audio()` 在舞台实例 B 的声音线程里执行,采样回到编辑页面、打包成 WAV 入库。断言:
 *   S8 卡在两台舞台里 ready;生成成功;线程是实例 B 起的(blob 地址、舞台源),实例 A 没起;卡片顶层记号只在线程里;
 *      入库的 WAV 与按同一配方算的期望逐样本一致;没有策略拦截(Refused to …)的报错。
 * 第一段(dev server,不经代理)原样保留。端口:dev server 占 --port 起连号三个;在线段占 --online-base 起三个、文档服务与素材服务各一个。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { createTimings } from './probe-timings.mjs';
import { startDevServer } from '../lib/dev-server.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const PORT = Number(arg('--port', 5783));
const PHASES = new Set(arg('--phases', 'dev,online').split(','));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-card-sound-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`)));
fs.mkdirSync(OUT, { recursive: true });
const results = [];
/** 耗时只记录(docs/semantics/guide_files/verification.md「耗时只记录,不当闸门」):死循环的声音代码被掐断用了多久只写进 TIMINGS 行,不决定过不过 */
const timingLog = createTimings('online-card-sound-probe');
const check = (name, ok, detail = {}) => { results.push({ check: name, ok: !!ok }); console.log(JSON.stringify({ check: name, ok: !!ok, detail }).slice(0, 2000)); return !!ok; };
const log = (...a) => console.error('[card-sound]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 120_000, every = 250) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { last = String(e?.message ?? e); }
    if (v) return v;
    if (Date.now() - t0 > ms) { check(`等到:${what}`, false, { last }); return null; }
    await sleep(every);
  }
}

const U = 'src/cards/user/';
const HEAD = `import type { CardDef } from "../../kernel/types";\n(globalThis as any).__pcSoundProbeMark = ((globalThis as any).__pcSoundProbeMark ?? 0) + 1;\n`;
const SOURCES = {
  // 与 av-pulse 同一种写法:画面是组件,声音按提示音配方合成;文件顶上引了要 DOM 的包与带画面的内置模块(只引、不在顶层调用)
  [`${U}probe-good.tsx`]: `${HEAD}import lottie from "lottie-web";
import { hudControls } from "../native/hud";
import { createNotificationRecipe, renderSoundEffectBlock } from "../../kernel/soundEffects";
const unused = [lottie, hudControls];
export const card: CardDef<{ frequency: number }> = {
  id: "probe-good", name: "探针有声卡", defaults: { frequency: 660 }, controls: [], kind: "animation", inputs: {},
  Component: () => <div data-unused={unused.length} />,
  audio: (_sources, range, params) => renderSoundEffectBlock(createNotificationRecipe({ frequency: params.frequency, gain: 0.5, duration: 0.2 }), { start: range.start, count: range.count }),
};`,
  // 顶层调用了占位
  [`${U}probe-top.tsx`]: `${HEAD}import lottie from "lottie-web";
lottie.loadAnimation({} as any);
export const card: CardDef<{}> = { id: "probe-top", name: "顶层用了 lottie", defaults: {}, controls: [], kind: "animation", inputs: {}, Component: () => null,
  audio: (_s, range) => new Float32Array(range.count) };`,
  // 线程的环境:每个采样位写一个结论(1 = 没有)
  [`${U}probe-env.tsx`]: `${HEAD}export const card: CardDef<{ editorOrigin: string }> = {
  id: "probe-env", name: "线程环境", defaults: { editorOrigin: "" }, controls: [], kind: "animation", inputs: {}, Component: () => null,
  audio: (_s, range, params) => {
    const g = globalThis as any, out = new Float32Array(range.count);
    out[0] = typeof g.document === "undefined" ? 1 : 0;
    out[1] = typeof g.localStorage === "undefined" ? 1 : 0;
    out[2] = typeof g.parent === "undefined" ? 1 : 0;
    out[3] = typeof g.RTCPeerConnection === "undefined" ? 1 : 0;
    out[4] = g.location && g.location.origin !== params.editorOrigin ? 1 : 0;
    out[5] = typeof g.window === "undefined" ? 1 : 0;
    out[6] = Number(g.__pcSoundProbeMark) > 0 ? 1 : 0;
    return out;
  },
};`,
  // 真包与用到才载入的内置模块
  [`${U}probe-mods.tsx`]: `${HEAD}import * as THREE from "three";
import { animate } from "motion";
import { cardSoundBlock } from "../native/sound-effects";
import { createNotificationRecipe } from "../../kernel/soundEffects";
const keep = [animate];
export const card: CardDef<{}> = { id: "probe-mods", name: "真模块", defaults: {}, controls: [], kind: "animation", inputs: {}, Component: () => <i data-k={keep.length} />,
  audio: async (_s, range) => {
    const block = await cardSoundBlock(createNotificationRecipe({ frequency: 520, gain: 0.5, duration: 0.2 }), range);
    const out = new Float32Array(block);
    out[0] = new THREE.Vector3(3, 4, 0).length();
    return out;
  } };`,
  // 死循环
  [`${U}probe-loop.tsx`]: `${HEAD}export const card: CardDef<{}> = { id: "probe-loop", name: "死循环", defaults: {}, controls: [], kind: "animation", inputs: {}, Component: () => null,
  audio: () => { for (;;) { /* 掐不断就永远不回 */ } } };`,
};

/**
 * 同步来的有声用户卡经真实加载路径:创建者把卡源码 `content.put` 进内容库 → 在线页面(隔离生效)取回、转译、发给两台舞台 →
 * 页面请求生成这段卡片的声音(`generateCardAudio`)→ `audio()` 在舞台实例 B 起的声音线程里执行 → 采样块回到编辑页面 → 打包成 WAV 入库。
 * 与上面 dev server 一段不同:这里舞台是跨源的 `s1./s2.pc.localhost`(带内容安全策略与出口白名单),线程从舞台源的 blob 地址引导。
 */
const ONLINE_CARD_ID = 'probe-online-audio';
const ONLINE_CARD_KEY = `${U}${ONLINE_CARD_ID}.tsx`;
const ONLINE_FREQ = 880;
const ONLINE_CARD_SOURCE = `/** 探针:同步来的有声用户卡(在线构建里没有) */
import type { CardDef } from "../../kernel/types";
import { createNotificationRecipe, renderSoundEffectBlock } from "../../kernel/soundEffects";
(globalThis as any).__pcSoundProbeMark = ((globalThis as any).__pcSoundProbeMark ?? 0) + 1;
export const probeOnlineAudio: CardDef<{ frequency: number }> = {
  id: "${ONLINE_CARD_ID}",
  name: "探针在线有声卡",
  description: "在线执行的声音线程探针用",
  frameMode: "stateful",
  defaults: { frequency: ${ONLINE_FREQ} },
  controls: [{ key: "frequency", label: "频率", type: "number", min: 100, max: 4000, step: 10 }],
  Component: () => <div className="absolute inset-0 flex items-center justify-center text-[64px]">probe-online-audio</div>,
  audio: (_sources: unknown, range: { start: number; count: number }, params: { frequency: number }) =>
    renderSoundEffectBlock(createNotificationRecipe({ frequency: params.frequency, gain: 0.5, duration: 0.2 }), { start: range.start, count: range.count }),
};
`;

/** 解一段 WAV(PCM 16/24/32 位整数或 32 位浮点,取第一个声道),回 { sampleRate, channels, frames, ch0 } */
function parseWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF') throw new Error('不是 RIFF');
  let pos = 12, fmt = null, dataAt = -1, dataLen = 0;
  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(pos, pos + 4)), len = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') fmt = { tag: dv.getUint16(pos + 8, true), channels: dv.getUint16(pos + 10, true), sampleRate: dv.getUint32(pos + 12, true), bits: dv.getUint16(pos + 22, true) };
    if (id === 'data') { dataAt = pos + 8; dataLen = Math.min(len, bytes.length - dataAt); break; }
    pos += 8 + len + (len & 1);
  }
  if (!fmt || dataAt < 0) throw new Error('没有 fmt / data');
  const bytesPer = fmt.bits / 8, frames = Math.floor(dataLen / (bytesPer * fmt.channels));
  const ch0 = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const at = dataAt + i * bytesPer * fmt.channels;
    ch0[i] = fmt.tag === 3 ? dv.getFloat32(at, true) : fmt.bits === 16 ? dv.getInt16(at, true) / 32768 : fmt.bits === 24 ? ((dv.getUint8(at) | (dv.getUint8(at + 1) << 8) | (dv.getInt8(at + 2) << 16)) / 8388608) : dv.getInt32(at, true) / 2147483648;
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, frames, ch0 };
}

const cleanups = [];
let exitCode = 1;
try {
  await main();
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ summary: { checks: results.length, passed: results.length - failed.length, fails: failed.map((r) => r.check), out: OUT } }));
  exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.log(JSON.stringify({ summary: { checks: results.length, error: String(e?.stack ?? e).slice(0, 1500), fails: results.filter((r) => !r.ok).map((r) => r.check), out: OUT } }));
} finally {
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* 尽力清 */ } }
}
timingLog.print();
process.exit(exitCode);

async function main() {
  if (PHASES.has('dev')) await devPhase();
  if (PHASES.has('online')) await onlinePhase();
}

async function devPhase() {
  const dirs = { exportDir: path.join(OUT, 'export'), dataDir: path.join(OUT, 'data'), projectsDir: path.join(OUT, 'projects') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  log('起 dev server', PORT);
  const server = await startDevServer({ port: PORT, logFile: path.join(OUT, 'vite.log'), log,
    env: { PROMPTCUT_EXPORT_DIR: dirs.exportDir, PROMPTCUT_DATA_DIR: dirs.dataDir, PROMPTCUT_PROJECTS_DIR: dirs.projectsDir, PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_PUSH: '0' } });
  cleanups.push(() => server.stop());
  const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--mute-audio', '--no-first-run', '--hide-scrollbars'] });
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 200)));
  await page.goto(`${server.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('编辑器就绪', () => page.evaluate(() => !!window.__pcStore && !!window.__pcPreviewDiag), 180_000);
  const stage = await until('后台舞台(跨源的那个文档)', () => page.frames().find((f) => /[?&]stage=1/.test(f.url()) && /[?&]id=B/.test(f.url())) ?? null, 120_000);
  if (!stage) return;
  await until('后台舞台载完', () => stage.evaluate(() => document.readyState === 'complete'), 120_000);
  const editorOrigin = new URL(page.url()).origin, stageOrigin = new URL(stage.url()).origin;

  /* ---- 编辑页面:转译成包(只读文本、不执行) */
  const bundled = await page.evaluate(async (sources) => {
    const T = await import('/src/online/cardRuntime/transpile.browser.ts');
    const hashOf = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const files = new Map();
    for (const [key, body] of Object.entries(sources)) files.set(key, { body, hash: await hashOf(body) });
    const out = await T.bundleCards({ entries: Object.keys(sources), read: (key) => files.get(key) ?? null });
    return out.map((r) => (r.ok ? { ok: true, entry: r.entry, bundle: r.bundle } : { ok: false, entry: r.entry, state: r.state }));
  }, SOURCES);
  const bundles = bundled.filter((b) => b.ok).map((b) => b.bundle);
  check('转译:五张测试卡都打成了包', bundles.length === Object.keys(SOURCES).length, { failed: bundled.filter((b) => !b.ok) });

  /* ---- 后台舞台:建声音宿主、起线程、载入、求块 */
  const clip = (id, cardId, extra = {}) => ({ id, cardId, start: 0, end: 0.5, params: {}, ...extra });
  const project = { version: 1, id: 'p', name: 'p', width: 640, height: 360, fps: 30, duration: 2,
    media: [{ id: 'media-1', kind: 'audio', name: 'a.wav', url: '/x', hash: 'a'.repeat(64) }],
    tracks: [{ id: 't', name: 't', clips: [clip('g', 'probe-good', { params: { frequency: 880 } }), clip('e', 'probe-env', { params: { editorOrigin } }), clip('m', 'probe-mods'), clip('l', 'probe-loop'),
      clip('src', undefined, { mediaId: 'media-1' }), clip('rd', 'probe-good', { nodeId: 'n-read' })] }],
    cardNodes: [{ id: 'n-read', adapter: 'card', cardId: 'probe-good', kind: 'animation', embeddedAudio: true, inputs: { source: { nodeId: '@clip/src/source' } }, params: {} }] };
  const ran = await stage.evaluate(async ({ bundles, project }) => {
    const H = await import('/src/online/cardRuntime/soundHost.ts');
    const SP = await import('/src/online/cardRuntime/soundSpawn.ts');
    // 时限按十分之一走(真的规则是每秒声音 2 秒、最少 10 秒;这里只为探针别等太久),掐线程走的是同一条路
    // 舞台接管了 setTimeout(虚拟时钟),时限要走真计时的口子;载入的时限不缩(开发服务器第一次载入线程的模块要一会儿)
    const real = window.__pcRealSetTimeout ?? setTimeout;
    const host = H.createSoundHost({ spawn: SP.spawnSoundWorker, setTimer: (fn, ms) => real(fn, ms === H.SOUND_LOAD_TIMEOUT_MS ? ms : ms / 10), clearTimer: (t) => clearTimeout(t) });
    const out = { origin: location.origin };
    out.loaded = await host.setBundles(bundles);
    const ask = async (nodeId, start = 0, count = 4096, key = 'k1') => {
      try { return { samples: [...(await host.render({ projectKey: key, project, nodeId, start, count, sampleRate: 48000 }))] }; }
      catch (e) { return { error: String(e?.message ?? e) }; }
    };
    out.good0 = await ask('@clip/g/card', 0, 4096);
    out.good1 = await ask('@clip/g/card', 4096, 1024);
    out.env = await ask('@clip/e/card', 0, 16);
    out.mods = await ask('@clip/m/card', 0, 2048);
    out.read = await ask('n-read', 0, 64);
    window.__pcProbeSound = { host, ask };
    return out;
  }, { bundles, project });
  // 死循环那一块单独问:耗时在探针这一侧量(舞台里的时钟是虚拟的)
  const loopAt = Date.now();
  ran.loop = await stage.evaluate(() => window.__pcProbeSound.ask('@clip/l/card', 0, 64));
  ran.loopMs = Date.now() - loopAt;
  Object.assign(ran, await stage.evaluate(async () => {
    const { host, ask } = window.__pcProbeSound;
    const afterLoop = await ask('@clip/g/card', 0, 512);
    const stats = host.stats();
    host.dispose();
    delete window.__pcProbeSound;
    return { afterLoop, stats, markInStage: globalThis.__pcSoundProbeMark ?? null };
  }));
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ...ran, good0: { n: ran.good0.samples?.length }, mods: { n: ran.mods.samples?.length } }, null, 1));

  // 编辑页面按同一配方算的期望值
  const want = await page.evaluate(async () => {
    const K = await import('/src/kernel/soundEffects.ts');
    const block = (hz, start, count) => [...K.renderSoundEffectBlock(K.createNotificationRecipe({ frequency: hz, gain: 0.5, duration: 0.2 }), { start, count })];
    return { good0: block(880, 0, 4096), good1: block(880, 4096, 1024), mods: block(520, 0, 2048), good512: block(880, 0, 512), markInEditor: globalThis.__pcSoundProbeMark ?? null };
  });
  const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => Object.is(Math.fround(v), Math.fround(b[i])));

  const env = ran.env.samples ?? [];
  check('S1 声音线程起在舞台源上;线程里没有 document、localStorage、parent、RTCPeerConnection、window',
    ran.origin === stageOrigin && stageOrigin !== editorOrigin && env[0] === 1 && env[1] === 1 && env[2] === 1 && env[3] === 1 && env[4] === 1 && env[5] === 1,
    { editorOrigin, stageOrigin, hostOrigin: ran.origin, env: env.slice(0, 7), error: ran.env.error });
  const blocked = ran.loaded?.blocked ?? {};
  check('S2 载入:能合成的卡报回来;只是引了占位的照常载入;顶层调用了占位的载入不成并说明原因',
    JSON.stringify(ran.loaded?.audioCards) === JSON.stringify(['probe-env', 'probe-good', 'probe-loop', 'probe-mods']) && Object.keys(blocked).length === 1 && /声音代码里不能用 lottie-web/.test(blocked[`${U}probe-top.tsx`] ?? ''),
    { audioCards: ran.loaded?.audioCards, blocked });
  check('S3 求一块采样:与编辑页面按同一配方算的逐样本相同,不是静音;后面的块接得上',
    same(ran.good0.samples, want.good0) && same(ran.good1.samples, want.good1) && ran.good0.samples.some((v) => v !== 0),
    { n0: ran.good0.samples?.length, n1: ran.good1.samples?.length, peak: ran.good0.samples ? Math.max(...ran.good0.samples.map(Math.abs)) : null, error: ran.good0.error ?? ran.good1.error });
  const mods = ran.mods.samples ?? [];
  check('S4 线程里的真模块:three 算得出数(3-4-5 的斜边),卡片目录下不带画面的内置模块(cardSoundBlock)能用',
    mods[0] === 5 && mods.length === want.mods.length && same(mods.slice(1), want.mods.slice(1)), { first: mods[0], n: mods.length, error: ran.mods.error });
  check('S5 卡片代码只在线程里执行:文件顶层的记号在线程里有,在编辑页面与舞台文档里都没有',
    env[6] === 1 && want.markInEditor === null && ran.markInStage === null, { inThread: env[6], inEditor: want.markInEditor, inStage: ran.markInStage });
  // 下界(不早于合成时限)是产品计时器的行为,仍是通过条件;上界(原 < 8 秒)随机器快慢,只记录
  timingLog.record('S6 死循环的声音代码从求这一块到被掐断', ran.loopMs, { formerLimit: '950 ms ～ 8 秒(上界不再作通过条件)' });
  check('S6 死循环掐得断:到时限这一块失败、线程被掐掉;之后别的卡照常合成(重新起了线程)',
    /合成超时/.test(ran.loop.error ?? '') && ran.loopMs >= 950 && same(ran.afterLoop.samples, want.good512) && ran.stats.timeouts === 1 && ran.stats.spawned === 2,
    { loop: ran.loop.error, loopMs: ran.loopMs, stats: ran.stats, afterLoop: ran.afterLoop.error ?? ran.afterLoop.samples?.length });
  check('S7 要读素材采样的节点不在线合成,原因说明白', /要读素材的声音采样/.test(ran.read.error ?? ''), { read: ran.read.error ?? 'ok' });
  check('页面没有报错', errors.length === 0, { errors: errors.slice(0, 5) });
}

/* ================================================================== 在线构建 + 隔离代理的真实路径(S8) */

async function onlinePhase() {
  const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
  const { createSharedProject, buildAuthProtocols } = await import('../../server/auth/client.mjs');
  const { startHostedProxy, proxyOrigins } = await import('./lib/hosted-proxy.mjs');
  const { seedSharedProject } = await import('./lib-seed.mjs');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { check('S8 前提:有在线构建', false, { dist: DIST }); return; }
  const BASE = Number(arg('--online-base', 5780)), DOC_PORT = Number(arg('--doc-port', 8786)), ASSET_PORT = Number(arg('--asset-port', 8787));
  const ORIGINS = proxyOrigins(BASE);
  const DOC_DIRECT = `http://127.0.0.1:${DOC_PORT}`;
  log('在线:起托管组合与隔离代理', BASE, DOC_PORT, ASSET_PORT);
  const dataDir = fs.mkdtempSync(path.join(OUT, 'hosted-'));
  const combo = await startHostedCombo({ dataDir, docPort: DOC_PORT, assetPort: ASSET_PORT, host: '127.0.0.1', trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'),
    docPublicUrl: `ws://pc.localhost:${BASE}/hosted/`, assetPublicUrl: `${ORIGINS.editor}/media/api/asset`, log: () => {} });
  cleanups.push(() => combo.close?.());
  const proxy = await startHostedProxy({ dist: DIST, basePort: BASE, docPort: DOC_PORT, assetPort: ASSET_PORT, policy: 'full' });
  cleanups.push(() => proxy.close());

  const NAME = `ocsnd-${Date.now().toString(36)}`;
  const creator = { username: 'boss', password: `boss-${randomBytes(9).toString('hex')}` };
  const PROJECT_PW = `pw-${randomBytes(9).toString('hex')}`;
  const made = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });
  const seeded = await seedSharedProject({ base: DOC_DIRECT, projectId: made.projectId, creator, name: NAME });
  check('S8 准备:托管组合、隔离代理、共享项目写进空项目', seeded.ok, seeded);

  // 创建者的凭证连接:写卡片源码、取读写票据(只用来在探针里读回生成的 WAV)
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId: made.projectId, username: creator.username, deviceId: 'ocsnd-probe-node-01', deviceName: 'probe-node', as: 'creator', password: creator.password, role: 'page' });
  const ws = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  cleanups.push(() => ws.close());
  const ask = (msg) => new Promise((resolve) => {
    const reqId = `p${Math.random().toString(36).slice(2)}`;
    const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  await ask({ type: 'project.open', projectId: made.projectId });
  const put = await ask({ type: 'content.put', kind: 'card-source', key: ONLINE_CARD_KEY, body: ONLINE_CARD_SOURCE });
  check('S8 准备:创建者把有声用户卡源码写进内容库(card-source)', put.type === 'content.stored', put);
  const tk = await ask({ type: 'auth.ticket', kind: 'asset', access: 'rw' });

  const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--mute-audio', '--no-first-run', '--hide-scrollbars', '--site-per-process', '--window-position=-32000,-32000'] });
  cleanups.push(() => browser.close());
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  const errors = [], refused = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 200)));
  page.on('console', (m) => { if (/Refused to /.test(m.text())) refused.push(m.text().slice(0, 200)); });
  // 每个文档(编辑页面与舞台)里给 Worker 包一层,只记「起了几个 Worker、从哪种地址起的」,不改线程
  await page.evaluateOnNewDocument(() => {
    try {
      const W = window.Worker;
      if (typeof W !== 'function') return;
      window.__pcWorkerSpawns = [];
      const Wrapped = function (url, ...rest) { try { window.__pcWorkerSpawns.push(String(url).slice(0, 12)); } catch { /* 记不下就算了 */ } return new W(url, ...rest); };
      Wrapped.prototype = W.prototype;
      Object.defineProperty(window, 'Worker', { value: Wrapped, configurable: true, writable: true });
    } catch { /* 没有 Worker */ }
  });
  const typeInto = async (sel, value) => { await page.waitForSelector(sel, { visible: true, timeout: 30_000 }); await page.click(sel, { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type(sel, value, { delay: 5 }); };
  await page.goto(`${ORIGINS.editor}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  await typeInto('[data-pc="join-name"]', NAME);
  await typeInto('[data-pc="join-username"]', 'member-a');
  await typeInto('[data-pc="join-password"]', PROJECT_PW);
  await page.click('[data-pc="join-submit"]');
  await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
  await until('在线:时间轴与声音入口', () => page.evaluate(() => !!window.__pcStore && !!window.__pcIo?.sound), 60_000);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && !f.detached);
  const diag = () => page.evaluate(() => { const d = window.__pcPreviewDiag?.(); return d ? { dual: d.dual, cardExec: d.cardExec } : null; });
  await until('在线:本页的执行判定落定、两台舞台都在', async () => { const d = await diag(); return d?.cardExec && d.cardExec.reason !== 'pending' && stageFrames().length >= 2 ? d : null; }, 60_000);
  const d0 = await diag();
  check('S8 前提:在线页面是双舞台、本页判「可执行」(隔离生效)', d0?.dual === true && d0?.cardExec?.enabled === true, d0?.cardExec);
  const stageOrigins = stageFrames().map((f) => new URL(f.url()).origin).sort();
  check('S8 两台舞台是跨源的 s1./s2.pc.localhost 子域(与编辑页面不同源)', JSON.stringify(stageOrigins) === JSON.stringify([...ORIGINS.stages].sort()) && !stageOrigins.includes(ORIGINS.editor), stageOrigins);

  await until('在线:页面认出同步来的有声卡', () => page.evaluate((id) => !!window.__pcCardSources?.()?.cards?.some((c) => c.id === id), ONLINE_CARD_ID), 60_000, 500);
  const clipId = 'ocsnd-clip';
  await page.evaluate((card, id) => {
    window.__pcStore.actions.editCardProject((p) => ({ ...p, duration: Math.max(p.duration, 6),
      tracks: [{ id: 'ocsnd-t', name: '序列 ocsnd', clips: [{ id, cardId: card, start: 0, end: 1, params: {}, frame: { x: 0, y: 0, w: 640, h: 360 } }] }, ...p.tracks] }));
  }, ONLINE_CARD_ID, clipId);
  const runState = await until('在线:这张卡在两台舞台都「能运行」(ready)', async () => {
    const s = await page.evaluate((id) => { const d = window.__pcCardExecDiag?.(); if (!d) return null; return { available: d.available, per: Object.fromEntries(Object.entries(d.stages).map(([k, v]) => [k, (v.states.find((x) => x[0] === id) ?? [null, null])[1]])) }; }, ONLINE_CARD_ID);
    return s && s.per.A?.state === 'ready' && s.per.B?.state === 'ready' ? s : null;
  }, 60_000, 500);
  check('S8 同步来的有声用户卡在两台舞台里载入成功(运行状态 ready)', !!runState, runState);

  // 请求生成这段卡片的声音:audio() 经舞台 RPC 到实例 B 起的线程
  const gen = await page.evaluate(async (id) => {
    try { const sound = await window.__pcIo.sound(); const out = await sound.generateCardAudio(id, { force: true }); return { ok: out?.ok === true, mediaId: out?.mediaId ?? null, reused: out?.reused ?? null }; }
    catch (e) { return { error: String(e?.message ?? e).slice(0, 300) }; }
  }, clipId);
  check('S8 在线页面生成这段同步卡的声音:成功(判轻、在浏览器里合成)', gen.ok === true && !!gen.mediaId, gen);

  const spawns = await Promise.all(stageFrames().map((f) => f.evaluate(() => ({ id: new URLSearchParams(location.search).get('id'), origin: location.origin, spawns: window.__pcWorkerSpawns ?? [] })).catch(() => null)));
  const spawnsB = spawns.find((s) => s?.id === 'B'), spawnsA = spawns.find((s) => s?.id === 'A');
  check('S8 声音线程是舞台实例 B 起的(blob 地址、在舞台源上),实例 A 没有为这张卡起线程',
    !!spawnsB && spawnsB.spawns.some((u) => /^blob:/.test(u)) && ORIGINS.stages.includes(spawnsB.origin) && (spawnsA?.spawns.length ?? 0) === 0,
    { B: spawnsB, A: spawnsA });
  const marks = await page.evaluate(() => globalThis.__pcSoundProbeMark ?? null);
  const stageMarks = await Promise.all(stageFrames().map((f) => f.evaluate(() => globalThis.__pcSoundProbeMark ?? null).catch(() => 'err')));
  // 同一个文件的模块顶层在两台舞台的窗口里也会执行(画面那一半由舞台里的加载器载入);不许出现的是编辑页面
  check('S8 卡片文件顶层的记号不在编辑页面里(编辑页面不执行卡片代码);两台隔离舞台的窗口里有(画面那一半)', marks === null && stageMarks.length === 2 && stageMarks.every((m) => m !== null), { editor: marks, stages: stageMarks });

  // 采样回到编辑页面、打包成 WAV 入库:取回字节,与编辑页面按同一配方算的期望逐样本比
  const media = await page.evaluate((id) => { const m = window.__pcStore.getState().project.media.find((x) => x.id === id); return m ? { hash: m.hash, kind: m.kind, duration: m.duration ?? null } : null; }, gen.mediaId ?? '');
  let wav = null, fetchErr = null;
  if (media?.hash) {
    try {
      const r = await fetch(`http://127.0.0.1:${ASSET_PORT}/api/asset/media/${media.hash}`, { headers: { authorization: `Bearer ${tk.ticket}` } });
      if (r.ok) wav = parseWav(new Uint8Array(await r.arrayBuffer())); else fetchErr = `状态 ${r.status}`;
    } catch (e) { fetchErr = String(e?.message ?? e).slice(0, 200); }
  }
  // 在线构建里没有 `/src/…` 可引,期望值不在页面里现算:按过零点数出前 4096 个采样的主频,应当是配方里的那个频率
  const head = wav ? Array.from(wav.ch0.slice(0, 4096)) : [];
  let crossings = 0;
  for (let i = 1; i < head.length; i++) if ((head[i - 1] < 0) !== (head[i] < 0)) crossings++;
  const heardHz = head.length ? crossings / 2 / (head.length / 48000) : 0;
  const want = { hz: ONLINE_FREQ, heardHz: Math.round(heardHz) };
  const near = () => Math.abs(heardHz - ONLINE_FREQ) <= ONLINE_FREQ * 0.06;
  check('S8 采样块回到了编辑页面并入库:取回的 WAV 前 4096 个采样的主频是配方里的频率(±6%),不是静音',
    !!wav && wav.sampleRate === 48000 && wav.frames >= 48000 * 0.9 && near(wav.ch0, want, 2e-3) && wav.ch0.slice(0, 4096).some((v) => Math.abs(v) > 0.05),
    { media, fetchErr, sampleRate: wav?.sampleRate, frames: wav?.frames, peak: wav ? Math.max(...wav.ch0.slice(0, 4096).map(Math.abs)) : null });
  check('S8 没有策略拦截的控制台报错(Refused to …)与页面错误', refused.length === 0 && errors.length === 0, { refused: refused.slice(0, 3), errors: errors.slice(0, 3) });
}
