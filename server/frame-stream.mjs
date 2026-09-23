/**
 * 轨道流(R8,任务书 `docs/plan/r8-streams-task.md` 的 G1～G6)—— 预渲染进程这一侧。
 *
 * 给预渲染集合里的卡产「轨道流」:每张(或每组)重卡一条 H.264 流,上半 RGB(预乘)、下半 alpha 灰度,
 * 裁到实体框,按 15 帧切成 fMP4 分段。页面侧的解封装 / 解码 / 合成在 `src/render/streamPlayer.ts`。
 *
 * # 这个文件里有什么
 *
 *   - fMP4 按 box 切分与校验(G2:`ftyp + moov` → init,`moof + mdat` → 分段,`mfra` 丢掉);
 *   - 流的划分(G1):哪些卡进流、裁剪矩形的上界、超出解码器预算时合并成组流、每条流的隔离工程;
 *   - 流库(`<库根>/streams/<streamKey>/`):`stream.json` 清单 + `init-<id>.mp4` + `<n>-<hash>.m4s`;
 *   - 生产调度 `StreamProducer`(G4):只在空闲时生产、`streamPool` 个会话、先稀疏后补密、租约延续;
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
 * # 分段的「变体」
 *
 * 一条流的所有分段不一定同一个矩形:稀疏那一趟用上界矩形、顺带量实体框的并集(G1:「第一趟生产
 * 顺带量各帧实体框的并集,第二段起收紧到它」),补密那一趟用收紧后的矩形。矩形或编码器不同,
 * `init.mp4` 就不同 —— 每个分段在清单里记着自己用哪个 `init`,页面按分段各自配置解码器。
 * 同一个变体里,后续分段算出来的 `ftyp + moov` 必须和已存的逐字节相同,不同就是新变体(换签名)。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { bakeStream } from './bakery/bake.mjs';
import { findFfmpeg, openStreamSegmentEncoder, pickStreamEncoder, STREAM_ENCODERS, streamFilter, STREAM_SEGMENT_FRAMES } from './bakery/ffmpeg.mjs';
import { mountFrameOf } from '../src/render/frameWindow.mjs';
import { resolveFrameSize } from '../src/kernel/frameSize.mjs';
import { cardStreamIdentity } from './card-identity.mjs';
import { planStreamSegments } from './frame-playback.mjs';
import { mergeRanges } from './snapshot-store.mjs';
import { atomic } from './frame-mov.mjs';

export const SEGMENT_FRAMES = STREAM_SEGMENT_FRAMES;
/** G0-b 结论 1:先按 stride 3 把整段快速铺满 */
export const SPARSE_STRIDE = 3;
/** G1 / G0-b (4):同时活跃的解码器预算 */
export const STREAM_DECODER_BUDGET = 6;
/** G0-b 结论 1:`streamPool` 缺省 1,最多 2 */
export const STREAM_POOL_DEFAULT = 1;
export const STREAM_POOL_MAX = 2;
/** G6:替换后旧文件延迟这么久再删(页面上可能还有一个在途请求) */
export const REPLACED_DELETE_MS = 5000;
/** 生产这条流的代码的版本(改了分段格式 / 坐标口径就加一,旧流全部作废) */
export const STREAM_CODE_VERSION = 1;
/** 单卡流的矩形上界:框外再留这么多像素给溢出框的内容(阴影、描边) */
export const LOCAL_OVERFLOW_PX = 32;
/** 实测实体框并集再外扩这么多(稀疏趟只量了三分之一的帧,中间帧可能略微超出) */
export const MEASURE_PAD_PX = 8;
/** 收紧后的面积超过上界的这个比例就不收紧(白换一个变体没有收益) */
export const TIGHTEN_MIN_SAVING = 0.15;

/** `streams` 开关(任务书:默认开;`PROMPTCUT_STREAMS=0` 关) */
export function streamsEnabled(env = process.env) {
  return String(env.PROMPTCUT_STREAMS ?? '1').trim() !== '0';
}

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
 */
export function pngAlphaBox(buf, threshold = 0) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return { full: true };
  let off = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = color === 6 ? 4 : color === 4 ? 2 : 0;
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
 * 这张卡能不能进流。**只收 `independent`**:毛玻璃(`belowDependent`)要采样下层,`unknown`
 * 一律按 `belowDependent` 处理(G1「哪些卡不进流」);`sourceDependent`(转场 / 图卡接素材)的
 * 隔离工程要带齐源链,这一版保守地不进流(见报告「待用户定」),它们照 K5 贴快照。
 * 框用了三维的卡也不进:单卡流画在包裹层自己的坐标系里,框的三维摆放会被压成一张平面贴图。
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

/** 区间集合在同一帧上的最大重叠数,以及峰值出现在哪一帧 */
export function peakConcurrency(intervals) {
  const events = [];
  for (const it of intervals) { events.push([it.from, 1]); events.push([it.to + 1, -1]); }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0, at = 0;
  for (const [frame, d] of events) { cur += d; if (cur > peak) { peak = cur; at = frame; } }
  return { peak, at };
}

/**
 * 同时活跃的流超过解码器预算时,把超出的**相邻**重卡合并成组流(G1:「这是唯一的合并规则」)。
 *
 * `streams`:按画家顺序排好的单卡流 `[{ clipIds: [id], order, from, to }]`;`layers`:全部画面层。
 * 贪心:在重叠峰值那一帧上,挑画家顺序里**紧挨着**的两条流(两者之间、在它们合并后的时间段里
 * 没有别的画面层插着)合并;反复直到峰值 ≤ 预算或者再也找不到可合并的一对。
 * 回合并后的列表(每项 `clipIds` 按画家顺序,最后一个是最上面那张)。
 */
export function groupStreams(streams, layers, budget = STREAM_DECODER_BUDGET) {
  let list = streams.map(s => ({ ...s, clipIds: [...s.clipIds] }));
  const overlaps = (a, b) => a.from <= b.to && b.from <= a.to;
  for (let guard = 0; guard < 1000; guard++) {
    const { peak, at } = peakConcurrency(list);
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
    if (!merged) break;
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
  const view = { x: -ox, y: -oy, w: stage.width, h: stage.height };
  const bound = evenRect(intersectRect(view, padRect({ x: 0, y: 0, w, h }, LOCAL_OVERFLOW_PX)), view);
  return { box: { w, h }, offset: { x: ox, y: oy }, bound };
}

/**
 * 按 entry(项目 + card plan + 预渲染集合)算出这一版的全部流。纯函数(除了 `prerenderPicked`
 * 由调用方给)。回 `[{ streamKey, kind, plane, clipIds, topClipId, offset, bound, mountFrame,
 * firstFrame, lastFrame, firstSegment, lastSegment, members }]`。
 */
export function planStreams(entry, { picked = () => true, budget = STREAM_DECODER_BUDGET, codeVersion = '' } = {}) {
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
  for (const control of plan) {
    if (!picked(control.clipId)) continue;
    const at = where.get(control.clipId);
    if (!at || !streamEligible(control, at.clip, at.track)) continue;
    const firstFrame = control.sampling?.firstFrame ?? Math.ceil(at.clip.start * fps - 1e-9);
    const lastFrame = Math.min(total - 1, firstFrame + control.count - 1);
    if (lastFrame < firstFrame) continue;
    const mountFrame = mountFrameOf(at.clip, fps);
    singles.push({ control, clip: at.clip, clipIds: [control.clipId], order: orderOf.get(control.clipId) ?? 0, from: Math.min(mountFrame, firstFrame), to: lastFrame });
  }
  singles.sort((a, b) => a.order - b.order);
  const byClip = new Map(singles.map(s => [s.clipIds[0], s]));
  const grouped = groupStreams(singles, layers, budget);
  const specs = [];
  for (const g of grouped) {
    const members = g.clipIds.map(id => byClip.get(id));
    const first = Math.min(...members.map(m => m.from));
    const last = Math.max(...members.map(m => m.to));
    const firstVisible = Math.min(...members.map(m => m.control.sampling?.firstFrame ?? m.from));
    const base = {
      clipIds: [...g.clipIds], topClipId: g.clipIds[g.clipIds.length - 1], mountFrame: first,
      firstFrame: firstVisible, lastFrame: last,
      firstSegment: Math.floor(Math.max(0, firstVisible) / SEGMENT_FRAMES), lastSegment: Math.floor(last / SEGMENT_FRAMES),
      fps, stage, total,
    };
    if (members.length === 1) {
      const m = members[0];
      const placement = localPlacement(m.clip, stage);
      const streamKey = cardStreamIdentity({ kind: 'card', fps, stage, codeVersion,
        members: [{ key: m.control.snapshotKey || m.control.key, sampling: m.control.sampling, count: m.control.count }] });
      specs.push({ ...base, streamKey, kind: 'card', plane: 'local', offset: placement.offset, bound: placement.bound, box: placement.box, members: [m.control] });
    } else {
      const view = { x: 0, y: 0, w: stage.width, h: stage.height };
      const streamKey = cardStreamIdentity({ kind: 'group', fps, stage, codeVersion,
        members: members.map(m => ({ key: m.control.key, sampling: m.control.sampling, count: m.control.count })) });
      specs.push({ ...base, streamKey, kind: 'group', plane: 'stage', offset: { x: 0, y: 0 }, bound: evenRect(view, view), members: members.map(m => m.control) });
    }
  }
  return specs;
}

/**
 * 这条流的**隔离工程**(G4「单卡像素怎么隔离」:`isolatedCardProject` 的流版本)。
 *
 * 只留这条流的卡(单卡流一张、组流一组)可见;同一条序列上的其它片段和别的序列都变成
 * 隐藏的 `sourceOnly` 序列 —— 不出画,但图卡按源片段解输入时还找得到。**时间不平移**(流按全局
 * 帧号分段);背景透明由导出页自己保证。
 *
 * 单卡流还要把包裹层外观拿掉(框摆到 `offset`、不缩放不旋转、不透明度 / 淡入淡出 / motion / 强调
 * 都去掉):这些在舞台上由包裹层加。组流原样保留(外观画进流里)。
 */
export function isolatedStreamProject(project, spec) {
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
 * 流库
 * ======================================================================== */

const KEY_RE = /^[a-f0-9]{64}$/;
const INIT_RE = /^[a-f0-9]{16}$/;
const SEG_RE = /^(\d{1,7})-([a-f0-9]{16})\.m4s$/;

/** 编码参数的哈希(分段签名的一部分,G2) */
export function encoderParamsHash(encoder) {
  const spec = STREAM_ENCODERS[encoder];
  return sha(JSON.stringify({ args: spec?.args ?? null, filter: streamFilter(spec?.pixFmt) }), 16);
}

/** 分段签名 = 流签名 + 分段号 + stride + 编码器名 + 编码参数哈希(G2),再加上矩形(变体) */
export function segmentSignature({ streamKey, segment, stride, encoder, rect }) {
  return sha(JSON.stringify({ streamKey, segment, stride, encoder, params: encoderParamsHash(encoder), rect }), 32);
}

/** 清单里就绪的分段号(区间,C3 的 `stream` 表单位是分段号) */
export function readySegmentRanges(manifest) {
  return mergeRanges(Object.keys(manifest?.segments ?? {}).map(Number).filter(Number.isInteger));
}

export class StreamStore {
  constructor(root) { this.root = root; this.manifests = new Map(); }
  dir(key) { return path.join(this.root, key); }
  async load(key) {
    if (this.manifests.has(key)) return this.manifests.get(key);
    let manifest = null;
    try { manifest = JSON.parse(await fs.readFile(path.join(this.dir(key), 'stream.json'), 'utf8')); } catch {}
    if (!manifest || manifest.streamKey !== key) manifest = null;
    this.manifests.set(key, manifest);
    return manifest;
  }
  async save(manifest) {
    this.manifests.set(manifest.streamKey, manifest);
    await atomic(path.join(this.dir(manifest.streamKey), 'stream.json'), JSON.stringify(manifest));
  }
  /** 扫盘(F5):每条流的「键 → 就绪分段」 */
  async scan() {
    const out = [];
    let items = [];
    try { items = await fs.readdir(this.root, { withFileTypes: true }); } catch { return out; }
    for (const item of items) {
      if (!item.isDirectory() || !KEY_RE.test(item.name)) continue;
      this.manifests.delete(item.name);
      const manifest = await this.load(item.name);
      if (!manifest) continue;
      const ranges = readySegmentRanges(manifest);
      if (ranges.length) out.push({ key: item.name, ranges, manifest });
    }
    return out;
  }
  initFile(key, id) { return path.join(this.dir(key), `init-${id}.mp4`); }
  segFile(key, file) { return path.join(this.dir(key), file); }
}

/** 页面要的清单形状(不带签名等内部字段) */
export function publicManifest(manifest) {
  if (!manifest) return null;
  const segments = {};
  for (const [n, s] of Object.entries(manifest.segments ?? {})) segments[n] = { init: s.init, file: s.file, stride: s.stride, samples: s.samples };
  const inits = {};
  for (const [id, i] of Object.entries(manifest.inits ?? {})) inits[id] = { codec: i.codec, width: i.width, height: i.height, rect: i.rect };
  return { streamKey: manifest.streamKey, kind: manifest.kind, plane: manifest.plane, clipIds: manifest.clipIds, fps: manifest.fps,
    segmentFrames: SEGMENT_FRAMES, bound: manifest.bound, tight: manifest.tight ?? null, inits, segments };
}

/**
 * 分段字节的读口(C3 的快照字节同源,页面直连预渲染进程):
 *
 *   GET /stream/<streamKey>/manifest            清单(`no-store`:分段会被替换)
 *   GET /stream/<streamKey>/init/<initId>       init.mp4(内容寻址,immutable)
 *   GET /stream/<streamKey>/seg/<n>-<hash>.m4s  分段(内容寻址,immutable)
 *
 * `pathname` 是 `/api/frames` 之后那一段。认得就回 true(已经答了),不认得回 false。
 */
export function handleStreamRequest(store, req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const m = /^\/stream\/([a-f0-9]{64})\/(manifest|init\/([a-f0-9]{16})|seg\/(\d{1,7}-[a-f0-9]{16}\.m4s))$/.exec(pathname);
  if (!m) return false;
  const key = m[1];
  const fail = (status, error) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify({ error })); };
  if (m[2] === 'manifest') {
    store.manifests.delete(key);
    void store.load(key).then(manifest => {
      if (!manifest) return fail(404, 'Stream is not ready');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(publicManifest(manifest)));
    }, () => fail(404, 'Stream is not ready'));
    return true;
  }
  const file = m[3] ? store.initFile(key, m[3]) : store.segFile(key, m[4]);
  void fs.readFile(file).then(buf => {
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Length', buf.length);
    res.end(req.method === 'HEAD' ? undefined : buf);
  }, () => fail(404, 'Stream file is not ready'));
  return true;
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
 *   - **先稀疏后补密**:所有流先按 `stride = 3` 铺满,再用满密度分段替换;
 *   - 每个 worker 在流之间按「离播放头最近的未就绪分段」轮转,**但优先延续自己的租约**(`planStreamSegments`);
 *   - **同时存活的分段编码器 ≤ 2 × streamPool**(双缓冲)。
 */
export class StreamProducer {
  constructor(pipeline, { env = process.env } = {}) {
    this.pipeline = pipeline;
    this.enabled = streamsEnabled(env);
    this.budget = streamDecoderBudget(env);
    this.poolLimit = streamPoolLimit(env);
    this.pool = this.poolLimit.fixed ?? STREAM_POOL_DEFAULT;
    this.store = new StreamStore(path.join(pipeline.root, 'streams'));
    this.streams = new Map();
    this.workers = new Set();
    this.encoding = new Set();
    this.aliveEncoders = 0;
    this.encoderWaiters = [];
    this.generation = 0;
    this.closed = false;
    this.measure = { idle: [], busy: [] };
    this.stats = { segments: 0, resets: 0, replacedDeleted: 0, failures: 0, maxAliveEncoders: 0, setFrameWindowCalls: 0 };
    this.log = [];
  }

  /** 诊断口(`/api/frames/diagnostics`):每条流的分段表(G4 的 `status()`) */
  status() {
    return {
      enabled: this.enabled, pool: this.pool, budget: this.budget, encoder: this.encoderName ?? null,
      stats: { ...this.stats, aliveEncoders: this.aliveEncoders },
      streams: [...this.streams.values()].map(state => ({
        streamKey: state.spec.streamKey, kind: state.spec.kind, clipIds: state.spec.clipIds,
        firstSegment: state.spec.firstSegment, lastSegment: state.spec.lastSegment,
        bound: state.spec.bound, tight: state.manifest?.tight ?? null, resets: state.resets ?? null,
        segments: Object.fromEntries(Object.entries(state.manifest?.segments ?? {}).map(([n, s]) => [n, { stride: s.stride, init: s.init, bytes: s.bytes, encodeMs: s.encodeMs, tailMs: s.tailMs }])),
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

  /**
   * 新的一版项目 / card plan(`preload` 在锚帧就绪之后调)。重算期望的流(G6:`localRev` 变了
   * 重算受影响流的期望签名),读回盘上已有的分段、发 `layer`,再把 worker 叫起来。
   */
  async update(entry) {
    if (!this.enabled || this.closed || !entry) return [];
    const specs = planStreams(entry, {
      picked: clipId => this.pipeline.prerenderPicked(entry, clipId),
      budget: this.budget,
      codeVersion: `${STREAM_CODE_VERSION}:${this.pipeline.captureCode?.() || ''}`,
    });
    const generation = ++this.generation;
    this.entryKey = entry.key;
    const next = new Map();
    for (const spec of specs) {
      // 同一张卡、同参数同入点的两个片段(比如复制出来叠在两条序列上)内容逐像素相同,共用一条流
      if (next.has(spec.streamKey)) { next.get(spec.streamKey).aliases.add(spec.topClipId); continue; }
      const old = this.streams.get(spec.streamKey);
      const manifest = old?.manifest ?? await this.store.load(spec.streamKey) ?? this.freshManifest(spec);
      const state = old ?? { reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set() };
      state.spec = spec;
      state.aliases = new Set();
      state.manifest = manifest;
      state.isolated = isolatedStreamProject(entry.project, spec);
      state.generation = generation;
      next.set(spec.streamKey, state);
    }
    this.streams = next;
    if (generation !== this.generation) return specs;
    this.republish();
    this.kick();
    return specs;
  }

  freshManifest(spec) {
    return { version: STREAM_CODE_VERSION, streamKey: spec.streamKey, kind: spec.kind, plane: spec.plane, clipIds: spec.clipIds,
      fps: spec.fps, bound: spec.bound, offset: spec.offset, tight: null, inits: {}, segments: {} };
  }

  /**
   * 把每条流此刻的就绪分段发成 C3 的 `layer`(`kind: 'stream'`,单位是分段号;组流带 `groupClipIds`,
   * 挂在组里最上面那张卡上)。同时挂到 `stageByKey` 上 —— `adoptCardPlan` 的认领是「清表后全量重发」,
   * 没挂在那里的层会被它冲掉。
   */
  republish() {
    for (const state of this.streams.values()) this.publish(state);
  }

  publish(state) {
    const ranges = readySegmentRanges(state.manifest);
    if (!ranges.length) return;
    const { spec } = state;
    const index = this.pipeline.readyIndex;
    try {
      index.stageByKey({ kind: 'stream', key: spec.streamKey, ranges });
      for (const clipId of [spec.topClipId, ...(state.aliases ?? [])]) {
        index.setLayer({ clipId, kind: 'stream', key: spec.streamKey, ranges, ...(spec.kind === 'group' ? { groupClipIds: spec.clipIds } : {}) });
      }
    } catch {}
  }

  /** 这一段现在是什么状态:没有 / 签名对不上 / 稀疏 / 满密度 */
  segmentState(state, n) {
    const seg = state.manifest?.segments?.[n];
    if (!seg) return 'none';
    const expectStride = seg.stride > 1 ? seg.stride : 1;
    const rect = expectStride > 1 ? state.manifest.bound : (state.manifest.tight ?? state.manifest.bound);
    const sig = this.encoderName ? segmentSignature({ streamKey: state.spec.streamKey, segment: n, stride: expectStride, encoder: this.encoderName, rect }) : seg.sig;
    if (seg.sig !== sig) return 'stale';
    return seg.stride > 1 ? 'sparse' : 'dense';
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
        const { spec } = state;
        const failures = state.failures;
        const ready = n => !need(state, n) || (failures.get(n) ?? 0) >= 3;
        const { frame, playing } = this.playheadFrame(spec.fps);
        const leaseLast = lease && lease.streamSignature === spec.streamKey && (lease.lastFrame + 1) % SEGMENT_FRAMES === 0
          ? Math.floor(lease.lastFrame / SEGMENT_FRAMES) : null;
        const pick = planStreamSegments({ playheadFrame: frame, fps: spec.fps, rate: playing ? 1 : 0, stride,
          firstSegment: spec.firstSegment, lastSegment: spec.lastSegment, ready, reserved: state.reserved, leaseLastSegment: leaseLast });
        if (pick.segment === null) continue;
        if (pick.continues) return { state, segment: pick.segment, stride };
        const start = pick.segment * SEGMENT_FRAMES;
        const distance = start >= frame ? start - frame : (frame - start) + spec.total;
        if (!best || distance < best.distance) best = { state, segment: pick.segment, stride, distance };
      }
      if (best) return best;
    }
    return null;
  }

  needsSparseAnywhere() {
    for (const state of this.streams.values()) {
      for (let n = state.spec.firstSegment; n <= state.spec.lastSegment; n++) {
        if (this.needsSparse(state, n) && (state.failures.get(n) ?? 0) < 3) return true;
      }
    }
    return false;
  }

  /** 把 worker 叫起来(已经在跑的不重复起);最多 `pool` 个 */
  kick() {
    if (!this.enabled || this.closed) return;
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
   * 生产一个分段(G4:单个分段的生产是它自己的一个 run)。租约接得上就接着推,接不上就把这条流的
   * 隔离工程灌进会话、从挂载帧重放。出帧逐张喂给这个分段的编码器;编码在后台收尾(双缓冲)。
   */
  async runSegment(bakery, { state, segment, stride }) {
    const { spec } = state;
    const generation = state.generation;
    const fps = spec.fps;
    const fromFrame = segment * SEGMENT_FRAMES;
    const toFrame = Math.min(fromFrame + SEGMENT_FRAMES - 1, spec.total - 1);
    const samples = toFrame - fromFrame + 1;
    const encoder = await this.encoder();
    const manifest = state.manifest;
    const rect = stride > 1 ? manifest.bound : (manifest.tight ?? manifest.bound);
    const captureRect = { x: rect.x + spec.offset.x, y: rect.y + spec.offset.y, w: rect.w, h: rect.h };
    const lease = bakery.streamLease;
    const continues = !!lease && !lease.dirty && lease.streamSignature === spec.streamKey && lease.lastFrame + 1 === fromFrame;
    if (!continues) {
      await bakery.reset(state.isolated, this.pipeline.emptyUrl(state.isolated), { deferCards: true });
      bakery.streamLease = null;
      this.stats.resets++;
      this.stats.setFrameWindowCalls++;
      state.resets = state.resets ?? { sparse: 0, dense: 0 };
      state.resets[stride > 1 ? 'sparse' : 'dense']++;
    }
    const abort = new AbortController();
    const stale = () => this.closed || state.generation !== generation || this.streams.get(spec.streamKey) !== state;
    const guard = setInterval(() => { if (stale()) abort.abort(); }, 100);
    guard.unref?.();
    let enc = null;
    let firstCapture = true;
    const measuring = stride > 1 && !manifest.tight;
    try {
      const result = await bakeStream(bakery, {
        streamSignature: spec.streamKey, fromFrame, toFrame, stride, fps, mountFrame: spec.mountFrame,
        clip: captureRect, hasMedia: false, signal: abort.signal,
        onFrame: async (frame, png) => {
          if (stale()) throw Object.assign(new Error('流已作废'), { cancelled: true });
          if (measuring) this.measurePng(state, frame, png, rect);
          if (!enc) {
            // 第一张图出来时还没有这个分段的编码器在跑:这一张的出图耗时算「空闲」样本
            await this.encoderSlot();
            enc = openStreamSegmentEncoder(this.ffmpeg, { encoder, fps });
          }
          const repeat = Math.min(stride, toFrame - frame + 1);
          for (let k = 0; k < repeat; k++) await enc.write(png);
          firstCapture = false;
        },
      });
      if (result.reset) this.stats.bakeStreamResets = (this.stats.bakeStreamResets ?? 0) + 1;
      if (result.captured) {
        const per = result.captureMs / result.captured;
        (this.aliveEncoders > 1 ? this.measure.busy : this.measure.idle).push(per);
        while (this.measure.busy.length > 50) this.measure.busy.shift();
        while (this.measure.idle.length > 50) this.measure.idle.shift();
      }
    } catch (error) {
      if (enc) { await enc.abort(); this.releaseEncoderSlot(); }
      bakery.streamLease = null;
      throw error;
    } finally { clearInterval(guard); }
    if (!enc) return false;
    void firstCapture;
    const job = enc.finish()
      .then(out => this.storeSegment(state, generation, { segment, stride, rect, encoder, samples, out }))
      .catch(error => {
        this.stats.failures++;
        state.failures.set(segment, (state.failures.get(segment) ?? 0) + 1);
        this.note(`分段 ${spec.streamKey.slice(0, 8)}#${segment} 编码失败:${error?.message || error}`);
      })
      .finally(() => { state.reserved.delete(segment); this.releaseEncoderSlot(); this.encoding.delete(job); this.kick(); });
    this.encoding.add(job);
    return true;
  }

  /**
   * 稀疏那一趟顺带量实体框(G1):这一张截图里 alpha > 0 的包围盒,换回平面坐标并进并集。
   * 截图矩形就是 `rect`(平面坐标),所以图片像素 (x, y) 在平面上是 (rect.x + x, rect.y + y)。
   */
  measurePng(state, frame, png, rect) {
    const box = pngAlphaBox(png);
    if (box?.full) { state.measureFailed = true; return; }
    if (box) state.measured = unionRect(state.measured, { x: rect.x + box.x, y: rect.y + box.y, w: box.w, h: box.h });
    state.measuredSegments.add(Math.floor(frame / SEGMENT_FRAMES));
  }

  /**
   * 稀疏那一趟整条流量完之后定收紧矩形:并集外扩一点、夹回上界、外扩到偶数。面积省不到
   * `TIGHTEN_MIN_SAVING` 就不收紧(白换一个变体)。一个实体框都没量到(整条流透明)时也不收紧。
   */
  maybeTighten(state) {
    const manifest = state.manifest;
    if (manifest.tight || state.measureFailed) return;
    const { spec } = state;
    for (let n = spec.firstSegment; n <= spec.lastSegment; n++) if (this.needsSparse(state, n)) return;
    const bound = manifest.bound;
    // 并集必须覆盖**每一个**分段:有的稀疏分段是上一个进程产的(这次没量到),收紧就可能裁掉它的内容
    for (let n = spec.firstSegment; n <= spec.lastSegment; n++) if (!state.measuredSegments.has(n)) { manifest.tight = bound; return; }
    if (!state.measured) { manifest.tight = bound; return; }
    const tight = evenRect(intersectRect(padRect(state.measured, MEASURE_PAD_PX), bound), bound);
    manifest.tight = rectArea(tight) <= rectArea(bound) * (1 - TIGHTEN_MIN_SAVING) ? tight : bound;
    this.note(`流 ${spec.streamKey.slice(0, 8)} 收紧到 ${JSON.stringify(manifest.tight)}(上界 ${JSON.stringify(bound)})`);
  }

  /** 编完一个分段:切分、校验、落盘、改清单、发 `layer`;被替换的旧文件 5 秒后删(G6) */
  async storeSegment(state, generation, { segment, stride, rect, encoder, samples, out }) {
    const { spec } = state;
    const { init, segments, dropped } = splitFmp4(out.bytes);
    if (segments.length !== 1) throw new Error(`一次编码应当恰好一个分段,实际 ${segments.length} 个`);
    const info = segmentInfo(segments[0]);
    if (info.moofs !== 1) throw new Error(`分段里应当恰好一个 moof,实际 ${info.moofs}`);
    // G2:一个分段的样本数必须恰好 15(末段除外),少一帧就重拍
    if (info.sampleCount !== samples) throw new Error(`分段样本数 ${info.sampleCount},应当是 ${samples}`);
    if (info.firstSampleIsSync !== true) throw new Error('分段首帧不是 IDR');
    if (!init.length) throw new Error('编码输出里没有 ftyp + moov');
    if (state.generation !== generation || this.streams.get(spec.streamKey) !== state) return;
    const manifest = state.manifest;
    const initId = sha(init, 16);
    const dir = this.store.dir(spec.streamKey);
    await fs.mkdir(dir, { recursive: true });
    if (!manifest.inits[initId]) {
      const meta = initInfo(init);
      await atomic(this.store.initFile(spec.streamKey, initId), init);
      manifest.inits[initId] = { codec: meta.codec, width: meta.width, height: meta.height, timescale: meta.timescale, rect, encoder, bytes: init.length };
      this.note(`流 ${spec.streamKey.slice(0, 8)} 新变体 init-${initId}(${meta.codec} ${meta.width}×${meta.height})`);
    }
    const file = `${segment}-${sha(segments[0], 16)}.m4s`;
    await atomic(this.store.segFile(spec.streamKey, file), segments[0]);
    const old = manifest.segments[segment];
    manifest.segments[segment] = { file, init: initId, stride, samples, bytes: segments[0].length, encodeMs: out.encodeMs, tailMs: out.tailMs,
      sig: segmentSignature({ streamKey: spec.streamKey, segment, stride, encoder, rect }), dropped, at: Date.now() };
    if (stride > 1) this.maybeTighten(state);
    await this.store.save(manifest);
    this.stats.segments++;
    this.publish(state);
    if (old && old.stride > 1 && stride === 1) {
      // 验收「稀疏分段 ≤ 满密度 1.0 倍」要的对照:同一段、稀疏与满密度各自的字节和矩形
      (this.stats.sparseVsDense ||= []).push({ stream: spec.streamKey.slice(0, 8), segment, sparse: old.bytes, dense: segments[0].length,
        sameRect: JSON.stringify(manifest.inits[old.init]?.rect) === JSON.stringify(rect) });
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
    const found = await this.store.scan();
    for (const item of found) {
      try { this.pipeline.readyIndex.stageByKey({ kind: 'stream', key: item.key, ranges: item.ranges }); } catch {}
    }
    return found.length;
  }

  /** 已经在库里的流在认领表里的样子(`adoptCardPlan` 用):`{ clipId, kind: 'stream', key }` */
  claimLayers() {
    return [...this.streams.values()].flatMap(state => [state.spec.topClipId, ...(state.aliases ?? [])]
      .map(clipId => ({ clipId, kind: 'stream', key: state.spec.streamKey })));
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
