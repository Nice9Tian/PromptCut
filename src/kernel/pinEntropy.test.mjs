/**
 * 随机与墙上时钟钉死的单测。跑:node --test src/kernel/pinEntropy.test.mjs
 *
 * 这些错了都不会报错,只会让「导两遍」出两个画面 —— 而且只在用到随机的第三方素材上发作
 * (实测 lottie 的 wiggle / random 表达式)。所以把几条钉死:同一个起点出同一串数、
 * 墙上时钟跟着帧走、带参数的 Date 不受影响、crypto 也走种子。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { installPinnedEntropy, PINNED_EPOCH_MS } from "./pinEntropy.ts";

/** 沙箱:不碰测试进程自己的 Math / Date / crypto */
function makeHost() {
  const c = globalThis.crypto;
  return {
    Math: Object.create(Math),
    Date,
    crypto: { getRandomValues: c.getRandomValues.bind(c), randomUUID: c.randomUUID.bind(c) },
  };
}

test("两个独立页面装上之后,Math.random 出同一串数", () => {
  const a = makeHost(), b = makeHost();
  installPinnedEntropy(a);
  installPinnedEntropy(b);
  const sa = Array.from({ length: 8 }, () => a.Math.random());
  const sb = Array.from({ length: 8 }, () => b.Math.random());
  assert.deepEqual(sa, sb);
  assert.ok(sa.every((x) => x >= 0 && x < 1));
});

test("__pcResetRandom(1) 之后的序列和原 exportClock 的 mulberry32 逐位相同", () => {
  const h = makeHost();
  installPinnedEntropy(h);
  h.Math.random(); h.Math.random();          // 模块加载期先消耗几次
  h.__pcResetRandom(1);
  // 原 exportClock 里的实现,照抄一份当参照
  let s = 1;
  const ref = () => { s = (s + 0x6d2b79f5) | 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < 16; i++) assert.equal(h.Math.random(), ref());
});

test("墙上时钟 = 固定纪元 + 当前帧毫秒;时钟没就位时就是纪元本身", () => {
  const h = makeHost();
  installPinnedEntropy(h);
  assert.equal(h.Date.now(), PINNED_EPOCH_MS);
  assert.equal(new h.Date().getTime(), PINNED_EPOCH_MS);
  h.__pcExportMs = 1234.4;
  assert.equal(h.Date.now(), PINNED_EPOCH_MS + 1234);
  assert.equal(new h.Date().getTime(), PINNED_EPOCH_MS + 1234);
  assert.equal(h.Date(), new Date(PINNED_EPOCH_MS + 1234).toString());
  delete h.__pcExportMs;
  h.__pcStageClock = { now: () => 500 };
  assert.equal(h.Date.now(), PINNED_EPOCH_MS + 500);
});

test("带参数的 Date 是计算不是读时钟,原样不动;instanceof 照旧", () => {
  const h = makeHost();
  installPinnedEntropy(h);
  assert.equal(new h.Date(0).getTime(), 0);
  assert.equal(new h.Date("2020-02-03T00:00:00Z").getTime(), Date.UTC(2020, 1, 3));
  assert.equal(new h.Date(2021, 0, 1).getFullYear(), 2021);
  assert.equal(h.Date.UTC(2000, 0, 1), Date.UTC(2000, 0, 1));
  assert.equal(h.Date.parse("1970-01-01T00:00:01Z"), 1000);
  assert.ok(new h.Date() instanceof Date);
  assert.ok(new h.Date(5) instanceof h.Date);
});

test("crypto 走同一个种子:两个页面填出同样的字节,UUID 格式正确且相同", () => {
  const a = makeHost(), b = makeHost();
  installPinnedEntropy(a);
  installPinnedEntropy(b);
  const ua = a.crypto.getRandomValues(new Uint32Array(4));
  const ub = b.crypto.getRandomValues(new Uint32Array(4));
  assert.deepEqual([...ua], [...ub]);
  const ida = a.crypto.randomUUID(), idb = b.crypto.randomUUID();
  assert.equal(ida, idb);
  assert.match(ida, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("重复安装不会把种子流拨回起点", () => {
  const h = makeHost();
  installPinnedEntropy(h);
  const first = h.Math.random();
  installPinnedEntropy(h);
  assert.notEqual(h.Math.random(), first);
});
