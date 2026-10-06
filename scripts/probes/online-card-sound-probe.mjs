/**
 * 在线执行用户卡与图卡 · 声音线程的真实浏览器探针(`docs/plan/online-card-exec-contract.md` 3.5)。
 * 全程在本机:本探针自己起的 dev server,不连任何托管端,不向扬声器出声(Chrome 无头、`--mute-audio`;声音线程只算采样、不播)。
 *
 *   node scripts/probes/online-card-sound-probe.mjs [--port 5720] [--out <目录>]
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
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startDevServer } from '../lib/dev-server.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const PORT = Number(arg('--port', 5720));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-card-sound-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`)));
fs.mkdirSync(OUT, { recursive: true });
const results = [];
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
process.exit(exitCode);

async function main() {
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
  check('S6 死循环掐得断:到时限这一块失败、线程被掐掉;之后别的卡照常合成(重新起了线程)',
    /合成超时/.test(ran.loop.error ?? '') && ran.loopMs >= 950 && ran.loopMs < 8000 && same(ran.afterLoop.samples, want.good512) && ran.stats.timeouts === 1 && ran.stats.spawned === 2,
    { loop: ran.loop.error, loopMs: ran.loopMs, stats: ran.stats, afterLoop: ran.afterLoop.error ?? ran.afterLoop.samples?.length });
  check('S7 要读素材采样的节点不在线合成,原因说明白', /要读素材的声音采样/.test(ran.read.error ?? ''), { read: ran.read.error ?? 'ok' });
  check('页面没有报错', errors.length === 0, { errors: errors.slice(0, 5) });
}
