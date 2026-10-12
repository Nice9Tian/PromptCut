/**
 * 快照的「这一套」有哪几帧(契约 `docs/plan/prerender-products-contract.md` 第 2.1、2.4 节)。
 *
 * 浏览器和 Node 共用(同 `snapshotPick.mjs`),纯函数,不引 React、不引别的渲染模块。
 * 锚帧(全局帧号)由调用方用 `snapshotPick.mjs` 的 `anchorFrames` 算好传进来。
 *
 * 一张卡该有快照的本地帧 = 本地帧 0、15、30……(小于 `count`)并上落在这张卡范围里的锚帧。
 * 必须带锚帧:选帧规则「不跨区间」(`pickSnapshotFrame`)不让跨过锚帧去拿更早的一张,
 * 只按 15 排的话,每个锚帧后面最多 14 帧选不出快照。
 *
 * 口径:`count` 是这张卡的帧数,`firstFrame` 是它的第一帧的全局帧号(`control.sampling.firstFrame`),
 * 本地帧 = 全局帧 - `firstFrame`。就绪区间的形状同 `snapshotPick.mjs` 的 `ReadyRange`:
 * 本地帧口径的闭区间 `[from, to]`。
 *
 * 15 这个数只写在这一处(守门测试 `snapshotGrid.test.mjs` 保证)。代码里另有的两个 15
 * (轨道流分段长度、垫在流下面的快照更换间隔)各管各的,不要互相引用。
 */

/** 每隔多少帧存一张快照 */
export const SNAPSHOT_STRIDE = 15;

const isFrame = (n) => Number.isInteger(n) && n >= 0;

/** 这张卡有几帧;不是正整数就当没有 */
function frameCount(count) {
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/** 落在这张卡范围里的锚帧,换成本地帧(去重、升序、不含越界) */
function anchorLocals(anchors, count, firstFrame) {
  const out = new Set();
  const base = Number.isInteger(firstFrame) ? firstFrame : 0;
  for (const anchor of anchors ?? []) {
    if (!Number.isInteger(anchor)) continue;
    const local = anchor - base;
    if (local >= 0 && local < count) out.add(local);
  }
  return out;
}

/**
 * 这张卡该有快照的本地帧,升序、去重。
 * `count` 不是正整数时返回空数组(没有帧就没有快照)。
 */
export function gridLocalFrames({ count, firstFrame = 0, anchors = [] } = {}) {
  const n = frameCount(count);
  if (!n) return [];
  const set = anchorLocals(anchors, n, firstFrame);
  for (let frame = 0; frame < n; frame += SNAPSHOT_STRIDE) set.add(frame);
  return [...set].sort((a, b) => a - b);
}

/** 某一本地帧在不在这一套里(越界、非整数都回 false) */
export function gridWants({ localFrame, count, firstFrame = 0, anchors = [] } = {}) {
  const n = frameCount(count);
  if (!n || !isFrame(localFrame) || localFrame >= n) return false;
  if (localFrame % SNAPSHOT_STRIDE === 0) return true;
  const global = localFrame + (Number.isInteger(firstFrame) ? firstFrame : 0);
  for (const anchor of anchors ?? []) if (anchor === global) return true;
  return false;
}

/** 把就绪区间(闭区间,不要求已合并、不要求有序)合并成有序不相交的一份;不合法的区间丢掉 */
function mergedRanges(ranges) {
  const valid = [];
  for (const range of Array.isArray(ranges) ? ranges : []) {
    if (!Array.isArray(range)) continue;
    const [from, to] = range;
    if (Number.isInteger(from) && Number.isInteger(to) && to >= from) valid.push([from, to]);
  }
  valid.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [from, to] of valid) {
    const last = out[out.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/**
 * 就绪区间是不是盖住了这一套(或其中一段)。
 *
 * - 不给 `from`、`to`:问整套。给了(本地帧,闭区间,夹到 `[0, count - 1]`):只问落在这一段里的那几帧。
 * - 这一段里这一套一帧都没有(例如 `from = 1`、`to = 10`)算齐:没有要等的东西。
 * - `count` 不是正整数时没有这一套,算齐。
 */
export function gridComplete({ ranges, count, firstFrame = 0, anchors = [], from, to } = {}) {
  const n = frameCount(count);
  if (!n) return true;
  const lo = Math.max(0, Number.isInteger(from) ? from : 0);
  const hi = Math.min(n - 1, Number.isInteger(to) ? to : n - 1);
  if (lo > hi) return true;
  const merged = mergedRanges(ranges);
  let at = 0;
  for (const frame of gridLocalFrames({ count: n, firstFrame, anchors })) {
    if (frame < lo) continue;
    if (frame > hi) break;
    while (at < merged.length && merged[at][1] < frame) at += 1;
    if (at >= merged.length || merged[at][0] > frame) return false;
  }
  return true;
}
