// 合并流评估 · 第 2 问的乙（不重新编码，直接拼码流）用的 H.264 码流工具。只给探针用。
//
// 能做的事：拆 Annex-B、读 SPS / PPS / 条带头、把一条流的条带改写后放进一张更大的画面里
// （改 first_mb_in_slice、frame_num、是不是 IDR、去块滤波不跨条带），以及把 SPS 改成合并后的宽高。
// 只支持产品现在这套编码参数产出的码流：逐行扫描的帧（frame_mbs_only）、CABAC、只有 I / P 条带、没有 B 帧。
// 遇到别的（场编码、CAVLC、B 条带、多条带组）直接抛错，不猜。
//
// 依据是 ITU-T H.264 第 7.3 节的语法（SPS 7.3.2.1.1、PPS 7.3.2.2、条带头 7.3.3）。

export class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  get bitsLeft() { return this.buf.length * 8 - this.pos; }
  u(n) { let v = 0; for (let i = 0; i < n; i++) { v = v * 2 + ((this.buf[this.pos >> 3] >> (7 - (this.pos & 7))) & 1); this.pos++; } return v; }
  ue() { let zeros = 0; while (this.u(1) === 0) { zeros++; if (zeros > 32) throw new Error('ue 读坏了'); } return zeros ? (2 ** zeros - 1) + this.u(zeros) : 0; }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -(k / 2); }
}
export class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  u(n, v) { for (let i = n - 1; i >= 0; i--) { this.cur = (this.cur << 1) | (Math.floor(v / 2 ** i) & 1); if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; } } }
  ue(v) { const x = v + 1; const len = Math.floor(Math.log2(x)); this.u(len, 0); this.u(len + 1, x); }
  se(v) { this.ue(v > 0 ? 2 * v - 1 : -2 * v); }
  get aligned() { return this.n === 0; }
  toBuffer() { if (this.n) throw new Error('没对齐到字节'); return Buffer.from(this.bytes); }
}

/** Annex-B → NAL 单元列表（不含起始码） */
export function splitAnnexB(buf) {
  const out = [];
  let i = 0, start = -1;
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) { let end = i; while (end > start && buf[end - 1] === 0) end--; out.push(buf.subarray(start, end)); }
      start = i + 3; i += 3;
    } else i++;
  }
  if (start >= 0) out.push(buf.subarray(start));
  return out;
}
export const START = Buffer.from([0, 0, 0, 1]);
export const nalType = (nal) => nal[0] & 0x1f;
export const nalRefIdc = (nal) => (nal[0] >> 5) & 3;

/** NAL 负载（去掉 1 字节头）→ RBSP：去掉防竞争字节 00 00 03 */
export function unescapeRbsp(nal) {
  const out = [];
  let zeros = 0;
  for (let i = 1; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}
/** NAL 头 + RBSP → NAL：补回防竞争字节 */
export function escapeNal(header, rbsp) {
  const out = [header];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

function skipScalingList(r, size) {
  let last = 8, next = 8;
  for (let j = 0; j < size; j++) { if (next !== 0) next = (last + r.se() + 256) % 256; last = next === 0 ? last : next; }
}

export function parseSps(nal) {
  const rbsp = unescapeRbsp(nal);
  const r = new BitReader(rbsp);
  const s = { profile: r.u(8), constraints: r.u(8), level: r.u(8), id: r.ue(), chromaFormat: 1, separateColourPlane: 0 };
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(s.profile)) {
    s.chromaFormat = r.ue();
    if (s.chromaFormat === 3) s.separateColourPlane = r.u(1);
    s.bitDepthLuma = r.ue() + 8; s.bitDepthChroma = r.ue() + 8; r.u(1);
    if (r.u(1)) for (let i = 0; i < (s.chromaFormat !== 3 ? 8 : 12); i++) if (r.u(1)) skipScalingList(r, i < 6 ? 16 : 64);
  }
  s.log2MaxFrameNum = r.ue() + 4;
  s.pocType = r.ue();
  if (s.pocType === 0) s.log2MaxPocLsb = r.ue() + 4;
  else if (s.pocType === 1) { s.deltaPicOrderAlwaysZero = r.u(1); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
  s.maxNumRefFrames = r.ue();
  s.gapsAllowed = r.u(1);
  s.posWidth = r.pos;
  s.widthMbs = r.ue() + 1;
  s.heightMapUnits = r.ue() + 1;
  s.frameMbsOnly = r.u(1);
  if (!s.frameMbsOnly) s.mbAdaptive = r.u(1);
  s.direct8x8 = r.u(1);
  s.cropping = r.u(1);
  if (s.cropping) s.crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  s.posAfterCrop = r.pos;
  s.vuiPresent = r.u(1);
  s.rbsp = rbsp;
  return s;
}

export function parsePps(nal) {
  const r = new BitReader(unescapeRbsp(nal));
  const p = { id: r.ue(), spsId: r.ue(), cabac: r.u(1), bottomFieldPicOrderPresent: r.u(1), numSliceGroups: r.ue() + 1 };
  if (p.numSliceGroups > 1) throw new Error('不支持多条带组（FMO）');
  p.numRefIdxL0Default = r.ue() + 1; p.numRefIdxL1Default = r.ue() + 1;
  p.weightedPred = r.u(1); p.weightedBipredIdc = r.u(2);
  p.picInitQp = r.se() + 26; p.picInitQs = r.se() + 26; p.chromaQpIndexOffset = r.se();
  p.deblockingControlPresent = r.u(1); p.constrainedIntraPred = r.u(1); p.redundantPicCntPresent = r.u(1);
  return p;
}

const SLICE_NAMES = ['P', 'B', 'I', 'SP', 'SI'];

/** 读条带头。回字段，以及条带数据（CABAC：对齐之后）在 RBSP 里的字节位置 */
export function parseSliceHeader(nal, sps, pps) {
  if (!sps.frameMbsOnly) throw new Error('不支持场编码');
  const rbsp = unescapeRbsp(nal);
  const r = new BitReader(rbsp);
  const type = nalType(nal), idr = type === 5;
  const h = { nalType: type, refIdc: nalRefIdc(nal), idr };
  h.firstMb = r.ue();
  h.sliceTypeRaw = r.ue();
  h.sliceType = SLICE_NAMES[h.sliceTypeRaw % 5];
  if (h.sliceType !== 'P' && h.sliceType !== 'I') throw new Error(`不支持 ${h.sliceType} 条带`);
  h.ppsId = r.ue();
  if (sps.separateColourPlane) throw new Error('不支持分色平面');
  h.frameNum = r.u(sps.log2MaxFrameNum);
  if (idr) h.idrPicId = r.ue();
  if (sps.pocType === 0) { h.pocLsb = r.u(sps.log2MaxPocLsb); if (pps.bottomFieldPicOrderPresent) h.deltaPocBottom = r.se(); }
  if (sps.pocType === 1 && !sps.deltaPicOrderAlwaysZero) { h.deltaPoc0 = r.se(); if (pps.bottomFieldPicOrderPresent) h.deltaPoc1 = r.se(); }
  if (pps.redundantPicCntPresent) h.redundantPicCnt = r.ue();
  h.numRefIdxL0 = pps.numRefIdxL0Default;
  if (h.sliceType === 'P') {
    h.numRefIdxOverride = r.u(1);
    if (h.numRefIdxOverride) h.numRefIdxL0 = r.ue() + 1;
    h.rplm = null;
    if (r.u(1)) { h.rplm = []; for (;;) { const idc = r.ue(); if (idc === 3) break; h.rplm.push([idc, r.ue()]); } }
    if (pps.weightedPred) {
      const w = { lumaDenom: r.ue(), chromaDenom: sps.chromaFormat ? r.ue() : null, entries: [] };
      for (let i = 0; i < h.numRefIdxL0; i++) {
        const e = { luma: null, chroma: null };
        if (r.u(1)) e.luma = [r.se(), r.se()];
        if (sps.chromaFormat && r.u(1)) e.chroma = [r.se(), r.se(), r.se(), r.se()];
        w.entries.push(e);
      }
      h.pwt = w;
    }
  }
  if (h.refIdc) {
    if (idr) h.marking = { noOutputOfPriorPics: r.u(1), longTermReference: r.u(1) };
    else {
      h.marking = { adaptive: r.u(1), ops: [] };
      if (h.marking.adaptive) for (;;) { const op = r.ue(); if (op === 0) break; const a = [op]; if (op === 1 || op === 3) a.push(r.ue()); if (op === 2) a.push(r.ue()); if (op === 3 || op === 6) a.push(r.ue()); if (op === 4) a.push(r.ue()); h.marking.ops.push(a); }
    }
  }
  if (pps.cabac && h.sliceType !== 'I') h.cabacInitIdc = r.ue();
  h.sliceQpDelta = r.se();
  if (pps.deblockingControlPresent) { h.deblockIdc = r.ue(); if (h.deblockIdc !== 1) { h.alphaOffset = r.se(); h.betaOffset = r.se(); } }
  h.headerBits = r.pos;
  if (!pps.cabac) throw new Error('只支持 CABAC（条带数据按字节对齐，改完头可以原样接上）');
  while (r.pos & 7) { if (r.u(1) !== 1) throw new Error('cabac_alignment_one_bit 不是 1'); }
  h.dataByte = r.pos >> 3;
  h.rbsp = rbsp;
  return h;
}

/**
 * 改写一个条带，放进合并后的画面：
 *   firstMb   新的 first_mb_in_slice；
 *   frameNum  合并流自己的 frame_num；
 *   idr       合并后的这一幅是不是 IDR（一幅画面里所有条带必须同为 IDR 或同不是）；原来是 IDR 而合并后不是的，改成普通的 I 条带；
 *   pocLsb    pic_order_cnt_type 为 0 时用；
 *   deblockAcross  false（缺省）= 去块滤波不跨条带边界（disable_deblocking_filter_idc = 2）。原条带关着去块（= 1）的保持关着。
 * 条带数据（宏块层）一个比特不动。
 */
export function rewriteSlice(nal, sps, pps, { firstMb, frameNum, idr, idrPicId = 0, pocLsb = 0, deblockAcross = false }) {
  const h = parseSliceHeader(nal, sps, pps);
  if (idr && !h.idr) throw new Error('合并后的画面是 IDR，但这一格的条带不是关键帧');
  const w = new BitWriter();
  w.ue(firstMb);
  w.ue(h.sliceTypeRaw % 5); // 5～9 的写法等于声明「这一幅所有条带同类型」，合并后不一定成立
  w.ue(h.ppsId);
  w.u(sps.log2MaxFrameNum, frameNum % (2 ** sps.log2MaxFrameNum));
  if (idr) w.ue(idrPicId);
  if (sps.pocType === 0) { w.u(sps.log2MaxPocLsb, pocLsb % (2 ** sps.log2MaxPocLsb)); if (pps.bottomFieldPicOrderPresent) w.se(h.deltaPocBottom ?? 0); }
  if (sps.pocType === 1 && !sps.deltaPicOrderAlwaysZero) { w.se(h.deltaPoc0 ?? 0); if (pps.bottomFieldPicOrderPresent) w.se(h.deltaPoc1 ?? 0); }
  if (pps.redundantPicCntPresent) w.ue(h.redundantPicCnt ?? 0);
  if (h.sliceType === 'P') {
    w.u(1, h.numRefIdxOverride);
    if (h.numRefIdxOverride) w.ue(h.numRefIdxL0 - 1);
    if (h.rplm) { w.u(1, 1); for (const [idc, v] of h.rplm) { w.ue(idc); w.ue(v); } w.ue(3); } else w.u(1, 0);
    if (pps.weightedPred) {
      w.ue(h.pwt.lumaDenom); if (sps.chromaFormat) w.ue(h.pwt.chromaDenom);
      for (const e of h.pwt.entries) {
        w.u(1, e.luma ? 1 : 0); if (e.luma) { w.se(e.luma[0]); w.se(e.luma[1]); }
        if (sps.chromaFormat) { w.u(1, e.chroma ? 1 : 0); if (e.chroma) for (const v of e.chroma) w.se(v); }
      }
    }
  }
  if (h.refIdc) {
    if (idr) { w.u(1, h.marking.noOutputOfPriorPics ?? 0); w.u(1, h.marking.longTermReference ?? 0); }
    else if (h.idr) w.u(1, 0); // 原来是 IDR、现在是普通 I 条带：滑动窗口
    else { w.u(1, h.marking.adaptive); if (h.marking.adaptive) { for (const op of h.marking.ops) for (const v of op) w.ue(v); w.ue(0); } }
  }
  if (pps.cabac && h.sliceType !== 'I') w.ue(h.cabacInitIdc);
  w.se(h.sliceQpDelta);
  if (pps.deblockingControlPresent) {
    const idc = h.deblockIdc === 1 ? 1 : (deblockAcross ? h.deblockIdc : 2);
    w.ue(idc);
    if (idc !== 1) { w.se(h.alphaOffset ?? 0); w.se(h.betaOffset ?? 0); }
  } else if (!deblockAcross) throw new Error('PPS 里没开 deblocking_filter_control_present_flag，关不掉跨条带的去块滤波');
  while (!w.aligned) w.u(1, 1);
  const rbsp = Buffer.concat([w.toBuffer(), h.rbsp.subarray(h.dataByte)]);
  // 一幅里各条带的 nal_ref_idc 要一样：x264 给 I 条带写 3、P 条带写 2，混在一幅里时 Chrome 的硬解那条路会把它当成新的一幅
  // （实测：不统一就在第一幅「有的格 I、有的格 P」的画面上报 Decoding error）。这里统一成 IDR 写 3、其余写 2。
  const header = ((h.refIdc ? (idr ? 3 : 2) : 0) << 5) | (idr ? 5 : 1);
  return escapeNal(header, rbsp);
}

/** 把 SPS 改成合并后的尺寸：宽高（宏块数）、级别；去掉裁剪（合并后的显示尺寸就是编码尺寸）。其余比特原样。 */
export function rewriteSps(nal, { widthMbs, heightMbs, level }) {
  const s = parseSps(nal);
  const r = new BitReader(s.rbsp);
  const w = new BitWriter();
  for (let i = 0; i < s.posWidth; i++) w.u(1, r.u(1));
  r.ue(); r.ue();
  w.ue(widthMbs - 1); w.ue(heightMbs - 1);
  w.u(1, r.u(1)); // frame_mbs_only_flag
  if (!s.frameMbsOnly) w.u(1, r.u(1));
  w.u(1, r.u(1)); // direct_8x8_inference_flag
  if (r.u(1)) { r.ue(); r.ue(); r.ue(); r.ue(); }
  w.u(1, 0); // frame_cropping_flag
  while (r.bitsLeft > 0) w.u(1, r.u(1));
  while (!w.aligned) w.u(1, 0);
  const out = w.toBuffer();
  if (level) out[2] = level;
  return escapeNal(nal[0], out);
}

/** 一条 Annex-B 流 → { sps, pps, spsNal, ppsNal, pictures: [{ idr, slices: [nal…] }] }。SEI、AUD 丢掉。 */
export function readStream(buf) {
  const nals = splitAnnexB(buf);
  let spsNal = null, ppsNal = null, sps = null, pps = null;
  const pictures = [];
  let cur = null;
  for (const nal of nals) {
    const t = nalType(nal);
    if (t === 7) { if (!spsNal) { spsNal = Buffer.from(nal); sps = parseSps(nal); } else if (!Buffer.from(nal).equals(spsNal)) throw new Error('流中途换了 SPS'); continue; }
    if (t === 8) { if (!ppsNal) { ppsNal = Buffer.from(nal); pps = parsePps(nal); } else if (!Buffer.from(nal).equals(ppsNal)) throw new Error('流中途换了 PPS'); continue; }
    if (t !== 1 && t !== 5) continue;
    const h = parseSliceHeader(nal, sps, pps);
    // 新的一幅：first_mb 回到 0（这些流没有任意条带顺序，够用）
    if (!cur || h.firstMb === 0) { cur = { idr: h.idr, sliceType: h.sliceType, frameNum: h.frameNum, slices: [] }; pictures.push(cur); }
    cur.slices.push({ nal: Buffer.from(nal), firstMb: h.firstMb, sliceType: h.sliceType, deblockIdc: h.deblockIdc });
  }
  return { sps, pps, spsNal, ppsNal, pictures };
}

/** 两条流的 PPS 逐字节相同、SPS 里会影响条带语法的字段相同，才拼得起来。不同就回原因。 */
export function compatible(a, b) {
  if (!a.ppsNal.equals(b.ppsNal)) return 'PPS 不同';
  for (const k of ['profile', 'chromaFormat', 'log2MaxFrameNum', 'pocType', 'log2MaxPocLsb', 'frameMbsOnly', 'direct8x8', 'maxNumRefFrames']) if (a.sps[k] !== b.sps[k]) return `SPS 的 ${k} 不同（${a.sps[k]} / ${b.sps[k]}）`;
  return null;
}

/**
 * 把几条流拼成一条（不重新编码）。
 *   cells: [{ stream（readStream 的结果）, xMb, yMb, offset（这一格的第 0 幅落在合并流的第几幅，可以为负）,
 *             filler（同尺寸的全黑流，readStream 的结果：第 0 幅是 I、第 1 幅是全跳过的 P；这一格没有内容的时候用它垫）}]
 *   widthMbs / heightMbs：合并后的画面（宏块数）；count：合并流出几幅；
 *   startWithIdr：第 0 幅强制是 IDR（哪一格在这一幅不是关键帧就用它的 filler 的 I 条带顶上 —— 那一格要等到自己的下一个关键帧才对）。
 * 回 { annexb, units（每幅一段 Annex-B）, pictures: [{ idr, types: 每格的条带类型 }] }。
 */
export function stitch({ cells, widthMbs, heightMbs, count, level, startWithIdr = true }) {
  const base = cells[0].stream;
  for (const c of cells) { const why = compatible(base, c.stream) || (c.filler ? compatible(base, c.filler) : null); if (why) throw new Error(`拼不起来：${why}`); }
  const sps = base.sps, pps = base.pps;
  const spsOut = rewriteSps(base.spsNal, { widthMbs, heightMbs, level });
  const parts = [];
  const info = [];
  let frameNum = 0, sinceIdr = 0, idrCount = 0;
  const mapMb = (c, firstMb) => { const w = c.stream.sps.widthMbs; const x = firstMb % w, y = Math.floor(firstMb / w); return (c.yMb + y) * widthMbs + c.xMb + x; };
  for (let n = 0; n < count; n++) {
    const picks = cells.map((c) => {
      const i = n - c.offset;
      const pic = i >= 0 && i < c.stream.pictures.length ? c.stream.pictures[i] : null;
      return { c, pic };
    });
    const allKey = picks.every(({ pic }) => pic?.idr);
    const idr = allKey || (n === 0 && startWithIdr);
    if (idr) { frameNum = 0; sinceIdr = 0; idrCount++; } else { frameNum++; sinceIdr++; }
    const slices = [];
    const types = [];
    for (const { c, pic } of picks) {
      let src = pic, from = c.stream;
      if (idr && !pic?.idr) { if (!c.filler) throw new Error('这一幅要 IDR，但有一格不是关键帧又没有垫片'); src = c.filler.pictures[0]; from = c.filler; types.push('垫I'); }
      else if (!pic) { if (!c.filler) throw new Error('这一格这一幅没有内容又没有垫片'); src = c.filler.pictures[1]; from = c.filler; types.push('垫P'); }
      else types.push(pic.idr ? 'I' : pic.sliceType);
      for (const s of src.slices) slices.push({ firstMb: mapMb({ ...c, stream: from }, s.firstMb), nal: rewriteSlice(s.nal, sps, pps, { firstMb: mapMb({ ...c, stream: from }, s.firstMb), frameNum, idr, idrPicId: idrCount % 2, pocLsb: 2 * sinceIdr }) });
    }
    slices.sort((a, b) => a.firstMb - b.firstMb);
    const unit = [];
    if (idr) unit.push(START, spsOut, START, base.ppsNal);
    for (const s of slices) unit.push(START, s.nal);
    const bytes = Buffer.concat(unit);
    parts.push(bytes);
    info.push({ idr, types, slices: slices.length, bytes: bytes.length });
  }
  return { annexb: Buffer.concat(parts), units: parts, pictures: info, spsOut };
}
