/**
 * mediaSync 的单测。跑:node --test src/editor/preview/mediaSync.test.mjs
 *
 * 钉死的是一条:**纠偏本身不能制造下一次纠偏的理由**。
 * 原来那版「偏差 > 0.2s 就 seek」在时间轴中段会自持循环 —— 中段 seek 要从上一个关键帧
 * (用户素材是每 5 秒一个)解出上百帧才出画,这几百毫秒里播放头照走,落定时又超阈值,
 * 于是再 seek。表现就是「从中间或尾部起播一卡一卡,从开头十几秒起播没事」。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { planSync, HARD_SEEK_SEC, SEEK_COOLDOWN_MS, IN_SYNC_SEC, MAX_RATE_SKEW } from "./mediaSync.ts";

const base = { elTime: 0, seeking: false, paused: false, target: 0, playing: true, now: 10_000, lastSeekAt: 0 };
const at = (o) => planSync({ ...base, ...o });

test("对齐得好好的:什么都不动,速度保持 1", () => {
  const p = at({ elTime: 300, target: 300.01 });
  assert.equal(p.seekTo, null);
  assert.equal(p.rate, 1);
  assert.equal(p.play, false);
});

test("中等偏差用变速追,不 seek —— 中段 seek 正是卡顿的来源", () => {
  const behind = at({ elTime: 300, target: 300.25 }); // 视频落后 0.25s
  assert.equal(behind.seekTo, null, "这一档绝不能 seek");
  assert.ok(behind.rate > 1 && behind.rate <= 1 + MAX_RATE_SKEW, `应该快放一点,实际 ${behind.rate}`);

  const ahead = at({ elTime: 300.25, target: 300 }); // 视频超前 0.25s
  assert.equal(ahead.seekTo, null);
  assert.ok(ahead.rate < 1 && ahead.rate >= 1 - MAX_RATE_SKEW, `应该慢放一点,实际 ${ahead.rate}`);
});

test("变速幅度封顶在 ±10%:再多就听得出变调了", () => {
  const p = at({ elTime: 300, target: 300 + HARD_SEEK_SEC - 0.001 });
  assert.ok(p.rate <= 1 + MAX_RATE_SKEW + 1e-9);
});

test("真脱节了(超过 0.5s)才 seek", () => {
  const p = at({ elTime: 300, target: 301 });
  assert.equal(p.seekTo, 301);
  assert.equal(p.rate, 1, "seek 的同时把速度还原,别带着微调落地");
});

test("seek 有冷却:上一次还没过 700ms 就先忍着", () => {
  const p = at({ elTime: 300, target: 301, now: 10_000, lastSeekAt: 10_000 - (SEEK_COOLDOWN_MS - 50) });
  assert.equal(p.seekTo, null, "冷却期内不许再 seek");
  const q = at({ elTime: 300, target: 301, now: 10_000, lastSeekAt: 10_000 - (SEEK_COOLDOWN_MS + 50) });
  assert.equal(q.seekTo, 301, "冷却过了就该纠了");
});

test("seeking 期间一律不下新指令 —— 这时候 currentTime 读的是目标值不是真实进度", () => {
  const p = at({ elTime: 301, target: 305, seeking: true });
  assert.equal(p.seekTo, null);
  assert.equal(p.rate, null);
  assert.equal(p.pause, false);
});

test("seeking 期间如果还没起播,play() 照发:起播不该被 seek 挡住", () => {
  const p = at({ elTime: 300, target: 300, seeking: true, paused: true });
  assert.equal(p.play, true);
  assert.equal(p.seekTo, null);
});

test("暂停:精确对齐(0.03s),并且把速度还原", () => {
  const p = at({ playing: false, paused: true, elTime: 300, target: 300.5 });
  assert.equal(p.seekTo, 300.5);
  assert.equal(p.rate, 1);
  const q = at({ playing: false, paused: true, elTime: 300, target: 300.01 });
  assert.equal(q.seekTo, null, "已经在 0.03s 以内就别动,逐帧看的时候乱 seek 很难受");
});

test("暂停但元素还在放:要 pause", () => {
  const p = at({ playing: false, paused: false, elTime: 300, target: 300 });
  assert.equal(p.pause, true);
});

test("target 不合法时什么都不做", () => {
  assert.equal(at({ target: NaN }).seekTo, null);
  assert.equal(at({ target: -1 }).seekTo, null);
  assert.equal(at({ elTime: NaN, target: 3 }).seekTo, null);
});

/*
 * 回归的正主:模拟「中段起播」整个过程,数它一共 seek 了几次。
 *
 * 模型按实测取值:播放头按墙钟走;seek 一次要 400ms 才出画(关键帧 5 秒一个,
 * 中段得解出上百帧),这期间 seeking=true 且视频时间不前进;不 seek 的时候视频按
 * playbackRate 正常走。起播时先给 250ms 的启动延迟,让它天然落后一截。
 */
function simulate(planner, { frames = 600, startupLagMs = 250 } = {}) {
  let t = 300;            // 播放头
  let el = 300;           // 视频时钟
  let seeking = false, seekEndsAt = 0, lastSeekAt = 0, paused = true;
  let rate = 1, seeks = 0, stalledFrames = 0;
  const dt = 1000 / 60;

  for (let i = 0, now = 0; i < frames; i++, now += dt) {
    if (seeking && now >= seekEndsAt) seeking = false;
    if (!paused && !seeking && now >= startupLagMs) el += (dt / 1000) * rate;
    if (seeking) stalledFrames++;

    const p = planner({ elTime: el, seeking, paused, target: t, playing: true, now, lastSeekAt });
    if (p.rate !== null) rate = p.rate;
    if (p.seekTo !== null) { el = p.seekTo; seeking = true; seekEndsAt = now + 400; lastSeekAt = now; seeks++; }
    if (p.play) paused = false;

    t += dt / 1000;
  }
  return { seeks, stalledFrames, finalDrift: +(t - el).toFixed(3) };
}

/** 原来那版逻辑,逐字照抄,用来对照 */
const oldPlanner = ({ elTime, target, paused }) => ({
  seekTo: Math.abs(elTime - target) > 0.2 ? target : null,
  rate: null,
  play: paused,
  pause: false,
});

test("中段起播 10 秒:旧逻辑反复 seek(就是那个一卡一卡),新逻辑收敛", () => {
  const before = simulate(oldPlanner);
  const after = simulate(planSync);

  // 旧逻辑:每次 seek 都制造下一次 seek 的理由,一路 seek 到底
  assert.ok(before.seeks >= 5, `旧逻辑本该反复 seek,实际只有 ${before.seeks} 次`);
  // 新逻辑:最多纠一次,之后靠变速追平
  assert.ok(after.seeks <= 1, `新逻辑不该反复 seek,实际 ${after.seeks} 次`);
  assert.ok(
    after.stalledFrames * 4 < before.stalledFrames,
    `卡住的帧数该大幅下降:旧 ${before.stalledFrames} → 新 ${after.stalledFrames}`,
  );
  assert.ok(Math.abs(after.finalDrift) < HARD_SEEK_SEC, `最终应该追平,实际差 ${after.finalDrift}s`);
});

test("开头起播(seek 便宜)两版都不卡 —— 说明差别真的出在 seek 代价上", () => {
  const cheapSeek = (planner) => simulate(planner, { startupLagMs: 30 });
  assert.ok(cheapSeek(oldPlanner).seeks === 0);
  assert.ok(cheapSeek(planSync).seeks === 0);
});
