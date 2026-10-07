/**
 * 在线浏览器执行用户卡与图卡的功能验收(任务书 `docs/plan/sound-online-render-task.md` 第 15 条;
 * 契约 `docs/plan/online-card-exec-contract.md` 第 8、11.1、13A 节)。
 *
 *   npx vite build --mode online
 *   node scripts/probes/online-card-exec-probe.mjs [--dist dist-online] [--base-port 5720] [--doc-port 8796] [--asset-port 8797] [--out <截图目录>]
 *
 * 全程在本机、不连任何远端,不向扬声器出声(Chrome 无头、`--mute-audio`;「听到」按数字判):本机托管组合(素材服务真核票据)
 * + 仿 nginx 的代理 `lib/hosted-proxy.mjs`(带全套策略头的隔离摆法)+ 在线构建。
 *
 * 做法:创建者一侧**不起桌面编辑器**(证明没有任何预渲染产物时也画得出来),替创建者把卡片源码 `content.put` 进内容库,
 * 把一段纯色视频与一段短 WAV 传进素材服务;在线普通档的成员页加入这个协作项目,时间轴上摆好:
 *   用户画面卡 `oce-visual`、用户有声卡(画面组件加 `audio()`)`oce-sound`、带相对导入的用户卡 `oce-rel`
 *   (引同目录的 `./oce-rel-helper`、页面自带的 `../native/hud`、`./oce-rel.css`)、带视频输入源的图卡 `oce-invert`、
 *   纯合成的音频图卡 `oce-tone`、读素材采样的音频图卡 `oce-sample`,另有故意很慢的用户卡 `oce-slow`、
 *   用了 `namespace` 的 `oce-ns`、引了 `lodash` 的 `oce-lodash`。
 * 创建者一侧摆法的代码放在本文件里的 `CARDS`;卡片顶层写着记号 `globalThis.__pcOceMark`,探针用它核「哪个文档里执行了卡片代码」。
 *
 * # 验收标准(每条一行「过 / 不过」,最后一行是 JSON `{ ok, pass, fail, fails, ... }`;退出码 = 有没有「不过」)
 *
 * E1 前提:本页隔离生效(双舞台、可执行、外链允许),没有任何预渲染产物(层表空、没有 `snap/` 与 `px/` 请求);
 *    各张同步卡在两台舞台里载入成功(运行状态 `ready`)。
 * E2 判轻的直接画出来:`oce-visual`、`oce-sound`、`oce-rel` 的片段在可见舞台里是活的 DOM(带各自的记号节点与文字),没有「需要本地 PC 渲染辅助」
 *    的图标、时间轴不挂徽标、整个过程里没有 `snap/` 与 `px/` 请求;截图。相对导入生效:引到的 helper 的文字、`.css` 的背景色(算出样式)、
 *    页面自带的 `../native/hud`(数据属性里有它的导出个数)都在;编辑页面(顶层文档)里没有执行卡片代码的记号,两台舞台里有。
 * E3 听得到声音(按数字,不靠人听):用户有声卡与纯合成的音频图卡在预览里播放,`<audio>` 在走、声音源是浏览器合成的 blob 地址、解码后窗口里有能量、
 *    实时采样有峰值;判定测量期间没有新建音频上下文、没有元素开始播放、没有新建可播放地址、没有声源启动、页面上没有在播的媒体元素;
 *    用户有声卡的声音生成后入库(WAV 在素材服务里);读素材采样的音频图卡**不在线合成**,判定是「合成不了」并给出原因说明(说明原文进输出)。
 * E4 改参数即时生效:把 `oce-visual` 的文字参数改掉,舞台里的 DOM 文字几秒内跟着变;另一成员(乙)的项目里与舞台里都看得到。
 * E5 图卡:带视频输入源的图卡在舞台里画出输出(片段中心的像素是视频那一帧颜色的反色,容差 ±24),视频经舞台源上的 `/media-s/<会话号>/media/<哈希>` 取到、
 *    请求里不带 `?t=`。
 * E6 判重的仍走预渲染或渲染节点:故意很慢的 `oce-slow`(摆在 10～14 秒,免得它在 0～4 秒拖慢别的卡的播放)测量后判重(进测量记录),播放中被抑制,页面发布的清单计划含它;
 *    探针替渲染节点写层表与清单后,舞台里换成预渲染快照、不挂徽标。同时判轻的卡不在清单计划里、没被抑制。
 * E7 三种退回:`namespace` 的卡(`unsupported-syntax`)、引 `lodash` 的卡(`missing-module`)按原做法 —— 图标「需要本地 PC 渲染辅助」、时间轴徽标、
 *    进清单计划;参数面板出现对应的说明(原文进输出)。另开一个 `--disable-gpu --disable-software-rasterizer` 的浏览器:图卡的运行状态是 `gpu`、
 *    参数面板说明「图形能力不够」、舞台不挂图卡的画布,DOM 用户卡不受影响。
 * E8 源码更新后在线页面跟着换:创建者把 `oce-visual` 的源码换一版,10 秒内舞台里的画面是新版的、成本身份(测量记录里的 identityKey)换了、
 *    浏览器节点报的代码身份换了。
 * E10 导出页不执行卡片代码、贴同步卡的预渲染原尺寸:另开一个只有一张同步画面卡的项目,渲染节点的预渲染原尺寸由探针替它写;在线逐帧导出(`exportVideoBrowser`,
 *     同源 `?export=1` 的导出页)进行中采样导出页:没有卡片模块的顶层记号(编辑页面里也没有)、同步卡的包裹层挂出来但没有活内容、每一帧都换成预渲染原尺寸;导出完成,成片第一帧
 *     左上角像素是预渲染原尺寸的颜色。
 * E9 手机低内存档(仿手机)按现有规则走:运行状态 `low-memory`、参数面板说明「低内存档」、两个文档里都没有执行卡片代码的记号,没有预渲染结果的卡显示图标。
 *
 * 耗时只记录,不当通过条件(verification.md「耗时只记录,不当闸门」):E8 换成新版的用时写进 TIMINGS 行;等待时限只为防卡死。不打印令牌、口令(输出里的票据形状串一律抹掉)。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { createTimings } from './probe-timings.mjs';
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';
import { seedSharedProject } from './lib-seed.mjs';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';
import { createAssetClient } from '../../server/asset-store/client.mjs';
import { findFfmpeg } from '../../server/bakery/index.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const BASE = Number(arg('--base-port', 5720));
const DOC_PORT = Number(arg('--doc-port', 8796)), ASSET_PORT = Number(arg('--asset-port', 8797));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'online-card-exec-shots')));
const ORIGINS = proxyOrigins(BASE);
const DOC_DIRECT = `http://127.0.0.1:${DOC_PORT}`;
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
/** 耗时只记录(docs/semantics/guide_files/verification.md「耗时只记录,不当闸门」):源码更新后舞台换成新版用了多久只写进 TIMINGS 行,不决定过不过 */
const timingLog = createTimings('online-card-exec-probe');
let pass = 0;
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s === undefined ? '' : (s.length > 500 ? `${s.slice(0, 500)}…` : s).replace(/v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'v1.***'); };
const check = (label, ok, detail) => { console.log(`${ok ? '  过' : '不过'}  ${label}${detail !== undefined ? `  〔${short(detail)}〕` : ''}`); if (ok) pass++; else fails.push(label); return !!ok; };
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
const UNSUPPORTED = '需要本地 PC 渲染辅助';

/* ------------------------------------------------------------------ 卡片源码(创建者 content.put 进内容库) */
const U = 'src/cards/user/';
const MARK = '(globalThis as any).__pcOceMark = ((globalThis as any).__pcOceMark ?? 0) + 1;';
const visualSource = (prefix, tint) => `/** 探针:同步来的用户画面卡 */
import type { CardDef, CardProps } from "../../kernel/types";
${MARK}
interface Params { text: string; tint: string }
function OceVisual({ params }: CardProps<Params>) {
  return <div data-oce-visual="1" className="absolute inset-0 flex items-center justify-center" style={{ color: params.tint, fontSize: 56 }}>${prefix} {params.text}</div>;
}
export const oceVisual: CardDef<Params> = {
  id: "oce-visual", name: "在线探针画面卡", description: "在线执行探针用", frameMode: "stateful",
  defaults: { text: "v1", tint: "${tint}" },
  controls: [{ key: "text", label: "文字", type: "text" }, { key: "tint", label: "颜色", type: "color" }],
  Component: OceVisual,
};
`;
const SOUND_FREQ = 880;
const CARDS = {
  'oce-visual': visualSource('OCE', '#33ccff'),
  'oce-sound': `/** 探针:同步来的用户有声卡(画面组件加 audio()) */
import type { CardDef, CardProps } from "../../kernel/types";
import { createNotificationRecipe } from "../../kernel/soundEffects";
import { cardSoundBlock } from "../native/sound-effects";
${MARK}
interface Params { frequency: number }
function OceSound({ params }: CardProps<Params>) { return <div data-oce-sound="1" className="absolute inset-0 flex items-center justify-center text-[56px]" style={{ color: "#ffcc33" }}>SND {params.frequency}</div>; }
export const oceSound: CardDef<Params> = {
  id: "oce-sound", name: "在线探针有声卡", description: "在线执行探针用", frameMode: "stateful",
  defaults: { frequency: ${SOUND_FREQ} },
  controls: [{ key: "frequency", label: "频率", type: "number", min: 100, max: 4000, step: 10 }],
  Component: OceSound,
  audio: (_sources: unknown, range: { start: number; count: number }, params: Params) =>
    cardSoundBlock(createNotificationRecipe({ frequency: params.frequency, gain: 0.5, duration: 0.3 }), range),
};
`,
  'oce-rel': `/** 探针:带相对导入的用户卡(同目录文件、页面自带的内置模块、样式文件) */
import type { CardDef } from "../../kernel/types";
import { hudControls } from "../native/hud";
import { relLabel } from "./oce-rel-helper";
import "./oce-rel.css";
${MARK}
export const oceRel: CardDef<{}> = {
  id: "oce-rel", name: "在线探针相对导入卡", description: "在线执行探针用", frameMode: "stateful",
  defaults: {}, controls: [],
  Component: () => <div data-oce-rel="1" data-hud={hudControls.length} className="oce-rel-box">{relLabel("rel")}</div>,
};
`,
  'oce-rel-helper': `export function relLabel(s: string): string { return "REL-" + s; }\n`,
  'oce-slow': `/** 探针:故意很慢的用户卡:每次渲染忙等 40 毫秒(真墙钟),测量后判重 */
import type { CardDef } from "../../kernel/types";
${MARK}
function OceSlow() {
  const now = () => ((globalThis as any).__pcRealNow ? (globalThis as any).__pcRealNow() : performance.now());
  const end = now() + 40;
  while (now() < end) { /* 烧时间 */ }
  return <div data-oce-slow="1" className="absolute inset-0 flex items-center justify-center text-[56px]" style={{ color: "#ff6699" }}>SLOW</div>;
}
export const oceSlow: CardDef<{}> = { id: "oce-slow", name: "在线探针慢卡", description: "在线执行探针用", frameMode: "stateful", defaults: {}, controls: [], Component: OceSlow };
`,
  'oce-ns': `/** 探针:用了 namespace(转译器会悄悄转错的写法,预检拦下,状态 unsupported-syntax) */
import type { CardDef } from "../../kernel/types";
${MARK}
export namespace OceNs { export const marker = 1; }
export const oceNs: CardDef<{}> = { id: "oce-ns", name: "在线探针 namespace 卡", description: "在线执行探针用", frameMode: "stateful", defaults: {}, controls: [],
  Component: () => <div data-oce-ns="1">NS {OceNs.marker}</div> };
`,
  'oce-lodash': `/** 探针:引了在线页面里没有的包(状态 missing-module) */
import type { CardDef } from "../../kernel/types";
import _ from "lodash";
${MARK}
export const oceLodash: CardDef<{}> = { id: "oce-lodash", name: "在线探针 lodash 卡", description: "在线执行探针用", frameMode: "stateful", defaults: {}, controls: [],
  Component: () => <div data-oce-lodash="1">{_.upperFirst("lodash")}</div> };
`,
  'oce-invert': `/** 探针:带视频输入源的图卡(反色滤镜) */
import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";
interface Params { amount: number }
export const oceInvert: CardDef<Params> = {
  id: "oce-invert", name: "在线探针反色图卡", description: "在线执行探针用", source: "user", tags: ["探针"], kind: "filter", frameMode: "direct",
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
`,
  'oce-tone': `/** 探针:纯合成的音频图卡(不读素材) */
import type { CardDef } from "../../kernel/types";
import { createNotificationRecipe } from "../../kernel/soundEffects";
import { cardSoundBlock } from "../native/sound-effects";
interface Params { frequency: number }
export const oceTone: CardDef<Params> = {
  id: "oce-tone", name: "在线探针纯合成音频卡", description: "在线执行探针用", source: "user", tags: ["探针"], kind: "audio", frameMode: "direct", inputs: {},
  defaults: { frequency: 660 },
  controls: [{ key: "frequency", label: "频率", type: "number", min: 100, max: 4000, step: 10 }],
  audio: (_sources: unknown, range: { start: number; count: number }, params: Params) =>
    cardSoundBlock(createNotificationRecipe({ frequency: params.frequency, gain: 0.5, duration: 0.3 }), range),
};
`,
  'oce-sample': `/** 探针:读素材采样的音频图卡(在线不合成,用已入库的声音) */
import type { CardDef } from "../../kernel/types";
interface Params { gain: number }
export const oceSample: CardDef<Params> = {
  id: "oce-sample", name: "在线探针读采样音频卡", description: "在线执行探针用", source: "user", tags: ["探针"], kind: "audio", frameMode: "direct",
  inputs: { source: { description: "要处理的声音" } },
  defaults: { gain: 1 },
  controls: [{ key: "gain", label: "增益", type: "number", min: 0, max: 4, step: 0.05 }],
  audio: async (sources: any, range: { start: number; count: number }, params: Params) => {
    const block = await sources.source.block(range.start, range.count);
    const out = new Float32Array(block.length);
    for (let i = 0; i < block.length; i++) out[i] = block[i] * params.gain;
    return out;
  },
};
`,
};
const CARD_KEYS = {
  'oce-visual': `${U}oce-visual.tsx`, 'oce-sound': `${U}oce-sound.tsx`, 'oce-rel': `${U}oce-rel.tsx`, 'oce-rel-helper': `${U}oce-rel-helper.ts`,
  'oce-slow': `${U}oce-slow.tsx`, 'oce-ns': `${U}oce-ns.tsx`, 'oce-lodash': `${U}oce-lodash.tsx`, 'oce-invert': `${U}oce-invert.tsx`,
  'oce-tone': `${U}oce-tone.tsx`, 'oce-sample': `${U}oce-sample.tsx`,
};
const REL_CSS = `.oce-rel-box { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 56px; color: #fff; background: rgb(10, 200, 100); }\n`;
const CARD_IDS = ['oce-visual', 'oce-sound', 'oce-rel', 'oce-slow', 'oce-ns', 'oce-lodash', 'oce-invert', 'oce-tone', 'oce-sample'];

/* ------------------------------------------------------------------ 素材:纯色视频、短 WAV、预渲染快照字节 */
const COLOR = [200, 40, 40];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'online-card-exec-'));
const ffmpeg = await findFfmpeg();
if (!ffmpeg) { console.log(JSON.stringify({ ok: false, pass: 0, fail: 1, fails: ['找不到 ffmpeg,造不出视频素材'] })); process.exit(1); }
const videoFile = path.join(tmp, 'solid.mp4');
{
  const hex = COLOR.map((c) => c.toString(16).padStart(2, '0')).join('');
  const r = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=320x180:r=30:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoFile], { windowsHide: true, timeout: 60_000 });
  if (r.status !== 0) { console.log(JSON.stringify({ ok: false, pass: 0, fail: 1, fails: ['ffmpeg 造视频失败'] })); process.exit(1); }
}
/** 1 秒、48 kHz、16 位单声道正弦(440 Hz)的 WAV */
function sineWav(seconds = 1, hz = 440, rate = 48000) {
  const n = Math.round(seconds * rate), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / rate) * 0.5 * 32767), 44 + i * 2);
  return buf;
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2b1d6d40000000049454e44ae426082', 'hex');
const fakeAssets = new Map();
const assetLog = [];

/* ------------------------------------------------------------------ 托管组合、代理、项目 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-card-exec-hosted-'));
const combo = await startHostedCombo({
  dataDir, docPort: DOC_PORT, assetPort: ASSET_PORT, host: '127.0.0.1', trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'),
  docPublicUrl: `ws://pc.localhost:${BASE}/hosted/`, assetPublicUrl: `${ORIGINS.editor}/media/api/asset`, log: () => {},
});
const proxy = await startHostedProxy({
  dist: DIST, basePort: BASE, docPort: DOC_PORT, assetPort: ASSET_PORT, policy: 'full',
  intercept: ({ role, req, url }) => {
    const m = /^\/media\/api\/asset\/(snap|px)\/([0-9a-f]{64})$/.exec(url.pathname);
    if (!m) return undefined;
    assetLog.push({ at: Date.now(), ns: m[1], hash: m[2], role });
    const hit = fakeAssets.get(`${m[1]}/${m[2]}`);
    if (hit && req.method === 'GET') return { status: 200, body: hit.bytes, headers: { 'content-type': hit.type, 'content-length': hit.bytes.length, 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' } };
    return undefined;
  },
});
const NAME = `oce-${Date.now().toString(36)}`;
const creator = { username: 'boss', password: `boss-${randomBytes(9).toString('hex')}` };
const PROJECT_PW = `pw-${randomBytes(9).toString('hex')}`;
const made = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });
const seeded = await seedSharedProject({ base: DOC_DIRECT, projectId: made.projectId, creator, name: NAME });
check('准备:托管组合、隔离代理、共享项目写进空项目(创建者一侧没有桌面编辑器)', seeded.ok === true, seeded);

const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId: made.projectId, username: creator.username, deviceId: 'oce-probe-node-01', deviceName: 'probe-node', as: 'creator', password: creator.password, role: 'page' });
const ws = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
const ask = (msg) => new Promise((resolve) => {
  const reqId = `p${Math.random().toString(36).slice(2)}`;
  const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ ...msg, reqId }));
});
await ask({ type: 'project.open', projectId: made.projectId });
const putSource = (key, body) => ask({ type: 'content.put', kind: 'card-source', key, body });
let putOk = true;
for (const [id, body] of Object.entries(CARDS)) { const r = await putSource(CARD_KEYS[id], body); if (r.type !== 'content.stored') { putOk = false; console.log('put 失败', id, short(r)); } }
{ const r = await putSource(`${U}oce-rel.css`, REL_CSS); if (r.type !== 'content.stored') putOk = false; }
check('准备:创建者把九张卡与它们的 helper、样式文件写进内容库', putOk);
const tk = await ask({ type: 'auth.ticket', kind: 'asset', access: 'rw' });
const assets = createAssetClient({ base: `http://127.0.0.1:${ASSET_PORT}/api/asset`, ticket: () => tk.ticket });
const VIDEO_HASH = (await assets.put('media', fs.readFileSync(videoFile), { ext: 'mp4' })).hash;
const WAV_HASH = (await assets.put('media', sineWav(), { ext: 'wav' })).hash;
check('准备:一段纯色视频与一段 WAV 传进素材服务', /^[0-9a-f]{64}$/.test(VIDEO_HASH) && /^[0-9a-f]{64}$/.test(WAV_HASH));

/** 预渲染结果(替渲染节点写) */
function makeLayer(clipId, color, fps, count, firstFrame = 0) {
  const html = Buffer.from(`<div data-probe-snap="${clipId}" style="position:absolute;inset:0;background:${color};color:#fff;font:bold 160px sans-serif;display:flex;align-items:center;justify-content:center">SNAP ${clipId}</div>`, 'utf8');
  const png = Buffer.concat([PNG_1PX, Buffer.from(clipId)]);
  const L = { clipId, rk: randomBytes(32).toString('hex'), ck: randomBytes(32).toString('hex'), full: sha(html), small: sha(png), count, fps, firstFrame };
  fakeAssets.set(`snap/${L.full}`, { type: 'text/html', bytes: html });
  fakeAssets.set(`px/${L.small}`, { type: 'image/png', bytes: png });
  return L;
}
async function writeManifests(L, conn = { ask }) {
  const half = L.count / 2;
  for (const [from, to] of [[0, half - 1], [half, L.count - 1]]) {
    const frames = [], small = [];
    for (let f = from; f <= to; f++) { frames.push([f, L.full, 300]); small.push([f, L.small, 80]); }
    const r = await conn.ask({ type: 'content.put', kind: 'snapshot-manifest', key: `${L.rk}:${from}-${to}`, body: { v: 1, kind: 'snapshot', tier: 'shared', resultKey: L.rk, dirKey: L.rk, entryKey: null, range: { from, to }, canvasHeavy: false, frames, small } });
    check(`写段清单 ${L.clipId}`, r.type === 'content.stored', r);
  }
}
async function writeLayerMap(projectId, fps, layers, conn = { ask }) {
  const map = { v: 2, kind: 'layer-map', projectId, fps, width: 1920, height: 1080, span: layers[0].count / 2, at: Date.now(),
    layers: layers.map((L) => ({ clipId: L.clipId, kind: 'html', key: L.rk, tier: 'shared', resultKey: L.rk, dirKey: L.rk, entryKey: null, firstFrame: L.firstFrame, count: L.count, contentKey: L.ck, envFingerprint: 'oce0probe0fp0000' })) };
  const r = await conn.ask({ type: 'content.put', kind: 'snapshot-manifest', key: `layers:${projectId}`, body: map });
  check('写层表', r.type === 'content.stored', r);
}

/* ------------------------------------------------------------------ 浏览器 */
const AUDIO_HOOK = () => {
  if (window.__pcAudioLog) return;
  const logged = (window.__pcAudioLog = []);
  const note = (kind, extra) => logged.push({ kind, at: Math.round(performance.now()), ...extra });
  for (const name of ['AudioContext', 'OfflineAudioContext']) {
    const Original = window[name];
    if (!Original) continue;
    window[name] = new Proxy(Original, { construct(target, args, newTarget) { note(name); return Reflect.construct(target, args, newTarget); } });
  }
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) { note('play', { src: String(this.currentSrc || this.src).slice(0, 24) }); return play.apply(this, a); };
  const create = URL.createObjectURL;
  URL.createObjectURL = function (...a) { note('createObjectURL', { type: a[0]?.type ?? null }); return create.apply(this, a); };
  if (window.AudioScheduledSourceNode) {
    const start = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function (...a) { note('sourceStart'); return start.apply(this, a); };
  }
};
const browsers = [];
async function launch(extra = []) {
  const b = await puppeteer.launch({ pipe: true, headless: true, protocolTimeout: 600_000,
    args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-position=-32000,-32000', '--site-per-process', '--force-device-scale-factor=1', ...extra] });
  browsers.push(b);
  return b;
}
async function openMember(browser, tag, { mobile = false, name = NAME, cardIds = CARD_IDS } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  if (mobile) {
    await page.emulate({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      viewport: { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false } });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 4 }); });
  } else await page.setViewport({ width: 1600, height: 900 });
  await page.evaluateOnNewDocument(AUDIO_HOOK);
  const pageErrors = [], refused = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  page.on('console', (msg) => { const t = msg.text(); if (/Refused to|violates the following Content Security Policy/i.test(t)) refused.push(t.slice(0, 200)); });
  const typeInto = async (sel, value) => { await page.waitForSelector(sel, { visible: true, timeout: 30_000 }); await page.click(sel, { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type(sel, value, { delay: 5 }); };
  await page.goto(`${ORIGINS.editor}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  await typeInto('[data-pc="join-name"]', name);
  await typeInto('[data-pc="join-username"]', `m-${tag.toLowerCase()}`);
  await typeInto('[data-pc="join-password"]', PROJECT_PW);
  await page.click('[data-pc="join-submit"]');
  await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
  await until(`${tag} 时间轴`, () => page.evaluate(() => !!window.__pcStore), 30_000);
  await until(`${tag} 页面认出同步来的卡`, () => page.evaluate((ids) => { const c = window.__pcCardSources?.()?.cards ?? []; return ids.every((id) => c.some((x) => x.id === id)); }, cardIds), 60_000, 500);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && !f.detached);
  const run = () => page.evaluate((ids) => { const d = window.__pcCardExecDiag?.(); return d ? { available: d.available, visual: d.visual, run: Object.fromEntries(ids.map((id) => [id, d.run?.[id] ?? null])), graph: Object.fromEntries(Object.entries(d.stages).map(([k, v]) => [k, v.graph])) } : null; }, CARD_IDS).catch(() => null);
  /** 可见舞台(两台里此刻可见的那个;低内存档只有一个) */
  const visibleStage = async () => {
    const frames = stageFrames();
    for (const f of frames) {
      const el = await f.frameElement().catch(() => null);
      const vis = el ? await el.evaluate((e) => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5 && e.getBoundingClientRect().width > 10; }).catch(() => false) : false;
      if (vis) return f;
    }
    return frames[0] ?? null;
  };
  /** 可见舞台里每个片段的状况:包裹层、活节点(选择器 → 文字)、快照平面、占位槽位 */
  const stageState = async (clipIds, probes = {}) => {
    const f = await visibleStage();
    if (!f) return null;
    return f.evaluate((ids, pr) => {
      const out = {};
      for (const id of ids) {
        const w = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
        if (!w) { out[id] = { wrapper: false }; continue; }
        const snap = w.querySelector(':scope > [data-pc-snapshot-plane]');
        const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
        const plane = slot?.querySelector('[data-pc-placeholder-plane]');
        const live = pr[id] ? w.querySelector(pr[id]) : null;
        out[id] = { wrapper: true, live: !!live, text: live ? (live.textContent ?? '').trim().slice(0, 60) : null,
          snapshot: !!snap && snap.childElementCount > 0, snapText: snap?.textContent?.trim().slice(0, 40) ?? null,
          placeholderShown: !!slot && !slot.hidden, reason: slot?.getAttribute('data-pc-placeholder-reason') ?? plane?.getAttribute('data-pc-placeholder-reason') ?? null,
          shownText: slot && !slot.hidden ? (plane?.textContent ?? '').trim().slice(0, 40) : null, canvas: w.querySelectorAll('canvas').length, graphNode: !!w.querySelector('[data-pc-graph-node]') };
      }
      return out;
    }, clipIds, probes);
  };
  const timeline = (clipIds) => page.evaluate((ids) => Object.fromEntries(ids.map((id) => { const el = document.querySelector(`[data-clip-id="${id}"]`); const b = el?.querySelector('[data-pc="clip-custom-card"]'); return [id, el ? { badge: !!b, title: b?.getAttribute('title') ?? null } : null]; })), clipIds);
  /** 选中片段、打开参数面板,读那一句运行状态说明 */
  const panelNote = async (clipId) => {
    await page.evaluate((id) => { window.__pcStore.actions.select([id]); }, clipId);
    await page.evaluate(() => { document.querySelector('[data-pc-rail="edit"]')?.click(); });
    await sleep(300);
    await page.evaluate(() => { document.querySelector('[data-pc="inspector"] [data-pc-tab="form"]')?.click(); });
    await sleep(400);
    return page.evaluate(() => document.querySelector('[data-pc="params-run-state"]')?.textContent ?? null);
  };
  const centerPixel = async (name) => {
    const box = await page.evaluate(() => { const els = [...document.querySelectorAll('iframe[data-pc^="stage-frame"]')]; const el = els.find((e) => Number(getComputedStyle(e).opacity) > 0.5) ?? els[0]; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    const png = PNG.sync.read(fs.readFileSync(file));
    const i = (Math.round(box.y) * png.width + Math.round(box.x)) * 4;
    return { rgb: [png.data[i], png.data[i + 1], png.data[i + 2]], file };
  };
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
  /** 可见舞台那一块放大截一张 */
  const stageShot = async (name) => {
    const f = await visibleStage();
    const el = f ? await f.frameElement().catch(() => null) : null;
    const box = el ? await el.boundingBox().catch(() => null) : null;
    if (!box || box.width < 10) return null;
    await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { ...box, scale: Math.min(3, 1600 / box.width) } }).catch(() => {});
    return `${name}.png`;
  };
  return { tag, page, pageErrors, refused, stageFrames, run, visibleStage, stageState, timeline, panelNote, centerPixel, shot, stageShot, close: () => ctx.close().catch(() => {}) };
}
const near = (a, b, tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** 在页面里听一段(同 `sound-ab-probe.mjs` 的 listen):把播放头放到 `at`、播 `ms` 毫秒,看此刻出声的 `<audio>`;分析节点不接输出,探针自己不出声 */
async function listen(page, { at, ms = 700, clipId = null }) {
  return page.evaluate(async ({ at, ms, clipId }) => {
    const { actions, getState } = window.__pcStore;
    const wait = (n) => new Promise((r) => setTimeout(r, n));
    actions.pause(); actions.setVolume?.(1); actions.seek(at);
    let el = null;
    for (let i = 0; i < 80 && !el; i++) {
      await wait(100);
      el = [...document.querySelectorAll('audio')].find((a) => (a.currentSrc || a.getAttribute('src')) && a.readyState >= 2) ?? null;
      if (!el && [...document.querySelectorAll('audio')].some((a) => a.dataset.cardAudioState === 'error')) break;
    }
    const audios = [...document.querySelectorAll('audio')].map((a) => ({ state: a.dataset.cardAudioState ?? null, src: (a.currentSrc || a.getAttribute('src') || '').slice(0, 40), ready: a.readyState }));
    const status = [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent || '').filter((t) => /音频|声音|卡片/.test(t));
    if (!el) return { playing: false, audios, status };
    const src = el.currentSrc;
    let decoded = null;
    try {
      const bytes = await (await fetch(src)).arrayBuffer();
      const buffer = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes);
      const data = buffer.getChannelData(0), from = Math.max(0, Math.floor(el.currentTime * buffer.sampleRate)), to = Math.min(data.length, from + Math.round((ms / 1000) * buffer.sampleRate));
      let sq = 0, peak = 0;
      for (let i = from; i < to; i++) { sq += data[i] * data[i]; peak = Math.max(peak, Math.abs(data[i])); }
      decoded = { seconds: +buffer.duration.toFixed(4), rms: to > from ? Math.sqrt(sq / (to - from)) : 0, peak, bytes: bytes.byteLength };
    } catch (e) { decoded = { error: String(e?.message ?? e) }; }
    let live = { peak: 0, rms: 0, samples: 0 };
    let analyser = null, context = null, source = null;
    try {
      context = window.__pcProbeContext ??= new AudioContext({ sampleRate: 48000 });
      if (context.state !== 'running') await context.resume();
      source = context.createMediaStreamSource(el.captureStream());
      analyser = context.createAnalyser(); analyser.fftSize = 2048;
      source.connect(analyser);
    } catch (e) { live.error = String(e?.message ?? e); }
    const t0 = el.currentTime, block = new Float32Array(2048);
    actions.play();
    const started = performance.now();
    let sq = 0, n = 0, reached = t0;
    while (performance.now() - started < ms) {
      await wait(20);
      if (el.isConnected) reached = Math.max(reached, el.currentTime);
      if (analyser) { analyser.getFloatTimeDomainData(block); for (const v of block) { live.peak = Math.max(live.peak, Math.abs(v)); sq += v * v; n++; } live.samples++; }
    }
    const volume = el.volume, muted = el.muted;
    const owner = getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    const left = owner ? Math.max(0, owner.end - at) : ms / 1000;
    actions.pause();
    live.rms = n ? Math.sqrt(sq / n) : 0;
    try { source?.disconnect(); } catch { /* 已断 */ }
    await wait(120);
    return { playing: reached - t0 > Math.max(0.08, Math.min(ms / 1000, left) * 0.4), advanced: +(reached - t0).toFixed(3), volume, muted, source: src.startsWith('blob:') ? 'blob' : 'url', decoded, live, audios, status };
  }, { at, ms, clipId });
}
const audible = (r) => !!r && r.playing && r.volume > 0 && !r.muted && (r.decoded?.rms ?? 0) > 0.003 && (r.live?.peak ?? 0) > 0.003;
const brief = (r) => r && ({ playing: r.playing, advanced: r.advanced, source: r.source, decodedRms: r.decoded?.rms && +r.decoded.rms.toFixed(5), livePeak: r.live?.peak && +r.live.peak.toFixed(5), liveErr: r.live?.error, audios: r.audios, status: r.status });

/* ------------------------------------------------------------------ 项目摆法 */
const TILES = [[0, 0], [640, 0], [1280, 0], [0, 360], [640, 360], [1280, 360]];
const V = { v: 'oce-clip-v', snd: 'oce-clip-snd', rel: 'oce-clip-rel', slow: 'oce-clip-slow', ns: 'oce-clip-ns', lod: 'oce-clip-lod' };
const CARD_OF = { v: 'oce-visual', snd: 'oce-sound', rel: 'oce-rel', slow: 'oce-slow', ns: 'oce-ns', lod: 'oce-lodash' };
const GCLIP = 'oce-clip-g', TONE = 'oce-clip-tone', SAMPLE = 'oce-clip-sample';
async function layOut(page) {
  return page.evaluate((v, cardOf, tiles, hashes) => {
    const S = window.__pcStore;
    const m = S.actions.addMedia({ kind: 'video', name: 'solid.mp4', url: '/@media/' + hashes.video, hash: hashes.video, ext: 'mp4', size: 1000, width: 320, height: 180, duration: 2 });
    const a = S.actions.addMedia({ kind: 'audio', name: 'sine.wav', url: '/@media/' + hashes.wav, hash: hashes.wav, ext: 'wav', size: 96044, duration: 1 });
    S.actions.editCardProject((p) => ({
      ...p, duration: Math.max(p.duration, 15),
      cardNodes: [...(p.cardNodes ?? []),
        { id: 'oce-n-g', adapter: 'card', cardId: 'oce-invert', kind: 'filter', inputs: { source: '@clip/' + 'oce-clip-g' + '/source' }, params: { amount: 1 } },
        { id: 'oce-n-tone', adapter: 'card', cardId: 'oce-tone', kind: 'audio', inputs: {}, params: { frequency: 660 } },
        { id: 'oce-n-sample', adapter: 'card', cardId: 'oce-sample', kind: 'audio', inputs: { source: '@clip/oce-clip-sample-src/source' }, params: { gain: 1 } }],
      tracks: [
        ...Object.keys(v).map((k, i) => ({ id: 'oce-t-' + k, name: '序列 ' + k, clips: [{ id: v[k], cardId: cardOf[k], start: k === 'slow' ? 10 : 0, end: k === 'slow' ? 14 : 4, params: {}, frame: { x: tiles[i][0], y: tiles[i][1], w: 640, h: 360 } }] })),
        { id: 'oce-t-g', name: '图卡', clips: [{ id: 'oce-clip-g', mediaId: m.id, cardId: 'oce-invert', nodeId: 'oce-n-g', start: 4, end: 6, params: { amount: 1 } }] },
        { id: 'oce-t-tone', name: '纯合成音频卡', clips: [{ id: 'oce-clip-tone', nodeId: 'oce-n-tone', start: 6, end: 8, params: {} }] },
        { id: 'oce-t-sample-src', name: '素材声音', clips: [{ id: 'oce-clip-sample-src', mediaId: a.id, start: 8, end: 9, params: {} }] },
        { id: 'oce-t-sample', name: '读采样音频卡', clips: [{ id: 'oce-clip-sample', nodeId: 'oce-n-sample', start: 8, end: 9, params: {} }] },
        ...p.tracks,
      ],
    }));
    S.actions.seek(1);
    const p = S.getState().project;
    return { projectId: p.id, fps: p.fps || 30 };
  }, V, CARD_OF, TILES, { video: VIDEO_HASH, wav: WAV_HASH });
}

const summary = { out: OUT, panel: {} };
const PROBES = { [V.v]: '[data-oce-visual]', [V.snd]: '[data-oce-sound]', [V.rel]: '[data-oce-rel]', [V.slow]: '[data-oce-slow]', [V.ns]: '[data-oce-ns]', [V.lod]: '[data-oce-lodash]' };
const ALL_V = Object.values(V);
const markersIn = async (m) => {
  const top = await m.page.evaluate(() => globalThis.__pcOceMark ?? null).catch(() => 'err');
  const stages = await Promise.all(m.stageFrames().map((f) => f.evaluate(() => globalThis.__pcOceMark ?? null).catch(() => 'err')));
  return { top, stages };
};

try {
  const ONLY_E10 = process.env.OCE_ONLY === 'E10'; // 排障用:只跑 E10
  if (!ONLY_E10) {
  /* ============================================================ 真显卡的普通档页面 */
  const b1 = await launch();
  summary.chrome = await b1.version();
  console.log('\n== E1 前提');
  const A = await openMember(b1, 'A');
  const fp = await layOut(A.page);
  check('摆项目:六个画面片段、一个图卡、纯合成与读采样两个音频图卡', !!fp?.projectId, fp);
  const FPS = fp.fps;
  const d0 = await until('A 本页隔离生效、各张卡载入', async () => {
    const d = await A.run();
    return d && d.run['oce-visual']?.state === 'ready' && d.run['oce-sound']?.state === 'ready' && d.run['oce-rel']?.state === 'ready' && d.run['oce-slow']?.state === 'ready'
      && d.run['oce-invert']?.state === 'ready' && d.run['oce-tone']?.state === 'ready' ? d : null;
  }, 120_000, 500);
  const diag0 = await A.page.evaluate(() => window.__pcPreviewDiag?.() ?? null);
  summary.E1 = { run: d0?.run, graph: d0?.graph, cardExec: diag0?.cardExec };
  check('E1 本页隔离生效(双舞台、可执行、出口由浏览器拦)', diag0?.dual === true && diag0?.cardExec?.enabled === true && diag0.cardExec.egress === 'none', diag0?.cardExec);
  check('E1 用户画面卡、有声卡、相对导入卡、慢卡、图卡、纯合成音频卡在两台舞台里载入成功(运行状态 ready)', !!d0, d0?.run);
  check('E1 读采样的音频图卡也载入成功(它的声音在线合成不了是另一回事,见 E3)', (await A.run())?.run['oce-sample']?.state === 'ready', (await A.run())?.run['oce-sample']);
  check('E1 没有任何预渲染产物:层表空、没有 snap/ 与 px/ 请求', assetLog.length === 0 && ((await A.page.evaluate(() => window.__pcOnlineSnapshots?.()?.mapVersion ?? null)) === null), { requests: assetLog.length });

  console.log('\n== E2 判轻的直接画出来');
  const t2 = Date.now();
  const live = await until('A 三张卡的片段在可见舞台里是活 DOM', async () => {
    await A.page.evaluate(() => window.__pcStore.actions.seek(1));
    const s = await A.stageState([V.v, V.snd, V.rel], PROBES);
    return s && s[V.v]?.live && s[V.snd]?.live && s[V.rel]?.live ? s : null;
  }, 90_000, 500);
  summary.E2 = { ms: Date.now() - t2, stage: live };
  const stNow = await A.stageState([V.v, V.snd, V.rel], PROBES);
  check('E2 用户画面卡、有声卡、相对导入卡在可见舞台里是活 DOM(没有快照、没有图标)', !!live && [V.v, V.snd, V.rel].every((id) => stNow?.[id]?.live && !stNow[id].snapshot && !stNow[id].placeholderShown), { ms: Date.now() - t2, stNow });
  check('E2 活 DOM 里是各自的文字(画面卡 OCE v1、有声卡 SND 880、相对导入卡 REL-rel)', stNow?.[V.v]?.text === 'OCE v1' && stNow?.[V.snd]?.text === `SND ${SOUND_FREQ}` && stNow?.[V.rel]?.text === 'REL-rel', { v: stNow?.[V.v]?.text, snd: stNow?.[V.snd]?.text, rel: stNow?.[V.rel]?.text });
  const relProps = await (await A.visibleStage()).evaluate(() => { const el = document.querySelector('[data-oce-rel]'); return el ? { bg: getComputedStyle(el).backgroundColor, hud: Number(el.getAttribute('data-hud')) } : null; });
  check('E2 相对导入都生效:同目录 helper 的文字、.css 的背景色(算出样式 rgb(10, 200, 100))、页面自带的 ../native/hud 的导出个数 > 0', relProps?.bg === 'rgb(10, 200, 100)' && relProps.hud > 0, relProps);
  const tl = await A.timeline(ALL_V);
  check('E2 时间轴不挂「需要本地 PC 渲染辅助」的徽标(三张判轻的卡)', [V.v, V.snd, V.rel].every((id) => tl[id] && !tl[id].badge), tl);
  summary.E2.screenshot = await A.stageShot('e2-stage');
  await A.shot('e2-editor');
  const mk = await markersIn(A);
  summary.E2.markers = mk;
  check('E2 卡片代码只在隔离舞台里执行:编辑页面(顶层文档)里没有卡片模块顶层的记号,两台舞台里都有', mk.top === null && mk.stages.length === 2 && mk.stages.every((n) => typeof n === 'number' && n > 0), mk);
  check('E2 整个过程没有 snap/ 与 px/ 请求', assetLog.length === 0, { requests: assetLog.length });

  console.log('\n== E3 听得到声音');
  // 纯合成音频图卡:先测量(不出声),再听
  const tone = await A.page.evaluate(async (clipId) => {
    const p = window.__pcStore.getState().project, clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    const sound = await window.__pcIo.sound();
    const key = window.__pcSoundJudge.keyOf(p, clip);
    const hadRecord = !!(await window.__pcSoundJudge.read(key));
    const log0 = window.__pcAudioLog.length;
    const mediaDuring = [];
    const watch = setInterval(() => { mediaDuring.push([...document.querySelectorAll('audio,video')].filter((e) => !e.paused).length); }, 5);
    const decision = await sound.decideClipSound(p, clip);
    clearInterval(watch);
    return { key, hadRecord, synth: decision.synth, reused: decision.verdict?.reused, record: await window.__pcSoundJudge.read(key), during: window.__pcAudioLog.slice(log0), playingDuring: Math.max(0, ...mediaDuring) };
  }, TONE);
  check('E3 纯合成音频图卡:测量确实做了(之前没有记录、测了 16 块)并判轻(在浏览器里合成)', !tone.hadRecord && tone.reused === false && tone.record?.samples === 16 && tone.synth === true,
    { record: tone.record && { kind: tone.record.kind, blockMs: +tone.record.blockMs.toFixed(3), samples: tone.record.samples }, synth: tone.synth });
  check('E3 测量期间扬声器无输出:没有新建音频上下文、没有元素开始播放、没有新建可播放地址、没有声源启动,页面上没有在播的媒体元素', tone.during.length === 0 && tone.playingDuring === 0, { during: tone.during, playingDuring: tone.playingDuring });
  const heardTone = await listen(A.page, { at: 6.0, ms: 500, clipId: TONE });
  check('E3 纯合成音频图卡在预览里听得到:声音源是浏览器合成的(blob),解码有能量,实时采样有峰值', audible(heardTone) && heardTone.source === 'blob', brief(heardTone));
  const heardSnd = await listen(A.page, { at: 0.0, ms: 500, clipId: V.snd });
  check('E3 用户有声卡在预览里听得到:声音源是浏览器合成的(blob),解码有能量,实时采样有峰值', audible(heardSnd) && heardSnd.source === 'blob', brief(heardSnd));
  const gen = await A.page.evaluate(async (clipId) => {
    try { const sound = await window.__pcIo.sound(); const r = await sound.generateCardAudio(clipId, { force: true }); return { ok: r?.ok === true, mediaId: r?.mediaId ?? null }; }
    catch (e) { return { error: String(e?.message ?? e).slice(0, 300) }; }
  }, V.snd);
  let wav = null;
  if (gen.mediaId) {
    const hash = await A.page.evaluate((id) => window.__pcStore.getState().project.media.find((x) => x.id === id)?.hash ?? null, gen.mediaId);
    const r = hash ? await fetch(`http://127.0.0.1:${ASSET_PORT}/api/asset/media/${hash}`, { headers: { authorization: `Bearer ${tk.ticket}` } }) : null;
    if (r?.ok) { const bytes = new Uint8Array(await r.arrayBuffer()); wav = { bytes: bytes.length, riff: String.fromCharCode(...bytes.subarray(0, 4)) }; }
  }
  check('E3 用户有声卡的声音在浏览器里生成并入库(WAV 在素材服务里取得到)', gen.ok === true && wav?.riff === 'RIFF' && wav.bytes > 1000, { gen, wav });
  const sample = await A.page.evaluate(async (clipId) => {
    const p = window.__pcStore.getState().project, clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    const sound = await window.__pcIo.sound();
    const d = await sound.decideClipSound(p, clip);
    return { synth: d.synth, reason: d.reason ?? null, message: d.message ?? null };
  }, SAMPLE);
  summary.panel.sampleAudio = sample.message;
  check('E3 读素材采样的音频图卡不在线合成:判定是「合成不了」并给出原因说明', sample.synth === false && sample.reason === 'not-runnable' && /读素材的声音采样/.test(sample.message ?? ''), sample);

  if (process.env.OCE_STOP_AFTER === 'E3') throw new Error('OCE_STOP_AFTER=E3(排障用:跑到 E3 为止)');
  console.log('\n== E4 改参数即时生效');
  await A.page.evaluate((id) => { window.__pcStore.actions.seek(1); window.__pcStore.actions.setClipParams(id, { text: 'edited' }); }, V.v);
  const edited = await until('A 舞台里的文字变成 OCE edited', async () => { const s = await A.stageState([V.v], PROBES); return s?.[V.v]?.text === 'OCE edited' ? s : null; }, 15_000, 250);
  check('E4 改文字参数,舞台里的 DOM 文字几秒内跟着变', !!edited, edited);
  const Bm = await openMember(b1, 'B');
  const remote = await until('乙的项目里看得到改过的参数', () => Bm.page.evaluate((id) => window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.params?.text === 'edited', V.v), 30_000);
  check('E4 另一成员(乙)的项目里看得到改过的参数', !!remote);
  await Bm.page.evaluate(() => window.__pcStore.actions.seek(1));
  const editedB = await until('乙的舞台里文字也是 OCE edited', async () => { const s = await Bm.stageState([V.v], PROBES); return s?.[V.v]?.text === 'OCE edited' ? s : null; }, 90_000, 500);
  check('E4 乙的舞台里画出来的也是改过的文字(乙自己的浏览器里执行)', !!editedB, editedB);

  console.log('\n== E5 图卡:带视频输入源');
  await A.page.evaluate(() => window.__pcStore.actions.seek(5));
  const want = COLOR.map((c) => 255 - c);
  let px = null;
  await until('A 可见舞台画出图卡的输出(片段中心是视频那一帧的反色)', async () => { px = await A.centerPixel('e5-invert'); return near(px.rgb, want); }, 60_000, 1000);
  check(`E5 截图取预览中心的像素:是视频那一帧 (${COLOR}) 的反色 (${want}),容差 ±24`, !!px && near(px.rgb, want), { got: px?.rgb, file: px?.file });
  const gst = await A.stageState([GCLIP]);
  check('E5 可见舞台挂的是图卡的画布,不显示图标', gst?.[GCLIP]?.graphNode === true && gst[GCLIP].canvas >= 1 && !gst[GCLIP].placeholderShown, gst?.[GCLIP]);
  const sid = diag0?.cardExec?.sid ?? '';
  const mediaReqs = proxy.requests.filter((r) => r.path === `/media-s/${sid}/media/${VIDEO_HASH}`);
  check('E5 视频经舞台源上的 /media-s/<会话号>/media/<哈希> 按 Range 取到(应答 206),请求里不带 ?t=', mediaReqs.some((r) => r.status === 206) && !proxy.requests.some((r) => r.path.includes(VIDEO_HASH) && /[?&]t=/.test(r.path)), { count: mediaReqs.length, statuses: [...new Set(mediaReqs.map((r) => r.status))] });

  console.log('\n== E6 判重的仍走预渲染或渲染节点');
  await A.page.evaluate(() => window.__pcStore.actions.seek(11));
  const heavy = await until('A 慢卡测过并判重(进测量记录、被抑制)', async () => {
    const d = await A.page.evaluate(() => { const x = window.__pcPreviewDiag?.(); return x ? { probed: x.probeRun?.probed ?? [], running: x.probeRun?.running ?? null } : null; });
    return d?.probed.some((e) => e.clipId === V.slow) ? d : null;
  }, 120_000, 500);
  check('E6 慢卡进了测量记录', !!heavy, heavy && { running: heavy.running, slow: heavy.probed.filter((e) => e.clipId === V.slow).length });
  await A.page.evaluate(() => { const S = window.__pcStore; S.actions.seek(10.5); S.actions.play(); });
  const suppressed = await until('A 播放中慢卡被抑制', async () => {
    const d = await A.page.evaluate(() => window.__pcPreviewDiag?.() ?? null);
    return d?.suppressed?.includes(V.slow) ? d.suppressed : null;
  }, 30_000, 300);
  await A.page.evaluate(() => window.__pcStore.actions.pause());
  check('E6 播放中判重的慢卡被抑制(不活渲);判轻的三张卡没被抑制', !!suppressed && [V.v, V.snd, V.rel].every((id) => !suppressed.includes(id)), suppressed);
  // 没声明 direct 的卡在测量完成前按重(进清单计划);测完判轻的撤出去,计划随之重发。等到它稳定下来
  const plan = await until('A 页面发布的清单计划含慢卡、不含判轻的三张卡', async () => {
    const d = await A.page.evaluate(() => window.__pcPlanPublisher?.() ?? null);
    return d?.lastClips?.includes(V.slow) && [V.v, V.snd, V.rel].every((id) => !d.lastClips.includes(id)) ? d : null;
  }, 120_000, 1000) ?? await A.page.evaluate(() => window.__pcPlanPublisher?.() ?? null);
  check('E6 页面发布的清单计划含判重的慢卡,不含判轻的画面卡、有声卡、相对导入卡', !!plan?.lastClips?.includes(V.slow) && [V.v, V.snd, V.rel].every((id) => !plan.lastClips.includes(id)), plan?.lastClips);
  // 替渲染节点写层表与清单:慢卡换成预渲染快照
  const layer = makeLayer(V.slow, '#7e22ce', FPS, 4 * FPS, 10 * FPS);
  await writeManifests(layer);
  await writeLayerMap(fp.projectId, FPS, [layer]);
  await A.page.evaluate(() => window.__pcStore.actions.seek(11));
  const snap = await until('A 慢卡换成预渲染快照', async () => {
    await A.page.evaluate(() => window.__pcStore.actions.seek(11));
    const s = await A.stageState([V.slow], PROBES);
    return s?.[V.slow]?.snapshot && /SNAP/.test(s[V.slow].snapText ?? '') ? s : null;
  }, 60_000, 500);
  check('E6 渲染节点的预渲染结果写进层表后,舞台里慢卡贴出快照,没有图标', !!snap && !snap[V.slow].placeholderShown, snap);
  check('E6 慢卡的快照字节是经 snap/ 取到的(请求 > 0);时间轴上慢卡不挂徽标', assetLog.some((r) => r.ns === 'snap' && r.hash === layer.full) && !(await A.timeline([V.slow]))[V.slow]?.badge, { snapRequests: assetLog.filter((r) => r.ns === 'snap').length });
  summary.E6 = { probed: heavy?.probed?.length ?? null, suppressed, planClips: plan?.lastClips ?? null };
  await A.stageShot('e6-stage');

  console.log('\n== E7 三种退回');
  await A.page.evaluate(() => window.__pcStore.actions.seek(1));
  const bad = await until('A 两张卡的运行状态落定', async () => { const d = await A.run(); return d?.run['oce-ns']?.state && d.run['oce-ns'].state !== 'loading' && d.run['oce-lodash']?.state && d.run['oce-lodash'].state !== 'loading' ? d : null; }, 60_000, 500);
  check('E7 namespace 的卡:运行状态 unsupported-syntax;引 lodash 的卡:运行状态 missing-module', bad?.run['oce-ns']?.state === 'unsupported-syntax' && bad?.run['oce-lodash']?.state === 'missing-module', { ns: bad?.run['oce-ns'], lodash: bad?.run['oce-lodash'] });
  const badStage = await until('A 两张坏卡显示「需要本地 PC 渲染辅助」图标', async () => {
    await A.page.evaluate(() => window.__pcStore.actions.seek(1));
    const s = await A.stageState([V.ns, V.lod], PROBES);
    return s?.[V.ns]?.placeholderShown && s?.[V.lod]?.placeholderShown && s[V.ns].reason === 'unsupported' && s[V.lod].reason === 'unsupported' ? s : null;
  }, 60_000, 500) ?? await A.stageState([V.ns, V.lod], PROBES);
  check('E7 两张坏卡按原做法:舞台里是「电脑 + 离线」图标与「需要本地 PC 渲染辅助」(没有活 DOM)', [V.ns, V.lod].every((id) => badStage?.[id]?.placeholderShown && badStage[id].reason === 'unsupported' && !badStage[id].live && (badStage[id].shownText ?? '').includes(UNSUPPORTED)), badStage);
  const tlBad = await until('A 时间轴上两张坏卡有徽标', async () => { const t = await A.timeline(ALL_V); return t[V.ns]?.badge && t[V.lod]?.badge ? t : null; }, 30_000, 500) ?? await A.timeline(ALL_V);
  check('E7 时间轴:两张坏卡有徽标(悬停文案「需要本地 PC 渲染辅助」),判轻的卡与有层的慢卡没有', tlBad[V.ns]?.badge && tlBad[V.ns].title === UNSUPPORTED && tlBad[V.lod]?.badge && [V.v, V.snd, V.rel, V.slow].every((id) => !tlBad[id]?.badge), tlBad);
  const plan2 = await until('A 清单计划含两张坏卡', async () => { const d = await A.page.evaluate(() => window.__pcPlanPublisher?.() ?? null); return d?.lastClips?.includes(V.ns) && d.lastClips.includes(V.lod) ? d : null; }, 90_000, 1000);
  check('E7 两张坏卡进清单计划(发布补渲,由渲染节点渲)', !!plan2, plan2?.lastClips);
  summary.panel.ns = await A.panelNote(V.ns);
  summary.panel.lodash = await A.panelNote(V.lod);
  check('E7 参数面板说明 namespace 卡为什么没在浏览器里运行(用了在线页面不支持的写法)', /用了在线页面不支持的写法/.test(summary.panel.ns ?? '') && /画面由渲染节点提供/.test(summary.panel.ns), summary.panel.ns);
  check('E7 参数面板说明 lodash 卡为什么没在浏览器里运行(引用了在线页面里没有的模块 lodash)', /引用了在线页面里没有的模块 lodash/.test(summary.panel.lodash ?? ''), summary.panel.lodash);
  await A.stageShot('e7-stage');

  console.log('\n== E8 源码更新后在线页面跟着换');
  const idBefore = await A.page.evaluate((id) => { const d = window.__pcPreviewDiag?.(); return d?.probeRun?.probed?.filter((e) => e.clipId === id).map((e) => e.identityKey) ?? []; }, V.v);
  const nodeIdentity = () => A.page.evaluate(() => window.__pcBrowserNode?.()?.cards?.sources?.['oce-visual'] ?? null);
  const nodeBefore = await nodeIdentity();
  await A.page.evaluate(() => window.__pcStore.actions.seek(1));
  const tPut = Date.now();
  const put2 = await putSource(CARD_KEYS['oce-visual'], visualSource('OCE2', '#33ccff'));
  check('E8 创建者写进新一版源码', put2.type === 'content.stored', put2);
  const swapped = await until('A 舞台里的画面是新版的(OCE2 打头)', async () => { const s = await A.stageState([V.v], PROBES); return /^OCE2 /.test(s?.[V.v]?.text ?? '') ? s : null; }, 120_000, 250); // 等待时限只为防卡死(原 20 秒)
  const swapMs = Date.now() - tPut;
  timingLog.record('E8 写进新源码到舞台里的画面换成新版', swapped ? swapMs : null, { formerLimit: '≤ 10 秒' });
  check('E8 源码更新后舞台里的画面换成新版(用时只记录)', !!swapped, { swapMs, text: swapped?.[V.v]?.text });
  const idAfter = await until('A 成本身份换了(新版又测了一次、身份不同)', async () => {
    const ids = await A.page.evaluate((id) => window.__pcPreviewDiag?.()?.probeRun?.probed?.filter((e) => e.clipId === id).map((e) => e.identityKey) ?? [], V.v);
    return ids.length > idBefore.length && new Set(ids).size > new Set(idBefore).size ? ids : null;
  }, 60_000, 500);
  check('E8 成本身份(测量记录里的 identityKey)换了', !!idAfter, { before: idBefore, after: idAfter });
  // 换代后有一小段时间节点不报这张卡(NODE_CARD_SETTLE_MS),所以轮询到它重新出现、值变了
  const nodeAfter = await until('A 浏览器节点报的代码身份换了', async () => { const id = await nodeIdentity(); return id && id !== nodeBefore ? id : null; }, 20_000, 500);
  check('E8 浏览器节点报的代码身份换了(换代后短暂不报,之后报出新的)', !!nodeBefore && !!nodeAfter && nodeBefore !== nodeAfter, { before: nodeBefore, after: nodeAfter });
  check('E8 换版后画面卡仍是判轻的活 DOM(没有图标)', (await A.stageState([V.v], PROBES))?.[V.v]?.live === true);
  summary.E8 = { swapMs };

  summary.errorsA = A.pageErrors.slice(0, 5);
  check('A 与乙两页没有页面错误、没有内容安全策略拦截的报错(卡片都在允许的范围里)', A.pageErrors.length === 0 && Bm.pageErrors.length === 0 && A.refused.length === 0 && Bm.refused.length === 0, { A: A.pageErrors.slice(0, 3), B: Bm.pageErrors.slice(0, 3), refusedA: A.refused.slice(0, 2), refusedB: Bm.refused.slice(0, 2) });
  await Bm.close();
  await A.close();
  await b1.close().catch(() => {});

  }

  /* ============================================================ E10 导出页不执行卡片代码、贴同步卡的预渲染原尺寸 */
  console.log('\n== E10 导出页');
  {
    const NAME2 = `${NAME}-x`;
    const made2 = await createSharedProject({ base: DOC_DIRECT, name: NAME2, mode: 'free', creator, password: PROJECT_PW });
    const seeded2 = await seedSharedProject({ base: DOC_DIRECT, projectId: made2.projectId, creator, name: NAME2, deviceId: 'oce-probe-seed-02' });
    const protocols2 = await buildAuthProtocols({ base: DOC_DIRECT, projectId: made2.projectId, username: creator.username, deviceId: 'oce-probe-node-02', deviceName: 'probe-node2', as: 'creator', password: creator.password, role: 'page' });
    const ws2 = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols2);
    await new Promise((resolve, reject) => { ws2.addEventListener('open', resolve); ws2.addEventListener('error', reject); });
    const conn2 = { ask: (msg) => new Promise((resolve) => {
      const reqId = `q${Math.random().toString(36).slice(2)}`;
      const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws2.removeEventListener('message', on); resolve(m); } };
      ws2.addEventListener('message', on); ws2.send(JSON.stringify({ ...msg, reqId }));
    }) };
    await conn2.ask({ type: 'project.open', projectId: made2.projectId });
    const put2 = await conn2.ask({ type: 'content.put', kind: 'card-source', key: CARD_KEYS['oce-visual'], body: visualSource('OCE', '#33ccff') });
    check('E10 准备:第二个项目(只有一张同步的画面卡)写进内容库', seeded2.ok === true && put2.type === 'content.stored', { seeded: seeded2.ok, put: put2.type });
    const b4 = await launch();
    const X = await openMember(b4, 'X', { name: NAME2, cardIds: ['oce-visual'] });
    const EXP_FPS = 30, EXP_COLOR = [10, 140, 60];
    const setup2 = await X.page.evaluate(() => {
      const S = window.__pcStore;
      S.actions.editCardProject((p) => ({ ...p, duration: 1,
        tracks: [{ id: 'oce-exp-t', name: '导出', clips: [{ id: 'oce-exp-v', cardId: 'oce-visual', start: 0, end: 1, params: {}, frame: { x: 0, y: 0, w: 1920, h: 1080 } }] }] }));
      S.actions.seek(0.2);
      const p = S.getState().project;
      return { projectId: p.id, fps: p.fps || 30 };
    });
    await until('X 同步卡载入成功', async () => (await X.run())?.run['oce-visual']?.state === 'ready', 120_000, 500);
    const live2 = await until('X 导出前预览里是活 DOM', async () => (await X.stageState(['oce-exp-v'], { 'oce-exp-v': '[data-oce-visual]' }))?.['oce-exp-v']?.live, 60_000, 500);
    check('E10 导出前:预览里这张判轻的同步卡是活 DOM', !!live2);
    // 预渲染原尺寸:纯色快照(左上角没有文字,取像素用)
    const layer2 = makeLayer('oce-exp-v', '#0a8c3c', EXP_FPS, 30, 0);
    await writeManifests(layer2, conn2);
    await writeLayerMap(setup2.projectId, EXP_FPS, [layer2], conn2);
    await until('X 层表到了', async () => (await X.page.evaluate(() => window.__pcOnlineSnapshots?.()?.layers?.some((l) => l.clipId === 'oce-exp-v' && l.ready > 0))), 60_000, 500);
    // 导出:一边导出一边在导出页(同源 iframe)里看
    const seen = { frames: 0, marks: new Set(), live: false, snap: false, urls: new Set() };
    let done = false;
    const exportPromise = X.page.evaluate(() => window.__pcIo.exportVideoBrowser({ maxFrames: 15, originals: true })).then((r) => { done = true; return r; }, (e) => { done = true; return { error: String(e?.message ?? e) }; });
    const t0 = Date.now();
    while (!done && Date.now() - t0 < 180_000) {
      for (const fr of X.page.frames()) {
        if (!/[?&]export=1/.test(fr.url())) continue;
        seen.urls.add(new URL(fr.url()).origin + new URL(fr.url()).pathname);
        const st = await fr.evaluate(() => ({ wrappers: [...document.querySelectorAll('[data-pc-clip]')].map((w) => w.getAttribute('data-pc-clip') + ':' + w.childElementCount), mark: globalThis.__pcOceMark ?? null, live: !!document.querySelector('[data-oce-visual]'), snap: /SNAP oce-exp-v/.test(document.body?.innerText ?? '') || !!document.querySelector('[data-probe-snap="oce-exp-v"]') })).catch(() => null);
        if (st) { seen.wrappers = st.wrappers; seen.frames++; seen.marks.add(String(st.mark)); seen.live ||= st.live; seen.snap ||= st.snap; }
      }
      await sleep(80);
    }
    const exp = await exportPromise;
    const topMark = await X.page.evaluate(() => globalThis.__pcOceMark ?? null);
    summary.E10 = { frames: exp?.result?.frames ?? null, error: exp?.error ?? null, waits: exp?.waits ?? null, stats: exp?.result?.stats ?? null, seen: { wrappers: seen.wrappers ?? null, frames: seen.frames, marks: [...seen.marks], live: seen.live, snap: seen.snap, urls: [...seen.urls] }, topMark };
    check('E10 导出页(同源 ?export=1 的 iframe)被采样到,里面没有卡片模块的顶层记号,编辑页面里也没有', seen.frames > 0 && seen.marks.size === 1 && seen.marks.has('null') && topMark === null, summary.E10);
    // 预渲染原尺寸是合成器在导出页给出的场景快照里换进包裹层的(不在导出页的活文档里):导出页里这张卡的包裹层挂着、里面没有任何活内容;每一帧都换了一次
    check('E10 导出页里同步卡的包裹层挂出来了、里面没有活内容(没有执行卡片代码),每一帧都换成了预渲染原尺寸(heavyReplaced = 15)', seen.live === false && (seen.wrappers ?? []).includes('oce-exp-v:0') && exp?.result?.stats?.heavyReplaced === 15, summary.E10);
    check('E10 导出完成(15 帧),没有等待提示', exp?.result?.frames === 15 && !exp?.error && (exp?.waits ?? []).length === 0, summary.E10);
    // 成片第一帧左上角是预渲染原尺寸的颜色
    let color = null;
    if (exp?.base64) {
      const mp4 = path.join(tmp, 'e10.mp4'), png = path.join(OUT, 'e10-frame0.png');
      fs.writeFileSync(mp4, Buffer.from(exp.base64, 'base64'));
      const r = spawnSync(ffmpeg, ['-y', '-i', mp4, '-vframes', '1', png], { windowsHide: true, timeout: 60_000 });
      if (r.status === 0) { const img = PNG.sync.read(fs.readFileSync(png)); const i = (100 * img.width + 100) * 4; color = { rgb: [img.data[i], img.data[i + 1], img.data[i + 2]], size: [img.width, img.height], file: png }; }
    }
    summary.E10.frame0 = color;
    check(`E10 成片第一帧(左上角像素)是预渲染原尺寸的颜色 (${EXP_COLOR}),容差 ±30,且尺寸是项目画幅`, !!color && near(color.rgb, EXP_COLOR, 30) && color.size[0] === 1920 && color.size[1] === 1080, color);
    check('E10 导出页那一页没有页面错误', X.pageErrors.length === 0, X.pageErrors.slice(0, 3));
    try { ws2.close(); } catch { /* 已关 */ }
    await X.close();
    await b4.close().catch(() => {});
  }

  if (!ONLY_E10) {
  /* ============================================================ 图形能力不够 */
  console.log('\n== E7(续) 图形能力不够(--disable-gpu --disable-software-rasterizer)');
  const b2 = await launch(['--disable-gpu', '--disable-software-rasterizer']);
  const G = await openMember(b2, 'G');
  await G.page.evaluate(() => window.__pcStore.actions.seek(5));
  const gdiag = await until('G 图卡的运行状态有结论', async () => { const d = await G.run(); return d?.run['oce-invert'] && d.run['oce-invert'].state !== 'loading' && d.graph.A && d.graph.B ? d : null; }, 120_000, 500);
  summary.gpu = gdiag;
  check('E7 软件渲染或没有 GPU 的浏览器:图卡的运行状态是 gpu,两台舞台报的图形能力都不是 ok', gdiag?.run['oce-invert']?.state === 'gpu' && gdiag.graph.A !== 'ok' && gdiag.graph.B !== 'ok', { run: gdiag?.run['oce-invert'], graph: gdiag?.graph });
  summary.panel.gpu = await G.panelNote(GCLIP);
  check('E7 参数面板说明「图形能力不够」', /图形能力不够/.test(summary.panel.gpu ?? ''), summary.panel.gpu);
  await sleep(1500);
  const gs = await G.stageState([GCLIP]);
  check('E7 图卡片段退回原做法:舞台不挂图卡的画布', gs?.[GCLIP]?.graphNode === false, gs?.[GCLIP]);
  await G.page.evaluate(() => window.__pcStore.actions.seek(1));
  const gdom = await until('G 的 DOM 用户卡不受影响(画面卡是活 DOM)', async () => { const s = await G.stageState([V.v], PROBES); return s?.[V.v]?.live ? s : null; }, 90_000, 500);
  check('E7 同一个页面里 DOM 用户卡不受影响:画面卡照样在浏览器里画', !!gdom && (await G.run())?.run['oce-visual']?.state === 'ready', { run: (await G.run())?.run['oce-visual'] });
  check('E7 GPU 页没有页面错误', G.pageErrors.length === 0, G.pageErrors.slice(0, 3));
  await G.shot('e7-gpu-editor');
  await G.close();
  await b2.close().catch(() => {});

  /* ============================================================ 低内存档 */
  console.log('\n== E9 手机低内存档(仿手机)');
  const b3 = await launch();
  const P = await openMember(b3, 'P', { mobile: true });
  const lm = await until('P 运行状态落定为 low-memory', async () => { const d = await P.run(); return d?.run['oce-visual']?.state === 'low-memory' ? d : null; }, 120_000, 500);
  check('E9 低内存档:同步卡的运行状态是 low-memory(现有规则:这台设备不运行用户卡与图卡的代码)', !!lm && ['oce-visual', 'oce-rel', 'oce-invert'].every((id) => lm.run[id]?.state === 'low-memory'), lm?.run);
  summary.panel.lowmem = await P.panelNote(V.v);
  check('E9 参数面板说明「低内存档,不运行用户卡与图卡的代码」', /低内存档/.test(summary.panel.lowmem ?? ''), summary.panel.lowmem);
  await P.page.evaluate(() => window.__pcStore.actions.seek(1));
  await sleep(4000);
  const mm = await markersIn(P);
  check('E9 低内存档的任何文档里都没有执行卡片代码的记号', mm.top === null && mm.stages.every((n) => n === null), mm);
  const ps = await P.stageState([V.v, V.rel], PROBES);
  check('E9 低内存档里没有预渲染结果的卡显示「需要本地 PC 渲染辅助」图标,没有活 DOM(同现有规则)', [V.v, V.rel].every((id) => ps?.[id]?.placeholderShown && ps[id].reason === 'unsupported' && !ps[id].live), ps);
  summary.lowmem = { run: lm?.run ?? null, markers: mm };
  await P.shot('e9-lowmem');
  check('E9 低内存档没有页面错误', P.pageErrors.length === 0, P.pageErrors.slice(0, 3));
  await P.close();
  }
} catch (e) {
  check('探针没有中途出错', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  try { ws.close(); } catch { /* 已关 */ }
  for (const b of browsers) await b.close().catch(() => {});
  await proxy.close().catch(() => {});
  await combo.close?.().catch?.(() => {});
  for (const dir of [dataDir, tmp]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ } }
}
const ok = fails.length === 0;
timingLog.print();
console.log(JSON.stringify({ ok, pass, fail: fails.length, fails, ...summary }));
process.exit(ok ? 0 : 1);
