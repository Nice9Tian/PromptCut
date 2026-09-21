/**
 * pinAnimations 的单测。跑:node --test src/render/pinAnimations.test.mjs
 *
 * 钉死 R3 新加的三条(K3 / K5):
 *   - `sync(nowMs, skip)` 跳过 skip 里那些包裹层子树的动画(正在追帧 / 被抑制的片段不能被全局时钟拨回去);
 *   - `syncIn(el, stageMs)` 只钉子树,**锚点和全局 sync 同一份**、时间基同样是全局舞台毫秒 ——
 *     追完之后交回全局 sync 必须天然连续;
 *   - `resetIn(el)` 只丢这个子树的锚点,别的卡的锚点不动(整份 reset 会让别的卡入场动画重播一遍)。
 *
 * 没有 DOM:`Animation` / `Element` 都用最小假件,只实现被读到的那几样。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createAnimationPinner } from "./pinAnimations.ts";

/** 假包裹层:closest('[data-pc-clip]') 回它自己;子元素往上指到它 */
function fakeWrapper(id) {
  const wrap = { id, closest: (sel) => (sel === "[data-pc-clip]" ? wrap : null) };
  return wrap;
}
/** 包裹层里的一个目标元素 */
const fakeTarget = (wrap) => ({ closest: (sel) => (sel === "[data-pc-clip]" ? wrap : null) });

/** 假动画。endTime 给 Infinity 就永不 finish */
function fakeAnim(wrap, endTime = 1000) {
  return {
    playState: "running",
    currentTime: null,
    finished: false,
    effect: { target: wrap ? fakeTarget(wrap) : null, getComputedTiming: () => ({ endTime }) },
    pause() { this.playState = "paused"; },
    finish() { this.playState = "finished"; this.finished = true; },
  };
}

/** 假 document / 假宿主元素:各自交出一组动画 */
const host = (list) => ({ getAnimations: () => list });
const fakeDoc = (list) => ({ getAnimations: () => list });

test("sync:头一次出现的时刻当锚点,之后 currentTime = now − 锚点,并且 pause", () => {
  const a = fakeAnim(fakeWrapper("c1"));
  const p = createAnimationPinner(fakeDoc([a]));
  p.sync(500);
  assert.equal(a.currentTime, 0);
  assert.equal(a.playState, "paused");
  p.sync(700);
  assert.equal(a.currentTime, 200);
});

test("sync:越过 endTime 就 finish(),不再往下钉", () => {
  const a = fakeAnim(fakeWrapper("c1"), 100);
  const p = createAnimationPinner(fakeDoc([a]));
  p.sync(0);
  p.sync(150);
  assert.equal(a.playState, "finished");
  assert.equal(a.currentTime, 0);
});

test("sync(skip):skip 里包裹层子树的动画这一帧不钉,别的照钉", () => {
  const w1 = fakeWrapper("c1");
  const w2 = fakeWrapper("c2");
  const a1 = fakeAnim(w1);
  const a2 = fakeAnim(w2);
  const p = createAnimationPinner(fakeDoc([a1, a2]));
  p.sync(0);
  p.sync(300, new Set([w1]));
  assert.equal(a1.currentTime, 0, "被跳过的那条停在上一次的值");
  assert.equal(a2.currentTime, 300);
  // 从 skip 里拿掉之后接着钉,锚点没丢(还是 0),所以是 400 不是 0
  p.sync(400);
  assert.equal(a1.currentTime, 400);
});

test("sync(skip):不属于任何片段的动画(target 为 null)照钉", () => {
  const a = fakeAnim(null);
  const p = createAnimationPinner(fakeDoc([a]));
  p.sync(0);
  p.sync(120, new Set([fakeWrapper("c1")]));
  assert.equal(a.currentTime, 120);
});

test("syncIn:只钉子树,时间基是全局舞台毫秒,锚点与全局 sync 共用 —— 追完交回 sync 连续", () => {
  const w1 = fakeWrapper("c1");
  const w2 = fakeWrapper("c2");
  const a1 = fakeAnim(w1, Infinity);
  const a2 = fakeAnim(w2, Infinity);
  const p = createAnimationPinner(fakeDoc([a1, a2]));
  // 全局先走一拍:两条都拿到锚点 0
  p.sync(0);
  // c1 自己按子树追帧(全局时钟不动),全局这一拍跳过它
  for (let ms = 100; ms <= 500; ms += 100) p.syncIn(host([a1]), ms);
  assert.equal(a1.currentTime, 500);
  assert.equal(a2.currentTime, 0, "syncIn 不碰别的片段");
  // 追上之后交回全局:锚点本来就在全局基上,600 直接接得上
  p.sync(600);
  assert.equal(a1.currentTime, 600);
  assert.equal(a2.currentTime, 600);
});

test("resetIn:只丢这个子树的锚点,别的卡的锚点不动", () => {
  const w1 = fakeWrapper("c1");
  const w2 = fakeWrapper("c2");
  const a1 = fakeAnim(w1, Infinity);
  const a2 = fakeAnim(w2, Infinity);
  const p = createAnimationPinner(fakeDoc([a1, a2]));
  p.sync(1000); // 两条锚点都是 1000
  p.resetIn(host([a1]));
  p.sync(1500);
  assert.equal(a1.currentTime, 0, "锚点重记成 1500");
  assert.equal(a2.currentTime, 500, "锚点还是 1000");
});

test("resetIn / syncIn 对 null 是空跑", () => {
  const p = createAnimationPinner(fakeDoc([]));
  p.resetIn(null);
  p.syncIn(undefined, 10);
});
