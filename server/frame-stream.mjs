/**
 * 轨道流(R8,任务书 `docs/plan/r8-streams-task.md` 的 G1～G6)—— 预渲染进程这一侧。
 *
 * 给预渲染集合里的卡产「轨道流」:每张(或每组)重卡一条 H.264 流,上半 RGB(预乘)、下半 alpha 灰度,
 * 裁到实体框,从这条流自己的第一帧起每 15 帧切成一个 fMP4 分段(换算只在 `src/render/streamSegments.mjs` 一处)。
 * 页面侧的解封装 / 解码 / 合成在 `src/render/streamPlayer.ts`。
 *
 * # 这个文件里有什么
 *
 *   - fMP4 按 box 切分与校验(G2:`ftyp + moov` → init,`moof + mdat` → 分段,`mfra` 丢掉);
 *   - 流的划分(G1):哪些卡进流、裁剪矩形的上界、超出解码器预算时合并成组流、每条流的隔离工程;
 *   - 流库(`<库根>/streams/<streamKey>/`):`stream.json` 清单 + `init-<id>.mp4` + `<n>-<hash>.m4s`;
 *   - 生产调度 `StreamProducer`(G4):只在空闲时生产、`streamPool` 个会话、先稀疏后补密、租约延续;
 *     稀疏版每个分段只截分段的第一帧、其余帧重复它,顺带量这一张的位置矩形记进清单(`segments[n].box`);
 *   - 校验与替换(G6):分段签名不对的重新生产,新分段到达后换用,旧文件延迟 5 秒删除;
 *   - 分段字节的 HTTP 读口 `handleStreamRequest`(路由挂在 `vite-plugin-frames.ts` 上,见报告)。
 *
 * # 两种流的坐标系
 *
 *   - **单卡流**(`plane: 'local'`):画在**包裹层自己的坐标系**里 —— 和快照平面一样,x / y / 缩放 /
 *     旋转 / 不透明度 / 淡入淡出 / motion / 强调都不在流里,舞台上由包裹层照常加上(E7 第 5 条:
 *     「层序、overflow、zIndex 自动跟着包裹层走」「包裹层轨迹仍随 t 变」)。隔离工程里把这张卡的框
 *     摆到画面里(`offset`),截图矩形 = 平面矩形 + `offset`。
 *   - **组流**(`plane: 'stage'`):舞台坐标,组内各卡的包裹层外观全部画进流里(G1),
 *     由 `Stage` 渲在与包裹层同级的 `[data-pc-group-plane]` 上。
 *
 * 单卡流除了平面的独立卡,还有两类单独成流的卡(`soloStreamKind`):源依赖卡(转场、套在视频上的素材效果卡,连同它用到的视频一起渲)
 * 和外框用了三维变形的独立卡(流里是变形之前的画面,贴的时候包裹层照常做变形)。
 *
 * # 分段的「变体」
 *
 * 一条流的所有分段不一定同一个矩形:稀疏那一趟用上界矩形、每个分段量一个位置矩形(这一张里不透明像素的外接框),
 * 整条流的稀疏版齐了以后把它们的并集定成收紧矩形,补密那一趟用收紧后的矩形(补密时发现画面顶到了收紧矩形的边,就把它放大重来)。矩形或编码器不同,
 * `init.mp4` 就不同 —— 每个分段在清单里记着自己用哪个 `init`,页面按分段各自配置解码器。
 * 同一个变体里,后续分段算出来的 `ftyp + moov` 必须和已存的逐字节相同,不同就是新变体(换签名)。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { bakeStream } from './bakery/bake.mjs';
import { directCaptureMode, directSegmentCapture, newDirectRecord, rgbaAlphaBox } from './bakery/capture-canvas.mjs';
import { belowSegmentCapture, newBelowRecord } from './bakery/capture-below.mjs';
import { prepareFrameMedia } from './bakery/frame-media.mjs';
import { findFfmpeg, openStreamSegmentEncoder, pickStreamEncoder, STREAM_ENCODERS, streamFilterIdentity, STREAM_SEGMENT_FRAMES } from './bakery/ffmpeg.mjs';
import { mountFrameOf } from '../src/render/frameWindow.mjs';
import { resolveFrameSize } from '../src/kernel/frameSize.mjs';
import { cardStreamIdentity } from './card-identity.mjs';
import { resultKeyOf } from './render-node/fingerprint.mjs';
import { planStreamSegments } from './frame-playback.mjs';
import { belowLayersOf, streamInputSig } from '../src/render/streamInputSig.mjs';
import { isStreamOrigin, streamSegmentFirstFrame, streamSegmentFrameCount, streamSegmentLastFrame, streamSegmentOf, streamSegmentSpan } from '../src/render/streamSegments.mjs';

import { StreamStore, readySegmentRanges, handleStreamRequest } from './asset-store/stream-store.mjs';
export { StreamStore, readySegmentRanges, publicManifest, handleStreamRequest } from './asset-store/stream-store.mjs';

export const SEGMENT_FRAMES = STREAM_SEGMENT_FRAMES;
/**
 * 稀疏版的间隔:就是一个分段的帧数 —— 每个分段只截分段的第一帧,其余帧重复它(只有这一档;原来「每 3 帧一张」那一档去掉了)。
 * 清单里稀疏分段的 `stride` 记这个数,满密度的记 1;读的一侧只看它是不是大于 1。
 */
export const SPARSE_STRIDE = STREAM_SEGMENT_FRAMES;
/** G1 / G0-b (4):同时活跃的解码器预算 */
export const STREAM_DECODER_BUDGET = 6;
/** G0-b 结论 1:`streamPool` 缺省 1,最多 2 */
export const STREAM_POOL_DEFAULT = 1;
export const STREAM_POOL_MAX = 2;
/** G6:替换后旧文件延迟这么久再删(页面上可能还有一个在途请求) */
export const REPLACED_DELETE_MS = 5000;
/**
 * 生产这条流的代码的版本(改了分段格式 / 坐标口径就加一,旧流全部作废)。
 * 2:画布卡的帧从画布直接取像素(`./bakery/capture-canvas.mjs`);单卡流的成员键不再带生成快照的代码指纹
 * (`docs/plan/prerender-products-contract.md` 第 9.3 节,这两样同一次换)。
 * 3:分段从这条流自己的第一帧起每 15 帧一段(原来从项目的第 0 帧起),最后一段到这条流自己的最后一帧为止
 * (`src/render/streamSegments.mjs`;`docs/plan/html-snapshot-removal-dryrun.md` 第 10.5 节)。分段号的含义变了,旧流全部重产。
 * 4:稀疏版每个分段只截第一帧(原来每 3 帧一张);清单里每个分段带位置矩形 `box`;收紧矩形改由各分段的位置矩形定、
 * 补密时顶到边就放大。旧清单里的稀疏分段没有位置矩形、收紧矩形的来历也不同,不混着用,重产一次(这一版还没有发出去过)。
 */
export const STREAM_CODE_VERSION = 4;
/** 单卡流的矩形上界:框外再留这么多像素给溢出框的内容(阴影、描边) */
export const LOCAL_OVERFLOW_PX = 32;
/** 各分段位置矩形的并集再外扩这么多(稀疏版每个分段只量了第一帧,中间帧可能略微超出;超出得多由补密那一趟发现、放大) */
export const MEASURE_PAD_PX = 8;
/** 补密时画面顶到了收紧矩形的某一边、重量过以后:这一边在量到的边界之外最多再多留这么多像素(画面多半还会接着往那边走) */
export const TIGHT_WIDEN_MARGIN_PX = 64;
/** 收紧后的面积超过上界的这个比例就不收紧(白换一个变体没有收益) */
export const TIGHTEN_MIN_SAVING = 0.15;
/** X1:队列的流任务里,一个分段最多连着产几次(失败或被中途作废)才放弃这个任务(可重试) */
export const QUEUE_SEGMENT_ATTEMPTS = 3;

/** `streams` 开关(任务书:默认开;`PROMPTCUT_STREAMS=0` 关) */
export function streamsEnabled(env = process.env) {
  return String(env.PROMPTCUT_STREAMS ?? '1').trim() !== '0';
}

/**
 * 「依赖下层的流」(`kind: 'below'`,`docs/plan/prerender-products-contract.md` 第 5 节)出不出。**缺省开**。
 *
 * 这种流的计划、键、隔离工程、切分与认领、流里的像素怎么取(差分取层,`./bakery/capture-below.mjs`)、怎么贴回舞台
 * (`src/render/Stage.tsx` 舞台根下的那块平面)都做了,产品里一直出。
 * 只给单测和探针留一个**关掉**的办法:环境变量 `PROMPTCUT_TEST_BELOW_STREAMS=0`(生产环境不设),或给 `planStreams` 传
 * `below: false` —— 用来扮「还不认识这种流的旧节点」(队列里新旧节点并存时,旧节点收到这种任务要报对不上、不可重试)。
 * 关着的时候 `planStreams` 不出这种流,于是切分不出这种任务、层表里没有这种行、生产者不产它。
 */
export const BELOW_STREAMS_DEFAULT = true;
export function belowStreamsEnabled(env = process.env) {
  const flag = String(env?.PROMPTCUT_TEST_BELOW_STREAMS ?? '').trim();
  if (flag === '0') return false;
  if (flag === '1') return true;
  return BELOW_STREAMS_DEFAULT;
}

/**
 * 依赖下层的流:推过去而不取图的帧(回放的帧、稀疏那一趟分段里第一帧以外的帧)也要真的画一次,用这张丢掉的截图来画。
 *
 * 原因(2026-10-14 在导出页上单独量的,不经过产流):下层有一张中途挂载的 motion 式卡、上面压着毛玻璃(`backdrop-filter`)时,
 * 只推帧不截图(`beginFrame` 不带 `screenshot`)的那几拍里,这张卡的动画在画面上不往前走 —— 动画的时刻在页面里是对的,
 * 可合成出来的像素停在它挂载的那一帧,要到下一次真的截图才起步,之后一直落后那么多帧;没有毛玻璃压着时没有这回事。
 * 每一拍都截一张(哪怕是最便宜的)就对了。质量 1 的 JPEG 在 960×540 上每张约 4 毫秒。
 * 不这样做的后果:稀疏版和断了租约重产的满密度分段里,下层那张卡落后好几帧(流里的画面是错的);画面还在一拍一拍地追,
 * 差分取层的自检(藏起目标卡再露出来,带目标卡的那张要不变)有时就过不了,整条流被判死。
 */
const BELOW_DISCARD_SHOT = Object.freeze({ format: 'jpeg', quality: 1 });
/** 上面那种丢掉的帧在 `bakeStream` 的 `capture` → `onFrame` 之间的记号 */
const BELOW_SKIPPED = Object.freeze({ skipped: true });

/** 解码器预算。只给探针压低它(`PROMPTCUT_STREAM_DECODERS`),产品里就是 6 */
export function streamDecoderBudget(env = process.env) {
  const n = Math.round(Number(env.PROMPTCUT_STREAM_DECODERS));
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : STREAM_DECODER_BUDGET;
}

/** `streamPool` 的上限:`PROMPTCUT_STREAM_POOL=1|2`;不设 = 从 1 起按实测自适应、最多 2 */
export function streamPoolLimit(env = process.env) {
  const n = Math.round(Number(env.PROMPTCUT_STREAM_POOL));
  return n === 1 || n === 2 ? { fixed: n } : { fixed: null };
}

const sha = (data, n = 64) => createHash('sha256').update(data).digest('hex').slice(0, n);
const zlibInflate = data => zlib.inflateSync(data);
const sleep = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); });

/* ======================================================================== *
 * fMP4(G2)
 * ======================================================================== */

/** 顶层 box:[{ type, start, end, header }] */
export function topLevelBoxes(buf) {
  const out = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    else if (size === 0) size = buf.length - off;
    if (size < header || off + size > buf.length) break;
    out.push({ type, start: off, end: off + size, header });
    off += size;
  }
  return out;
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts']);

/** 递归找第一个某类型的 box,回 `{ payload, start, end }` */
export function findBox(buf, type, start = 0, end = buf.length) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const t = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    else if (size === 0) size = end - off;
    if (size < header || off + size > end) return null;
    if (t === type) return { payload: buf.subarray(off + header, off + size), start: off, end: off + size };
    let inner = null;
    if (CONTAINERS.has(t)) inner = off + header;
    else if (t === 'stsd') inner = off + header + 8;
    else if (t === 'avc1' || t === 'avc3') inner = off + header + 78;
    if (inner !== null) { const hit = findBox(buf, type, inner, off + size); if (hit) return hit; }
    off += size;
  }
  return null;
}

/**
 * ffmpeg 一次调用的输出 → `{ init, segments, dropped }`。`ftyp + moov` 是 init,
 * 每对 `moof + mdat` 是一个分段,别的顶层 box(`mfra`)丢掉、不落盘。
 */
export function splitFmp4(buf) {
  const boxes = topLevelBoxes(buf);
  let i = 0, initEnd = 0;
  for (; i < boxes.length && (boxes[i].type === 'ftyp' || boxes[i].type === 'moov'); i++) initEnd = boxes[i].end;
  const segments = [], dropped = [];
  let segStart = -1;
  for (; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.type === 'moof') {
      if (segStart >= 0) segments.push(buf.subarray(segStart, b.start));
      segStart = b.start;
    } else if (b.type !== 'mdat') {
      if (segStart >= 0) { segments.push(buf.subarray(segStart, b.start)); segStart = -1; }
      dropped.push(b.type);
    }
  }
  if (segStart >= 0) segments.push(buf.subarray(segStart));
  return { init: Buffer.from(buf.subarray(0, initEnd)), segments: segments.map(s => Buffer.from(s)), dropped };
}

/** `avcC` → `avc1.PPCCLL`(G5:**codec 串从 avcC 拼**,level 随内容变,不能写死) */
export function codecOfAvcC(avcC) {
  const hex = b => b.toString(16).padStart(2, '0');
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}

/** init.mp4 → `{ codec, width, height, timescale }` */
export function initInfo(init) {
  const avcC = findBox(init, 'avcC');
  const avc1 = findBox(init, 'avc1');
  const mdhd = findBox(init, 'mdhd');
  let width = null, height = null, timescale = null;
  if (avc1) { width = avc1.payload.readUInt16BE(24); height = avc1.payload.readUInt16BE(26); }
  if (mdhd) timescale = mdhd.payload.readUInt8(0) === 1 ? mdhd.payload.readUInt32BE(20) : mdhd.payload.readUInt32BE(12);
  return { codec: avcC ? codecOfAvcC(avcC.payload) : null, width, height, timescale };
}

/** 一个分段 → `{ moofs, sampleCount, firstSampleIsSync }` */
export function segmentInfo(seg) {
  const moofs = topLevelBoxes(seg).filter(b => b.type === 'moof').length;
  const tfhd = findBox(seg, 'tfhd');
  const trun = findBox(seg, 'trun');
  let defaultFlags = null, firstFlags = null, sampleCount = 0;
  if (tfhd) {
    const flags = tfhd.payload.readUInt32BE(0) & 0xffffff;
    let o = 8;
    if (flags & 0x1) o += 8;
    if (flags & 0x2) o += 4;
    if (flags & 0x8) o += 4;
    if (flags & 0x10) o += 4;
    if (flags & 0x20) defaultFlags = tfhd.payload.readUInt32BE(o);
  }
  if (trun) {
    const flags = trun.payload.readUInt32BE(0) & 0xffffff;
    sampleCount = trun.payload.readUInt32BE(4);
    let o = 8;
    if (flags & 0x1) o += 4;
    if (flags & 0x4) firstFlags = trun.payload.readUInt32BE(o);
    // 没有 first_sample_flags 时逐样本的 flags 在样本表里
    if (firstFlags === null && (flags & 0x400)) {
      let p = o;
      if (flags & 0x100) p += 4;
      if (flags & 0x200) p += 4;
      firstFlags = trun.payload.readUInt32BE(p);
    }
  }
  const eff = firstFlags ?? defaultFlags;
  return { moofs, sampleCount, firstSampleIsSync: eff === null ? null : (eff & 0x00010000) === 0 };
}

/* ======================================================================== *
 * 实测实体框:截下来的 PNG 里 alpha > 0 的包围盒(G1「用实测实体框的并集」;G0-b (10) 的量法)
 *
 * 不用页面里 `__pcSolid` 的实体框:那一套按元素外框算,`box-shadow` / 发光这类画在框外的像素
 * 不在里面(实测金句药丸的外发光被裁掉一圈)。截图本来就在手上,直接看像素最准。
 * ======================================================================== */

/**
 * PNG(8 位,RGBA / 灰度 + alpha,不隔行)里 alpha > `threshold` 的像素的包围盒,坐标是图片像素;
 * 一个都没有回 null;读不懂的格式回 `{ full: true }`(调用方当「整张都算」)。
 *
 * 没有 alpha 通道的 PNG(真彩色、灰度,又没有 `tRNS` 透明色):整张都不透明,包围盒就是整张图。画面铺满截图矩形又不透明时
 * (源依赖卡的流里带着视频,多半如此)Chrome 交出来的就是这种 PNG;以前把它当「读不懂」,这条流的分段就没有位置矩形,
 * 补密时也不看画面有没有顶到收紧矩形的边。
 */
export function pngAlphaBox(buf, threshold = 0) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return { full: true };
  let off = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0, keyed = false;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
    else if (type === 'tRNS') keyed = true;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = color === 6 ? 4 : color === 4 ? 2 : 0;
  // 真彩色(2)、灰度(0)而且没有透明色:没有 alpha 通道,每个像素都不透明
  if ((color === 2 || color === 0) && !keyed && width > 0 && height > 0) return { x: 0, y: 0, w: width, h: height };
  if (depth !== 8 || interlace || !bpp || !width || !height) return { full: true };
  let raw;
  try { raw = zlibInflate(Buffer.concat(idat)); } catch { return { full: true }; }
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return { full: true };
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let minX = width, minY = -1, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1) + 1;
    const f = raw[base - 1];
    if (f === 0) { for (let i = 0; i < stride; i++) cur[i] = raw[base + i]; }
    else if (f === 1) { for (let i = 0; i < stride; i++) cur[i] = (raw[base + i] + (i >= bpp ? cur[i - bpp] : 0)) & 255; }
    else if (f === 2) { for (let i = 0; i < stride; i++) cur[i] = (raw[base + i] + prev[i]) & 255; }
    else if (f === 3) { for (let i = 0; i < stride; i++) cur[i] = (raw[base + i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255; }
    else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[i] = (raw[base + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    } else return { full: true };
    let first = -1, last = -1;
    for (let x = 0, i = bpp - 1; x < width; x++, i += bpp) if (cur[i] > threshold) { if (first < 0) first = x; last = x; }
    if (first >= 0) {
      if (minY < 0) minY = y;
      maxY = y;
      if (first < minX) minX = first;
      if (last > maxX) maxX = last;
    }
    const t = prev; prev = cur; cur = t;
  }
  return maxY < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/* ======================================================================== *
 * 矩形
 * ======================================================================== */

const rectOf = (x0, y0, x1, y1) => ({ x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) });
export const intersectRect = (a, b) => rectOf(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.min(a.x + a.w, b.x + b.w), Math.min(a.y + a.h, b.y + b.h));
export const unionRect = (a, b) => !a ? b : !b ? a : rectOf(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x + a.w, b.x + b.w), Math.max(a.y + a.h, b.y + b.h));
export const padRect = (r, pad) => rectOf(r.x - pad, r.y - pad, r.x + r.w + pad, r.y + r.h + pad);
export const rectArea = r => Math.max(0, r?.w || 0) * Math.max(0, r?.h || 0);
/** 是不是一个矩形(四个有限数,宽高为正);位置矩形 `box` 的形状 */
export const isBox = r => !!r && typeof r === 'object' && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0;

/**
 * 一张按 `rect` 截的图里,不透明像素的外接框 `local`(图片像素坐标)顶到了 `rect` 的哪几边 —— 只算还没到上界 `bound` 的边
 * (已经贴着上界的边再往外就不是这条流的范围了)。有顶到的回 `{ left?, top?, right?, bottom? }`,没有回 null。
 */
/** 收紧矩形在 `sides` 里为真的那几边放到上界,别的边不动(重量的一趟用的截图矩形) */
export function extendSides(tight, sides, bound) {
  const x0 = sides?.left ? bound.x : tight.x, y0 = sides?.top ? bound.y : tight.y;
  const x1 = sides?.right ? bound.x + bound.w : tight.x + tight.w, y1 = sides?.bottom ? bound.y + bound.h : tight.y + tight.h;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function tightOverflowSides(local, rect, bound) {
  const sides = {};
  if (local.x <= 0 && rect.x > bound.x) sides.left = true;
  if (local.y <= 0 && rect.y > bound.y) sides.top = true;
  if (local.x + local.w >= rect.w && rect.x + rect.w < bound.x + bound.w) sides.right = true;
  if (local.y + local.h >= rect.h && rect.y + rect.h < bound.y + bound.h) sides.bottom = true;
  return Object.keys(sides).length ? sides : null;
}

/**
 * 整数化并外扩到**偶数宽、偶数高**(G1:`format=yuv420p` 严格要求宽高都是偶数;取整做在截图矩形上,
 * 滤镜链不动),结果不出 `limit`。`limit` 自己的宽高必须是偶数。优先往右 / 下扩,碰边再往左 / 上。
 */
export function evenRect(r, limit) {
  let x0 = Math.floor(r.x), y0 = Math.floor(r.y), x1 = Math.ceil(r.x + r.w), y1 = Math.ceil(r.y + r.h);
  const lx0 = limit.x, ly0 = limit.y, lx1 = limit.x + limit.w, ly1 = limit.y + limit.h;
  x0 = Math.max(x0, lx0); y0 = Math.max(y0, ly0); x1 = Math.min(x1, lx1); y1 = Math.min(y1, ly1);
  if (x1 - x0 < 2) { x1 = Math.min(lx1, x0 + 2); x0 = x1 - 2; }
  if (y1 - y0 < 2) { y1 = Math.min(ly1, y0 + 2); y0 = y1 - 2; }
  if ((x1 - x0) % 2) { if (x1 < lx1) x1++; else x0--; }
  if ((y1 - y0) % 2) { if (y1 < ly1) y1++; else y0--; }
  return rectOf(x0, y0, x1, y1);
}

/* ======================================================================== *
 * 流的划分(G1)
 * ======================================================================== */

const frame3d = frame => !!(frame?.rotateX || frame?.rotateY || frame?.translateZ);

/**
 * 这张卡是不是**平面的独立卡**(单卡流里可以和相邻的独立卡并成组流的那一种)。**只收 `independent`**:毛玻璃(`belowDependent`)
 * 要采样下层,`unknown` 一律按 `belowDependent` 处理(G1「哪些卡不进流」)。源依赖卡(转场、接素材的素材效果卡)和框用了三维的
 * 独立卡不在这里:它们同样产单卡流,但单独成流、不并进组流,判据在下面的 `soloStreamKind`。
 */
export function streamEligible(control, clip, track) {
  if (!control?.clipId || !clip || !track) return false;
  if (track.hidden || track.sourceOnly) return false;
  if (!clip.cardId) return false;
  const compositing = control.capabilities?.compositing ?? control.compositing;
  if (compositing !== 'independent') return false;
  if (frame3d(clip.frame)) return false;
  return Number.isInteger(control.count) && control.count > 0;
}

/** 项目里 `id` 是这个值的卡片节点(`project.cardNodes`;数组,旧数据里也可能是按 id 存的对象) */
function cardNodeOf(project, nodeId) {
  if (typeof nodeId !== 'string' || !nodeId) return null;
  const raw = project?.cardNodes;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  return list.find(node => node?.id === nodeId) ?? null;
}

/**
 * 这个片段是不是**接着输入的素材效果卡**(转场、套在素材上的滤镜这一类):片段挂的节点是出画面的素材效果卡节点
 * (判据同 `src/render/cards/GraphCard.tsx` 的 `graphVisualNode`),而且它有输入(接素材、接别的片段、接另一张素材效果卡;
 * 输入指向的片段已经删掉的也算 —— 边还记在节点上)。没有输入的素材效果卡(自己生成画面的)不算。
 */
export function graphCardWithInputs(project, clip) {
  const node = cardNodeOf(project, clip?.nodeId);
  if (!node || node.adapter !== 'card' || node.kind === 'audio') return false;
  return !!node.inputs && typeof node.inputs === 'object' && Object.keys(node.inputs).length > 0;
}

/**
 * 两类**单独成流**的卡(`docs/semantics/mechanism/rendering.md`「重管线:预渲染」「怎么产,按卡分」;用户 2026-10-13 定,
 * `docs/plan/user-decisions-2026-10-13.md` 第 1 节第 7 条)。它们各产一条单卡流(`kind: 'card'`、`plane: 'local'`,和独立卡的单卡流
 * 同一种形状、走同一套稀疏版与满密度版、分段、位置矩形、任务队列),只是不参加组流合并,浏览器也不产(见下):
 *
 *   - `'source'` **源依赖卡**:转场、套在视频上的素材效果卡 —— 画面取决于别的素材或别的片段。连同它用到的视频一起渲:
 *     隔离工程里它的源片段都留着(藏起来的序列是 `sourceOnly`,不出画,素材效果卡解输入时找得到),流里就是「视频经过这张卡以后」
 *     的画面;贴的时候这条流顶替这张卡原来的画面(套在视频上的那一种,这一段的视频本来就由这张卡画,不另画)。
 *     判据:审阅表写了 `sourceDependent`;或者没有审阅过(`unknown`、旧的统称 `context`)而片段挂着接了输入的素材效果卡节点
 *     (`graphCardWithInputs`)。素材效果卡的画面是宿主照它给的描述在画布上执行出来的,采样不到下面的层,所以不走「依赖下层的流」。
 *     流键里顺着输入带着整条源链(`CardFrameCache.plan` 的 `streamMemberKey`:素材本身、素材的裁剪起点、每条输入的时间映射、
 *     上游各张卡的参数与源码版本),页面的输入签名同样(`src/render/layerInputSig.mjs`),任一变了旧流就不再贴;
 *   - `'spatial'` **外框用了三维变形的独立卡**:流里是变形之前的平面画面(隔离工程里框只留位置和宽高,`localClip`),
 *     贴的时候流平面是包裹层的子元素,包裹层照常带着三维变形,所以画面跟着变形。三维那几项不进流键(它们不在流里)。
 *
 * 两类同时成立时算 `'source'`(框的三维照样不在流里)。别的卡回 null:平面的独立卡走 `streamEligible`,
 * 依赖下层的、没审阅过又没接输入的走 `belowStreamEligible`。
 *
 * 不参加组流合并:组流按舞台坐标产,成员的外观(含三维)全画进流里,和「流里是变形之前的画面」对不上;源依赖卡多半整幅不透明,
 * 并进组流会把夹在中间的层关系压平。它们各占一个解码器,算进预算。
 * 浏览器不产:源依赖卡要解素材、执行素材效果卡,三维外框的卡浏览器那条取像素的路没有验过;切分不出浏览器那一份
 * (`render-node/split.mjs` 的 `browserStreamInputOf`),在线页面本页产流也不认它们(`src/online/pageStreamPlan.ts`)。
 */
export function soloStreamKind(control, clip, track, project) {
  if (!control?.clipId || !clip || !track) return null;
  if (track.hidden || track.sourceOnly) return null;
  if (!clip.cardId) return null;
  if (!(Number.isInteger(control.count) && control.count > 0)) return null;
  const compositing = control.capabilities?.compositing ?? control.compositing;
  if (compositing === 'sourceDependent') return 'source';
  if (compositing === 'independent') return frame3d(clip.frame) ? 'spatial' : null;
  if (compositing === 'belowDependent') return null;
  return graphCardWithInputs(project, clip) ? 'source' : null;
}

/**
 * 源依赖卡的流要不要从挂载帧回放:这张卡自己是 motion 式的要(`streamNeedsReplay`);它的输入链上还有别的素材效果卡时也要 ——
 * 上游那几张卡的写法这里拿不到(卡片计划里只有输出节点的能力),保守地当它们带着历史。只接素材的不用:素材按时间直接取帧。
 */
function sourceNeedsReplay(project, clip, control) {
  if (streamNeedsReplay([control])) return true;
  const top = cardNodeOf(project, clip?.nodeId);
  if (!top) return false;
  const seen = new Set([top.id]);
  const queue = [top];
  while (queue.length) {
    const node = queue.shift();
    for (const ref of Object.values(node?.inputs ?? {})) {
      const id = typeof ref === 'string' ? ref : ref?.nodeId;
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      // 片段的素材本身(`@clip/<id>/source`):按时间取帧,没有历史。片段不是素材段时这个节点是它那张卡,但素材效果卡不接 DOM 卡
      if (/^@clip\/.+\/source$/.test(id)) continue;
      const upstream = cardNodeOf(project, id);
      if (upstream?.adapter === 'media') continue;
      if (!upstream || upstream.adapter === 'card') return true;
      queue.push(upstream);
    }
  }
  return false;
}

/**
 * 「依赖下层的流」收哪些卡(契约第 5.1 节)之外,另外两类卡进不进。现在都不进;以后要并进这条路,把对应的一项改成 true 就行
 * (`docs/plan/html-snapshot-removal-dryrun.md` 第 0 节第 7 条):
 *   - `sourceDependent`:源依赖卡(转场、接素材的素材效果卡)。隔离工程里它的源片段都留着(藏起来的序列仍是 `sourceOnly`),
 *     键里目标卡的缓存内容键已经顺着输入带上了整条源链;
 *   - `frame3d`:框用了三维的卡(含独立卡 —— 它进不了单卡流)。这种流按舞台坐标产,三维摆放照原样画进去。
 * 用户 2026-10-13 定了这两类的做法:源依赖卡和三维外框的独立卡各自单独成流(上面的 `soloStreamKind`),不走这条路,
 * `planStreams` 先把它们挑走。还剩一种没有流:**依赖下层(或没审阅过、又没接输入)而外框又用了三维的卡** —— 它的画面取决于
 * 它在屏幕上盖住了什么,产不出「变形之前的画面」;要给它流只能把 `frame3d` 打开(流里是带着三维的舞台坐标画面),见报告。
 */
export const BELOW_STREAM_RULES = Object.freeze({ sourceDependent: false, frame3d: false });

/**
 * 这张卡进不进「依赖下层的流」。收:依不依赖下层这一样是「依赖下层」(`belowDependent`)、旧的统称 `context`、
 * 或「未知」(`unknown`,审阅表没覆盖到的卡;没写、认不出的值也按未知)的卡。平面的独立卡走单卡流(`streamEligible`),不进这里;
 * 源依赖卡和框用了三维的卡看 `rules`。和 `streamEligible` 不会同时为真。
 */
export function belowStreamEligible(control, clip, track, rules = BELOW_STREAM_RULES) {
  if (!control?.clipId || !clip || !track) return false;
  if (track.hidden || track.sourceOnly) return false;
  if (!clip.cardId) return false;
  const spatial = frame3d(clip.frame);
  if (spatial && rules?.frame3d !== true) return false;
  const compositing = control.capabilities?.compositing ?? control.compositing;
  if (compositing === 'independent') { if (!spatial) return false; }
  else if (compositing === 'sourceDependent') { if (rules?.sourceDependent !== true) return false; }
  return Number.isInteger(control.count) && control.count > 0;
}

/**
 * 场景里全部**画面层**(卡片段 + 画面素材段),按画家顺序排:和 `FrameScene` 一样,
 * `project.tracks` 倒着数(第一条序列在最上面),同一条序列里按片段顺序。
 * 组流「只由 z 序相邻的卡组成」—— 相邻要连素材层一起看。
 */
export function paintLayers(project, fps) {
  const tracks = project?.tracks ?? [];
  const media = new Map((project?.media ?? []).map(m => [m.id, m]));
  const out = [];
  tracks.forEach((track, ti) => {
    if (track.hidden || track.sourceOnly) return;
    (track.clips ?? []).forEach((clip, ci) => {
      const card = !!clip.cardId;
      const m = clip.mediaId ? media.get(clip.mediaId) : null;
      if (!card && !(m && m.kind !== 'audio')) return;
      const from = card ? mountFrameOf(clip, fps) : Math.max(0, Math.floor(clip.start * fps));
      const to = Math.max(from, Math.ceil(clip.end * fps - 1e-9) - 1);
      out.push({ clipId: clip.id, card, order: (tracks.length - 1 - ti) * 1e6 + ci, from, to, trackIndex: ti, clipIndex: ci });
    });
  });
  return out.sort((a, b) => a.order - b.order);
}

/**
 * 区间集合在同一帧上的最大重叠数,以及峰值出现在哪一帧。`skip`(帧号的集合)给了,就不把这些帧当候选:
 * 回的是剩下的帧里重叠最多的那一帧(`groupStreams` 在有不参加合并的流时用它换一帧再找)。
 */
export function peakConcurrency(intervals, skip = null) {
  const events = [];
  for (const it of intervals) { events.push([it.from, 1]); events.push([it.to + 1, -1]); }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0, at = 0;
  for (const [frame, d] of events) { cur += d; if (cur > peak && !skip?.has(frame)) { peak = cur; at = frame; } }
  return { peak, at };
}

/**
 * 同时活跃的流超过解码器预算时,把超出的**相邻**重卡合并成组流(G1:「这是唯一的合并规则」)。
 *
 * `streams`:按画家顺序排好的单卡流 `[{ clipIds: [id], order, from, to }]`;`layers`:全部画面层。
 * 贪心:在重叠峰值那一帧上,挑画家顺序里**紧挨着**的两条流(两者之间、在它们合并后的时间段里
 * 没有别的画面层插着)合并;反复直到峰值 ≤ 预算或者再也找不到可合并的一对。
 * 回合并后的列表(每项 `clipIds` 按画家顺序,最后一个是最上面那张)。
 *
 * `fixed`:不参加合并、但同样各占一个解码器的流(依赖下层的流,契约第 5.1 节)`[{ from, to }]`。它们只算进重叠峰值,
 * 不会被挑去合并,也不出现在结果里;不给(或给空)时和原来完全一样。它们在 `layers` 里本来就有自己那一层,
 * 夹在两张卡中间时照旧挡住那两张卡合并。有它们的时候,峰值那一帧上可能没有能合的一对(挤在那里的都是不能合的流),
 * 而别的超预算的帧上有:这一帧找不到就记进 `tried`、换下一个超预算的帧,合成一次以后从头再看。
 */
export function groupStreams(streams, layers, budget = STREAM_DECODER_BUDGET, fixed = []) {
  let list = streams.map(s => ({ ...s, clipIds: [...s.clipIds] }));
  const overlaps = (a, b) => a.from <= b.to && b.from <= a.to;
  const tried = new Set();
  for (let guard = 0; guard < 1000; guard++) {
    const { peak, at } = fixed.length ? peakConcurrency([...list, ...fixed], tried) : peakConcurrency(list);
    if (peak <= budget) break;
    const active = list.map((s, i) => ({ s, i })).filter(({ s }) => s.from <= at && at <= s.to).sort((a, b) => a.s.order - b.s.order);
    let merged = false;
    for (let k = 0; k + 1 < active.length && !merged; k++) {
      const lo = active[k].s, hi = active[k + 1].s;
      const span = { from: Math.min(lo.from, hi.from), to: Math.max(lo.to, hi.to) };
      const members = new Set([...lo.clipIds, ...hi.clipIds]);
      const minOrder = Math.min(lo.order, lo.minOrder ?? lo.order, hi.minOrder ?? hi.order);
      const maxOrder = Math.max(hi.order, lo.order);
      const blocked = layers.some(l => !members.has(l.clipId) && l.order > minOrder && l.order < maxOrder && overlaps(l, span));
      if (blocked) continue;
      const next = { clipIds: [...lo.clipIds, ...hi.clipIds], order: maxOrder, minOrder, from: span.from, to: span.to };
      list = list.filter((_, i) => i !== active[k].i && i !== active[k + 1].i);
      list.push(next);
      list.sort((a, b) => a.order - b.order);
      merged = true;
    }
    if (!merged && !fixed.length) break;
    if (merged) tried.clear(); else tried.add(at);
  }
  return list;
}

/**
 * 一张卡的包裹层框(整数外扩)和它在隔离工程里摆到哪儿(`offset`):框比画面小时居中,
 * 两边都给溢出留地方;框和画面一样大时贴着左上角。
 */
export function localPlacement(clip, stage) {
  const size = resolveFrameSize(clip.frame, stage);
  const w = Math.max(2, Math.ceil(size.w)), h = Math.max(2, Math.ceil(size.h));
  const ox = Math.max(0, Math.floor((stage.width - w) / 2));
  const oy = Math.max(0, Math.floor((stage.height - h) / 2));
  // 平面坐标系下,截图能覆盖到的范围是 [-ox, W - ox] × [-oy, H - oy]
  const view = { x: -ox || 0, y: -oy || 0, w: stage.width, h: stage.height };
  const bound = evenRect(intersectRect(view, padRect({ x: 0, y: 0, w, h }, LOCAL_OVERFLOW_PX)), view);
  return { box: { w, h }, offset: { x: ox, y: oy }, bound };
}

/**
 * 这条流产分段时要不要从挂载帧回放(`docs/plan/prerender-products-contract.md` 第 4.2 节)。
 *
 * 成员里有一张 motion 式(有状态)的卡就要:它的画面带着前面各帧的历史,接不上租约时只能从挂载帧逐帧推过来。
 * 全部成员都是 remotion 式(`frameMode === 'direct'`:画面只由时间和参数决定)才不要 —— 直接落在目标帧就是对的。
 * 写法取 card plan 里带着的 `control.frameMode`;没有这一项(旧形状的输入)、或者声明了 `need_prerendering`
 * 的,一律按有状态处理(宁可多回放,不可画错)。判据和 `snapshot-tier.mjs` 的 `snapshotTier` 的「有状态」一致。
 */
export function streamNeedsReplay(controls) {
  const list = Array.isArray(controls) ? controls : [];
  if (!list.length) return true;
  return list.some(control => {
    const caps = control?.capabilities;
    if ((control?.frameMode ?? caps?.frameMode) !== 'direct') return true;
    return caps?.need_prerendering === true || caps?.needPrerendering === true || control.needPrerendering === true;
  });
}

/**
 * 按 entry(项目 + card plan + 预渲染集合)算出这一版的全部流。纯函数(除了 `prerenderPicked`
 * 由调用方给)。回 `[{ streamKey, contentKey, envFingerprint, kind, plane, clipIds, topClipId, offset, bound,
 * mountFrame, replay, firstFrame, lastFrame, originFrame, firstSegment, lastSegment, members }]`。`replay`:产分段时要不要从挂载帧
 * 回放(`streamNeedsReplay`);不进任何键 —— 不回放不改画面,remotion 式的卡画面只由时间和参数决定。
 *
 * `originFrame`:这条流自己的第一帧(项目帧号)——单卡流是片段的第一帧,组流是成员里最早的第一帧,依赖下层的流是目标卡的第一帧。
 * 分段从它起每 15 帧一段(`streamSegmentSpan`),所以 `firstSegment` 恒为 0;`originFrame` 自己不另进键(键里已有成员的采样窗口)。
 *
 * M4(契约 E.4):`contentKey` 是流的内容键(成员取 card plan 的**内容键**,不含环境),
 * `streamKey = resultKeyOf(contentKey, envFingerprint)` 是落盘和路由用的结果键。同一个项目在两种
 * 环境下 `contentKey` 相同、`streamKey` 不同。没有指纹就不产流(回 `[]`),理由同 `CardFrameCache.plan()`。
 *
 * 单独成流的两类卡(`soloStreamKind`:源依赖卡、框用了三维的独立卡)各出一条 `kind: 'card'`、`plane: 'local'` 的单卡流,另带
 * `solo: 'source' | 'spatial'`,排在单卡流和组流后面;它们不参加组流合并,但占解码器预算。项目里没有这两类卡时结果与原来逐项相同。
 *
 * `below`(缺省取 `belowStreamsEnabled()`,**缺省开**):预渲染集合里依赖下层、`context`、未知的重卡各出一条
 * `kind: 'below'` 的流(`belowStreamSpec`),排在单卡流和组流后面;它们不参加组流合并,但占解码器预算。
 * 传 `false` 时结果与没有这种流时逐项相同。
 */
export function planStreams(entry, { picked = () => true, budget = STREAM_DECODER_BUDGET, codeVersion = '', envFingerprint, below = belowStreamsEnabled() } = {}) {
  if (typeof envFingerprint !== 'string' || !envFingerprint) return [];
  const project = entry?.project;
  const plan = entry?.cardPlan;
  if (!project || !Array.isArray(plan) || !plan.length) return [];
  const fps = Number(project.fps) || 30;
  const stage = { width: Number(project.width) || 1920, height: Number(project.height) || 1080, camera3dFov: project.camera3dFov };
  const total = Math.max(1, Math.floor((Number(project.duration) || 0) * fps));
  const where = new Map();
  (project.tracks ?? []).forEach((track, ti) => (track.clips ?? []).forEach((clip, ci) => where.set(clip.id, { track, clip, ti, ci })));
  const layers = paintLayers(project, fps);
  const orderOf = new Map(layers.map(l => [l.clipId, l.order]));
  const singles = [];
  // 单独成流的两类卡(`soloStreamKind`:源依赖卡、框用了三维的独立卡):各一条单卡流,不参加组流合并,但各占一个解码器
  const solos = [];
  const soloSeen = new Set();
  for (const control of plan) {
    if (!picked(control.clipId)) continue;
    const at = where.get(control.clipId);
    if (!at) continue;
    const flat = streamEligible(control, at.clip, at.track);
    const solo = flat ? null : soloStreamKind(control, at.clip, at.track, project);
    if (!flat && !solo) continue;
    if (solo && soloSeen.has(control.clipId)) continue;
    const firstFrame = control.sampling?.firstFrame ?? Math.ceil(at.clip.start * fps - 1e-9);
    const lastFrame = Math.min(total - 1, firstFrame + control.count - 1);
    if (lastFrame < firstFrame) continue;
    const mountFrame = mountFrameOf(at.clip, fps);
    const item = { control, clip: at.clip, clipIds: [control.clipId], order: orderOf.get(control.clipId) ?? 0, from: Math.min(mountFrame, firstFrame), to: lastFrame };
    if (solo) { soloSeen.add(control.clipId); solos.push({ ...item, solo }); } else singles.push(item);
  }
  singles.sort((a, b) => a.order - b.order);
  solos.sort((a, b) => a.order - b.order);
  const byClip = new Map(singles.map(s => [s.clipIds[0], s]));
  // 依赖下层的流的目标卡(`below: false` 时是空的):不参加组流合并,但各占一个解码器。已经单独成流的卡不再出这种流
  const belows = below ? belowTargets(plan, { picked, where, fps, total, orderOf, taken: soloSeen }) : [];
  const fixed = solos.length ? [...solos, ...belows] : belows;
  const grouped = groupStreams(singles, layers, budget, fixed);
  const specs = [];
  /** 一张卡的单卡流(包裹层自己的坐标系;外观不在流里):平面的独立卡,和单独成流的两类卡,都是这一种 */
  const cardSpec = (m, base) => {
    const placement = localPlacement(m.clip, stage);
    // 成员键取不带生成快照的代码指纹的那一份内容键(`streamMemberKey`:改生成快照的代码不该让流跟着作废);
    // `??` 后面的回退只为没有这个字段的旧形状输入(照旧内容键,再照旧 `snapshotKey || key`)
    const contentKey = cardStreamIdentity({ kind: 'card', fps, stage, codeVersion,
      members: [{ key: m.control.streamMemberKey ?? m.control.contentKey ?? (m.control.snapshotKey || m.control.key), sampling: m.control.sampling, count: m.control.count }] });
    const streamKey = resultKeyOf(contentKey, envFingerprint);
    return { ...base, streamKey, contentKey, envFingerprint, kind: 'card', plane: 'local', offset: placement.offset, bound: placement.bound, box: placement.box, members: [m.control] };
  };
  for (const g of grouped) {
    const members = g.clipIds.map(id => byClip.get(id));
    const first = Math.min(...members.map(m => m.from));
    const last = Math.max(...members.map(m => m.to));
    const firstVisible = Math.min(...members.map(m => m.control.sampling?.firstFrame ?? m.from));
    const base = {
      clipIds: [...g.clipIds], topClipId: g.clipIds[g.clipIds.length - 1], mountFrame: first,
      firstFrame: firstVisible, lastFrame: last,
      ...streamSegmentSpan(firstVisible, last),
      fps, stage, total,
      replay: streamNeedsReplay(members.map(m => m.control)),
    };
    if (members.length === 1) {
      specs.push(cardSpec(members[0], base));
    } else {
      const view = { x: 0, y: 0, w: stage.width, h: stage.height };
      const contentKey = cardStreamIdentity({ kind: 'group', fps, stage, codeVersion,
        members: members.map(m => ({ key: m.control.cacheContentKey ?? m.control.key, sampling: m.control.sampling, count: m.control.count })) });
      const streamKey = resultKeyOf(contentKey, envFingerprint);
      specs.push({ ...base, streamKey, contentKey, envFingerprint, kind: 'group', plane: 'stage', offset: { x: 0, y: 0 }, bound: evenRect(view, view), members: members.map(m => m.control) });
    }
  }
  // 单独成流的两类卡:形状同单卡流,另带 `solo`(哪一类;切分据此不出浏览器那一份)。源依赖卡的回放另看它的输入链
  for (const m of solos) {
    const firstVisible = m.control.sampling?.firstFrame ?? m.from;
    specs.push({ ...cardSpec(m, {
      clipIds: [...m.clipIds], topClipId: m.clipIds[0], mountFrame: m.from,
      firstFrame: firstVisible, lastFrame: m.to,
      ...streamSegmentSpan(firstVisible, m.to),
      fps, stage, total,
      replay: m.solo === 'source' ? sourceNeedsReplay(project, m.clip, m.control) : streamNeedsReplay([m.control]),
    }), solo: m.solo });
  }
  if (belows.length) specs.push(...belowStreamSpecs(entry, belows, { fps, stage, total, codeVersion, envFingerprint }));
  return relockStreams(specs, entry?.streamLocks);
}

/**
 * 「流库里有别的指纹产的同一条流」(任务书 `render-refactor-task.md`「甲二」):单卡流的内容键在 `locks`(内容键 → 环境指纹)里时,
 * 这条流的键照那个指纹出(`streamKey = 内容键 × 那个指纹`,`envFingerprint` 也换成它,本机的记在 `ownEnvFingerprint`)。
 * 锁由管线在把那条流整条拉回本机流库之后才记(`FramePipeline.adoptForeignStreams`),记在每个 entry 的 `streamLocks` 上;
 * 所以照锁出键的流在本机一定是齐的:生产者不重产,舞台播的就是拉回来的那一条,切分时照锁只出一份。
 * 组流、依赖下层的流不换(它们不在别的环境产)。没有锁时原样返回同一个数组。
 */
export function relockStreams(specs, locks) {
  if (!locks || typeof locks.get !== 'function' || !locks.size) return specs;
  return specs.map(spec => {
    const fingerprint = spec?.kind === 'card' ? locks.get(spec.contentKey) : null;
    if (typeof fingerprint !== 'string' || !fingerprint || fingerprint === spec.envFingerprint) return spec;
    return { ...spec, streamKey: resultKeyOf(spec.contentKey, fingerprint), envFingerprint: fingerprint, ownEnvFingerprint: spec.envFingerprint };
  });
}

/**
 * 交给切分(`render-node/split.mjs` 的 `streams`)的一条流:流键与分段范围之外,带上这条流的形状 ——
 * 切分给浏览器出单卡流那一份时要写进任务的 `input.stream`(`docs/plan/browser-stream-task.md` 第一处;页面不自己算这些)。
 * 成员卡的信息不在这里:切分按 `topClipId` 到同一份 card plan 里取(那里有 cardId 与超体积标记)。
 */
export function queueStreamOf(spec) {
  return {
    streamKey: spec.streamKey, contentKey: spec.contentKey, topClipId: spec.topClipId,
    originFrame: spec.originFrame, firstSegment: spec.firstSegment, lastSegment: spec.lastSegment,
    kind: spec.kind, plane: spec.plane, clipIds: [...(spec.clipIds ?? [])], fps: spec.fps,
    bound: spec.bound ? { ...spec.bound } : null, offset: spec.offset ? { ...spec.offset } : null,
    firstFrame: spec.firstFrame, lastFrame: spec.lastFrame, total: spec.total,
    // 依赖下层的流另带算进键里的下层(切分据此知道这条流要整场景的下层和素材);别的流不带这一项,形状与原来相同
    ...(spec.kind === 'below' ? { belowClipIds: [...(spec.belowClipIds ?? [])] } : {}),
    // 单独成流的两类卡(`soloStreamKind`)带上是哪一类:切分据此不出浏览器那一份
    ...(spec.solo ? { solo: spec.solo } : {}),
  };
}

/**
 * 在线页面的清单计划用:只按清单里的片段算流(`picked` = 在清单里),不看本机判没判重、本机能不能产流 ——
 * 这些流只给浏览器出一份(`splitPlan` 的 `browserOnly`),切分方自己不产。回 `planStreams` 的结果;`clips` 是片段 id 的集合或数组。
 */
export function planListStreams(entry, clips, options = {}) {
  const listed = clips instanceof Set ? clips : new Set(Array.isArray(clips) ? clips : []);
  return planStreams(entry, { ...options, picked: clipId => listed.has(clipId) });
}

/**
 * 这条流的**隔离工程**(G4「单卡像素怎么隔离」:`isolatedCardProject` 的流版本)。
 *
 * 只留这条流的卡(单卡流一张、组流一组)可见;同一条序列上的其它片段和别的序列都变成
 * 隐藏的 `sourceOnly` 序列 —— 不出画,但图卡按源片段解输入时还找得到。**时间不平移**(隔离工程里
 * 片段还在它原来的时刻,产分段时按项目帧号推帧;分段号由 `originFrame` 换算);背景透明由导出页自己保证。
 *
 * 单卡流还要把包裹层外观拿掉(框摆到 `offset`、不缩放不旋转、不透明度 / 淡入淡出 / motion / 强调
 * 都去掉):这些在舞台上由包裹层加。组流原样保留(外观画进流里)。
 */
export function isolatedStreamProject(project, spec) {
  if (spec?.kind === 'below') return isolatedBelowProject(project, spec);
  const members = new Set(spec.clipIds);
  const ids = new Set((project.tracks ?? []).map(t => t.id));
  const tracks = [];
  for (const track of project.tracks ?? []) {
    const own = (track.clips ?? []).filter(c => members.has(c.id));
    if (!own.length) { tracks.push({ ...structuredClone(track), hidden: true, sourceOnly: true }); continue; }
    const clips = own.map(c => spec.plane === 'local' ? localClip(c, spec) : structuredClone(c));
    tracks.push({ ...structuredClone(track), hidden: false, sourceOnly: false, clips });
    const siblings = (track.clips ?? []).filter(c => !members.has(c.id));
    if (siblings.length) {
      let id = `__pc_source_${track.id}`, n = 1;
      while (ids.has(id)) id = `__pc_source_${track.id}_${n++}`;
      ids.add(id);
      tracks.push({ ...structuredClone(track), id, hidden: true, sourceOnly: true, clips: structuredClone(siblings) });
    }
  }
  return { ...structuredClone(project), tracks, _cardRender: { mode: 'final', frames: {}, missing: {} } };
}

function localClip(clip, spec) {
  const out = structuredClone(clip);
  delete out.motion; delete out.opacity; delete out.fadeIn; delete out.fadeOut; delete out.emphasis;
  const size = resolveFrameSize(clip.frame, spec.stage);
  // 框的左上角 = (x, y) − 锚点偏移;锚点取 [0,0] 就是 (x, y) 本身
  out.frame = clip.frame || spec.offset.x || spec.offset.y
    ? { x: spec.offset.x, y: spec.offset.y, w: size.w, h: size.h, anchor: [0, 0] }
    : undefined;
  if (out.frame === undefined) delete out.frame;
  return out;
}

/* ======================================================================== *
 * 依赖下层的流(`kind: 'below'`,`docs/plan/prerender-products-contract.md` 第 5.1、5.2 节)
 *
 * 这一节只有计划、键和隔离工程。流里的像素怎么取(第 5.3 节:差分取层)在 `./bakery/capture-below.mjs`,
 * 由 `StreamProducer.runSegment` 接上;怎么贴回舞台(第 5.4 节)在页面一侧(`src/render/Stage.tsx`、`streamPlayer.ts`)。
 * 出不出这种流由 `belowStreamsEnabled` 管,缺省开。
 * ======================================================================== */

/** 这一版里要出「依赖下层的流」的目标卡,按画家顺序。每项带它占解码器的那一段 `from..to`(同单卡流的算法) */
function belowTargets(plan, { picked, where, fps, total, orderOf, taken = null }) {
  const out = [];
  const seen = new Set();
  for (const control of plan) {
    if (!control?.clipId || seen.has(control.clipId) || taken?.has(control.clipId) || !picked(control.clipId)) continue;
    const at = where.get(control.clipId);
    if (!at || !belowStreamEligible(control, at.clip, at.track)) continue;
    const firstFrame = control.sampling?.firstFrame ?? Math.ceil(at.clip.start * fps - 1e-9);
    const lastFrame = Math.min(total - 1, firstFrame + control.count - 1);
    if (lastFrame < firstFrame) continue;
    seen.add(control.clipId);
    out.push({ control, clip: at.clip, order: orderOf.get(control.clipId) ?? 0, firstFrame, from: Math.min(mountFrameOf(at.clip, fps), firstFrame), to: lastFrame });
  }
  return out.sort((a, b) => a.order - b.order);
}

/**
 * 一层的缓存内容键(`control.cacheContentKey`)没管到、又会改这一层画面的项目数据;没有回 undefined(摘要里不出现这一项)。
 *
 * 现在只有一样:素材段挂的**像素映射**(`clip.pixelMap`、项目里那一条定义、定义里引用到的别的素材)。缓存内容键来自卡片图
 * (`src/kernel/cardGraph.mjs` 的 `projectCardGraph`),图里只把滤镜、音频效果、强调串成了节点,像素映射不在图里;
 * 不补这一项,改了下层素材的像素映射,依赖下层的流的键不变,旧流会被接着贴。
 */
export function belowLayerExtra(project, clip) {
  const ref = clip?.pixelMap;
  if (!ref) return undefined;
  const def = (project?.pixelMaps ?? []).find(x => x?.id === ref.id) ?? null;
  const ids = new Set();
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const [name, inner] of Object.entries(value)) {
      if (name === 'mediaId' && typeof inner === 'string' && inner) ids.add(inner);
      else walk(inner);
    }
  };
  walk(def);
  const media = [...ids].sort().map(id => {
    const m = (project?.media ?? []).find(x => x?.id === id);
    return [id, m ? (m.hash ?? m.url ?? m.path ?? null) : null];
  });
  return { pixelMap: ref, def, media };
}

/**
 * 每个目标卡一条**依赖下层的流**。`targets` 是 `belowTargets` 的结果;回的每一项形状照组流(舞台坐标,`plane: 'stage'`、
 * `offset` 是零、`bound` 是整个画面,收紧留给产流那一趟量),另外:
 *
 *   - `clipIds` 只有目标卡一张(这条流挂在它身上);`belowClipIds` 是算进键里的那些下层,按画家顺序(下面的在前);
 *   - 键:`cardStreamIdentity({ kind: 'below' })`。下层取 `belowLayersOf`(与页面的输入签名、与隔离工程同一份认定),每层用它在
 *     card plan 里的缓存内容键加采样窗口,再加 `belowLayerExtra`。有一层在 card plan 里找不到键(预渲染间不认识的卡)时,
 *     整条退回用整个项目的键 `entry.key`(`belowScene: true`;更粗,但不会错);连 `entry.key` 也没有就不出这条流;
 *   - `replay` / `mountFrame`:目标卡和下层里的卡片段(含挂着节点的素材效果卡片段)有一张是 motion 式的就要回放,从这些有状态的卡里最早的
 *     挂载帧起(在 card plan 里找不到的按有状态算)。纯素材段按时间直接取帧,不算;
 *   - `hasMedia`:项目里有没有画面素材(有的话产流那一趟截图前要等素材就位,`bakeStream` 的 `hasMedia`;
 *     藏起来的源片段也算,素材效果卡可能接着它们)。
 */
function belowStreamSpecs(entry, targets, { fps, stage, total, codeVersion, envFingerprint }) {
  const project = entry.project;
  const controlOf = new Map();
  for (const control of entry.cardPlan ?? []) if (control?.clipId && !controlOf.has(control.clipId)) controlOf.set(control.clipId, control);
  const visualMedia = new Set((project.media ?? []).filter(m => m && m.kind !== 'audio').map(m => m.id));
  const hasMedia = (project.tracks ?? []).some(track => (track.clips ?? []).some(c => c?.mediaId && visualMedia.has(c.mediaId)));
  const view = { x: 0, y: 0, w: stage.width, h: stage.height };
  const specs = [];
  for (const target of targets) {
    const { control, clip } = target;
    const found = belowLayersOf(project, control.clipId);
    const targetKey = control.cacheContentKey ?? control.key;
    if (!found || typeof targetKey !== 'string' || !targetKey) continue;
    const layers = [];
    let whole = false;
    for (const layer of found.below) {
      const lower = controlOf.get(layer.id);
      const key = lower?.cacheContentKey ?? lower?.key;
      if (typeof key !== 'string' || !key) { whole = true; break; }
      layers.push({ key, sampling: lower.sampling, count: lower.count, extra: belowLayerExtra(project, layer.clip) });
    }
    if (whole && (typeof entry.key !== 'string' || !entry.key)) continue;
    const contentKey = cardStreamIdentity({ kind: 'below', fps, stage, codeVersion,
      members: [{ key: targetKey, sampling: control.sampling, count: control.count, extra: belowLayerExtra(project, clip) }],
      below: whole ? { scene: entry.key } : { layers } });
    let mountFrame = target.from;
    const stateful = [control];
    for (const layer of found.below) {
      if (!layer.clip.cardId && !layer.clip.nodeId) continue;
      const lower = controlOf.get(layer.id) ?? null;
      stateful.push(lower);
      if (streamNeedsReplay([lower])) mountFrame = Math.min(mountFrame, mountFrameOf(layer.clip, fps));
    }
    specs.push({
      clipIds: [control.clipId], topClipId: control.clipId, mountFrame,
      firstFrame: target.firstFrame, lastFrame: target.to,
      ...streamSegmentSpan(target.firstFrame, target.to),
      fps, stage, total,
      replay: streamNeedsReplay(stateful),
      streamKey: resultKeyOf(contentKey, envFingerprint), contentKey, envFingerprint,
      kind: 'below', plane: 'stage', offset: { x: 0, y: 0 }, bound: evenRect(view, view),
      members: [control],
      belowClipIds: found.below.map(layer => layer.id), belowScene: whole, hasMedia,
      // 这一版项目里这条流的输入签名:发层时带给页面(`StreamProducer.publish`),页面按自己手里的项目算同一个签名,
      // 对不上就是下层已经改过、预渲染进程还没换版本的那一小段 —— 旧流不贴(`src/editor/snapshotFeed.ts`)。算不出不带
      inputSig: streamInputSig(project, { clipIds: [control.clipId], kind: 'below' }),
    });
  }
  return specs;
}

/**
 * 依赖下层的流发给页面的那一层(就绪索引的 `layer`,`kind: 'stream'`)另带的两项;别的流回空对象,发出去的层一个字不变。
 *
 *   - `streamKind: 'below'`:页面据此把这条流的平面挂在舞台根下、按舞台坐标贴(契约第 5.4 节),不挂进包裹层;
 *   - `inputSig`:产这条流的那一版项目的输入签名(`belowStreamSpecs` 算的)。只给这条流自己的目标卡;算不出不带(页面不比)。
 */
export function belowLayerMark(spec, clipId) {
  if (spec?.kind !== 'below') return {};
  const sig = clipId === spec.topClipId && typeof spec.inputSig === 'string' && spec.inputSig ? { inputSig: spec.inputSig } : {};
  return { streamKind: 'below', ...sig };
}

/**
 * 依赖下层的流的**隔离工程**(契约第 5.3 节头一段):留着目标卡和画家顺序排在它下面的全部层,只把上面的层藏起来。
 * `isolatedStreamProject` 遇到 `kind: 'below'` 的流走这里;单卡流、组流那一种(非成员全藏)不变。
 *
 *   - 目标卡上面的序列:整条变成隐藏的 `sourceOnly` 序列(不出画,素材效果卡按源片段解输入时还找得到);
 *   - 目标卡所在的序列:它前面的片段(画家顺序在它下面)和它自己留着,它后面的片段挪到一条隐藏的 `sourceOnly` 序列里;
 *   - 目标卡下面的序列:原样(本来隐藏的照旧隐藏),卡片、素材、它们的外观都不动;
 *   - 目标卡的外观原样保留(这种流按舞台坐标产,外观画进流里);时间不平移。
 * 「上面 / 下面」和流键、输入签名用的是同一个画家顺序(`src/render/streamInputSig.mjs` 的 `belowLayersOf`)。
 *
 * `withTarget: false`:连目标卡也藏起来(挪进那条隐藏的序列),只剩下层 —— 差分取层要的那一张「不带目标卡」的画面。
 */
export function isolatedBelowProject(project, spec, { withTarget = true } = {}) {
  const targetId = spec?.topClipId ?? spec?.clipIds?.[0];
  const source = project.tracks ?? [];
  let ti = -1, ci = -1;
  source.forEach((track, i) => (track.clips ?? []).forEach((clip, j) => { if (ti < 0 && clip.id === targetId) { ti = i; ci = j; } }));
  if (ti < 0) throw new Error(`隔离工程:项目里没有片段 ${targetId}`);
  const ids = new Set(source.map(t => t.id));
  const tracks = [];
  source.forEach((track, i) => {
    if (i < ti) { tracks.push({ ...structuredClone(track), hidden: true, sourceOnly: true }); return; }
    if (i > ti) { tracks.push(structuredClone(track)); return; }
    const clips = track.clips ?? [];
    const kept = clips.filter((_, j) => j < ci || (j === ci && withTarget));
    const hiddenClips = clips.filter((_, j) => j > ci || (j === ci && !withTarget));
    tracks.push({ ...structuredClone(track), hidden: false, sourceOnly: false, clips: structuredClone(kept) });
    if (hiddenClips.length) {
      let id = `__pc_source_${track.id}`, n = 1;
      while (ids.has(id)) id = `__pc_source_${track.id}_${n++}`;
      ids.add(id);
      tracks.push({ ...structuredClone(track), id, hidden: true, sourceOnly: true, clips: structuredClone(hiddenClips) });
    }
  });
  return { ...structuredClone(project), tracks, _cardRender: { mode: 'final', frames: {}, missing: {} } };
}

/* ======================================================================== *
 * 流库
 * ======================================================================== */

const KEY_RE = /^[a-f0-9]{64}$/;
const INIT_RE = /^[a-f0-9]{16}$/;
const SEG_RE = /^(\d{1,7})-([a-f0-9]{16})\.m4s$/;

/** 编码参数的哈希(分段签名的一部分,G2)。滤镜链按它的身份算(`streamFilterIdentity`),等价改写不作废已有分段 */
export function encoderParamsHash(encoder) {
  const spec = STREAM_ENCODERS[encoder];
  return sha(JSON.stringify({ args: spec?.args ?? null, filter: streamFilterIdentity(spec?.pixFmt) }), 16);
}

/**
 * 分段签名 = 流签名 + 分段号 + stride + 编码器名 + 编码参数哈希(G2),再加上矩形(变体)。
 * 分段号是这条流自己的(从它的第一帧起数),签名里没有项目帧号:流在时间轴上的位置只经流键进来。
 */
export function segmentSignature({ streamKey, segment, stride, encoder, rect }) {
  return sha(JSON.stringify({ streamKey, segment, stride, encoder, params: encoderParamsHash(encoder), rect }), 32);
}

/**
 * C6.2:校验一份任务清单 `StreamResult`(`artifact-transfer-contract.md` 第 3 节),整理成 `adoptSegments`
 * 要的形状 `{ key, range, header, inits, segments: [[n, seg]…] }`。不认识的字段忽略;格式不对就抛。
 */
export function streamAdoption(result) {
  const bad = why => { throw Object.assign(new Error(`轨道流清单不对:${why}`), { retryable: false }); };
  if (!result || typeof result !== 'object') bad('不是对象');
  if (result.v !== 1) bad(`v = ${result.v}`);
  if (result.kind !== 'stream') bad(`kind = ${result.kind}`);
  const key = result.resultKey;
  if (!KEY_RE.test(String(key))) bad('resultKey');
  const from = result.range?.from, to = result.range?.to;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) bad('range');
  const header = result.header;
  if (!header || typeof header !== 'object' || !Array.isArray(header.clipIds)) bad('header');
  // 分段号从这条流自己的第一帧起数:清单不带这一帧的(改分段规则之前的节点产的)不收,免得把按项目帧号分的段当成新的贴
  if (!isStreamOrigin(header.originFrame)) bad('header.originFrame');
  const inits = {};
  for (const [id, meta] of Object.entries(result.inits ?? {})) {
    if (!INIT_RE.test(id) || !KEY_RE.test(String(meta?.hash)) || meta.hash.slice(0, 16) !== id) bad(`init ${id}`);
    inits[id] = meta;
  }
  const segments = [];
  for (const [name, seg] of Object.entries(result.segments ?? {})) {
    const n = Number(name);
    if (!Number.isInteger(n) || String(n) !== name || n < from || n > to) bad(`分段 ${name}`);
    if (!KEY_RE.test(String(seg?.hash)) || !INIT_RE.test(String(seg?.init))) bad(`分段 ${name}`);
    if (!Number.isInteger(seg.stride) || seg.stride < 1 || !Number.isInteger(seg.samples) || seg.samples < 1) bad(`分段 ${name}`);
    segments.push([n, seg]);
  }
  segments.sort((a, b) => a[0] - b[0]);
  return { key, range: { from, to }, header, inits, segments };
}

/**
 * 清单里记的第一帧跟上这一版计划的(`spec.originFrame`),回同一个清单对象。
 *
 * 清单的 `originFrame` 记的是「产这条流时它的第一帧在项目的第几帧」。现在流键里带着片段在时间轴上的位置,同一个键的清单
 * 这一项不会和计划对不上,这里什么都不改。留着这一步是给「片段在时间轴上挪动以后流不失效」(记了待办,这次不做)用的:
 * 那时位置从流键和输入签名里拿掉,同一条流会被摆到别的帧上,清单里的旧位置就由这里换成当前的;读的一侧本来就不从清单取这一帧
 * (取的是就绪消息 / 层表那一行带的,由计划的一侧按当前项目给),所以分段和清单的格式都不用再动。
 */
export function anchorManifest(manifest, spec) {
  if (manifest && isStreamOrigin(spec?.originFrame) && manifest.originFrame !== spec.originFrame) manifest.originFrame = spec.originFrame;
  return manifest;
}

/* ======================================================================== *
 * 生产调度(G4)
 * ======================================================================== */

/**
 * 预渲染进程里的轨道流生产者。一个 `FramePipeline` 一个。
 *
 *   - **只在机器空闲时生产**(G0-b 结论 1):`pipeline.streamBusy()` 为真(用户在播放 / 刚拖过播放头 /
 *     legacy 播放热池在用)时每 250 ms 看一次,不开新分段;
 *   - **`streamPool` 个会话**,缺省 1、最多 2,按实测自适应(带编码器的每帧耗时超过空闲时的 2 倍就不再加);
 *     会话经 `pipeline.leaseStreamBakery()` / `returnStreamBakery()` 拿,不经 `acquireUser`、不进 `laneChains`;
 *   - **先稀疏后补密**:所有流的稀疏版(每个分段只截第一帧)都铺满,才开始用满密度分段替换;
 *   - 每个 worker 在流之间按「离播放头最近的未就绪分段」轮转,**但优先延续自己的租约**(`planStreamSegments`);
 *   - **同时存活的分段编码器 ≤ 2 × streamPool**(双缓冲)。
 */
export class StreamProducer {
  constructor(pipeline, { env = process.env, ownership = null, projectAccess = null } = {}) {
    this.ownership = ownership;
    this.pipeline = pipeline;
    this.enabled = streamsEnabled(env);
    this.budget = streamDecoderBudget(env);
    this.poolLimit = streamPoolLimit(env);
    this.pool = this.poolLimit.fixed ?? STREAM_POOL_DEFAULT;
    this.store = new StreamStore(path.join(pipeline.root, 'streams'), { ownership, projectAccess });
    /** 画布卡的流走不走画布直取:`auto`(缺省)/ `always`(过了实测就走,不管快慢)/ `off`;见 `directOf` */
    this.direct = directCaptureMode(env);
    this.streams = new Map();
    this.workers = new Set();
    this.encoding = new Set();
    this.aliveEncoders = 0;
    this.encoderWaiters = [];
    this.generation = 0;
    this.closed = false;
    this.measure = { idle: [], busy: [] };
    this.stats = { segments: 0, resets: 0, replayedFrames: 0, replacedDeleted: 0, failures: 0, maxAliveEncoders: 0, setFrameWindowCalls: 0 };
    this.log = [];
    /**
     * 分段字节的读口接上了没有(`attachRoute()`,由挂 `/api/frames/*` 的那一处在建 `FramePipeline` 时调)。
     *
     * **没接上就什么都不产、一条 `stream` 层都不发。** 理由:页面拿到 `stream` 层却取不到字节时,
     * 现在的父页(`src/editor/snapshotFeed.ts`)会把 `stream` 层当成快照去取 ——
     * `/api/frames/snapshot/stream/…` 在预渲染进程上落到 SPA 兜底、回一整页 `index.html`(200,实测),
     * 于是重卡在暂停 / 拖动时贴上一整张应用页面。读口和父页那一侧要一起接(见报告里的补丁),
     * 这道闸保证只接了一半时行为和 R7 一样。
     */
    this.routeAttached = false;
  }

  /** 读口接上了:从现在起生产、发层(见 `routeAttached`) */
  attachRoute() {
    if (this.routeAttached) return;
    this.routeAttached = true;
    this.note('分段读口已接上');
    if (this.pendingEntry) { const entry = this.pendingEntry; this.pendingEntry = null; void this.update(entry).catch(() => {}); }
  }

  /** 读口:`handleStreamRequest` 按本生产者的流库答 */
  handle(req, res, pathname) {
    return handleStreamRequest(this.store, req, res, pathname);
  }

  /** 诊断口(`/api/frames/diagnostics`):每条流的分段表(G4 的 `status()`) */
  status() {
    return {
      enabled: this.enabled, routeAttached: this.routeAttached, pool: this.pool, budget: this.budget, encoder: this.encoderName ?? null,
      stats: { ...this.stats, aliveEncoders: this.aliveEncoders },
      streams: [...this.streams.values()].map(state => ({
        streamKey: state.spec.streamKey, contentKey: state.spec.contentKey, kind: state.spec.kind, clipIds: state.spec.clipIds,
        ...(state.spec.solo ? { solo: state.spec.solo } : {}),
        originFrame: state.spec.originFrame ?? null, firstSegment: state.spec.firstSegment, lastSegment: state.spec.lastSegment,
        bound: state.spec.bound, tight: state.manifest?.tight ?? null, resets: state.resets ?? null,
        replay: state.spec.replay !== false, replayedFrames: state.replayedFrames ?? 0,
        direct: state.direct ? { ...state.direct } : null, capture: state.capture ? { ...state.capture } : null,
        below: state.below ? { ...state.below } : null,
        segments: Object.fromEntries(Object.entries(state.manifest?.segments ?? {}).map(([n, s]) => [n, { stride: s.stride, init: s.init, bytes: s.bytes, encodeMs: s.encodeMs, tailMs: s.tailMs,
          ...(s.box !== undefined ? { box: s.box } : {}), at: s.at ?? null }])),
        inits: Object.keys(state.manifest?.inits ?? {}),
      })),
      log: this.log.slice(-40),
    };
  }

  note(message) {
    this.log.push({ at: Date.now(), message });
    while (this.log.length > 200) this.log.shift();
  }

  /** 编码器(`probeEncoders` 真编一小段之后定;一次进程只探一次) */
  async encoder() {
    if (this.encoderName) return this.encoderName;
    this.ffmpeg ||= await findFfmpeg();
    const { encoder } = await pickStreamEncoder(this.ffmpeg);
    this.encoderName = encoder;
    this.note(`编码器:${encoder}`);
    return encoder;
  }

  /* ---------------------------------------------------------------------- *
   * X1:轨道流走队列(`docs/plan/m6c-contract.md` X1)
   *
   * 队列模式下,流的分段由渲染任务队列的细任务产(`kind: 'stream'`,每任务 `STREAM_SEGMENTS` 个分段):
   * 认领到任务的节点经执行器调 `produceRange`,在这里按段产出满密度分段、落盘、发层。本机的自动生产
   * (`runWorker`)跳过归队列的流(`queueOwned`),否则所有任务都会走去重。
   *
   * 编码器只进分段签名与清单(`segmentSignature`、`inits[].encoder`),不进流键:流键 = 内容键 × 环境指纹
   * (`planStreams`),所以不同编码器的节点产的是同一个键下的分段,取用方照清单收(`adoptSegments`)。
   * ---------------------------------------------------------------------- */

  /**
   * 本机能不能产轨道流(`node.hello` 的 `capabilities.streams`):开关关着(`PROMPTCUT_STREAMS=0`)回 false;
   * 开着就探一次编码器(与 `runWorker` 同一个 `encoder()`,一次进程只探一次),探不到回 false,
   * 并照 `runWorker` 的做法把生产者关掉。
   */
  async capable() {
    if (!this.enabled || this.closed) return false;
    try {
      await this.encoder();
      return true;
    } catch (error) {
      this.enabled = false;
      this.note(`没有能用的 H.264 编码器,轨道流关闭:${error?.message || error}`);
      return false;
    }
  }

  /**
   * 这条流归不归队列产:只为队列任务建的(`queueOnly`),或它所属的 entry 在队列模式(`queueSnapshots`,
   * 队列模式的 `/preload` 设,连不上文档服务时 `leaveQueueMode` 清掉 —— 这里现读,清掉后自动生产立即接手)。
   */
  queueOwned(state) {
    if (state?.queueOnly === true) return true;
    const key = state?.entryKey ?? this.entryKey;
    const entry = key ? this.pipeline.entries?.get?.(key) : null;
    // 集成裁定(m6c-contract「集成时的裁定」X1 空档):切这一版 plan 的节点没切出流任务(它关着流),
    // `FramePipeline.releaseQueueStreams` 把这一版的流交还本机自动生产,快照照旧走队列
    return entry?.queueSnapshots === true && entry.queueStreamsLocal !== true;
  }

  /**
   * 队列任务要产的这条流在生产者里的 state:手里有(自动生产那边的,或别的任务建的)就用它 —— 一个流键只能有
   * 一个 state,否则两份内存里的清单会互相覆盖 `stream.json`;没有(独立渲染主机、还没 preload 到这一版、
   * 或只是拉来的 `adoptedOnly`)就按 `spec` 建一个 `queueOnly` 的:有隔离工程、能发层,但自动生产不碰它。
   */
  async queueState(entry, spec) {
    const usable = state => state && !state.adoptedOnly;
    let state = this.streams.get(spec.streamKey);
    if (!usable(state)) {
      const manifest = state?.manifest ?? (await this.store.load(spec.streamKey)) ?? this.freshManifest(spec);
      state = this.streams.get(spec.streamKey);
      if (!usable(state)) {
        const base = state ?? { reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set() };
        delete base.adoptedOnly;
        base.queueOnly = true;
        base.spec = spec;
        base.manifest = anchorManifest(base.manifest ?? manifest, spec);
        base.aliases ||= new Set();
        base.generation = this.generation;
        base.entryKey = entry.key;
        state = base;
        this.streams.set(spec.streamKey, state);
      }
    }
    state.isolated ||= isolatedStreamProject(entry.project, spec);
    return state;
  }

  /**
   * 队列的流任务:按段产出 `[from, to]` 这几个分段,每段等编码收尾、落盘、发层
   * (`storeSegment`,C6.4 的推送钩子照常)之后才算完。`density: 'sparse'` 是稀疏流任务(`SPARSE_STRIDE`,每个分段只截第一帧):
   * 这一段已经有稀疏的或满密度的就跳过;不给是满密度任务(`stride = 1`):已经是满密度而且不旧的分段跳过。自动生产那边正在做的
   * (`reserved`)等它做完。一个分段连续 `QUEUE_SEGMENT_ATTEMPTS` 次没产成抛可重试的错误。
   * 预渲染间与自动生产共用 `leaseStreamBakery` 的池,整段只借一次:相邻分段接着租约推,不重灌工程。
   * `progress(done)`:这一段里已经就绪的帧数(每个分段按它实际的帧数,流的末段可以不满 15 帧)。回 `{ produced, skipped }`。
   */
  async produceRange(entry, spec, range, { signal, progress, density = null } = {}) {
    const sparse = density === 'sparse';
    const stride = sparse ? SPARSE_STRIDE : 1;
    /** 这一段还要不要产:稀疏任务只补一张都没有的(和签名对不上的),满密度任务补到满密度为止 */
    const pending = (state, n) => { const s = this.segmentState(state, n); return sparse ? (s === 'none' || s === 'stale') : s !== 'dense'; };
    const cancelled = () => Object.assign(new Error('Queue task cancelled'), { cancelled: true });
    if (!this.enabled || this.closed) throw Object.assign(new Error('本机的轨道流关着'), { code: 'streams-disabled', retryable: false });
    if (!this.routeAttached) throw Object.assign(new Error('轨道流的分段读口还没接上'), { code: 'streams-not-ready', retryable: true });
    if (!(await this.capable())) throw Object.assign(new Error('本机没有能用的 H.264 编码器'), { code: 'no-stream-encoder', retryable: false });
    const from = Math.max(range.from, spec.firstSegment), to = Math.min(range.to, spec.lastSegment);
    const state = await this.queueState(entry, spec);
    state.queueHolds = (state.queueHolds ?? 0) + 1;
    let bakery = null, produced = 0, skipped = 0, frames = 0;
    const report = () => { try { progress?.(frames); } catch { /* 进度回调出错不影响生产 */ } };
    try {
      for (let n = from; n <= to; n++) {
        let attempts = 0, made = false;
        while (pending(state, n)) {
          if (signal?.aborted || this.closed) throw cancelled();
          // 差分取层实测没过的流(`belowSegmentCapture`):这张卡的这种流产不出来,换一台同样的节点也一样,不重试
          if (state.below?.failed) throw Object.assign(new Error(`流 ${spec.streamKey.slice(0, 8)} 的差分取层没过(${state.below.failed})`), { code: 'below-capture-failed', retryable: false });
          if (state.reserved.has(n)) { await sleep(50); continue; }
          if (attempts++ >= QUEUE_SEGMENT_ATTEMPTS) {
            throw Object.assign(new Error(`流 ${spec.streamKey.slice(0, 8)} 分段 ${n} 连续 ${QUEUE_SEGMENT_ATTEMPTS} 次没产成`), { code: 'stream-segment-failed', retryable: true });
          }
          const task = { state, segment: n, stride, queue: { signal } };
          state.reserved.add(n);
          let handedOff = false;
          try {
            bakery ||= await this.pipeline.leaseStreamBakery();
            handedOff = await this.runSegment(bakery, task);
          } catch (error) {
            if (signal?.aborted || this.closed) throw cancelled();
            // 收紧矩形要重量、重产的那几趟(`runSegment` 标 `cancelled`,次数有上界:四条边各一次)不算一次没产成
            if (error?.cancelled) attempts = Math.max(0, attempts - 1);
            if (!error?.cancelled) {
              this.stats.failures++;
              state.failures.set(n, (state.failures.get(n) ?? 0) + 1);
              this.note(`队列分段 ${spec.streamKey.slice(0, 8)}#${n} 失败:${error?.message || error}`);
              // 会话可能已经坏了:换一个新的(同 `runWorker`)
              if (bakery) { this.pipeline.returnStreamBakery(bakery, { dead: true }); bakery = null; }
            }
          } finally {
            if (!handedOff) state.reserved.delete(n);
          }
          // 编码在后台收尾(`storeSegment`),等它落盘;它自己吞掉异常,失败就在这一轮 while 里重来
          if (handedOff) { await task.job; made = true; }
        }
        if (made) produced++; else skipped++;
        frames += streamSegmentFrameCount(n, spec.originFrame, spec.lastFrame);
        report();
      }
    } finally {
      state.queueHolds = Math.max(0, (state.queueHolds ?? 1) - 1);
      if (bakery) this.pipeline.returnStreamBakery(bakery);
    }
    if (signal?.aborted) throw cancelled();
    return { produced, skipped };
  }

  /**
   * 导出专用的逐帧位图(`./export-frames.mjs`;在线浏览器导出时本页不执行的卡的画面):把 `[from, to]` 这几个分段盖住的每一帧
   * 按这条流的矩形上界取一张,逐张交给 `onFrame(frame, shot)`(`shot` 是 PNG,或 `{ rgba, width, height }`),不压成视频、不进流库。
   * 推帧、隔离工程、差分取层都是 `runSegment` 那一套(同一份代码),所以画面和这张卡的轨道流的满密度分段压缩之前逐像素相同。
   * `spec` 是 `exportSpecOf` 的结果。这一种的状态不登记进 `streams`(预览不读它),按导出的结果键另记,租约的签名也用它,
   * 不会和同一张卡的轨道流接上同一份租约。一个分段连续 `QUEUE_SEGMENT_ATTEMPTS` 次没取成抛可重试的错误。
   */
  async produceExportRange(entry, spec, range, { signal, progress, onFrame } = {}) {
    const cancelled = () => Object.assign(new Error('Queue task cancelled'), { cancelled: true });
    if (this.closed) throw cancelled();
    if (typeof onFrame !== 'function') throw new Error('produceExportRange 要 onFrame');
    const key = spec.exportResultKey;
    this.exportStates ||= new Map();
    let state = this.exportStates.get(key);
    if (!state) {
      const own = { ...spec, streamKey: key };
      state = { spec: own, manifest: this.freshManifest(own), isolated: isolatedStreamProject(entry.project, spec), reserved: new Set(), failures: new Map(), exportOnly: true };
      this.exportStates.set(key, state);
      while (this.exportStates.size > 16) this.exportStates.delete(this.exportStates.keys().next().value);
    }
    const from = Math.max(range.from, 0), to = Math.min(range.to, spec.lastSegment);
    let bakery = null, frames = 0;
    try {
      for (let n = from; n <= to; n++) {
        for (let attempts = 0; ;) {
          if (signal?.aborted || this.closed) throw cancelled();
          if (state.below?.failed) throw Object.assign(new Error(`导出位图 ${key.slice(0, 8)} 的差分取层没过(${state.below.failed})`), { code: 'below-capture-failed', retryable: false });
          try {
            bakery ||= await this.pipeline.leaseStreamBakery();
            await this.runSegment(bakery, { state, segment: n, stride: 1, queue: { signal }, exportSink: onFrame });
            break;
          } catch (error) {
            if (signal?.aborted || this.closed) throw cancelled();
            if (error?.retryable === false) throw error;
            this.stats.failures++;
            this.note(`导出位图 ${key.slice(0, 8)}#${n} 失败:${error?.message || error}`);
            if (bakery) { this.pipeline.returnStreamBakery(bakery, { dead: true }); bakery = null; }
            if (++attempts >= QUEUE_SEGMENT_ATTEMPTS) {
              throw Object.assign(new Error(`导出位图 ${key.slice(0, 8)} 分段 ${n} 连续 ${QUEUE_SEGMENT_ATTEMPTS} 次没取成:${error?.message || error}`), { code: 'export-frames-failed', retryable: true });
            }
          }
        }
        frames += streamSegmentFrameCount(n, spec.originFrame, spec.lastFrame);
        try { progress?.(frames); } catch { /* 进度回调出错不影响生产 */ }
      }
    } finally {
      if (bakery) this.pipeline.returnStreamBakery(bakery);
    }
    if (signal?.aborted) throw cancelled();
    return { frames };
  }

  /**
   * 新的一版项目 / card plan(`preload` 在锚帧就绪之后调)。重算期望的流(G6:`localRev` 变了
   * 重算受影响流的期望签名),读回盘上已有的分段、发 `layer`,再把 worker 叫起来。
   */
  async update(entry) {
    if (!this.enabled || this.closed || !entry) return [];
    if (!this.routeAttached) { this.pendingEntry = entry; return []; }
    const specs = planStreams(entry, {
      // c10a 契约第 17 节:补渲进集合的片段不产流(`streamPicked`);旧的管线替身没有它时退回 `prerenderPicked`
      picked: clipId => (this.pipeline.streamPicked ?? this.pipeline.prerenderPicked).call(this.pipeline, entry, clipId),
      budget: this.budget,
      codeVersion: `${STREAM_CODE_VERSION}:${this.pipeline.captureCode?.() || ''}`,
      // M4:流键乘本进程预渲染 Chrome 的环境指纹(还没定下来时为 null,planStreams 回 [])
      envFingerprint: this.pipeline.envFingerprint,
    });
    const generation = ++this.generation;
    // 先把要读盘的清单都读回来(这一段会让出事件循环),再**同步**改状态:两次 update 交错时,
    // 旧的那次读完发现自己已经不是最新一代就整个作废,不去改新一代共用的 state(Item 4 审查 #5)
    const loaded = new Map();
    for (const spec of specs) {
      if (loaded.has(spec.streamKey) || this.streams.get(spec.streamKey)?.manifest) continue;
      loaded.set(spec.streamKey, await this.store.load(spec.streamKey));
      if (generation !== this.generation) return specs;
    }
    if (generation !== this.generation || this.closed) return specs;
    this.entryKey = entry.key;
    const next = new Map();
    for (const spec of specs) {
      // 同一张卡、同参数同入点的两个片段(比如复制出来叠在两条序列上)内容逐像素相同,共用一条流
      if (next.has(spec.streamKey)) { next.get(spec.streamKey).aliases.add(spec.topClipId); continue; }
      const old = this.streams.get(spec.streamKey);
      const manifest = old?.manifest ?? loaded.get(spec.streamKey) ?? this.freshManifest(spec);
      const state = old ?? { reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set() };
      // C6.2:拉取时新建的流(`adoptSegments`)进了这一版的计划,从此是正常的流(照常补产、发层、认领)
      delete state.adoptedOnly;
      // X1:只为队列任务建的流进了这一版的计划:归不归队列改由这一版 entry 的模式定(`queueOwned`)
      delete state.queueOnly;
      state.spec = spec;
      state.aliases = new Set();
      state.manifest = anchorManifest(manifest, spec);
      state.isolated = isolatedStreamProject(entry.project, spec);
      state.generation = generation;
      // Item 4:这条流的层只发给当前版本正是这个 entry 的会话
      state.entryKey = entry.key;
      next.set(spec.streamKey, state);
    }
    // X1:队列任务正在产的流(`queueHolds > 0`)不在这一版的计划里也留着 —— 流键是内容寻址的,
    // 产完照样有效;换掉它会让在跑的队列任务的分段作废
    for (const [key, state] of this.streams) if (!next.has(key) && (state.queueHolds ?? 0) > 0) next.set(key, state);
    this.streams = next;
    if (generation !== this.generation) return specs;
    this.republish();
    this.kick();
    return specs;
  }

  freshManifest(spec) {
    return { version: STREAM_CODE_VERSION, streamKey: spec.streamKey, kind: spec.kind, plane: spec.plane, clipIds: spec.clipIds,
      fps: spec.fps, originFrame: spec.originFrame, bound: spec.bound, offset: spec.offset, tight: null, inits: {}, segments: {} };
  }

  /**
   * 把每条流此刻的就绪分段发成 C3 的 `layer`(`kind: 'stream'`,单位是分段号;带这条流的第一帧 `originFrame`,
   * 页面按它把项目帧号换成分段号;组流带 `groupClipIds`,挂在组里最上面那张卡上)。同时挂到 `stageByKey` 上 —— 会话换版本时先清表,之后靠认领把它补回来。
   * 发层过 Item 4 的闸:只进当前版本是这条流所属 entry(`state.entryKey`)的会话。
   */
  republish() {
    if (!this.routeAttached) return;
    for (const state of this.streams.values()) this.publish(state);
  }

  publish(state) {
    const ranges = readySegmentRanges(state.manifest);
    if (!ranges.length) return;
    const { spec } = state;
    const ready = this.pipeline.ready;
    try {
      ready.stageByKey({ kind: 'stream', key: spec.streamKey, ranges });
      // C6.2:只是拉来、还不属于任何一版的流(`adoptedOnly`)不知道该发给哪个会话 —— 只挂在键上,
      // 等它进了某一版的计划(`update` 接手这个 state)再照常发层
      if (state.adoptedOnly) return;
      const entryKey = state.entryKey ?? this.entryKey;
      for (const clipId of [spec.topClipId, ...(state.aliases ?? [])]) {
        ready.publish(entryKey, { clipId, kind: 'stream', key: spec.streamKey, ranges, ...(isStreamOrigin(spec.originFrame) ? { originFrame: spec.originFrame } : {}),
          ...(spec.kind === 'group' ? { groupClipIds: spec.clipIds } : {}), ...belowLayerMark(spec, clipId) });
      }
    } catch {}
  }

  /** 这一段现在是什么状态:没有 / 签名对不上 / 稀疏 / 满密度 */
  segmentState(state, n) {
    const seg = state.manifest?.segments?.[n];
    if (!seg) return 'none';
    // C6.2(契约第 6 节):别的节点产、拉进来的分段不按本机的编码器名重算签名 —— 指纹相同、编码器名不同的
    // 机器会把它判旧重渲。清单就在这条流的目录里(流键 = 内容键 × 指纹),流键没变就是内容没变,算新鲜
    if (seg.adopted === true && state.manifest.streamKey === state.spec?.streamKey) return seg.stride > 1 ? 'sparse' : 'dense';
    const expectStride = seg.stride > 1 ? seg.stride : 1;
    const rect = expectStride > 1 ? state.manifest.bound : (state.manifest.tight ?? state.manifest.bound);
    const sig = this.encoderName ? segmentSignature({ streamKey: state.spec.streamKey, segment: n, stride: expectStride, encoder: this.encoderName, rect }) : seg.sig;
    if (seg.sig !== sig) return 'stale';
    return seg.stride > 1 ? 'sparse' : 'dense';
  }

  /**
   * 别处产的这个分段(`seg`,清单里的那一项)本机要不要收:本机没有、已判旧,或者本机只有稀疏版而对方是满密度的(升上去)。
   * 本机已经是满密度的、或者两边都是稀疏的,不收。
   */
  adoptable(state, n, seg) {
    if (!state?.manifest?.segments?.[n]) return true;
    const mine = this.segmentState(state, n);
    if (mine === 'stale' || mine === 'none') return true;
    return mine === 'sparse' && !(Number(seg?.stride) > 1);
  }

  /** 还要不要做稀疏那一趟(整条流有没有哪一段连稀疏的都没有) */
  needsSparse(state, n) { return this.segmentState(state, n) === 'none'; }
  needsDense(state, n) { const s = this.segmentState(state, n); return s !== 'dense'; }

  /** 这一刻的播放头(全局帧号)与是否在播,从镜像插件读 */
  playheadFrame(fps) {
    let head = null;
    try { head = this.pipeline.playhead?.(); } catch {}
    return { frame: Math.max(0, Math.round((Number(head?.t) || 0) * fps)), playing: !!head?.playing };
  }

  /**
   * 选下一件活:先稀疏后补密;同一 worker 优先延续自己的租约;否则挑离播放头最近的那条流。
   * 回 `{ state, segment, stride }` 或 null。
   */
  nextTask(bakery) {
    const lease = bakery?.streamLease && !bakery.streamLease.dirty ? bakery.streamLease : null;
    // 先稀疏后补密:还有哪一段连稀疏的都没有(含正在编的),就只做稀疏那一趟
    const sparsePhase = this.needsSparseAnywhere();
    for (const stride of sparsePhase ? [SPARSE_STRIDE] : [1]) {
      const need = stride > 1 ? (s, n) => this.needsSparse(s, n) : (s, n) => this.needsDense(s, n);
      let best = null;
      for (const state of this.streams.values()) {
        // C6.2:只是拉来的流没有隔离工程,本机不替它补产(进了某一版的计划之后才产)
        // X1:归队列产的流(`queueOwned`)也不自己产,由执行器按任务产(`produceRange`)
        if (state.adoptedOnly || this.queueOwned(state)) continue;
        const { spec } = state;
        const failures = state.failures;
        const ready = n => !need(state, n) || (failures.get(n) ?? 0) >= 3;
        const { frame, playing } = this.playheadFrame(spec.fps);
        // 租约停在某个分段的最后一帧上,才算「接得上下一段」
        const leaseSegment = lease && lease.streamSignature === spec.streamKey ? streamSegmentOf(lease.lastFrame, spec.originFrame) : null;
        const leaseLast = leaseSegment !== null && leaseSegment >= 0 && lease.lastFrame === streamSegmentLastFrame(leaseSegment, spec.originFrame, spec.lastFrame)
          ? leaseSegment : null;
        const pick = planStreamSegments({ playheadFrame: frame, originFrame: spec.originFrame, fps: spec.fps, rate: playing ? 1 : 0, stride,
          firstSegment: spec.firstSegment, lastSegment: spec.lastSegment, ready, reserved: state.reserved, leaseLastSegment: leaseLast });
        if (pick.segment === null) continue;
        if (pick.continues) return { state, segment: pick.segment, stride };
        const start = streamSegmentFirstFrame(pick.segment, spec.originFrame);
        const distance = start >= frame ? start - frame : (frame - start) + spec.total;
        if (!best || distance < best.distance) best = { state, segment: pick.segment, stride, distance };
      }
      if (best) return best;
    }
    return null;
  }

  needsSparseAnywhere() {
    for (const state of this.streams.values()) {
      if (state.adoptedOnly || this.queueOwned(state)) continue;
      for (let n = state.spec.firstSegment; n <= state.spec.lastSegment; n++) {
        if (this.needsSparse(state, n) && (state.failures.get(n) ?? 0) < 3) return true;
      }
    }
    return false;
  }

  /** 把 worker 叫起来(已经在跑的不重复起);最多 `pool` 个 */
  kick() {
    if (!this.enabled || this.closed || !this.routeAttached) return;
    while (this.workers.size < this.pool) {
      const worker = this.runWorker().catch(error => this.note(`worker 异常:${error?.message || error}`)).finally(() => this.workers.delete(worker));
      this.workers.add(worker);
      if (!this.hasWork()) break;
    }
  }

  hasWork() { return !!this.nextTask(null); }

  async runWorker() {
    let bakery = null;
    try {
      for (;;) {
        if (this.closed || !this.enabled) return;
        if (this.pipeline.streamBusy?.()) { await sleep(250); continue; }
        // 编码器要先定下来:分段签名里有它。一个能用的都没有就整个关掉(记一条诊断),不反复探
        try { await this.encoder(); } catch (error) {
          this.enabled = false;
          this.note(`没有能用的 H.264 编码器,轨道流关闭:${error?.message || error}`);
          return;
        }
        const task = this.nextTask(bakery);
        if (!task) return;
        task.state.reserved.add(task.segment);
        let handedOff = false;
        try {
          bakery ||= await this.pipeline.leaseStreamBakery();
          // 编码在后台收尾:预留要一直保持到分段落盘,否则同一段会被再挑一次
          handedOff = await this.runSegment(bakery, task);
        } catch (error) {
          if (error?.cancelled) { /* 被新版本或关闭掐掉:下一轮再说 */ }
          else {
            this.stats.failures++;
            task.state.failures.set(task.segment, (task.state.failures.get(task.segment) ?? 0) + 1);
            this.note(`分段 ${task.state.spec.streamKey.slice(0, 8)}#${task.segment} 失败:${error?.message || error}`);
            // 会话可能已经坏了(页面崩溃 / 协议超时):换一个新的
            if (bakery) { this.pipeline.returnStreamBakery(bakery, { dead: true }); bakery = null; }
          }
        } finally {
          if (!handedOff) task.state.reserved.delete(task.segment);
        }
        this.adaptPool();
      }
    } finally {
      if (bakery) this.pipeline.returnStreamBakery(bakery);
    }
  }

  /** 编码器槽位:同时存活 ≤ 2 × streamPool(G4) */
  async encoderSlot() {
    while (this.aliveEncoders >= 2 * this.pool) await new Promise(resolve => this.encoderWaiters.push(resolve));
    this.aliveEncoders++;
    this.stats.maxAliveEncoders = Math.max(this.stats.maxAliveEncoders, this.aliveEncoders);
  }
  releaseEncoderSlot() {
    this.aliveEncoders = Math.max(0, this.aliveEncoders - 1);
    const next = this.encoderWaiters.shift();
    next?.();
  }

  /**
   * 这条流走不走画布直取(`docs/plan/prerender-products-contract.md` 第 6.1 节第一道:登记)。回这条流的直取记录,不走回 null。
   * 只有单卡流、成员登记为画布卡(审阅表的 `canvasHeavy`)才走;组流、别的种类的流、实测没过的流照旧截图。
   * 第二道(产流时实测)和「直取快不快」都在 `directSegmentCapture` 里,每个分段的第一帧做。
   */
  directOf(state) {
    const { spec } = state;
    if (this.direct === 'off' || spec.kind !== 'card' || spec.members?.length !== 1 || spec.members[0]?.capabilities?.canvasHeavy !== true) return null;
    const record = state.direct ||= newDirectRecord();
    if (record.failed) return null;
    // 上一次试出来不比截图快:歇几个分段再试
    if (this.direct !== 'always' && record.cooldown > 0) { record.cooldown--; return null; }
    return record;
  }

  /**
   * 生产一个分段(G4:单个分段的生产是它自己的一个 run)。租约接得上就接着推,接不上就把这条流的
   * 隔离工程灌进会话、从挂载帧重放。出帧逐张喂给这个分段的编码器;编码在后台收尾(双缓冲)。
   *
   * 依赖下层的流(`kind: 'below'`)每一帧截两张、差分取层(`./bakery/capture-below.mjs`):隔离工程里留着下层,
   * 截图矩形恒为上界(整个画面,不随收紧变:毛玻璃要采样四周的下层),交给编码器的是裁到这一趟的矩形的那一层;
   * 项目里有画面素材时截图前等素材就位。别的两种流走的路和原来逐项相同。
   */
  async runSegment(bakery, task) {
    const { state, segment, stride } = task;
    const { spec } = state;
    const below = spec.kind === 'below';
    // 差分取层实测没过的流不再产(不白付一次重灌和回放);自动生产把它记成这个分段的一次失败,三次以后不再挑它
    if (below && state.below?.failed) throw Object.assign(new Error(`差分取层没过(${state.below.failed}),这条流不再产`), { code: 'below-capture-failed', retryable: false });
    // X1:队列任务产的分段(`task.queue`)不随版本作废 —— 流键是内容寻址的,换了一版而键没变,分段照样有效;
    // 只有任务被中止、生产者关了、这条流被换掉才作废。`generation: null` 让 `storeSegment` 不按版本判旧
    const queue = task.queue ?? null;
    const generation = queue ? null : state.generation;
    const fps = spec.fps;
    // 这个分段盖住的项目帧:从这条流自己的第一帧起数,末段到这条流的最后一帧为止(`streamSegments.mjs`)
    if (!isStreamOrigin(spec.originFrame)) throw Object.assign(new Error(`流 ${spec.streamKey.slice(0, 8)} 没有第一帧,产不了分段`), { retryable: false });
    const fromFrame = streamSegmentFirstFrame(segment, spec.originFrame);
    const toFrame = streamSegmentLastFrame(segment, spec.originFrame, spec.lastFrame);
    const samples = toFrame - fromFrame + 1;
    if (segment < 0 || samples < 1) throw Object.assign(new Error(`流 ${spec.streamKey.slice(0, 8)} 没有分段 ${segment}`), { retryable: false });
    // 导出专用的逐帧位图(`produceExportRange`):同一套推帧与取帧,帧不进编码器、交给 `exportSink`;恒按矩形上界取、不量不收紧、不走画布直取
    const exportSink = typeof task.exportSink === 'function' ? task.exportSink : null;
    const encoder = exportSink ? null : await this.encoder();
    const manifest = state.manifest;
    /*
     * 重量的一趟(`state.remeasure`):上一次补这个分段时画面顶到了收紧矩形的边。这一趟把顶到的那几边放到上界、每一帧都量,
     * 量出这一段实际到哪,收紧矩形照量到的放大(`settleTight`);放大后的矩形和这一趟用的不一样,这个分段再按它产一次。
     */
    const remeasure = !exportSink && stride === 1 && spec.kind !== 'below' && manifest.tight && state.remeasure?.segment === segment ? state.remeasure : null;
    const rect = stride > 1 || exportSink ? manifest.bound
      : remeasure ? evenRect(extendSides(manifest.tight, remeasure.sides, manifest.bound), manifest.bound)
        : (manifest.tight ?? manifest.bound);
    const captureRect = { x: rect.x + spec.offset.x, y: rect.y + spec.offset.y, w: rect.w, h: rect.h };
    // 依赖下层的流:两张截图都按上界截,算完再裁到 `captureRect`
    const viewRect = below ? { x: manifest.bound.x + spec.offset.x, y: manifest.bound.y + spec.offset.y, w: manifest.bound.w, h: manifest.bound.h } : captureRect;
    const sparse = stride > 1;
    const replay = spec.replay !== false;
    /*
     * 稀疏的分段只截这一段的第一帧。要回放的流(motion 式)照旧把这一段的每一帧都推过去(下一段接着租约推,不然每段都要从挂载帧重来);
     * 不要回放的流(remotion 式)只推到第一帧就停,下一段直接跳过去 —— 同一条流、同一个页面上跳,不重灌工程。
     */
    const bakeTo = sparse && !replay ? fromFrame : toFrame;
    const lease = bakery.streamLease;
    const samePage = !!lease && !lease.dirty && lease.page === bakery.page && lease.streamSignature === spec.streamKey;
    const continues = samePage && lease.lastFrame + 1 === fromFrame;
    if (!continues && !(sparse && !replay && samePage)) {
      await bakery.reset(state.isolated, this.pipeline.emptyUrl(state.isolated), { deferCards: true });
      bakery.streamLease = null;
      this.stats.resets++;
      this.stats.setFrameWindowCalls++;
      state.resets = state.resets ?? { sparse: 0, dense: 0 };
      state.resets[stride > 1 ? 'sparse' : 'dense']++;
    }
    /*
     * 依赖下层、要回放的流:每一拍都画(`BELOW_DISCARD_SHOT` 的说明)。做法是让 `bakeStream` 把「推过去的帧」也当成要取的帧
     * (从它本来要回放的起点起、间隔 1),在取帧钩子里把不是这个分段要的帧画一张丢掉;`bakeStream` 和截图代码一个字不动。
     * `drawFrom`:接得上租约时就是这个分段的第一帧,接不上时是回放的起点(与 `bakeStream` 自己算的 `startFrame` 同一个数)。
     */
    const drawAll = below && replay;
    const drawFrom = drawAll && !continues && Number.isInteger(spec.mountFrame) ? Math.max(0, Math.min(fromFrame, spec.mountFrame)) : fromFrame;
    const wanted = frame => frame >= fromFrame && (frame - fromFrame) % stride === 0;
    let discarded = 0, discardedBefore = 0;
    const abort = new AbortController();
    const stale = () => this.closed || (!exportSink && this.streams.get(spec.streamKey) !== state)
      || (queue ? queue.signal?.aborted === true : state.generation !== generation);
    const guard = setInterval(() => { if (stale()) abort.abort(); }, 100);
    guard.unref?.();
    let enc = null;
    let firstCapture = true;
    /** 这个分段的位置矩形(平面坐标):`undefined` = 没量出来,`null` = 这一张全透明 */
    let segmentBox;
    /** 重量的一趟里这一段每一帧不透明区域的并集(平面坐标) */
    let remeasured = null;
    // 补密时每一帧都看一眼画面有没有顶到收紧矩形的边(依赖下层的流有自己的办法,见 `below-overflow`);矩形就是上界时不用看
    const guardTight = !exportSink && !sparse && !below && JSON.stringify(rect) !== JSON.stringify(manifest.bound);
    try {
      /*
       * 不要回放的流(成员全是 remotion 式,`spec.replay === false`):不传 `mountFrame`、预热帧数传 0。
       * `bakeStream` 对「没给 `mountFrame`」就是从 `fromFrame` 起挂载,接不上租约只付一次重灌页面的钱,
       * 不再从挂载帧逐帧推过来;所以分段不必按顺序产。`server/bakery/bake.mjs` 一个字不动(代码指纹)。
       */
      // 画布直取:这个分段的帧不截图,从画布取像素(过不了实测的照旧截图);`shot` 是 PNG,或 `{ rgba, width, height }`
      const direct = exportSink ? null : this.directOf(state);
      const belowCapture = below ? belowSegmentCapture(bakery, { clipId: spec.topClipId, view: viewRect, rect: captureRect, record: state.below ||= newBelowRecord(), signal: abort.signal,
        note: message => this.note(`流 ${spec.streamKey.slice(0, 8)} ${message}`) }) : null;
      const result = await bakeStream(bakery, {
        streamSignature: spec.streamKey, fromFrame: drawAll ? drawFrom : fromFrame, toFrame: bakeTo, stride: drawAll ? 1 : stride, fps,
        ...(replay ? { mountFrame: spec.mountFrame } : { warm: 0 }),
        // 每一拍都画的那一种:素材只在真要取的帧前面等(丢掉的那几张不用等视频就位),所以不交给 `bakeStream` 逐帧等
        clip: viewRect, hasMedia: below && !drawAll && spec.hasMedia === true, signal: abort.signal,
        ...(drawAll ? { capture: async (frame, shoot, info) => {
          if (!wanted(frame)) {
            await bakery.beginFrame({ screenshot: BELOW_DISCARD_SHOT });
            discarded++;
            if (frame < fromFrame) discardedBefore++;
            return BELOW_SKIPPED;
          }
          if (spec.hasMedia === true) await prepareFrameMedia(bakery);
          return belowCapture(frame, shoot, info);
        } }
        : below ? { capture: belowCapture }
        : direct ? { capture: directSegmentCapture(bakery, { clipId: spec.topClipId, rect: captureRect, record: direct, stride, captures: Math.ceil(samples / stride), always: this.direct === 'always',
          note: message => this.note(`流 ${spec.streamKey.slice(0, 8)} ${message}`) }) } : {}),
        onFrame: async (frame, shot) => {
          if (stale()) throw Object.assign(new Error('流已作废'), { cancelled: true });
          // 画一张丢掉的帧(不是这个分段要的)不进编码器
          if (shot === BELOW_SKIPPED || (drawAll && !wanted(frame))) return;
          if (exportSink) { await exportSink(frame, shot); return; }
          const raw = shot?.rgba ? shot : null;
          if (sparse || frame === fromFrame || guardTight || remeasure) {
            // 这一张里不透明像素的外接框(截图矩形里的像素坐标)
            const local = raw ? rgbaAlphaBox(raw.rgba, raw.width, raw.height) : pngAlphaBox(shot);
            if (sparse) segmentBox = this.measureBox(state, frame, local, rect);
            else if (frame === fromFrame && !local?.full) segmentBox = local ? { x: rect.x + local.x, y: rect.y + local.y, w: local.w, h: local.h } : null;
            // 重量的一趟:记下这一段每一帧实际到哪(平面坐标);读不懂的图当整幅都有
            if (remeasure) remeasured = unionRect(remeasured, !local ? null : local.full ? rect : { x: rect.x + local.x, y: rect.y + local.y, w: local.w, h: local.h });
            if (guardTight && local && !local.full) {
              const sides = tightOverflowSides(local, rect, manifest.bound);
              if (sides) throw Object.assign(new Error(`第 ${frame} 帧的画面顶到了收紧矩形的边(${Object.keys(sides).join('、')})`), { code: 'tight-overflow', sides });
            }
          }
          if (!enc) {
            // 第一张图出来时还没有这个分段的编码器在跑:这一张的出图耗时算「空闲」样本
            await this.encoderSlot();
            enc = openStreamSegmentEncoder(this.ffmpeg, { encoder, fps, ...(raw ? { raw: { width: raw.width, height: raw.height } } : {}) });
          }
          const repeat = Math.min(stride, toFrame - frame + 1);
          for (let k = 0; k < repeat; k++) await enc.write(raw ? raw.rgba : shot);
          firstCapture = false;
        },
      });
      if (result.reset) this.stats.bakeStreamResets = (this.stats.bakeStreamResets ?? 0) + 1;
      // 这条流取图那一段的累计(诊断:`status()` 每条流的 `capture`;取了几帧、取图和推帧各花多少毫秒)
      // 画一张丢掉的那些帧不算取了的帧;分段第一帧之前的那些就是回放的帧(`bakeStream` 把它们数进了 `captured`)
      result.captured -= discarded;
      result.replayed = (result.replayed ?? 0) + discardedBefore;
      const taken = state.capture ||= { frames: 0, captureMs: 0, stepMs: 0 };
      taken.frames += result.captured; taken.captureMs += result.captureMs; taken.stepMs += result.stepMs;
      if (discarded) taken.discarded = (taken.discarded ?? 0) + discarded;
      // 回放过的帧数(`bakeStream` 的 `replayed`):不回放的流恒为 0,探针读 `status()` 核对
      this.stats.replayedFrames = (this.stats.replayedFrames ?? 0) + (result.replayed ?? 0);
      state.replayedFrames = (state.replayedFrames ?? 0) + (result.replayed ?? 0);
      if (result.captured) {
        const per = result.captureMs / result.captured;
        (this.aliveEncoders > 1 ? this.measure.busy : this.measure.idle).push(per);
        while (this.measure.busy.length > 50) this.measure.busy.shift();
        while (this.measure.idle.length > 50) this.measure.idle.shift();
      }
    } catch (error) {
      if (enc) { await enc.abort(); this.releaseEncoderSlot(); }
      bakery.streamLease = null;
      // 差分取层发现目标卡改到了收紧矩形外面(稀疏那一趟没量到的帧):把收紧矩形放大,这个分段按新矩形重来,不算失败
      if (below && error?.code === 'below-overflow' && this.widenTight(state, error.box)) error.cancelled = true;
      // 别的流:补密时画面顶到了收紧矩形的边(稀疏版每段只量了第一帧)。这个分段重来一趟,那几边放到上界、每帧都量(见上),不算失败
      if (error?.code === 'tight-overflow') {
        state.remeasure = { segment, sides: { ...(remeasure?.sides ?? {}), ...error.sides } };
        error.cancelled = true;
      }
      throw error;
    } finally { clearInterval(guard); }
    if (remeasure) {
      state.remeasure = null;
      const settled = this.settleTight(state, remeasured, remeasure.sides);
      if (JSON.stringify(settled) !== JSON.stringify(rect)) {
        // 这一趟是按放到上界的矩形产的,比定下来的收紧矩形大:不留它,这个分段按定下来的矩形再产一次(不算失败)
        if (enc) { await enc.abort(); this.releaseEncoderSlot(); }
        bakery.streamLease = null;
        throw Object.assign(new Error(`流 ${spec.streamKey.slice(0, 8)}#${segment} 的收紧矩形重新量过,按新矩形重来`), { cancelled: true });
      }
    }
    // 导出专用的逐帧位图:帧已经逐张交出去了,没有编码器、不进流库
    if (exportSink) return true;
    if (!enc) return false;
    void firstCapture;
    const job = enc.finish()
      .then(out => this.storeSegment(state, generation, { segment, stride, rect, encoder, samples, out, box: segmentBox }))
      .catch(error => {
        this.stats.failures++;
        state.failures.set(segment, (state.failures.get(segment) ?? 0) + 1);
        this.note(`分段 ${spec.streamKey.slice(0, 8)}#${segment} 编码失败:${error?.message || error}`);
      })
      .finally(() => { state.reserved.delete(segment); this.releaseEncoderSlot(); this.encoding.delete(job); this.kick(); });
    this.encoding.add(job);
    // X1:队列任务要等这个分段真落盘才算产完(`produceRange`);自动生产不等(双缓冲)
    task.job = job;
    return true;
  }

  /**
   * 稀疏那一趟每个分段量一个位置矩形:这一张(分段的第一帧)里 alpha > 0 的像素的外接框,换回平面坐标,不外扩。
   * 截图矩形就是 `rect`(平面坐标),所以图片像素 (x, y) 在平面上是 (rect.x + x, rect.y + y)。`local` 是 `pngAlphaBox` / `rgbaAlphaBox`
   * 的结果。回这个分段的位置矩形(`null` = 全透明;读不懂的图回 `undefined`,并记 `measureFailed`:这条流不收紧)。顺带并进整条流的并集。
   */
  measureBox(state, frame, local, rect) {
    if (local?.full) { state.measureFailed = true; return undefined; }
    const box = local ? { x: rect.x + local.x, y: rect.y + local.y, w: local.w, h: local.h } : null;
    if (box) state.measured = unionRect(state.measured, box);
    state.measuredSegments.add(streamSegmentOf(frame, state.spec.originFrame));
    return box;
  }
  /**
   * 整条流的稀疏版齐了以后定收紧矩形:各分段位置矩形(清单里的 `box`)的并集外扩一点、夹回上界、外扩到偶数。面积省不到
   * `TIGHTEN_MIN_SAVING` 就不收紧(白换一个变体)。有哪个分段没有位置矩形(拉来的旧分段、读不懂的图)、整条流都透明、
   * 或者已经有按上界产的满密度分段(收紧会把它们判旧重产),都不收紧。
   */
  maybeTighten(state) {
    const manifest = state.manifest;
    if (manifest.tight || state.measureFailed) return;
    const { spec } = state;
    for (let n = spec.firstSegment; n <= spec.lastSegment; n++) if (this.needsSparse(state, n)) return;
    const bound = manifest.bound;
    let union = null;
    for (let n = spec.firstSegment; n <= spec.lastSegment; n++) {
      const seg = manifest.segments[n];
      // 并集必须覆盖**每一个**分段,而且不能把已经按上界产好的满密度分段判旧
      if (!seg || seg.box === undefined || (seg.stride === 1 && !seg.adopted)) { manifest.tight = bound; return; }
      if (seg.box) union = unionRect(union, seg.box);
    }
    if (!union) { manifest.tight = bound; return; }
    const tight = evenRect(intersectRect(padRect(union, MEASURE_PAD_PX), bound), bound);
    manifest.tight = rectArea(tight) <= rectArea(bound) * (1 - TIGHTEN_MIN_SAVING) ? tight : bound;
    this.note(`流 ${spec.streamKey.slice(0, 8)} 收紧到 ${JSON.stringify(manifest.tight)}(上界 ${JSON.stringify(bound)})`);
  }

  /**
   * 依赖下层的流的收紧矩形不够大:满密度那一趟里目标卡改到了它外面(`box`,场景坐标)。把它并进去再外扩、夹回上界。
   * 已经按旧矩形产好的满密度分段签名对不上了(`segmentState` 判 `stale`),会按新矩形重产。回有没有真的放大。
   */
  widenTight(state, box) {
    const manifest = state.manifest;
    const { spec } = state;
    if (!manifest?.tight || !box) return false;
    const bound = manifest.bound;
    const plane = { x: box.x - spec.offset.x, y: box.y - spec.offset.y, w: box.w, h: box.h };
    const wider = evenRect(intersectRect(unionRect(manifest.tight, padRect(plane, MEASURE_PAD_PX)), bound), bound);
    if (rectArea(wider) <= rectArea(manifest.tight)) return false;
    state.measured = unionRect(state.measured, plane);
    this.note(`流 ${spec.streamKey.slice(0, 8)} 的收紧矩形放大到 ${JSON.stringify(wider)}(原来 ${JSON.stringify(manifest.tight)},目标卡改到了它外面)`);
    manifest.tight = wider;
    return true;
  }

  /**
   * 补密时画面顶到了收紧矩形的边(`sides`:`{ left, top, right, bottom }` 里为真的那几边),重量了一趟,这一段每一帧实际到哪是 `measured`
   * (平面坐标的并集;全透明是 null)。收紧矩形在顶到的那几边放到「量到的边界、外扩 `MEASURE_PAD_PX`、再多留一截」:多留的一截等于
   * 这一段里画面超出原来矩形的距离,最多 `TIGHT_WIDEN_MARGIN_PX`(画面多半还会接着往那边走,少重来几次;只超出一点的不白放大)。
   * 别的边不动,夹回上界、外扩到偶数;放大以后省不到 `TIGHTEN_MIN_SAVING` 就干脆用上界。
   * 只放大不缩小。已经按旧矩形产好的满密度分段签名对不上,会按新矩形重产。回定下来的收紧矩形。
   */
  settleTight(state, measured, sides) {
    const manifest = state.manifest;
    if (!manifest?.tight || !sides) return manifest?.tight ?? null;
    const { tight, bound } = manifest;
    const m = measured ?? tight;
    /** 这一边往外放多少:量到的边界超出原来矩形 `over` 像素 → 外扩 + 再多留 `over`(封顶);没量到超出(贴着边)按封顶留 */
    const reach = over => MEASURE_PAD_PX + (over > 0 ? Math.min(TIGHT_WIDEN_MARGIN_PX, over) : TIGHT_WIDEN_MARGIN_PX);
    const x1 = tight.x + tight.w, y1 = tight.y + tight.h, mx1 = m.x + m.w, my1 = m.y + m.h;
    const grown = rectOf(
      sides.left ? Math.min(tight.x, m.x - reach(tight.x - m.x)) : tight.x,
      sides.top ? Math.min(tight.y, m.y - reach(tight.y - m.y)) : tight.y,
      sides.right ? Math.max(x1, mx1 + reach(mx1 - x1)) : x1,
      sides.bottom ? Math.max(y1, my1 + reach(my1 - y1)) : y1);
    let wider = evenRect(intersectRect(grown, bound), bound);
    if (rectArea(wider) > rectArea(bound) * (1 - TIGHTEN_MIN_SAVING)) wider = bound;
    if (rectArea(wider) <= rectArea(tight)) return tight;
    this.note(`流 ${state.spec.streamKey.slice(0, 8)} 的收紧矩形放大到 ${JSON.stringify(wider)}(原来 ${JSON.stringify(tight)},补密时画面顶到了${Object.keys(sides).filter(k => sides[k]).join('、')}边)`);
    manifest.tight = wider;
    state.widened = (state.widened ?? 0) + 1;
    return wider;
  }

  /** 编完一个分段:切分、校验、落盘、改清单、发 `layer`;被替换的旧文件 5 秒后删(G6) */
  async storeSegment(state, generation, { segment, stride, rect, encoder, samples, out, box }) {
    await this.ownership?.assert();
    const { spec } = state;
    const { init, segments, dropped } = splitFmp4(out.bytes);
    if (segments.length !== 1) throw new Error(`一次编码应当恰好一个分段,实际 ${segments.length} 个`);
    const info = segmentInfo(segments[0]);
    if (info.moofs !== 1) throw new Error(`分段里应当恰好一个 moof,实际 ${info.moofs}`);
    // G2:一个分段的样本数必须恰好 15(这条流的末段除外),少一帧就重拍
    if (info.sampleCount !== samples) throw new Error(`分段样本数 ${info.sampleCount},应当是 ${samples}`);
    if (info.firstSampleIsSync !== true) throw new Error('分段首帧不是 IDR');
    if (!init.length) throw new Error('编码输出里没有 ftyp + moov');
    // `generation === null`:队列任务产的分段,不按版本判旧(见 `runSegment`)
    if ((generation !== null && state.generation !== generation) || this.streams.get(spec.streamKey) !== state) return;
    const manifest = state.manifest;
    const initId = sha(init, 16);
    const dir = this.store.dir(spec.streamKey);
    await this.ownership?.assert();
    await fs.mkdir(dir, { recursive: true });
    if (!manifest.inits[initId]) {
      const meta = initInfo(init);
      await this.store.writeFile(this.store.initFile(spec.streamKey, initId), init);
      manifest.inits[initId] = { codec: meta.codec, width: meta.width, height: meta.height, timescale: meta.timescale, rect, encoder, bytes: init.length };
      this.note(`流 ${spec.streamKey.slice(0, 8)} 新变体 init-${initId}(${meta.codec} ${meta.width}×${meta.height})`);
    }
    const file = `${segment}-${sha(segments[0], 16)}.m4s`;
    await this.store.writeFile(this.store.segFile(spec.streamKey, file), segments[0]);
    const old = manifest.segments[segment];
    // 位置矩形:稀疏的分段记这一趟量的;满密度的沿用它替换掉的那个稀疏分段的(没有就记这一趟第一帧量的)
    const kept = stride > 1 ? box : (old?.box !== undefined ? old.box : box);
    manifest.segments[segment] = { file, init: initId, stride, samples, bytes: segments[0].length, encodeMs: out.encodeMs, tailMs: out.tailMs,
      sig: segmentSignature({ streamKey: spec.streamKey, segment, stride, encoder, rect }), dropped, at: Date.now(), ...(kept !== undefined ? { box: kept } : {}) };
    if (stride > 1) this.maybeTighten(state);
    const oldRect = old ? manifest.inits[old.init]?.rect : null;
    this.pruneInits(state);
    await this.store.save(manifest);
    this.stats.segments++;
    this.publish(state);
    // C6.4 第 4 节的流钩子:这个分段所在的段进推送队列。只在管线配了推送队列时生效,没配时这一行什么都不做
    if (this.pipeline.pushQueue) { try { this.pipeline.enqueueStreamPush?.(spec, segment); } catch {} }
    if (old && old.stride > 1 && stride === 1) {
      // 验收「稀疏分段 ≤ 满密度 1.0 倍」要的对照:同一段、稀疏与满密度各自的字节和矩形
      (this.stats.sparseVsDense ||= []).push({ stream: spec.streamKey.slice(0, 8), segment, sparse: old.bytes, dense: segments[0].length,
        sameRect: JSON.stringify(oldRect) === JSON.stringify(rect) });
      while (this.stats.sparseVsDense.length > 100) this.stats.sparseVsDense.shift();
    }
    if (old && old.file !== file) {
      const stalePath = this.store.segFile(spec.streamKey, old.file);
      const timer = setTimeout(() => {
        const still = Object.values(state.manifest?.segments ?? {}).some(s => s.file === old.file);
        if (still) return;
        void fs.rm(stalePath, { force: true }).then(() => { this.stats.replacedDeleted++; });
      }, REPLACED_DELETE_MS);
      timer.unref?.();
    }
  }

  /**
   * 清单里没有分段再用的变体去掉(调用方接着保存清单):稀疏版全部换成满密度以后的上界变体、收紧矩形放大以前的变体。
   * 它的开头文件过 `REPLACED_DELETE_MS` 再删(页面上可能还有拿着旧清单的在途请求);到时清单里又有它了(同样的矩形又产了一次)就不删。
   */
  pruneInits(state) {
    const manifest = state.manifest, key = state.spec.streamKey;
    const used = new Set(Object.values(manifest.segments ?? {}).map(s => s.init));
    const gone = Object.keys(manifest.inits ?? {}).filter(id => !used.has(id));
    if (!gone.length) return 0;
    for (const id of gone) delete manifest.inits[id];
    const timer = setTimeout(() => {
      for (const id of gone) if (!state.manifest?.inits?.[id]) void fs.rm(this.store.initFile(key, id), { force: true }).catch(() => {});
    }, REPLACED_DELETE_MS);
    timer.unref?.();
    return gone.length;
  }

  /**
   * C6.2 拉取端(契约第 6 节):把别的节点产的一段轨道流(任务清单 `StreamResult` + 字节)收进本机流库。
   * `blobs`:哈希 → Buffer(`Map` 或普通对象),要含清单里本机还没有的每个 init 和分段。
   *
   *   - **写文件**只在这里:照现有命名 `init-<sha16>.mp4`、`<n>-<sha16>.m4s`,经 `atomic`;
   *   - **合并清单**合进这条流在内存里的 `state.manifest`(没有 state 就按清单的 `header` 新建一个最小的,
   *     标 `adoptedOnly`:不在任何一版的计划里,本机不替它补产、不认领,`publish` 只挂键不发层;之后
   *     `update` 把它排进某一版时去掉这个标记),再 `StreamStore.save` —— 不从外面改
   *     `stream.json`,否则会被生产者用内存里的清单覆盖;
   *   - 拉来的分段记 `adopted: true`,带对方的 `encoder` 与 `sig`(`segmentState` 据此不判旧);
   *   - 本机已经有、而且不是 `stale` 的分段跳过,不覆盖;
   *   - 发布:照现有的 `publish(state)`(`adoptedOnly` 的只 `stageByKey`)。
   *
   * 同一个生产者上的拉取串行进行。回 `{ written, skipped, inits }`(写了几个分段、跳过几个、新写了几个 init)。
   */
  adoptSegments(result, blobs) {
    const run = (this.adoptChain ?? Promise.resolve()).catch(() => {}).then(() => this.adoptSegmentsNow(result, blobs));
    this.adoptChain = run;
    return run;
  }

  /** `adoptSegments` 的本体(已串行化) */
  async adoptSegmentsNow(result, blobs) {
    await this.ownership?.assert();
    if (this.ownership && result?.projectId !== this.ownership.projectId) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
    const plan = streamAdoption(result);
    if (this.closed) throw Object.assign(new Error('Stream producer closed'), { cancelled: true });
    const { key } = plan;
    const blobOf = hash => {
      const buf = typeof blobs?.get === 'function' ? blobs.get(hash) : blobs?.[hash];
      if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) throw new Error(`缺少块 ${hash}`);
      const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      if (sha(bytes) !== hash) throw new Error(`块 ${hash} 的内容和哈希对不上`);
      return bytes;
    };
    let state = await this.adoptionState(key, plan);
    // 先挑出要写的分段(本机没有,或者已判旧),核对字节;一个块不对就整个不写
    const pending = [];
    for (const [n, seg] of plan.segments) {
      if (!this.adoptable(state, n, seg)) continue;
      const initMeta = plan.inits[seg.init] ?? state.manifest.inits?.[seg.init];
      if (!initMeta) throw new Error(`分段 ${n} 用的 init ${seg.init} 不在清单里`);
      pending.push({ n, seg, bytes: blobOf(seg.hash) });
    }
    const initIds = [...new Set(pending.map(p => p.seg.init))].filter(id => !state.manifest.inits?.[id]);
    const initBytes = new Map(initIds.map(id => {
      if (!plan.inits[id]) throw new Error(`init ${id} 不在清单里`);
      return [id, blobOf(plan.inits[id].hash)];
    }));
    // 写文件(内容寻址,重复写同一份无害)
    await fs.mkdir(this.store.dir(key), { recursive: true });
    for (const [id, bytes] of initBytes) { await this.ownership?.assert(); await this.store.writeFile(this.store.initFile(key, id), bytes); }
    for (const p of pending) {
      await this.ownership?.assert();
      p.file = `${p.n}-${p.seg.hash.slice(0, 16)}.m4s`;
      await this.store.writeFile(this.store.segFile(key, p.file), p.bytes);
    }
    // 写盘期间 `update()` 可能换了一版:以此刻 `this.streams` 里的为准,**同步**合并
    const live = this.streams.get(key);
    if (live) state = live;
    else if (!this.closed) this.streams.set(key, state);
    const manifest = state.manifest;
    manifest.inits ||= {};
    manifest.segments ||= {};
    let written = 0, skipped = plan.segments.length - pending.length, inits = 0;
    const replaced = [];
    for (const p of pending) {
      const old = manifest.segments[p.n];
      // 写盘期间本机刚产好了这一段:不覆盖,刚写的文件没人引用就删掉
      if (old && old.file !== p.file && !this.adoptable(state, p.n, p.seg)) {
        skipped++;
        if (!Object.values(manifest.segments).some(s => s.file === p.file)) void fs.rm(this.store.segFile(key, p.file), { force: true }).catch(() => {});
        continue;
      }
      // 换到的那份清单没有这个 init、而刚才也没写它的文件(极少见:写盘期间换了一版):这一段不收,下次再拉
      if (!manifest.inits[p.seg.init] && !initBytes.has(p.seg.init)) { skipped++; continue; }
      if (!manifest.inits[p.seg.init]) {
        const meta = plan.inits[p.seg.init];
        manifest.inits[p.seg.init] = { codec: meta.codec ?? null, width: meta.width ?? null, height: meta.height ?? null, timescale: meta.timescale ?? null,
          rect: meta.rect ?? null, encoder: meta.encoder ?? null, bytes: meta.bytes ?? initBytes.get(p.seg.init)?.length ?? null, adopted: true };
        inits++;
      }
      // 位置矩形:对方清单里带着就用对方的;没带、而本机被它换掉的那个分段有,就留着本机的
      const adoptedBox = isBox(p.seg.box) || p.seg.box === null ? p.seg.box : old?.box;
      manifest.segments[p.n] = { file: p.file, init: p.seg.init, stride: p.seg.stride, samples: p.seg.samples, bytes: p.bytes.length,
        // 分段的 `encoder` 取它所用 init 的(契约第 11 节第 6 条)
        sig: p.seg.sig ?? null, encoder: manifest.inits[p.seg.init]?.encoder ?? p.seg.encoder ?? null, adopted: true, at: Date.now(),
        ...(adoptedBox !== undefined ? { box: adoptedBox } : {}) };
      if (old && old.file !== p.file) replaced.push(old.file);
      written++;
    }
    // 对方已经收紧过、本机还没有:用对方的收紧矩形(本机没有按上界产的满密度分段时才换,免得把它们判旧)
    if (!manifest.tight && plan.header.tight && !Object.values(manifest.segments).some(s => !s.adopted && s.stride === 1)) manifest.tight = plan.header.tight;
    if (state.adoptedOnly) {
      state.spec.firstSegment = Math.min(state.spec.firstSegment, plan.range.from);
      state.spec.lastSegment = Math.max(state.spec.lastSegment, plan.range.to);
    }
    await this.store.save(manifest);
    // 照现有的 `publish(state)`:`adoptedOnly` 的 state 由 `adoptionState` 按清单的 header 建出了 publish 要的
    // 全部 spec 字段(streamKey / topClipId / kind / clipIds),在它那里只挂键、不发层
    this.publish(state);
    for (const file of replaced) {
      const timer = setTimeout(() => {
        if (Object.values(state.manifest?.segments ?? {}).some(s => s.file === file)) return;
        void fs.rm(this.store.segFile(key, file), { force: true }).then(() => { this.stats.replacedDeleted++; }, () => {});
      }, REPLACED_DELETE_MS);
      timer.unref?.();
    }
    if (written) this.note(`流 ${key.slice(0, 8)} 拉进 ${written} 个分段(跳过 ${skipped})`);
    return { written, skipped, inits };
  }

  /**
   * 拉取前先问:这一段清单里,本机还缺哪些分段、要下哪些块(`applyResult` 据此只下载缺的)。
   * 回 `{ segments: [n…], hashes: [hash…] }`。只读,不改状态。
   */
  async adoptionNeeds(result) {
    await this.ownership?.assert();
    if (this.ownership && result?.projectId !== this.ownership.projectId) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
    const plan = streamAdoption(result);
    const state = this.streams.get(plan.key) ?? { spec: { streamKey: plan.key }, manifest: await this.store.load(plan.key) };
    const segments = [], hashes = new Set();
    for (const [n, seg] of plan.segments) {
      if (!this.adoptable(state, n, seg)) continue;
      segments.push(n);
      hashes.add(seg.hash);
      if (!state.manifest?.inits?.[seg.init] && plan.inits[seg.init]) hashes.add(plan.inits[seg.init].hash);
    }
    return { segments, hashes: [...hashes] };
  }

  /** 拉取要合进的 state:生产者手里有就用它;没有就按盘上的清单(或新清单)新建一个 `adoptedOnly` 的 */
  async adoptionState(key, plan) {
    const live = this.streams.get(key);
    if (live) return live;
    const { header, range } = plan;
    const manifest = (await this.store.load(key)) ?? { version: STREAM_CODE_VERSION, streamKey: key, kind: header.kind, plane: header.plane,
      clipIds: header.clipIds, fps: header.fps, originFrame: header.originFrame, bound: header.bound, offset: header.offset ?? null, tight: header.tight ?? null, inits: {}, segments: {} };
    const again = this.streams.get(key);
    if (again) return again;
    const clipIds = Array.isArray(manifest.clipIds) ? manifest.clipIds : header.clipIds;
    return {
      adoptedOnly: true,
      spec: { streamKey: key, contentKey: null, kind: manifest.kind ?? header.kind, plane: manifest.plane ?? header.plane, clipIds, topClipId: clipIds[clipIds.length - 1] ?? null,
        fps: manifest.fps ?? header.fps, bound: manifest.bound ?? header.bound, offset: manifest.offset ?? header.offset ?? { x: 0, y: 0 },
        originFrame: manifest.originFrame ?? header.originFrame, firstSegment: range.from, lastSegment: range.to },
      manifest, aliases: new Set(), reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set(),
    };
  }

  /**
   * 按实测自适应 `streamPool`(G0-b 结论 1):带编码器时每帧出图耗时不超过空闲时的 2 倍、
   * 而且不止一条流有活,才加到 2;超过 2 倍就退回 1。设了 `PROMPTCUT_STREAM_POOL` 就不动。
   */
  adaptPool() {
    if (this.poolLimit.fixed) return;
    const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
    const { idle, busy } = this.measure;
    if (idle.length < 3 || busy.length < 10) return;
    const ok = avg(busy) <= 2 * avg(idle);
    const want = ok && this.streams.size > 1 ? STREAM_POOL_MAX : STREAM_POOL_DEFAULT;
    if (want !== this.pool) {
      this.note(`streamPool ${this.pool} → ${want}(带编码器 ${avg(busy).toFixed(1)} ms/帧,空闲 ${avg(idle).toFixed(1)} ms/帧)`);
      this.pool = want;
      this.kick();
    }
  }

  /** 等全部在编的分段收尾(探针 / 测试用) */
  async drain() {
    for (;;) {
      await Promise.allSettled([...this.workers, ...this.encoding]);
      if (!this.workers.size && !this.encoding.size) return;
    }
  }

  /** F5:扫盘挂到「键 → 区间」上,等 card plan 到位再认领 */
  async rescan() {
    if (!this.routeAttached) return 0;
    const found = await this.store.scan();
    for (const item of found) {
      try { this.pipeline.ready.stageByKey({ kind: 'stream', key: item.key, ranges: item.ranges }); } catch {}
    }
    return found.length;
  }

  /**
   * 已经在库里的流在认领表里的样子(`claimSessions` 用):`{ clipId, kind: 'stream', key }`。
   * 传了 `entryKey` 就只给属于那一版的流 —— 生产者手里的可能是另一个会话的版本。
   */
  claimLayers(entryKey) {
    // C6.2:只是拉来的流(`adoptedOnly`)不属于任何一版,不认领
    return [...this.streams.values()].filter(state => !state.adoptedOnly && (entryKey === undefined || (state.entryKey ?? this.entryKey) === entryKey))
      .flatMap(state => [state.spec.topClipId, ...(state.aliases ?? [])]
      .map(clipId => ({ clipId, kind: 'stream', key: state.spec.streamKey, ...(isStreamOrigin(state.spec.originFrame) ? { originFrame: state.spec.originFrame } : {}),
        ...belowLayerMark(state.spec, clipId) })));
  }

  async close() {
    this.closed = true;
    for (const resolve of this.encoderWaiters.splice(0)) resolve();
    await Promise.allSettled([...this.workers, ...this.encoding]);
  }
}

/** 某个目录下是否存在流库(给 F5 扫盘判断用) */
export function hasStreamLibrary(root) {
  try { return fsSync.statSync(path.join(root, 'streams')).isDirectory(); } catch { return false; }
}
